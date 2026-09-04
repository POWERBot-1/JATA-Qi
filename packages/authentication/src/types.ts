// T-01 Authenticated server-side principal boundary.
//
// This module defines the SERVER-SIDE authentication surface that derives
// every principal/tenant/role used by the JATA Qi governance and authority
// layers. The contract is deliberately strict:
//
//   * Production request paths MUST NOT pass caller-supplied actor objects
//     directly to the unified loop or commercial control plane. They MUST
//     authenticate a presented credential against a registered
//     ServerAuthenticator and obtain an AuthenticatedPrincipal from it.
//   * The AuthenticatedPrincipal carries an authenticationMethod
//     (`DETERMINISTIC_TEST`, `STATIC_TOKEN`, `OIDC`, `MTLS`, ...) and a
//     `verifiedAt` timestamp; both are recorded in the audit trace so a
//     forged `CommercialActor` is structurally impossible to confuse with a
//     server-verified one.
//   * The role set returned by the authenticator is the authoritative set:
//     callers may only narrow (filter to a subset they declare they need),
//     never widen.
//   * Live identity provider activation is explicitly gated. The
//     authentication module ships only with a `DeterministicTestAuthenticator`
//     and a `StaticTokenAuthenticator`; an `OidcAuthenticator` exists as a
//     type-only contract and a future-milestone delivery — wiring one is a
//     separate authorization gate and is NOT performed by T-01.
//
// No live identity provider is required by T-01. The architectural boundary
// is what is being installed; provider activation is out of scope.

import type { CommercialActor, CommercialActorRole } from '@jataqi/commercial-control-plane';

/**
 * The set of authentication methods the JATA Qi server-side principal
 * boundary recognises. Any presented credential whose authenticator is not
 * one of these methods MUST be rejected at the boundary. The list is closed
 * and the type union is exhaustive on purpose.
 */
export type AuthenticationMethod =
  | 'DETERMINISTIC_TEST' // explicit test authenticator; tests only
  | 'STATIC_TOKEN'      // static token; development / staging only
  | 'OIDC'              // OpenID Connect; provider activation is gated
  | 'MTLS'              // mTLS client certificate; provider activation is gated
  | 'KERNEL_INTERNAL';  // kernel-internal system actor; never a user request

/**
 * A presented credential. The request boundary is responsible for collecting
 * these from the wire (HTTP headers, mTLS peer certs, OAuth bearer tokens,
 * etc.) and handing them to the authenticator. The principal boundary never
 * inspects raw headers itself.
 */
export interface PresentedCredential {
  /**
   * Method used to convey the credential. The authenticator validates that
   * the method is one it can verify; mismatches are rejected.
   */
  readonly method: AuthenticationMethod;
  /** Raw credential material (e.g. bearer token, JWT, peer cert DER). */
  readonly material: string;
  /**
   * Optional channel-specific metadata (issuer, audience, mTLS SAN, JWT kid,
   * ...). Authenticators may use it to narrow verification; production
   * authenticators should validate it against pinned values.
   */
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * The validated, server-side principal. This is the ONLY object that
 * downstream governance, authority, and audit layers may trust as a caller
 * identity. A `CommercialActor` is reachable only as a derived projection of
 * this object; the principal carries the extra metadata the actor does not.
 */
export interface AuthenticatedPrincipal {
  /** Stable principal id (subject claim for OIDC, principal name for static tokens). */
  readonly id: string;
  /** Server-verified tenant id. */
  readonly tenantId: string;
  /** Server-asserted role set. Callers may only narrow; never widen. */
  readonly roles: readonly CommercialActorRole[];
  /** The authentication method that verified this principal. */
  readonly authenticationMethod: AuthenticationMethod;
  /** Server-side verification timestamp (ms). */
  readonly verifiedAt: number;
  /**
   * Server-side correlation/audit id for this authentication event. Surface
   * this in audit traces so a forged actor is impossible to confuse with a
   * real one.
   */
  readonly authenticationEventId: string;
  /**
   * Optional underlying subject metadata (issuer, subject, claims subset).
   * Authenticators decide what is safe to expose; downstream code MUST NOT
   * trust this for authorization.
   */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * The authenticator contract. Implementations verify a `PresentedCredential`
 * against a trusted source and return an `AuthenticatedPrincipal`. A live
 * identity provider implements this interface; the `DeterministicTest`
 * authenticator implements it without any external dependency so unit and
 * integration tests can exercise the full principal boundary without network
 * access.
 */
export interface ServerAuthenticator {
  /** Stable authenticator id (e.g. "deterministic-test", "oidc-acme"). */
  readonly id: string;
  /** Authentication methods this authenticator can verify. */
  readonly supports: readonly AuthenticationMethod[];
  /**
   * Verify a presented credential. Throws `PrincipalValidationError` on
   * failure for any reason (unknown subject, expired, signature invalid,
   * missing tenant, insufficient evidence, etc.). Returns the verified
   * principal on success.
   */
  verify(credential: PresentedCredential, now: number, requestId: string): Promise<AuthenticatedPrincipal>;
}

/**
 * Project an authenticated principal to a `CommercialActor` (the shape the
 * control plane and unified loop consume). This is a one-way projection:
 * the principal metadata is preserved separately in the audit trace; the
 * actor only carries the trust-relevant fields.
 *
 * `requestedRoles` lets a caller narrow the principal's role set to a
 * declared set (default: all). Widening is structurally impossible — the
 * function throws if a requested role is not in the principal's verified
 * role set.
 */
export function projectToActor(
  principal: AuthenticatedPrincipal,
  requestedRoles?: readonly CommercialActorRole[],
): CommercialActor {
  const roles = requestedRoles ?? principal.roles;
  for (const role of roles) {
    if (!principal.roles.includes(role)) {
      throw new PrincipalValidationError(
        `Role "${role}" is not in the authenticated principal's verified role set; widening is not permitted.`,
      );
    }
  }
  return {
    id: principal.id,
    tenantId: principal.tenantId,
    roles: [...roles],
  };
}

/** Server-side principal boundary error: any rejection from the authenticator. */
export class PrincipalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrincipalValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Rejection when no authenticator supports the presented method. */
export class UnsupportedAuthenticationMethodError extends PrincipalValidationError {
  constructor(method: string) {
    super(`Authentication method "${method}" is not supported by any registered authenticator.`);
    this.name = 'UnsupportedAuthenticationMethodError';
  }
}

/** Rejection when an authentication event cannot be correlated for audit. */
export class UnauthenticatedRequestError extends PrincipalValidationError {
  constructor(reason: string) {
    super(`Request lacks a valid server-side principal: ${reason}`);
    this.name = 'UnauthenticatedRequestError';
  }
}
