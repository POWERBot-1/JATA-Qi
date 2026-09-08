// P1 (S2) — AUTHENTICATION MODULE FACTORY SEAM.
//
// Proves the production authentication wiring primitive: authenticators can
// be constructed AFTER the durable stores open, against the durable S-9
// token registry (fingerprints only), so revocation is visible across
// processes and the plaintext constructor table is never the verification
// path. Also proves the fail-closed factory rules.
//
// Fail-hard: if PostgreSQL cannot start, before() rejects and the suite
// FAILS (no skip).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { bootR2Postgres, type R2Postgres } from './r2-pg.js';
import {
  AuthenticationModule,
  StaticTokenAuthenticator,
  TokenRegistryStore,
  AuthenticationEventStore,
  type StaticTokenRecord,
} from '../src/index.js';

let pg: R2Postgres;

before(async () => {
  pg = await bootR2Postgres('p1-authfactory', 56600);
});

after(async () => {
  if (pg) await pg.stop();
});

function storageModule(): StorageModule {
  return new StorageModule({
    driverInstance: new PostgresDriver({ connectionString: pg.connectionString, requireExplicitConfig: true, max: 4 }),
  });
}

const TOKEN = 'p1-factory-secret-token';
const RECORDS: readonly StaticTokenRecord[] = [
  { token: TOKEN, principalId: 'p1-user', tenantId: 'acme', roles: ['agent'] },
];

describe('P1 authentication factory seam (S2)', () => {
  it('constructs authenticators against the durable S-9 registry (factory path)', async () => {
    const kernel = createTestKernel();
    kernel.register(storageModule());
    const module = new AuthenticationModule({
      durableSessions: { enabled: true },
      policy: { mode: 'production' },
      authenticatorFactory: async (stores) => {
        assert.ok(stores.tokenRegistry, 'the durable registry must be available to the factory');
        assert.ok(stores.sessionStore, 'the durable session store must be available to the factory');
        await stores.tokenRegistry.importRecords(RECORDS, 'p1-test', Date.now());
        return [new StaticTokenAuthenticator([], { registry: stores.tokenRegistry })];
      },
    });
    kernel.register(module);
    await kernel.boot();

    const boundary = module.getService();
    assert.deepEqual(boundary.listAuthenticatorIds(), ['static-token']);

    // Verification goes through the durable registry (fingerprint), not a table.
    const principal = await boundary.authenticate({ method: 'STATIC_TOKEN', material: TOKEN });
    assert.equal(principal.id, 'p1-user');
    assert.equal(principal.tenantId, 'acme');

    // DURABLE REVOCATION: revoke by principal through the registry, then the
    // SAME boundary (and any other process) must refuse the token.
    const registry = module.getTokenRegistry();
    const fingerprint = AuthenticationEventStore.fingerprint(TOKEN);
    const revoked = await registry.revokeByFingerprint(fingerprint, 'p1-test-revocation', Date.now());
    assert.equal(revoked.status, 'REVOKED');
    await assert.rejects(
      () => boundary.authenticate({ method: 'STATIC_TOKEN', material: TOKEN }),
      /revoked/,
    );
    await kernel.shutdown().catch(() => undefined);
  });

  it('a SECOND composition over the same database sees the revocation (cross-process visibility)', async () => {
    const token = 'p1-factory-second-token';
    const records: readonly StaticTokenRecord[] = [
      { token, principalId: 'p1-user-2', tenantId: 'acme', roles: ['agent'] },
    ];
    // Composition A imports and authenticates.
    const kernelA = createTestKernel();
    kernelA.register(storageModule());
    const moduleA = new AuthenticationModule({
      durableSessions: { enabled: true },
      policy: { mode: 'production' },
      authenticatorFactory: async (stores) => {
        await stores.tokenRegistry!.importRecords(records, 'p1-a', Date.now());
        return [new StaticTokenAuthenticator([], { registry: stores.tokenRegistry! })];
      },
    });
    kernelA.register(moduleA);
    await kernelA.boot();
    const boundaryA = moduleA.getService();
    const principal = await boundaryA.authenticate({ method: 'STATIC_TOKEN', material: token });
    assert.equal(principal.id, 'p1-user-2');

    // Composition B (independent storage module/pool = process-fan-out
    // equivalent; the true two-process proof is in the CLI P1 suite) opens
    // the same durable registry and must see A's revocation.
    const kernelB = createTestKernel();
    kernelB.register(storageModule());
    await kernelB.boot();
    const registryB = await TokenRegistryStore.open(kernelB.getModule('storage') as never);
    const fingerprint = AuthenticationEventStore.fingerprint(token);
    await registryB.revokeByFingerprint(fingerprint, 'revoked-by-B', Date.now());

    // A's boundary (registry-backed) now refuses the token without restart.
    await assert.rejects(
      () => boundaryA.authenticate({ method: 'STATIC_TOKEN', material: token }),
      /revoked/,
    );
    await kernelA.shutdown().catch(() => undefined);
  });

  it('FAILS CLOSED: factory combined with an explicit authenticators array is an error', async () => {
    const kernel = createTestKernel();
    kernel.register(storageModule());
    const module = new AuthenticationModule({
      durableSessions: { enabled: true },
      policy: { mode: 'production' },
      authenticators: [],
      authenticatorFactory: () => [],
    });
    kernel.register(module);
    await assert.rejects(
      () => kernel.boot(),
      /authenticatorFactory cannot be combined with an explicit authenticators array/,
    );
    await kernel.shutdown().catch(() => undefined);
  });

  it('FAILS CLOSED: a factory that cannot operate durably aborts boot', async () => {
    const kernel = createTestKernel();
    kernel.register(storageModule());
    const module = new AuthenticationModule({
      durableSessions: { enabled: true },
      policy: { mode: 'production' },
      authenticatorFactory: async () => {
        throw new Error('no durable registry available (fail-closed)');
      },
    });
    kernel.register(module);
    await assert.rejects(() => kernel.boot(), /no durable registry available/);
    await kernel.shutdown().catch(() => undefined);
  });
});
