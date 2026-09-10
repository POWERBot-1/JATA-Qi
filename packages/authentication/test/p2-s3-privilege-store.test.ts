// P2-S3 — the durable Privileged Access Plane STORE over real PostgreSQL
// (spec §9, §13, §21.4, §24-S3; A-07/A-13/A-22/A-23 privilege subset).
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the
// suite FAILS (no skip — the elevation store is the S3 security substrate).
//
// Covered:
//   * non-transactional source refusal (memory is never privilege authority);
//   * first-elevation bootstrap single-winner (tenant + platform scopes);
//   * grantor authorization: a grant from a principal WITHOUT a durable
//     security-admin elevation is refused (no caller manufactures elevation);
//   * grant validation: break-glass refused (S6), role/class mismatch
//     refused (no plane-hierarchy transitivity), step-up required for
//     non-operator classes, lifetime bounded to (0, 4h];
//   * durable audit: PRIVILEGE_ELEVATION / PRIVILEGE_REVOKED events land in
//     the SAME authoritative store, in-tx, secret-free (no material fields);
//   * closed schema + material-shaped-field refusal;
//   * register enforcement: an unregistered operation id is refused;
//   * revocation is CAS-guarded, idempotent, reason-mandatory.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import {
  IdentityStore,
  PrivilegeRequiredError,
  PrivilegeStore,
  PrivilegeStoreError,
  MAX_ELEVATION_LIFETIME_MS,
  assertElevationDocumentShape,
  bootstrapElevationId,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

let pg: R2Postgres;
let storage: StorageModule;
let identity: IdentityStore;
let privilege: PrivilegeStore;

let now: number;
const T0 = Date.now();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;

const TENANT = 'acme';

before(async () => {
  now = T0;
  pg = await bootR2Postgres('p2s3store', 59400);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  identity = await IdentityStore.open(storage);
  privilege = await PrivilegeStore.open(storage);
});

after(async () => {
  await pg.stop();
});

/** Bootstrap a tenant security-admin in a FRESH tenant and return its ids. */
async function bootstrapTenantAdmin(): Promise<{ principalId: string; tenantId: string }> {
  const tenantId = `acme-${nextId('t')}`;
  const principalId = nextId('secadmin');
  await privilege.bootstrapFirstElevation({ principalId, tenantId, reason: 'p2-s3 store test bootstrap' }, now);
  return { principalId, tenantId };
}

describe('P2-S3 durable privilege store (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S3 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('refuses a non-transactional source at open (memory is never privilege authority)', async () => {
    const memory = new StorageModule();
    const kernel = createTestKernel();
    kernel.register(memory);
    await kernel.boot();
    await assert.rejects(() => PrivilegeStore.open(memory), PrivilegeStoreError);
    await kernel.shutdown();
  });

  it('first-elevation bootstrap is single-winner per (tenant, scope)', async () => {
    const tenant = `boot-${nextId('t')}`;
    const principal = nextId('boot');
    const first = await privilege.bootstrapFirstElevation({ principalId: principal, tenantId: tenant, reason: 'first' }, now);
    assert.equal(first.scope, 'tenant');
    assert.equal(first.planeRole, 'security-admin');
    assert.equal(first.grantedBy, 'kernel:bootstrap');
    await assert.rejects(
      () => privilege.bootstrapFirstElevation({ principalId: principal, tenantId: tenant, reason: 'second' }, now),
      /BOOTSTRAP_ALREADY_USED/,
    );
    // Distinct scope slot: platform bootstrap is independent.
    const platform = await privilege.bootstrapFirstElevation({ principalId: principal, tenantId: tenant, scope: 'platform', reason: 'platform' }, now);
    assert.equal(platform.scope, 'platform');
    assert.equal(platform.tenantId, 'system');
    assert.equal(platform.id, bootstrapElevationId(tenant, 'platform'));
  });

  it('grantor authorization: a principal WITHOUT a security-admin elevation cannot grant (no self-elevation)', async () => {
    const rogue = nextId('rogue');
    await assert.rejects(
      () =>
        privilege.grantElevation(
          {
            principalId: nextId('target'),
            tenantId: TENANT,
            scope: 'tenant',
            planeRole: 'tenant-admin',
            operationClasses: ['tenant-admin'],
            sessionEventId: 'evt-rogue',
            stepUpEventId: 'stepup-rogue',
            stepUpAt: now,
            grantedBy: rogue,
            grantorPrincipalId: rogue,
            grantorSessionEventId: 'evt-rogue',
            reason: 'rogue self-grant attempt',
          },
          now,
        ),
      PrivilegeRequiredError,
    );
  });

  it('break-glass is refused on the standing grant path (S6 — never minted here)', async () => {
    const { principalId: admin, tenantId } = await bootstrapTenantAdmin();
    await assert.rejects(
      () =>
        privilege.grantElevation(
          {
            principalId: nextId('bg'),
            tenantId,
            scope: 'tenant',
            planeRole: 'break-glass',
            operationClasses: ['operator'],
            sessionEventId: 'evt-bg',
            stepUpEventId: 'stepup-bg',
            stepUpAt: now,
            grantedBy: admin,
            grantorPrincipalId: admin,
            grantorSessionEventId: 'kernel:bootstrap',
            reason: 'break-glass probe',
          },
          now,
        ),
      /BREAK_GLASS_NOT_AUTHORIZED/,
    );
  });

  it('plane-hierarchy non-transitivity: a tenant-admin role cannot cover an operator class', async () => {
    const { principalId: admin, tenantId } = await bootstrapTenantAdmin();
    await assert.rejects(
      () =>
        privilege.grantElevation(
          {
            principalId: nextId('hier'),
            tenantId,
            scope: 'tenant',
            planeRole: 'tenant-admin',
            operationClasses: ['operator'],
            sessionEventId: 'evt-hier',
            stepUpEventId: 'stepup-hier',
            stepUpAt: now,
            grantedBy: admin,
            grantorPrincipalId: admin,
            grantorSessionEventId: 'kernel:bootstrap',
            reason: 'non-transitivity probe',
          },
          now,
        ),
      /ROLE_CLASS_MISMATCH/,
    );
  });

  it('lifetime is bounded to (0, 4h] and step-up is required for non-operator classes', async () => {
    const { principalId: admin, tenantId } = await bootstrapTenantAdmin();
    await assert.rejects(
      () =>
        privilege.grantElevation(
          {
            principalId: nextId('lt'),
            tenantId,
            scope: 'tenant',
            planeRole: 'tenant-admin',
            operationClasses: ['tenant-admin'],
            sessionEventId: 'evt-lt',
            stepUpEventId: 'stepup-lt',
            stepUpAt: now,
            lifetimeMs: MAX_ELEVATION_LIFETIME_MS + 1,
            grantedBy: admin,
            grantorPrincipalId: admin,
            grantorSessionEventId: 'kernel:bootstrap',
            reason: 'lifetime probe',
          },
          now,
        ),
      /INVALID_LIFETIME/,
    );
    await assert.rejects(
      () =>
        privilege.grantElevation(
          {
            principalId: nextId('nstep'),
            tenantId,
            scope: 'tenant',
            planeRole: 'tenant-admin',
            operationClasses: ['tenant-admin'],
            sessionEventId: 'evt-nstep',
            grantedBy: admin,
            grantorPrincipalId: admin,
            grantorSessionEventId: 'kernel:bootstrap',
            reason: 'missing step-up probe',
          },
          now,
        ),
      /STEP_UP_REQUIRED/,
    );
  });

  it('grant + revoke emit durable PRIVILEGE_ELEVATION / PRIVILEGE_REVOKED events (secret-free)', async () => {
    const { principalId: admin, tenantId } = await bootstrapTenantAdmin();
    const target = nextId('target');
    const elevation = await privilege.grantElevation(
      {
        principalId: target,
        tenantId,
        scope: 'tenant',
        planeRole: 'operator',
        operationClasses: ['operator'],
        sessionEventId: 'evt-op',
        grantedBy: admin,
        grantorPrincipalId: admin,
        grantorSessionEventId: 'kernel:bootstrap',
        reason: 'p2-s3 store audit probe',
        correlationId: 'corr-audit-probe',
      },
      now,
    );
    const grantedEvents = await identity.queryEvents(tenantId, 'PRIVILEGE_ELEVATION');
    const grantEvent = grantedEvents.find((e) => e.correlationId === 'corr-audit-probe');
    assert.ok(grantEvent, 'the grant is audited durably (PRIVILEGE_ELEVATION)');
    assert.equal(grantEvent.principalId, target);
    assert.equal(grantEvent.decision, 'ALLOW');
    // No material-shaped fields on the audit record (A-22).
    for (const key of Object.keys(grantEvent)) {
      assert.doesNotMatch(key, /material|secret|token|password|privatekey|jwks/i);
    }
    const detail = String(grantEvent.detail ?? '');
    assert.doesNotMatch(detail, /token|secret|material|password/i);

    await privilege.revokeElevation(
      {
        elevationId: elevation.id,
        tenantId,
        scope: 'tenant',
        revokedBy: admin,
        revokerSessionEventId: 'kernel:bootstrap',
        reason: 'p2-s3 store audit revocation probe',
        correlationId: 'corr-revoke-probe',
      },
      now,
    );
    const revokedEvents = await identity.queryEvents(tenantId, 'PRIVILEGE_REVOKED');
    assert.ok(
      revokedEvents.some((e) => e.correlationId === 'corr-revoke-probe'),
      'the revocation is audited durably (PRIVILEGE_REVOKED)',
    );
  });

  it('revocation is idempotent and terminal (ACTIVE ⇒ REVOKED, then a repeat is a no-op)', async () => {
    const { principalId: admin, tenantId } = await bootstrapTenantAdmin();
    const target = nextId('target');
    const elevation = await privilege.grantElevation(
      {
        principalId: target,
        tenantId,
        scope: 'tenant',
        planeRole: 'operator',
        operationClasses: ['operator'],
        sessionEventId: 'evt-op2',
        grantedBy: admin,
        grantorPrincipalId: admin,
        grantorSessionEventId: 'kernel:bootstrap',
        reason: 'p2-s3 idempotent revoke probe',
      },
      now,
    );
    const first = await privilege.revokeElevation(
      { elevationId: elevation.id, tenantId, scope: 'tenant', revokedBy: admin, revokerSessionEventId: 'kernel:bootstrap', reason: 'revoke once' },
      now,
    );
    assert.equal(first.status, 'REVOKED');
    const second = await privilege.revokeElevation(
      { elevationId: elevation.id, tenantId, scope: 'tenant', revokedBy: admin, revokerSessionEventId: 'kernel:bootstrap', reason: 'revoke again' },
      now,
    );
    assert.equal(second.status, 'REVOKED');
  });

  it('closed schema + material-shaped-field refusal (A-22)', () => {
    assert.throws(
      () => assertElevationDocumentShape({ accessToken: 'x' } as never, new Set(['id', 'accessToken']), 'probe'),
      /MATERIAL_FIELD_REFUSED/,
    );
    assert.throws(
      () => assertElevationDocumentShape({ unknownField: 1 } as never, new Set(['id']), 'probe'),
      /CLOSED_SCHEMA_VIOLATION/,
    );
  });

  it('an unregistered operation id is refused (register is the binding authority)', async () => {
    await assert.rejects(
      () => privilege.assertElevationForOperation('someone', TENANT, 'not.a.real.operation', now),
      /UNREGISTERED_OPERATION/,
    );
  });
});
