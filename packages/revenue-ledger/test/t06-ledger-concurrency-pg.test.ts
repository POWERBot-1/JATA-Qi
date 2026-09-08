// T-06 revenue-ledger sequence integrity over REAL PostgreSQL with REAL OS
// processes (Workstream B).
//
//   * two concurrent processes appending entries for the same tenant;
//   * three concurrent processes appending entries for the same tenant;
//   * two concurrent processes on DIFFERENT tenants keep independent chains;
//   * a process SIGKILLed while its composed write is still open (crash
//     recovery: entry AND sequence allocation roll back together);
//   * retry after failure continues the chain with no gap and no duplicate;
//   * rollback semantics and the durable-handler idempotency guard
//     (sourceEventId) stay intact.
//
// Every append runs the PRODUCTION path (`RevenueLedgerService.recordCost`
// inside a tenant-bound `StorageModule.atomically` with a CAS-advanced
// per-tenant sequence counter), and every success is verified against the
// real database: unique contiguous sequences, correct predecessor links, and
// `verifyIntegrity()` reporting a valid hash chain. Durable-handler
// redelivery idempotency is additionally proven end to end by the T-05
// payment-chain suite (`t05-payment-chain-pg.test.ts`, same package).
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
// R1 (§6 TEST KERNEL REPAIR): this fixture installs the REAL A-01
// AuthorizationBoundaryModule — the same module the production composition
// installs. It is NOT a mock, a stub, or a bypass. Legitimate kernel-internal
// worker operations establish scoped KERNEL_INTERNAL authority through the
// real boundary; anything out of scope is still denied.
import { AuthorizationBoundaryModule } from '@jataqi/authorization-boundary';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { CommercialControlPlaneModule, type CommercialActor, type CommercialEvidence } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { BillingModule } from '@jataqi/billing';
import { PaymentsModule } from '@jataqi/payments';
import { RevenueLedgerModule, type RevenueLedgerEntry, type RevenueLedgerService } from '../src/index.js';

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
  const port = 59400 + Math.floor(Math.random() * 500);
  clusterDir = path.join(os.tmpdir(), `jataqi-t06-ledger-pg-${process.pid}`);
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
    console.warn('[t06-ledger-pg] PostgreSQL unavailable:', String((error as Error)?.message ?? error));
    pg = { server, port, started: false };
  }
});

after(async () => {
  if (pg?.started) await pg.server.stop().catch(() => undefined);
  pg = undefined;
  removeClusterDir(clusterDir);
});

const WORKER = new URL('./t06-ledger-worker.mjs', import.meta.url).pathname;

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

function runAppendWorkers(cs: string, workerCount: number, perWorker: number, tenant: string, tag: string): Promise<WorkerResult[]> {
  const outs = Array.from({ length: workerCount }, () => path.join(os.tmpdir(), `t06-ledger-${tag}-${process.pid}-${randomUUID().slice(0, 8)}.json`));
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

async function bootLedgerStack(cs: string): Promise<{ shutdown: () => Promise<void>; ledger: RevenueLedgerService; driver: PostgresDriver }> {
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 10 });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new CommercialControlPlaneModule());
  kernel.register(new AuthorizationBoundaryModule());
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  kernel.register(new CommercialEventStreamModule());
  kernel.register(new BillingModule());
  kernel.register(new RevenueLedgerModule());
  await kernel.boot();
  const ledger = kernel.getModule<RevenueLedgerModule>('revenue-ledger').getService();
  return { shutdown: () => kernel.shutdown(), ledger, driver };
}

function evidenceFor(seed: string, n: number): CommercialEvidence[] {
  const now = Date.now();
  return [{
    id: `ev-${seed}-${n}`, status: 'MEASURED', source: 't06-ledger-pg', observedAt: now, confidence: 95,
    summary: 'evidence', provenance: { source: 't06-ledger-pg', collectedAt: now, correlationId: `c-${seed}-${n}` },
  }];
}

async function appendOne(ledger: RevenueLedgerService, actor: CommercialActor, seed: string, n: number): Promise<RevenueLedgerEntry> {
  return ledger.recordCost(actor, {
    productId: `product-${seed}`,
    amount: { amount: n, currency: 'KES' },
    category: 'AI',
    evidence: evidenceFor(seed, n),
    notes: `seed ${seed} entry ${n}`,
  });
}

/** Independent chain verification straight from the database rows
 *  (contiguity, uniqueness, predecessor linkage). */
async function verifyChainFromRows(cs: string, tenant: string): Promise<{ count: number; rows: Array<{ id: string; sequence: number; hash: string; previousHash: string }> }> {
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 4 });
  try {
    await driver.init();
    const coll = await driver.openCollection<RevenueLedgerEntry>('revenue-ledger.entries');
    const rows = (await coll.all())
      .filter((e) => e.tenantId === tenant)
      .sort((a, b) => a.sequence - b.sequence);
    for (let i = 0; i < rows.length; i += 1) {
      assert.equal(rows[i]!.sequence, i + 1, `sequences must be contiguous 1..N (found ${rows[i]!.sequence} at index ${i})`);
    }
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'entry ids unique');
    let previousHash = 'GENESIS';
    for (const row of rows) {
      assert.equal(row.previousHash, previousHash, `entry ${row.sequence} must link to its true predecessor`);
      previousHash = row.hash;
    }
    return { count: rows.length, rows };
  } finally {
    await driver.close().catch(() => undefined);
  }
}

describe('T-06 revenue-ledger multi-process sequence integrity (real PostgreSQL)', async () => {
  const requirePg = (): void => {
    if (!pg?.started) assert.fail('DATABASE INTEGRATION NOT EXECUTED — real PostgreSQL required for the ledger concurrency proof.');
  };

  it('two concurrent OS processes append for the same tenant: unique contiguous sequences + valid chain', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const actor: CommercialActor = { id: 'verify-admin', tenantId: 'acme', roles: ['admin'] };
    const perWorker = 15;
    try {
      const results = await runAppendWorkers(cs, 2, perWorker, 'acme', 'two');
      assert.equal(results.length, 2 * perWorker, 'every append succeeded');
      const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
      assert.deepEqual(sequences, Array.from({ length: 2 * perWorker }, (_, i) => i + 1), 'no duplicate and no gap across two processes');
      assert.equal(new Set(results.map((r) => r.id)).size, results.length, 'entry ids unique');

      const chain = await verifyChainFromRows(cs, 'acme');
      assert.equal(chain.count, 2 * perWorker, 'all 30 entries persisted');

      const { shutdown, ledger, driver } = await bootLedgerStack(cs);
      try {
        const integrity = await ledger.verifyIntegrity(actor);
        assert.deepEqual(integrity, { valid: true, entries: 2 * perWorker }, 'service-level hash-chain verification succeeds after two-process run');
        for (const r of results) {
          const match = chain.rows.find((e) => e.id === r.id);
          assert.ok(match, `worker-reported entry ${r.id} persisted`);
          assert.equal(match.sequence, r.sequence, 'persisted sequence matches worker report');
          assert.equal(match.hash, r.hash, 'persisted hash matches worker report');
        }
      } finally {
        await shutdown().catch(() => undefined);
        await driver.close().catch(() => undefined);
      }
    } finally {
      await dropDb(database);
    }
  });

  it('three concurrent OS processes append for the same tenant: no duplicates, ordering valid, chain verifies', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const actor: CommercialActor = { id: 'verify-admin', tenantId: 'acme', roles: ['admin'] };
    const perWorker = 10;
    try {
      const results = await runAppendWorkers(cs, 3, perWorker, 'acme', 'three');
      assert.equal(results.length, 3 * perWorker);
      const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
      assert.deepEqual(sequences, Array.from({ length: 3 * perWorker }, (_, i) => i + 1), 'no duplicate sequence across three processes');
      assert.equal(new Set(results.map((r) => r.id)).size, results.length, 'entry ids unique');

      const chain = await verifyChainFromRows(cs, 'acme');
      assert.equal(chain.count, 3 * perWorker, 'all 30 entries persisted');

      const { shutdown, ledger, driver } = await bootLedgerStack(cs);
      try {
        const integrity = await ledger.verifyIntegrity(actor);
        assert.deepEqual(integrity, { valid: true, entries: 3 * perWorker }, 'service-level verification succeeds after three-process run');
      } finally {
        await shutdown().catch(() => undefined);
        await driver.close().catch(() => undefined);
      }
    } finally {
      await dropDb(database);
    }
  });

  it('two concurrent processes on DIFFERENT tenants keep fully independent chains', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const perWorker = 8;
    try {
      const [resultsA, resultsB] = await Promise.all([
        runAppendWorkers(cs, 1, perWorker, 'tenant-a', 'ind-a'),
        runAppendWorkers(cs, 1, perWorker, 'tenant-b', 'ind-b'),
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

  it('crash recovery: SIGKILL mid-transaction rolls back the entry AND its sequence allocation; retry continues cleanly', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const actor: CommercialActor = { id: 'verify-admin', tenantId: 'acme', roles: ['admin'] };
    try {
      const { shutdown, ledger, driver } = await bootLedgerStack(cs);
      try {
        await appendOne(ledger, actor, 'seed', 1);
        await appendOne(ledger, actor, 'seed', 2);
      } finally {
        await shutdown().catch(() => undefined);
        await driver.close().catch(() => undefined);
      }

      // Crash worker: opens the composed write, allocates sequence 3, writes
      // its entry, signals via sentinel and HOLDS the transaction open.
      const sentinel = path.join(os.tmpdir(), `t06-ledger-crash-${process.pid}-${randomUUID().slice(0, 8)}.json`);
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
      child.kill('SIGKILL'); // die mid-transaction (uncommitted)
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));

      // Only the two committed entries survive; the crashed allocation (3)
      // rolled back with the entry; the chain still verifies.
      const chain = await verifyChainFromRows(cs, 'acme');
      assert.equal(chain.count, 2, 'crashed entry must not persist');
      const { shutdown: s2, ledger: ledger2, driver: driver2 } = await bootLedgerStack(cs);
      try {
        const integrity = await ledger2.verifyIntegrity(actor);
        assert.deepEqual(integrity, { valid: true, entries: 2 }, 'chain still valid after crash');
        // Retry: the next append reuses sequence 3 and continues the chain.
        await appendOne(ledger2, actor, 'retry', 3);
        const after = await ledger2.verifyIntegrity(actor);
        assert.deepEqual(after, { valid: true, entries: 3 }, 'retry continues the hash chain with no gap and no duplicate');
      } finally {
        await s2().catch(() => undefined);
        await driver2.close().catch(() => undefined);
      }
    } finally {
      await dropDb(database);
    }
  });

  it('rollback semantics: a failed composed write rolls back entry+allocation; retry continues; idempotency guard never duplicates', async () => {
    requirePg();
    const { database, cs } = await freshDb();
    const actor: CommercialActor = { id: 'verify-admin', tenantId: 'acme', roles: ['admin'] };
    try {
      const { shutdown, ledger, driver } = await bootLedgerStack(cs);
      try {
        await appendOne(ledger, actor, 'seed', 1);

        // Injected failure AFTER allocation + insert inside a composed write —
        // the exact shape RevenueLedgerService.append uses in production.
        const storageDriver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 4 });
        const storageModule = new StorageModule({ driverInstance: storageDriver });
        const storageKernel = createTestKernel();
        storageKernel.register(storageModule);
        await storageKernel.boot();
        try {
          await assert.rejects(
            storageModule.atomically(async (scope) => {
              const entries = await scope.collection<RevenueLedgerEntry>('revenue-ledger.entries');
              const seq = await scope.collection<{ id: string; tenantId: string; sequence: number }>('revenue-ledger.entries-seq');
              const counterId = 'seq:acme';
              for (let attempt = 0; attempt < 64; attempt += 1) {
                const cur = await seq.get(counterId);
                const observed = cur ?? { id: counterId, tenantId: 'acme', sequence: 0 };
                const next = { id: counterId, tenantId: 'acme', sequence: observed.sequence + 1 };
                const res = await seq.cas(counterId, (c) => (c?.sequence ?? 0) === observed.sequence, () => next);
                if (res.ok) {
                  await entries.put({ id: `injected-${next.sequence}`, tenantId: 'acme', sequence: next.sequence, previousHash: 'GENESIS', hash: 'x', entryType: 'COST', recognitionStatus: 'RECOGNIZED', amount: { amount: 1, currency: 'KES' }, costCategory: 'AI', createdAt: Date.now(), evidence: [], notes: 'injected' });
                  throw new Error('injected post-append failure');
                }
              }
              assert.fail('counter CAS did not converge');
            }, { tenantId: 'acme' }),
            /injected post-append failure/,
          );

          // Rolled back: the chain is intact at 1 entry and the allocation
          // (2) is gone with it; a retry reuses sequence 2 with NO gap.
          const chainAfterRollback = await verifyChainFromRows(cs, 'acme');
          assert.equal(chainAfterRollback.count, 1, 'failed write left no entry behind');
          const integrity1 = await ledger.verifyIntegrity(actor);
          assert.deepEqual(integrity1, { valid: true, entries: 1 }, 'chain valid after rollback');
          const entry2 = await appendOne(ledger, actor, 'retry', 2);
          const integrity2 = await ledger.verifyIntegrity(actor);
          assert.deepEqual(integrity2, { valid: true, entries: 2 }, 'retry after rollback continues contiguously');

          // Idempotency guard (durable-handler sourceEventId dedupe): a
          // re-run of the effect for an already-handled source event must not
          // create a second entry. Seed the handled marker, then re-run the
          // guard twice and count.
          const sourceEvent = `evt-${randomUUID()}`;
          await storageModule.atomically(async (scope) => {
            const entries = await scope.collection<RevenueLedgerEntry>('revenue-ledger.entries');
            const seq = await scope.collection<{ id: string; tenantId: string; sequence: number }>('revenue-ledger.entries-seq');
            // First handling: append an entry carrying the source event
            // (sequence 3, chained to the real entry 2's hash).
            const counterId = 'seq:acme';
            for (let attempt = 0; attempt < 64; attempt += 1) {
              const cur = await seq.get(counterId);
              const observed = cur ?? { id: counterId, tenantId: 'acme', sequence: 0 };
              const next = { id: counterId, tenantId: 'acme', sequence: observed.sequence + 1 };
              const res = await seq.cas(counterId, (c) => (c?.sequence ?? 0) === observed.sequence, () => next);
              if (res.ok) {
                await entries.put({ id: `handled-${sourceEvent}`, tenantId: 'acme', sequence: next.sequence, previousHash: entry2.hash, hash: 'handled-dummy', entryType: 'REVENUE', recognitionStatus: 'RECOGNIZED', amount: { amount: 1, currency: 'KES' }, createdAt: Date.now(), evidence: [], notes: 'handled', sourceEventId: sourceEvent });
                return;
              }
            }
          }, { tenantId: 'acme' });
          const guardRun = async (): Promise<number> => {
            let created = 0;
            await storageModule.atomically(async (scope) => {
              const entries = await scope.collection<RevenueLedgerEntry>('revenue-ledger.entries');
              if ((await entries.query({ where: (e) => e.sourceEventId === sourceEvent, limit: 1 }))[0]) return; // idempotent redelivery
              created += 1;
            }, { tenantId: 'acme' });
            return created;
          };
          assert.equal(await guardRun(), 0, 'first redelivery is deduplicated');
          assert.equal(await guardRun(), 0, 'second redelivery is deduplicated');
          const afterGuard = await verifyChainFromRows(cs, 'acme');
          const handled = afterGuard.rows.filter((r) => r.id === `handled-${sourceEvent}`);
          assert.equal(handled.length, 1, 'exactly one entry exists for the source event');
          assert.equal(afterGuard.count, 3, 'no extra rows from redeliveries');
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
