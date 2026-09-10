// T-03 principal boundary service — the single object a production request
// path talks to in order to turn a presented credential into authority.
//
// This is NOT a second authentication system. It is a thin, fail-closed
// enforcement wrapper around the existing T-01 `AuthenticatorRegistry`:
// it adds (a) explicit policy admission, checked before any authenticator is
// consulted, and (b) independent validation of whatever an authenticator
// returns, so a misconfigured or hostile authenticator cannot smuggle an
// inadmissible method or a malformed principal into the durable queue.
//
// It never mints authority, never holds credentials, never persists anything,
// and never falls back: every rejection throws. There is no SYSTEM actor, no
// anonymous actor, and no default principal anywhere in this file.

import { randomUUID } from 'node:crypto';
import type { CommercialActor, CommercialActorRole } from '@jataqi/commercial-control-plane';
import { AuthenticatorRegistry } from './authenticator-registry.js';
import {
  assertMethodAdmitted,
  resolveAuthenticationPolicy,
  type AuthenticationPolicyInput,
  type ResolvedAuthenticationPolicy,
} from './authentication-policy.js';
import {
  isAuthenticationMethod,
  projectToActor,
  PrincipalValidationError,
  UnauthenticatedRequestError,
  type AuthenticatedPrincipal,
  type PresentedCredential,
  type ServerAuthenticator,
} from './types.js';
import {
  assertValidSessionLifetimeMs,
  DEFAULT_SESSION_LIFETIME_MS,
  type AuthenticationEventStore,
  type SessionConcurrencyPolicy,
} from './authentication-event-store.js';
import type { SessionTokenService } from './session-tokens.js';

export interface PrincipalBoundaryConfig {
  /**
   * Authenticators this composition root trusts. Defaults to NONE, which
   * means every request fails closed. A boundary that can authenticate
   * someone must be told, explicitly, who it can authenticate them as.
   */
  readonly authenticators?: readonly ServerAuthenticator[];
  /** Explicit admission policy. Defaults to the production posture. */
  readonly policy?: AuthenticationPolicyInput;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable correlation-id source. Defaults to `randomUUID`. */
  readonly newRequestId?: () => string;
  /**
   * R2 S-8: when attached, every successful authentication is durably
   * recorded in the shared event store BEFORE the principal is
   * returned, and the store is the SOLE session substrate (no memory
   * fallback: a record failure rejects the authentication). When
   * absent, R1 behavior is preserved exactly (no durable session).
   */
  readonly eventStore?: AuthenticationEventStore;
  /**
   * R2 S-8: session lifetime in ms (default 24h). Must be an integer in
   * `(0, 30 days]`. The durable row expires at
   * `min(now + sessionLifetimeMs, credentialExpiresAt ?? +inf)`.
   */
  readonly sessionLifetimeMs?: number;
  /**
   * P2-S2: the session-token lifecycle service. Required for
   * `authenticateWithSessionToken` (mint); SESSION_TOKEN verification
   * through `authenticate` needs only a registered
   * SessionTokenAuthenticator. The service's `sessionLifetimeMs` SHOULD
   * match this boundary's `sessionLifetimeMs` (the authentication module
   * wires both from the same configuration).
   */
  readonly sessionTokenService?: SessionTokenService;
}

/** A verified principal together with the actor projected from it. */
export interface AuthenticatedRequest {
  readonly principal: AuthenticatedPrincipal;
  readonly actor: CommercialActor;
}

/**
 * P2-S2: a freshly authenticated principal together with its minted opaque
 * session token. The token material is returned ONCE — the caller MUST
 * deliver it to the authenticated party over a confidential channel and
 * MUST NOT log or persist it (only the fingerprint is durable).
 */
export interface AuthenticatedSession {
  readonly principal: AuthenticatedPrincipal;
  readonly actor: CommercialActor;
  readonly sessionToken: string;
}

/** Secret-free provenance of one authentication, safe for logs and receipts. */
export interface AuthenticationProvenance {
  readonly principalId: string;
  readonly tenantId: string;
  readonly authenticationMethod: string;
  readonly authenticationEventId: string;
  readonly verifiedAt: number;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate an authenticator's returned principal independently of the
 * authenticator. An authenticator is trusted to *verify credentials*, not to
 * be correct: a buggy or compromised implementation must still be unable to
 * hand a malformed or inadmissible principal to the durable boundary.
 */
function assertWellFormedPrincipal(principal: unknown): asserts principal is AuthenticatedPrincipal {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) {
    throw new PrincipalValidationError('Authenticator returned no principal object (fail-closed).');
  }
  const candidate = principal as Partial<AuthenticatedPrincipal>;
  if (!isNonBlankString(candidate.id)) {
    throw new PrincipalValidationError('Authenticator returned a principal with a blank id (fail-closed).');
  }
  if (!isNonBlankString(candidate.tenantId)) {
    throw new PrincipalValidationError('Authenticator returned a principal with a blank tenant id (fail-closed).');
  }
  if (!Array.isArray(candidate.roles) || candidate.roles.length === 0) {
    throw new PrincipalValidationError('Authenticator returned a principal with no verified roles (fail-closed).');
  }
  for (const role of candidate.roles) {
    if (!isNonBlankString(role)) {
      throw new PrincipalValidationError('Authenticator returned a principal with a blank role entry (fail-closed).');
    }
  }
  if (!isAuthenticationMethod(candidate.authenticationMethod)) {
    throw new PrincipalValidationError('Authenticator returned an unrecognized authentication method (fail-closed).');
  }
  if (typeof candidate.verifiedAt !== 'number' || !Number.isFinite(candidate.verifiedAt) || candidate.verifiedAt < 0) {
    throw new PrincipalValidationError('Authenticator returned a malformed verifiedAt timestamp (fail-closed).');
  }
  if (!isNonBlankString(candidate.authenticationEventId)) {
    throw new PrincipalValidationError('Authenticator returned no authentication event id (fail-closed).');
  }
  if (
    candidate.credentialExpiresAt !== undefined &&
    (typeof candidate.credentialExpiresAt !== 'number' ||
      !Number.isFinite(candidate.credentialExpiresAt) ||
      candidate.credentialExpiresAt <= 0)
  ) {
    throw new PrincipalValidationError('Authenticator returned a malformed credentialExpiresAt timestamp (fail-closed).');
  }
}

/**
 * The production-facing authentication boundary.
 *
 * Construction is fail-closed: an authenticator whose supported methods are
 * not all admitted by the policy is rejected outright, so registering a test
 * authenticator into a production root is a startup error rather than a
 * latent authority hole.
 */
export class PrincipalBoundary {
  readonly #registry: AuthenticatorRegistry;
  readonly #policy: ResolvedAuthenticationPolicy;
  readonly #now: () => number;
  readonly #newRequestId: () => string;
  readonly #eventStore?: AuthenticationEventStore;
  readonly #sessionLifetimeMs: number;
  readonly #sessionTokenService?: SessionTokenService;

  constructor(config: PrincipalBoundaryConfig = {}) {
    this.#policy = resolveAuthenticationPolicy(config.policy);
    this.#registry = new AuthenticatorRegistry();
    this.#now = config.now ?? ((): number => Date.now());
    this.#newRequestId = config.newRequestId ?? ((): string => randomUUID());
    this.#eventStore = config.eventStore;
    this.#sessionLifetimeMs = config.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
    assertValidSessionLifetimeMs(this.#sessionLifetimeMs);
    this.#sessionTokenService = config.sessionTokenService;

    for (const authenticator of config.authenticators ?? []) {
      this.#admitAuthenticator(authenticator);
    }
  }

  /** Reject an authenticator that could produce a method this policy forbids. */
  #admitAuthenticator(authenticator: ServerAuthenticator): void {
    if (!authenticator || typeof authenticator.verify !== 'function') {
      throw new PrincipalValidationError('An authenticator must implement verify() (fail-closed).');
    }
    if (!Array.isArray(authenticator.supports) || authenticator.supports.length === 0) {
      throw new PrincipalValidationError(
        `Authenticator "${String(authenticator.id)}" declares no supported methods (fail-closed).`,
      );
    }
    for (const method of authenticator.supports) {
      if (!this.#policy.allowedMethods.includes(method)) {
        throw new PrincipalValidationError(
          `Authenticator "${String(authenticator.id)}" supports "${method}", which this composition root's ` +
            `${this.#policy.describe()} does not admit. Refusing to register it (fail-closed).`,
        );
      }
    }
    this.#registry.register(authenticator);
  }

  /** The resolved, frozen policy. Auditable via `getPolicy().describe()`. */
  getPolicy(): ResolvedAuthenticationPolicy {
    return this.#policy;
  }

  /** Registered authenticator ids (diagnostics; never credentials). */
  listAuthenticatorIds(): readonly string[] {
    return this.#registry.list().map((authenticator) => authenticator.id);
  }

  /**
   * The registered authenticators themselves (structural posture checks —
   * e.g. P2-INV-01/INV-02 inspect `verifiesCryptographicProof` and the
   * supported methods; never used for verification).
   */
  listAuthenticators(): readonly ServerAuthenticator[] {
    return this.#registry.list();
  }

  /**
   * Authenticate a presented credential and return the verified principal.
   *
   * Order of enforcement (all fail closed, none falls back):
   *   1. a credential must be present and carry a method;
   *   2. the method must be admitted by the resolved policy — checked BEFORE
   *      any authenticator runs, so a registered authenticator can never
   *      widen the boundary;
   *   3. the T-01 registry must verify the material;
   *   4. the returned principal is independently validated;
   *   5. the returned principal's method is re-checked against the policy, so
   *      an authenticator that mislabels itself cannot smuggle test authority.
   *   6. R2 only: when an event store is attached, the success is recorded
   *      durably BEFORE the principal is returned; a record failure
   *      rejects the authentication (no unverifiable session exists).
   *      P2-S2 only: SESSION_TOKEN presentations skip this step — they
   *      validate an already-recorded session instead of recording one.
   */
  async authenticate(credential: PresentedCredential | undefined | null): Promise<AuthenticatedPrincipal> {
    // Steps 1–5 (presence, recognized method, policy admission before any
    // authenticator runs, registry verification, independent structural
    // validation, method re-check) — shared with session-token minting.
    const principal = await this.#verifyCredential(credential);

    // (6) R2 durable session: record BEFORE returning. The boundary is the
    // SOLE writer of session rows; no other path may mint sessions.
    // P2-S2: a principal produced by SESSION_TOKEN validation references an
    // ALREADY-RECORDED session (that is what was validated) — recording
    // again would violate insert-once, so validation never re-records.
    if (this.#eventStore && principal.authenticationMethod !== 'SESSION_TOKEN') {
      const now = this.#now();
      const lifetimeEnd = now + this.#sessionLifetimeMs;
      const expiresAt =
        principal.credentialExpiresAt !== undefined
          ? Math.min(lifetimeEnd, principal.credentialExpiresAt)
          : lifetimeEnd;
      try {
        await this.#eventStore.recordEvent(
          {
            eventId: principal.authenticationEventId,
            tenantId: principal.tenantId,
            principalId: principal.id,
            method: principal.authenticationMethod,
            verifiedAt: principal.verifiedAt,
            expiresAt,
          },
          now,
        );
      } catch (error) {
        throw new UnauthenticatedRequestError(
          'Authentication succeeded but the durable session could not be recorded ' +
            `(${error instanceof Error ? error.message : String(error)}) (fail-closed).`,
        );
      }
    }
    return principal;
  }

  /**
   * Authenticate and project to the `CommercialActor` the queue and loop
   * consume. `requestedRoles` may only NARROW the verified set: widening
   * throws inside T-01's own `projectToActor`, so the narrowing rule has a
   * single implementation.
   */
  async authenticateAndProject(
    credential: PresentedCredential | undefined | null,
    requestedRoles?: readonly CommercialActorRole[],
  ): Promise<AuthenticatedRequest> {
    const principal = await this.authenticate(credential);
    const actor = projectToActor(principal, requestedRoles);
    return { principal, actor };
  }

  /**
   * P2-S2: verify a presented credential (the shared steps 1–5 of
   * `authenticate`: presence, recognized method, policy admission before
   * any authenticator runs, registry verification, independent structural
   * validation, method re-check) WITHOUT recording a session. Used by
   * `authenticate` (which then records) and by `authenticateWithSessionToken`
   * (which then mints) so a login is recorded exactly once.
   */
  async #verifyCredential(credential: PresentedCredential | undefined | null): Promise<AuthenticatedPrincipal> {
    if (!credential || typeof credential !== 'object') {
      throw new UnauthenticatedRequestError('no credential was presented (fail-closed).');
    }
    if (!isAuthenticationMethod(credential.method)) {
      throw new UnauthenticatedRequestError(
        `presented credential carries no recognized authentication method (got "${String(credential.method)}") (fail-closed).`,
      );
    }
    assertMethodAdmitted(this.#policy, credential.method);
    const principal = await this.#registry.authenticate(credential, this.#now(), this.#newRequestId());
    assertWellFormedPrincipal(principal);
    if (!this.#policy.allowedMethods.includes(principal.authenticationMethod)) {
      throw new PrincipalValidationError(
        `Authenticator returned method "${principal.authenticationMethod}", which this composition root's policy ` +
          `does not admit (fail-closed).`,
      );
    }
    return principal;
  }

  /**
   * P2-S2: authenticate a presented credential AND mint its opaque session
   * token in a single call. The credential MUST be a real credential (a
   * SESSION_TOKEN reference is refused — no session chaining; renewal is
   * bounded rotation, extension beyond the bound is re-authentication
   * here). The session row is recorded WITH the token binding atomically
   * under the concurrent-session policy (default N=3 refuse-new, overridable
   * per call); the material is returned ONCE in `sessionToken`.
   *
   * `requestedRoles` narrows BEFORE mint (a narrowed session carries
   * narrowed asserted roles); widening throws, as in `projectToActor`.
   */
  async authenticateWithSessionToken(
    credential: PresentedCredential | undefined | null,
    requestedRoles?: readonly CommercialActorRole[],
    policy?: SessionConcurrencyPolicy,
  ): Promise<AuthenticatedSession> {
    if (!this.#sessionTokenService) {
      throw new UnauthenticatedRequestError(
        'session-token minting is not configured on this boundary (no session-token service) (fail-closed).',
      );
    }
    if (credential !== undefined && credential !== null && credential.method === 'SESSION_TOKEN') {
      throw new UnauthenticatedRequestError(
        'a session token cannot mint a further session (no chaining — re-authenticate with a credential) (fail-closed).',
      );
    }
    const principal = await this.#verifyCredential(credential);
    const actor = projectToActor(principal, requestedRoles);
    const narrowed: AuthenticatedPrincipal =
      requestedRoles === undefined ? principal : { ...principal, roles: [...actor.roles] };
    try {
      const minted = await this.#sessionTokenService.mintFor(narrowed, this.#now(), policy);
      return { principal: narrowed, actor, sessionToken: minted.material };
    } catch (error) {
      throw new UnauthenticatedRequestError(
        'Authentication succeeded but the durable session token could not be minted ' +
          `(${error instanceof Error ? error.message : String(error)}) (fail-closed).`,
      );
    }
  }

  /** Secret-free provenance projection of a verified principal. */
  static provenanceOf(principal: AuthenticatedPrincipal): AuthenticationProvenance {
    return {
      principalId: principal.id,
      tenantId: principal.tenantId,
      authenticationMethod: principal.authenticationMethod,
      authenticationEventId: principal.authenticationEventId,
      verifiedAt: principal.verifiedAt,
    };
  }
}
