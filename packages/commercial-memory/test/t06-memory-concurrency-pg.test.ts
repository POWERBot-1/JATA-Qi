// T-06 commercial-memory sequence integrity over REAL PostgreSQL with REAL OS
// processes (Workstream B).
//
//   * two concurrent processes recording for the same tenant;
//   * three concurrent processes recording for the same tenant;
//   * two concurrent processes on DIFFERENT tenants keep fully independent
//     per-tenant sequences;
//   * a process SIGKILLed mid-composed-write (crash recovery: record AND
//     sequence allocation roll back together);
//   * rollback correctness (injected failure) and retry correctness;
//   * final chain verification via the service's `verifyIntegrity`.
//
// Every record runs the PRODUCTION path (`CommercialMemoryService.record`
// inside a tenant-bound `StorageModule.atomically` with a CAS-advanced
// per-tenant sequence counter — never a weaker query-then-write scheme).
//
// PostgreSQL is a HARD requirement (no silent skip).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { CommercialControlPlaneModule, type CommercialActor, type CommercialEvidence } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { CommercialMemoryModule, type CommercialMemoryRecord } from '../src/index.js';
import type { CommercialMemoryService } from '../src/index.js';

let pg: { server: EmbeddedPostgres; port: number; started: boolean } | undefined;
let dbCounter = 0;
let clusterDir: string;

/** O-3 lifecycle hygiene: remove the pid-named cluster dir on teardown
 * (`persistent: true` embedded-postgres never removes it). Best-effort. */
function removeClusterDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — never fail the suite over teardown.
  }
}

before(async () => {
  const port = 59700 + Math.floor(Math.random() * 200);
  clusterDir = path.join(os.tmpdir(), `jataqi-t06-memory-pg-${process.pid}`);
  const server = new EmbeddedPostgres({
    databaseDir: clusterDir,
    port,
    user: 'postgres',
    password: 'postgres',
    authMethod: 'password',
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ['--no-locale', '--encoding=UTF8'],
    postgresFlags: [],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await server.initialise();
    await server.start();
    pg = { server, port, started: true };
  } catch (error) {
    console.warn('[t06-memory-pg] PostgreSQL unavailable:', String((error as Error)?.message ?? error));
    pg = { server, port, started: false };
  }
});

after(async () => {
  if (pg?.started) await pg.server.stop().catch(() => undefined);
  pg = undefined;
  removeClusterDir(clusterDir);
});

const WORKER = new URL('./t06-memory-worker.mjs', import.meta.url).pathname;

async function freshDb(): Promise<{ database: string; cs: string }> {
  if (!pg?.started) throw new Error('PostgreSQL unavailable.');
  const database = `jata_test_${process.pid}_${dbCounter++}_${randomUUID().slice(0, 8)}`;
  await pg.server.createDatabase(database);
  return { database, cs: `postgres://postgres:postgres@127.0.0.1:${pg.port}/${database}` };
}

async function dropDb(database: string): Promise<void> {
  if (pg?.started) await pg.server.dropDatabase(database).catch(() => undefined);
}

interface WorkerResult { id: string; tenantId: string; sequence: number; hash: string; previousHash: string }

function runRecordWorkers(cs: string, workerCount: number, perWorker: number, tenant: string, tag: string): Promise<WorkerResult[]> {
  const outs = Array.from({ length: workerCount }, () => path.join(os.tmpdir(), `t06-memory-${tag}-${process.pid}-${randomUUID().slice(0, 8)}.json`));
  return Promise.all(outs.map((out, w) => new Promise<WorkerResult[]>((resolve, reject) => {
    const child = fork(WORKER, [], {
      env: { ...process.env, JATAQI_TEST_PG_CS: cs, WORKER_MODE: 'append', WORKER_ID: `${tag}-${w}`, TENANT: tenant, COUNT: String(perWorker), OUT: out },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker ${tag}-${w} timed out; stderr: ${stderr.slice(0, 800)}`));
    }, 120_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`worker ${tag}-${w} exited ${code}; stderr: ${stderr.slice(0, 800)}`));
        return;
      }
      try {
        resolve(JSON.parse(fs.readFileSync(out, 'utf8')) as WorkerResult[]);
      } catch (error) {
        reject(new Error(`worker ${tag}-${w} produced no parseable result: ${String(error)}`));
      }
    });
  }))).then((all) => all.flat());
}

async function bootMemoryStack(cs: string): Promise<{ shutdown: () => Promise<void>; memory: CommercialMemoryService; driver: PostgresDriver }> {
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 10 });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new CommercialControlPlaneModule());
  kernel.register(new CommercialEventStreamModule());
  kernel.register(new CommercialMemoryModule());
  await kernel.boot();
  const memory = kernel.getModule<CommercialMemoryModule>('commercial-memory').getService();
  return { shutdown: () => kernel.shutdown(), memory, driver };
}

function evidenceFor(seed: string, n: number): CommercialEvidence[] {
  const now = Date.now();
  return [{
    id: `ev-${seed}-${n}`, status: 'MEASURED', source: 't06-memory-pg', observedAt: now, confidence: 100,
    summary: 'evidence', provenance: { source: 't06-memory-pg', collectedAt: now },
  }];
}

async function recordOne(memory: CommercialMemoryService, actor: CommercialActor, seed: string, n: number): Promise<CommercialMemoryRecord> {
  return memory.record(actor, {
    kind: 'PROHIBITED_STRATEGY',
    productId: `product-${seed}`,
    title: `seed ${seed} record ${n}`,
    summary: `seed ${seed} record ${n}`,
    tags: ['t06', seed],
    evidence: evidenceFor(seed, n),
    confidence: 100,
    provenance: { source: 't06-memory-pg', collectedAt: Date.now() },
    reusable: true,
  });
}

/** Independent chain verification straight from the database rows. */
async function verifyChainFromRows(cs: string, tenant: string): Promise<{ count: number; rows: Array<{ id: string; sequence: number; hash: string; previousHash: string }> }> {
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 4 });
  try {
    await driver.init();
    const coll = await driver.openCollection<CommercialMemoryRecord>('commercial-memory.records');
    const rows = (await coll.all())
      .filter((r) => r.tenantId === tenant)
      .sort((a, b) => a.sequence - b.sequence);
    for (let i = 0; i < rows.length; i += 1) {
      assert.equal(rows[i]!.sequence, i + 1, `sequences must be contiguous 1..N (found ${rows[i]!.sequence} at index ${i})`);
    }
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'record ids unique');
    let previousHash = 'GENESIS';
    for (const row of rows) {
      assert.equal(row.previousHash, previousHash, `record ${row.sequence} must link to its true predecessor`);
      previousHash = row.hash;
    }
    return { count: rows.length, rows };
  } finally {
    await driver.close().catch(() => undefined);
  }
}

describe('T-06 commercial-memory multi-process sequence integrity (real PostgreSQL)', async () => {
  const requirePg = (): void => {
    if (!pg?.started) assert.fail('DATABASE INTEGRATION NOT EXECUTED — real PostgreSQL required for the memory concurrency proof.');
  };

  it('two concurrent OS processes record for the same tenant: unique sequences, no duplicates, chain verifies', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const actor: CommercialActor = { id: 'verify-admin', tenantId: 'acme', roles: ['admin'] };
    const perWorker = 12;
    try {
      const results = await runRecordWorkers(cs, 2, perWorker, 'acme', 'two');
      assert.equal(results.length, 2 * perWorker, 'every record succeeded');
      const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
      assert.deepEqual(sequences, Array.from({ length: 2 * perWorker }, (_, i) => i + 1), 'no duplicate and no gap across two processes');
      assert.equal(new Set(results.map((r) => r.id)).size, results.length, 'record ids unique');

      const chain = await verifyChainFromRows(cs, 'acme');
      assert.equal(chain.count, 2 * perWorker);

      const { shutdown, memory, driver } = await bootMemoryStack(cs);
      try {
        const integrity = await memory.verifyIntegrity(actor);
        assert.deepEqual(integrity, { valid: true, records: 2 * perWorker }, 'service-level hash-chain verification succeeds after two-process run');
        for (const r of results) {
          const match = chain.rows.find((e) => e.id === r.id);
          assert.ok(match, `worker-reported record ${r.id} persisted`);
          assert.equal(match.sequence, r.sequence);
          assert.equal(match.hash, r.hash);
        }
      } finally {
        await shutdown().catch(() => undefined);
        await driver.close().catch(() => undefined);
      }
    } finally {
      await dropDb(database);
    }
  });

  it('three concurrent OS processes record for the same tenant: no duplicates, ordering valid, chain verifies', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const actor: CommercialActor = { id: 'verify-admin', tenantId: 'acme', roles: ['admin'] };
    const perWorker = 8;
    try {
      const results = await runRecordWorkers(cs, 3, perWorker, 'acme', 'three');
      assert.equal(results.length, 3 * perWorker);
      const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
      assert.deepEqual(sequences, Array.from({ length: 3 * perWorker }, (_, i) => i + 1), 'no duplicate sequence across three processes');
      assert.equal(new Set(results.map((r) => r.id)).size, results.length, 'record ids unique');

      const chain = await verifyChainFromRows(cs, 'acme');
      assert.equal(chain.count, 3 * perWorker, 'all records persisted');

      const { shutdown, memory, driver } = await bootMemoryStack(cs);
      try {
        const integrity = await memory.verifyIntegrity(actor);
        assert.deepEqual(integrity, { valid: true, records: 3 * perWorker }, 'service-level verification succeeds after three-process run');
      } finally {
        await shutdown().catch(() => undefined);
        await driver.close().catch(() => undefined);
      }
    } finally {
      await dropDb(database);
    }
  });

  it('two concurrent processes on DIFFERENT tenants: fully independent per-tenant sequences', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const perWorker = 8;
    try {
      const [resultsA, resultsB] = await Promise.all([
        runRecordWorkers(cs, 1, perWorker, 'tenant-a', 'ind-a'),
        runRecordWorkers(cs, 1, perWorker, 'tenant-b', 'ind-b'),
      ]);
      for (const [results, tenant] of [[resultsA, 'tenant-a'], [resultsB, 'tenant-b']] as const) {
        assert.ok(results.every((r) => r.tenantId === tenant), 'each worker wrote only its own tenant');
        const seq = results.map((r) => r.sequence).sort((a, b) => a - b);
        assert.deepEqual(seq, Array.from({ length: perWorker }, (_, i) => i + 1), `${tenant} chain is 1..N and gap-free`);
        const chain = await verifyChainFromRows(cs, tenant);
        assert.equal(chain.count, perWorker);
      }
    } finally {
      await dropDb(database);
    }
  });

  it('crash recovery: SIGKILL mid-transaction rolls back record AND allocation; retry continues cleanly', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const actor: CommercialActor = { id: 'verify-admin', tenantId: 'acme', roles: ['admin'] };
    try {
      const { shutdown, memory, driver } = await bootMemoryStack(cs);
      try {
        await recordOne(memory, actor, 'seed', 1);
        await recordOne(memory, actor, 'seed', 2);
      } finally {
        await shutdown().catch(() => undefined);
        await driver.close().catch(() => undefined);
      }

      const sentinel = path.join(os.tmpdir(), `t06-memory-crash-${process.pid}-${randomUUID().slice(0, 8)}.json`);
      const child = fork(WORKER, [], {
        env: { ...process.env, JATAQI_TEST_PG_CS: cs, WORKER_MODE: 'crash', WORKER_ID: 'crash-1', TENANT: 'acme', SENTINEL: sentinel },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr?.on('data', (d) => { stderr += String(d); });
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(sentinel)) {
        if (Date.now() > deadline) throw new Error(`crash worker never reached its open transaction; stderr: ${stderr.slice(0, 500)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));

      const chain = await verifyChainFromRows(cs, 'acme');
      assert.equal(chain.count, 2, 'crashed record must not persist');
      const { shutdown: s2, memory: memory2, driver: driver2 } = await bootMemoryStack(cs);
      try {
        const integrity = await memory2.verifyIntegrity(actor);
        assert.deepEqual(integrity, { valid: true, records: 2 }, 'chain still valid after crash');
        await recordOne(memory2, actor, 'retry', 3);
        const after = await memory2.verifyIntegrity(actor);
        assert.deepEqual(after, { valid: true, records: 3 }, 'retry continues the hash chain with no gap and no duplicate');
      } finally {
        await s2().catch(() => undefined);
        await driver2.close().catch(() => undefined);
      }
    } finally {
      await dropDb(database);
    }
  });

  it('rollback correctness: injected failure rolls back record+allocation; retry continues contiguously', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const actor: CommercialActor = { id: 'verify-admin', tenantId: 'acme', roles: ['admin'] };
    try {
      const { shutdown, memory, driver } = await bootMemoryStack(cs);
      try {
        const rec1 = await recordOne(memory, actor, 'seed', 1);

        // Injected failure AFTER allocation + insert — the exact composed-write
        // shape CommercialMemoryService.record uses in production.
        const storageDriver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 4 });
        const storageModule = new StorageModule({ driverInstance: storageDriver });
        const storageKernel = createTestKernel();
        storageKernel.register(storageModule);
        await storageKernel.boot();
        try {
          await assert.rejects(
            storageModule.atomically(async (scope) => {
              const records = await scope.collection<CommercialMemoryRecord>('commercial-memory.records');
              const seq = await scope.collection<{ id: string; tenantId: string; sequence: number }>('commercial-memory.records-seq');
              const counterId = 'seq:acme';
              for (let attempt = 0; attempt < 64; attempt += 1) {
                const cur = await seq.get(counterId);
                const observed = cur ?? { id: counterId, tenantId: 'acme', sequence: 0 };
                const next = { id: counterId, tenantId: 'acme', sequence: observed.sequence + 1 };
                const res = await seq.cas(counterId, (c) => (c?.sequence ?? 0) === observed.sequence, () => next);
                if (res.ok) {
                  const injected = { id: `injected-${next.sequence}`, tenantId: 'acme', sequence: next.sequence, previousHash: 'GENESIS', hash: 'x', kind: 'RAW_EVENT', title: 'injected', summary: 'injected', evidence: [], confidence: 100, provenance: { source: 'x', collectedAt: Date.now() }, createdAt: Date.now(), tags: [] } as unknown as CommercialMemoryRecord;
                  await records.put(injected);
                  throw new Error('injected post-record failure');
                }
              }
              assert.fail('counter CAS did not converge');
            }, { tenantId: 'acme' }),
            /injected post-record failure/,
          );

          const chainAfterRollback = await verifyChainFromRows(cs, 'acme');
          assert.equal(chainAfterRollback.count, 1, 'failed write left no record behind');
          const integrity1 = await memory.verifyIntegrity(actor);
          assert.deepEqual(integrity1, { valid: true, records: 1 }, 'chain valid after rollback');
          const rec2 = await recordOne(memory, actor, 'retry', 2);
          const integrity2 = await memory.verifyIntegrity(actor);
          assert.deepEqual(integrity2, { valid: true, records: 2 }, 'retry after rollback continues contiguously (sequence 2 reused, no gap)');
          assert.equal(rec2.sequence, 2, 'retried record carries the rolled-back sequence');
          void rec1;
        } finally {
          await storageKernel.shutdown().catch(() => undefined);
          await storageDriver.close().catch(() => undefined);
        }
      } finally {
        await shutdown().catch(() => undefined);
        await driver.close().catch(() => undefined);
      }
    } finally {
      await dropDb(database);
    }
  });
});
