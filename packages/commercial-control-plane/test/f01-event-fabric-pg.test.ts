import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { isEventEnvelope, type EventEnvelope, type Kernel } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialControlPlaneService,
  type PublishCommercialEventInput,
} from '../src/index.js';

// F-01 real-PostgreSQL evidence: the CAS event sequencing (F-01c) and unified
// durable outbox (F-01d) run against an embedded real PostgreSQL backend
// (same pattern as the loop-host P-01 harness). The backend is a HARD
// requirement here: if PostgreSQL cannot start, the suite fails loudly rather
// than silently skipping PG integration.

let pg:
  | {
      server: EmbeddedPostgres;
      port: number;
      user: string;
      password: string;
      database: string;
    }
  | undefined;
let kernel: Kernel;
let service: CommercialControlPlaneService;
let admin: CommercialActor;
let now: number;

function eventInput(overrides: Partial<PublishCommercialEventInput> = {}): PublishCommercialEventInput {
  return {
    eventType: 'f01.pg.event',
    source: 'f01-pg-test',
    correlationId: 'corr-f01-pg',
    payload: { marker: 'f01-pg' },
    provenance: { source: 'f01-pg-test', collectedAt: now, correlationId: 'corr-f01-pg' },
    ...overrides,
  };
}

before(async () => {
  now = Date.now();
  admin = { id: 'admin-1', tenantId: 'acme', roles: ['admin'] };
  const port = 56100 + Math.floor(Math.random() * 800);
  const user = 'postgres';
  const password = 'postgres';
  const server = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), `jataqi-f01-pg-${process.pid}`),
    port,
    user,
    password,
    authMethod: 'password',
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ['--no-locale', '--encoding=UTF8'],
    postgresFlags: [],
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  const database = `f01_${process.pid}_${randomUUID().slice(0, 8)}`;
  await server.createDatabase(database);
  pg = { server, port, user, password, database };

  const driver = new PostgresDriver({
    connectionString: `postgres://${user}:${password}@127.0.0.1:${port}/${database}`,
    requireExplicitConfig: true,
    max: 10,
  });
  kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  await kernel.boot();
  service = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
});

after(async () => {
  if (pg) {
    await pg.server.dropDatabase(pg.database).catch(() => undefined);
    await pg.server.stop().catch(() => undefined);
    pg = undefined;
  }
});

describe('F-01 event fabric over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', async () => {
    assert.ok(pg, 'F-01 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('assigns unique contiguous per-tenant sequences under concurrent publish', async () => {
    const count = 20;
    const events = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        service.publishEvent(admin, eventInput({ idempotencyKey: `pg-conc-${index}` })),
      ),
    );
    const sequences = events.map((event) => event.sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, Array.from({ length: count }, (_, index) => index + 1));
  });

  it('persists a hash-chained unified outbox that verifies on PostgreSQL', async () => {
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'pg-o-1' }));
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'pg-o-2' }));
    await service.publishEvent(admin, eventInput({ idempotencyKey: 'pg-o-3' }));
    const replayed = await service.replayUnifiedOutbox(admin, {});
    assert.ok(replayed.length >= 3);
    const sequences = replayed.map((record) => record.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    for (const record of replayed) {
      assert.ok(isEventEnvelope(record.envelope));
      assert.equal(record.tenantId, 'acme');
    }
    const integrity = await service.verifyUnifiedOutboxIntegrity(admin);
    assert.equal(integrity.valid, true);
    assert.equal(integrity.entries, replayed.length);
  });

  it('idempotent republish yields one event and one outbox record on PostgreSQL', async () => {
    const input = eventInput({ idempotencyKey: 'pg-idem-once' });
    const first = await service.publishEvent(admin, input);
    const second = await service.publishEvent(admin, input);
    assert.equal(first.id, second.id);
    assert.equal(first.sequence, second.sequence);
    const matching = (await service.replayUnifiedOutbox(admin, {})).filter(
      (record) => record.eventId === first.id,
    );
    assert.equal(matching.length, 1);
  });

  it('detects payload tampering fail-closed on PostgreSQL', async () => {
    const event = await service.publishEvent(admin, eventInput({ idempotencyKey: 'pg-tamper-1' }));
    const before = await service.verifyUnifiedOutboxIntegrity(admin);
    assert.equal(before.valid, true);
    const storage = kernel.getModule<StorageModule>('storage');
    const records = await storage.collection<{ id: string; eventId: string; envelope: EventEnvelope }>(
      'commercial-control.unified-outbox',
    );
    const target = (await records.all()).find((record) => record.eventId === event.id);
    assert.ok(target);
    await records.put({
      ...target!,
      envelope: { ...target!.envelope, payload: { marker: 'forged-on-pg' } },
    });
    const afterTamper = await service.verifyUnifiedOutboxIntegrity(admin);
    assert.equal(afterTamper.valid, false);
    assert.match(afterTamper.reason ?? '', /hash does not match/);
  });
});
