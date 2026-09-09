// R2 — durable decision + enforcement path (`decideAsync` / Tx-1 + Tx-2).
//
// This is the ONLY path that renders or consumes authorization when a
// SecurityStateStore is attached. Fail-closed contract:
//
//   * `decideAsync`: system-scope ACTIVE-manifest read → ONE tenant
//     transaction { rate increment → session check → credential preload →
//     pure PDP `decideA01` (unchanged) → sink audit → S-10 DECISION } →
//     sealed envelope citing manifestId + manifestDigest + sessionEventId
//     + sessionStatus + securityStoreTxId.
//   * Enforcement (`executeDurable`): envelope integrity + skew-strict
//     freshness + citation check → live ACTIVE-manifest digest match →
//     Tx-1 { session re-check (no-op CAS lock) → S-4 → S-5 → S-7 →
//     credential re-check (no-op CAS lock) + S-3 } → side effect (with
//     S-5 heartbeat) → Tx-2 { S-5 completion + CONSUMED receipt }.
//   * Any storage failure, at any point, ⇒ DENY with
//     SECURITY_STATE_UNAVAILABLE. Uncertainty never produces ALLOW, zero
//     usage, or "unrevoked".
//   * Retry transparency: `transact` retries may re-run the decision
//     closure (quota may be over-counted — safe direction) and may emit
//     duplicate sink records for rolled-back attempts (S-10 holds exactly
//     the committed receipt — the authoritative channel).

import { randomUUID } from 'node:crypto';
import {
  assessSessionRow,
  type AuthenticationEventDoc,
  type IdentityStateAuthority,
} from '@jataqi/authentication';
import { StorageModule, type ICollection } from '@jataqi/storage';
import { buildConsumedAuditRecord, buildDecisionAuditRecord } from './audit.js';
import { CapabilityManifestRegistry } from './capability-manifests.js';
import {
  claimIdempotency,
  completeIdempotency,
  consumeBudget,
  consumeEnvelope,
  extendIdempotencyLease,
  failIdempotency,
  FALLBACK_RATE_WINDOW_MS,
  IDEMPOTENCY_HEARTBEAT_MS,
  IDEMPOTENCY_LEASE_MS,
  incrementRateWindow,
} from './consumption-stores.js';
import { checkCredentialRow, DurableCredentialBroker, isCredentialExpired, type CredentialDoc } from './credential-store.js';
import { assertEnvelopeIntegrity, envelopeAcceptance, sanitizeRequestForEnvelope, sealEnvelope } from './envelope.js';
import { decideA01, type A01PolicyContext } from './policy-engine.js';
import {
  R2_SKEW_MS,
  SecurityStateStore,
  type ActiveManifest,
  type SecurityTxCollections,
} from './security-state-store.js';
import {
  AuthorizationDeniedError,
  CredentialDeniedError,
  type A01AuditSink,
  type A01AuthorizationEnvelope,
  type A01AuthorizationRequest,
  type A01CredentialCheckView,
  type A01DecisionRecord,
  type A01DenialReason,
  type A01IdempotencyReceipt,
  type A01PolicyEngine,
  type A01ProvenanceBinding,
  type A01SessionAuditStatus,
  type CredentialBroker,
} from './types.js';
import type { ScopedExecutionContext } from './gate.js';

export interface DurableDeciderDeps {
  readonly store: SecurityStateStore;
  readonly broker: DurableCredentialBroker;
  readonly audit: A01AuditSink;
  readonly engine?: A01PolicyEngine;
  readonly policyVersion: string;
  readonly now: () => number;
  readonly verifyKernelPrincipal?: (principal: unknown, scope: string) => boolean;
  /**
   * P2-S1: the identity-state authority consulted INSIDE the Phase-B tenant
   * transaction (spec §24-S1 "identity-state check inside the Phase-B
   * transaction"). Absent (undefined) ⇒ the exact pre-P2 decision behavior
   * (no identity gate, no role re-read) — the P1/R2 substrate is unchanged.
   * Present ⇒ every decision re-reads the principal's identity state and
   * ACTIVE role assignments (no role set is cached across decisions); a
   * non-ACTIVATED identity or a tenant mismatch renders a DENY; the request
   * role set is NARROWED to the ACTIVE assignments before the PDP runs.
   * The resolver is lazy (the decision-time kernel is fully booted) and
   * fail-closed: a resolver/lookup failure is a storage-failure DENY.
   */
  readonly identityAuthorityResolver?: () => IdentityStateAuthority | undefined | Promise<IdentityStateAuthority | undefined>;
}

/** Internal: a COMPLETED S-5 row was found — roll back Tx-1 and return the receipt. */
class IdempotentReplaySignal {
  constructor(readonly receipt: A01IdempotencyReceipt) {}
}

/** One enforcement transaction's post-commit work items. */
interface Tx1Outcome {
  readonly leaseNonce?: string;
  readonly idempotencyKey?: string;
  readonly credential?: { credentialId: string; audience: string; scopes: readonly string[]; expiresAt: number };
}

function isValidTenantId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    StorageModule.validateTenantId(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * P2-S1: narrow a request's principal role set to the intersection with the
 * ACTIVE role assignments re-read in the decision transaction (spec §4.1 —
 * the role set at decision time is asserted ∩ assigned, never cached).
 * Pure narrowing: a role without an ACTIVE assignment is dropped; no role
 * is ever added. Returns the same object when nothing changed.
 */
function narrowRequestRoles(
  request: A01AuthorizationRequest,
  activeRoles: readonly string[],
): A01AuthorizationRequest {
  const principal = request.principal;
  if (!principal || !Array.isArray(principal.roles)) return request;
  const allowed = new Set(activeRoles);
  const narrowed = principal.roles.filter((role) => allowed.has(role));
  if (narrowed.length === principal.roles.length) return request;
  return { ...request, principal: { ...principal, roles: narrowed } };
}

export class DurableDecider {
  private readonly store: SecurityStateStore;
  private readonly broker: DurableCredentialBroker;
  private readonly audit: A01AuditSink;
  private readonly engine: A01PolicyEngine | undefined;
  private readonly policyVersion: string;
  private readonly now: () => number;
  private readonly verifyKernelPrincipal: ((principal: unknown, scope: string) => boolean) | undefined;
  private readonly identityAuthorityResolver: DurableDeciderDeps['identityAuthorityResolver'];
  private identityAuthorityCache: IdentityStateAuthority | undefined;
  private identityAuthorityResolved = false;

  constructor(deps: DurableDeciderDeps) {
    this.store = deps.store;
    this.broker = deps.broker;
    this.audit = deps.audit;
    this.engine = deps.engine;
    this.policyVersion = deps.policyVersion;
    this.now = deps.now;
    this.verifyKernelPrincipal = deps.verifyKernelPrincipal;
    this.identityAuthorityResolver = deps.identityAuthorityResolver;
  }

  /**
   * P2-S1: lazily resolve the identity-state authority (once; the kernel is
   * fully booted by decision time). Fail-closed: a resolver failure re-throws
   * (the Phase-B catch turns it into a storage-failure DENY) and is NOT
   * cached as "resolved" — a broken resolver must keep failing closed.
   */
  private async resolveIdentityAuthority(): Promise<IdentityStateAuthority | undefined> {
    if (this.identityAuthorityResolved) return this.identityAuthorityCache;
    this.identityAuthorityResolved = true;
    try {
      this.identityAuthorityCache = this.identityAuthorityResolver
        ? await this.identityAuthorityResolver()
        : undefined;
    } catch (error) {
      this.identityAuthorityResolved = false;
      throw error;
    }
    return this.identityAuthorityCache;
  }

  // -- decideAsync ----------------------------------------------------------

  /**
   * Render the authoritative durable decision for one invocation.
   * DENY outcomes (including storage-failure DENYs) are returned as sealed
   * DENY envelopes whenever the audit can be confirmed; only a failed audit
   * itself throws (R1 precedent: an unaudited decision must not exist).
   */
  async decideAsync(request: A01AuthorizationRequest | null | undefined): Promise<A01AuthorizationEnvelope> {
    const now = this.now();
    const envelopeId = randomUUID();
    const maybeRequest = request as A01AuthorizationRequest | null | undefined;
    const capabilityId = maybeRequest?.capability?.capabilityId ?? '';
    const tenantId = typeof maybeRequest?.tenantId === 'string' ? maybeRequest.tenantId : '';
    const principalId = maybeRequest?.principal?.id ?? '';

    // Phase A: system-scope ACTIVE-manifest read (policy lookup is
    // inherently cross-tenant; PDP tenant checks still apply per decision).
    let active: ActiveManifest | undefined;
    try {
      active = capabilityId ? await this.store.getActiveManifest(capabilityId) : undefined;
    } catch (error) {
      return this.storageFailureDeny(maybeRequest, envelopeId, now, error);
    }

    // Requests without a usable tenant cannot open a tenant transaction:
    // render the structural DENY without durable state (sink-audited).
    if (!isValidTenantId(tenantId)) {
      return this.unscopedDeny(maybeRequest, envelopeId, now);
    }

    // Phase B: ONE tenant transaction binds rate + session + credential +
    // PDP + audit. Any throw inside ⇒ rollback ⇒ storage-failure DENY.
    try {
      return await this.store.transact({ tenantId }, async (collections, txId) =>
        this.renderDecisionTx(collections, txId, maybeRequest, envelopeId, active, now, { tenantId, principalId, capabilityId }),
      );
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        // Unreachable: the tx body renders DENYs as envelopes, never throws
        // them. Defense in depth — fail closed if that ever changes.
        return this.storageFailureDeny(maybeRequest, envelopeId, now, error);
      }
      return this.storageFailureDeny(maybeRequest, envelopeId, now, error);
    }
  }

  /** The Phase-B transaction body: rate → session → credential → PDP → audit. */
  private async renderDecisionTx(
    collections: SecurityTxCollections,
    txId: string,
    maybeRequest: A01AuthorizationRequest | null | undefined,
    envelopeId: string,
    active: ActiveManifest | undefined,
    now: number,
    ids: { tenantId: string; principalId: string; capabilityId: string },
  ): Promise<A01AuthorizationEnvelope> {
    // 1. Rate reservation (every rendered decision is load, ALLOW or DENY).
    let usage = 0;
    if (ids.capabilityId && ids.tenantId && ids.principalId) {
      const windowMs = active?.manifest.rateLimit.windowMs ?? FALLBACK_RATE_WINDOW_MS;
      const count = await incrementRateWindow(collections.rateWindows, {
        tenantId: ids.tenantId,
        principalId: ids.principalId,
        capabilityId: ids.capabilityId,
        windowMs,
        now,
      });
      usage = count - 1;
    }

    // 2. Session validation (non-kernel eventIds; kernel principals verify
    // cryptographically — see assessSessionClaim).
    const session = await this.assessSessionClaim(collections.sessions, maybeRequest, now);
    if (!session.verdict) {
      return this.renderSessionDenyTx(collections, txId, maybeRequest, envelopeId, active, now, session);
    }

    // 2.5 P2-S1: the identity-state + role re-read INSIDE this transaction
    // (spec §24-S1). Fail-closed: a lookup failure rolls back the
    // transaction (storage-failure DENY). Absent authority ⇒ the exact
    // pre-P2 behavior (unlinked principals keep their pre-S1 decisions).
    let requestForPdp = maybeRequest;
    const identity = await this.assessIdentityClaim(collections, maybeRequest, now);
    if (identity.denial) {
      return this.renderIdentityDenyTx(collections, txId, maybeRequest, envelopeId, active, now, session, identity.denial);
    }
    if (identity.narrowedRequest !== undefined) {
      requestForPdp = identity.narrowedRequest;
    }

    // 3. Credential preload for the PDP adapter (checks run inside PDP).
    let credentialRow: CredentialDoc | undefined;
    const presentedId = maybeRequest?.credential?.credentialId;
    if (active && active.manifest.requiredCredentialScopes.length > 0 && typeof presentedId === 'string' && presentedId) {
      const row = await collections.credentials.get(presentedId);
      if (row && row.tenantId === ids.tenantId) {
        if (row.status === 'ACTIVE' && isCredentialExpired(row.expiresAt, now)) {
          await collections.credentials.cas(
            row.id,
            (cur) => !!cur && cur.status === 'ACTIVE' && isCredentialExpired(cur.expiresAt, now),
            (cur) => ({ ...cur, status: 'EXPIRED' as const, updatedAt: now }),
          );
          credentialRow = { ...row, status: 'EXPIRED' as const };
        } else {
          credentialRow = { ...row };
        }
      }
    }

    // 4. Pure PDP (unchanged): ephemeral single-manifest registry (the
    // request MUST cite the ACTIVE version), row-backed broker adapter,
    // post-increment probe.
    const registry = new CapabilityManifestRegistry();
    if (active) registry.register(active.manifest);
    const brokerAdapter = {
      available: (): boolean => true,
      checkFor: (view: A01CredentialCheckView, requiredScopes: readonly string[]): readonly A01DenialReason[] => {
        const matched = credentialRow && view.credential?.credentialId === credentialRow.id ? credentialRow : undefined;
        return checkCredentialRow(matched, view, requiredScopes, false, now);
      },
    } as CredentialBroker;
    const context: A01PolicyContext = {
      now,
      manifests: registry,
      broker: brokerAdapter,
      engine: this.engine,
      policyVersion: this.policyVersion,
      rateWindowUsage: () => usage,
      ...(this.verifyKernelPrincipal ? { verifyKernelPrincipal: this.verifyKernelPrincipal } : {}),
    };
    const outcome = decideA01(requestForPdp, context);

    // 5. Seal with durable citations → sink audit (first, in-tx) → S-10.
    // The sealed request is the (possibly identity-narrowed) request that
    // the PDP actually evaluated.
    const safeRequest = sanitizeRequestForEnvelope(requestForPdp);
    const envelopeCredential = safeRequest.credential
      ? {
          credentialId: safeRequest.credential.credentialId,
          audience: safeRequest.credential.audience ?? safeRequest.target.audience ?? null,
          scopes: [...safeRequest.credential.scopes],
        }
      : undefined;
    const envelope = sealEnvelope({
      request: safeRequest,
      decision: outcome.decision,
      envelopeId,
      provenance: outcome.provenance,
      ...(envelopeCredential ? { credential: envelopeCredential } : {}),
      durableCitations: {
        ...(active ? { manifestId: active.manifestId, manifestDigest: active.digest } : {}),
        ...(session.eventId ? { sessionEventId: session.eventId } : {}),
        sessionStatus: session.status,
        securityStoreTxId: txId,
      },
    });
    await this.recordDecisionTx(collections, envelope);
    return envelope;
  }

  /**
   * Assess the request's session claim WITHOUT throwing for evidence
   * problems (revoked/expired/unknown ⇒ non-verdict + audit status).
   * Structurally malformed principals fall through to the PDP (which owns
   * the MISSING_/FORGED_ codes). Kernel-method principals MUST verify
   * cryptographically; unverified ones fall back to the S-8 check (fail
   * closed — R1's unverified-match gap is closed on the durable path).
   */
  private async assessSessionClaim(
    sessions: ICollection<AuthenticationEventDoc>,
    maybeRequest: A01AuthorizationRequest | null | undefined,
    now: number,
  ): Promise<{ verdict: boolean; eventId: string; status: A01SessionAuditStatus }> {
    const principal = maybeRequest?.principal as
      | { id?: unknown; tenantId?: unknown; authenticationMethod?: unknown; authenticationEventId?: unknown }
      | undefined;
    const eventId = typeof principal?.authenticationEventId === 'string' ? principal.authenticationEventId : '';
    if (!principal || typeof principal !== 'object' || !eventId) {
      // Malformed principal: the PDP owns this verdict (MISSING_/FORGED_).
      return { verdict: true, eventId: '', status: 'UNKNOWN' };
    }
    if (principal.authenticationMethod === 'KERNEL_INTERNAL') {
      const raw = maybeRequest?.principal;
      if (this.verifyKernelPrincipal?.(raw, 'kernel:internal-execution') === true) {
        return { verdict: true, eventId, status: 'KERNEL_INTERNAL_VERIFIED' };
      }
      // Unverified kernel claim: fall through to the S-8 evidence check
      // (an S-8 row for a kernel eventId is unexpected ⇒ UNKNOWN ⇒ deny).
    }
    const row = eventId ? await sessions.get(eventId) : undefined;
    const requestTenant = typeof maybeRequest?.tenantId === 'string' ? maybeRequest.tenantId : '';
    if (row && row.tenantId !== requestTenant) {
      return { verdict: false, eventId, status: 'UNKNOWN' };
    }
    const assessment = assessSessionRow(row, now);
    if (!assessment.active) {
      return { verdict: false, eventId, status: assessment.status };
    }
    return { verdict: true, eventId, status: 'ACTIVE' };
  }

  /**
   * P2-S1: the identity-state re-read (spec §4.1: no role set or membership
   * state is cached across decisions). Runs INSIDE the Phase-B tenant
   * transaction through the passed scope (one consistent snapshot).
   *
   *   * no identity authority configured          ⇒ pre-P2 passthrough;
   *   * KERNEL_INTERNAL principal                 ⇒ skipped (cryptographic
   *     kernel verification is the authority — same rule as the session
   *     stage);
   *   * no identity record for (tenant, principal) ⇒ passthrough (the
   *     pre-P2 decision behavior for unlinked principals is preserved
   *     exactly — only EXISTING identities are gated);
   *   * identity tenant ≠ request tenant          ⇒ DENY
   *     IDENTITY_TENANT_MISMATCH (tenant substitution);
   *   * identity state ≠ ACTIVATED                ⇒ DENY
   *     IDENTITY_STATE_INACTIVE (ENROLLED/SUSPENDED/DEACTIVATED/
   *     DEPROVISIONED — a suspended or terminal identity cannot hold a
   *     privilege, stale or not);
   *   * ACTIVATED                                 ⇒ the request role set is
   *     NARROWED to the ACTIVE role assignments (intersection; never
   *     widened) and the narrowed request is what the PDP evaluates.
   *
   * Any storage failure propagates (the Phase-B catch ⇒ storage-failure
   * DENY — uncertainty never produces ALLOW).
   */
  private async assessIdentityClaim(
    collections: SecurityTxCollections,
    maybeRequest: A01AuthorizationRequest | null | undefined,
    now: number,
  ): Promise<{
    readonly denial?: {
      readonly code: 'IDENTITY_STATE_INACTIVE' | 'IDENTITY_TENANT_MISMATCH';
      readonly state?: string;
      readonly identityTenant?: string;
    };
    readonly narrowedRequest?: A01AuthorizationRequest;
  }> {
    const authority = await this.resolveIdentityAuthority();
    if (!authority) return {};
    const principal = maybeRequest?.principal as
      | { id?: unknown; tenantId?: unknown; authenticationMethod?: unknown }
      | undefined;
    if (!principal || typeof principal !== 'object') return {};
    if (principal.authenticationMethod === 'KERNEL_INTERNAL') return {};
    const tenantId = typeof maybeRequest?.tenantId === 'string' ? maybeRequest.tenantId : '';
    const principalId = typeof principal.id === 'string' ? principal.id : '';
    if (!tenantId || !principalId) return {};
    const lookup = await authority.lookupInTx(collections.scope, tenantId, principalId, now);
    if (!lookup) return {};
    if (lookup.tenantId !== tenantId) {
      return { denial: { code: 'IDENTITY_TENANT_MISMATCH', state: lookup.state, identityTenant: lookup.tenantId } };
    }
    if (lookup.state !== 'ACTIVATED') {
      return { denial: { code: 'IDENTITY_STATE_INACTIVE', state: lookup.state } };
    }
    if (maybeRequest) {
      const narrowed = narrowRequestRoles(maybeRequest, lookup.activeRoles);
      if (narrowed !== maybeRequest) return { narrowedRequest: narrowed };
    }
    return {};
  }

  /**
   * Short-circuit DENY for a failed identity-state re-read (still fully
   * audited in-tx; the sealed request is the PRE-narrowing request, since
   * the denial precedes the PDP).
   */
  private async renderIdentityDenyTx(
    collections: SecurityTxCollections,
    txId: string,
    maybeRequest: A01AuthorizationRequest | null | undefined,
    envelopeId: string,
    active: ActiveManifest | undefined,
    now: number,
    session: { eventId: string; status: A01SessionAuditStatus },
    denial: { readonly code: 'IDENTITY_STATE_INACTIVE' | 'IDENTITY_TENANT_MISMATCH'; readonly state?: string; readonly identityTenant?: string },
  ): Promise<A01AuthorizationEnvelope> {
    const safeRequest = sanitizeRequestForEnvelope(maybeRequest);
    const decision: A01DecisionRecord = {
      decisionId: `dec-${now}-${randomUUID().slice(0, 8)}`,
      decision: 'DENY',
      reasonCodes: Object.freeze([denial.code] as const),
      policyVersion: this.policyVersion,
      decidedAt: now,
      expiresAt: now,
      budgetCostUnits: 1,
    };
    const run = safeRequest.run;
    const provenance: A01ProvenanceBinding = Object.freeze({
      source: 'authorization-boundary',
      correlationId: run.correlationId || run.runId,
      createdAt: now,
    });
    const envelope = sealEnvelope({
      request: safeRequest,
      decision,
      envelopeId,
      provenance,
      durableCitations: {
        ...(active ? { manifestId: active.manifestId, manifestDigest: active.digest } : {}),
        ...(session.eventId ? { sessionEventId: session.eventId } : {}),
        sessionStatus: session.status,
        securityStoreTxId: txId,
      },
    });
    await this.recordDecisionTx(collections, envelope);
    return envelope;
  }

  /** Short-circuit DENY for a failed session claim (still fully audited in-tx). */
  private async renderSessionDenyTx(
    collections: SecurityTxCollections,
    txId: string,
    maybeRequest: A01AuthorizationRequest | null | undefined,
    envelopeId: string,
    active: ActiveManifest | undefined,
    now: number,
    session: { eventId: string; status: A01SessionAuditStatus },
  ): Promise<A01AuthorizationEnvelope> {
    const safeRequest = sanitizeRequestForEnvelope(maybeRequest);
    const decision: A01DecisionRecord = {
      decisionId: `dec-${now}-${randomUUID().slice(0, 8)}`,
      decision: 'DENY',
      reasonCodes: Object.freeze(['PRINCIPAL_REVOKED'] as const),
      policyVersion: this.policyVersion,
      decidedAt: now,
      expiresAt: now,
      budgetCostUnits: 1,
    };
    const run = safeRequest.run;
    const provenance: A01ProvenanceBinding = Object.freeze({
      source: 'authorization-boundary',
      correlationId: run.correlationId || run.runId,
      createdAt: now,
    });
    const envelope = sealEnvelope({
      request: safeRequest,
      decision,
      envelopeId,
      provenance,
      durableCitations: {
        ...(active ? { manifestId: active.manifestId, manifestDigest: active.digest } : {}),
        sessionEventId: session.eventId,
        sessionStatus: session.status,
        securityStoreTxId: txId,
      },
    });
    await this.recordDecisionTx(collections, envelope);
    return envelope;
  }

  /** Sink-first, in-tx DECISION audit: sink confirmation, then the S-10 receipt. */
  private async recordDecisionTx(collections: SecurityTxCollections, envelope: A01AuthorizationEnvelope): Promise<void> {
    const record = buildDecisionAuditRecord(envelope);
    await this.audit.record(record);
    await SecurityStateStore.putAuditReceipt(collections.decisions, record, 'decideAsync', true);
  }

  /** Unscoped fallback: no usable tenant ⇒ no tx; structural DENY via the pure PDP, sink-audited. */
  private async unscopedDeny(
    maybeRequest: A01AuthorizationRequest | null | undefined,
    envelopeId: string,
    now: number,
  ): Promise<A01AuthorizationEnvelope> {
    const context: A01PolicyContext = {
      now,
      manifests: new CapabilityManifestRegistry(),
      engine: this.engine,
      policyVersion: this.policyVersion,
      rateWindowUsage: () => 0,
      ...(this.verifyKernelPrincipal ? { verifyKernelPrincipal: this.verifyKernelPrincipal } : {}),
    };
    const outcome = decideA01(maybeRequest, context);
    const safeRequest = sanitizeRequestForEnvelope(maybeRequest);
    const envelope = sealEnvelope({
      request: safeRequest,
      decision: outcome.decision,
      envelopeId,
      provenance: outcome.provenance,
    });
    try {
      await this.audit.record(buildDecisionAuditRecord(envelope));
    } catch {
      throw new AuthorizationDeniedError(['AUDIT_UNAVAILABLE'], 'authorization audit sink failed; failing closed');
    }
    return envelope;
  }

  /**
   * Storage-failure DENY: seal a DENY envelope citing
   * SECURITY_STATE_UNAVAILABLE (sink-audited; a receipt tx is attempted
   * when the tenant is usable, since the failure may have been transient
   * or confined to the system-scope read).
   */
  private async storageFailureDeny(
    maybeRequest: A01AuthorizationRequest | null | undefined,
    envelopeId: string,
    now: number,
    error: unknown,
  ): Promise<A01AuthorizationEnvelope> {
    const safeRequest = sanitizeRequestForEnvelope(maybeRequest);
    const decision: A01DecisionRecord = {
      decisionId: `dec-${now}-${randomUUID().slice(0, 8)}`,
      decision: 'DENY',
      reasonCodes: Object.freeze(['SECURITY_STATE_UNAVAILABLE'] as const),
      policyVersion: this.policyVersion,
      decidedAt: now,
      expiresAt: now,
      budgetCostUnits: 1,
    };
    const run = safeRequest.run;
    const provenance: A01ProvenanceBinding = Object.freeze({
      source: 'authorization-boundary',
      correlationId: run.correlationId || run.runId,
      createdAt: now,
    });
    const envelope = sealEnvelope({ request: safeRequest, decision, envelopeId, provenance });
    const record = buildDecisionAuditRecord(envelope);
    try {
      await this.audit.record(record);
    } catch {
      throw new AuthorizationDeniedError(
        ['SECURITY_STATE_UNAVAILABLE', 'AUDIT_UNAVAILABLE'],
        `durable security state failed (${error instanceof Error ? error.message : String(error)}) and the audit sink is unavailable; failing closed`,
      );
    }
    const tenantId = typeof maybeRequest?.tenantId === 'string' ? maybeRequest.tenantId : '';
    if (isValidTenantId(tenantId)) {
      try {
        await this.store.transact({ tenantId }, async (collections) => {
          await SecurityStateStore.putAuditReceipt(collections.decisions, record, 'decideAsync/storage-failure', false);
        });
      } catch {
        throw new AuthorizationDeniedError(
          ['SECURITY_STATE_UNAVAILABLE'],
          'durable security state failed and the failure receipt could not be confirmed; failing closed',
        );
      }
    }
    return envelope;
  }

  // -- executeDurable (Tx-1 + side effect + Tx-2) ------------------------------

  /**
   * Durable enforcement: integrity + skew-strict freshness + citations →
   * live digest match → Tx-1 → material → side effect (heartbeat) → Tx-2.
   * Any failure before the side effect throws before it runs; receipt
   * failures after it throw honestly (reconciliation shows the orphan).
   */
  async executeDurable<T>(
    envelope: unknown,
    sideEffect: (scoped: ScopedExecutionContext) => Promise<T>,
    expected: { readonly tool: string; readonly operation: string; readonly targetResource?: string },
  ): Promise<T> {
    const now = this.now();
    let verified: A01AuthorizationEnvelope;
    try {
      assertEnvelopeIntegrity(envelope);
      verified = envelope as A01AuthorizationEnvelope;
    } catch {
      throw new AuthorizationDeniedError(['ENVELOPE_TAMPERED', 'ENVELOPE_MALFORMED']);
    }
    const reasons = envelopeAcceptance(verified, expected, now);
    if (now + R2_SKEW_MS >= verified.decision.expiresAt && !reasons.includes('AUTHORIZATION_EXPIRED')) {
      reasons.push('AUTHORIZATION_EXPIRED');
    }
    if (reasons.length > 0) {
      throw new AuthorizationDeniedError([...reasons]);
    }
    if (!verified.manifestId || !verified.manifestDigest) {
      throw new AuthorizationDeniedError(
        ['CAPABILITY_VERSION_MISMATCH'],
        'durable enforcement requires decideAsync citations (manifestId + manifestDigest); sync-path envelopes cannot be consumed durably',
      );
    }
    if (!isValidTenantId(verified.tenantId)) {
      throw new AuthorizationDeniedError(['SECURITY_STATE_UNAVAILABLE'], 'envelope tenant is unusable for durable enforcement');
    }
    const tenantId = verified.tenantId;

    // Live ACTIVE-manifest digest match (rotation since decide ⇒ deny).
    let active: ActiveManifest | undefined;
    try {
      active = await this.store.getActiveManifest(verified.capability.capabilityId);
    } catch (error) {
      throw this.storageDenied(error);
    }
    if (!active) {
      throw new AuthorizationDeniedError(
        ['SECURITY_STATE_UNAVAILABLE'],
        'durable manifest state vanished for a cited capability (fail-closed)',
      );
    }
    if (active.manifestId !== verified.manifestId || active.digest !== verified.manifestDigest) {
      await this.bestEffortDenyReceipt(verified, 'denied-stale-manifest');
      throw new AuthorizationDeniedError(
        ['CAPABILITY_VERSION_MISMATCH'],
        'the cited manifest revision is no longer ACTIVE (rotated since decide; re-decide)',
      );
    }

    // Tx-1: session lock → S-4 → S-5 → S-7 → credential lock + S-3.
    let tx1: Tx1Outcome;
    try {
      tx1 = await this.store.transact({ tenantId }, async (collections) =>
        this.renderTx1(collections, verified, active!, now),
      );
    } catch (error) {
      if (error instanceof IdempotentReplaySignal) {
        return this.idempotentReplay(verified, error.receipt) as unknown as T;
      }
      if (error instanceof AuthorizationDeniedError) {
        await this.bestEffortDenyReceipt(verified, 'denied');
        throw error;
      }
      if (error instanceof CredentialDeniedError) {
        await this.bestEffortDenyReceipt(verified, 'denied');
        throw new AuthorizationDeniedError([...error.reasons], 'credential enforcement failed before the side effect');
      }
      await this.bestEffortDenyReceipt(verified, 'denied');
      throw this.storageDenied(error);
    }

    // Material, post-commit, pre-side-effect (the only material touch point).
    let scoped: ScopedExecutionContext;
    if (tx1.credential) {
      let material: string;
      try {
        material = await this.broker.fetchMaterial(tx1.credential.credentialId, verified.envelopeId);
      } catch (error) {
        await this.bestEffortDenyReceipt(verified, 'denied');
        if (error instanceof CredentialDeniedError) {
          throw new AuthorizationDeniedError([...error.reasons], 'credential material unavailable after authorization (fail-closed; consumption stands)');
        }
        throw this.storageDenied(error);
      }
      scoped = {
        envelope: verified,
        credential: {
          credentialId: tx1.credential.credentialId,
          audience: tx1.credential.audience,
          scopes: [...tx1.credential.scopes],
          expiresAt: tx1.credential.expiresAt,
          material,
        },
      };
    } else {
      scoped = { envelope: verified };
    }

    // Side effect with S-5 heartbeat (best-effort lease extension).
    const heartbeat = this.startHeartbeat(tenantId, tx1);
    try {
      const result = await sideEffect(scoped);
      this.stopHeartbeat(heartbeat);
      await this.renderTx2Success(verified, tenantId, tx1);
      return result;
    } catch (error) {
      this.stopHeartbeat(heartbeat);
      if (isTx2SuccessError(error)) throw error;
      await this.renderTx2Failure(verified, tenantId, tx1, error);
      throw error;
    }
  }

  /** Tx-1 body: ordered enforcement-lock consumption (all-or-nothing). */
  private async renderTx1(
    collections: SecurityTxCollections,
    verified: A01AuthorizationEnvelope,
    active: ActiveManifest,
    now: number,
  ): Promise<Tx1Outcome> {
    // 1. Session re-check (live S-8 read + enforcement-lock no-op CAS).
    await this.assertSessionLive(collections, verified, now);

    // 2. S-4 exactly-once (non-READ).
    await consumeEnvelope(collections.consumedEnvelopes, {
      envelopeId: verified.envelopeId,
      decisionId: verified.decision.decisionId,
      tenantId: verified.tenantId,
      principalId: verified.principal.id,
      runId: verified.run.runId,
      impact: verified.impact,
      now,
    });

    // 3. S-5 claim (COMPLETED ⇒ roll back everything and return the receipt).
    let leaseNonce: string | undefined;
    let idempotencyKey: string | undefined;
    const key = verified.provenance.idempotencyKey;
    if (key) {
      const claim = await claimIdempotency(collections.idempotency, { tenantId: verified.tenantId, key, now });
      if (!claim.claimed) {
        throw new IdempotentReplaySignal(claim.receipt);
      }
      leaseNonce = claim.leaseNonce;
      idempotencyKey = key;
    }

    // 4. S-7 budget (ceiling pinned from ACTIVE at first consume).
    await consumeBudget(collections.runBudgets, {
      tenantId: verified.tenantId,
      principalId: verified.principal.id,
      runId: verified.run.runId,
      capabilityId: verified.capability.capabilityId,
      cost: verified.decision.budgetCostUnits,
      ceiling: active.manifest.budgetPerRunCostUnits,
      manifestId: active.manifestId,
      now,
    });

    // 5. Credential re-check + S-3 single-use claim (no material in-tx).
    let credential: Tx1Outcome['credential'];
    if (verified.credential) {
      credential = await this.broker.acquireInTx(collections, verified, active.manifest.requiredCredentialScopes, now);
    }
    return {
      ...(leaseNonce !== undefined ? { leaseNonce } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(credential ? { credential } : {}),
    };
  }

  /** Live session enforcement check: fresh S-8 read, tenant-bound, lock-held. */
  private async assertSessionLive(
    collections: SecurityTxCollections,
    verified: A01AuthorizationEnvelope,
    now: number,
  ): Promise<void> {
    const method = verified.principal.authenticationMethod;
    const eventId = verified.principal.authenticationEventId;
    if (method === 'KERNEL_INTERNAL' && this.verifyKernelPrincipal?.(verified.principal, 'kernel:internal-execution') === true) {
      return;
    }
    const row = eventId ? await collections.sessions.get(eventId) : undefined;
    if (row && row.tenantId !== verified.tenantId) {
      throw new AuthorizationDeniedError(['PRINCIPAL_REVOKED'], 'session tenant does not match the envelope tenant');
    }
    const assessment = assessSessionRow(row, now);
    if (!assessment.active) {
      throw new AuthorizationDeniedError(['PRINCIPAL_REVOKED'], `session is ${assessment.status.toLowerCase()}: ${assessment.detail}`);
    }
    // Enforcement lock: no-op CAS takes the row lock so a revoke that
    // commits before this point denies, and one arriving during Tx-1 waits
    // (non-retroactive, documented).
    const locked = await collections.sessions.cas(
      assessment.event.id,
      (cur) => !!cur && cur.status === 'ACTIVE',
      (cur) => cur,
    );
    if (!locked.ok) {
      const fresh = eventId ? await collections.sessions.get(eventId) : undefined;
      const reassessed = assessSessionRow(fresh, now);
      const status = reassessed.active ? 'revoked' : reassessed.status.toLowerCase();
      throw new AuthorizationDeniedError(['PRINCIPAL_REVOKED'], `session is ${status} (lost the enforcement lock race)`);
    }
  }

  /** COMPLETED-key path: CONSUMED receipt + the re-fetched receipt (never a cached object). */
  private async idempotentReplay(
    verified: A01AuthorizationEnvelope,
    receipt: A01IdempotencyReceipt,
  ): Promise<A01IdempotencyReceipt> {
    const now = this.now();
    const record = buildConsumedAuditRecord(verified, {
      consumedAt: now,
      sideEffectInvoked: false,
      detail: 'idempotent-replay',
      idempotentReplay: true,
    });
    await this.recordReceiptTx(verified.tenantId, record, 'idempotent-replay');
    return receipt;
  }

  /** Tx-2 success: S-5 → COMPLETED + CONSUMED receipt, one tx (sink first). */
  private async renderTx2Success(verified: A01AuthorizationEnvelope, tenantId: string, tx1: Tx1Outcome): Promise<void> {
    const now = this.now();
    try {
      await this.store.transact({ tenantId }, async (collections, txId) => {
        if (tx1.leaseNonce && tx1.idempotencyKey) {
          await completeIdempotency(collections.idempotency, {
            tenantId,
            key: tx1.idempotencyKey,
            leaseNonce: tx1.leaseNonce,
            resultRef: { decisionId: verified.decision.decisionId, envelopeId: verified.envelopeId, completedAt: now },
            now,
          });
        }
        const record = buildConsumedAuditRecord(verified, {
          consumedAt: now,
          sideEffectInvoked: true,
          detail: 'executed',
          securityStoreTxId: txId,
        });
        await this.audit.record(record);
        await SecurityStateStore.putAuditReceipt(collections.decisions, record, 'executeDurable/Tx-2', false);
      });
    } catch (error) {
      // The side effect RAN but the receipt failed: honest failure (the
      // orphan is visible to reconciliation). Mark so the execute wrapper
      // does not run the failure path on top.
      throw markTx2SuccessError(this.storageDenied(error));
    }
  }

  /**
   * Tx-2 failure: S-5 → FAILED + CONSUMED receipt, one tx (sink first).
   * Best-effort relative to the side-effect error (R1 parity: the
   * side-effect error propagates); a finalize failure is attached as the
   * `cause` so neither failure is silent.
   */
  private async renderTx2Failure(
    verified: A01AuthorizationEnvelope,
    tenantId: string,
    tx1: Tx1Outcome,
    sideEffectError: unknown,
  ): Promise<void> {
    const now = this.now();
    try {
      await this.store.transact({ tenantId }, async (collections, txId) => {
        if (tx1.leaseNonce && tx1.idempotencyKey) {
          try {
            await failIdempotency(collections.idempotency, {
              tenantId,
              key: tx1.idempotencyKey,
              leaseNonce: tx1.leaseNonce,
              now,
            });
          } catch (ownershipError) {
            // Key ownership was lost (reclaimed mid-flight): the ledger no
            // longer considers this attempt live. Record that explicitly and
            // continue with the CONSUMED receipt (nothing to mark FAILED).
            void ownershipError;
          }
        }
        const record = buildConsumedAuditRecord(verified, {
          consumedAt: now,
          sideEffectInvoked: false,
          detail: 'side-effect-failure',
          securityStoreTxId: txId,
        });
        await this.audit.record(record);
        await SecurityStateStore.putAuditReceipt(collections.decisions, record, 'executeDurable/Tx-2-failure', false);
      });
    } catch (finalizeError) {
      const wrapped = this.storageDenied(finalizeError);
      (wrapped as { cause?: unknown }).cause = sideEffectError;
      throw wrapped;
    }
  }

  /** S-10 + sink receipt in its own tx (replay + deny paths). Throws on failure. */
  private async recordReceiptTx(tenantId: string, record: ReturnType<typeof buildConsumedAuditRecord>, context: string): Promise<void> {
    await this.store.transact({ tenantId }, async (collections, txId) => {
      const receipted = { ...record, securityStoreTxId: txId };
      await this.audit.record(receipted);
      await SecurityStateStore.putAuditReceipt(collections.decisions, receipted, `executeDurable/${context}`, false);
    });
  }

  /** Deny-path receipt: best-effort (R1 parity — the DENY itself is the safe outcome). */
  private async bestEffortDenyReceipt(verified: A01AuthorizationEnvelope, detail: string): Promise<void> {
    try {
      const record = buildConsumedAuditRecord(verified, {
        consumedAt: this.now(),
        sideEffectInvoked: false,
        detail,
      });
      await this.recordReceiptTx(verified.tenantId, record, detail);
    } catch {
      // Best-effort: the denial stands regardless (R1 parity).
    }
  }

  private storageDenied(error: unknown): AuthorizationDeniedError {
    if (error instanceof AuthorizationDeniedError && error.reasons.includes('SECURITY_STATE_UNAVAILABLE')) {
      return error;
    }
    return new AuthorizationDeniedError(
      ['SECURITY_STATE_UNAVAILABLE'],
      `durable security state failed (${error instanceof Error ? error.message : String(error)}); failing closed`,
    );
  }

  // -- S-5 heartbeat --------------------------------------------------------

  private startHeartbeat(tenantId: string, tx1: Tx1Outcome): ReturnType<typeof setInterval> | undefined {
    if (!tx1.leaseNonce || !tx1.idempotencyKey) return undefined;
    const leaseNonce = tx1.leaseNonce;
    const key = tx1.idempotencyKey;
    const timer = setInterval(() => {
      // Best-effort: a failed beat self-heals on the next beat; an expired
      // lease only enables reclaim (crash-recovery semantics), never
      // silent double-execution while beats succeed.
      void (async () => {
        try {
          await this.store.transact({ tenantId }, async (collections) => {
            await extendIdempotencyLease(collections.idempotency, {
              tenantId,
              key,
              leaseNonce,
              now: this.now(),
              leaseMs: IDEMPOTENCY_LEASE_MS,
            });
          });
        } catch {
          /* best-effort heartbeat */
        }
      })();
    }, IDEMPOTENCY_HEARTBEAT_MS);
    if (typeof (timer as { unref?: unknown }).unref === 'function') {
      (timer as unknown as { unref(): void }).unref();
    }
    return timer;
  }

  private stopHeartbeat(timer: ReturnType<typeof setInterval> | undefined): void {
    if (timer !== undefined) clearInterval(timer);
  }
}

const TX2_SUCCESS_MARK = Symbol('tx2-success-error');

function markTx2SuccessError(error: AuthorizationDeniedError): AuthorizationDeniedError {
  (error as unknown as Record<symbol, boolean>)[TX2_SUCCESS_MARK] = true;
  return error;
}

function isTx2SuccessError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as Record<symbol, boolean>)[TX2_SUCCESS_MARK] === true;
}
