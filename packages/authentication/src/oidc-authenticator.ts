// P2-S1 — provider-neutral OIDC authentication boundary (spec §5.1).
//
// `OidcAuthenticator` implements `ServerAuthenticator` +
// `ProductionAuthenticatorContract`. The verification pipeline (all
// fail-closed, deterministic codes):
//
//   1. method = OIDC; material = a signed token; empty/malformed ⇒ reject;
//   2. signature: pinned JWKS (RS256/ES256 only; `none`/HS*/unknown alg
//      rejected; unknown/unpinned kid rejected) — NO store is read before
//      the signature verifies (A-15: a wrong iss/aud never leaks identity
//      state);
//   3. claims: `iss` exact-issuer, `aud` ∈ configured allow-list, `exp`
//      deny-early (300 s skew), `nbf`/`iat` future-beyond-skew ⇒ reject,
//      `sub` non-blank, `jti` non-blank, optional `auth_time` valid
//      (A-02/A-15/A-22 — the 4-case skew table in `jwt.ts`);
//   4. replay: durable one-shot `jti` consume (A-01 — cross-process);
//   5. tenant mapping: (iss, sub) → (principalId, tenantId) via the durable
//      subject-binding — the tenant is DERIVED SERVER-SIDE, never taken
//      from a claim (A-06: tenant substitution is structurally impossible);
//      unknown subject ⇒ reject (no default tenant);
//   6. identity lifecycle: ENROLLED/SUSPENDED ⇒ activation via THIS
//      verification (the evidence is the auth event); ACTIVATED ⇒ proceed;
//      DEACTIVATED/DEPROVISIONED ⇒ reject (no re-enable);
//   7. role set = asserted ∩ assigned (spec §4.1) — an asserted role
//      without an ACTIVE assignment is dropped (never widened); `system`
//      can never be asserted from the wire;
//   8. AUTH_LOGIN recorded durably BEFORE the principal is returned
//      (record-before-principal); failures with a resolved tenant record
//      AUTH_FAILED (reason class only — never material).
//
// PRODUCTION / TEST honesty: the JWKS pin is the trust anchor. An `inline`
// pin with operator-generated keys (or an injected fetcher) is a TEST
// DOUBLE or staging pin — it proves the boundary's behavior; it is never
// represented as a live production identity provider. Live IdP activation
// (a real issuer + real jwks_uri) is a separate operational authorization;
// external IdP availability is NOT required for verification (the pin is
// resolved at boot).

import { randomUUID } from 'node:crypto';
import type { CommercialActorRole } from '@jataqi/commercial-control-plane';
import {
  isCommercialActorRole,
  PrincipalValidationError,
  type AuthenticatedPrincipal,
  type AuthenticationMethod,
  type PresentedCredential,
  type ServerAuthenticator,
} from './types.js';
import type { IdentityProviderHealth, ProductionAuthenticatorContract } from './contracts.js';
import {
  assessOidcClaims,
  DEFAULT_OIDC_ALGORITHMS,
  OIDC_CLOCK_SKEW_MS,
  resolveJwksPin,
  verifyJwt,
  type JwksSource,
  type JwtAlgorithm,
  type ResolvedJwksPin,
} from './jwt.js';
import type { IdentityStore } from './identity-store.js';
import type { JtiReplayStore } from './jti-replay.js';

export interface OidcAuthenticatorOptions {
  /** Stable authenticator id (audit records cite it). Default `"oidc"`. */
  readonly id?: string;
  /** The EXACT expected issuer (`iss`). One issuer per authenticator. */
  readonly issuer: string;
  /** The configured audience allow-list (`aud` must be a member). */
  readonly audience: readonly string[];
  /** The pinned JWKS source (inline key set or exact pinned URL). */
  readonly jwks: JwksSource;
  /** Admitted algorithms. Default: the closed RS256|ES256 pair. */
  readonly allowedAlgorithms?: readonly JwtAlgorithm[];
  /**
   * Clock-skew bound in MILLISECONDS (the codebase `now` convention).
   * Default: the shared 300 s deny-early bound. The JWT claims boundary
   * converts to epoch seconds at the boundary (RFC 7519 numericdates).
   */
  readonly skewMs?: number;
  /** The durable identity core (tenant mapping + lifecycle + events). */
  readonly identityStore: IdentityStore;
  /** The durable jti single-use replay set. */
  readonly jtiReplay: JtiReplayStore;
  /** Injectable clock (default `Date.now`). */
  readonly clock?: () => number;
}

/** A closed, deterministic OIDC rejection (carries the failure code). */
export class OidcAuthenticatorError extends PrincipalValidationError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OidcAuthenticatorError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OidcAuthenticator implements ServerAuthenticator, ProductionAuthenticatorContract {
  readonly id: string;
  readonly supports: readonly AuthenticationMethod[] = ['OIDC'];
  /** Cryptographic proof: pinned-JWKS signature verification. */
  readonly verifiesCryptographicProof = true;
  /** `iss` exact + `aud` ∈ configured allow-list — both mandatory. */
  readonly validatesIssuerAndAudience = true;
  /** Durable one-shot jti consumption (cross-process). */
  readonly replayResistant = true;

  private readonly issuer: string;
  private readonly audience: readonly string[];
  private readonly allowedAlgorithms: readonly JwtAlgorithm[];
  private readonly skewMs: number;
  private readonly pin: ResolvedJwksPin;
  private readonly identityStore: IdentityStore;
  private readonly jtiReplay: JtiReplayStore;
  private readonly clock: () => number;

  private constructor(options: OidcAuthenticatorOptions, pin: ResolvedJwksPin) {
    if (typeof options.issuer !== 'string' || options.issuer.trim().length === 0) {
      throw new OidcAuthenticatorError('OIDC_CONFIG', 'the OIDC authenticator requires the exact issuer (fail-closed).');
    }
    if (!Array.isArray(options.audience) || options.audience.length === 0 || !options.audience.every((a) => typeof a === 'string' && a.length > 0)) {
      throw new OidcAuthenticatorError('OIDC_CONFIG', 'the OIDC authenticator requires a non-empty audience allow-list (fail-closed).');
    }
    this.id = options.id ?? 'oidc';
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.allowedAlgorithms = options.allowedAlgorithms ?? DEFAULT_OIDC_ALGORITHMS;
    this.skewMs = options.skewMs ?? OIDC_CLOCK_SKEW_MS;
    this.pin = pin;
    this.identityStore = options.identityStore;
    this.jtiReplay = options.jtiReplay;
    this.clock = options.clock ?? ((): number => Date.now());
  }

  /**
   * Construct the authenticator, resolving the pinned JWKS ONCE (the `url`
   * variant fetches exactly here — at boot, never at verification time).
   * A pin that cannot be resolved rejects construction (boot fails closed).
   */
  static async create(options: OidcAuthenticatorOptions): Promise<OidcAuthenticator> {
    const pin = await resolveJwksPin(options.jwks, options.clock ? options.clock() : Date.now());
    return new OidcAuthenticator(options, pin);
  }

  /**
   * The resolved pin (diagnostics: source, url, resolvedAt, kid count —
   * never key material in logs).
   */
  get pinInfo(): { readonly source: 'inline' | 'url'; readonly url?: string; readonly resolvedAt: number; readonly kidCount: number } {
    return {
      source: this.pin.source,
      ...(this.pin.url !== undefined ? { url: this.pin.url } : {}),
      resolvedAt: this.pin.resolvedAt,
      kidCount: this.pin.keys.size,
    };
  }

  /**
   * INV-14 health. The pin is resolved at boot, so availability is
   * established by the pin state (by design, external IdP availability is
   * NOT required — spec §5.1; a live probe would couple verification to
   * the IdP's uptime, which the boundary explicitly does not do).
   */
  async health(): Promise<IdentityProviderHealth> {
    return {
      status: 'healthy',
      checkedAt: this.clock(),
      detail: `pinned JWKS ${this.pin.source}${this.pin.url ? ` (${this.pin.url})` : ''} resolved at ${this.pin.resolvedAt}; ${this.pin.keys.size} key(s)`,
    };
  }

  async verify(credential: PresentedCredential, now: number, requestId: string): Promise<AuthenticatedPrincipal> {
    if (credential.method !== 'OIDC') {
      throw new OidcAuthenticatorError('METHOD_MISMATCH', `OIDC authenticator does not support method "${credential.method}".`);
    }
    if (typeof credential.material !== 'string' || credential.material.length === 0) {
      throw new OidcAuthenticatorError('JWT_MALFORMED', 'OIDC verification requires non-empty token material.');
    }

    // (2) Signature first — NO identity state is read before the signature
    // verifies (A-15: wrong iss/aud cannot probe identity existence).
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      ({ header, payload } = verifyJwt(credential.material, this.pin, { allowedAlgorithms: this.allowedAlgorithms }));
    } catch (error) {
      throw this.mapJwtError(error);
    }
    void header;

    // (3) Required-claim boundary (exact table; 4-case skew documented in
    // jwt.ts). Unit conversion at the boundary: the claims boundary works in
    // RFC 7519 epoch SECONDS; the codebase `now` is epoch milliseconds.
    const nowSeconds = Math.floor(now / 1000);
    const assessment = assessOidcClaims(
      payload,
      { issuer: this.issuer, audience: this.audience, skewSeconds: Math.floor(this.skewMs / 1000) },
      nowSeconds,
    );
    if (!assessment.ok) {
      throw new OidcAuthenticatorError(assessment.code, assessment.detail);
    }
    const claims = assessment.claims;

    // (4) Durable one-shot replay consume (A-01). The jti set is
    // millisecond-based (codebase convention): the assertion expiry converts
    // from seconds at this boundary.
    try {
      await this.jtiReplay.consume(claims.jti, now, claims.exp * 1000);
    } catch (error) {
      if (error instanceof PrincipalValidationError) {
        throw new OidcAuthenticatorError(error.message.startsWith('[JTI_REPLAY_DETECTED]') ? 'JTI_REPLAY_DETECTED' : 'JTI_STORE_UNAVAILABLE', (error as Error).message);
      }
      throw new OidcAuthenticatorError('JTI_STORE_UNAVAILABLE', `the durable replay store failed (${(error as Error).message}) (fail-closed).`);
    }

    // (5) Server-side tenant mapping (A-06): unknown subject ⇒ reject.
    const binding = await this.identityStore.findBySubject(claims.iss, claims.sub);
    if (!binding) {
      throw new OidcAuthenticatorError(
        'IDENTITY_NOT_ENROLLED',
        'the (issuer, subject) pair is not enrolled; unknown subjects authenticate to nothing (no default tenant) (fail-closed).',
      );
    }
    const principalId = binding.principalId;
    const tenantId = binding.tenantId;

    // (6) Identity lifecycle (tenant resolved — failures below are auditable).
    try {
      const identity = await this.identityStore.getPrincipal(principalId, tenantId);
      if (!identity) {
        throw new OidcAuthenticatorError(
          'IDENTITY_NOT_ENROLLED',
          `the subject is bound but the identity record for "${principalId}" is missing (dangling binding) (fail-closed).`,
        );
      }
      switch (identity.state) {
        case 'ENROLLED':
        case 'SUSPENDED': {
          // Fresh verification IS the activation evidence (spec §4.2):
          // ENROLLED → ACTIVATED (first), SUSPENDED → ACTIVATED (re-activation).
          await this.identityStore.activate(principalId, tenantId, { authenticationEventId: requestId, method: 'OIDC' }, now);
          break;
        }
        case 'ACTIVATED':
          break;
        case 'DEACTIVATED':
        case 'DEPROVISIONED':
          throw new OidcAuthenticatorError(
            'IDENTITY_STATE_INACTIVE',
            `identity "${principalId}" is ${identity.state}; deprovisioned/deactivated identities cannot authenticate (no re-enable) (fail-closed).`,
          );
      }

      // (7) role set = asserted ∩ assigned (never widened).
      const activeRoles = await this.identityStore.getActiveRoles(principalId, tenantId, now);
      let effectiveRoles: CommercialActorRole[] = [...activeRoles];
      if (payload.roles !== undefined) {
        if (!Array.isArray(payload.roles) || payload.roles.some((r) => typeof r !== 'string')) {
          throw new OidcAuthenticatorError('OIDC_CLAIM_ROLES_INVALID', 'the "roles" claim is present but not a string array (fail-closed).');
        }
        for (const role of payload.roles as readonly string[]) {
          if (!isCommercialActorRole(role)) {
            throw new OidcAuthenticatorError('OIDC_CLAIM_ROLES_INVALID', `the "roles" claim asserts unknown role "${role}" (fail-closed).`);
          }
          if (role === 'system') {
            throw new OidcAuthenticatorError('OIDC_CLAIM_ROLES_INVALID', 'the "roles" claim asserts "system"; a kernel-internal role can never be asserted from the wire (fail-closed).');
          }
        }
        const asserted = payload.roles as readonly CommercialActorRole[];
        effectiveRoles = activeRoles.filter((role) => asserted.includes(role));
      }
      if (effectiveRoles.length === 0) {
        throw new OidcAuthenticatorError(
          'NO_EFFECTIVE_ROLES',
          'the identity has no active role assignments that satisfy the assertion; a role-less principal cannot authenticate (fail-closed).',
        );
      }

      // (8) record-before-principal: AUTH_LOGIN durably, then return.
      await this.identityStore.appendEvent({
        id: randomUUID(),
        at: now,
        tenantId,
        kind: 'AUTH_LOGIN',
        principalId,
        resource: 'authentication',
        authority: { method: 'OIDC', authenticationEventId: requestId },
        decision: 'ALLOW',
        result: 'LOGIN',
        detail: `state=${identity.state} → ACTIVATED`,
      });

      const eventId = randomUUID();
      const principal: AuthenticatedPrincipal = {
        id: principalId,
        tenantId,
        roles: effectiveRoles,
        authenticationMethod: 'OIDC',
        verifiedAt: now,
        authenticationEventId: eventId,
        // claims.exp is epoch SECONDS (JWT numericdate); the boundary works
        // in epoch ms — convert at this boundary, exactly once.
        credentialExpiresAt: claims.exp * 1000,
        claims: {
          issuer: claims.iss,
          subject: claims.sub,
          ...(claims.authTime !== undefined ? { authTime: claims.authTime } : {}),
        },
      };
      return principal;
    } catch (error) {
      // Failure with a resolved tenant: record AUTH_FAILED (reason class
      // only — never material). If the record itself fails, the rejection
      // still stands (the denial is never downgraded to an audit problem).
      const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'AUTH_FAILED';
      try {
        await this.identityStore.appendEvent({
          id: randomUUID(),
          at: now,
          tenantId,
          kind: 'AUTH_FAILED',
          principalId,
          resource: 'authentication',
          decision: 'DENY',
          result: code,
        });
      } catch {
        // Audit of the failure is best-effort ONCE the rejection has been
        // decided; the rejection itself is never masked (fail-closed).
      }
      if (error instanceof PrincipalValidationError) throw error;
      throw new OidcAuthenticatorError('IDENTITY_STORE_UNAVAILABLE', `the durable identity store failed (${(error as Error).message}) (fail-closed).`);
    }
  }

  private mapJwtError(error: unknown): OidcAuthenticatorError {
    const candidate = error as { code?: unknown; message?: unknown };
    if (candidate && typeof candidate.code === 'string') {
      return new OidcAuthenticatorError(candidate.code, typeof candidate.message === 'string' ? candidate.message : 'JWT verification failed (fail-closed).');
    }
    const message = error instanceof Error ? error.message : String(error);
    return new OidcAuthenticatorError('JWT_MALFORMED', `JWT verification failed (${message}) (fail-closed).`);
  }
}
