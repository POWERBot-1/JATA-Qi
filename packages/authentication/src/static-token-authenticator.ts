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

export class StaticTokenAuthenticator implements ServerAuthenticator {
  readonly id = 'static-token';
  readonly supports: readonly AuthenticationMethod[] = ['STATIC_TOKEN'];
  private readonly table: ReadonlyMap<string, StaticTokenRecord>;

  constructor(records: readonly StaticTokenRecord[]) {
    this.table = new Map(records.map((record) => [record.token, record]));
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
    };
  }
}
