import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import {
  AuthenticationEventStore,
  AuthenticationStoreError,
  DeterministicTestAuthenticator,
  PrincipalBoundary,
  PrincipalValidationError,
  testCredential,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

// R2 S-8 durable sessions over real PostgreSQL. Fail-hard: if PostgreSQL
// cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let storage: StorageModule;
let store: AuthenticationEventStore;
const T0 = Date.now();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;

before(async () => {
  pg = await bootR2Postgres('r2authn', 59100);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  store = await AuthenticationEventStore.open(storage);
});

after(async () => {
  await pg.stop();
});

describe('R2 S-8 durable sessions over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('records a session and reports it ACTIVE with no secret material persisted', async () => {
    const eventId = nextId('evt');
    const doc = await store.recordEvent(
      {
        eventId,
        tenantId: 'acme',
        principalId: 'user:alice',
        method: 'STATIC_TOKEN',
        verifiedAt: T0,
        expiresAt: T0 + 3_600_000,
      },
      T0,
    );
    assert.equal(doc.status, 'ACTIVE');
    assert.equal(doc.tenantId, 'acme');
    const assessment = await store.assertActive(eventId, 'acme', T0 + 1_000);
    assert.equal(assessment.active, true);
    // S-10: row carries provenance only — no credential/token material.
    const keys = Object.keys(doc).sort();
    assert.deepEqual(keys, [
      'createdAt',
      'expiresAt',
      'id',
      'method',
      'principalId',
      'status',
      'tenantId',
      'updatedAt',
      'verifiedAt',
    ]);
  });

  it('refuses to re-record a duplicate event id', async () => {
    const eventId = nextId('evt');
    const input = {
      eventId,
      tenantId: 'acme',
      principalId: 'user:alice',
      method: 'STATIC_TOKEN' as const,
      verifiedAt: T0,
      expiresAt: T0 + 3_600_000,
    };
    await store.recordEvent(input, T0);
    await assert.rejects(() => store.recordEvent(input, T0), AuthenticationStoreError);
  });

  it('revokes ACTIVE sessions, is idempotent, and rejects unknown ids', async () => {
    const eventId = nextId('evt');
    await store.recordEvent(
      {
        eventId,
        tenantId: 'acme',
        principalId: 'user:alice',
        method: 'STATIC_TOKEN',
        verifiedAt: T0,
        expiresAt: T0 + 3_600_000,
      },
      T0,
    );
    const revoked = await store.revokeEvent(eventId, 'acme', 'key-compromise', T0 + 5);
    assert.equal(revoked.status, 'REVOKED');
    const again = await store.revokeEvent(eventId, 'acme', 'key-compromise', T0 + 6);
    assert.equal(again.status, 'REVOKED');
    const assessment = await store.assertActive(eventId, 'acme', T0 + 7);
    assert.equal(assessment.active, false);
    assert.equal(assessment.status, 'REVOKED');
    await assert.rejects(
      () => store.revokeEvent(nextId('missing'), 'acme', 'nope', T0),
      AuthenticationStoreError,
    );
  });

  it('isolates sessions by tenant (cross-tenant read invisible, cross-tenant revoke refused)', async () => {
    const eventId = nextId('evt');
    await store.recordEvent(
      {
        eventId,
        tenantId: 'acme',
        principalId: 'user:alice',
        method: 'STATIC_TOKEN',
        verifiedAt: T0,
        expiresAt: T0 + 3_600_000,
      },
      T0,
    );
    assert.equal(await store.getEvent(eventId, 'other-tenant'), undefined);
    const cross = await store.assertActive(eventId, 'other-tenant', T0 + 1);
    assert.equal(cross.active, false);
    // Refusal surfaces fail-closed; the storage tenant boundary (driver)
    // rejects the cross-tenant CAS before the store predicate even runs.
    await assert.rejects(
      () => store.revokeEvent(eventId, 'other-tenant', 'hostile', T0 + 1),
      /cross-tenant|different tenant/i,
    );
    // The legitimate tenant's session is untouched by the hostile attempt.
    assert.equal((await store.assertActive(eventId, 'acme', T0 + 1)).active, true);
  });

  it('evaluates expiry on read (deny-early by the skew bound) and supports the EXPIRED flip', async () => {
    const eventId = nextId('evt');
    await store.recordEvent(
      {
        eventId,
        tenantId: 'acme',
        principalId: 'user:alice',
        method: 'STATIC_TOKEN',
        verifiedAt: T0,
        expiresAt: T0 + 3_600_000,
      },
      T0,
    );
    assert.equal((await store.assertActive(eventId, 'acme', T0 + 1)).active, true);
    // At expiresAt the skew bound already denies on read (no flip needed).
    const atEdge = await store.assertActive(eventId, 'acme', T0 + 3_600_000);
    assert.equal(atEdge.active, false);
    assert.equal(atEdge.status, 'EXPIRED');
    const flipped = await store.markExpired(eventId, 'acme', T0 + 3_600_000);
    assert.equal(flipped?.status, 'EXPIRED');
  });

  it('records the session BEFORE PrincipalBoundary returns the principal', async () => {
    const record = { id: 'user:bob', tenantId: 'acme', roles: ['operator'] as const };
    const boundary = new PrincipalBoundary({
      policy: { mode: 'test-only', allowTestMethod: true },
      authenticators: [new DeterministicTestAuthenticator([record])],
      eventStore: store,
      sessionLifetimeMs: 3_600_000,
      now: () => T0,
    });
    const principal = await boundary.authenticate(testCredential(record));
    const row = await store.getEvent(principal.authenticationEventId, 'acme');
    assert.ok(row, 'session row must exist once authenticate resolves');
    assert.equal(row?.principalId, 'user:bob');
    assert.equal(row?.status, 'ACTIVE');
    assert.equal(row?.expiresAt, T0 + 3_600_000);
  });

  it('rejects the authentication when the durable session cannot be recorded', async () => {
    const record = { id: 'user:carol', tenantId: 'acme', roles: ['operator'] as const };
    const boundary = new PrincipalBoundary({
      policy: { mode: 'test-only', allowTestMethod: true },
      authenticators: [new DeterministicTestAuthenticator([record])],
      eventStore: store,
      sessionLifetimeMs: 3_600_000,
      now: () => T0,
      // Fixed request id: the second authenticate mints the same event id,
      // the insert-once record fails, and the authentication must reject.
      newRequestId: () => `fixed-${process.pid}-carol`,
    });
    await boundary.authenticate(testCredential(record));
    await assert.rejects(() => boundary.authenticate(testCredential(record)), PrincipalValidationError);
  });

  it('refuses to open over a non-transactional (memory) source', async () => {
    const { createTestKernel } = await import('@jataqi/core-kernel/testing');
    const kernel = createTestKernel();
    const memory = new StorageModule();
    kernel.register(memory);
    await kernel.boot();
    await assert.rejects(() => AuthenticationEventStore.open(memory), AuthenticationStoreError);
  });
});
