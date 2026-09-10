// P2-S4 — Delegation + Policy: shared types, closed vocabularies, the
// `identity.delegations` collection name, and the decision-time delegation
// authority surface (spec §8, §7.2, §24-S4).
//
// Delegation in JATA Qi is a DURABLE, TENANT-BOUND grant on the single
// authoritative PostgreSQL security substrate. A grant can only ever NARROW
// the delegator's authority (it is a subset of the delegator's live
// capability-manifest scope, re-verified at every decision), is mandatory-
// expiring, depth-bounded, and cross-tenant REFUSED by default (§8.2.2).
//
// Durability rules (R2 discipline, preserved — same as S-8/S-9/S1/S3):
//   * the delegation store runs ONLY on a transactional driver (memory and
//     filesystem refused at open — delegation is never process-local);
//   * tenant-scoped grants live in the delegator's RLS-bound tenant scope;
//     platform-scoped grants live under the `system` tenant via explicit,
//     enumerated, counted system-scope transactions (INV-15);
//   * closed field allow-lists + material-shaped-field refusal (a secret can
//     never be smuggled into a grant);
//   * rows are never deleted by the store API;
//   * CAS-guarded transitions (ACTIVE → CONSUMED/REVOKED/EXPIRED): concurrent
//     consume/revoke cannot both win, and a use racing a revocation reads one
//     consistent snapshot (single transaction).

import type { StorageWriteScope } from '@jataqi/storage';
import { PrincipalValidationError } from './types.js';
import { AUTH_SESSION_CLOCK_SKEW_MS } from './authentication-event-store.js';
import { PRIVILEGE_PLATFORM_TENANT } from './privilege-types.js';

/** P2-S4 collection: durable, tenant-bound delegation grants. */
export const DELEGATIONS_COLLECTION = 'identity.delegations';

/** The storage tenant marker for platform-scoped delegation grants. */
export const DELEGATION_PLATFORM_TENANT = PRIVILEGE_PLATFORM_TENANT;

/** Shared deny-early clock-skew bound (the single P2 300 s bound). */
export const DELEGATION_CLOCK_SKEW_MS = AUTH_SESSION_CLOCK_SKEW_MS;

/**
 * Hard cap on a grant's lifetime. The specification makes `maxAgeMs`
 * mandatory and "bounded by the manifest lifetime floor"; the store enforces
 * this conservative ceiling (≤ 24 h) as defense-in-depth and the decision-time
 * chain re-verification enforces the manifest-bound constraint (a grant can
 * never outlive the manifest revision it cites — §8.2.6).
 */
export const MAX_DELEGATION_LIFETIME_MS = 24 * 60 * 60_000;

/** Maximum delegation chain depth (spec §8.2.6: depth ≤ 2; default 1). */
export const MAX_DELEGATION_CHAIN_DEPTH = 2;

/** Delegation status. CONSUMED/REVOKED/EXPIRED are terminal for use. */
export type DelegationStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'CONSUMED';

/** Delegation scope: one tenant (default), or the whole platform (audited path). */
export type DelegationScope = 'tenant' | 'platform';

/** One (tool, operation) the grant may be exercised for. */
export interface DelegationAction {
  readonly tool: string;
  readonly operation: string;
}

/** One target-system/resource scope the grant covers (mirrors A-01 target entries). */
export interface DelegationTargetScope {
  readonly system: string;
  readonly resourcePattern?: string;
}

/** Grant constraints (spec §8.1). `maxAgeMs` is mandatory; ceilings narrow. */
export interface DelegationConstraints {
  readonly maxAgeMs: number;
  /** Per-run budget ceiling (cost units). Absent = manifest ceiling applies. */
  readonly budgetCeiling?: number;
  /** Classification ceiling (A-01 vocabulary string). */
  readonly classificationCeiling?: string;
  /** Impact ceiling (A-01 vocabulary string). */
  readonly impactCeiling?: string;
}

/** Digest-bound approval (spec §8.1: mandatory when the capability requires approval). */
export interface DelegationApprovalBinding {
  readonly approvalId: string;
  readonly approverId: string;
  readonly approvedAt: number;
  readonly expiresAt: number;
  readonly approvedActionDigest: string;
}

/**
 * One durable delegation grant (spec §8.1). `id` IS the delegation id
 * (server-minted `randomUUID`). Material never enters this document:
 * `grantedBy` and `approval` carry REFERENCES/fingerprints only.
 */
export interface DelegationDoc {
  readonly id: string;
  readonly delegatorPrincipalId: string;
  readonly delegateePrincipalId: string;
  /** Delegator's tenant for tenant-scoped grants; `system` for platform grants. */
  readonly tenantId: string;
  readonly scope: DelegationScope;
  readonly capability: { readonly capabilityId: string; readonly capabilityVersion: string };
  /** ⊆ the delegator's manifest operations. */
  readonly actions: readonly DelegationAction[];
  /** ⊆ the delegator's manifest target scope. */
  readonly targetScope: readonly DelegationTargetScope[];
  readonly constraints: DelegationConstraints;
  /** Number of prior delegation hops (0 for a direct grant); bounded ≤ 2. */
  readonly chainDepth: number;
  /**
   * Provenance: the delegator's authority evidence at grant time. `chain[0]`
   * is the delegator's manifest digest (re-verified against the LIVE manifest
   * at every decision — §8.2.6 / A-16); subsequent entries cite upstream
   * grant/envelope digests for chained delegation.
   */
  readonly chain: readonly string[];
  readonly grantedBy: {
    readonly principalId: string;
    readonly authenticationEventId: string;
    readonly stepUpEventId?: string;
    /** Recorded platform-plane elevation id (mandatory for platform grants). */
    readonly platformElevationId?: string;
  };
  readonly approval?: DelegationApprovalBinding;
  /** One-shot grants are CAS-consumed to CONSUMED on first use. */
  readonly oneShot: boolean;
  /** Remaining uses for counted grants (`!oneShot`). Absent = single-use. */
  readonly useCount?: number;
  readonly expiresAt: number;
  readonly status: DelegationStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly consumedAt?: number;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
}

/** Input to `DelegationStore.grantDelegation`. */
export interface GrantDelegationInput {
  readonly delegatorPrincipalId: string;
  readonly delegateePrincipalId: string;
  readonly tenantId: string;
  readonly scope: DelegationScope;
  readonly capability: { readonly capabilityId: string; readonly capabilityVersion: string };
  readonly actions: readonly DelegationAction[];
  readonly targetScope: readonly DelegationTargetScope[];
  readonly constraints: DelegationConstraints;
  readonly chainDepth: number;
  readonly chain: readonly string[];
  readonly grantedBy: {
    readonly principalId: string;
    readonly authenticationEventId: string;
    readonly stepUpEventId?: string;
    readonly platformElevationId?: string;
  };
  readonly approval?: DelegationApprovalBinding;
  readonly oneShot: boolean;
  readonly useCount?: number;
  readonly correlationId?: string;
  /**
   * The delegator's verified authority at grant time (resolved by the
   * caller from the LIVE capability manifest). The store asserts the grant
   * is a SUBSET of this (defense-in-depth); the authoritative re-check is
   * the decision-time chain re-verification against the live manifest.
   */
  readonly delegatorEvidence: {
    readonly manifestDigest: string;
    readonly actions: readonly DelegationAction[];
    readonly targets: readonly DelegationTargetScope[];
    readonly classificationCeiling: string;
    readonly impactCeiling: string;
    readonly requiresApproval: boolean;
  };
}

/** Input to `DelegationStore.revokeDelegation`. */
export interface RevokeDelegationInput {
  readonly delegationId: string;
  readonly tenantId: string;
  readonly scope: DelegationScope;
  /** The acting authority (recorded in the audit). */
  readonly revokedBy: string;
  /** Mandatory, non-blank revocation reason. */
  readonly reason: string;
  readonly correlationId?: string;
}

/** Decision-time assessment verdicts. `VALID` is the ONLY non-denying outcome. */
export type DelegationAssessmentVerdict =
  | 'VALID'
  | 'UNKNOWN_GRANT'
  | 'NOT_DELEGATEE'
  | 'CROSS_TENANT'
  | 'SCOPE_TENANT'
  | 'SCOPE_OPERATION'
  | 'SCOPE_TARGET'
  | 'SCOPE_CLASSIFICATION'
  | 'SCOPE_IMPACT'
  | 'EXPIRED'
  | 'REVOKED'
  | 'CONSUMED'
  | 'CHAIN_DEPTH'
  | 'DELEGATOR_AUTHORITY_CHANGED'
  | 'PLATFORM_SCOPE_REQUIRED'
  | 'APPROVAL_REQUIRED';

/** The assessment of one grant for one decision (secret-free). */
export interface DelegationAssessment {
  readonly verdict: DelegationAssessmentVerdict;
  readonly delegationId: string;
  readonly status?: DelegationStatus;
  readonly scope?: DelegationScope;
  readonly detail?: string;
}

/**
 * What the decision-time delegation stage needs to assess one grant. The
 * `liveManifest` is the ACTIVE manifest revision (the delegator's authority
 * re-check — A-16), resolved by the decider from durable state.
 */
export interface DelegationRequirement {
  readonly delegationId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly sessionEventId?: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly tool: string;
  readonly operation: string;
  readonly targetSystem: string;
  readonly targetResource?: string;
  readonly classification: string;
  readonly impact: string;
  /** True when the request's capability is system-scoped (platform operation). */
  readonly requestIsPlatformScoped: boolean;
  readonly liveManifest: {
    readonly digest: string;
    readonly actions: readonly DelegationAction[];
    readonly targets: readonly DelegationTargetScope[];
    readonly classificationCeiling: string;
    readonly impactCeiling: string;
    readonly requiresApproval: boolean;
  };
}

/** A minimal scope/tenant peek (system-scope) for the decider's classification. */
export interface DelegationPeek {
  readonly scope: DelegationScope;
  readonly tenantId: string;
}

/**
 * The delegation-state authority the durable A-01 decider consults. It reads
 * the SAME `identity.delegations` collection the store writes — there is no
 * second source of truth. Implementations MUST throw on any storage problem
 * (the decider turns that into a storage-failure DENY) and MUST read through
 * the passed scope for tenant-scoped reads (one consistent snapshot).
 */
export interface DelegationStateAuthority {
  readonly kind: 'p2-delegation-state-authority';
  /** System-scope peek: existence + scope + tenant (enumerated INV-15 read). */
  peek(delegationId: string): Promise<DelegationPeek | undefined>;
  /** Tenant-scoped read + full assessment INSIDE the caller's transaction. */
  assessInTx(scope: StorageWriteScope, requirement: DelegationRequirement, now: number): Promise<DelegationAssessment>;
  /** System-scoped read + full assessment (platform grants / classification). */
  assessPlatform(requirement: DelegationRequirement, now: number): Promise<DelegationAssessment>;
  /** Tenant-scoped CAS consumption (one-shot → CONSUMED; counted → decrement). */
  consumeInTx(scope: StorageWriteScope, delegationId: string, now: number): Promise<DelegationDoc>;
  /** System-scoped CAS consumption (platform grants). */
  consumePlatform(delegationId: string, now: number): Promise<DelegationDoc>;
}

/** Durable delegation-store failure (any rejection from the delegation substrate). */
export class DelegationStoreError extends PrincipalValidationError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'DelegationStoreError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A required delegation is missing or invalid (service-enforcement denial). */
export class DelegationRequiredError extends DelegationStoreError {
  readonly verdict: DelegationAssessmentVerdict;
  constructor(verdict: DelegationAssessmentVerdict, detail: string) {
    super('DELEGATION_REQUIRED', `delegated authority refused (${verdict}): ${detail} (fail-closed).`);
    this.name = 'DelegationRequiredError';
    this.verdict = verdict;
  }
}

const FORBIDDEN_FIELD_PATTERN = /(material|secret|token|password|privatekey|credentialmaterial|jwks|jwk)/i;

/** Closed-schema + material-shaped-field refusal (same pattern as S-1/S-8/S-9/S-3). */
export function assertDelegationDocumentShape(
  doc: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) {
      throw new DelegationStoreError(
        'CLOSED_SCHEMA_VIOLATION',
        `${context}: unknown field "${key}" would be persisted (closed-schema violation, fail-closed).`,
      );
    }
    if (FORBIDDEN_FIELD_PATTERN.test(key)) {
      throw new DelegationStoreError(
        'MATERIAL_FIELD_REFUSED',
        `${context}: field "${key}" is material-shaped and must never be persisted (fail-closed).`,
      );
    }
  }
}

/** Deny-early expiry (the single P2 300 s bound, applied uniformly). */
export function isDelegationExpired(expiresAt: number, now: number): boolean {
  return now + DELEGATION_CLOCK_SKEW_MS >= expiresAt;
}

/** True when a chain depth is within the allowed bound (spec §8.2.6: ≤ 2). */
export function isDelegationChainDepthAllowed(depth: number): boolean {
  return Number.isInteger(depth) && depth >= 0 && depth <= MAX_DELEGATION_CHAIN_DEPTH;
}

/**
 * Conservative subset test: is `grantTarget` within the `liveTargets` scope?
 * A system must match, and the grant's resource pattern must be covered:
 *   * grant resourcePattern undefined ⇒ a live target must hold "no resource"
 *     (`resourcePattern === undefined`) — never inferred;
 *   * grant resourcePattern present ⇒ a live target must cover it (`*` covers
 *     everything, an identical literal covers exactly, an undefined live
 *     pattern does NOT cover a concrete resource).
 * This is the fail-closed subset notion used at grant time and in the A-16
 * live-manifest re-verification; the authoritative per-decision resource
 * check is `delegationTargetMatches` against both the grant and the live
 * manifest.
 */
export function delegationTargetScopeWithin(
  grantTarget: DelegationTargetScope,
  liveTargets: readonly DelegationTargetScope[],
): boolean {
  return liveTargets.some((t) => {
    if (t.system !== grantTarget.system) return false;
    if (grantTarget.resourcePattern === undefined) return t.resourcePattern === undefined;
    return t.resourcePattern === undefined ? false : t.resourcePattern === '*' || t.resourcePattern === grantTarget.resourcePattern;
  });
}

/**
 * Target-scope matching (mirrors the A-01 `targetMatches` semantics exactly:
 * exact system match; `resourcePattern` undefined ⇒ resource must be absent;
 * no `*` ⇒ exact resource match; `*` ⇒ simple segment glob).
 */
export function delegationTargetMatches(
  pattern: DelegationTargetScope | undefined,
  system: string,
  resource: string | undefined,
): boolean {
  if (!pattern) return false;
  if (pattern.system !== system) return false;
  if (pattern.resourcePattern === undefined) return resource === undefined;
  if (resource === undefined) return false;
  if (!pattern.resourcePattern.includes('*')) return pattern.resourcePattern === resource;
  const regex = new RegExp(
    `^${pattern.resourcePattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return regex.test(resource);
}

/**
 * A-01 classification/impact orderings (mirrored locally so the delegation
 * store can compare ceilings without depending on the authorization-boundary
 * package — the dependency direction is authorization-boundary → authentication).
 * These MUST stay identical to `A01_CLASSIFICATION_ORDER` / `A01_IMPACT_ORDER`.
 */
export const DELEGATION_CLASSIFICATION_ORDER: Readonly<Record<string, number>> = Object.freeze({
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
});
export const DELEGATION_IMPACT_ORDER: Readonly<Record<string, number>> = Object.freeze({
  READ: 0,
  REVERSIBLE_WRITE: 1,
  CONSEQUENTIAL_WRITE: 2,
  EXTERNAL_SIDE_EFFECT: 3,
});

function classificationRank(value: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(DELEGATION_CLASSIFICATION_ORDER, value)
    ? DELEGATION_CLASSIFICATION_ORDER[value]
    : undefined;
}
function impactRank(value: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(DELEGATION_IMPACT_ORDER, value)
    ? DELEGATION_IMPACT_ORDER[value]
    : undefined;
}

function actionsContain(actions: readonly DelegationAction[], tool: string, operation: string): boolean {
  return actions.some((a) => a.tool === tool && a.operation === operation);
}

function targetsContain(targets: readonly DelegationTargetScope[], system: string, resource: string | undefined): boolean {
  return targets.some((t) => delegationTargetMatches(t, system, resource));
}

/**
 * Pure, deterministic grant assessment (spec §8.2.1–8.2.8, in order). Only
 * `VALID` is non-denying. Used by the store's in-transaction reads AND the
 * decider's enforcement re-check (one semantics, two enforcement sites).
 */
export function assessDelegationRow(
  row: DelegationDoc,
  requirement: DelegationRequirement,
  now: number,
): DelegationAssessment {
  const common = { delegationId: row.id, status: row.status, scope: row.scope };

  // §8.2.1: delegatee binding — no acting-as.
  if (row.delegateePrincipalId !== requirement.principalId) {
    return { ...common, verdict: 'NOT_DELEGATEE', detail: 'the grant binds a different delegatee principal' };
  }

  // §8.2.2: tenant binding / cross-tenant refusal.
  if (row.scope === 'tenant') {
    if (row.tenantId !== requirement.tenantId) {
      return {
        ...common,
        verdict: 'CROSS_TENANT',
        detail: `a tenant-scoped grant for "${row.tenantId}" cannot be exercised for "${requirement.tenantId}"`,
      };
    }
  } else {
    // Platform-scoped grant: covers platform operations only, and requires
    // the fully-audited platform path (recorded platform elevation + approval).
    if (!requirement.requestIsPlatformScoped) {
      return { ...common, verdict: 'SCOPE_TENANT', detail: 'a platform-scoped grant cannot be exercised as tenant-scoped authority' };
    }
    if (!row.grantedBy.platformElevationId) {
      return {
        ...common,
        verdict: 'PLATFORM_SCOPE_REQUIRED',
        detail: 'a platform-scoped grant must record the delegator\'s platform-plane elevation at grant time',
      };
    }
    if (!row.approval) {
      return { ...common, verdict: 'APPROVAL_REQUIRED', detail: 'a platform-scoped grant requires a bound digest approval' };
    }
  }

  // §8.2.5: status.
  if (row.status === 'REVOKED') {
    return { ...common, verdict: 'REVOKED', detail: 'the grant was revoked' };
  }
  if (row.status === 'CONSUMED') {
    return { ...common, verdict: 'CONSUMED', detail: 'the grant was already consumed' };
  }
  if (row.status === 'EXPIRED') {
    return { ...common, verdict: 'EXPIRED', detail: 'the grant expired' };
  }
  if (row.status !== 'ACTIVE') {
    return { ...common, verdict: 'REVOKED', detail: `unexpected grant status "${String(row.status)}"` };
  }

  // §8.2.4: expiry (deny-early).
  if (isDelegationExpired(row.expiresAt, now)) {
    return { ...common, verdict: 'EXPIRED', detail: 'the grant window has passed (deny-early)' };
  }

  // §8.2.3: capability/operation subset (grant).
  if (row.capability.capabilityId !== requirement.capabilityId) {
    return { ...common, verdict: 'SCOPE_OPERATION', detail: `the grant covers capability "${row.capability.capabilityId}", not "${requirement.capabilityId}"` };
  }
  if (!actionsContain(row.actions, requirement.tool, requirement.operation)) {
    return { ...common, verdict: 'SCOPE_OPERATION', detail: `the grant does not cover operation ${requirement.tool}/${requirement.operation}` };
  }
  // §8.2.3: target subset (grant).
  if (!targetsContain(row.targetScope, requirement.targetSystem, requirement.targetResource)) {
    return {
      ...common,
      verdict: 'SCOPE_TARGET',
      detail: `the grant target scope does not cover ${requirement.targetSystem}/${requirement.targetResource ?? '<none>'}`,
    };
  }
  // §8.2.3: classification/impact ceilings (grant).
  const requestClassRank = classificationRank(requirement.classification);
  if (row.constraints.classificationCeiling !== undefined) {
    const ceilingRank = classificationRank(row.constraints.classificationCeiling);
    if (requestClassRank !== undefined && ceilingRank !== undefined && requestClassRank > ceilingRank) {
      return { ...common, verdict: 'SCOPE_CLASSIFICATION', detail: 'the request classification exceeds the grant ceiling' };
    }
  }
  const requestImpactRank = impactRank(requirement.impact);
  if (row.constraints.impactCeiling !== undefined) {
    const ceilingRank = impactRank(row.constraints.impactCeiling);
    if (requestImpactRank !== undefined && ceilingRank !== undefined && requestImpactRank > ceilingRank) {
      return { ...common, verdict: 'SCOPE_IMPACT', detail: 'the request impact exceeds the grant ceiling' };
    }
  }

  // §8.2.6: chain depth bound.
  if (!isDelegationChainDepthAllowed(row.chainDepth)) {
    return { ...common, verdict: 'CHAIN_DEPTH', detail: `grant chain depth ${row.chainDepth} exceeds the allowed bound` };
  }

  // §8.2.6 / A-16: chain integrity — the delegator's authority must be UNCHANGED.
  //   (a) the cited manifest digest must still be the LIVE digest;
  //   (b) the grant must still be a subset of the live manifest scope.
  if (row.chain.length === 0 || row.chain[0] !== requirement.liveManifest.digest) {
    return {
      ...common,
      verdict: 'DELEGATOR_AUTHORITY_CHANGED',
      detail: 'the delegator\'s cited manifest revision is no longer active (authority changed since grant)',
    };
  }
  for (const action of row.actions) {
    if (!actionsContain(requirement.liveManifest.actions, action.tool, action.operation)) {
      return { ...common, verdict: 'DELEGATOR_AUTHORITY_CHANGED', detail: 'the grant exceeds the delegator\'s live manifest operations' };
    }
  }
  for (const target of row.targetScope) {
    if (!delegationTargetScopeWithin(target, requirement.liveManifest.targets)) {
      return { ...common, verdict: 'DELEGATOR_AUTHORITY_CHANGED', detail: 'the grant exceeds the delegator\'s live manifest targets' };
    }
  }
  if (row.constraints.classificationCeiling !== undefined) {
    const ceilingRank = classificationRank(row.constraints.classificationCeiling);
    const liveRank = classificationRank(requirement.liveManifest.classificationCeiling);
    if (ceilingRank !== undefined && liveRank !== undefined && ceilingRank > liveRank) {
      return { ...common, verdict: 'DELEGATOR_AUTHORITY_CHANGED', detail: 'the grant classification ceiling exceeds the live manifest' };
    }
  }
  if (row.constraints.impactCeiling !== undefined) {
    const ceilingRank = impactRank(row.constraints.impactCeiling);
    const liveRank = impactRank(requirement.liveManifest.impactCeiling);
    if (ceilingRank !== undefined && liveRank !== undefined && ceilingRank > liveRank) {
      return { ...common, verdict: 'DELEGATOR_AUTHORITY_CHANGED', detail: 'the grant impact ceiling exceeds the live manifest' };
    }
  }

  // §8.1: approval mandatory when the live capability requires it.
  if (requirement.liveManifest.requiresApproval && !row.approval) {
    return { ...common, verdict: 'APPROVAL_REQUIRED', detail: 'the live manifest requires an approval and the grant carries none' };
  }
  if (row.approval !== undefined) {
    if (row.approval.approvedAt >= row.approval.expiresAt || isDelegationExpired(row.approval.expiresAt, now)) {
      return { ...common, verdict: 'APPROVAL_REQUIRED', detail: 'the grant approval is expired' };
    }
  }

  return { ...common, verdict: 'VALID' };
}
