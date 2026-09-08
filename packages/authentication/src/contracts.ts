// P1 (S8) — IDENTITY / SESSION SECURITY CONTRACTS.
//
// These are CONTRACTS ONLY. P1 defines the stable interfaces the production
// security composition depends on; P2 (separately authorized) implements:
// OIDC, OAuth, SSO, SAML, MFA, enrollment, account recovery, deprovisioning,
// privileged identity management, and ReBAC/PAM. Nothing in this file
// implements an identity provider, and nothing here grants authority.
//
// Contract rules:
//  * every implementation MUST fail closed (throw) rather than degrade to an
//    permissive default;
//  * no contract method ever returns secret material;
//  * implementations are admitted through the existing T-03 policy layer
//    (`resolveAuthenticationPolicy` / `PrincipalBoundary`), never around it.

import type { AuthenticatedPrincipal, PresentedCredential } from './types.js';

// ---------------------------------------------------------------------------
// Production authenticator contract
// ---------------------------------------------------------------------------

/**
 * The contract a PRODUCTION-grade `ServerAuthenticator` must satisfy beyond
 * the base interface. The shipped `StaticTokenAuthenticator` is explicitly
 * development/staging-scoped; a production composition under the P1 posture
 * admits only authenticators that declare conformance to this contract
 * (self-declaration — the operator remains accountable for the claim).
 */
export interface ProductionAuthenticatorContract {
  /** Stable authenticator id (audit records cite it). */
  readonly id: string;
  /**
   * True when this authenticator verifies cryptographic proof (signature,
 * mTLS certificate chain, or equivalent) rather than bare bearer equality.
   */
  readonly verifiesCryptographicProof: boolean;
  /**
   * True when verification validates issuer AND audience (aud) against an
   * explicitly configured allow-list. Bearer-table lookups are NOT
   * audience-validating.
   */
  readonly validatesIssuerAndAudience: boolean;
  /**
   * True when the authenticator refuses replayed assertions (jti/nonce
   * tracking or equivalent single-use semantics).
   */
  readonly replayResistant: boolean;
  /**
   * Health of the backing identity provider. Production compositions surface
   * this at boot and during operation (INV-14); `unavailable` MUST make
   * verification fail closed.
   */
  health(): Promise<IdentityProviderHealth>;
}

// ---------------------------------------------------------------------------
// Session lifecycle contract
// ---------------------------------------------------------------------------

/**
 * The session lifecycle the durable composition (R2 S-8 + P1 posture)
 * guarantees. The authoritative implementation is `AuthenticationEventStore`;
 * this contract states the semantics any future session substrate must keep:
 *
 *  - RECORD-BEFORE-PRINCIPAL: a session exists durably before any authority
 *    derived from it is handed out;
 *  - REVOCATION IS DURABLE AND CROSS-PROCESS: revocation is visible to every
 *    process without restart;
 *  - EXPIRY DENY-EARLIES: expiry comparisons apply the shared clock-skew
 *    bound (a session is expired when `now + skew >= expiresAt`);
 *  - NO PROCESS-LOCAL SESSION AUTHORITY: a store failure rejects the
 *    authentication/dispatch (fail-closed), never a memory fallback.
 */
export interface SessionLifecycleContract {
  readonly kind: 'session-lifecycle';
  /** Validate a session id for a tenant at a point in time (deny closed). */
  assertActive(sessionId: string, tenantId: string, now: number): Promise<void>;
  /** Revoke durably; visible cross-process; idempotent. */
  revoke(sessionId: string, tenantId: string, reason: string, now: number): Promise<void>;
  /** Durable session lifetime bounds enforced at record time. */
  readonly lifetimeBoundsMs: { readonly min: number; readonly max: number };
}

// ---------------------------------------------------------------------------
// Token lifecycle contract
// ---------------------------------------------------------------------------

/**
 * The token lifecycle the durable composition (R2 S-9 + P1 posture)
 * guarantees. The authoritative implementation is `TokenRegistryStore`:
 * fingerprints only (never material), revocation/rotation durable and
 * cross-process, rebind refused.
 */
export interface TokenLifecycleContract {
  readonly kind: 'token-lifecycle';
  /** Verify raw material against the durable fingerprint registry (deny closed). */
  verifyByMaterial(material: string, now: number, requestId: string): Promise<AuthenticatedPrincipal>;
  /** Revoke one registration by fingerprint (idempotent, durable). */
  revokeByFingerprint(fingerprint: string, reason: string, now: number): Promise<void>;
  /** Revoke every active registration for a principal (compromise path). */
  revokeByPrincipal(principalId: string, tenantId: string, reason: string, now: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Step-up authentication contract (P2 implements enforcement)
// ---------------------------------------------------------------------------

/**
 * A step-up requirement marker. High-impact authorization requests may carry
 * one; the boundary (P2) challenges the caller for fresh, stronger
 * authentication before the decision can become ALLOW. P1 defines only the
 * marker shape so manifests and policies can reference it stably.
 */
export interface StepUpRequirement {
  readonly kind: 'step-up';
  /** Maximum age of the step-up assertion to be honored (ms). */
  readonly maxAgeMs: number;
  /** Methods that satisfy the requirement (subset of admitted methods). */
  readonly satisfiedBy: readonly ('OIDC' | 'MTLS' | 'MFA')[];
}

/** A step-up-capable authenticator (P2 implements the challenge flow). */
export interface StepUpCapableAuthenticator {
  /** Initiate/verify a step-up assertion for an already-authenticated principal. */
  verifyStepUp(
    principal: AuthenticatedPrincipal,
    credential: PresentedCredential,
    requirement: StepUpRequirement,
    now: number,
  ): Promise<AuthenticatedPrincipal>;
}

// ---------------------------------------------------------------------------
// Identity-provider health (INV-14)
// ---------------------------------------------------------------------------

export interface IdentityProviderHealth {
  readonly status: 'healthy' | 'degraded' | 'unavailable';
  readonly checkedAt: number;
  /** Secret-free diagnostic (never credentials, tokens, or connection strings). */
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Principal lifecycle hooks (P2 implements the workflows)
// ---------------------------------------------------------------------------

/**
 * Hooks a future identity-lifecycle implementation (P2) must provide so the
 * security composition can react to provisioning/deprovisioning events.
 * P1 defines the shape only; the durable token registry's
 * `revokeByPrincipal` is the only currently wired consequence.
 */
export interface PrincipalLifecycleHooks {
  onProvisioned(principalId: string, tenantId: string, at: number): Promise<void>;
  onDeprovisioned(principalId: string, tenantId: string, reason: string, at: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Privileged identity boundary (P2 implements the plane)
// ---------------------------------------------------------------------------

/**
 * The boundary a privileged-identity plane (P2) must expose. The closed
 * actor-role vocabulary and the "system is never external" rule stay
 * authoritative where they are today; this contract is where break-glass,
 * just-in-time elevation, and privileged-session review will attach.
 */
export interface PrivilegedIdentityBoundary {
  readonly kind: 'privileged-identity-boundary';
  /** True when the principal currently holds a privileged designation. */
  isPrivileged(principal: AuthenticatedPrincipal, now: number): Promise<boolean>;
  /**
   * Assert the principal's privilege is currently valid (fresh step-up,
   * not revoked, within its elevation window); throws (deny) otherwise.
   */
  assertPrivilegeValid(principal: AuthenticatedPrincipal, now: number): Promise<void>;
}
