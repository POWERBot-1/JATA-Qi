// A-01 enforcement gate (policy enforcement point, PEP).
//
// This is the chokepoint every agent-initiated, externally consequential
// invocation must pass through. It is authoritative by construction:
//
//   * `decide()` renders the decision (DEFAULT DENY) and seals it into a
//     tamper-resistant envelope.
//   * `executeAuthorized()` re-verifies the sealed envelope (integrity,
//     decision, freshness, replay) and re-acquires the credential BEFORE
//     invoking the protected side effect. Every failure throws
//     `AuthorizationDeniedError` and the side effect is never invoked.
//   * Replay protection: a non-READ envelope is consumed exactly once; an
//     idempotency key, once consumed by a successful side effect, returns the
//     cached result for duplicate delivery instead of re-executing.
//   * Budget and rate state are consumed here, so the decision and the
//     enforcement point cannot drift apart.
//   * Every decision (ALLOW or DENY) and every consumption produces a
//     privacy-safe audit record. If the audit sink fails, the outcome fails
//     closed with AUDIT_UNAVAILABLE: an unauditable ALLOW does not exist.
//
// Downstream components consume the envelope (re-verifying it via
// `assertEnvelope`) rather than reconstructing authorization from untrusted
// caller metadata.

import { randomUUID } from 'node:crypto';
import { assertEnvelopeIntegrity, envelopeAcceptance, sealEnvelope } from './envelope.js';
import { decideA01, type A01DecisionResult, type A01PolicyContext } from './policy-engine.js';
import { InMemoryAuditSink } from './audit.js';
import type {
  A01AuditRecord,
  A01AuthorizationEnvelope,
  A01AuthorizationRequest,
  A01AuditSink,
  A01CredentialBinding,
  A01DenialReason,
  A01PolicyEngine,
  CredentialBroker,
  ScopedCredential,
} from './types.js';
import { AuthorizationDeniedError, CredentialDeniedError } from './types.js';
import { CapabilityManifestRegistry } from './capability-manifests.js';

export const A01_DEFAULT_POLICY_VERSION = 'a01-policy-1';

export interface A01GateConfig {
  readonly now?: () => number;
  readonly manifests?: CapabilityManifestRegistry;
  readonly broker?: CredentialBroker;
  readonly audit?: A01AuditSink;
  readonly engine?: A01PolicyEngine;
  readonly policyVersion?: string;
  /**
   * R1/D2: verifier for kernel-internal service principals (see
   * `KernelInternalIdentity`). Supplied by the composition root. When absent,
   * NO principal is ever treated as a verified kernel worker — the default is
   * strictly the stricter behaviour.
   */
  readonly verifyKernelPrincipal?: (principal: unknown, scope: string) => boolean;
}

export interface ScopedExecutionContext {
  readonly envelope: A01AuthorizationEnvelope;
  /** Present only when the decision bound a credential. Material lives only here, only now. */
  readonly credential?: ScopedCredential;
}

interface RateWindowState {
  readonly timestamps: number[];
}

export class AuthorizationGate {
  private readonly now: () => number;
  private readonly manifests: CapabilityManifestRegistry;
  private readonly broker: CredentialBroker | undefined;
  private readonly engine: A01PolicyEngine | undefined;
  private readonly audit: A01AuditSink;
  private readonly policyVersion: string;
  private readonly verifyKernelPrincipal: ((principal: unknown, scope: string) => boolean) | undefined;
  private auditAvailable: boolean;

  private readonly consumedEnvelopes = new Set<string>();
  private readonly idempotencyCache = new Map<string, unknown>();
  private readonly rateWindows = new Map<string, RateWindowState>();
  private readonly runBudgets = new Map<string, number>();
  /**
   * Pending durable decision-audit writes, keyed by envelope. Execution
   * AWAITs the write for its own envelope before running the side effect —
   * a durable audit that fails rejects the execution (fail-closed, no race).
   */
  private readonly decisionAudits = new Map<string, Promise<void>>();

  constructor(config: A01GateConfig = {}) {
    this.now = config.now ?? ((): number => Date.now());
    this.manifests = config.manifests ?? new CapabilityManifestRegistry();
    this.broker = config.broker;
    this.engine = config.engine;
    this.policyVersion = config.policyVersion ?? A01_DEFAULT_POLICY_VERSION;
    this.verifyKernelPrincipal = config.verifyKernelPrincipal;
    this.audit = config.audit ?? new InMemoryAuditSink();
    // Audit availability is probed lazily per record; a throwing sink turns
    // ALLOW decisions into fail-closed DENYs (AUDIT_UNAVAILABLE).
    this.auditAvailable = true;
  }

  get manifestsRegistry(): CapabilityManifestRegistry {
    return this.manifests;
  }

  /** The configured credential broker (diagnostics; never grants anything). */
  get credentialBroker(): CredentialBroker | undefined {
    return this.broker;
  }

  private rateKey(tenantId: string, principalId: string, capabilityId: string): string {
    return `${tenantId}::${principalId}::${capabilityId}`;
  }

  private rateUsage(key: string, windowMs: number, now: number): number {
    const state = this.rateWindows.get(key);
    if (!state) return 0;
    const cutoff = now - windowMs;
    const alive = state.timestamps.filter((t) => t > cutoff);
    if (alive.length !== state.timestamps.length) {
      this.rateWindows.set(key, { timestamps: alive });
    }
    return alive.length;
  }

  private recordRate(key: string): void {
    const state = this.rateWindows.get(key);
    const timestamps = state ? [...state.timestamps, this.now()] : [this.now()];
    this.rateWindows.set(key, { timestamps });
  }

  /**
   * Render the authoritative decision for one invocation and seal it into an
   * envelope. DENY outcomes are returned as sealed DENY envelopes (audited),
   * so every caller can present the decision without re-querying.
   */
  decide(request: A01AuthorizationRequest | null | undefined): A01AuthorizationEnvelope {
    const now = this.now();
    // Rate window usage for this decision (counted across all decisions).
    const maybeRequest = request as A01AuthorizationRequest | null | undefined;
    const capabilityId = maybeRequest?.capability?.capabilityId ?? '';
    const tenantId = typeof maybeRequest?.tenantId === 'string' ? maybeRequest.tenantId : '';
    const principalId = maybeRequest?.principal?.id ?? '';
    const usageProbe = (key: { tenantId: string; principalId: string; capabilityId: string }): number => {
      const manifest = this.manifests.get(key.capabilityId, maybeRequest?.capability?.capabilityVersion ?? '');
      const windowMs = manifest?.rateLimit.windowMs ?? 1;
      return this.rateUsage(this.rateKey(key.tenantId, key.principalId, key.capabilityId), windowMs, now);
    };
    const context: A01PolicyContext = {
      now,
      manifests: this.manifests,
      broker: this.broker,
      engine: this.engine,
      policyVersion: this.policyVersion,
      rateWindowUsage: usageProbe,
      ...(this.verifyKernelPrincipal ? { verifyKernelPrincipal: this.verifyKernelPrincipal } : {}),
    };
    const outcome = decideA01(maybeRequest, context);
    const { decision, provenance, credential, manifest } = outcome;

    const envelopeId = randomUUID();
    const safeRequest = this.sanitizeRequestForEnvelope(maybeRequest);
    // The sealed envelope carries the request's credential BINDING (id/audience/
    // scopes — never material). `credential` above is the broker CHECK result
    // (a denial reason, if any) and must not be mistaken for the binding.
    const envelopeCredential: A01CredentialBinding | null = safeRequest.credential
      ? {
          credentialId: safeRequest.credential.credentialId,
          audience: safeRequest.credential.audience ?? safeRequest.target.audience ?? null,
          scopes: [...safeRequest.credential.scopes],
        }
      : null;
    void credential;
    const envelope = sealEnvelope({
      request: safeRequest,
      decision,
      envelopeId,
      provenance,
      ...(envelopeCredential ? { credential: envelopeCredential } : {}),
    });

    // Count this decision in the rate window (denied attempts are load too).
    if (capabilityId && tenantId && principalId) {
      this.recordRate(this.rateKey(tenantId, principalId, capabilityId));
    }

    this.auditDecision(envelope, manifest);
    return envelope;
  }

  private sanitizeRequestForEnvelope(request: A01AuthorizationRequest | null | undefined): A01AuthorizationRequest {
    // The envelope mirrors only the authoritative fields; if the request was
    // structurally broken the decision is a DENY and the envelope carries the
    // sanitized (empty) identity fields rather than garbage.
    const base: A01AuthorizationRequest = {
      principal: {
        id: '',
        tenantId: '',
        roles: [],
        authenticationMethod: 'KERNEL_INTERNAL',
        authenticationEventId: '',
      },
      tenantId: '',
      agent: { agentId: '' },
      run: { runId: '', correlationId: '' },
      capability: { capabilityId: '', capabilityVersion: '' },
      tool: '',
      operation: '',
      target: { system: '' },
      dataClassification: 'INTERNAL',
      impact: 'EXTERNAL_SIDE_EFFECT',
      budgetCostUnits: 1,
    };
    if (!request || typeof request !== 'object') return base;
    const r = request as unknown as Record<string, unknown>;
    const principal = r.principal as Record<string, unknown> | undefined;
    return {
      ...base,
      ...(principal && typeof principal.id === 'string'
        ? {
            principal: {
              id: principal.id,
              tenantId: typeof principal.tenantId === 'string' ? principal.tenantId : '',
              roles: Array.isArray(principal.roles) ? principal.roles.filter((x): x is string => typeof x === 'string') : [],
              authenticationMethod: typeof principal.authenticationMethod === 'string' ? principal.authenticationMethod : 'KERNEL_INTERNAL',
              authenticationEventId: typeof principal.authenticationEventId === 'string' ? principal.authenticationEventId : '',
            },
          }
        : {}),
      ...(typeof r.tenantId === 'string' ? { tenantId: r.tenantId } : {}),
      ...(r.agent && typeof (r.agent as { agentId?: unknown }).agentId === 'string'
        ? { agent: { agentId: (r.agent as { agentId: string }).agentId } }
        : {}),
      ...(r.run && typeof (r.run as { runId?: unknown }).runId === 'string'
        ? {
            run: {
              runId: (r.run as { runId: string }).runId,
              correlationId: typeof (r.run as { correlationId?: unknown }).correlationId === 'string'
                ? (r.run as { correlationId: string }).correlationId
                : (r.run as { runId: string }).runId,
            },
          }
        : {}),
      ...(r.capability && typeof (r.capability as { capabilityId?: unknown }).capabilityId === 'string'
        ? {
            capability: {
              capabilityId: (r.capability as { capabilityId: string }).capabilityId,
              capabilityVersion: typeof (r.capability as { capabilityVersion?: unknown }).capabilityVersion === 'string'
                ? (r.capability as { capabilityVersion: string }).capabilityVersion
                : '',
            },
          }
        : {}),
      ...(typeof r.tool === 'string' ? { tool: r.tool } : {}),
      ...(typeof r.operation === 'string' ? { operation: r.operation } : {}),
      ...(r.target && typeof (r.target as { system?: unknown }).system === 'string'
        ? {
            target: {
              system: (r.target as { system: string }).system,
              ...(typeof (r.target as { resource?: unknown }).resource === 'string'
                ? { resource: (r.target as { resource: string }).resource }
                : {}),
              ...(typeof (r.target as { audience?: unknown }).audience === 'string'
                ? { audience: (r.target as { audience: string }).audience }
                : {}),
            },
          }
        : {}),
      ...(typeof r.dataClassification === 'string' ? { dataClassification: r.dataClassification as A01AuthorizationRequest['dataClassification'] } : {}),
      ...(typeof r.impact === 'string' ? { impact: r.impact as A01AuthorizationRequest['impact'] } : {}),
      ...(typeof r.idempotencyKey === 'string' ? { idempotencyKey: r.idempotencyKey } : {}),
      ...(typeof r.budgetCostUnits === 'number' ? { budgetCostUnits: r.budgetCostUnits } : {}),
      ...(r.approval && typeof (r.approval as { approvalId?: unknown }).approvalId === 'string'
        ? {
            approval: {
              approvalId: (r.approval as { approvalId: string }).approvalId,
              approverId: typeof (r.approval as { approverId?: unknown }).approverId === 'string'
                ? (r.approval as { approverId: string }).approverId
                : '',
              approvedAt: typeof (r.approval as { approvedAt?: unknown }).approvedAt === 'number'
                ? (r.approval as { approvedAt: number }).approvedAt
                : 0,
              expiresAt: typeof (r.approval as { expiresAt?: unknown }).expiresAt === 'number'
                ? (r.approval as { expiresAt: number }).expiresAt
                : Number.MAX_SAFE_INTEGER,
              approvedActionDigest: typeof (r.approval as { approvedActionDigest?: unknown }).approvedActionDigest === 'string'
                ? (r.approval as { approvedActionDigest: string }).approvedActionDigest
                : '',
            },
          }
        : {}),
      ...(r.credential && typeof (r.credential as { credentialId?: unknown }).credentialId === 'string'
        ? {
            credential: {
              credentialId: (r.credential as { credentialId: string }).credentialId,
              audience: typeof (r.credential as { audience?: unknown }).audience === 'string'
                ? (r.credential as { audience: string }).audience
                : null,
              scopes: Array.isArray((r.credential as { scopes?: unknown }).scopes)
                ? ((r.credential as { scopes: unknown[] }).scopes).filter((x): x is string => typeof x === 'string')
                : [],
            },
          }
        : {}),
    };
  }

  private auditDecision(envelope: A01AuthorizationEnvelope, manifest: A01DecisionResult['manifest'] | undefined): void {
    const record: A01AuditRecord = {
      id: `decision-${envelope.decision.decisionId}`,
      kind: 'DECISION',
      principalId: envelope.principal.id,
      tenantId: envelope.tenantId,
      agentId: envelope.agent.agentId,
      runId: envelope.run.runId,
      correlationId: envelope.provenance.correlationId,
      ...(envelope.provenance.causationId ? { causationId: envelope.provenance.causationId } : {}),
      capabilityId: envelope.capability.capabilityId,
      capabilityVersion: envelope.capability.capabilityVersion,
      tool: envelope.tool,
      operation: envelope.operation,
      targetSystem: envelope.target.system,
      ...(envelope.target.resource ? { targetResource: envelope.target.resource } : {}),
      dataClassification: envelope.dataClassification,
      impact: envelope.impact,
      decision: envelope.decision.decision,
      reasonCodes: [...envelope.decision.reasonCodes],
      policyVersion: envelope.decision.policyVersion,
      ...(envelope.approval ? { approvalReference: envelope.approval.approvalId } : {}),
      ...(envelope.credential
        ? { credentialReference: { credentialId: envelope.credential.credentialId, audience: envelope.credential.audience, scopes: [...envelope.credential.scopes] } }
        : {}),
      envelopeId: envelope.envelopeId,
      ...(envelope.provenance.idempotencyKey ? { idempotencyKey: envelope.provenance.idempotencyKey } : {}),
      decidedAt: envelope.decision.decidedAt,
    };
    try {
      const result = this.audit.record(record);
      if (result && typeof (result as Promise<void>).then === 'function') {
        // Durable sinks are async: the write completes after decide()
        // returns. The write is tracked per envelope and AWAITED by
        // executeAuthorized before any side effect — a failed durable audit
        // fails the execution closed (and latches the gate for everything
        // after it).
        (result as Promise<void>).catch(() => {
          this.auditAvailable = false;
        });
        this.decisionAudits.set(envelope.envelopeId, result as Promise<void>);
      }
    } catch {
      // A throwing audit sink: an unauditable ALLOW must not exist.
      if (envelope.decision.decision === 'ALLOW') {
        throw new AuthorizationDeniedError(['AUDIT_UNAVAILABLE'], 'authorization audit sink failed; failing closed');
      }
      // DENY decisions with a broken audit sink: still throw — provenance is
      // mandatory for every decision, not only allows.
      throw new AuthorizationDeniedError(['AUDIT_UNAVAILABLE'], 'authorization audit sink failed; failing closed');
    }
    void manifest;
  }

  /**
   * Verify that a sealed envelope is intact, an ALLOW, fresh, and bound to
   * exactly the (tool, operation, targetResource) being executed. Throws
   * `AuthorizationDeniedError` before any side effect when not.
   */
  assertEnvelope(
    envelope: unknown,
    expected: { readonly tool: string; readonly operation: string; readonly targetResource?: string },
  ): A01AuthorizationEnvelope {
    let verified: A01AuthorizationEnvelope;
    try {
      assertEnvelopeIntegrity(envelope);
      verified = envelope as A01AuthorizationEnvelope;
    } catch {
      throw new AuthorizationDeniedError(['ENVELOPE_TAMPERED', 'ENVELOPE_MALFORMED']);
    }
    const reasons = envelopeAcceptance(verified, expected, this.now());
    if (reasons.length > 0) {
      throw new AuthorizationDeniedError(reasons);
    }
    return verified;
  }

  /**
   * The single enforcement checkpoint. Verifies the envelope, consumes it
   * (replay protection), re-acquires the credential, and ONLY THEN invokes
   * the protected side effect. Any failure throws before the side effect.
   */
  async executeAuthorized<T>(
    envelope: unknown,
    sideEffect: (scoped: ScopedExecutionContext) => Promise<T>,
    expected: { readonly tool: string; readonly operation: string; readonly targetResource?: string },
  ): Promise<T> {
    if (!this.auditAvailable) {
      throw new AuthorizationDeniedError(['AUDIT_UNAVAILABLE'], 'authorization audit sink is unavailable; failing closed');
    }
    const verified = this.assertEnvelope(envelope, expected);

    // Durable provenance is a precondition of the side effect: await this
    // envelope's decision-audit write and fail closed if it failed.
    const decisionAudit = this.decisionAudits.get(verified.envelopeId);
    if (decisionAudit) {
      let auditFailed = false;
      await decisionAudit.catch(() => {
        auditFailed = true;
      });
      if (auditFailed || !this.auditAvailable) {
        this.auditConsumed(verified, false, 'audit');
        throw new AuthorizationDeniedError(['AUDIT_UNAVAILABLE'], 'durable decision audit failed; failing closed before the side effect');
      }
    }

    // Replay protection: non-READ decisions are consumed exactly once.
    if (verified.impact !== 'READ') {
      if (this.consumedEnvelopes.has(verified.envelopeId)) {
        this.auditConsumed(verified, false, 'replayed');
        throw new AuthorizationDeniedError(['REPLAYED_AUTHORIZATION']);
      }
    }

    // Idempotent duplicate delivery: a key already consumed by a successful
    // side effect returns the cached result; no re-execution.
    const idempotencyKey = verified.provenance.idempotencyKey;
    if (idempotencyKey && this.idempotencyCache.has(idempotencyKey)) {
      this.auditConsumed(verified, true, 'idempotent-replay');
      return this.idempotencyCache.get(idempotencyKey) as T;
    }

    // Budget: per-run consumption must stay within the capability budget.
    const runKey = `${verified.tenantId}::${verified.principal.id}::${verified.run.runId}`;
    const used = this.runBudgets.get(runKey) ?? 0;
    const cost = verified.decision.budgetCostUnits;
    if (used + cost > this.budgetCeiling(verified)) {
      this.auditConsumed(verified, false, 'budget');
      throw new AuthorizationDeniedError(['BUDGET_EXHAUSTED']);
    }

    // Credential: re-acquire at the enforcement point (single-use per envelope).
    let scoped: ScopedExecutionContext;
    if (verified.credential) {
      if (!this.broker || !this.broker.available()) {
        this.auditConsumed(verified, false, 'broker');
        throw new AuthorizationDeniedError(['CREDENTIAL_BROKER_UNAVAILABLE']);
      }
      try {
        const credential = this.broker.acquireFor(verified, this.manifestRequiredScopes(verified));
        scoped = { envelope: verified, credential };
      } catch (error) {
        const codes: A01DenialReason[] = error instanceof CredentialDeniedError ? [...error.reasons] : ['CREDENTIAL_REQUIRED'];
        this.auditConsumed(verified, false, 'credential');
        throw new AuthorizationDeniedError(codes, 'credential enforcement failed before the side effect');
      }
    } else {
      scoped = { envelope: verified };
    }

    // Consume NOW (before the await) so concurrent duplicates see the
    // consumption synchronously.
    if (verified.impact !== 'READ') {
      this.consumedEnvelopes.add(verified.envelopeId);
    }
    this.runBudgets.set(runKey, used + cost);

    try {
      const result = await sideEffect(scoped);
      if (idempotencyKey) {
        this.idempotencyCache.set(idempotencyKey, result);
      }
      this.auditConsumed(verified, true, 'executed');
      return result;
    } catch (error) {
      this.auditConsumed(verified, false, 'side-effect-failure');
      throw error;
    }
  }

  private budgetCeiling(envelope: A01AuthorizationEnvelope): number {
    const manifest = this.manifests.get(envelope.capability.capabilityId, envelope.capability.capabilityVersion);
    return manifest ? manifest.budgetPerRunCostUnits : 0;
  }

  private manifestRequiredScopes(envelope: A01AuthorizationEnvelope): readonly string[] {
    const manifest = this.manifests.get(envelope.capability.capabilityId, envelope.capability.capabilityVersion);
    return manifest ? manifest.requiredCredentialScopes : [];
  }

  private auditConsumed(envelope: A01AuthorizationEnvelope, sideEffectInvoked: boolean, detail: string): void {
    const record: A01AuditRecord = {
      id: `consumed-${envelope.envelopeId}-${detail}`,
      kind: 'CONSUMED',
      principalId: envelope.principal.id,
      tenantId: envelope.tenantId,
      agentId: envelope.agent.agentId,
      runId: envelope.run.runId,
      correlationId: envelope.provenance.correlationId,
      ...(envelope.provenance.causationId ? { causationId: envelope.provenance.causationId } : {}),
      capabilityId: envelope.capability.capabilityId,
      capabilityVersion: envelope.capability.capabilityVersion,
      tool: envelope.tool,
      operation: envelope.operation,
      targetSystem: envelope.target.system,
      ...(envelope.target.resource ? { targetResource: envelope.target.resource } : {}),
      dataClassification: envelope.dataClassification,
      impact: envelope.impact,
      decision: envelope.decision.decision,
      reasonCodes: [...envelope.decision.reasonCodes],
      policyVersion: envelope.decision.policyVersion,
      ...(envelope.approval ? { approvalReference: envelope.approval.approvalId } : {}),
      ...(envelope.credential
        ? { credentialReference: { credentialId: envelope.credential.credentialId, audience: envelope.credential.audience, scopes: [...envelope.credential.scopes] } }
        : {}),
      envelopeId: envelope.envelopeId,
      ...(envelope.provenance.idempotencyKey ? { idempotencyKey: envelope.provenance.idempotencyKey } : {}),
      decidedAt: envelope.decision.decidedAt,
      consumedAt: this.now(),
      sideEffectInvoked,
    };
    try {
      const result = this.audit.record(record);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch(() => {
          this.auditAvailable = false;
        });
      }
    } catch {
      // Consumption of a DENIED/failed path with a broken audit sink is
      // recorded best-effort; the ALLOW path already requires audit success.
    }
  }
}

export type { A01DenialReason };
