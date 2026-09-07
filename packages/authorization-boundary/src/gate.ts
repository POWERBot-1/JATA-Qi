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
import { assertEnvelopeIntegrity, envelopeAcceptance, sanitizeRequestForEnvelope, sealEnvelope } from './envelope.js';
import { decideA01, type A01DecisionResult, type A01PolicyContext } from './policy-engine.js';
import { buildConsumedAuditRecord, buildDecisionAuditRecord, InMemoryAuditSink } from './audit.js';
import type { DurableCredentialBroker } from './credential-store.js';
import { DurableDecider } from './durable-decider.js';
import type { SecurityRetryStats, SecurityStateStore } from './security-state-store.js';
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
  /**
   * R2: the authoritative durable security-state substrate. When attached,
   * `decide()` throws (a sync API cannot consult durable state) and
   * `decideAsync()` + the durable enforcement path are the ONLY decision
   * paths; the process-local rate/budget/replay/idempotency state below is
   * NOT consulted. When absent, the exact R1 in-memory path runs.
   */
  readonly store?: SecurityStateStore;
  /**
   * R2: durable credential broker (required when `store` is attached —
   * construction throws otherwise). The sync `broker` above is NOT
   * consulted on the durable path.
   */
  readonly durableBroker?: DurableCredentialBroker;
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
  private readonly store: SecurityStateStore | undefined;
  private readonly durable: DurableDecider | undefined;
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
    this.store = config.store;
    if (this.store && !config.durableBroker) {
      throw new AuthorizationDeniedError(
        ['SECURITY_STATE_UNAVAILABLE'],
        'a gate with durable security state requires a durable credential broker (fail-closed)',
      );
    }
    this.durable = this.store
      ? new DurableDecider({
          store: this.store,
          broker: config.durableBroker as DurableCredentialBroker,
          audit: this.audit,
          ...(config.engine ? { engine: config.engine } : {}),
          policyVersion: this.policyVersion,
          now: this.now,
          ...(this.verifyKernelPrincipal ? { verifyKernelPrincipal: this.verifyKernelPrincipal } : {}),
        })
      : undefined;
  }

  get manifestsRegistry(): CapabilityManifestRegistry {
    return this.manifests;
  }

  /** The configured credential broker (diagnostics; never grants anything). */
  get credentialBroker(): CredentialBroker | undefined {
    return this.broker;
  }

  /** R2: the attached durable security-state substrate, if any. */
  get securityStore(): SecurityStateStore | undefined {
    return this.store;
  }

  /** R2: cumulative durable-transaction/retry counters (evidence; zeros when no store). */
  getSecurityRetryStats(): SecurityRetryStats {
    return this.store?.getRetryStats() ?? { transactions: 0, retriesSerialization: 0, retriesDeadlock: 0 };
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
   *
   * R2: when a durable store is attached this method THROWS — a sync API
   * cannot consult durable security state, so it MUST NOT render decisions.
   * Use `decideAsync()`.
   */
  decide(request: A01AuthorizationRequest | null | undefined): A01AuthorizationEnvelope {
    if (this.store) {
      throw new AuthorizationDeniedError(
        ['SECURITY_STATE_UNAVAILABLE'],
        'sync decide() cannot consult durable security state; use decideAsync() (fail-closed)',
      );
    }
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
    const safeRequest = sanitizeRequestForEnvelope(maybeRequest);
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

  /**
   * R2: render the authoritative DURABLE decision (Tx-bound rate, session,
   * credential, PDP, and audit) when a store is attached. Without a store
   * this delegates to the exact R1 sync semantics, additionally awaiting
   * the decision-audit confirmation (strictly stronger than `decide()`).
   */
  async decideAsync(request: A01AuthorizationRequest | null | undefined): Promise<A01AuthorizationEnvelope> {
    if (this.durable) {
      return this.durable.decideAsync(request);
    }
    const envelope = this.decide(request);
    const pending = this.decisionAudits.get(envelope.envelopeId);
    if (pending) {
      let auditFailed = false;
      await pending.catch(() => {
        auditFailed = true;
      });
      if (auditFailed || !this.auditAvailable) {
        throw new AuthorizationDeniedError(['AUDIT_UNAVAILABLE'], 'durable decision audit failed; failing closed');
      }
    }
    return envelope;
  }

  private auditDecision(envelope: A01AuthorizationEnvelope, manifest: A01DecisionResult['manifest'] | undefined): void {
    const record: A01AuditRecord = buildDecisionAuditRecord(envelope);
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
    // R2: one enforcement entry point — the attached store selects the
    // durable Tx-1/Tx-2 path; without a store the exact R1 path runs.
    if (this.durable) {
      return this.durable.executeDurable(envelope, sideEffect, expected);
    }
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
    const record: A01AuditRecord = buildConsumedAuditRecord(envelope, {
      consumedAt: this.now(),
      sideEffectInvoked,
      detail,
    });
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
