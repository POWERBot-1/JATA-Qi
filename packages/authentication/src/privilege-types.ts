// P2-S3 — Privileged Access Plane: shared types, closed vocabularies,
// collection name, and the decision-time authority surface.
//
// The privileged plane is a SEPARATE closed vocabulary from the commercial
// 7-role set (`observer…system`). Plane roles are held ONLY in durable
// elevation grants (`privileged.elevations`), never as a token-table field.
// Privilege is derived from authoritative durable state — never from a role
// string, a caller claim, or an ambient process designation.
//
// Durability rules (R2 discipline, preserved):
//   * the elevation store runs ONLY on a transactional driver (memory and
//     filesystem refused at open);
//   * tenant-scoped elevations live in the tenant's RLS-bound transaction
//     scope; platform-scoped elevations live under the `system` tenant via
//     explicit, enumerated, counted system-scope transactions (INV-15);
//   * closed field allow-lists + material-shaped-field refusal;
//   * rows are never deleted by the store API;
//   * CAS-guarded transitions (ACTIVE → REVOKED/EXPIRED): concurrent
//     revocations cannot both win, and a use racing a revocation reads one
//     consistent snapshot (single tenant transaction).

import type { StorageWriteScope } from '@jataqi/storage';
import { PrincipalValidationError } from './types.js';
import { AUTH_SESSION_CLOCK_SKEW_MS } from './authentication-event-store.js';

/** P2-S3 collection: durable just-in-time elevation grants. */
export const PRIVILEGED_ELEVATIONS_COLLECTION = 'privileged.elevations';

/** The storage tenant marker for platform-scoped elevation rows. */
export const PRIVILEGE_PLATFORM_TENANT = 'system';

/**
 * The plane-role vocabulary (spec §9.1) — separate from the commercial
 * 7-role set. `break-glass` is a role ONLY (never a standing operation
 * class): it is the emergency path, activated per-use, never held standing.
 */
export type PrivilegeRole =
  | 'platform-admin'
  | 'tenant-admin'
  | 'security-admin'
  | 'operator'
  | 'break-glass';

export const RECOGNIZED_PRIVILEGE_ROLES: readonly PrivilegeRole[] = Object.freeze([
  'platform-admin',
  'tenant-admin',
  'security-admin',
  'operator',
  'break-glass',
]);

/** The standing operation classes (spec §9.3). `break-glass` is not a class. */
export type PrivilegeOperationClass = 'platform-admin' | 'tenant-admin' | 'security-admin' | 'operator';

export const RECOGNIZED_PRIVILEGE_OPERATION_CLASSES: readonly PrivilegeOperationClass[] =
  Object.freeze(['platform-admin', 'tenant-admin', 'security-admin', 'operator']);

export function isPrivilegeRole(value: unknown): value is PrivilegeRole {
  return typeof value === 'string' && (RECOGNIZED_PRIVILEGE_ROLES as readonly string[]).includes(value);
}

export function isPrivilegeOperationClass(value: unknown): value is PrivilegeOperationClass {
  return typeof value === 'string' && (RECOGNIZED_PRIVILEGE_OPERATION_CLASSES as readonly string[]).includes(value);
}

/** Elevation scope: one tenant, or the whole platform. */
export type PrivilegeScope = 'tenant' | 'platform';

/** Elevation status. EXPIRED is derived at read time; REVOKED is terminal. */
export type PrivilegeElevationStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

/** Elevation lifetime bounds (spec §9.2: default 30 min; max 4 h). */
export const DEFAULT_ELEVATION_LIFETIME_MS = 30 * 60_000;
export const MAX_ELEVATION_LIFETIME_MS = 4 * 60 * 60_000;

/** Shared deny-early clock-skew bound (the single P2 300 s bound). */
export const PRIVILEGE_CLOCK_SKEW_MS = AUTH_SESSION_CLOCK_SKEW_MS;

/** Default step-up recency window for operation classes that require it. */
export const DEFAULT_STEP_UP_MAX_AGE_MS = 15 * 60_000;

/**
 * One durable elevation grant (spec §9.2). `id` IS the elevation id
 * (server-minted `randomUUID`). Material never enters this document:
 * `stepUpEventId` is a reference to the step-up evidence, never the
 * evidence material.
 */
export interface PrivilegeElevationDoc {
  /** Elevation id (server-minted; the PK). */
  readonly id: string;
  readonly principalId: string;
  /** Real tenant for `scope: 'tenant'`; `PRIVILEGE_PLATFORM_TENANT` for `scope: 'platform'`. */
  readonly tenantId: string;
  readonly scope: PrivilegeScope;
  /** The plane role the elevation confers. */
  readonly planeRole: PrivilegeRole;
  /** The operation classes the elevation covers (closed set; non-empty). */
  readonly operationClasses: readonly PrivilegeOperationClass[];
  /** The durable session that authenticated the elevation (session binding). */
  readonly sessionEventId: string;
  /** Step-up evidence reference (fresh authentication/MFA assertion id). */
  readonly stepUpEventId?: string;
  /** When the step-up evidence was produced (step-up recency). */
  readonly stepUpAt?: number;
  /** The named granting authority (admin identity or `kernel:bootstrap`). */
  readonly grantedBy: string;
  /** Mandatory, non-blank operator-supplied reason. */
  readonly reason: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly status: PrivilegeElevationStatus;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
  readonly updatedAt: number;
}

/** Input to `PrivilegePlane.grantElevation`. */
export interface GrantElevationInput {
  readonly principalId: string;
  readonly tenantId: string;
  readonly scope: PrivilegeScope;
  readonly planeRole: PrivilegeRole;
  readonly operationClasses: readonly PrivilegeOperationClass[];
  /** The durable session binding (the session that authenticated the elevation). */
  readonly sessionEventId: string;
  /** Step-up evidence (required when the covered classes require step-up). */
  readonly stepUpEventId?: string;
  readonly stepUpAt?: number;
  /** The named granting authority. */
  readonly grantedBy: string;
  /** The acting security-admin's principal id (authorization — re-read in-tx). */
  readonly grantorPrincipalId: string;
  /** The acting security-admin's session (re-read in-tx; grantor authorization). */
  readonly grantorSessionEventId: string;
  /** Mandatory, non-blank reason. */
  readonly reason: string;
  /** Optional lifetime override (bounded to (0, MAX_ELEVATION_LIFETIME_MS]). */
  readonly lifetimeMs?: number;
  /** Correlation id for the audit trail. */
  readonly correlationId?: string;
}

/**
 * The decision-time assessment of a principal's elevation for one
 * operation class. `verdict: 'VALID'` is the ONLY non-denying outcome.
 */
export interface PrivilegeElevationAssessment {
  readonly verdict:
    | 'VALID'
    | 'REQUIRED'
    | 'EXPIRED'
    | 'REVOKED'
    | 'SCOPE_MISMATCH'
    | 'ROLE_MISMATCH'
    | 'SESSION_MISMATCH'
    | 'STEP_UP_STALE';
  readonly elevationId?: string;
  readonly operationClass?: PrivilegeOperationClass;
  readonly elevationStatus?: PrivilegeElevationStatus;
  /** Secret-free detail (never material). */
  readonly detail?: string;
}

/**
 * The privilege-state authority the durable A-01 decider consults INSIDE its
 * Phase-B transaction (mirrors the P2-S1 identity authority). Implementations
 * MUST read through the passed scope (one consistent snapshot) and MUST throw
 * on any storage problem — the decider turns that into a storage-failure
 * DENY. `undefined` is never returned: an absent/mismatched elevation is a
 * non-VALID assessment (fail-closed), never an ambiguity.
 */
export interface PrivilegeStateAuthority {
  readonly kind: 'p2-privilege-state-authority';
  /**
   * Assess inside the CALLER's transaction (tenant-scoped: RLS-bound,
   * one consistent snapshot). Used by the durable decider's Phase-B for
   * tenant-scoped operation classes.
   */
  assessInTx(
    scope: StorageWriteScope,
    requirement: {
      readonly principalId: string;
      readonly tenantId: string;
      /** The presenting session (session/elevation binding check). */
      readonly sessionEventId?: string;
      readonly operationClass: PrivilegeOperationClass;
      readonly scope: PrivilegeScope;
      readonly stepUpRequired: boolean;
      readonly stepUpMaxAgeMs: number;
    },
    now: number,
  ): Promise<PrivilegeElevationAssessment>;
  /**
   * Assess a PLATFORM-scoped requirement in its own explicit system-scope
   * transaction (the enumerated, counted `transaction:system` exception —
   * the same pattern as the ACTIVE-manifest Phase-A read). Used by the
   * durable decider for platform-scoped operation classes.
   */
  assessPlatform(
    requirement: {
      readonly principalId: string;
      readonly sessionEventId?: string;
      readonly operationClass: PrivilegeOperationClass;
      readonly stepUpRequired: boolean;
      readonly stepUpMaxAgeMs: number;
    },
    now: number,
  ): Promise<PrivilegeElevationAssessment>;
}

/** A minimal, service-facing enforcement seam (PO-1…PO-8 migration). */
export interface PrivilegeEnforcer {
  readonly kind: 'p2-privilege-enforcer';
  /**
   * Assert the principal holds a valid, durable elevation for the named
   * operation. Throws `PrivilegeRequiredError` on any denial; fails closed
   * (throws) on any storage problem — never a silent ALLOW.
   */
  assertElevation(principalId: string, tenantId: string, operationId: string, now: number): Promise<void>;
}

/** Durable privilege-plane failure (any rejection from the elevation substrate). */
export class PrivilegeStoreError extends PrincipalValidationError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'PrivilegeStoreError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A required elevation is missing or invalid (service-enforcement denial). */
export class PrivilegeRequiredError extends PrivilegeStoreError {
  readonly verdict: PrivilegeElevationAssessment['verdict'];
  constructor(verdict: PrivilegeElevationAssessment['verdict'], detail: string) {
    super('PRIVILEGE_REQUIRED', `privileged operation refused (${verdict}): ${detail} (fail-closed).`);
    this.name = 'PrivilegeRequiredError';
    this.verdict = verdict;
  }
}

const FORBIDDEN_FIELD_PATTERN = /(material|secret|token|password|privatekey|credentialmaterial|jwks|jwk)/i;

/** Closed-schema + material-shaped-field refusal (same pattern as S-1/S-8/S-9). */
export function assertElevationDocumentShape(doc: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) {
      throw new PrivilegeStoreError(
        'CLOSED_SCHEMA_VIOLATION',
        `${context}: unknown field "${key}" would be persisted (closed-schema violation, fail-closed).`,
      );
    }
    if (FORBIDDEN_FIELD_PATTERN.test(key)) {
      throw new PrivilegeStoreError(
        'MATERIAL_FIELD_REFUSED',
        `${context}: field "${key}" is material-shaped and must never be persisted (fail-closed).`,
      );
    }
  }
}

/** The closed transition table for elevation status (ACTIVE ⇒ EXPIRED/REVOKED). */
export function isPermittedElevationTransition(from: PrivilegeElevationStatus, to: PrivilegeElevationStatus): boolean {
  if (from === 'ACTIVE') return to === 'REVOKED' || to === 'EXPIRED';
  return false; // REVOKED and EXPIRED are terminal (immutable)
}

/** Deny-early expiry (the single P2 300 s bound, applied uniformly). */
export function isElevationExpired(expiresAt: number, now: number): boolean {
  return now + PRIVILEGE_CLOCK_SKEW_MS >= expiresAt;
}

/** True when a step-up assertion is too old (or future-beyond-skew) to be honored. */
export function isStepUpStale(stepUpAt: number, maxAgeMs: number, now: number): boolean {
  return now - stepUpAt > maxAgeMs || stepUpAt > now + PRIVILEGE_CLOCK_SKEW_MS;
}

/**
 * Whether a plane role is acceptable for an operation class (spec §9.1/§9.3):
 * a standing role matches its own class; `break-glass` (the emergency path)
 * is acceptable for any class it explicitly covers.
 */
export function isPlaneRoleAcceptable(operationClass: PrivilegeOperationClass, planeRole: PrivilegeRole): boolean {
  if (planeRole === 'break-glass') return true;
  return planeRole === operationClass;
}

/** The requirement shape the pure assessment consumes (mirrors `PrivilegeStateAuthority`). */
export interface PrivilegeAssessmentRequirement {
  readonly principalId: string;
  /** The presenting session (session/elevation binding check). */
  readonly sessionEventId?: string;
  readonly operationClass: PrivilegeOperationClass;
  readonly scope: PrivilegeScope;
  readonly stepUpRequired: boolean;
  readonly stepUpMaxAgeMs: number;
}

/**
 * Pure, deterministic elevation-row assessment. `verdict: 'VALID'` is the
 * ONLY non-denying outcome; every other verdict maps to a distinct A-01
 * denial code. Used by the store's in-transaction read AND the durable
 * decider's enforcement re-check (one semantics, two enforcement sites).
 */
export function assessElevationRow(
  row: PrivilegeElevationDoc,
  requirement: PrivilegeAssessmentRequirement,
  now: number,
): PrivilegeElevationAssessment {
  const common = {
    elevationId: row.id,
    operationClass: requirement.operationClass,
    elevationStatus: row.status,
  };
  if (row.principalId !== requirement.principalId) {
    return { ...common, verdict: 'REQUIRED', detail: 'elevation principal does not match the request principal' };
  }
  // A row that does not cover the requested class is irrelevant to this
  // decision (the principal simply holds no elevation for the class).
  if (!Array.isArray(row.operationClasses) || !row.operationClasses.includes(requirement.operationClass)) {
    return { ...common, verdict: 'REQUIRED', detail: 'elevation does not cover the requested operation class' };
  }
  if (row.scope !== requirement.scope) {
    return { ...common, verdict: 'SCOPE_MISMATCH', detail: `elevation scope (${row.scope}) does not match the required scope (${requirement.scope})` };
  }
  if (!isPlaneRoleAcceptable(requirement.operationClass, row.planeRole)) {
    return { ...common, verdict: 'ROLE_MISMATCH', detail: `plane role (${row.planeRole}) is not acceptable for the operation class (${requirement.operationClass})` };
  }
  if (row.status === 'REVOKED') {
    return { ...common, verdict: 'REVOKED', detail: 'elevation was revoked' };
  }
  if (row.status === 'EXPIRED') {
    return { ...common, verdict: 'EXPIRED', detail: 'elevation expired' };
  }
  if (row.status !== 'ACTIVE') {
    return { ...common, verdict: 'REQUIRED', detail: `elevation status (${String(row.status)}) is not ACTIVE` };
  }
  if (isElevationExpired(row.expiresAt, now)) {
    return { ...common, verdict: 'EXPIRED', detail: 'elevation window has passed (deny-early)' };
  }
  if (requirement.stepUpRequired) {
    if (typeof row.stepUpAt !== 'number') {
      return { ...common, verdict: 'STEP_UP_STALE', detail: 'elevation carries no step-up evidence but the operation class requires it' };
    }
    if (isStepUpStale(row.stepUpAt, requirement.stepUpMaxAgeMs, now)) {
      return { ...common, verdict: 'STEP_UP_STALE', detail: 'elevation step-up evidence is stale' };
    }
  }
  if (requirement.sessionEventId !== undefined && row.sessionEventId !== requirement.sessionEventId) {
    return { ...common, verdict: 'SESSION_MISMATCH', detail: 'elevation is bound to a different session' };
  }
  return { ...common, verdict: 'VALID' };
}

/**
 * Fold a set of candidate rows into ONE verdict, preferring the most
 * specific denial (REVOKED > EXPIRED > STEP_UP_STALE > SESSION_MISMATCH >
 * ROLE_MISMATCH > SCOPE_MISMATCH > REQUIRED). Used by the store's scan.
 */
export function foldElevationAssessments(rows: readonly PrivilegeElevationDoc[], requirement: PrivilegeAssessmentRequirement, now: number): PrivilegeElevationAssessment {
  let scopeMismatch: PrivilegeElevationAssessment | undefined;
  let roleMismatch: PrivilegeElevationAssessment | undefined;
  let sessionMismatch: PrivilegeElevationAssessment | undefined;
  let stepUpStale: PrivilegeElevationAssessment | undefined;
  let expired: PrivilegeElevationAssessment | undefined;
  let revoked: PrivilegeElevationAssessment | undefined;
  for (const row of rows) {
    const a = assessElevationRow(row, requirement, now);
    switch (a.verdict) {
      case 'VALID':
        return a;
      case 'REVOKED':
        revoked = a;
        break;
      case 'EXPIRED':
        expired = a;
        break;
      case 'STEP_UP_STALE':
        stepUpStale = a;
        break;
      case 'SESSION_MISMATCH':
        sessionMismatch = a;
        break;
      case 'ROLE_MISMATCH':
        roleMismatch = a;
        break;
      case 'SCOPE_MISMATCH':
        scopeMismatch = a;
        break;
      case 'REQUIRED':
        break;
    }
  }
  return (
    revoked ?? expired ?? stepUpStale ?? sessionMismatch ?? roleMismatch ?? scopeMismatch ??
    { verdict: 'REQUIRED', operationClass: requirement.operationClass }
  );
}
