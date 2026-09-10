// R2 — durable authentication-event registry (S-8).
//
// Every security-sensitive authentication success is recorded here BEFORE
// the verified principal is returned (see `PrincipalBoundary`). The row is
// the durable session: dispatch and authorization re-validate its status
// (ACTIVE / REVOKED / EXPIRED) on every use, so revocation is effective
// across processes immediately, without restart.
//
// Provenance only: event id, principal, tenant, method, timestamps, and
// revocation metadata. NEVER credential material, tokens, or secrets —
// the closed field allow-list rejects anything else at the repository
// layer, and revocation flips preserve history (rows are never deleted).

import { createHash, randomUUID } from 'node:crypto';
import type { CommercialActorRole } from '@jataqi/commercial-control-plane';
import { StorageModule, type ICollection, type SecurityCollectionSource, type StorageWriteScope } from '@jataqi/storage';
import { PrincipalValidationError, isAuthenticationMethod, isCommercialActorRole, type AuthenticationMethod } from './types.js';
import { IDENTITY_EVENTS_COLLECTION, type IdentityEventDoc } from './identity-types.js';

/** R2 S-8 collection: durable authentication events (sessions). */
export const AUTHENTICATION_EVENTS_COLLECTION = 'authentication.events';

/** Default session lifetime (24h). Mirrors T-02 snapshot freshness. */
export const DEFAULT_SESSION_LIFETIME_MS = 86_400_000;

/** Upper bound for a configured session lifetime (30 days, T-02 precedent). */
export const MAX_SESSION_LIFETIME_MS = 2_592_000_000;

/**
 * R2 clock-skew bound (5 minutes, T-02 precedent). Durable-path expiry
 * comparisons are conservative (deny-early): a session is expired when
 * `now + SKEW >= expiresAt`.
 */
export const AUTH_SESSION_CLOCK_SKEW_MS = 300_000;

export type AuthenticationEventStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface AuthenticationEventDoc {
  /** The authentication event id (durable session identity). */
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly method: AuthenticationMethod;
  readonly verifiedAt: number;
  readonly expiresAt: number;
  readonly status: AuthenticationEventStatus;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * P2-S2: SHA-256 hex fingerprint of the live 256-bit opaque session token
   * (one-way — token MATERIAL is never persisted). Absent on pre-token rows
   * (spec §21.2 migration coexistence: the bearer remains the original
   * credential path and status re-validation is unchanged).
   */
  readonly sessionFingerprint?: string;
  /**
   * P2-S2: the role set ASSERTED at mint (a copy of the verified principal's
   * roles). This is an assertion, not authority: every decision re-narrows
   * it against the durable ACTIVE role assignments inside its own
   * transaction (P2-S1 Phase-B stage 2.5), so no effective role set is ever
   * cached here across decisions.
   */
  readonly roles?: readonly CommercialActorRole[];
  /** P2-S2: rotations performed on this event (0 at mint; bounded). */
  readonly rotationCount?: number;
  /** P2-S2: ms timestamp of the last rotation (absent until rotated). */
  readonly rotatedAt?: number;
  /**
   * P2-S2: the fingerprint superseded by the last rotation (rotation-chain
   * evidence; the superseded token is dead — it references nothing live).
   */
  readonly previousFingerprint?: string;
  /**
   * P2-S2: session binding — the OIDC issuer when the session was minted
   * from an OIDC authentication (verification re-checks the binding).
   */
  readonly issuer?: string;
}

/** Durable-store failure: any rejection from the session/token substrate. */
export class AuthenticationStoreError extends PrincipalValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationStoreError';
  }
}

const ALLOWED_EVENT_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'tenantId',
  'principalId',
  'method',
  'verifiedAt',
  'expiresAt',
  'status',
  'revokedAt',
  'revocationReason',
  'createdAt',
  'updatedAt',
  // P2-S2 session-token lifecycle (fingerprints/bindings only — no material;
  // none of these names is material-shaped under FORBIDDEN_FIELD_PATTERN).
  'sessionFingerprint',
  'roles',
  'rotationCount',
  'rotatedAt',
  'previousFingerprint',
  'issuer',
]);

// ---------------------------------------------------------------------------
// P2-S2 — durable session/token lifecycle (spec §6).
// ---------------------------------------------------------------------------

/** P2-S2: SHA-256 hex shape (64 lowercase hex chars). */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * P2-S2: the concurrent-session policy (spec §6.1). `maxActiveSessions` live
 * sessions are allowed per (principal, tenant); on exceed the store either
 * refuses the new session (`refuse-new`) or CAS-revokes the oldest live one
 * (`revoke-oldest`) — it never silently accumulates.
 */
export interface SessionConcurrencyPolicy {
  readonly maxActiveSessions: number;
  readonly onExceed: 'refuse-new' | 'revoke-oldest';
}

/** P2-S2: the spec default — max 3 active sessions, refuse new on exceed. */
export const DEFAULT_SESSION_CONCURRENCY_POLICY: SessionConcurrencyPolicy = Object.freeze({
  maxActiveSessions: 3,
  onExceed: 'refuse-new',
});

/** P2-S2: the closed session-token failure code set. */
export type SessionTokenFailureCode =
  | 'SESSION_TOKEN_MALFORMED'
  | 'SESSION_TOKEN_UNKNOWN'
  | 'SESSION_TOKEN_REVOKED'
  | 'SESSION_TOKEN_EXPIRED'
  | 'SESSION_TOKEN_TENANT_MISMATCH'
  | 'SESSION_IDENTITY_INACTIVE'
  | 'SESSION_CONCURRENCY_REFUSED'
  | 'SESSION_ROTATION_LIMIT';

/** P2-S2: a closed, deterministic session/token lifecycle rejection. */
export class SessionTokenError extends AuthenticationStoreError {
  readonly code: SessionTokenFailureCode;
  constructor(code: SessionTokenFailureCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'SessionTokenError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function assertValidConcurrencyPolicy(policy: SessionConcurrencyPolicy, context: string): void {
  if (!policy || typeof policy !== 'object') {
    throw new AuthenticationStoreError(`${context}: a session policy must be an object (fail-closed).`);
  }
  if (!Number.isInteger(policy.maxActiveSessions) || policy.maxActiveSessions < 1) {
    throw new AuthenticationStoreError(
      `${context}: maxActiveSessions must be an integer >= 1 (fail-closed).`,
    );
  }
  if (policy.onExceed !== 'refuse-new' && policy.onExceed !== 'revoke-oldest') {
    throw new AuthenticationStoreError(
      `${context}: onExceed must be 'refuse-new' or 'revoke-oldest' (fail-closed).`,
    );
  }
}

function assertUsableClock(now: number, context: string): void {
  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
    throw new AuthenticationStoreError(`${context}: an unusable clock cannot mint or assess sessions (fail-closed).`);
  }
}

const FORBIDDEN_FIELD_PATTERN = /(material|secret|token|password|privatekey|credentialmaterial)/i;

/**
 * Reject any document carrying unknown fields or material-shaped fields.
 * Defense in depth: even a compromised caller cannot smuggle a secret
 * into durable session state through this repository.
 */
export function assertSessionDocumentShape(doc: Record<string, unknown>, context: string): void {
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_EVENT_FIELDS.has(key)) {
      throw new AuthenticationStoreError(
        `${context}: unknown field "${key}" would be persisted (closed-schema violation, fail-closed).`,
      );
    }
    if (FORBIDDEN_FIELD_PATTERN.test(key)) {
      throw new AuthenticationStoreError(
        `${context}: field "${key}" is material-shaped and must never be persisted (fail-closed).`,
      );
    }
  }
}

export function assertValidSessionLifetimeMs(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_SESSION_LIFETIME_MS) {
    throw new PrincipalValidationError(
      `sessionLifetimeMs must be an integer between 1 and ${MAX_SESSION_LIFETIME_MS} ms (fail-closed).`,
    );
  }
}

/** Conservative expiry: deny-early by the skew bound (fail closed). */
export function isSessionExpired(expiresAt: number, now: number): boolean {
  return now + AUTH_SESSION_CLOCK_SKEW_MS >= expiresAt;
}

export type SessionAssessment =
  | { readonly active: true; readonly event: AuthenticationEventDoc }
  | { readonly active: false; readonly status: 'REVOKED' | 'EXPIRED' | 'UNKNOWN'; readonly detail: string };

/**
 * Assess a raw session row WITHOUT throwing for evidence problems
 * (mirrors `assessPersistedSnapshot` discipline): malformed rows,
 * revoked rows, expired rows, and absent rows all map to deterministic
 * non-active outcomes. Only caller bugs (unusable clock) throw.
 */
export function assessSessionRow(value: unknown, now: number): SessionAssessment {
  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
    throw new AuthenticationStoreError('Session status cannot be assessed with an unusable clock (fail-closed).');
  }
  if (value === undefined || value === null) {
    return { active: false, status: 'UNKNOWN', detail: 'No durable authentication event exists for this event id (re-authentication required).' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { active: false, status: 'UNKNOWN', detail: 'Durable authentication event is not a record (fail-closed).' };
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' || row.id.length === 0 ||
    typeof row.tenantId !== 'string' || row.tenantId.length === 0 ||
    typeof row.principalId !== 'string' || row.principalId.length === 0 ||
    !isAuthenticationMethod(row.method) ||
    typeof row.verifiedAt !== 'number' || !Number.isFinite(row.verifiedAt) || row.verifiedAt < 0 ||
    typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) || row.expiresAt <= 0 ||
    (row.status !== 'ACTIVE' && row.status !== 'REVOKED' && row.status !== 'EXPIRED')
  ) {
    return { active: false, status: 'UNKNOWN', detail: 'Durable authentication event shape is invalid (fail-closed).' };
  }
  // P2-S2: the session-token lifecycle fields are optional (pre-token rows
  // carry none of them), but when present they must be well-formed —
  // otherwise the row is evidence-unusable (fail-closed, never trusted).
  if (
    (row.sessionFingerprint !== undefined &&
      (typeof row.sessionFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(row.sessionFingerprint))) ||
    (row.previousFingerprint !== undefined &&
      (typeof row.previousFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(row.previousFingerprint))) ||
    (row.roles !== undefined &&
      (!Array.isArray(row.roles) ||
        row.roles.length === 0 ||
        !(row.roles as readonly unknown[]).every(isCommercialActorRole))) ||
    (row.rotationCount !== undefined &&
      (typeof row.rotationCount !== 'number' ||
        !Number.isInteger(row.rotationCount) ||
        (row.rotationCount as number) < 0)) ||
    (row.rotatedAt !== undefined &&
      (typeof row.rotatedAt !== 'number' || !Number.isFinite(row.rotatedAt) || (row.rotatedAt as number) < 0)) ||
    (row.issuer !== undefined && (typeof row.issuer !== 'string' || (row.issuer as string).trim().length === 0))
  ) {
    return { active: false, status: 'UNKNOWN', detail: 'Durable authentication event carries malformed session-token lifecycle fields (fail-closed).' };
  }
  const event = value as AuthenticationEventDoc;
  if (event.status === 'REVOKED') {
    return {
      active: false,
      status: 'REVOKED',
      detail: `Authentication event was revoked${event.revokedAt !== undefined ? ` at ${event.revokedAt}` : ''}${event.revocationReason ? `: ${event.revocationReason}` : ''}.`,
    };
  }
  if (event.status === 'EXPIRED' || isSessionExpired(event.expiresAt, now)) {
    return { active: false, status: 'EXPIRED', detail: 'Authentication event is expired (re-authentication required).' };
  }
  return { active: true, event };
}

export interface RecordAuthenticationEventInput {
  readonly eventId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly method: AuthenticationMethod;
  readonly verifiedAt: number;
  readonly expiresAt: number;
  /**
   * P2-S2: the session-token binding minted for this event. When absent the
   * row is a pre-token session (spec §21.2 coexistence): the bearer remains
   * the original credential path and status re-validation is unchanged.
   */
  readonly sessionToken?: {
    /** SHA-256 hex fingerprint of the 256-bit material (one-way). */
    readonly fingerprint: string;
    /** The role set asserted at mint (narrowed at every decision). */
    readonly roles: readonly CommercialActorRole[];
    /** The OIDC issuer when minted from an OIDC authentication. */
    readonly issuer?: string;
  };
}

/** P2-S2: options for `recordEvent` (all optional; legacy behavior preserved). */
export interface RecordAuthenticationEventOptions {
  /**
   * The concurrent-session policy to enforce atomically with the insert.
   * When absent, no policy is applied (exact R2/P1/P2-S1 behavior).
   */
  readonly sessionPolicy?: SessionConcurrencyPolicy;
}

/** P2-S2: input for `rotateSessionToken` (all fields required). */
export interface RotateSessionTokenInput {
  readonly eventId: string;
  readonly tenantId: string;
  /** The fingerprint of the currently-live token (must match the row). */
  readonly expectedFingerprint: string;
  /** The fingerprint of the replacement token (must differ). */
  readonly newFingerprint: string;
  /**
   * Maximum rotations permitted per event; reaching it refuses further
   * rotation (full re-authentication required) — rotation loops cannot be
   * used as an unbounded session-extension mechanism.
   */
  readonly maxRotations: number;
}

/**
 * R2 S-8 repository. All operations run inside explicit tenant-scoped
 * transactions against a transactional driver; construction over a
 * non-transactional source throws (fail closed — memory is never
 * authoritative session state).
 */
export class AuthenticationEventStore {
  private constructor(
    private readonly source: SecurityCollectionSource,
    private readonly events: ICollection<AuthenticationEventDoc>,
  ) {}

  static async open(source: SecurityCollectionSource): Promise<AuthenticationEventStore> {
    if (!source.supportsTransactions()) {
      throw new AuthenticationStoreError(
        'AuthenticationEventStore requires a transactional storage driver (PostgreSQL); ' +
          'a non-transactional store is never authoritative session state (fail-closed).',
      );
    }
    const driver = source.getDriver();
    if (typeof driver.ensureIndex === 'function') {
      await driver.ensureIndex(AUTHENTICATION_EVENTS_COLLECTION, {
        name: 'by_principal',
        keys: ['principalId'],
        includeTenant: true,
      });
      await driver.ensureIndex(AUTHENTICATION_EVENTS_COLLECTION, {
        name: 'by_status',
        keys: ['status'],
        includeTenant: true,
      });
      // P2-S2: session-token verification resolves fingerprint → row.
      await driver.ensureIndex(AUTHENTICATION_EVENTS_COLLECTION, {
        name: 'by_session_fingerprint',
        keys: ['sessionFingerprint'],
        includeTenant: true,
      });
    }
    const events = await source.collection<AuthenticationEventDoc>(AUTHENTICATION_EVENTS_COLLECTION);
    return new AuthenticationEventStore(source, events);
  }

  /** The resolved collection (diagnostics; all access stays tenant-scoped). */
  get collectionName(): string {
    return AUTHENTICATION_EVENTS_COLLECTION;
  }

  private async inTenant<T>(tenantId: string, fn: (events: ICollection<AuthenticationEventDoc>, scope: StorageWriteScope) => Promise<T>): Promise<T> {
    StorageModule.validateTenantId(tenantId);
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) {
        throw new AuthenticationStoreError(
          'Authentication event write requires an atomic transaction (fail-closed).',
        );
      }
      const events = await scope.collection<AuthenticationEventDoc>(AUTHENTICATION_EVENTS_COLLECTION);
      return fn(events, scope);
    }, { tenantId });
  }

  /**
   * Durably record one authentication event (insert-once). A duplicate
   * event id is rejected outright — event ids are minted unique per
   * authentication, so a collision is an anomaly, never an update.
   *
   * P2-S2: when `options.sessionPolicy` is supplied, the concurrent-session
   * policy is enforced atomically with the insert in the SAME tenant
   * transaction (count live sessions for the principal; refuse or
   * CAS-revoke-oldest). Every recording additionally appends its
   * SESSION_CREATED audit event in the same transaction — there is no
   * unaudited session (spec §13.2).
   */
  async recordEvent(
    input: RecordAuthenticationEventInput,
    now: number,
    options: RecordAuthenticationEventOptions = {},
  ): Promise<AuthenticationEventDoc> {
    if (!input || typeof input !== 'object') {
      throw new AuthenticationStoreError('recordEvent requires an event input (fail-closed).');
    }
    if (typeof input.eventId !== 'string' || input.eventId.trim().length === 0) {
      throw new AuthenticationStoreError('recordEvent requires a non-empty event id (fail-closed).');
    }
    StorageModule.validateTenantId(input.tenantId);
    if (typeof input.principalId !== 'string' || input.principalId.trim().length === 0) {
      throw new AuthenticationStoreError('recordEvent requires a non-empty principal id (fail-closed).');
    }
    if (!isAuthenticationMethod(input.method)) {
      throw new AuthenticationStoreError('recordEvent requires a recognized authentication method (fail-closed).');
    }
    if (typeof input.verifiedAt !== 'number' || !Number.isFinite(input.verifiedAt) || input.verifiedAt < 0) {
      throw new AuthenticationStoreError('recordEvent requires a valid verifiedAt timestamp (fail-closed).');
    }
    if (typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt) || input.expiresAt <= input.verifiedAt) {
      throw new AuthenticationStoreError('recordEvent requires expiresAt strictly after verifiedAt (fail-closed).');
    }
    assertUsableClock(now, 'recordEvent');
    if (options.sessionPolicy !== undefined) {
      assertValidConcurrencyPolicy(options.sessionPolicy, 'recordEvent');
    }
    // P2-S2 session-token binding validation (fail-closed caller bugs).
    if (input.sessionToken !== undefined) {
      const binding = input.sessionToken;
      if (typeof binding.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(binding.fingerprint)) {
        throw new AuthenticationStoreError('recordEvent requires a 64-hex session-token fingerprint when binding a token (fail-closed).');
      }
      if (!Array.isArray(binding.roles) || binding.roles.length === 0 || !binding.roles.every(isCommercialActorRole)) {
        throw new AuthenticationStoreError('recordEvent requires a non-empty recognized asserted role set when binding a token (fail-closed).');
      }
      if (binding.roles.includes('system')) {
        throw new AuthenticationStoreError(
          'recordEvent: role "system" denotes a kernel-internal actor and can never be asserted on a session-token row (fail-closed).',
        );
      }
      if (binding.issuer !== undefined && (typeof binding.issuer !== 'string' || binding.issuer.trim().length === 0)) {
        throw new AuthenticationStoreError('recordEvent requires a non-blank issuer when one is bound (fail-closed).');
      }
    }
    const doc: AuthenticationEventDoc = {
      id: input.eventId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      method: input.method,
      verifiedAt: input.verifiedAt,
      expiresAt: input.expiresAt,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      ...(input.sessionToken !== undefined
        ? {
            sessionFingerprint: input.sessionToken.fingerprint,
            roles: [...input.sessionToken.roles],
            rotationCount: 0,
            ...(input.sessionToken.issuer !== undefined ? { issuer: input.sessionToken.issuer } : {}),
          }
        : {}),
    };
    assertSessionDocumentShape(doc as unknown as Record<string, unknown>, 'recordEvent');
    const policy = options.sessionPolicy;
    return this.inTenant(input.tenantId, async (events, scope) => {
      // P2-S2 concurrent-session policy (same transaction as the insert —
      // two concurrent recordings cannot both slip under the cap and then
      // both commit: the second committer's count includes the first).
      if (policy !== undefined) {
        const active = await events.query({
          where: (row) => row.principalId === input.principalId && row.status === 'ACTIVE',
        });
        const live = active.filter((row) => !isSessionExpired(row.expiresAt, now));
        if (live.length >= policy.maxActiveSessions) {
          if (policy.onExceed === 'refuse-new') {
            throw new SessionTokenError(
              'SESSION_CONCURRENCY_REFUSED',
              `principal "${input.principalId}" already holds ${live.length} live session(s) (max ${policy.maxActiveSessions}); ` +
                'the new session is refused — authenticate after revoking or expiring one (fail-closed).',
            );
          }
          // revoke-oldest: the oldest live session (by verifiedAt, then
          // createdAt, then id for determinism) is CAS-revoked in this same
          // transaction; a lost race fails the whole recording (fail-closed,
          // never a half-applied policy).
          const oldest = [...live].sort((a, b) =>
            a.verifiedAt !== b.verifiedAt
              ? a.verifiedAt - b.verifiedAt
              : a.createdAt !== b.createdAt
                ? a.createdAt - b.createdAt
                : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          )[0]!;
          const revoked = await events.cas(
            oldest.id,
            (cur) => !!cur && cur.status === 'ACTIVE' && cur.principalId === input.principalId,
            (cur) => ({
              ...cur,
              status: 'REVOKED' as const,
              revokedAt: now,
              revocationReason: 'concurrent-session-policy: revoke-oldest',
              updatedAt: now,
            }),
          );
          if (!revoked.ok) {
            throw new AuthenticationStoreError(
              'recordEvent: the concurrent-session revoke-oldest lost a race; refusing the new session (fail-closed — retry).',
            );
          }
          await this.appendSessionEventInTx(scope, {
            id: randomUUID(),
            at: now,
            tenantId: input.tenantId,
            kind: 'SESSION_REVOKED',
            principalId: input.principalId,
            resource: AUTHENTICATION_EVENTS_COLLECTION,
            authority: { method: oldest.method, authenticationEventId: oldest.id },
            result: 'REVOKED',
            detail: 'concurrent-session-policy: revoke-oldest',
          });
        }
      }
      const res = await events.cas(doc.id, (cur) => cur === undefined, () => ({ ...doc }));
      if (!res.ok) {
        throw new AuthenticationStoreError(
          `Authentication event "${doc.id}" is already recorded; event ids are never re-recorded (fail-closed).`,
        );
      }
      await this.appendSessionEventInTx(scope, {
        id: randomUUID(),
        at: now,
        tenantId: input.tenantId,
        kind: 'SESSION_CREATED',
        principalId: input.principalId,
        resource: AUTHENTICATION_EVENTS_COLLECTION,
        authority: { method: input.method, authenticationEventId: input.eventId },
        result: 'ACTIVE',
        detail:
          input.sessionToken !== undefined
            ? `session-token minted (fingerprint=${input.sessionToken.fingerprint})`
            : 'pre-token session (migration coexistence; bearer = original credential path)',
      });
      return { ...(res.doc as AuthenticationEventDoc) };
    });
  }

  /** Tenant-scoped read of one event row (RLS-enforced at the database). */
  async getEvent(eventId: string, tenantId: string): Promise<AuthenticationEventDoc | undefined> {
    if (typeof eventId !== 'string' || eventId.length === 0) return undefined;
    return this.inTenant(tenantId, async (events) => {
      const row = await events.get(eventId);
      return row ? { ...row } : undefined;
    });
  }

  /**
   * Assess whether a session is ACTIVE. Read-only: expiry is evaluated
   * on read (conservative skew); no flip is performed here.
   */
  async assertActive(eventId: string, tenantId: string, now: number): Promise<SessionAssessment> {
    const row = await this.getEvent(eventId, tenantId);
    if (row && row.tenantId !== tenantId) {
      return { active: false, status: 'UNKNOWN', detail: 'Authentication event tenant does not match the active tenant (fail-closed).' };
    }
    return assessSessionRow(row, now);
  }

  /**
   * P2-S2: append one session-lifecycle audit event (insert-once) inside the
   * caller's transaction — the state change it records and the event commit
   * atomically (an audit-write failure fails the operation: no unaudited
   * session-lifecycle transition, spec §13.2). Events carry fingerprints and
   * reasons only — never token material.
   */
  private async appendSessionEventInTx(scope: StorageWriteScope, event: IdentityEventDoc): Promise<void> {
    const events = await scope.collection<IdentityEventDoc>(IDENTITY_EVENTS_COLLECTION);
    const res = await events.cas(event.id, (cur) => cur === undefined, () => ({ ...event }));
    if (!res.ok) {
      throw new AuthenticationStoreError(
        `session audit event "${event.id}" is already recorded (fail-closed — the lifecycle transition is refused with it).`,
      );
    }
  }

  /**
   * Revoke one event (ACTIVE → REVOKED, CAS-guarded). Idempotent:
   * re-revoking returns the current row. Unknown ids throw (no silent
   * success); EXPIRED rows are left EXPIRED (terminal either way).
   *
   * P2-S2: token revocation IS row revocation (single source of truth — no
   * separate token-state store): revoking the row kills every bearer
   * referencing it. A flip appends SESSION_REVOKED in the same transaction;
   * an idempotent re-revoke emits nothing further (exactly one revocation
   * record per event).
   */
  async revokeEvent(
    eventId: string,
    tenantId: string,
    reason: string,
    now: number,
  ): Promise<AuthenticationEventDoc> {
    if (typeof eventId !== 'string' || eventId.length === 0) {
      throw new AuthenticationStoreError('revokeEvent requires an event id (fail-closed).');
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new AuthenticationStoreError('revokeEvent requires a revocation reason (fail-closed).');
    }
    assertUsableClock(now, 'revokeEvent');
    return this.inTenant(tenantId, async (events, scope) => {
      const res = await events.cas(
        eventId,
        (cur) => {
          if (!cur) {
            throw new AuthenticationStoreError(`Authentication event "${eventId}" does not exist (fail-closed).`);
          }
          if (cur.tenantId !== tenantId) {
            throw new AuthenticationStoreError('Cross-tenant session revocation is refused (fail-closed).');
          }
          return cur.status === 'ACTIVE';
        },
        (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: reason.trim(), updatedAt: now }),
      );
      if (!res.ok) {
        const current = await events.get(eventId);
        if (!current) {
          throw new AuthenticationStoreError(`Authentication event "${eventId}" does not exist (fail-closed).`);
        }
        return { ...current };
      }
      const revoked = res.doc as AuthenticationEventDoc;
      await this.appendSessionEventInTx(scope, {
        id: randomUUID(),
        at: now,
        tenantId,
        kind: 'SESSION_REVOKED',
        principalId: revoked.principalId,
        resource: AUTHENTICATION_EVENTS_COLLECTION,
        authority: { method: revoked.method, authenticationEventId: revoked.id },
        result: 'REVOKED',
        detail: reason.trim(),
      });
      return { ...revoked };
    });
  }

  /**
   * Explicitly flip a past-expiry ACTIVE row to EXPIRED (maintenance /
   * GC attribution). Read paths do NOT depend on this flip — expiry is
   * evaluated on read — so this is evidence hygiene, not enforcement.
   *
   * P2-S2: a flip appends SESSION_EXPIRED in the same transaction; a
   * no-op (already terminal, still live, unknown, or foreign-tenant id)
   * emits nothing and returns the current row (or undefined).
   */
  async markExpired(eventId: string, tenantId: string, now: number): Promise<AuthenticationEventDoc | undefined> {
    assertUsableClock(now, 'markExpired');
    return this.inTenant(tenantId, async (events, scope) => {
      const res = await events.cas(
        eventId,
        (cur) => !!cur && cur.tenantId === tenantId && cur.status === 'ACTIVE' && isSessionExpired(cur.expiresAt, now),
        (cur) => ({ ...cur, status: 'EXPIRED' as const, updatedAt: now }),
      );
      if (!res.ok) {
        const current = await events.get(eventId);
        return current ? { ...current } : undefined;
      }
      const expired = res.doc as AuthenticationEventDoc;
      await this.appendSessionEventInTx(scope, {
        id: randomUUID(),
        at: now,
        tenantId,
        kind: 'SESSION_EXPIRED',
        principalId: expired.principalId,
        resource: AUTHENTICATION_EVENTS_COLLECTION,
        authority: { method: expired.method, authenticationEventId: expired.id },
        result: 'EXPIRED',
      });
      return { ...expired };
    });
  }

  /**
   * P2-S2: rotate the live session token of one event (CAS-guarded,
   * spec §6.1). The presented token's fingerprint must equal the row's live
   * fingerprint; on success the row carries the replacement fingerprint, the
   * superseded fingerprint is kept as rotation-chain evidence, and
   * SESSION_ROTATED (previous + new fingerprints) is appended in the same
   * transaction. The previous token stops working immediately,
   * cross-process (it references nothing live).
   *
   * Fail-closed: unknown/foreign-tenant rows, revoked/expired rows,
   * pre-token rows (no token to rotate — re-authenticate), fingerprint
   * mismatch (already rotated, revoked, or never live), and the rotation
   * bound all throw closed `SessionTokenError` codes. A concurrent rotation
   * race has exactly one CAS winner; losers observe SESSION_TOKEN_UNKNOWN.
   */
  async rotateSessionToken(input: RotateSessionTokenInput, now: number): Promise<AuthenticationEventDoc> {
    if (!input || typeof input !== 'object') {
      throw new AuthenticationStoreError('rotateSessionToken requires an input (fail-closed).');
    }
    if (typeof input.eventId !== 'string' || input.eventId.length === 0) {
      throw new AuthenticationStoreError('rotateSessionToken requires an event id (fail-closed).');
    }
    StorageModule.validateTenantId(input.tenantId);
    if (typeof input.expectedFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(input.expectedFingerprint)) {
      throw new AuthenticationStoreError('rotateSessionToken requires a 64-hex expected fingerprint (fail-closed).');
    }
    if (typeof input.newFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(input.newFingerprint)) {
      throw new AuthenticationStoreError('rotateSessionToken requires a 64-hex replacement fingerprint (fail-closed).');
    }
    if (input.newFingerprint === input.expectedFingerprint) {
      throw new AuthenticationStoreError('rotateSessionToken requires a replacement fingerprint that differs (fail-closed).');
    }
    if (!Number.isInteger(input.maxRotations) || input.maxRotations < 0) {
      throw new AuthenticationStoreError('rotateSessionToken requires maxRotations to be an integer >= 0 (fail-closed).');
    }
    assertUsableClock(now, 'rotateSessionToken');
    return this.inTenant(input.tenantId, async (events, scope) => {
      const res = await events.cas(
        input.eventId,
        (cur) => {
          if (!cur) {
            throw new SessionTokenError(
              'SESSION_TOKEN_UNKNOWN',
              `session "${input.eventId}" does not exist (fail-closed).`,
            );
          }
          if (cur.tenantId !== input.tenantId) {
            throw new SessionTokenError(
              'SESSION_TOKEN_TENANT_MISMATCH',
              'cross-tenant session-token rotation is refused (fail-closed).',
            );
          }
          if (!cur.sessionFingerprint) {
            throw new SessionTokenError(
              'SESSION_TOKEN_UNKNOWN',
              'the session carries no token (pre-token row cannot rotate — re-authenticate) (fail-closed).',
            );
          }
          if (cur.sessionFingerprint !== input.expectedFingerprint) {
            throw new SessionTokenError(
              'SESSION_TOKEN_UNKNOWN',
              'the presented token is not the live token for this session (already rotated, revoked, or never live) (fail-closed).',
            );
          }
          if (cur.status === 'REVOKED') {
            throw new SessionTokenError(
              'SESSION_TOKEN_REVOKED',
              'the session is revoked; a revoked session cannot rotate (re-authenticate) (fail-closed).',
            );
          }
          if (cur.status === 'EXPIRED' || isSessionExpired(cur.expiresAt, now)) {
            throw new SessionTokenError(
              'SESSION_TOKEN_EXPIRED',
              'the session is expired; an expired session cannot rotate (re-authenticate) (fail-closed).',
            );
          }
          const rotations = cur.rotationCount ?? 0;
          if (rotations >= input.maxRotations) {
            throw new SessionTokenError(
              'SESSION_ROTATION_LIMIT',
              `the session has already rotated ${rotations} time(s) (max ${input.maxRotations}); ` +
                'full re-authentication is required (fail-closed).',
            );
          }
          return cur.status === 'ACTIVE';
        },
        (cur) => ({
          ...cur,
          sessionFingerprint: input.newFingerprint,
          previousFingerprint: cur.sessionFingerprint,
          rotationCount: (cur.rotationCount ?? 0) + 1,
          rotatedAt: now,
          updatedAt: now,
        }),
      );
      if (!res.ok) {
        // The predicate passed but the swap lost: a concurrent rotation won
        // and the presented token is no longer live.
        throw new SessionTokenError(
          'SESSION_TOKEN_UNKNOWN',
          'a concurrent rotation won; the presented token is no longer live (fail-closed).',
        );
      }
      const rotated = res.doc as AuthenticationEventDoc;
      await this.appendSessionEventInTx(scope, {
        id: randomUUID(),
        at: now,
        tenantId: input.tenantId,
        kind: 'SESSION_ROTATED',
        principalId: rotated.principalId,
        resource: AUTHENTICATION_EVENTS_COLLECTION,
        authority: { method: rotated.method, authenticationEventId: rotated.id },
        result: 'ROTATED',
        detail: `rotation=${rotated.rotationCount} previous=${input.expectedFingerprint} current=${input.newFingerprint}`,
      });
      return { ...rotated };
    });
  }

  /**
   * P2-S2: resolve a session row by its live token fingerprint. The lookup
   * is inherently pre-tenant (the tenant is what the lookup reveals), so it
   * runs in an explicit SYSTEM-scope transaction — the SAME enumerated,
   * counted `transaction:system` exception the S-9 fingerprint read uses
   * (INV-15; no new labels). Callers MUST re-bind the resolved tenant to
   * the request context before any authority flows (the session-token
   * verifier does). Returns undefined for malformed fingerprints, unknown
   * fingerprints, and (defensively) fingerprint collisions — every one of
   * those denies at the verifier, never mints (fixation defense).
   */
  async findSessionByFingerprint(fingerprint: string): Promise<AuthenticationEventDoc | undefined> {
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
      return undefined;
    }
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) {
        throw new AuthenticationStoreError('Session fingerprint lookup requires an atomic transaction (fail-closed).');
      }
      const events = await scope.collection<AuthenticationEventDoc>(AUTHENTICATION_EVENTS_COLLECTION);
      const rows = await events.query({ where: (row) => row.sessionFingerprint === fingerprint });
      if (rows.length !== 1) {
        // Unknown (0) or a collision (>1, cryptographically impossible for
        // SHA-256 over 256-bit random — refused defensively either way).
        return undefined;
      }
      return { ...(rows[0] as AuthenticationEventDoc) };
    });
  }

  /** SHA-256 fingerprint of token material (the S-9 document id; one-way). */
  static fingerprint(material: string): string {
    return createHash('sha256').update(material, 'utf8').digest('hex');
  }
}
