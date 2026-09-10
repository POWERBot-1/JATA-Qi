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
  classifyPrivilegedA01,
  PRIVILEGE_PLATFORM_TENANT,
  type AuthenticationEventDoc,
  type DelegationAssessment,
  type DelegationAssessmentVerdict,
  type DelegationRequirement,
  type DelegationStateAuthority,
  type IdentityStateAuthority,
  type PrivilegeElevationAssessment,
  type PrivilegeOperationClass,
  type PrivilegeStateAuthority,
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
  /**
   * P2-S3: the privilege-state authority resolver for the durable decision
   * path (spec §24-S3). Lazy (resolved at first decision, when the kernel is
   * fully booted). Absent ⇒ a registered privileged operation DENIES with
   * PRIVILEGE_CHECK_UNAVAILABLE (fail-closed — no ambient authority). Present
   * ⇒ every privileged decision re-reads the durable elevation inside its
   * transaction (tenant scope) or in an explicit system-scope read (platform
   * scope); the enforcement path re-validates before the side effect.
   */
  readonly privilegeAuthorityResolver?: () => PrivilegeStateAuthority | undefined | Promise<PrivilegeStateAuthority | undefined>;
  /**
   * P2-S4: the delegation-state authority resolver for the durable decision
   * path (spec §24-S4). Lazy (resolved at first delegated decision, when the
   * kernel is fully booted). Absent ⇒ a request carrying a delegation
   * reference DENIES with DELEGATION_CHECK_UNAVAILABLE (fail-closed — no
   * ambient delegation authority). Present ⇒ every delegated decision
   * re-reads the durable grant and re-verifies chain integrity against the
   * live manifest; the enforcement path re-validates and atomically consumes
   * the grant before the side effect.
   */
  readonly delegationAuthorityResolver?: () => DelegationStateAuthority | undefined | Promise<DelegationStateAuthority | undefined>;
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

/** P2-S3: a register-classified privileged requirement (Phase-A state). */
interface PrivilegeStageState {
  readonly requirement: {
    readonly principalId: string;
    readonly tenantId: string;
    readonly sessionEventId?: string;
    readonly operationClass: PrivilegeOperationClass;
    readonly scope: 'tenant' | 'platform';
    readonly stepUpRequired: boolean;
    readonly stepUpMaxAgeMs: number;
  };
  readonly operationId: string;
  readonly operationClass: string;
  /** True when no privilege authority is configured (fail-closed deny). */
  readonly unavailable?: boolean;
  /** Pre-computed platform-scope assessment (system read, Phase A). */
  readonly platformAssessment?: PrivilegeElevationAssessment;
}

/** Map an elevation assessment verdict to its A-01 denial code (VALID ⇒ undefined). */
function privilegeDenialCode(verdict: PrivilegeElevationAssessment['verdict']): A01DenialReason | undefined {
  switch (verdict) {
    case 'VALID':
      return undefined;
    case 'EXPIRED':
      return 'PRIVILEGE_ELEVATION_EXPIRED';
    case 'REVOKED':
      return 'PRIVILEGE_ELEVATION_REVOKED';
    case 'SCOPE_MISMATCH':
      return 'PRIVILEGE_SCOPE_MISMATCH';
    case 'ROLE_MISMATCH':
      return 'PRIVILEGE_ROLE_MISMATCH';
    case 'SESSION_MISMATCH':
      return 'PRIVILEGE_SESSION_MISMATCH';
    case 'STEP_UP_STALE':
      return 'STEP_UP_STALE';
    case 'REQUIRED':
      return 'PRIVILEGE_ELEVATION_REQUIRED';
  }
}

/** P2-S4: a delegation-stage classification (Phase-A state). */
interface DelegationStageState {
  readonly delegationId: string;
  /** The decision-time requirement (built from the request + ACTIVE manifest). */
  readonly requirement?: DelegationRequirement;
  /** A pre-computed Phase-A denial (fail-closed; no durable grant authority). */
  readonly denial?: A01DenialReason;
  /** A platform-scoped grant's Phase-A (system-scope) assessment. */
  readonly platformAssessment?: DelegationAssessment;
}

/** Map a delegation assessment verdict to its A-01 denial code (VALID ⇒ undefined). */
function delegationDenialCode(verdict: DelegationAssessmentVerdict): A01DenialReason | undefined {
  switch (verdict) {
    case 'VALID':
      return undefined;
    case 'UNKNOWN_GRANT':
      return 'DELEGATION_UNKNOWN_GRANT';
    case 'NOT_DELEGATEE':
      return 'DELEGATION_NOT_DELEGATEE';
    case 'CROSS_TENANT':
      return 'DELEGATION_CROSS_TENANT_REFUSED';
    case 'SCOPE_TENANT':
      return 'DELEGATION_SCOPE_TENANT';
    case 'SCOPE_OPERATION':
      return 'DELEGATION_SCOPE_OPERATION';
    case 'SCOPE_TARGET':
      return 'DELEGATION_SCOPE_TARGET';
    case 'SCOPE_CLASSIFICATION':
      return 'DELEGATION_SCOPE_CLASSIFICATION';
    case 'SCOPE_IMPACT':
      return 'DELEGATION_SCOPE_IMPACT';
    case 'EXPIRED':
      return 'DELEGATION_EXPIRED';
    case 'REVOKED':
      return 'DELEGATION_REVOKED';
    case 'CONSUMED':
      return 'DELEGATION_CONSUMED';
    case 'CHAIN_DEPTH':
      return 'DELEGATION_CHAIN_DEPTH_EXCEEDED';
    case 'DELEGATOR_AUTHORITY_CHANGED':
      return 'DELEGATION_DELEGATOR_AUTHORITY_CHANGED';
    case 'PLATFORM_SCOPE_REQUIRED':
      return 'DELEGATION_PLATFORM_SCOPE_REQUIRED';
    case 'APPROVAL_REQUIRED':
      return 'DELEGATION_APPROVAL_REQUIRED';
  }
}

/**
 * Build the delegation requirement from a request OR a sealed envelope (they
 * share the authoritative fields) + the ACTIVE manifest. Returns `undefined`
 * when there is no ACTIVE manifest (the delegator's cited authority cannot
 * be re-verified — fail closed).
 */
function buildDelegationRequirement(
  source:
    | {
        readonly principal?: { readonly id?: unknown; readonly authenticationEventId?: unknown };
        readonly tenantId?: unknown;
        readonly capability?: { readonly capabilityId: string; readonly capabilityVersion: string };
        readonly tool?: unknown;
        readonly operation?: unknown;
        readonly target?: { readonly system: string; readonly resource?: string };
        readonly dataClassification?: unknown;
        readonly impact?: unknown;
      }
    | null
    | undefined,
  active: ActiveManifest | undefined,
  delegationId: string,
): DelegationRequirement | undefined {
  if (!source || !active) return undefined;
  const principal = source.principal;
  const targetResource =
    typeof source.target?.resource === 'string' && source.target.resource.length > 0 ? source.target.resource : undefined;
  return {
    delegationId,
    principalId: typeof principal?.id === 'string' ? principal.id : '',
    tenantId: typeof source.tenantId === 'string' ? source.tenantId : '',
    ...(typeof principal?.authenticationEventId === 'string' && principal.authenticationEventId
      ? { sessionEventId: principal.authenticationEventId }
      : {}),
    capabilityId: source.capability?.capabilityId ?? '',
    capabilityVersion: source.capability?.capabilityVersion ?? '',
    tool: typeof source.tool === 'string' ? source.tool : '',
    operation: typeof source.operation === 'string' ? source.operation : '',
    targetSystem: source.target?.system ?? '',
    ...(targetResource !== undefined ? { targetResource } : {}),
    classification: typeof source.dataClassification === 'string' ? source.dataClassification : 'INTERNAL',
    impact: typeof source.impact === 'string' ? source.impact : 'EXTERNAL_SIDE_EFFECT',
    requestIsPlatformScoped: active.manifest.allowTenantWildcard,
    liveManifest: {
      digest: active.digest,
      actions: active.manifest.allowedOperations.map((entry) => ({ tool: entry.tool, operation: entry.operation })),
      targets: active.manifest.allowedTargets.map((entry) => ({
        system: entry.system,
        ...(entry.resourcePattern !== undefined ? { resourcePattern: entry.resourcePattern } : {}),
      })),
      classificationCeiling: active.manifest.maxDataClassification,
      impactCeiling: active.manifest.maxImpact,
      requiresApproval: active.manifest.requiresApproval,
    },
  };
}

/** Map a durable delegation-store consumption failure to an A-01 denial. */
function mapDelegationConsumeError(error: unknown): AuthorizationDeniedError {
  const code = error instanceof Error ? /\[([A-Z0-9_]+)\]/.exec(error.message)?.[1] : undefined;
  switch (code) {
    case 'REVOKED':
      return new AuthorizationDeniedError(['DELEGATION_REVOKED'], 'the delegation grant was revoked before consumption (fail-closed)');
    case 'CONSUMED':
      return new AuthorizationDeniedError(['DELEGATION_CONSUMED'], 'the delegation grant was already consumed (one-shot / use-count exhausted)');
    case 'EXPIRED':
      return new AuthorizationDeniedError(['DELEGATION_EXPIRED'], 'the delegation grant expired before consumption (fail-closed)');
    case 'UNKNOWN_GRANT':
      return new AuthorizationDeniedError(['DELEGATION_UNKNOWN_GRANT'], 'the delegation grant no longer exists (fail-closed)');
    default:
      if (error instanceof AuthorizationDeniedError) return error;
      return new AuthorizationDeniedError(
        ['DELEGATION_CHECK_UNAVAILABLE'],
        'delegation consumption failed against durable state (fail-closed)',
      );
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
  private readonly privilegeAuthorityResolver: DurableDeciderDeps['privilegeAuthorityResolver'];
  private readonly delegationAuthorityResolver: DurableDeciderDeps['delegationAuthorityResolver'];
  private identityAuthorityCache: IdentityStateAuthority | undefined;
  private identityAuthorityResolved = false;
  private privilegeAuthorityCache: PrivilegeStateAuthority | undefined;
  private privilegeAuthorityResolved = false;
  private delegationAuthorityCache: DelegationStateAuthority | undefined;
  private delegationAuthorityResolved = false;

  constructor(deps: DurableDeciderDeps) {
    this.store = deps.store;
    this.broker = deps.broker;
    this.audit = deps.audit;
    this.engine = deps.engine;
    this.policyVersion = deps.policyVersion;
    this.now = deps.now;
    this.verifyKernelPrincipal = deps.verifyKernelPrincipal;
    this.identityAuthorityResolver = deps.identityAuthorityResolver;
    this.privilegeAuthorityResolver = deps.privilegeAuthorityResolver;
    this.delegationAuthorityResolver = deps.delegationAuthorityResolver;
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

  /**
   * P2-S3: lazily resolve the privilege-state authority (once; the kernel is
   * fully booted by decision time). Fail-closed: a resolver failure re-throws
   * (the Phase-B catch turns it into a storage-failure DENY) and is NOT
   * cached as "resolved" — a broken resolver must keep failing closed.
   */
  private async resolvePrivilegeAuthority(): Promise<PrivilegeStateAuthority | undefined> {
    if (this.privilegeAuthorityResolved) return this.privilegeAuthorityCache;
    this.privilegeAuthorityResolved = true;
    try {
      this.privilegeAuthorityCache = this.privilegeAuthorityResolver
        ? await this.privilegeAuthorityResolver()
        : undefined;
    } catch (error) {
      this.privilegeAuthorityResolved = false;
      throw error;
    }
    return this.privilegeAuthorityCache;
  }

  /** P2-S3 structural probe (P2-INV-04): is a privilege authority live? */
  async hasLivePrivilegeAuthority(): Promise<boolean> {
    return (await this.resolvePrivilegeAuthority()) !== undefined;
  }

  /**
   * P2-S4: lazily resolve the delegation-state authority (once; fail-closed —
   * a resolver failure re-throws and is NOT cached, mirroring the identity and
   * privilege resolvers). Absent ⇒ delegation references DENY (fail-closed).
   */
  private async resolveDelegationAuthority(): Promise<DelegationStateAuthority | undefined> {
    if (this.delegationAuthorityResolved) return this.delegationAuthorityCache;
    this.delegationAuthorityResolved = true;
    try {
      this.delegationAuthorityCache = this.delegationAuthorityResolver
        ? await this.delegationAuthorityResolver()
        : undefined;
    } catch (error) {
      this.delegationAuthorityResolved = false;
      this.delegationAuthorityCache = undefined;
      throw error;
    }
    return this.delegationAuthorityCache;
  }

  /** P2-S4 structural probe (P2-INV-04 delegation half): is a delegation authority live? */
  async hasLiveDelegationAuthority(): Promise<boolean> {
    return (await this.resolveDelegationAuthority()) !== undefined;
  }

  /**
   * P2-S3: register-classify the request and build the privilege-stage state.
   * Returns `undefined` when the request is not privileged or is a verified
   * kernel-internal principal (its closed cryptographic scopes are the
   * authority — same rule as the session/identity stages). Absent authority +
   * a privileged request ⇒ `unavailable` (fail-closed deny). Platform-scoped
   * requirements are assessed here (Phase-A system read); tenant-scoped ones
   * are assessed inside Phase-B.
   */
  private async classifyPrivilege(
    maybeRequest: A01AuthorizationRequest | null | undefined,
    now: number,
  ): Promise<PrivilegeStageState | undefined> {
    const tool = typeof maybeRequest?.tool === 'string' ? maybeRequest.tool : '';
    const operation = typeof maybeRequest?.operation === 'string' ? maybeRequest.operation : '';
    const entry = classifyPrivilegedA01(tool, operation);
    if (!entry) return undefined;
    const principal = maybeRequest?.principal as
      | { id?: unknown; authenticationMethod?: unknown; authenticationEventId?: unknown }
      | undefined;
    if (principal?.authenticationMethod === 'KERNEL_INTERNAL') return undefined;
    const requirement = {
      principalId: typeof principal?.id === 'string' ? principal.id : '',
      tenantId: typeof maybeRequest?.tenantId === 'string' ? maybeRequest.tenantId : '',
      ...(typeof principal?.authenticationEventId === 'string' && principal.authenticationEventId
        ? { sessionEventId: principal.authenticationEventId }
        : {}),
      operationClass: entry.opClass,
      scope: entry.scope,
      stepUpRequired: entry.stepUpRequired,
      stepUpMaxAgeMs: entry.stepUpMaxAgeMs,
    };
    const authority = await this.resolvePrivilegeAuthority();
    if (!authority) {
      return { requirement, operationId: entry.operationId, operationClass: entry.opClass, unavailable: true };
    }
    if (entry.scope === 'platform') {
      const platformAssessment = await authority.assessPlatform(requirement, now);
      return { requirement, operationId: entry.operationId, operationClass: entry.opClass, platformAssessment };
    }
    return { requirement, operationId: entry.operationId, operationClass: entry.opClass };
  }

  /**
   * P2-S4: classify a delegation reference (spec §24-S4). The reference is
   * the grant id only — the grant itself is re-read from durable state. The
   * delegation authority is lazily resolved (fail-closed); a platform-scoped
   * grant is assessed in an explicit system-scope read HERE (the
   * ACTIVE-manifest pattern); a tenant-scoped grant is assessed inside
   * Phase-B. A foreign-tenant grant is indistinguishable from an unknown
   * grant (no grant-existence leak — A-09). Returns `undefined` when the
   * request carries no delegation reference or is a verified kernel-internal
   * principal (its closed cryptographic scopes are the authority — same rule
   * as the session/identity/privilege stages).
   */
  private async classifyDelegation(
    maybeRequest: A01AuthorizationRequest | null | undefined,
    active: ActiveManifest | undefined,
    now: number,
  ): Promise<DelegationStageState | undefined> {
    const delegationId = (maybeRequest?.delegation as { delegationId?: unknown } | undefined)?.delegationId;
    if (typeof delegationId !== 'string' || !delegationId) return undefined;
    const principal = maybeRequest?.principal as { authenticationMethod?: unknown } | undefined;
    if (principal?.authenticationMethod === 'KERNEL_INTERNAL') return undefined;
    const authority = await this.resolveDelegationAuthority();
    if (!authority) {
      return { delegationId, denial: 'DELEGATION_CHECK_UNAVAILABLE' };
    }
    // Without an ACTIVE manifest the delegator's cited authority cannot be
    // re-verified (A-16 chain integrity) — fail closed.
    const requirement = buildDelegationRequirement(maybeRequest, active, delegationId);
    if (!requirement) {
      return { delegationId, denial: 'DELEGATION_DELEGATOR_AUTHORITY_CHANGED' };
    }
    const peek = await authority.peek(delegationId);
    if (!peek) {
      return { delegationId, requirement, denial: 'DELEGATION_UNKNOWN_GRANT' };
    }
    if (peek.scope === 'platform') {
      const platformAssessment = await authority.assessPlatform(requirement, now);
      return { delegationId, requirement, platformAssessment };
    }
    // Tenant-scoped grant in a foreign tenant: indistinguishable from unknown
    // (no grant-existence leak across tenants — A-09 cross-tenant refusal).
    if (peek.tenantId !== requirement.tenantId) {
      return { delegationId, requirement, denial: 'DELEGATION_UNKNOWN_GRANT' };
    }
    return { delegationId, requirement };
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

    // Phase A (P2-S3): register-classify the request. A platform-scoped
    // requirement is assessed in an explicit system-scope read HERE (the
    // ACTIVE-manifest pattern); the tenant-scoped assessment runs inside the
    // Phase-B tenant transaction. Classification is register-driven — never
    // caller-controlled. A resolver failure is a storage-failure DENY.
    let privilege: PrivilegeStageState | undefined;
    try {
      privilege = await this.classifyPrivilege(maybeRequest, now);
    } catch (error) {
      return this.storageFailureDeny(maybeRequest, envelopeId, now, error);
    }

    // Phase A (P2-S4): classify the delegation reference. A platform-scoped
    // grant is assessed in an explicit system-scope read HERE; the
    // tenant-scoped assessment runs inside the Phase-B tenant transaction.
    // The reference is register-driven (grant id only) — never caller scope.
    let delegation: DelegationStageState | undefined;
    try {
      delegation = await this.classifyDelegation(maybeRequest, active, now);
    } catch (error) {
      return this.storageFailureDeny(maybeRequest, envelopeId, now, error);
    }

    // Requests without a usable tenant cannot open a tenant transaction:
    // render the structural DENY without durable state (sink-audited).
    if (!isValidTenantId(tenantId)) {
      return this.unscopedDeny(maybeRequest, envelopeId, now);
    }

    // Phase B: ONE tenant transaction binds rate + session + identity +
    // privilege + delegation + credential + PDP + audit. Any throw inside ⇒
    // rollback ⇒ storage-failure DENY.
    try {
      return await this.store.transact({ tenantId }, async (collections, txId) =>
        this.renderDecisionTx(collections, txId, maybeRequest, envelopeId, active, now, { tenantId, principalId, capabilityId }, privilege, delegation),
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
    privilege: PrivilegeStageState | undefined,
    delegation: DelegationStageState | undefined,
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

    // 2.75 P2-S3: privilege stage (register-classified; fail-closed). A
    // non-VALID elevation renders a short-circuit DENY envelope (still fully
    // audited in-tx); a VALID elevation is cited on the sealed envelope.
    let privilegeCitation: { elevationId?: string; operationClass: string; status: string } | undefined;
    if (privilege) {
      const assessed = await this.assessPrivilegeClaim(collections, privilege, now);
      if (assessed.denialCode !== undefined) {
        return this.renderPrivilegeDenyTx(collections, txId, maybeRequest, envelopeId, active, now, session, privilege, assessed.denialCode);
      }
      if (assessed.assessment) {
        privilegeCitation = {
          ...(assessed.assessment.elevationId !== undefined ? { elevationId: assessed.assessment.elevationId } : {}),
          operationClass: privilege.operationClass,
          status: assessed.assessment.elevationStatus ?? 'ACTIVE',
        };
      } else {
        privilegeCitation = { operationClass: privilege.operationClass, status: 'ACTIVE' };
      }
    }

    // 2.8 P2-S4: delegation stage (grant id reference; fail-closed). A
    // non-VALID grant renders a short-circuit DENY envelope (fully audited
    // in-tx); a VALID grant is cited on the sealed envelope (delegationStatus
    // = 'VALID'). No delegation reference ⇒ the stage is a no-op.
    let delegationCitation: string | undefined;
    if (delegation) {
      const assessed = await this.assessDelegationClaim(collections, delegation, now);
      if (assessed.denialCode !== undefined) {
        return this.renderDelegationDenyTx(collections, txId, maybeRequest, envelopeId, active, now, session, delegation, assessed.denialCode);
      }
      delegationCitation = 'VALID';
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
      // P2-S3: the privilege stage was already resolved in-tx above; the PDP
      // stage is a structural passthrough on the durable path (a registered
      // privileged operation that reached the PDP holds a VALID elevation).
      ...(privilege ? { privilegeStage: (): readonly A01DenialReason[] => [] } : {}),
      // P2-S4: the delegation stage was already resolved in-tx above; the PDP
      // stage is a structural passthrough on the durable path (a request with
      // a delegation reference that reached the PDP holds a VALID grant).
      ...(delegation ? { delegationStage: (): readonly A01DenialReason[] => [] } : {}),
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
        ...(privilegeCitation?.elevationId !== undefined ? { privilegeElevationId: privilegeCitation.elevationId } : {}),
        ...(privilegeCitation?.operationClass !== undefined ? { privilegeOperationClass: privilegeCitation.operationClass } : {}),
        ...(privilegeCitation?.status !== undefined ? { privilegeStatus: privilegeCitation.status } : {}),
        ...(delegationCitation !== undefined ? { delegationStatus: delegationCitation } : {}),
      },
    });
    await this.recordDecisionTx(collections, envelope);
    return envelope;
  }

  /**
   * P2-S3: assess the register-classified privilege claim. Tenant-scoped
   * requirements re-read the durable elevation INSIDE the Phase-B tenant
   * transaction (one consistent snapshot); platform-scoped requirements use
   * the Phase-A system-scope assessment. Any storage failure propagates
   * (Phase-B catch ⇒ storage-failure DENY).
   */
  private async assessPrivilegeClaim(
    collections: SecurityTxCollections,
    privilege: PrivilegeStageState,
    now: number,
  ): Promise<{ denialCode?: A01DenialReason; assessment?: PrivilegeElevationAssessment }> {
    if (privilege.unavailable) {
      return { denialCode: 'PRIVILEGE_CHECK_UNAVAILABLE' };
    }
    let assessment: PrivilegeElevationAssessment;
    if (privilege.requirement.scope === 'platform') {
      assessment = privilege.platformAssessment ?? { verdict: 'REQUIRED', operationClass: privilege.requirement.operationClass };
    } else {
      const authority = await this.resolvePrivilegeAuthority();
      if (!authority) return { denialCode: 'PRIVILEGE_CHECK_UNAVAILABLE' };
      assessment = await authority.assessInTx(collections.scope, privilege.requirement, now);
    }
    const denialCode = privilegeDenialCode(assessment.verdict);
    if (denialCode !== undefined) return { denialCode, assessment };
    return { assessment };
  }

  /** Short-circuit DENY for a failed privilege claim (fully audited in-tx). */
  private async renderPrivilegeDenyTx(
    collections: SecurityTxCollections,
    txId: string,
    maybeRequest: A01AuthorizationRequest | null | undefined,
    envelopeId: string,
    active: ActiveManifest | undefined,
    now: number,
    session: { eventId: string; status: A01SessionAuditStatus },
    privilege: PrivilegeStageState,
    denialCode: A01DenialReason,
  ): Promise<A01AuthorizationEnvelope> {
    const safeRequest = sanitizeRequestForEnvelope(maybeRequest);
    const decision: A01DecisionRecord = {
      decisionId: `dec-${now}-${randomUUID().slice(0, 8)}`,
      decision: 'DENY',
      reasonCodes: Object.freeze([denialCode] as const),
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
        privilegeOperationClass: privilege.operationClass,
        privilegeStatus: 'DENIED',
      },
    });
    await this.recordDecisionTx(collections, envelope);
    return envelope;
  }

  /**
   * P2-S4: assess a classified delegation reference. A pre-computed Phase-A
   * denial short-circuits; a platform-scoped grant uses its Phase-A system
   * assessment; a tenant-scoped grant re-reads the durable grant INSIDE the
   * Phase-B tenant transaction (one consistent snapshot — a grant revoked in
   * another transaction cannot race past this read). Any storage failure
   * propagates (Phase-B catch ⇒ storage-failure DENY).
   */
  private async assessDelegationClaim(
    collections: SecurityTxCollections,
    delegation: DelegationStageState,
    now: number,
  ): Promise<{ denialCode?: A01DenialReason }> {
    if (delegation.denial) {
      return { denialCode: delegation.denial };
    }
    if (delegation.platformAssessment) {
      const code = delegationDenialCode(delegation.platformAssessment.verdict);
      return code !== undefined ? { denialCode: code } : {};
    }
    const authority = await this.resolveDelegationAuthority();
    if (!authority) return { denialCode: 'DELEGATION_CHECK_UNAVAILABLE' };
    if (!delegation.requirement) return { denialCode: 'DELEGATION_DELEGATOR_AUTHORITY_CHANGED' };
    const assessment = await authority.assessInTx(collections.scope, delegation.requirement, now);
    const code = delegationDenialCode(assessment.verdict);
    return code !== undefined ? { denialCode: code } : {};
  }

  /** Short-circuit DENY for a failed delegation claim (fully audited in-tx). */
  private async renderDelegationDenyTx(
    collections: SecurityTxCollections,
    txId: string,
    maybeRequest: A01AuthorizationRequest | null | undefined,
    envelopeId: string,
    active: ActiveManifest | undefined,
    now: number,
    session: { eventId: string; status: A01SessionAuditStatus },
    delegation: DelegationStageState,
    denialCode: A01DenialReason,
  ): Promise<A01AuthorizationEnvelope> {
    const safeRequest = sanitizeRequestForEnvelope(maybeRequest);
    const decision: A01DecisionRecord = {
      decisionId: `dec-${now}-${randomUUID().slice(0, 8)}`,
      decision: 'DENY',
      reasonCodes: Object.freeze([denialCode] as const),
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
        delegationStatus: 'DENIED',
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

    // P2-S3: privilege re-validation — a revoked/expired elevation since
    // decide denies here, before any side effect (spec §9.3 revocation
    // behavior: no stale elevation remains valid after its invalidation).
    try {
      await this.assertPrivilegeLive(verified, now);
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        await this.bestEffortDenyReceipt(verified, 'denied');
      }
      throw error;
    }

    // P2-S4: delegation re-validation — a revoked/expired/consumed grant or
    // a delegator-authority change since decide denies here, before any side
    // effect. A platform-scoped grant is also consumed here (system scope);
    // a tenant-scoped grant is consumed atomically inside Tx-1.
    let delegationEnforcement:
      | { readonly delegationId: string; readonly requirement: DelegationRequirement; readonly scope: 'tenant' | 'platform' }
      | undefined;
    try {
      delegationEnforcement = await this.classifyDelegationEnforcement(verified, active, now);
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        await this.bestEffortDenyReceipt(verified, 'denied');
      }
      throw error;
    }

    // Tx-1: session lock → delegation consume (tenant) → S-4 → S-5 → S-7 →
    // credential lock + S-3.
    let tx1: Tx1Outcome;
    try {
      tx1 = await this.store.transact({ tenantId }, async (collections) =>
        this.renderTx1(collections, verified, active!, now, delegationEnforcement),
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
    delegationEnforcement:
      | { readonly delegationId: string; readonly requirement: DelegationRequirement; readonly scope: 'tenant' | 'platform' }
      | undefined,
  ): Promise<Tx1Outcome> {
    // 1. Session re-check (live S-8 read + enforcement-lock no-op CAS).
    await this.assertSessionLive(collections, verified, now);

    // 1.5 P2-S4: delegation consume (tenant-scoped). The grant is re-read
    // and CAS-consumed INSIDE this tenant transaction — the same snapshot as
    // the S-4 envelope claim, so a one-shot grant used twice (or racing a
    // revocation) resolves to exactly one winner (spec §24-S4; A-24).
    if (delegationEnforcement && delegationEnforcement.scope === 'tenant') {
      const authority = await this.resolveDelegationAuthority();
      if (!authority) {
        throw new AuthorizationDeniedError(['DELEGATION_CHECK_UNAVAILABLE'], 'delegation plane unavailable in Tx-1 (fail-closed)');
      }
      let assessment;
      try {
        assessment = await authority.assessInTx(collections.scope, delegationEnforcement.requirement, now);
      } catch (error) {
        throw this.storageDenied(error);
      }
      const code = delegationDenialCode(assessment.verdict);
      if (code !== undefined) {
        throw new AuthorizationDeniedError([code], `delegation re-validation failed in Tx-1 (${assessment.verdict})`);
      }
      try {
        await authority.consumeInTx(collections.scope, delegationEnforcement.delegationId, now);
      } catch (error) {
        throw mapDelegationConsumeError(error);
      }
    }

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

  /**
   * P2-S3 enforcement re-validation: re-classify the envelope's (tool,
   * operation) against the register and re-read the durable elevation
   * (tenant scope in its own tenant transaction; platform scope in an
   * explicit system-scope read). Non-VALID ⇒ deny before the side effect.
   */
  private async assertPrivilegeLive(verified: A01AuthorizationEnvelope, now: number): Promise<void> {
    const entry = classifyPrivilegedA01(verified.tool, verified.operation);
    if (!entry) return;
    if (verified.principal.authenticationMethod === 'KERNEL_INTERNAL') return;
    const authority = await this.resolvePrivilegeAuthority();
    if (!authority) {
      throw new AuthorizationDeniedError(['PRIVILEGE_CHECK_UNAVAILABLE'], 'privilege plane unavailable at enforcement (fail-closed)');
    }
    const requirement = {
      principalId: verified.principal.id,
      tenantId: entry.scope === 'tenant' ? verified.tenantId : PRIVILEGE_PLATFORM_TENANT,
      ...(verified.principal.authenticationEventId ? { sessionEventId: verified.principal.authenticationEventId } : {}),
      operationClass: entry.opClass,
      scope: entry.scope,
      stepUpRequired: entry.stepUpRequired,
      stepUpMaxAgeMs: entry.stepUpMaxAgeMs,
    };
    let assessment: PrivilegeElevationAssessment;
    try {
      if (entry.scope === 'platform') {
        assessment = await authority.assessPlatform(requirement, now);
      } else {
        assessment = await this.store.transact({ tenantId: verified.tenantId }, async (collections) =>
          authority.assessInTx(collections.scope, requirement, now),
        );
      }
    } catch (error) {
      throw this.storageDenied(error);
    }
    if (assessment.verdict !== 'VALID') {
      throw new AuthorizationDeniedError(
        [privilegeDenialCode(assessment.verdict) ?? 'PRIVILEGE_ELEVATION_REQUIRED'],
        `privilege re-validation failed at enforcement (${assessment.verdict})`,
      );
    }
  }

  /**
   * P2-S4 enforcement re-validation + platform-grant consumption. Mirrors
   * `assertPrivilegeLive`: the envelope's delegation reference is re-read
   * from durable state and re-verified against the LIVE manifest. A
   * tenant-scoped grant is fully assessed + atomically consumed INSIDE Tx-1
   * (with the S-4 envelope claim — one consistent snapshot, so a use racing
   * a revocation resolves to exactly one winner). A platform-scoped grant is
   * assessed and consumed here (system scope) BEFORE Tx-1 — the safe
   * direction (a grant can never be double-used even if Tx-1 fails).
   */
  private async classifyDelegationEnforcement(
    verified: A01AuthorizationEnvelope,
    active: ActiveManifest,
    now: number,
  ): Promise<
    | { readonly delegationId: string; readonly requirement: DelegationRequirement; readonly scope: 'tenant' | 'platform' }
    | undefined
  > {
    const delegationId = verified.delegation?.delegationId;
    if (!delegationId) return undefined;
    if (verified.principal.authenticationMethod === 'KERNEL_INTERNAL') return undefined;
    const authority = await this.resolveDelegationAuthority();
    if (!authority) {
      throw new AuthorizationDeniedError(['DELEGATION_CHECK_UNAVAILABLE'], 'delegation plane unavailable at enforcement (fail-closed)');
    }
    const requirement = buildDelegationRequirement(verified, active, delegationId);
    if (!requirement) {
      throw new AuthorizationDeniedError(
        ['DELEGATION_DELEGATOR_AUTHORITY_CHANGED'],
        'the delegator\'s cited authority cannot be re-verified at enforcement (fail-closed)',
      );
    }
    let peek;
    try {
      peek = await authority.peek(delegationId);
    } catch (error) {
      throw this.storageDenied(error);
    }
    if (!peek) {
      throw new AuthorizationDeniedError(['DELEGATION_UNKNOWN_GRANT'], 'the cited delegation grant no longer exists (fail-closed)');
    }
    if (peek.scope === 'platform') {
      let platformAssessment;
      try {
        platformAssessment = await authority.assessPlatform(requirement, now);
      } catch (error) {
        throw this.storageDenied(error);
      }
      const code = delegationDenialCode(platformAssessment.verdict);
      if (code !== undefined) {
        throw new AuthorizationDeniedError([code], `delegation re-validation failed at enforcement (${platformAssessment.verdict})`);
      }
      try {
        await authority.consumePlatform(delegationId, now);
      } catch (error) {
        throw mapDelegationConsumeError(error);
      }
      return { delegationId, requirement, scope: 'platform' };
    }
    // Tenant-scoped grant in a foreign tenant: indistinguishable from unknown
    // (no grant-existence leak across tenants — A-09).
    if (peek.tenantId !== verified.tenantId) {
      throw new AuthorizationDeniedError(['DELEGATION_UNKNOWN_GRANT'], 'the cited delegation grant is not visible to the envelope tenant (fail-closed)');
    }
    return { delegationId, requirement, scope: 'tenant' };
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
