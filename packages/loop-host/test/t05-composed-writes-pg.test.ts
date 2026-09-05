// T-05 section C/D: dispatch and settlement composition over REAL PostgreSQL.
//
// The host composes (checkpoint + work-item transition) in ONE storage
// transaction through `StorageModule.atomically` with queue/journal views
// bound to the scope (`WorkQueue.bindTo`, `CheckpointJournal.bindTo`). These
// tests prove, on a real transactional backend:
//
//   1. dispatch composition: the DISPATCHED checkpoint and the LEASED ->
//      DISPATCHED transition commit together; an injected failure after the
//      checkpoint write rolls BOTH back (no orphan checkpoint, item still
//      LEASED with its live token);
//   2. settlement composition: the SETTLED checkpoint and the terminal /
//      sleeping / bounded-retry transition commit together, or neither does;
//   3. a stale token inside the composed write is rejected by the SAME CAS
//      guard as before T-05 (StaleLeaseError) and nothing — not even the
//      checkpoint — is persisted;
//   4. T-04 ownership is intact: the CAS inside the scope runs on the
//      caller-owned client — no nested BEGIN / premature COMMIT / ROLLBACK —
//      proven by (a) the rolled-back checkpoint being invisible after the
//      scope fails and (b) the client remaining usable for further writes
//      inside the same scope after a CAS.
//
// PostgreSQL is required; the suite fails loudly when it cannot start.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import { CheckpointJournal, StaleLeaseError, WorkQueue, type HostedWorkItem, type LoopCheckpoint, type WorkSettlement } from '../src/index.js';
import { testPrincipalFor } from './helpers.js';
import { bootStorageKernel, dropDb, freshDb, makeDriver, makeStorage, pgAvailable, stopPg } from './pg-host-harness.js';

const actor = { id: 'composer', tenantId: 'acme', roles: ['agent', 'operator'] as ('agent' | 'operator')[] };

after(async () => {
  await stopPg();
});

async function node() {
  const db = await freshDb();
  if (!db) throw new Error('DATABASE INTEGRATION NOT EXECUTED: embedded PostgreSQL failed to start.');
  const driver = makeDriver(db.config);
  const storage = makeStorage(driver);
  const kernel = await bootStorageKernel(storage);
  const queue = new WorkQueue();
  const journal = new CheckpointJournal();
  await queue.init(kernel);
  await journal.init(kernel);
  return {
    db,
    driver,
    storage,
    queue,
    journal,
    async close() {
      await driver.close().catch(() => undefined);
      await dropDb(db.database);
    },
  };
}

/** Mirrors LoopHostService.composed(): both views bound to one scope. */
function composed<T>(storage: StorageModule, fn: (queue: WorkQueue, journal: CheckpointJournal) => Promise<T>): Promise<T> {
  return storage.atomically(async (scope) => {
    const [queue, journal] = await Promise.all([WorkQueue.bindTo(scope), CheckpointJournal.bindTo(scope)]);
    return fn(queue, journal);
  });
}

describe('T-05 composed host writes over real PostgreSQL', async () => {
  const available = await pgAvailable();
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(available, 'DATABASE INTEGRATION NOT EXECUTED: embedded PostgreSQL failed to start.');
  });
  if (!available) return;

  it('C: dispatch composition commits checkpoint + LEASED->DISPATCHED together', async () => {
    const n = await node();
    try {
      assert.equal(n.storage.supportsTransactions(), true);
      const item = await n.queue.enqueue(actor, { task: { objective: 'compose dispatch' } }, await testPrincipalFor(actor, Date.now()));
      const { token } = await n.queue.acquireLease(item.id, 'host-a', 30_000, Date.now());
      const leased = (await n.queue.get(actor, item.id))!;
      const { checkpoint, dispatched } = await composed(n.storage, async (queue, journal) => {
        const checkpoint = await journal.write(leased, { phase: 'DISPATCHED' }, Date.now());
        const dispatched = await queue.markDispatched(leased.id, token, checkpoint.id, Date.now());
        return { checkpoint, dispatched };
      });
      assert.equal(dispatched.status, 'DISPATCHED');
      assert.equal((await n.queue.get(actor, item.id))?.status, 'DISPATCHED');
      assert.equal((await n.journal.get(checkpoint.id))?.phase, 'DISPATCHED');
      assert.equal((await n.queue.get(actor, item.id))?.checkpointId, checkpoint.id);
    } finally {
      await n.close();
    }
  });

  it('C: an injected failure after the checkpoint write rolls back BOTH the checkpoint and the transition (T-04 ownership intact)', async () => {
    const n = await node();
    try {
      const item = await n.queue.enqueue(actor, { task: { objective: 'rollback dispatch' } }, await testPrincipalFor(actor, Date.now()));
      const { token } = await n.queue.acquireLease(item.id, 'host-a', 30_000, Date.now());
      const leased = (await n.queue.get(actor, item.id))!;
      let checkpointId = '';
      await assert.rejects(
        composed(n.storage, async (queue, journal) => {
          const checkpoint = await journal.write(leased, { phase: 'DISPATCHED' }, Date.now());
          checkpointId = checkpoint.id;
          const dispatched = await queue.markDispatched(leased.id, token, checkpoint.id, Date.now());
          assert.equal(dispatched.status, 'DISPATCHED', 'CAS applied on the caller-owned client inside the scope');
          // The client is still usable after the CAS (no premature COMMIT/ROLLBACK by the CAS):
          const again = await queue.get(actor, leased.id);
          assert.equal(again?.status, 'DISPATCHED', 'in-transaction read sees the uncommitted transition');
          throw new Error('injected failure after dispatch write');
        }),
        /injected failure after dispatch write/,
      );
      const after = (await n.queue.get(actor, item.id))!;
      assert.equal(after.status, 'LEASED', 'the transition was rolled back');
      assert.equal(after.leaseToken, token, 'the live lease is untouched');
      assert.equal(after.checkpointId, undefined);
      assert.equal(await n.journal.get(checkpointId), undefined, 'no orphan checkpoint survives the rollback');
      // The row is not left locked and the token still works: a real dispatch now succeeds.
      const ok = await composed(n.storage, async (queue, journal) => {
        const checkpoint = await journal.write(after, { phase: 'DISPATCHED' }, Date.now());
        return queue.markDispatched(after.id, token, checkpoint.id, Date.now());
      });
      assert.equal(ok.status, 'DISPATCHED');
      assert.equal(ok.checkpointSequence, 1, 'the rolled-back checkpoint never consumed a sequence');
    } finally {
      await n.close();
    }
  });

  it('D: settlement composition commits the SETTLED checkpoint together with the terminal transition, or neither', async () => {
    const n = await node();
    try {
      const item = await n.queue.enqueue(actor, { task: { objective: 'settle' } }, await testPrincipalFor(actor, Date.now()));
      const { token } = await n.queue.acquireLease(item.id, 'host-a', 30_000, Date.now());
      const leased = (await n.queue.get(actor, item.id))!;
      const dispatched = await composed(n.storage, async (queue, journal) => {
        const checkpoint = await journal.write(leased, { phase: 'DISPATCHED' }, Date.now());
        return queue.markDispatched(leased.id, token, checkpoint.id, Date.now());
      });
      const settlement: WorkSettlement = { status: 'COMPLETED', loopId: 'loop-1', loopOutcome: 'COMPLETED_DRY_RUN' };
      // Failure branch first: nothing persists.
      let orphan = '';
      await assert.rejects(
        composed(n.storage, async (queue, journal) => {
          const post = await journal.write(dispatched, { phase: 'SETTLED', loopId: 'loop-1', loopOutcome: 'COMPLETED_DRY_RUN', completedStages: ['WAKE'] }, Date.now());
          orphan = post.id;
          await queue.settleTerminal(dispatched.id, token, settlement, post.id, Date.now());
          throw new Error('injected failure after settlement write');
        }),
        /injected failure after settlement write/,
      );
      assert.equal((await n.queue.get(actor, item.id))?.status, 'DISPATCHED');
      assert.equal(await n.journal.get(orphan), undefined);
      // Success branch: both visible.
      const { post, settled } = await composed(n.storage, async (queue, journal) => {
        const post = await journal.write(dispatched, { phase: 'SETTLED', loopId: 'loop-1', loopOutcome: 'COMPLETED_DRY_RUN', completedStages: ['WAKE'] }, Date.now());
        const settled = await queue.settleTerminal(dispatched.id, token, settlement, post.id, Date.now());
        return { post, settled };
      });
      assert.equal(settled.status, 'COMPLETED');
      assert.equal((await n.queue.get(actor, item.id))?.status, 'COMPLETED');
      assert.equal((await n.journal.get(post.id))?.phase, 'SETTLED');
      assert.equal((await n.journal.latest(item.id))?.id, post.id);
    } finally {
      await n.close();
    }
  });

  it('D: bounded-retry settlement (recordFailure) composes with its checkpoint and preserves retry accounting', async () => {
    const n = await node();
    try {
      const item = await n.queue.enqueue(actor, { task: { objective: 'retry' }, maxAttempts: 3 }, await testPrincipalFor(actor, Date.now()));
      const { token } = await n.queue.acquireLease(item.id, 'host-a', 30_000, Date.now());
      const leased = (await n.queue.get(actor, item.id))!;
      const dispatched = await composed(n.storage, async (queue, journal) => {
        const checkpoint = await journal.write(leased, { phase: 'DISPATCHED' }, Date.now());
        return queue.markDispatched(leased.id, token, checkpoint.id, Date.now());
      });
      const { post, failed } = await composed(n.storage, async (queue, journal) => {
        const post = await journal.write(dispatched, { phase: 'SETTLED', loopId: 'loop-r', loopOutcome: 'FAILED_CLOSED' }, Date.now());
        const failed = await queue.recordFailure(dispatched.id, token, 'TRANSIENT', 'simulated', Date.now());
        return { post, failed };
      });
      assert.equal(failed.status, 'QUEUED');
      assert.equal(failed.attemptCount, 1);
      assert.equal(failed.leaseToken, undefined);
      assert.equal((await n.journal.get(post.id))?.loopOutcome, 'FAILED_CLOSED');
      assert.equal((await n.queue.get(actor, item.id))?.status, 'QUEUED');
    } finally {
      await n.close();
    }
  });

  it('C/F: a stale token inside the composed write is rejected by the same CAS guard, and the checkpoint written before it is rolled back', async () => {
    const n = await node();
    try {
      const item = await n.queue.enqueue(actor, { task: { objective: 'stale' } }, await testPrincipalFor(actor, Date.now()));
      await n.queue.acquireLease(item.id, 'host-a', 30_000, Date.now());
      const leased = (await n.queue.get(actor, item.id))!;
      let checkpointId = '';
      await assert.rejects(
        composed(n.storage, async (queue, journal) => {
          const checkpoint = await journal.write(leased, { phase: 'DISPATCHED' }, Date.now());
          checkpointId = checkpoint.id;
          await queue.markDispatched(leased.id, 'forged-token', checkpoint.id, Date.now());
        }),
        StaleLeaseError,
      );
      assert.equal((await n.queue.get(actor, item.id))?.status, 'LEASED');
      assert.equal(await n.journal.get(checkpointId), undefined, 'a checkpoint must never outlive its rejected transition');
    } finally {
      await n.close();
    }
  });

  it('C: two hosts racing the composed dispatch of one leased item: the token holder wins, the other is refused and writes nothing', async () => {
    const n = await node();
    const driverB = makeDriver(n.db.config);
    const storageB = makeStorage(driverB);
    await bootStorageKernel(storageB);
    try {
      const item = await n.queue.enqueue(actor, { task: { objective: 'race' } }, await testPrincipalFor(actor, Date.now()));
      const { token } = await n.queue.acquireLease(item.id, 'host-a', 30_000, Date.now());
      const leased = (await n.queue.get(actor, item.id))!;
      const [a, b] = await Promise.allSettled([
        composed(n.storage, async (queue, journal) => {
          const checkpoint = await journal.write(leased, { phase: 'DISPATCHED' }, Date.now());
          return queue.markDispatched(leased.id, token, checkpoint.id, Date.now());
        }),
        composed(storageB, async (queue, journal) => {
          const checkpoint = await journal.write(leased, { phase: 'DISPATCHED' }, Date.now());
          return queue.markDispatched(leased.id, 'host-b-forged', checkpoint.id, Date.now());
        }),
      ]);
      assert.equal(a.status, 'fulfilled');
      assert.equal(b.status, 'rejected');
      assert.ok((b as PromiseRejectedResult).reason instanceof StaleLeaseError);
      const final = (await n.queue.get(actor, item.id))!;
      assert.equal(final.status, 'DISPATCHED');
      assert.equal(final.leaseOwner, 'host-a');
      const checkpoints = await (await n.storage.collection<LoopCheckpoint>('loop-host.checkpoints')).all();
      assert.equal(checkpoints.filter((checkpoint) => checkpoint.workItemId === item.id).length, 1, 'exactly one checkpoint: the loser\'s rolled back');
      const rows = await (await n.storage.collection<HostedWorkItem>('loop-host.work-items')).all();
      assert.equal(rows.length, 1);
    } finally {
      await driverB.close().catch(() => undefined);
      await n.close();
    }
  });
});
