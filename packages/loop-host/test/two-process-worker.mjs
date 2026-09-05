// R-01 two-process acceptance worker (child process).
//
// This is a REAL separate OS process, not a second connection pool inside one
// process. It is the evidence for the audit's multi-process contention gap
// (G-11): two independent Node processes, one authoritative PostgreSQL, and the
// invariant that a given work item is executed exactly once.
//
// Usage: node two-process-worker.mjs <connectionString> <mode> <workerId> [extra...]
//   mode=compete  : try to lease every due item; print each lease win as JSON
//   mode=crash    : lease one item, then die HARD (process.exit) while holding
//                   the lease, leaving it for expiry reclaim by recovery
//   mode=echo-principal <actorJson> <workId>:
//                   read one item and print its persisted principal snapshot
//                   as JSON. The child receives NO principal material on its
//                   command line — whatever it prints came from durable
//                   PostgreSQL state (T-02 evidence).
//
// It performs no reasoning and no side effects; the runner is a stub because
// this test is about persistence-level contention, not cognition.

import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { WorkQueue } from '@jataqi/loop-host';

const [, , connectionString, mode, workerId] = process.argv;

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function main() {
  const driver = new PostgresDriver({ connectionString, requireExplicitConfig: true, max: 4 });
  const storage = new StorageModule({ driverInstance: driver });
  const kernel = createTestKernel();
  kernel.register(storage);
  await kernel.boot();

  const queue = new WorkQueue();
  await queue.init(kernel);

  const now = Date.now();

  if (mode === 'crash') {
    // Take a lease with a short TTL, announce it, then die without settling.
    const due = await queue.due(now, 1);
    if (due.length === 0) {
      emit({ workerId, event: 'nothing-due' });
      process.exit(0);
    }
    const target = due[0];
    const acquired = await queue.acquireLease(target.id, workerId, 1_000, now);
    emit({ workerId, event: 'leased-then-crashing', workId: acquired.item.id });
    // Hard kill: no drain, no settle, no cleanup. Exactly a crash.
    process.exit(9);
  }

  if (mode === 'compete') {
    const due = await queue.due(now, 50);
    const wins = [];
    for (const candidate of due) {
      try {
        const acquired = await queue.acquireLease(candidate.id, workerId, 30_000, now);
        wins.push(acquired.item.id);
        emit({ workerId, event: 'lease-won', workId: acquired.item.id });
      } catch (error) {
        emit({ workerId, event: 'lease-lost', workId: candidate.id, error: error.name });
      }
    }
    emit({ workerId, event: 'done', wins });
    await driver.close();
    process.exit(0);
  }

  if (mode === 'echo-principal') {
    const [, , , , , actorJson, workId] = process.argv;
    const actor = JSON.parse(actorJson);
    const item = await queue.get(actor, workId);
    if (!item) {
      emit({ workerId, event: 'principal-echo', found: false });
      await driver.close();
      process.exit(1);
    }
    emit({
      workerId,
      event: 'principal-echo',
      found: true,
      workId: item.id,
      tenantId: item.tenantId,
      status: item.status,
      snapshot: item.principal ?? null,
    });
    await driver.close();
    process.exit(0);
  }

  emit({ workerId, event: 'unknown-mode', mode });
  await driver.close();
  process.exit(1);
}

main().catch((error) => {
  emit({ workerId, event: 'fatal', error: String(error?.message ?? error) });
  process.exit(1);
});
