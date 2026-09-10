// P2-S1 — Production identity core: shared types, collection names, and the
// identity-state authority surface.
//
// Identity in JATA Qi is a TENANT-BOUND PAIR (principalId, tenantId) — the
// same unit as the T-01 `CommercialActor` projection. An identity record
// carries the lifecycle state machine (spec §4.2), its membership status,
// its role assignments, and its federation binding (issuer + subject).
//
// Durability rules (R2 discipline, preserved):
//   * every store runs ONLY inside explicit transactions on a transactional
//     driver (memory/filesystem refused at open);
//   * pre-tenant single-row lookups (subject bindings, jti replay) run in
//     explicit system-scope transactions — the SAME enumerated, counted,
//     `transaction:system` exception the S-9 fingerprint read uses (INV-15);
//   * closed field allow-lists + material-shaped-field refusal (a secret can
//     never be smuggled into identity state);
//   * rows are never deleted by the store API (audit hygiene); the only
//     deletions are TTL GC of jti-replay rows and the boot-canary sweep,
//     both explicit and documented;
//   * CAS-guarded transitions: two concurrent transitions cannot both win.

import type { CommercialActorRole } from '@jataqi/commercial-control-plane';
import type { StorageWriteScope } from '@jataqi/storage';
import { PrincipalValidationError } from './types.js';

/** P2-S1 collection: durable identity records (state machine). */
export const IDENTITY_PRINCIPALS_COLLECTION = 'identity.principals';
/** P2-S1 collection: per-tenant membership status. */
export const IDENTITY_MEMBERSHIPS_COLLECTION = 'identity.memberships';
/** P2-S1 collection: role lifecycle (grant/revoke, durable). */
export const IDENTITY_ROLE_ASSIGNMENTS_COLLECTION = 'identity.role-assignments';
/** P2-S1 collection: one-shot bound recovery records. */
export const IDENTITY_RECOVERY_COLLECTION = 'identity.recovery';
/** P2-S1 collection: one-shot (issuer, subject) → principal bindings. */
export const IDENTITY_SUBJECT_BINDINGS_COLLECTION = 'identity.subject-bindings';
/** P2-S1 collection: durable jti single-use replay set. */
export const IDENTITY_JTI_REPLAY_COLLECTION = 'identity.jti-replay';
/** P2-S1 collection: append-only identity/privilege security events. */
export const IDENTITY_EVENTS_COLLECTION = 'identity.events';

/** All P2-S1 collections (RLS-probe + registry reference). */
export const P2_S1_IDENTITY_COLLECTIONS: readonly string[] = Object.freeze([
  IDENTITY_PRINCIPALS_COLLECTION,
  IDENTITY_MEMBERSHIPS_COLLECTION,
  IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
  IDENTITY_RECOVERY_COLLECTION,
  IDENTITY_SUBJECT_BINDINGS_COLLECTION,
  IDENTITY_JTI_REPLAY_COLLECTION,
  IDENTITY_EVENTS_COLLECTION,
]);

/**
 * The identity lifecycle state machine (spec §4.2).
 *
 * ENROLLED → ACTIVATED → SUSPENDED → ACTIVATED (re-activation)
 *             │  └───────────→ DEACTIVATED → DEPROVISIONED (terminal)
 *
 * DEPROVISIONED is terminal: no path re-enables it (recovery included).
 */
export type IdentityState =
  | 'ENROLLED'
  | 'ACTIVATED'
  | 'SUSPENDED'
  | 'DEACTIVATED'
  | 'DEPROVISIONED';

/** The closed state set (machine-checkable; mirrors RECOGNIZED_* lists). */
export const RECOGNIZED_IDENTITY_STATES: readonly IdentityState[] = Object.freeze([
  'ENROLLED',
  'ACTIVATED',
  'SUSPENDED',
  'DEACTIVATED',
  'DEPROVISIONED',
]);

/** True when `value` is a recognized identity state. */
export function isIdentityState(value: unknown): value is IdentityState {
  return (
    typeof value === 'string' &&
    (RECOGNIZED_IDENTITY_STATES as readonly string[]).includes(value)
  );
}

/**
 * The closed transition table (spec §4.2 state machine). Every pair NOT
 * listed here is forbidden and is asserted as a negative case in the S1 test
 * matrix (all 14 of the remaining 20 ordered pairs).
 *
 * The diagram's "(rejected)" terminal exit from ENROLLED is implemented as
 * ENROLLED → DEPROVISIONED: an enrollment that never activates is
 * deprovisioned (the §4.4 cascade applies; the record is retained for audit).
 * This is the only reading that gives every reachable state a path to the
 * terminal state without inventing any other transition (in particular,
 * direct deactivation of a live ACTIVATED identity is NOT permitted — the
 * diagram routes deactivation exclusively from SUSPENDED).
 */
export const IDENTITY_LIFECYCLE_TRANSITIONS: readonly (readonly [IdentityState, IdentityState])[] =
  Object.freeze([
    ['ENROLLED', 'ACTIVATED'], // first successful production verification
    ['ENROLLED', 'DEPROVISIONED'], // the diagram's "(rejected)" terminal exit
    ['ACTIVATED', 'SUSPENDED'], // suspension (admin, reason)
    ['SUSPENDED', 'ACTIVATED'], // re-activation via fresh verification
    ['SUSPENDED', 'DEACTIVATED'], // deactivation (admin, reason)
    ['DEACTIVATED', 'DEPROVISIONED'], // deprovisioning (admin) + cascade
  ]);

/** True when the transition from → to is permitted by the state machine. */
export function isPermittedIdentityTransition(from: IdentityState, to: IdentityState): boolean {
  return IDENTITY_LIFECYCLE_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

/** Membership status (mirrors the principal state for the tenant). */
export type IdentityMembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

export interface IdentityPrincipalDoc {
  /** SHA-256(tenantId \u0000 principalId) — deterministic, collision-safe PK. */
  readonly id: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly state: IdentityState;
  readonly version: number;
  /** Last transition metadata (evidence, never material). */
  readonly lastTransition?: {
    readonly from: IdentityState;
    readonly to: IdentityState;
    readonly at: number;
    readonly evidence?: string;
    readonly reason?: string;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface IdentityMembershipDoc {
  /** Same PK as the principal doc (1:1 in S1 — one home tenant per identity). */
  readonly id: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly status: IdentityMembershipStatus;
  readonly since: number;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
  readonly updatedAt: number;
}

export type IdentityRoleAssignmentStatus = 'ACTIVE' | 'REVOKED';

export interface IdentityRoleAssignmentDoc {
  readonly id: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly role: CommercialActorRole;
  readonly status: IdentityRoleAssignmentStatus;
  readonly grantedBy: string;
  readonly grantedAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
  readonly updatedAt: number;
}

export type IdentityRecoveryStatus = 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

export interface IdentityRecoveryDoc {
  readonly id: string;
  readonly principalId: string;
  readonly tenantId: string;
  /** The recovery method (e.g. 'totp-rebind' — method semantics are S5). */
  readonly method: string;
  /** Opaque reference to the bound challenge (NEVER the challenge material). */
  readonly bindingRef: string;
  readonly oneShot: true;
  readonly expiresAt: number;
  readonly status: IdentityRecoveryStatus;
  readonly requestedBy: string;
  readonly createdAt: number;
  readonly consumedAt?: number;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
  readonly updatedAt: number;
}

export interface IdentitySubjectBindingDoc {
  /** SHA-256(issuer \u0000 subject) — deterministic, collision-safe PK. */
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly boundBy: string;
  readonly boundAt: number;
}

export interface IdentityJtiReplayDoc {
  /** The assertion jti (from the verified signature domain). */
  readonly id: string;
  readonly firstSeenAt: number;
  /** The assertion's exp (the row's retention horizon). */
  readonly expiresAt: number;
  readonly consumedAt: number;
}

// ---------------------------------------------------------------------------
// Identity security events (spec §13 catalog — S1-emitted kinds + reserved)
// ---------------------------------------------------------------------------

/**
 * The identity/privilege security event catalog (spec §13). S1 emits the
 * AUTH, IDENTITY, MEMBERSHIP, ROLE, CREDENTIAL, and ADMIN_ACTION kinds; the
 * remaining kinds are RESERVED for P2-S2…S6 (declared now so the catalog is
 * stable and the collection schema never needs to change).
 */
export type IdentityEventKind =
  // S1 — authentication
  | 'AUTH_LOGIN'
  | 'AUTH_FAILED'
  // S1 — identity lifecycle
  | 'IDENTITY_ENROLLED'
  | 'IDENTITY_ACTIVATED'
  | 'IDENTITY_SUSPENDED'
  | 'IDENTITY_DEACTIVATED'
  | 'IDENTITY_DEPROVISIONED'
  | 'IDENTITY_RECOVERED'
  // S1 — membership / roles
  | 'MEMBERSHIP_CHANGED'
  | 'ROLE_CHANGED'
  // S1 — credentials (auto-link records the binding change)
  | 'CREDENTIAL_CHANGED'
  // S1 — administrative actions (uniform shape for register operations)
  | 'ADMIN_ACTION'
  // S2 — session token lifecycle (reserved)
  | 'SESSION_CREATED'
  | 'SESSION_ROTATED'
  | 'SESSION_REVOKED'
  | 'SESSION_EXPIRED'
  // S5 — MFA (reserved)
  | 'AUTH_MFA_STEPUP'
  // S3/S6 — privilege plane + break-glass (reserved)
  | 'PRIVILEGE_ELEVATION'
  | 'PRIVILEGE_REVOKED'
  | 'PRIVILEGE_BREAKGLASS_ACTIVATED'
  | 'PRIVILEGE_BREAKGLASS_REVOKED'
  | 'PRIVILEGE_BREAKGLASS_EXPIRED'
  | 'PRIVILEGE_BREAKGLASS_REVIEW_DUE'
  | 'PRIVILEGE_BREAKGLASS_REVIEWED'
  // S4 — delegation (reserved)
  | 'DELEGATION_GRANTED'
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_USED'
  | 'DELEGATION_DENIED'
  // S3 — policy changes (reserved)
  | 'POLICY_CHANGED';

export const RECOGNIZED_IDENTITY_EVENT_KINDS: readonly IdentityEventKind[] = Object.freeze([
  'AUTH_LOGIN',
  'AUTH_FAILED',
  'IDENTITY_ENROLLED',
  'IDENTITY_ACTIVATED',
  'IDENTITY_SUSPENDED',
  'IDENTITY_DEACTIVATED',
  'IDENTITY_DEPROVISIONED',
  'IDENTITY_RECOVERED',
  'MEMBERSHIP_CHANGED',
  'ROLE_CHANGED',
  'CREDENTIAL_CHANGED',
  'ADMIN_ACTION',
  'SESSION_CREATED',
  'SESSION_ROTATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'AUTH_MFA_STEPUP',
  'PRIVILEGE_ELEVATION',
  'PRIVILEGE_REVOKED',
  'PRIVILEGE_BREAKGLASS_ACTIVATED',
  'PRIVILEGE_BREAKGLASS_REVOKED',
  'PRIVILEGE_BREAKGLASS_EXPIRED',
  'PRIVILEGE_BREAKGLASS_REVIEW_DUE',
  'PRIVILEGE_BREAKGLASS_REVIEWED',
  'DELEGATION_GRANTED',
  'DELEGATION_REVOKED',
  'DELEGATION_USED',
  'DELEGATION_DENIED',
  'POLICY_CHANGED',
]);

/**
 * One durable identity security event. Provenance fields (spec §10):
 * WHO (principalId + authority.authenticationEventId), WHAT (kind +
 * resource), WHEN (at), TENANT (tenantId), RESOURCE (resource), AUTHORITY
 * (authority), DECISION (decision), RESULT (result), CORRELATION
 * (correlationId). Append-only; closed schema; no material-shaped fields.
 */
export interface IdentityEventDoc {
  readonly id: string;
  readonly at: number;
  readonly tenantId: string;
  readonly kind: IdentityEventKind;
  readonly principalId?: string;
  readonly resource?: string;
  readonly authority?: {
    /** The authentication method of the acting principal (when one acted). */
    readonly method?: string;
    /** The durable authentication event id of the acting principal. */
    readonly authenticationEventId?: string;
    /** The named acting admin/service (enrolledBy, grantedBy, …). */
    readonly actor?: string;
  };
  readonly decision?: 'ALLOW' | 'DENY';
  readonly result?: string;
  /** Secret-free detail (reasons, state pairs, counts — never material). */
  readonly detail?: string;
  readonly correlationId?: string;
}

const FORBIDDEN_FIELD_PATTERN = /(material|secret|token|password|privatekey|credentialmaterial|jwks|jwk)/i;

/** Durable identity-store failure: any rejection from the identity substrate. */
export class IdentityStoreError extends PrincipalValidationError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'IdentityStoreError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Forbidden lifecycle transition (every non-table pair). */
export class IdentityLifecycleError extends IdentityStoreError {
  constructor(from: IdentityState, to: IdentityState | string, message?: string) {
    super(
      'LIFECYCLE_FORBIDDEN_TRANSITION',
      message ??
        (`identity transition ${from} → ${to} is not permitted by the lifecycle state machine (fail-closed); ` +
          `permitted transitions: ${IDENTITY_LIFECYCLE_TRANSITIONS.map(([a, b]) => `${a}→${b}`).join(', ')}`),
    );
    this.name = 'IdentityLifecycleError';
  }
}

/** Rebind refusal: a taken binding cannot be reassigned (fail-closed). */
export class IdentityRebindRefusedError extends IdentityStoreError {
  constructor(detail: string) {
    super('REBIND_REFUSED', `identity rebind refused (fail-closed): ${detail}`);
    this.name = 'IdentityRebindRefusedError';
  }
}

/** Durable jti replay: the assertion was already presented once. */
export class JtiReplayError extends IdentityStoreError {
  constructor(jti: string) {
    super('JTI_REPLAY_DETECTED', `jti "${jti}" was already consumed; replayed assertions are refused (fail-closed).`);
    this.name = 'JtiReplayError';
  }
}

/**
 * Reject any document carrying unknown fields or material-shaped fields.
 * Same defense-in-depth pattern as the S-8/S-9 stores: even a compromised
 * caller cannot smuggle a secret into durable identity state.
 */
export function assertIdentityDocumentShape(
  doc: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) {
      throw new IdentityStoreError(
        'CLOSED_SCHEMA_VIOLATION',
        `${context}: unknown field "${key}" would be persisted (closed-schema violation, fail-closed).`,
      );
    }
    if (FORBIDDEN_FIELD_PATTERN.test(key)) {
      throw new IdentityStoreError(
        'MATERIAL_FIELD_REFUSED',
        `${context}: field "${key}" is material-shaped and must never be persisted (fail-closed).`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Identity-state authority (the P2-S1 decision-time re-read surface)
// ---------------------------------------------------------------------------

/**
 * The result of a decision-time identity re-read (spec §4.1: no role set or
 * membership state is cached across decisions; the Phase-B transaction
 * re-reads both).
 */
export interface IdentityStateLookup {
  readonly state: IdentityState;
  /** The ACTIVE role assignments for (principalId, tenantId) at read time. */
  readonly activeRoles: readonly CommercialActorRole[];
  /** The identity's home tenant (the decider cross-checks against the request tenant). */
  readonly tenantId: string;
}

/**
 * The identity-state authority the durable decider consults INSIDE its tenant
 * transaction (spec §24-S1 "identity-state check inside the Phase-B
 * transaction"). Implementations MUST read through the passed transaction
 * scope (one consistent snapshot, no nested transactions) and MUST fail
 * closed (throw) on any storage problem — the decider turns that into a
 * storage-failure DENY.
 */
export interface IdentityStateAuthority {
  readonly kind: 'p2-identity-state-authority';
  /**
   * Re-read one principal's identity state + active roles. Returns
   * `undefined` when NO identity record exists for (tenantId, principalId) —
   * the pre-P2 passthrough (unlinked principals keep the exact pre-S1
   * decision behavior; only EXISTING identities are gated).
   */
  lookupInTx(
    scope: StorageWriteScope,
    tenantId: string,
    principalId: string,
    now: number,
  ): Promise<IdentityStateLookup | undefined>;
}

/** Deterministic collision-safe PK for a tenant-bound identity pair. */
export function identityPairKey(tenantId: string, principalId: string, hash: (input: string) => string): string {
  return hash(`${tenantId}\u0000${principalId}`);
}

/** Deterministic collision-safe PK for a federation binding. */
export function subjectBindingKey(issuer: string, subject: string, hash: (input: string) => string): string {
  return hash(`${issuer}\u0000${subject}`);
}
