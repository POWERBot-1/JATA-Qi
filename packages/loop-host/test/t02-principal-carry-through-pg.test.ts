// T-02 authenticated durable authority carry-through over real PostgreSQL.
//
// The memory suite proves the authority semantics; this suite proves they
// hold when the snapshot lives in an authoritative, transactional,
// multi-process database: the carried principal survives crash/restart,
// authority holds are durable across service instances, legacy rows hold,
// and a REAL separate OS process observes the persisted snapshot without
// any caller re-assertion. When PostgreSQL cannot start the suite SKIPs.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import type { AuthenticatedPrincipal } from '@jataqi/authentication';
import type { LoopRunResult } from '@jataqi/unified-loop';
import {
  LoopHostEvents,
  LoopHostService,
  PrincipalAuthorityError,
  WorkQueue,
  WORK_COLLECTION,
  type AuthenticatedPrincipalSnapshot,
  type HostedWorkItem,
  type LoopRunner,
} from '../src/index.js';
import { testPrincipalFor, reasoningTask } from './helpers.js';
import { bootStorageKernel, dropDb, freshDb, makeDriver, makeStorage, pgAvailable, stopPg } from './pg-host-harness.js';

after(async () => {
  await stopPg();
});

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'two-process-worker.mjs');

const actor: CommercialActor = { id: 't02-operator', tenantId: 'acme', roles: ['agent', 'operator'] };

function loopResult(outcome: LoopRunResult['outcome']): LoopRunResult {
  return {
    loopId: 'loop-t02-pg',
    correlationId: 'corr-t02-pg',
    tenantId: 'acme',
    outcome,
    trace: [],
    stageOutputs: {},
    records: [],
    finalStage: 'OUTCOME',
    startedAt: 1,
    endedAt: 2,
    continuation: 'TERMINATE',
  } as unknown as LoopRunResult;
}

/** Run the worker as a real child OS process with extra argv appended. */
function runWorker(
  connectionString: string,
  mode: string,
  workerId: string,
  extraArgs: string[] = [],
): Promise<{ code: number | null; lines: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, connectionString, mode, workerId, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = out
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return { workerId, event: 'unparseable', error: line };
          }
        });
      resolve({ code, lines });
    });
  });
}

describe('T-02 durable authority carry-through over real PostgreSQL', async () => {
  const available = await pgAvailable();
  if (!available) {
    it('SKIPPED: PostgreSQL integration unavailable in this environment', () => {
      assert.ok(true);
    });
    return;
  }

  it('T02-PG1: enqueue->dispatch->completed over PG carries the snapshot to the runner with audit provenance', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const kernel = await bootStorageKernel(makeStorage(driver));
    const host = new LoopHostService({ hostId: 't02-pg1', leaseTtlMs: 30_000 });
    await host.init(kernel);
    let seen: AuthenticatedPrincipal | undefined;
    host.setRunner((async (_actor, _task, opts) => {
      seen = opts.principal;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    const completed: Array<Record<string, unknown>> = [];
    kernel.bus.on(LoopHostEvents.Completed, (payload: unknown) => {
      completed.push(payload as Record<string, unknown>);
    });
    host.start();
    const principal = await testPrincipalFor(actor, Date.now());
    const item = await host.enqueue(actor, { task: reasoningTask() }, principal);
    assert.ok(item.principal, 'PG-persisted item must carry the snapshot');
    assert.equal(item.principal.authenticationEventId, principal.authenticationEventId);
    const summary = await host.tick();
    assert.equal(summary.dispatched, 1);
    assert.equal(summary.completed, 1);
    assert.ok(seen, 'runner must observe the carried principal');
    assert.equal(seen.authenticationEventId, principal.authenticationEventId);
    assert.deepEqual(seen, {
      id: principal.id,
      tenantId: principal.tenantId,
      roles: [...principal.roles],
      authenticationMethod: principal.authenticationMethod,
      verifiedAt: principal.verifiedAt,
      authenticationEventId: principal.authenticationEventId,
    });
    const settled = await host.get(actor, item.id);
    assert.equal(settled?.status, 'COMPLETED');
    assert.equal(settled?.principal?.authenticationEventId, principal.authenticationEventId);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].principalMethod, 'DETERMINISTIC_TEST');
    assert.equal(completed[0].principalEventId, principal.authenticationEventId);
    assert.equal(completed[0].principalVerifiedAt, principal.verifiedAt);
    assert.equal(completed[0].principalId, principal.id);
    await host.stop();
    await kernel.shutdown();
    await dropDb(db.database);
  });

  it('T02-PG2: a stale principal HOLDS durably and the hold is visible to a second service instance', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver1 = makeDriver(db.config);
    const kernel1 = await bootStorageKernel(makeStorage(driver1));
    const host1 = new LoopHostService({ hostId: 't02-pg2-a', leaseTtlMs: 30_000, maxPrincipalAgeMs: 1_000 });
    await host1.init(kernel1);
    host1.setRunner((async () => loopResult('COMPLETED_DRY_RUN')) as LoopRunner);
    host1.start();
    const t0 = Date.now();
    const item = await host1.enqueue(actor, { task: reasoningTask() }, await testPrincipalFor(actor, t0), t0);
    // Age out the snapshot, then dispatch on the aged clock.
    const summary = await host1.tick(t0 + 60_000);
    assert.equal(summary.held, 1);
    assert.equal((await host1.get(actor, item.id))?.heldReason, 'PRINCIPAL_STALE');

    // A second, independent service instance on the same database observes
    // the durable hold — and operator resume is refused there too.
    const driver2 = makeDriver(db.config);
    const kernel2 = await bootStorageKernel(makeStorage(driver2));
    const host2 = new LoopHostService({ hostId: 't02-pg2-b', leaseTtlMs: 30_000, maxPrincipalAgeMs: 1_000 });
    await host2.init(kernel2);
    const observed = await host2.get(actor, item.id);
    assert.equal(observed?.status, 'HELD');
    assert.equal(observed?.heldReason, 'PRINCIPAL_STALE');
    await assert.rejects(() => host2.resume(actor, item.id), PrincipalAuthorityError);
    await host1.stop();
    await kernel1.shutdown();
    await kernel2.shutdown();
    await dropDb(db.database);
  });

  it('T02-PG3: the carried principal survives crash/restart over PG (identical event id after recovery)', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver1 = makeDriver(db.config);
    const kernel1 = await bootStorageKernel(makeStorage(driver1));
    const q1 = new WorkQueue();
    await q1.init(kernel1);
    const t0 = Date.now();
    const principal = await testPrincipalFor(actor, t0);
    const item = await q1.enqueue(actor, { task: reasoningTask(), correlationId: 'corr-t02-crash' }, principal, t0);
    await q1.acquireLease(item.id, 'host1', 100, t0);
    // Crash: close the driver without settling (lease left to expire).
    await driver1.close();

    const driver2 = makeDriver(db.config);
    const kernel2 = await bootStorageKernel(makeStorage(driver2));
    const host2 = new LoopHostService({ hostId: 't02-pg3-survivor', leaseTtlMs: 20_000 });
    await host2.init(kernel2);
    const observedEventIds: string[] = [];
    host2.setRunner((async (_actor, _task, opts) => {
      observedEventIds.push(opts.principal.authenticationEventId);
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    host2.start();
    await host2.recover(t0 + 5_000);
    const summary = await host2.tick();
    assert.equal(summary.completed, 1);
    assert.deepEqual(observedEventIds, [principal.authenticationEventId]);
    const settled = await host2.get(actor, item.id);
    assert.equal(settled?.status, 'COMPLETED');
    assert.equal(settled?.principal?.authenticationEventId, principal.authenticationEventId);
    await host2.stop();
    await kernel1.shutdown().catch(() => undefined);
    await kernel2.shutdown();
    await dropDb(db.database);
  });

  it('T02-PG4: a separate OS process observes the durable snapshot with no caller re-assertion', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const kernel = await bootStorageKernel(makeStorage(driver));
    const queue = new WorkQueue();
    await queue.init(kernel);
    const principal = await testPrincipalFor(actor, Date.now());
    const item = await queue.enqueue(actor, { task: reasoningTask(), idempotencyKey: 't02-two-proc' }, principal);

    // The child receives the actor (for tenant-scoped read) and the work
    // id ONLY — no principal, no event id, no verified roles.
    const childArgv = [JSON.stringify({ id: actor.id, tenantId: actor.tenantId, roles: actor.roles }), item.id];
    assert.ok(
      !childArgv.join(' ').includes(principal.authenticationEventId),
      'the test must not smuggle principal material to the child',
    );
    const conn = db.config.connectionString as string;
    const result = await runWorker(conn, 'echo-principal', 'proc-echo', childArgv);
    assert.equal(result.code, 0);
    const echo = result.lines.find((line) => line.event === 'principal-echo');
    assert.ok(echo, `expected a principal-echo line, got ${JSON.stringify(result.lines)}`);
    assert.equal(echo.found, true);
    assert.equal(echo.workId, item.id);
    const snapshot = echo.snapshot as AuthenticatedPrincipalSnapshot;
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.principalId, principal.id);
    assert.equal(snapshot.tenantId, principal.tenantId);
    assert.deepEqual(snapshot.roles, [...principal.roles]);
    assert.equal(snapshot.authenticationMethod, 'DETERMINISTIC_TEST');
    assert.equal(snapshot.verifiedAt, principal.verifiedAt);
    assert.equal(snapshot.authenticationEventId, principal.authenticationEventId);
    await kernel.shutdown();
    await dropDb(db.database);
  });

  it('T02-PG5: a pre-T-02 legacy row in PG HOLDS with PRINCIPAL_ABSENT (never executes)', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const storage = makeStorage(driver);
    const kernel = await bootStorageKernel(storage);
    const host = new LoopHostService({ hostId: 't02-pg5', leaseTtlMs: 30_000 });
    await host.init(kernel);
    let calls = 0;
    host.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    host.start();
    // Legacy-shaped row written directly, exactly as a pre-T-02 producer left it.
    const now = Date.now();
    const legacy = {
      id: 'legacy-row-1',
      tenantId: 'acme',
      correlationId: 'corr-legacy',
      idempotencyKey: 'legacy-1',
      actor: { id: actor.id, tenantId: actor.tenantId, roles: [...actor.roles] },
      task: reasoningTask(),
      status: 'QUEUED',
      attemptCount: 0,
      maxAttempts: 3,
      checkpointSequence: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    } as unknown as HostedWorkItem;
    const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
    await items.put(legacy);
    const summary = await host.tick();
    assert.equal(calls, 0, 'a legacy row without a snapshot must never execute');
    assert.equal(summary.held, 1);
    const held = await host.get(actor, 'legacy-row-1');
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_ABSENT');
    await host.stop();
    await kernel.shutdown();
    await dropDb(db.database);
  });

  it('T02-PG6: tenant tampering in PG HOLDS with PRINCIPAL_MISMATCH through the real CAS path', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const storage = makeStorage(driver);
    const kernel = await bootStorageKernel(storage);
    const host = new LoopHostService({ hostId: 't02-pg6', leaseTtlMs: 30_000 });
    await host.init(kernel);
    let calls = 0;
    host.setRunner((async () => {
      calls += 1;
      return loopResult('COMPLETED_DRY_RUN');
    }) as LoopRunner);
    host.start();
    const item = await host.enqueue(actor, { task: reasoningTask() }, await testPrincipalFor(actor, Date.now()));
    const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
    const raw = await items.get(item.id);
    assert.ok(raw?.principal, 'expected the snapshot to be persisted in PG');
    await items.put({ ...raw, tenantId: 'other' });
    const summary = await host.tick();
    assert.equal(calls, 0);
    assert.equal(summary.held, 1);
    const queue = new WorkQueue();
    await queue.init(kernel);
    const held = await queue.getInternal(item.id);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.heldReason, 'PRINCIPAL_MISMATCH');
    await host.stop();
    await kernel.shutdown();
    await dropDb(db.database);
  });
});
