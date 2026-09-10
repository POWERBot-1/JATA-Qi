// P2-S2 — durable session/token lifecycle service (spec §6).
//
// The bearer for a durable S-8 session row is a server-minted 256-bit opaque
// token. The durable row carries the token's SHA-256 FINGERPRINT (one-way —
// material is never persisted, mirroring S-9); the material itself is
// returned to the caller ONCE (at mint and at rotation) and is never logged,
// never audited, and never re-derivable from durable state.
//
// Verification = fingerprint lookup (pre-tenant, enumerated system-scope —
// the same INV-15 exception as the S-9 read) + row status (ACTIVE, tenant
// binding, deny-early expiry) + identity-state gate (when the identity core
// is attached: an existing non-ACTIVATED identity denies; a missing record
// passes through, exactly like the P2-S1 Phase-B stage 2.5).
//
// This module mints NO authority of its own: mint requires an already
// authenticated principal (the boundary enforces that), and the asserted
// role set recorded on the row is re-narrowed against the durable ACTIVE
// role assignments at every decision (Phase-B stage 2.5). Token revocation
// IS row revocation — there is no separate token-state store.

import { randomBytes } from 'node:crypto';
import {
  AuthenticationEventStore,
  AuthenticationStoreError,
  DEFAULT_SESSION_CONCURRENCY_POLICY,
  DEFAULT_SESSION_LIFETIME_MS,
  SessionTokenError,
  assessSessionRow,
  assertValidSessionLifetimeMs,
  type AuthenticationEventDoc,
  type SessionConcurrencyPolicy,
} from './authentication-event-store.js';
import type { IdentityStore } from './identity-store.js';
import {
  PrincipalValidationError,
  type AuthenticatedPrincipal,
  type AuthenticationMethod,
  type PresentedCredential,
  type ServerAuthenticator,
} from './types.js';

/** P2-S2: session-token entropy (256 bits, spec §6.1). */
export const SESSION_TOKEN_BYTES = 32;

/**
 * P2-S2: default rotation bound per event (spec §6.1: bounded, configurable;
 * exceeding it requires full re-authentication). The bound counts rotations
 * performed on the event row (`rotationCount`), not presentations.
 */
export const DEFAULT_MAX_SESSION_ROTATIONS = 32;

/**
 * P2-S2: presented-material shape bounds. Tokens are minted as 43-char
 * base64url; verification accepts a narrow superset so future mint formats
 * stay verifiable, and anything outside it is MALFORMED (fail-closed)
 * without touching the store.
 */
const SESSION_TOKEN_MATERIAL_PATTERN = /^[A-Za-z0-9\-_]{16,512}$/;

/** Mint one 256-bit opaque session token (base64url, 43 chars). */
export function mintSessionTokenMaterial(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** The one-way fingerprint of session-token material (SHA-256 hex). */
export function fingerprintSessionToken(material: string): string {
  return AuthenticationEventStore.fingerprint(material);
}

/**
 * Run one store interaction, wrapping substrate failures (connection loss,
 * driver errors) in `AuthenticationStoreError` so every service method
 * fails closed with a uniform, registry-compatible type. Closed
 * `SessionTokenError` codes (and other store errors) pass through
 * untouched — only unexpected substrate breakage is wrapped, and it is
 * never mistaken for a denial-with-a-code nor for success.
 */
async function storeCall<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AuthenticationStoreError) throw error;
    throw new AuthenticationStoreError(
      `${op}: the session-token store failed (${error instanceof Error ? error.message : String(error)}) (fail-closed).`,
    );
  }
}

export interface SessionTokenServiceOptions {
  /** The authoritative S-8 session store (required — no memory fallback). */
  readonly eventStore: AuthenticationEventStore;
  /**
   * The durable identity core. When attached, verification denies for an
   * existing non-ACTIVATED identity (suspended/terminal principals cannot
   * use even a live session row); when absent, no identity gate applies.
   */
  readonly identityStore?: IdentityStore;
  /**
   * Maximum rotations per event (default 32). A non-negative integer;
   * 0 forbids rotation entirely (mint-only sessions).
   */
  readonly maxRotationsPerEvent?: number;
  /**
   * Default concurrent-session policy for mints (default: the spec default
   * N=3 refuse-new). Per-mint overrides are accepted explicitly.
   */
  readonly defaultSessionPolicy?: SessionConcurrencyPolicy;
  /**
   * Session lifetime for minted rows in ms (default 24h; must be an integer
   * in `(0, 30 days]`). The durable row expires at
   * `min(now + sessionLifetimeMs, credentialExpiresAt ?? +inf)` — the same
   * rule as the boundary's legacy recording path. Compositions that set a
   * boundary `sessionLifetimeMs` MUST align this value (the module wires
   * both from the same configuration).
   */
  readonly sessionLifetimeMs?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface MintedSession {
  /** The recorded durable row (fingerprints only — no material). */
  readonly event: AuthenticationEventDoc;
  /**
   * The opaque session-token material — returned ONCE. The caller MUST
   * deliver it to the authenticated party over a confidential channel and
   * MUST NOT log or persist it (only the fingerprint is durable).
   */
  readonly material: string;
}

/**
 * P2-S2 session-token lifecycle service. Every method fails closed; every
 * state transition commits atomically with its SESSION_* audit event in the
 * store layer (no unaudited transition); no method ever returns, logs, or
 * persists token material except the single mint/rotate handoff.
 */
export class SessionTokenService {
  private readonly eventStore: AuthenticationEventStore;
  private readonly identityStore?: IdentityStore;
  private readonly maxRotationsPerEvent: number;
  private readonly defaultSessionPolicy: SessionConcurrencyPolicy;
  private readonly sessionLifetimeMs: number;
  private readonly now: () => number;

  constructor(options: SessionTokenServiceOptions) {
    if (!options || typeof options !== 'object' || !options.eventStore) {
      throw new AuthenticationStoreError('SessionTokenService requires the authoritative session store (fail-closed).');
    }
    const maxRotations = options.maxRotationsPerEvent ?? DEFAULT_MAX_SESSION_ROTATIONS;
    if (!Number.isInteger(maxRotations) || maxRotations < 0) {
      throw new AuthenticationStoreError('SessionTokenService requires maxRotationsPerEvent to be an integer >= 0 (fail-closed).');
    }
    const sessionLifetimeMs = options.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
    assertValidSessionLifetimeMs(sessionLifetimeMs);
    this.eventStore = options.eventStore;
    this.identityStore = options.identityStore;
    this.maxRotationsPerEvent = maxRotations;
    this.defaultSessionPolicy = options.defaultSessionPolicy ?? DEFAULT_SESSION_CONCURRENCY_POLICY;
    this.sessionLifetimeMs = sessionLifetimeMs;
    this.now = options.now ?? ((): number => Date.now());
  }

  /** The rotation bound this service enforces (auditable). */
  get rotationBound(): number {
    return this.maxRotationsPerEvent;
  }

  /** The default mint policy this service enforces (auditable). */
  get mintPolicy(): SessionConcurrencyPolicy {
    return this.defaultSessionPolicy;
  }

  /**
   * Mint a session token for an ALREADY AUTHENTICATED principal (the caller
   * — the boundary — proves authentication before calling). Records the
   * session row WITH the token binding atomically under the
   * concurrent-session policy (default N=3 refuse-new) and returns the
   * material ONCE. The row's asserted roles are the principal's verified
   * roles; the OIDC issuer binding is carried when the principal carries it.
   */
  async mintFor(
    principal: AuthenticatedPrincipal,
    now?: number,
    policy?: SessionConcurrencyPolicy,
  ): Promise<MintedSession> {
    const at = now ?? this.now();
    if (!principal || typeof principal !== 'object') {
      throw new AuthenticationStoreError('mintFor requires an authenticated principal (fail-closed).');
    }
    if (principal.authenticationMethod === 'SESSION_TOKEN') {
      // No session chaining: a session reference cannot mint a further
      // session (that would bypass the rotation bound and extend sessions
      // indefinitely without re-authentication). Renewal is rotation (which
      // is bounded); extension beyond the bound is full re-authentication.
      throw new SessionTokenError(
        'SESSION_TOKEN_UNKNOWN',
        'a session token cannot mint a further session (no chaining — re-authenticate with a credential) (fail-closed).',
      );
    }
    const material = mintSessionTokenMaterial();
    const fingerprint = fingerprintSessionToken(material);
    const issuer =
      principal.authenticationMethod === 'OIDC' &&
      principal.claims !== undefined &&
      typeof principal.claims.issuer === 'string' &&
      principal.claims.issuer.length > 0
        ? principal.claims.issuer
        : undefined;
    const lifetimeEnd = at + this.sessionLifetimeMs;
    const event = await storeCall('mintFor', () => this.eventStore.recordEvent(
      {
        eventId: principal.authenticationEventId,
        tenantId: principal.tenantId,
        principalId: principal.id,
        method: principal.authenticationMethod,
        verifiedAt: principal.verifiedAt,
        expiresAt:
          principal.credentialExpiresAt !== undefined
            ? Math.min(lifetimeEnd, principal.credentialExpiresAt)
            : lifetimeEnd,
        sessionToken: {
          fingerprint,
          roles: [...principal.roles],
          ...(issuer !== undefined ? { issuer } : {}),
        },
      },
      at,
      { sessionPolicy: policy ?? this.defaultSessionPolicy },
    ));
    return { event, material };
  }

  /**
   * Verify presented session-token material: fingerprint lookup + row
   * status (ACTIVE, deny-early expiry) + tenant binding + identity-state
   * gate. Returns the session principal (authenticationMethod
   * SESSION_TOKEN, authenticationEventId = the session row id) or throws a
   * closed `SessionTokenError`. Unknown/malformed material is a denial —
   * never a mint (fixation defense).
   *
   * @param tenantId — the request tenant, when the presentation context
   * carries one. The authoritative tenant ALWAYS comes from the row
   * (server-side); a supplied tenant that mismatches the row is a
   * SESSION_TOKEN_TENANT_MISMATCH denial (tenant substitution defense).
   */
  async verify(material: string, tenantId?: string, now?: number): Promise<AuthenticatedPrincipal> {
    const at = now ?? this.now();
    if (typeof material !== 'string' || !SESSION_TOKEN_MATERIAL_PATTERN.test(material)) {
      throw new SessionTokenError(
        'SESSION_TOKEN_MALFORMED',
        'the presented session token is malformed (fail-closed).',
      );
    }
    const fingerprint = fingerprintSessionToken(material);
    const row = await storeCall('verify', () => this.eventStore.findSessionByFingerprint(fingerprint));
    if (!row) {
      throw new SessionTokenError(
        'SESSION_TOKEN_UNKNOWN',
        'the presented session token references no live session (unknown, rotated, or never minted — fail-closed).',
      );
    }
    if (tenantId !== undefined && row.tenantId !== tenantId) {
      throw new SessionTokenError(
        'SESSION_TOKEN_TENANT_MISMATCH',
        'the presented session token belongs to a different tenant than the request context (fail-closed).',
      );
    }
    const assessment = assessSessionRow(row, at);
    if (!assessment.active) {
      if (assessment.status === 'REVOKED') {
        throw new SessionTokenError('SESSION_TOKEN_REVOKED', `the session is revoked (${assessment.detail}) (fail-closed).`);
      }
      if (assessment.status === 'EXPIRED') {
        throw new SessionTokenError('SESSION_TOKEN_EXPIRED', `the session is expired (${assessment.detail}) (fail-closed).`);
      }
      throw new SessionTokenError('SESSION_TOKEN_UNKNOWN', `the session row is unusable (${assessment.detail}) (fail-closed).`);
    }
    const event = assessment.event;
    if (!event.sessionFingerprint || event.sessionFingerprint !== fingerprint) {
      // The row exists but the presented token is not its LIVE token (a
      // superseded rotation fingerprint, or a pre-token row reached through
      // a stale reference): deny, never honor.
      throw new SessionTokenError(
        'SESSION_TOKEN_UNKNOWN',
        'the presented token is not the live token for this session (fail-closed).',
      );
    }
    if (!event.roles || event.roles.length === 0) {
      throw new SessionTokenError(
        'SESSION_TOKEN_UNKNOWN',
        'the session row carries no asserted role set (fail-closed).',
      );
    }
    // Identity-state gate (defense in depth; same semantics as the P2-S1
    // Phase-B stage 2.5): an EXISTING non-ACTIVATED identity denies even
    // when the session row is still ACTIVE (e.g. suspended after mint — the
    // decision layer would deny too, but the session must not validate);
    // a missing identity record passes through (pre-P2 coexistence).
    // Verification NEVER mutates identity state (no re-activation here —
    // only fresh credential verification activates).
    if (this.identityStore) {
      const identityStore = this.identityStore;
      const identity = await storeCall('verify', () =>
        identityStore.getPrincipal(event.principalId, event.tenantId),
      );
      if (identity && identity.state !== 'ACTIVATED') {
        throw new SessionTokenError(
          'SESSION_IDENTITY_INACTIVE',
          `identity "${event.principalId}" is ${identity.state}; a non-activated identity cannot use a session token (fail-closed).`,
        );
      }
    }
    return {
      id: event.principalId,
      tenantId: event.tenantId,
      roles: [...event.roles],
      authenticationMethod: 'SESSION_TOKEN',
      verifiedAt: at,
      authenticationEventId: event.id,
      credentialExpiresAt: event.expiresAt,
    };
  }

  /**
   * Rotate a live session token: the presented material must be the row's
   * live token; on success a replacement token is minted, the row swaps to
   * its fingerprint (CAS — exactly one winner per race), and the new
   * material is returned ONCE. The previous token dies immediately,
   * cross-process. At the rotation bound, rotation is refused (full
   * re-authentication required).
   */
  async rotate(material: string, tenantId?: string, now?: number): Promise<MintedSession> {
    const at = now ?? this.now();
    if (typeof material !== 'string' || !SESSION_TOKEN_MATERIAL_PATTERN.test(material)) {
      throw new SessionTokenError(
        'SESSION_TOKEN_MALFORMED',
        'the presented session token is malformed (fail-closed).',
      );
    }
    const expectedFingerprint = fingerprintSessionToken(material);
    const row = await storeCall('rotate', () => this.eventStore.findSessionByFingerprint(expectedFingerprint));
    if (!row) {
      throw new SessionTokenError(
        'SESSION_TOKEN_UNKNOWN',
        'the presented session token references no live session (fail-closed).',
      );
    }
    if (tenantId !== undefined && row.tenantId !== tenantId) {
      throw new SessionTokenError(
        'SESSION_TOKEN_TENANT_MISMATCH',
        'the presented session token belongs to a different tenant than the request context (fail-closed).',
      );
    }
    const replacement = mintSessionTokenMaterial();
    const event = await storeCall('rotate', () => this.eventStore.rotateSessionToken(
      {
        eventId: row.id,
        tenantId: row.tenantId,
        expectedFingerprint,
        newFingerprint: fingerprintSessionToken(replacement),
        maxRotations: this.maxRotationsPerEvent,
      },
      at,
    ));
    return { event, material: replacement };
  }

  /**
   * Revoke the session referenced by presented token material
   * (operator/compromise path). Unknown material throws (no silent
   * success); re-revoking an already-terminal session is idempotent (the
   * current row is returned; no second SESSION_REVOKED is emitted).
   */
  async revoke(material: string, tenantId: string, reason: string, now?: number): Promise<AuthenticationEventDoc> {
    const at = now ?? this.now();
    if (typeof material !== 'string' || !SESSION_TOKEN_MATERIAL_PATTERN.test(material)) {
      throw new SessionTokenError(
        'SESSION_TOKEN_MALFORMED',
        'the presented session token is malformed (fail-closed).',
      );
    }
    const fingerprint = fingerprintSessionToken(material);
    const row = await storeCall('revoke', () => this.eventStore.findSessionByFingerprint(fingerprint));
    if (!row) {
      throw new SessionTokenError(
        'SESSION_TOKEN_UNKNOWN',
        'the presented session token references no session (fail-closed).',
      );
    }
    // The revocation tenant is authoritative: the row's tenant must match
    // it (cross-tenant revocation is refused inside revokeEvent as well —
    // defense in depth on both layers).
    return storeCall('revoke', () => this.eventStore.revokeEvent(row.id, tenantId, reason, at));
  }

  /**
   * Explicitly flip a past-expiry session to EXPIRED (evidence hygiene —
   * enforcement is on read). No-op for live/terminal/unknown sessions.
   */
  async markExpired(eventId: string, tenantId: string, now?: number): Promise<AuthenticationEventDoc | undefined> {
    const at = now ?? this.now();
    return storeCall('markExpired', () => this.eventStore.markExpired(eventId, tenantId, at));
  }
}

/**
 * P2-S2: the session-token verifier as a `ServerAuthenticator`
 * (method SESSION_TOKEN). The presentation context MAY carry `tenantId`
 * (cross-checked against the row when present); the authoritative tenant
 * always comes from the row itself (server-side derivation).
 */
export class SessionTokenAuthenticator implements ServerAuthenticator {
  readonly id = 'session-token';
  readonly supports: readonly AuthenticationMethod[] = ['SESSION_TOKEN'];

  constructor(private readonly service: SessionTokenService) {
    if (!service) {
      throw new PrincipalValidationError('SessionTokenAuthenticator requires a SessionTokenService (fail-closed).');
    }
  }

  async verify(credential: PresentedCredential, now: number, _requestId: string): Promise<AuthenticatedPrincipal> {
    if (credential.method !== 'SESSION_TOKEN') {
      throw new PrincipalValidationError(
        `Session token authenticator does not support method "${credential.method}".`,
      );
    }
    const contextTenant =
      credential.context !== undefined &&
      typeof credential.context.tenantId === 'string' &&
      credential.context.tenantId.length > 0
        ? (credential.context.tenantId as string)
        : undefined;
    return this.service.verify(credential.material, contextTenant, now);
  }
}
