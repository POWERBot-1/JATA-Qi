// R-01 two-process contention and crash-recovery acceptance suite.
//
// The P-01 audit recorded that "multi-process contention" was NOT DEMONSTRATED:
// both "workers" in the P-01 suites were connection pools inside ONE Node
// process. This suite closes that evidence gap for the two-node case by
// spawning REAL separate OS processes against one authoritative PostgreSQL.
//
// It proves:
//   1. Two independent OS processes racing for the same work item produce
//      exactly one lease winner (no duplicate execution).
//   2. A process that dies HARD while holding a lease leaves recoverable state,
//      and a surviving process's recovery pass reclaims it exactly once —
//      without ever fabricating an outcome for the dead process's work.
//
// When PostgreSQL cannot start, the suite SKIPs. It never fabricates a pass.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import { LoopHostService, WorkQueue } from '../src/index.js';
import { testPrincipalFor, reasoningTask } from './helpers.js';
import { bootStorageKernel, dropDb, freshDb, makeDriver, makeStorage, pgAvailable, stopPg } from './pg-host-harness.js';

after(async () => {
  await stopPg();
});

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'two-process-worker.mjs');

interface WorkerLine {
  workerId: string;
  event: string;
  workId?: string;
  wins?: string[];
  error?: string;
}

/** Run the worker as a real child OS process and collect its JSON lines. */
function runWorker(connectionString: string, mode: string, workerId: string): Promise<{ code: number | null; lines: WorkerLine[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, connectionString, mode, workerId], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.stderr.on('data', (chunk) => (err += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      const lines: WorkerLine[] = out
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as WorkerLine;
          } catch {
            return { workerId, event: 'unparseable', error: line };
          }
        });
      if (err.trim() && process.env.JATAQI_DEBUG_WORKER) console.warn(`[worker ${workerId}] ${err}`);
      resolve({ code, lines });
    });
  });
}

const actor: CommercialActor = { id: 'r01-operator', tenantId: 'acme', roles: ['agent', 'operator'] };

describe('R-01 two-process contention over one authoritative PostgreSQL', async () => {
  const available = await pgAvailable();
  if (!available) {
    it('SKIPPED: PostgreSQL integration unavailable in this environment', () => {
      assert.ok(true, 'DATABASE INTEGRATION NOT EXECUTED — no fabricated pass.');
    });
    return;
  }

  it('two separate OS processes racing one item: exactly one lease winner (no duplicate execution)', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const kernel = await bootStorageKernel(makeStorage(driver));
    const queue = new WorkQueue();
    await queue.init(kernel);

    // One single item that both processes will fight over.
    const item = await queue.enqueue(actor,  { task: reasoningTask(), idempotencyKey: 'r01-two-proc-race' }, await testPrincipalFor(actor, Date.now()),  Date.now());

    const conn = db.config.connectionString as string;
    const [a, b] = await Promise.all([
      runWorker(conn, 'compete', 'proc-a'),
      runWorker(conn, 'compete', 'proc-b'),
    ]);

    const winsA = a.lines.filter((l) => l.event === 'lease-won' && l.workId === item.id);
    const winsB = b.lines.filter((l) => l.event === 'lease-won' && l.workId === item.id);
    const totalWins = winsA.length + winsB.length;

    assert.equal(
      totalWins,
      1,
      `exactly one of two OS processes must win the lease; got ${totalWins} (a=${winsA.length}, b=${winsB.length})`,
    );

    // The database agrees: the item is leased by exactly one owner.
    const stored = await queue.getInternal(item.id);
    assert.ok(stored);
    assert.ok(['LEASED', 'DISPATCHED'].includes(stored.status));
    assert.ok(stored.leaseOwner === 'proc-a' || stored.leaseOwner === 'proc-b');
    assert.ok(stored.leaseToken, 'the winning process holds a lease token');

    await kernel.shutdown();
    await dropDb(db.database);
  });

  it('a hard-crashed process leaves work recoverable; a surviving process reclaims it exactly once', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const kernel = await bootStorageKernel(makeStorage(driver));
    const queue = new WorkQueue();
    await queue.init(kernel);

    const item = await queue.enqueue(actor,  { task: reasoningTask(), idempotencyKey: 'r01-two-proc-crash' }, await testPrincipalFor(actor, Date.now()),  Date.now());

    // Process 1 leases the item with a 1s TTL and dies hard (exit code 9).
    const conn = db.config.connectionString as string;
    const crashed = await runWorker(conn, 'crash', 'proc-crash');
    assert.equal(crashed.code, 9, 'the worker must have died hard while holding the lease');
    assert.ok(
      crashed.lines.some((l) => l.event === 'leased-then-crashing' && l.workId === item.id),
      'the crashing process must have actually taken the lease first',
    );

    // The row survives the dead process, still marked as leased.
    const afterCrash = await queue.getInternal(item.id);
    assert.ok(afterCrash);
    assert.ok(['LEASED', 'DISPATCHED'].includes(afterCrash.status), 'work survives process death still leased');
    assert.equal(afterCrash.leaseOwner, 'proc-crash');

    // A surviving host runs recovery AFTER the lease expires.
    const host = new LoopHostService({ hostId: 'survivor', leaseTtlMs: 5_000 });
    await host.init(kernel);
    const afterExpiry = Date.now() + 5_000;

    const first = await host.recover(afterExpiry);
    assert.equal(first.reclaimed, 1, 'recovery reclaims the dead process\u2019s expired lease exactly once');
    assert.equal(first.requeued, 1);

    // Idempotent: a second recovery pass must not reclaim it again.
    const second = await host.recover(afterExpiry + 1);
    assert.equal(second.reclaimed, 0, 'recovery must not double-reclaim already-requeued work');

    const requeued = await queue.getInternal(item.id);
    assert.ok(requeued);
    assert.equal(requeued.status, 'QUEUED', 'reclaimed work returns to the queue for FULL-loop redispatch');
    assert.equal(requeued.leaseToken, undefined, 'the dead process\u2019s lease token is cleared');
    // Crucially: no outcome was invented for the crashed dispatch.
    assert.notEqual(requeued.status, 'COMPLETED');

    await kernel.shutdown();
    await dropDb(db.database);
  });

  it('an ACTIVE lease held by a live process is never stolen by another process', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const kernel = await bootStorageKernel(makeStorage(driver));
    const queue = new WorkQueue();
    await queue.init(kernel);

    const item = await queue.enqueue(actor,  { task: reasoningTask(), idempotencyKey: 'r01-active-lease' }, await testPrincipalFor(actor, Date.now()),  Date.now());
    // This process takes a long lease.
    await queue.acquireLease(item.id, 'in-test-holder', 600_000, Date.now());

    // A separate OS process must not be able to acquire it.
    const conn = db.config.connectionString as string;
    const other = await runWorker(conn, 'compete', 'proc-intruder');
    const stolen = other.lines.filter((l) => l.event === 'lease-won' && l.workId === item.id);
    assert.equal(stolen.length, 0, 'an active lease must never be acquired by a second process');

    const stored = await queue.getInternal(item.id);
    assert.equal(stored?.leaseOwner, 'in-test-holder');

    await kernel.shutdown();
    await dropDb(db.database);
  });
});
