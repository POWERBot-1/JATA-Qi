// O-01 queue / lease / checkpoint unit acceptance (O1–O5, O13–O14 mechanics, O25–O26).
//
// Exercises WorkQueue, CheckpointJournal, and the scheduler eligibility policy
// directly against the real storage abstraction with a deterministic clock.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import {
  CheckpointJournal,
  InvalidWorkTransitionError,
  LeaseConflictError,
  StaleLeaseError,
  TenantIsolationError,
  WorkQueue,
  computeBackoffMs,
  isDispatchEligible,
  isReclaimable,
  nextWakeInMs,
  LOOP_HOST_CHECKPOINT_SCHEMA_VERSION,
  type HostedWorkItem,
  type LoopCheckpoint,
} from '../src/index.js';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import { testPrincipalFor } from './helpers.js';

const actor: CommercialActor = { id: 'agent-1', tenantId: 'acme', roles: ['agent', 'operator'] };
const stranger: CommercialActor = { id: 'agent-9', tenantId: 'other', roles: ['agent'] };

function task() {
  return { objective: 'Unit-test objective for queue mechanics.' };
}

async function boot() {
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  await kernel.boot();
  const queue = new WorkQueue();
  const journal = new CheckpointJournal();
  await queue.init(kernel);
  await journal.init(kernel);
  return { kernel, queue, journal };
}

describe('O-01 work queue — creation, tenancy, idempotency (O1, O26)', () => {
  it('O1: enqueue creates a tenant-scoped QUEUED record with correlation and idempotency identity', async () => {
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task() }, await testPrincipalFor(actor, 1_000),  1_000);
    assert.equal(item.status, 'QUEUED');
    assert.equal(item.tenantId, 'acme');
    assert.ok(item.id.length > 0);
    assert.ok(item.correlationId.length > 0);
    assert.ok(item.idempotencyKey.length > 0);
    assert.equal(item.attemptCount, 0);
    assert.equal(item.checkpointSequence, 0);
  });

  it('O1: cross-tenant reads are rejected fail-closed', async () => {
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task() }, await testPrincipalFor(actor, 1_000),  1_000);
    await assert.rejects(() => queue.get(stranger, item.id), TenantIsolationError);
    assert.deepEqual(await queue.list(stranger, {}), []);
    assert.equal((await queue.list(actor, {})).length, 1);
  });

  it('O26: re-enqueue with the same idempotency key returns the existing record (no duplicate)', async () => {
    const { queue } = await boot();
    const first = await queue.enqueue(actor,  { task: task(), idempotencyKey: 'k-1' }, await testPrincipalFor(actor, 1_000),  1_000);
    const second = await queue.enqueue(actor,  { task: task(), idempotencyKey: 'k-1' }, await testPrincipalFor(actor, 2_000),  2_000);
    assert.equal(first.id, second.id);
    assert.equal((await queue.list(actor, {})).length, 1);
  });

  it('O26: terminal settlement delivery is idempotent for the same loop run, refused otherwise', async () => {
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task() }, await testPrincipalFor(actor, 1_000),  1_000);
    const { token } = await queue.acquireLease(item.id, 'owner-a', 5_000, 1_000);
    const ck = await queue.markDispatched(item.id, token, 'ckpt-1', 1_000);
    assert.equal(ck.attemptCount, 1);
    const settled = await queue.settleTerminal(item.id, token, { status: 'COMPLETED', loopId: 'loop-1', loopOutcome: 'COMPLETED_DRY_RUN' }, 'ckpt-2', 1_000);
    assert.equal(settled.status, 'COMPLETED');
    const replay = await queue.settleTerminal(item.id, token, { status: 'COMPLETED', loopId: 'loop-1', loopOutcome: 'COMPLETED_DRY_RUN' }, 'ckpt-2', 1_000);
    assert.equal(replay.loopId, 'loop-1');
    await assert.rejects(
      () => queue.settleTerminal(item.id, token, { status: 'COMPLETED', loopId: 'loop-2', loopOutcome: 'COMPLETED_DRY_RUN' }, 'ckpt-3', 1_000),
      InvalidWorkTransitionError,
    );
  });
});

describe('O-01 leases — exclusivity, expiry, stale holders (O2, O3, O4)', () => {
  it('O2: an active lease cannot be double-acquired', async () => {
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task() }, await testPrincipalFor(actor, 1_000),  1_000);
    await queue.acquireLease(item.id, 'owner-a', 5_000, 1_000);
    await assert.rejects(() => queue.acquireLease(item.id, 'owner-b', 5_000, 2_000), LeaseConflictError);
  });

  it('O3: an expired lease is safely reclaimed; an active lease is never stolen', async () => {
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task() }, await testPrincipalFor(actor, 1_000),  1_000);
    await queue.acquireLease(item.id, 'owner-a', 1_000, 1_000);
    await assert.rejects(() => queue.reclaimExpired(item.id, 1_500), LeaseConflictError);
    const reclaimed = await queue.reclaimExpired(item.id, 2_001);
    assert.equal(reclaimed.status, 'QUEUED');
    assert.equal(reclaimed.leaseToken, undefined);
    assert.ok((reclaimed.lastError ?? '').includes('expired'));
  });

  it('O4: a stale lease holder cannot commit; the current holder is unaffected', async () => {
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task() }, await testPrincipalFor(actor, 1_000),  1_000);
    const first = await queue.acquireLease(item.id, 'owner-a', 1_000, 1_000);
    // Recovery reclaims the expired lease before any new holder is admitted.
    await queue.reclaimExpired(item.id, 2_001);
    const second = await queue.acquireLease(item.id, 'owner-b', 5_000, 2_001);
    await assert.rejects(
      () => queue.settleTerminal(item.id, first.token, { status: 'COMPLETED', loopId: 'loop-x', loopOutcome: 'COMPLETED_DRY_RUN' }, 'ckpt-x', 2_002),
      StaleLeaseError,
    );
    const current = await queue.getInternal(item.id);
    assert.equal(current?.status, 'LEASED');
    assert.equal(current?.leaseOwner, 'owner-b');
    // The valid holder can still proceed.
    await queue.markDispatched(item.id, second.token, 'ckpt-1', 2_002);
    const settled = await queue.settleTerminal(item.id, second.token, { status: 'COMPLETED', loopId: 'loop-y', loopOutcome: 'COMPLETED_DRY_RUN' }, 'ckpt-2', 2_002);
    assert.equal(settled.loopId, 'loop-y');
  });

  it('O2: release requires the live token and returns the record to QUEUED', async () => {
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task() }, await testPrincipalFor(actor, 1_000),  1_000);
    const { token } = await queue.acquireLease(item.id, 'owner-a', 5_000, 1_000);
    await assert.rejects(() => queue.releaseLease(item.id, 'wrong-token', 1_000), StaleLeaseError);
    const released = await queue.releaseLease(item.id, token, 1_000);
    assert.equal(released.status, 'QUEUED');
  });
});

describe('O-01 retries and DLQ (O13, O14)', () => {
  it('O13: transient failures requeue with bounded exponential backoff', async () => {
    assert.equal(computeBackoffMs(1, 1_000, 60_000), 1_000);
    assert.equal(computeBackoffMs(2, 1_000, 60_000), 2_000);
    assert.equal(computeBackoffMs(3, 1_000, 60_000), 4_000);
    assert.equal(computeBackoffMs(9, 1_000, 5_000), 5_000);
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task(), maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 }, await testPrincipalFor(actor, 1_000),  1_000);
    const first = await queue.acquireLease(item.id, 'h', 5_000, 1_000);
    await queue.markDispatched(item.id, first.token, 'c1', 1_000);
    const retry = await queue.recordFailure(item.id, first.token, 'TRANSIENT', 'boom', 1_000);
    assert.equal(retry.status, 'QUEUED');
    assert.equal(retry.availableAt, 2_000);
    assert.ok((retry.lastError ?? '').includes('boom'));
  });

  it('O14: exhausted budgets and permanent failures reach DLQ with a recorded reason', async () => {
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task(), maxAttempts: 1 }, await testPrincipalFor(actor, 1_000),  1_000);
    const held = await queue.acquireLease(item.id, 'h', 5_000, 1_000);
    await queue.markDispatched(item.id, held.token, 'c1', 1_000);
    const dead = await queue.recordFailure(item.id, held.token, 'TRANSIENT', 'boom', 1_000);
    assert.equal(dead.status, 'DLQ');
    assert.ok((dead.dlqReason ?? '').includes('boom'));

    const item2 = await queue.enqueue(actor,  { task: task(), maxAttempts: 5 }, await testPrincipalFor(actor, 1_000),  1_000);
    const held2 = await queue.acquireLease(item2.id, 'h', 5_000, 1_000);
    await queue.markDispatched(item2.id, held2.token, 'c1', 1_000);
    const dead2 = await queue.recordFailure(item2.id, held2.token, 'PERMANENT', 'malformed', 1_000);
    assert.equal(dead2.status, 'DLQ');
  });

  it('HELD/SLEEPING terminal-adjacent records resume only via explicit operator resume', async () => {
    const { queue } = await boot();
    const item = await queue.enqueue(actor,  { task: task() }, await testPrincipalFor(actor, 1_000),  1_000);
    const { token } = await queue.acquireLease(item.id, 'h', 5_000, 1_000);
    await queue.markDispatched(item.id, token, 'c1', 1_000);
    await queue.settleTerminal(item.id, token, { status: 'HELD', loopId: 'loop-1', loopOutcome: 'HELD_AT_GATE' }, 'c2', 1_000);
    const resumed = await queue.resumeWork(actor, item.id, 2_000);
    assert.equal(resumed.status, 'QUEUED');
    assert.equal(resumed.availableAt, 2_000);
    await assert.rejects(() => queue.resumeWork(stranger, item.id, 2_000), TenantIsolationError);
    // Terminal DENIED records are never resumable.
    const item2 = await queue.enqueue(actor,  { task: task() }, await testPrincipalFor(actor, 1_000),  1_000);
    const held2 = await queue.acquireLease(item2.id, 'h', 5_000, 1_000);
    await queue.markDispatched(item2.id, held2.token, 'c1', 1_000);
    await queue.settleTerminal(item2.id, held2.token, { status: 'DENIED', loopId: 'loop-9', loopOutcome: 'DENIED' }, 'c2', 1_000);
    await assert.rejects(() => queue.resumeWork(actor, item2.id, 2_000), InvalidWorkTransitionError);
  });
});

describe('O-01 checkpoints — versioning and integrity (O5, O25)', () => {
  function workItem(): HostedWorkItem {
    return {
      id: 'work-1',
      tenantId: 'acme',
      correlationId: 'corr-1',
      idempotencyKey: 'k-1',
      task: task(),
      actor: { id: 'agent-1', tenantId: 'acme', roles: ['agent'] },
      status: 'LEASED',
      attemptCount: 1,
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      availableAt: 1_000,
      checkpointSequence: 0,
    };
  }

  it('O5: checkpoints are versioned, sequenced, and integrity-tagged; valid reads pass', async () => {
    const { journal } = await boot();
    const checkpoint = await journal.write(workItem(), { phase: 'DISPATCHED' }, 1_000);
    assert.equal(checkpoint.schemaVersion, LOOP_HOST_CHECKPOINT_SCHEMA_VERSION);
    assert.equal(checkpoint.sequence, 1);
    assert.ok(checkpoint.integrity.length === 64);
    assert.ok(checkpoint.taskFingerprint.length === 64);
    const read = await journal.readLatest({ ...workItem(), checkpointSequence: 1 });
    assert.equal(read?.id, checkpoint.id);
  });

  it('O5: tampered checkpoints fail closed on read', async () => {
    const { kernel, journal } = await boot();
    const checkpoint = await journal.write(workItem(), { phase: 'DISPATCHED' }, 1_000);
    const collection = await kernel.getModule<StorageModule>('storage').collection<LoopCheckpoint>('loop-host.checkpoints');
    const tampered: LoopCheckpoint = { ...checkpoint, attempt: 99 };
    await collection.put(tampered);
    const { CheckpointIntegrityError } = await import('../src/index.js');
    await assert.rejects(() => journal.readLatest({ ...workItem(), checkpointSequence: 1 }), CheckpointIntegrityError);
  });

  it('O25: future schema versions fail closed (never silently accepted)', async () => {
    const { kernel, journal } = await boot();
    const checkpoint = await journal.write(workItem(), { phase: 'DISPATCHED' }, 1_000);
    const collection = await kernel.getModule<StorageModule>('storage').collection<LoopCheckpoint>('loop-host.checkpoints');
    const future = { ...checkpoint, schemaVersion: LOOP_HOST_CHECKPOINT_SCHEMA_VERSION + 99 };
    await collection.put({ ...future, integrity: future.integrity });
    const { IncompatibleCheckpointError } = await import('../src/index.js');
    // Integrity still matches the tampered version field (recompute to isolate the version gate).
    const { canonicalJson, sha256Hex } = await import('../src/index.js');
    const core = {
      schemaVersion: future.schemaVersion,
      workItemId: future.workItemId,
      tenantId: future.tenantId,
      correlationId: future.correlationId,
      phase: future.phase,
      sequence: future.sequence,
      attempt: future.attempt,
      loopId: undefined,
      loopOutcome: undefined,
      completedStages: undefined,
      taskFingerprint: future.taskFingerprint,
      createdAt: future.createdAt,
    };
    await collection.put({ ...future, integrity: sha256Hex(canonicalJson(core)) });
    await assert.rejects(() => journal.readLatest({ ...workItem(), checkpointSequence: 1 }), IncompatibleCheckpointError);
  });

  it('O5: checkpoints bound to a different task or tenant fail closed', async () => {
    const { journal } = await boot();
    await journal.write(workItem(), { phase: 'DISPATCHED' }, 1_000);
    const drifted = { ...workItem(), checkpointSequence: 1, task: { objective: 'A different objective.' } };
    const { CheckpointIntegrityError } = await import('../src/index.js');
    await assert.rejects(() => journal.readLatest(drifted), CheckpointIntegrityError);
  });
});

describe('O-01 scheduler eligibility policy (O16 mechanics)', () => {
  function item(overrides: Partial<HostedWorkItem>): HostedWorkItem {
    return {
      id: 'w',
      tenantId: 'acme',
      correlationId: 'c',
      idempotencyKey: 'k',
      task: task(),
      actor: { id: 'a', tenantId: 'acme', roles: ['agent'] },
      status: 'QUEUED',
      attemptCount: 0,
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      availableAt: 1_000,
      checkpointSequence: 0,
      ...overrides,
    };
  }

  it('O16: only due, unleased queue/sleep records are eligible', async () => {
    assert.equal(isDispatchEligible(item({}), 1_000), true);
    assert.equal(isDispatchEligible(item({ availableAt: 2_000 }), 1_000), false);
    assert.equal(isDispatchEligible(item({ status: 'SLEEPING' }), 1_000), true);
    assert.equal(isDispatchEligible(item({ status: 'COMPLETED' }), 1_000), false);
    assert.equal(isDispatchEligible(item({ leaseToken: 't', leaseExpiry: 9_999 }), 1_000), false);
    assert.equal(isReclaimable(item({ status: 'DISPATCHED', leaseExpiry: 500 }), 1_000), true);
    assert.equal(isReclaimable(item({ status: 'DISPATCHED', leaseExpiry: 9_999 }), 1_000), false);
    assert.equal(isReclaimable(item({ status: 'QUEUED' }), 1_000), false);
    assert.equal(nextWakeInMs([item({ availableAt: 5_000 })], 1_000), 4_000);
    assert.equal(nextWakeInMs([item({ availableAt: 500 })], 1_000), 0);
    assert.equal(nextWakeInMs([], 1_000), undefined);
  });
});
