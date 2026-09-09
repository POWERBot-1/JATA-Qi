// Static token authenticator.
//
// A minimal authenticator that maps opaque static tokens to a fixed set of
// verified principals. Suitable for development, staging, and CI; NOT for
// production traffic. Production deployments must swap this for an OIDC or
// mTLS authenticator and gate activation behind a separate authorization
// decision (out of T-01 scope).
//
// The authenticator is "fail-closed by default": unknown tokens, wrong
// methods, and misconfigured records all reject. It never mints tokens and
// never issues roles it was not configured with.

import { createHash } from 'node:crypto';
import type { CommercialActorRole } from '@jataqi/commercial-control-plane';
import {
  PrincipalValidationError,
  type AuthenticatedPrincipal,
  type AuthenticationMethod,
  type PresentedCredential,
  type ServerAuthenticator,
} from './types.js';
import type { TokenRegistryStore } from './token-registry.js';
import type { IdentityStore } from './identity-store.js';

export interface StaticTokenRecord {
  /** Opaque token material (bearer, API key, etc.). */
  readonly token: string;
  /** Verified principal id. */
  readonly principalId: string;
  /** Verified tenant id. */
  readonly tenantId: string;
  /** Verified role set. */
  readonly roles: readonly CommercialActorRole[];
  /**
   * Optional expiry timestamp (ms). When set, the authenticator rejects
   * expired tokens. Defaults to no expiry.
   */
  readonly expiresAt?: number;
}

export interface StaticTokenAuthenticatorOptions {
  /**
   * R2 S-9: when attached, verification consults the durable shared
   * registry (revocation/rotation visible across processes) INSTEAD of
   * the constructor table. The table is still required (fail-closed
   * configuration) but is not consulted on the durable path.
   */
  readonly registry?: TokenRegistryStore;
}

export class StaticTokenAuthenticator implements ServerAuthenticator {
  readonly id = 'static-token';
  readonly supports: readonly AuthenticationMethod[] = ['STATIC_TOKEN'];
  private readonly table: ReadonlyMap<string, StaticTokenRecord>;
  private readonly registry?: TokenRegistryStore;

  constructor(records: readonly StaticTokenRecord[], options: StaticTokenAuthenticatorOptions = {}) {
    this.table = new Map(records.map((record) => [record.token, record]));
    this.registry = options.registry;
  }

  async verify(credential: PresentedCredential, now: number, requestId: string): Promise<AuthenticatedPrincipal> {
    if (credential.method !== 'STATIC_TOKEN') {
      throw new PrincipalValidationError(
        `Static token authenticator does not support method "${credential.method}".`,
      );
    }
    if (typeof credential.material !== 'string' || credential.material.length === 0) {
      throw new PrincipalValidationError('A non-empty token is required.');
    }
    if (this.registry) {
      // R2 durable path: shared registry verdict (revocation-aware).
      return this.registry.verifyByMaterial(credential.material, now, requestId);
    }
    const record = this.table.get(credential.material);
    if (!record) {
      throw new PrincipalValidationError('Presented token is not recognised.');
    }
    if (record.expiresAt !== undefined && record.expiresAt <= now) {
      throw new PrincipalValidationError('Presented token has expired.');
    }
    if (!record.tenantId.trim()) {
      throw new PrincipalValidationError('Static token record is missing a tenant id (fail-closed).');
    }
    if (record.roles.length === 0) {
      throw new PrincipalValidationError('Static token record has no verified roles (fail-closed).');
    }
    return {
      id: record.principalId,
      tenantId: record.tenantId,
      roles: [...record.roles],
      authenticationMethod: 'STATIC_TOKEN',
      verifiedAt: now,
      authenticationEventId: `${requestId}:${createHash('sha256').update(credential.material).digest('hex').slice(0, 16)}`,
      ...(record.expiresAt !== undefined ? { credentialExpiresAt: record.expiresAt } : {}),
    };
  }
}

/**
 * P2-S1 — auto-linked static-token authenticator (spec §21.1).
 *
 * Wraps a durable-registry `StaticTokenAuthenticator`: on every SUCCESSFUL
 * registry verification, the verified (principalId, tenantId, roles) triple
 * is idempotently auto-linked into the durable identity core
 * (`IdentityStore.autoLinkTokenPrincipal`) BEFORE the principal is returned.
 *
 * The link is fail-closed: if the identity is terminal (DEACTIVATED /
 * DEPROVISIONED), or the principal id is already bound to another tenant,
 * the authentication is REFUSED — a static credential bound to a dead or
 * foreign identity cannot authenticate. Repeat verification of the same
 * binding is idempotent (one stable relationship, no new records).
 */
export class AutoLinkedStaticTokenAuthenticator implements ServerAuthenticator {
  readonly id = 'static-token:auto-linked';
  readonly supports: readonly AuthenticationMethod[] = ['STATIC_TOKEN'];

  constructor(
    private readonly inner: StaticTokenAuthenticator,
    private readonly identityStore: IdentityStore,
    private readonly importedBy: string,
  ) {
    if (!identityStore) {
      throw new PrincipalValidationError('AutoLinkedStaticTokenAuthenticator requires a durable IdentityStore (fail-closed).');
    }
  }

  async verify(credential: PresentedCredential, now: number, requestId: string): Promise<AuthenticatedPrincipal> {
    // 1. Verify against the durable registry (revocation/rotation-aware).
    const principal = await this.inner.verify(credential, now, requestId);
    // 2. Idempotent auto-link into the identity core (fail-closed: a
    //    terminal/foreign identity refuses the credential).
    await this.identityStore.autoLinkTokenPrincipal(
      principal.id,
      principal.tenantId,
      principal.roles,
      this.importedBy,
      now,
    );
    return principal;
  }
}
