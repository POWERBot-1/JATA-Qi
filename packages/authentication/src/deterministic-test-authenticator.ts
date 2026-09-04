// Deterministic test authenticator.
//
// Used by tests and local development to exercise the full principal boundary
// without any external identity provider. The authenticator is a pure,
// deterministic lookup keyed by the presented material: there is NO automatic
// fallback that would let unverified material through.
//
// It is NEVER acceptable to register this authenticator in a production
// composition root. The authenticator self-reports as DETERMINISTIC_TEST in
// the returned principal so a misconfigured deployment is visible in audit.

import { createHash, randomUUID } from 'node:crypto';
import type { CommercialActorRole } from '@jataqi/commercial-control-plane';
import {
  PrincipalValidationError,
  type AuthenticatedPrincipal,
  type AuthenticationMethod,
  type PresentedCredential,
  type ServerAuthenticator,
} from './types.js';

export interface TestPrincipalRecord {
  id: string;
  tenantId: string;
  roles: readonly CommercialActorRole[];
}

/**
 * Build a deterministic test authenticator from a fixed table of
 * principal records keyed by `material`. The material is treated as an
 * opaque token; production authenticators must verify signatures, this one
 * only does an exact-match lookup. The authenticator never issues tokens,
 * never mints ids, and never assigns roles it was not configured with.
 */
export class DeterministicTestAuthenticator implements ServerAuthenticator {
  readonly id = 'deterministic-test';
  readonly supports: readonly AuthenticationMethod[] = ['DETERMINISTIC_TEST'];
  private readonly table: ReadonlyMap<string, TestPrincipalRecord>;
  private readonly extraMethods = new Set<AuthenticationMethod>(['DETERMINISTIC_TEST']);

  constructor(records: readonly TestPrincipalRecord[]) {
    this.table = new Map(records.map((record) => [tokenFor(record), record]));
  }

  async verify(credential: PresentedCredential, now: number, requestId: string): Promise<AuthenticatedPrincipal> {
    if (!this.extraMethods.has(credential.method)) {
      throw new PrincipalValidationError(
        `Deterministic test authenticator does not support method "${credential.method}".`,
      );
    }
    if (typeof credential.material !== 'string' || credential.material.length === 0) {
      throw new PrincipalValidationError('A non-empty credential material is required.');
    }
    const record = this.table.get(credential.material);
    if (!record) {
      throw new PrincipalValidationError('Presented credential is not recognised by the test authenticator.');
    }
    if (!record.tenantId.trim()) {
      throw new PrincipalValidationError('Principal record is missing a tenant id (fail-closed).');
    }
    if (record.roles.length === 0) {
      throw new PrincipalValidationError('Principal record has no verified roles (fail-closed).');
    }
    return {
      id: record.id,
      tenantId: record.tenantId,
      roles: [...record.roles],
      authenticationMethod: 'DETERMINISTIC_TEST',
      verifiedAt: now,
      authenticationEventId: `${requestId}:${createHash('sha256').update(credential.material).digest('hex').slice(0, 16)}`,
    };
  }
}

/** Stable token for a test principal record (used as lookup key). */
export function tokenFor(record: TestPrincipalRecord): string {
  return `test:${record.id}@${record.tenantId}`;
}

/** Helper: build a `PresentedCredential` for the test authenticator. */
export function testCredential(record: TestPrincipalRecord): PresentedCredential {
  return { method: 'DETERMINISTIC_TEST', material: tokenFor(record) };
}

/** Convenience: random request id (correlation only). */
export function newRequestId(): string {
  return randomUUID();
}
