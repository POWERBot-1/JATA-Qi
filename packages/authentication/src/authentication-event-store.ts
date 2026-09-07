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

import { createHash } from 'node:crypto';
import { StorageModule, type ICollection, type SecurityCollectionSource, type StorageWriteScope } from '@jataqi/storage';
import { PrincipalValidationError, isAuthenticationMethod, type AuthenticationMethod } from './types.js';

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
]);

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
   */
  async recordEvent(input: RecordAuthenticationEventInput, now: number): Promise<AuthenticationEventDoc> {
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
    };
    assertSessionDocumentShape(doc as unknown as Record<string, unknown>, 'recordEvent');
    return this.inTenant(input.tenantId, async (events) => {
      const res = await events.cas(doc.id, (cur) => cur === undefined, () => ({ ...doc }));
      if (!res.ok) {
        throw new AuthenticationStoreError(
          `Authentication event "${doc.id}" is already recorded; event ids are never re-recorded (fail-closed).`,
        );
      }
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
   * Revoke one event (ACTIVE → REVOKED, CAS-guarded). Idempotent:
   * re-revoking returns the current row. Unknown ids throw (no silent
   * success); EXPIRED rows are left EXPIRED (terminal either way).
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
    return this.inTenant(tenantId, async (events) => {
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
      return { ...(res.doc as AuthenticationEventDoc) };
    });
  }

  /**
   * Explicitly flip a past-expiry ACTIVE row to EXPIRED (maintenance /
   * GC attribution). Read paths do NOT depend on this flip — expiry is
   * evaluated on read — so this is evidence hygiene, not enforcement.
   */
  async markExpired(eventId: string, tenantId: string, now: number): Promise<AuthenticationEventDoc | undefined> {
    return this.inTenant(tenantId, async (events) => {
      const res = await events.cas(
        eventId,
        (cur) => !!cur && cur.tenantId === tenantId && cur.status === 'ACTIVE' && isSessionExpired(cur.expiresAt, now),
        (cur) => ({ ...cur, status: 'EXPIRED' as const, updatedAt: now }),
      );
      if (!res.ok) {
        const current = await events.get(eventId);
        return current ? { ...current } : undefined;
      }
      return { ...(res.doc as AuthenticationEventDoc) };
    });
  }

  /** SHA-256 fingerprint of token material (the S-9 document id; one-way). */
  static fingerprint(material: string): string {
    return createHash('sha256').update(material, 'utf8').digest('hex');
  }
}
