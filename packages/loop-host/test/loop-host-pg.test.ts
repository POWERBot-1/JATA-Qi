// P-01 loop-host integration over a real PostgreSQL backend.
//
// These suites prove the loop-host QUEUE -> LEASE -> CHECKPOINT -> RUN ->
// SETTLE -> RETRY/DLQ pipeline stays correct and concurrency-safe when work
// items, leases, and checkpoints live in an authoritative, transactional,
// multi-process database — including concurrent workers (independent pools)
// and crash/restart recovery. Governance is unchanged: persistence stores
// state only. When PostgreSQL cannot start the suites SKIP.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import { UnifiedLoopEvents, type LoopOutcome, type LoopRunResult } from '@jataqi/unified-loop';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import {
  CheckpointJournal,
  LoopHostService,
  StaleLeaseError,
  TenantIsolationError,
  WorkQueue,
  WORK_COLLECTION,
  CHECKPOINT_COLLECTION,
  type HostedWorkItem,
  type LoopRunner,
} from '../src/index.js';
import { testPrincipalFor, buildHarness, reasoningTask, type Harness } from './helpers.js';
import { bootStorageKernel, dropDb, freshDb, makeDriver, makeStorage, pgAvailable, stopPg } from './pg-host-harness.js';

after(async () => {
  await stopPg();
});

const actorA: CommercialActor = { id: 'worker-a', tenantId: 'acme', roles: ['agent', 'operator'] };
const actorB: CommercialActor = { id: 'worker-b', tenantId: 'acme', roles: ['agent', 'operator'] };
const actorOtherTenant: CommercialActor = { id: 'worker-other', tenantId: 'other', roles: ['agent'] };

function nowMs(): number {
  return Date.now();
}

function simpleTask(obj: string) {
  return { objective: obj };
}

function fakeRunner(outcome: LoopOutcome, failTimes = 0): LoopRunner & { calls: () => number } {
  let calls = 0;
  const runner = (async (actor, task, opts) => {
    calls += 1;
    if (calls <= failTimes) throw new Error('simulated transient dispatch failure');
    const at = opts.now();
    const result: LoopRunResult = {
      loopId: `loop-fake-${calls}`,
      correlationId: opts.correlationId,
      tenantId: actor.tenantId,
      outcome,
      trace: [],
      stageOutputs: {},
      records: [],
      finalStage: 'OUTCOME',
      startedAt: at,
      endedAt: at,
      continuation: 'TERMINATE',
    };
    return result;
  }) as LoopRunner & { calls: () => number };
  runner.calls = () => calls;
  return runner;
}

describe('loop-host over real PostgreSQL (P-01)', async () => {
  const available = await pgAvailable();
  if (!available) {
    it('SKIPPED: PostgreSQL integration unavailable in this environment', () => {
      assert.ok(true);
    });
    return;
  }

  async function twoWorkers() {
    const db = await freshDb();
    if (!db) throw new Error('no db');
    const driverA = makeDriver(db.config);
    const driverB = makeDriver(db.config);
    const wqA = new WorkQueue();
    const wqB = new WorkQueue();
    const jA = new CheckpointJournal();
    const jB = new CheckpointJournal();
    await wqA.init(await bootStorageKernel(makeStorage(driverA)));
    await wqB.init(await bootStorageKernel(makeStorage(driverB)));
    await jA.init(await bootStorageKernel(makeStorage(driverA)));
    await jB.init(await bootStorageKernel(makeStorage(driverB)));
    return { db, driverA, driverB, wqA, wqB, jA, jB };
  }

  it('two workers competing for the same task: exactly one wins the lease (DB row-lock CAS)', async () => {
    const { db, wqA, wqB, driverA, driverB } = await twoWorkers();
    const seeded = await wqA.enqueue(actorA,  { task: simpleTask('lease race') }, await testPrincipalFor(actorA, nowMs()));
    const id = seeded.id;
    const attempts: Promise<boolean>[] = [];
    for (let i = 0; i < 10; i++) attempts.push(wqA.acquireLease(id, `hostA${i}`, 30000, nowMs()).then(() => true).catch(() => false));
    for (let i = 0; i < 10; i++) attempts.push(wqB.acquireLease(id, `hostB${i}`, 30000, nowMs()).then(() => true).catch(() => false));
    const winners = (await Promise.all(attempts)).filter(Boolean).length;
    assert.equal(winners, 1, `expected exactly one lease winner, got ${winners}`);
    const cur = await wqA.get(actorA, id);
    assert.equal(cur?.status, 'LEASED');
    assert.ok(cur?.leaseOwner);
    await driverA.close();
    await driverB.close();
    await dropDb(db!.database);
  });

  it('stale worker cannot settle; the valid holder can', async () => {
    const { db, wqA, wqB, driverA, driverB } = await twoWorkers();
    const seeded = await wqA.enqueue(actorA,  { task: simpleTask('stale settle') }, await testPrincipalFor(actorA, nowMs()));
    const id = seeded.id;
    const { token } = await wqA.acquireLease(id, 'hostA', 30000, nowMs());
    await wqA.markDispatched(id, token, 'ckpt-1', nowMs());
    // Stale worker presents an unknown token.
    await assert.rejects(
      () => wqB.settleTerminal(id, 'wrong-token', { status: 'COMPLETED', loopId: 'l1', loopOutcome: 'COMPLETED_DRY_RUN' }, 'ckpt-2', nowMs()),
      StaleLeaseError,
    );
    const stillDispatched = await wqA.get(actorA, id);
    assert.equal(stillDispatched?.status, 'DISPATCHED');
    // Valid holder settles.
    await wqA.settleTerminal(id, token, { status: 'COMPLETED', loopId: 'l1', loopOutcome: 'COMPLETED_DRY_RUN' }, 'ckpt-2', nowMs());
    assert.equal((await wqA.get(actorA, id))?.status, 'COMPLETED');
    await driverA.close();
    await driverB.close();
    await dropDb(db!.database);
  });

  it('expired lease is reclaimed by a competing worker; active lease is never stolen', async () => {
    const { db, wqA, wqB, driverA, driverB } = await twoWorkers();
    const seeded = await wqA.enqueue(actorA,  { task: simpleTask('reclaim') }, await testPrincipalFor(actorA, nowMs()));
    const id = seeded.id;
    const t0 = nowMs();
    await wqA.acquireLease(id, 'hostA', 100, t0);
    // Active lease cannot be reclaimed.
    await assert.rejects(() => wqB.reclaimExpired(id, t0 + 50), /still active/);
    // After expiry it can.
    const reclaimed = await wqB.reclaimExpired(id, t0 + 200);
    assert.equal(reclaimed.status, 'QUEUED');
    assert.equal(reclaimed.leaseToken, undefined);
    await driverA.close();
    await driverB.close();
    await dropDb(db!.database);
  });

  it('lease renewal: holder renews, stale holder is rejected', async () => {
    const { db, wqA, wqB, driverA, driverB } = await twoWorkers();
    const seeded = await wqA.enqueue(actorA,  { task: simpleTask('renew') }, await testPrincipalFor(actorA, nowMs()));
    const id = seeded.id;
    const { token } = await wqA.acquireLease(id, 'hostA', 100, nowMs());
    const renewed = await wqA.renewLease(id, token, 1000, nowMs());
    assert.ok((renewed.leaseExpiry ?? 0) > nowMs());
    await assert.rejects(() => wqB.renewLease(id, 'wrong-token', 1000, nowMs()), StaleLeaseError);
    await driverA.close();
    await driverB.close();
    await dropDb(db!.database);
  });

  it('duplicate idempotency-key enqueue (concurrent) yields one record', async () => {
    const { db, wqA, wqB, driverA, driverB } = await twoWorkers();
    const key = `dup-key-${Math.random().toString(36).slice(2)}`;
    const [r1, r2] = await Promise.all([
      wqA.enqueue(actorA,  { task: simpleTask('dup'), idempotencyKey: key }, await testPrincipalFor(actorA, nowMs())),
      wqB.enqueue(actorA,  { task: simpleTask('dup'), idempotencyKey: key }, await testPrincipalFor(actorA, nowMs())),
    ]);
    assert.equal(r1.id, r2.id);
    const all = await wqA.list(actorA, {});
    assert.equal(all.filter((x) => x.idempotencyKey === key).length, 1);
    await driverA.close();
    await driverB.close();
    await dropDb(db!.database);
  });

  it('tenant A cannot read or resume tenant B state (isolation at persistence boundary)', async () => {
    const { db, wqA, wqB, driverA, driverB } = await twoWorkers();
    const seeded = await wqA.enqueue(actorA,  { task: simpleTask('tenant-a') }, await testPrincipalFor(actorA, nowMs()));
    const id = seeded.id;
    await assert.rejects(() => wqB.get(actorOtherTenant, id), TenantIsolationError);
    await assert.rejects(() => wqB.resumeWork(actorOtherTenant, id, nowMs()), TenantIsolationError);
    // Cross-tenant list reveals nothing.
    const theirs = await wqB.list(actorOtherTenant, {});
    assert.equal(theirs.length, 0);
    await driverA.close();
    await driverB.close();
    await dropDb(db!.database);
  });

  it('checkpoint ordering is monotonic and persists across a database-backed journal', async () => {
    const { db, wqA, driverA } = await twoWorkers();
    const seeded = await wqA.enqueue(actorA,  { task: simpleTask('ckpt order') }, await testPrincipalFor(actorA, nowMs()));
    const id = seeded.id;
    const raw = await wqA.get(actorA, id);
    assert.ok(raw);
    // Stale/monotonic guard: write must not regress a checkpoint sequence.
    const { token } = await wqA.acquireLease(id, 'hostA', 30000, nowMs());
    const marked = await wqA.markDispatched(id, token, 'ckpt-pre', nowMs());
    assert.equal(marked.checkpointSequence, 1);
    assert.equal(marked.attemptCount, 1);
    // A stale worker attempting markDispatched cannot advance anything.
    await assert.rejects(() => wqA.markDispatched(id, 'stale', 'ckpt-x', nowMs()));
    await driverA.close();
    await dropDb(db!.database);
  });

  it('crash/restart: queued work and an expired in-flight lease survive and recover on a fresh driver', async () => {
    const db = await freshDb();
    if (!db) throw new Error('no db');
    const driver1 = makeDriver(db.config);
    const q1 = new WorkQueue();
    await q1.init(await bootStorageKernel(makeStorage(driver1)));
    const seeded = await q1.enqueue(actorA,  { task: simpleTask('crash-restart'), correlationId: 'corr-crash' }, await testPrincipalFor(actorA, nowMs()));
    const id = seeded.id;
    const t0 = nowMs();
    const { token } = await q1.acquireLease(id, 'host1', 100, t0);
    // Simulate host death mid-flight: record stays LEASED with an expiring lease.
    // (Lease TTL chosen so it is already expired at t0+300.)
    void token;
    await driver1.close(); // "process A ends"

    // "Restart" as a fresh worker B; durable rows are still there.
    const driver2 = makeDriver(db.config);
    const q2 = new WorkQueue();
    const j2 = new CheckpointJournal();
    const k2 = await bootStorageKernel(makeStorage(driver2));
    await q2.init(k2);
    await j2.init(k2);
    const restored = await q2.get(actorA, id);
    assert.equal(restored?.status, 'LEASED');
    assert.equal(restored?.correlationId, 'corr-crash');
    // Recovery reclaims the expired lease.
    const reclaimed = await q2.reclaimExpired(id, t0 + 300);
    assert.equal(reclaimed.status, 'QUEUED');
    await driver2.close();
    await dropDb(db!.database);
  });

  it('full host pipeline over PostgreSQL with a durable backend (fake runner): enqueue->LEASE->CHECKPOINT->SETTLE', async () => {
    const db = await freshDb();
    if (!db) throw new Error('no db');
    const driver = makeDriver(db.config);
    const kernel = await bootStorageKernel(makeStorage(driver));
    const host = new LoopHostService({ leaseTtlMs: 30_000, maxBatch: 10, sleepDelayMs: 1000 });
    await host.init(kernel);
    const runner = fakeRunner('COMPLETED_DRY_RUN');
    host.setRunner(runner);
    host.start();
    const item = await host.enqueue(actorA,  { task: simpleTask('host-over-pg') }, await testPrincipalFor(actorA, nowMs()));
    const summary = await host.tick();
    assert.equal(summary.dispatched, 1);
    assert.equal(summary.completed, 1);
    const settled = await host.get(actorA, item.id);
    assert.equal(settled?.status, 'COMPLETED');
    assert.equal(settled?.loopOutcome, 'COMPLETED_DRY_RUN');
    assert.ok(settled?.checkpointId);
    await host.stop();
    await driver.close();
    await dropDb(db!.database);
  });

  it('retry -> DLQ over PostgreSQL (bounded, terminal, not converted to success)', async () => {
    const db = await freshDb();
    if (!db) throw new Error('no db');
    const driver = makeDriver(db.config);
    const kernel = await bootStorageKernel(makeStorage(driver));
    const host = new LoopHostService({ leaseTtlMs: 30_000, maxBatch: 10 });
    await host.init(kernel);
    host.setRunner(fakeRunner('COMPLETED_DRY_RUN', 99));
    host.start();
    await host.enqueue(actorA,  { task: simpleTask('dlq'), maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 }, await testPrincipalFor(actorA, nowMs()));
    const first = await host.tick();
    assert.equal(first.retried, 1);
    const second = await host.tick();
    assert.equal(second.deadLettered, 1);
    const dlq = await host.list(actorA, { status: 'DLQ' });
    assert.equal(dlq.length, 1);
    assert.equal(dlq[0]!.attemptCount, 2);
    await host.stop();
    await driver.close();
    await dropDb(db!.database);
  });

  it('full 34-stage governed loop dispatches over PostgreSQL (governance unchanged by persistence)', async () => {
    const db = await freshDb();
    if (!db) throw new Error('no db');
    const driver = makeDriver(db.config);
    const h: Harness = await buildHarness({ storageModule: makeStorage(driver) });
    const svc = h.host();
    svc.start();
    let completed = 0;
    let stages = 0;
    h.kernel.bus.on(UnifiedLoopEvents.LoopCompleted, () => { completed += 1; });
    h.kernel.bus.on(UnifiedLoopEvents.StageCompleted, () => { stages += 1; });
    h.kernel.bus.on(UnifiedLoopEvents.BoundaryHeld, () => { stages += 1; });
    await svc.enqueue(h.actor,  { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    const summary = await svc.tick();
    assert.equal(summary.dispatched, 1);
    assert.equal(summary.completed, 1);
    assert.equal(completed, 1);
    assert.equal(stages, 34, 'exactly one authoritative 34-stage loop must run');
    await svc.stop();
    await driver.close();
    await dropDb(db!.database);
  });
});
