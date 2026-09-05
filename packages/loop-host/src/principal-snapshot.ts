// T-02 authenticated durable authority carry-through — pure validation core.
//
// This module is the single place that defines what a *verifiable*
// persisted principal is: snapshot construction (fixed fields only, frozen),
// structural validation, freshness assessment, and the pre-dispatch
// authorization decision. It performs no I/O, holds no state, mints no
// authority, and never sees credentials — callers supply an already
// authenticated `AuthenticatedPrincipal` (T-01 boundary) or a persisted
// snapshot, and every function either returns verified evidence or fails
// closed with a deterministic `AuthorityHoldReason`.
//
// The host stays a valet: it calls these pure functions to persist,
// revalidate, and forward authority evidence. Policy (max age, test-method
// admission) is supplied by the caller; the semantics below never change.

import {
  isAuthenticationMethod,
  projectToActor,
  type AuthenticatedPrincipal,
} from '@jataqi/authentication';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import {
  MAX_PRINCIPAL_AGE_MS,
  MAX_PRINCIPAL_CLOCK_SKEW_MS,
  PRINCIPAL_SNAPSHOT_VERSION,
  PrincipalAuthorityError,
  type AuthenticatedPrincipalSnapshot,
  type AuthorityHoldReason,
  type HostedWorkItem,
} from './types.js';

/** Resolved T-02 dispatch policy (no optionals: the service resolves defaults). */
export interface ResolvedPrincipalPolicy {
  /** Maximum snapshot age in ms (verifiedAt freshness horizon). */
  readonly maxAgeMs: number;
  /** When false, DETERMINISTIC_TEST snapshots are refused. */
  readonly allowTestMethod: boolean;
}

/** Outcome of persisted-snapshot assessment. */
export type SnapshotAssessment =
  | { ok: true; snapshot: AuthenticatedPrincipalSnapshot }
  | { ok: false; reason: AuthorityHoldReason; detail: string };

/** Outcome of the pre-dispatch authorization decision. */
export type DispatchAuthorization =
  | { ok: true; principal: AuthenticatedPrincipal; actor: CommercialActor; snapshot: AuthenticatedPrincipalSnapshot }
  | { ok: false; reason: AuthorityHoldReason; detail: string };

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Build the immutable persisted snapshot from an authenticated principal.
 * Picks the six fixed provenance fields plus the version and strips
 * EVERYTHING else (a hostile caller object carrying tokens/secrets/material
 * cannot smuggle them into durable storage through this builder). The
 * result is frozen. Throws PrincipalAuthorityError on malformed input.
 */
export function freezePrincipalSnapshot(principal: AuthenticatedPrincipal): AuthenticatedPrincipalSnapshot {
  if (!principal || typeof principal !== 'object') {
    throw new PrincipalAuthorityError('Authenticated enqueue requires an authenticated principal (fail-closed).');
  }
  if (!isNonBlankString(principal.id)) {
    throw new PrincipalAuthorityError('Principal id is missing or blank (fail-closed).');
  }
  if (!isNonBlankString(principal.tenantId)) {
    throw new PrincipalAuthorityError('Principal tenant id is missing or blank (fail-closed).');
  }
  if (!Array.isArray(principal.roles) || principal.roles.length === 0) {
    throw new PrincipalAuthorityError('Principal carries no verified roles (fail-closed).');
  }
  for (const role of principal.roles) {
    if (!isNonBlankString(role)) {
      throw new PrincipalAuthorityError('Principal carries a blank role entry (fail-closed).');
    }
  }
  if (!isAuthenticationMethod(principal.authenticationMethod)) {
    throw new PrincipalAuthorityError('Principal authentication method is not recognized (fail-closed).');
  }
  if (!isValidTimestamp(principal.verifiedAt)) {
    throw new PrincipalAuthorityError('Principal verifiedAt is malformed (fail-closed).');
  }
  if (!isNonBlankString(principal.authenticationEventId)) {
    throw new PrincipalAuthorityError('Principal authentication event id is missing or blank (fail-closed).');
  }
  const roles = Object.freeze([...principal.roles]);
  return Object.freeze({
    version: PRINCIPAL_SNAPSHOT_VERSION,
    principalId: principal.id,
    tenantId: principal.tenantId,
    roles,
    authenticationMethod: principal.authenticationMethod,
    verifiedAt: principal.verifiedAt,
    authenticationEventId: principal.authenticationEventId,
  });
}

/**
 * Deterministic serialization of a snapshot: fixed key order, roles in
 * verified order. Two snapshots built from the same principal serialize
 * identically; suitable for evidence comparison in tests and audits.
 */
export function serializePrincipalSnapshot(snapshot: AuthenticatedPrincipalSnapshot): string {
  return JSON.stringify({
    version: snapshot.version,
    principalId: snapshot.principalId,
    tenantId: snapshot.tenantId,
    roles: [...snapshot.roles],
    authenticationMethod: snapshot.authenticationMethod,
    verifiedAt: snapshot.verifiedAt,
    authenticationEventId: snapshot.authenticationEventId,
  });
}

/**
 * Reconstruct the executable `AuthenticatedPrincipal` view from a verified
 * snapshot. Only ever called with a snapshot that passed assessment; the
 * version tag is dropped because it is storage metadata, not identity.
 */
export function principalFromSnapshot(snapshot: AuthenticatedPrincipalSnapshot): AuthenticatedPrincipal {
  return {
    id: snapshot.principalId,
    tenantId: snapshot.tenantId,
    roles: [...snapshot.roles],
    authenticationMethod: snapshot.authenticationMethod,
    verifiedAt: snapshot.verifiedAt,
    authenticationEventId: snapshot.authenticationEventId,
  };
}

/**
 * T-01 actor-derivation rule, enforced at the durable boundary: the actor
 * MUST carry the principal's id and tenant and a narrowed-or-equal role
 * subset. Widening, cross-tenant projection, and identity substitution all
 * throw PrincipalAuthorityError (fail-closed).
 */
export function assertActorDerivedFromPrincipal(actor: CommercialActor, principal: AuthenticatedPrincipal): void {
  if (!actor || !isNonBlankString(actor.id) || !isNonBlankString(actor.tenantId)) {
    throw new PrincipalAuthorityError('A tenant-bound actor is required alongside the principal (fail-closed).');
  }
  if (actor.id !== principal.id) {
    throw new PrincipalAuthorityError('Actor id does not match the authenticated principal id (fail-closed).');
  }
  if (actor.tenantId !== principal.tenantId) {
    throw new PrincipalAuthorityError('Actor tenant does not match the authenticated principal tenant (fail-closed).');
  }
  if (!Array.isArray(actor.roles) || actor.roles.length === 0) {
    throw new PrincipalAuthorityError('Actor carries no roles (fail-closed).');
  }
  for (const role of actor.roles) {
    if (!principal.roles.includes(role)) {
      throw new PrincipalAuthorityError(
        `Actor role "${String(role)}" is not in the authenticated principal's verified role set (fail-closed).`,
      );
    }
  }
}

/**
 * Validate a resolved max-age policy value. The service constructor applies
 * this; assessment re-checks defensively so a corrupt policy can never
 * silently widen the freshness horizon.
 */
export function assertValidMaxAgeMs(maxAgeMs: number): void {
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > MAX_PRINCIPAL_AGE_MS) {
    throw new PrincipalAuthorityError(
      `maxPrincipalAgeMs must be an integer between 0 and ${MAX_PRINCIPAL_AGE_MS} ms (fail-closed).`,
    );
  }
}

/**
 * Assess a persisted snapshot value: presence, shape, version, recognized
 * method, and freshness. Never throws for evidence problems (those map to
 * deterministic hold reasons); throws only for caller bugs (unusable clock
 * or policy), which must also fail closed upstream.
 */
export function assessPersistedSnapshot(
  value: unknown,
  now: number,
  maxAgeMs: number,
): SnapshotAssessment {
  if (!isValidTimestamp(now)) {
    throw new PrincipalAuthorityError('Freshness cannot be assessed with an unusable clock (fail-closed).');
  }
  assertValidMaxAgeMs(maxAgeMs);
  if (value === undefined || value === null) {
    return { ok: false, reason: 'PRINCIPAL_ABSENT', detail: 'Work item carries no authenticated principal snapshot.' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'PRINCIPAL_MALFORMED', detail: 'Principal snapshot is not a record.' };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== PRINCIPAL_SNAPSHOT_VERSION) {
    return {
      ok: false,
      reason: 'PRINCIPAL_VERSION',
      detail: `Principal snapshot version ${String(candidate.version)} is not supported (expected ${PRINCIPAL_SNAPSHOT_VERSION}).`,
    };
  }
  if (
    !isNonBlankString(candidate.principalId) ||
    !isNonBlankString(candidate.tenantId) ||
    !Array.isArray(candidate.roles) ||
    candidate.roles.length === 0 ||
    !(candidate.roles as unknown[]).every(isNonBlankString) ||
    !isAuthenticationMethod(candidate.authenticationMethod) ||
    !isValidTimestamp(candidate.verifiedAt) ||
    !isNonBlankString(candidate.authenticationEventId)
  ) {
    return { ok: false, reason: 'PRINCIPAL_MALFORMED', detail: 'Principal snapshot shape or provenance fields are invalid.' };
  }
  const verifiedAt = candidate.verifiedAt as number;
  if (verifiedAt > now + MAX_PRINCIPAL_CLOCK_SKEW_MS) {
    return {
      ok: false,
      reason: 'PRINCIPAL_SKEW',
      detail: `Principal verifiedAt is ${verifiedAt - now}ms in the future, beyond the ${MAX_PRINCIPAL_CLOCK_SKEW_MS}ms skew tolerance; freshness is unverifiable.`,
    };
  }
  // Minor future drift (within tolerance) counts as freshly verified (age
  // 0) so small clock disagreement cannot strand work; anything older than
  // the horizon is stale. The exact boundary (age == maxAgeMs) is fresh.
  const age = Math.max(0, now - verifiedAt);
  if (age > maxAgeMs) {
    return {
      ok: false,
      reason: 'PRINCIPAL_STALE',
      detail: `Principal snapshot is ${age}ms old, beyond the ${maxAgeMs}ms maximum age; re-authentication is required.`,
    };
  }
  const snapshot: AuthenticatedPrincipalSnapshot = {
    version: PRINCIPAL_SNAPSHOT_VERSION,
    principalId: candidate.principalId as string,
    tenantId: candidate.tenantId as string,
    roles: Object.freeze([...(candidate.roles as AuthenticatedPrincipalSnapshot['roles'])]),
    authenticationMethod: candidate.authenticationMethod,
    verifiedAt,
    authenticationEventId: candidate.authenticationEventId as string,
  };
  return { ok: true, snapshot };
}

/**
 * Pre-dispatch authorization decision for one leased work item. Verifies,
 * in order: snapshot presence/shape/version/freshness, test-method policy,
 * the triple tenant match (snapshot == work item == actor), the
 * principal/actor identity match, and role non-expansion (via T-01's own
 * `projectToActor`, so the narrowing rule cannot drift). Returns the
 * executable principal + narrowed actor, or a deterministic hold reason.
 * No execution may follow an `ok: false` outcome.
 */
export function authorizeDispatch(
  item: HostedWorkItem,
  now: number,
  policy: ResolvedPrincipalPolicy,
): DispatchAuthorization {
  const assessed = assessPersistedSnapshot(item.principal, now, policy.maxAgeMs);
  if (!assessed.ok) return assessed;
  const snapshot = assessed.snapshot;
  if (!policy.allowTestMethod && snapshot.authenticationMethod === 'DETERMINISTIC_TEST') {
    return {
      ok: false,
      reason: 'PRINCIPAL_TEST_METHOD',
      detail: 'Test authentication is not admitted under this host principal policy; production authority is required.',
    };
  }
  // The persisted actor is storage evidence, not a trusted object: a
  // tampered or corrupt row with a missing/malformed actor must HOLD
  // (fail closed), never throw into the substrate-failure path (which
  // would reclaim and redispatch it forever).
  const persistedActor = item.actor as unknown;
  if (
    !persistedActor ||
    typeof persistedActor !== 'object' ||
    Array.isArray(persistedActor) ||
    !Array.isArray((persistedActor as { roles?: unknown }).roles)
  ) {
    return {
      ok: false,
      reason: 'PRINCIPAL_MISMATCH',
      detail: 'Persisted actor is missing or malformed; it cannot be matched to the verified principal (fail-closed).',
    };
  }
  const actorRecord = persistedActor as Pick<CommercialActor, 'id' | 'tenantId' | 'roles'>;
  if (snapshot.tenantId !== item.tenantId || actorRecord.tenantId !== snapshot.tenantId) {
    return {
      ok: false,
      reason: 'PRINCIPAL_MISMATCH',
      detail: 'Principal snapshot tenant, work-item tenant, and actor tenant do not match (fail-closed).',
    };
  }
  if (actorRecord.id !== snapshot.principalId) {
    return {
      ok: false,
      reason: 'PRINCIPAL_MISMATCH',
      detail: 'Persisted actor id does not match the verified principal id (fail-closed).',
    };
  }
  const principal = principalFromSnapshot(snapshot);
  try {
    const actor = projectToActor(principal, actorRecord.roles);
    return { ok: true, principal, actor, snapshot };
  } catch {
    return {
      ok: false,
      reason: 'PRINCIPAL_ROLE_ESCALATION',
      detail: 'Persisted actor roles exceed the verified principal role set (fail-closed).',
    };
  }
}

/** Audit-trail provenance projection of a snapshot (never secrets). */
export function provenanceOf(snapshot: AuthenticatedPrincipalSnapshot): {
  principalMethod: string;
  principalEventId: string;
  principalVerifiedAt: number;
  principalId: string;
} {
  return {
    principalMethod: snapshot.authenticationMethod,
    principalEventId: snapshot.authenticationEventId,
    principalVerifiedAt: snapshot.verifiedAt,
    principalId: snapshot.principalId,
  };
}
