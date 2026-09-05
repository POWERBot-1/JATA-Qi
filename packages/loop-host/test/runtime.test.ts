// R-01 host runtime supervision tests (in-memory, deterministic, no network).
//
// These prove the supervision mechanism itself: durable-storage fail-closed,
// boot-time recovery ordering, unattended multi-cycle operation, sleep/wake
// re-entry into the full governed loop, graceful shutdown without fabricated
// outcomes, and preservation of terminal governance states.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { LoopRunResult } from '@jataqi/unified-loop';
import {
  HostRuntime,
  LoopHostEvents,
  NonDurableStorageError,
  assertDurableStorage,
  isDurableDriver,
  type LoopRunner,
} from '../src/index.js';
import { testPrincipalFor, buildHarness, reasoningTask } from './helpers.js';

function loopResult(outcome: LoopRunResult['outcome'], loopId = `loop:${Math.random().toString(36).slice(2)}`): LoopRunResult {
  return {
    loopId,
    correlationId: 'corr',
    tenantId: 'acme',
    outcome,
    trace: [{ stage: 'WAKE', status: 'COMPLETED', summary: 'woke', at: Date.now() }],
    startedAt: Date.now(),
    endedAt: Date.now(),
  } as unknown as LoopRunResult;
}

/** Immediate sleep so multi-cycle tests do not spend wall-clock time. */
const fastSleep = () => Promise.resolve();

describe('R-01 host runtime — durable storage boundary', () => {
  it('classifies development-only drivers as non-durable', () => {
    assert.equal(isDurableDriver('memory'), false);
    assert.equal(isDurableDriver('filesystem'), false);
    assert.equal(isDurableDriver('postgres'), true);
  });

  it('assertDurableStorage fails closed for memory and filesystem', () => {
    assert.throws(() => assertDurableStorage('memory'), NonDurableStorageError);
    assert.throws(() => assertDurableStorage('filesystem'), NonDurableStorageError);
    assert.doesNotThrow(() => assertDurableStorage('postgres'));
  });

  it('refuses to run unattended on a non-durable driver (never silently degrades)', async () => {
    const h = await buildHarness();
    const runtime = new HostRuntime(h.host(), {
      requireDurableStorage: true,
      installSignalHandlers: false,
    });
    await assert.rejects(() => runtime.run(h.kernel as never), NonDurableStorageError);
    // The host must not have been started by a refused runtime.
    assert.equal(h.host().getLifecycle(), 'IDLE');
  });

  it('explicit development opt-out permits a non-durable driver', async () => {
    const h = await buildHarness();
    const runtime = new HostRuntime(h.host(), {
      requireDurableStorage: false,
      installSignalHandlers: false,
      maxCycles: 1,
      sleep: fastSleep,
    });
    await runtime.run(h.kernel as never);
    assert.equal(runtime.getStatus(), 'STOPPED');
  });
});

describe('R-01 host runtime — boot recovery and unattended cycles', () => {
  it('runs boot-time recovery BEFORE the first tick', async () => {
    const h = await buildHarness();
    const order: string[] = [];
    const host = h.host();
    const realRecover = host.recover.bind(host);
    const realTick = host.tick.bind(host);
    (host as unknown as { recover: typeof realRecover }).recover = async (now?: number) => {
      order.push('recover');
      return realRecover(now);
    };
    (host as unknown as { tick: typeof realTick }).tick = async (now?: number) => {
      order.push('tick');
      return realTick(now);
    };

    const runtime = new HostRuntime(host, {
      requireDurableStorage: false,
      installSignalHandlers: false,
      recoverOnBoot: true,
      maxCycles: 2,
      sleep: fastSleep,
    });
    await runtime.run(h.kernel as never);

    assert.equal(order[0], 'recover', 'recovery must precede the first dispatch');
    assert.ok(order.slice(1).every((step) => step === 'tick'));
    assert.ok(runtime.getBootRecovery() !== undefined);
  });

  it('performs multiple unattended cycles with no human invoking each one', async () => {
    const h = await buildHarness();
    const runtime = new HostRuntime(h.host(), {
      requireDurableStorage: false,
      installSignalHandlers: false,
      maxCycles: 5,
      sleep: fastSleep,
    });
    await runtime.run(h.kernel as never);
    const cycles = runtime.getCycles();
    assert.equal(cycles.length, 5, 'five cycles must run from a single run() call');
    // Indices are monotonic — evidence of genuine repeated supervision.
    cycles.forEach((cycle, index) => assert.equal(cycle.index, index));
  });

  it('a sleeping item re-wakes on a later cycle and re-enters the full governed loop', async () => {
    const h = await buildHarness();
    const host = h.host();
    const dispatches: number[] = [];
    let call = 0;
    const runner: LoopRunner = async () => {
      call += 1;
      dispatches.push(call);
      // First dispatch parks the item; second completes it.
      return call === 1 ? loopResult('SLEEP_PENDING') : loopResult('COMPLETED_DRY_RUN');
    };
    host.setRunner(runner);
    await host.enqueue(h.actor,  { task: reasoningTask(), idempotencyKey: 'r01-sleep' }, await testPrincipalFor(h.actor, h.now()));

    const runtime = new HostRuntime(host, {
      requireDurableStorage: false,
      installSignalHandlers: false,
      maxCycles: 12,
      minIdleMs: 0,
      maxIdleMs: 0,
      // Deterministic virtual time: each supervised idle advances the harness
      // clock past the park window, so the re-wake is caused by the runtime's
      // own sleep/wake cycle rather than by wall-clock racing.
      sleep: async () => {
        h.advance(40_000);
      },
      now: () => h.now(),
    });
    await runtime.run(h.kernel as never);

    assert.ok(dispatches.length >= 2, `expected a re-wake dispatch, saw ${dispatches.length}`);
    const item = (await host.list(h.actor, {}))[0];
    assert.ok(item);
    // The re-dispatch went through the host, which always re-enters the whole loop.
    assert.equal(item.status, 'COMPLETED');
  });

  it('emits runtime lifecycle events for operator observability', async () => {
    const h = await buildHarness();
    const seen: string[] = [];
    h.kernel.bus.on(LoopHostEvents.RuntimeStarted, () => void seen.push('started'));
    h.kernel.bus.on(LoopHostEvents.RuntimeStopped, () => void seen.push('stopped'));
    const runtime = new HostRuntime(h.host(), {
      requireDurableStorage: false,
      installSignalHandlers: false,
      maxCycles: 1,
      sleep: fastSleep,
    });
    await runtime.run(h.kernel as never);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ['started', 'stopped']);
  });
});

describe('R-01 host runtime — graceful shutdown and fail-closed behaviour', () => {
  it('shutdown() drains and stops the host without fabricating an outcome', async () => {
    const h = await buildHarness();
    const host = h.host();
    host.setRunner(async () => loopResult('COMPLETED_DRY_RUN'));
    await host.enqueue(h.actor,  { task: reasoningTask(), idempotencyKey: 'r01-drain' }, await testPrincipalFor(h.actor, h.now()));

    const runtime = new HostRuntime(host, {
      requireDurableStorage: false,
      installSignalHandlers: false,
      minIdleMs: 5,
      maxIdleMs: 10,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const running = runtime.run(h.kernel as never);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await runtime.shutdown();
    await running;

    assert.equal(runtime.getStatus(), 'STOPPED');
    assert.equal(host.getLifecycle(), 'STOPPED');
    // Nothing may be invented: every item is in a real recorded state.
    for (const item of await host.list(h.actor, {})) {
      assert.ok(['QUEUED', 'SLEEPING', 'LEASED', 'DISPATCHED', 'COMPLETED', 'HELD', 'DENIED', 'DLQ'].includes(item.status));
    }
  });

  it('a failing tick does not kill the runtime and never fabricates success', async () => {
    const h = await buildHarness();
    const host = h.host();
    let ticks = 0;
    (host as unknown as { tick: () => Promise<never> }).tick = async () => {
      ticks += 1;
      throw new Error('simulated substrate failure');
    };
    const runtime = new HostRuntime(host, {
      requireDurableStorage: false,
      installSignalHandlers: false,
      maxCycles: 3,
      sleep: fastSleep,
    });
    await runtime.run(h.kernel as never);
    assert.equal(ticks, 3, 'runtime must survive cycle failures');
    for (const cycle of runtime.getCycles()) {
      assert.match(cycle.error ?? '', /simulated substrate failure/);
      assert.equal(cycle.completed, 0, 'a failed cycle must never report completions');
    }
  });

  it('HELD stays terminal-pending-human across supervised cycles (never auto-retried)', async () => {
    const h = await buildHarness();
    const host = h.host();
    let calls = 0;
    host.setRunner(async () => {
      calls += 1;
      return loopResult('HELD_AT_GATE');
    });
    await host.enqueue(h.actor,  { task: reasoningTask(), idempotencyKey: 'r01-held' }, await testPrincipalFor(h.actor, h.now()));

    const runtime = new HostRuntime(host, {
      requireDurableStorage: false,
      installSignalHandlers: false,
      maxCycles: 6,
      sleep: fastSleep,
      // T-02: the supervisor clock must match the host clock, otherwise the
      // carried principal reads as stale at dispatch (same pattern as above).
      now: () => h.now(),
    });
    await runtime.run(h.kernel as never);

    assert.equal(calls, 1, 'a HELD item must never be re-dispatched by the supervisor');
    const item = (await host.list(h.actor, {}))[0];
    assert.equal(item?.status, 'HELD');
  });

  it('DENIED stays terminal across supervised cycles', async () => {
    const h = await buildHarness();
    const host = h.host();
    let calls = 0;
    host.setRunner(async () => {
      calls += 1;
      return loopResult('DENIED');
    });
    await host.enqueue(h.actor,  { task: reasoningTask(), idempotencyKey: 'r01-denied' }, await testPrincipalFor(h.actor, h.now()));

    const runtime = new HostRuntime(host, {
      requireDurableStorage: false,
      installSignalHandlers: false,
      maxCycles: 6,
      sleep: fastSleep,
      // T-02: the supervisor clock must match the host clock, otherwise the
      // carried principal reads as stale at dispatch (same pattern as above).
      now: () => h.now(),
    });
    await runtime.run(h.kernel as never);

    assert.equal(calls, 1, 'a DENIED item is terminal and must never be retried');
    const item = (await host.list(h.actor, {}))[0];
    assert.equal(item?.status, 'DENIED');
  });

  it('rejects invalid supervision configuration (fail closed)', async () => {
    const h = await buildHarness();
    assert.throws(() => new HostRuntime(h.host(), { minIdleMs: 100, maxIdleMs: 10 }), /maxIdleMs must be >= minIdleMs/);
    assert.throws(() => new HostRuntime(h.host(), { maxCycles: 0 }), /maxCycles must be a positive integer/);
  });

  it('cannot be run twice from the same instance', async () => {
    const h = await buildHarness();
    const runtime = new HostRuntime(h.host(), {
      requireDurableStorage: false,
      installSignalHandlers: false,
      maxCycles: 1,
      sleep: fastSleep,
    });
    await runtime.run(h.kernel as never);
    await assert.rejects(() => runtime.run(h.kernel as never), /cannot run from status/);
  });
});

describe('R-01 host runtime — storage module contract', () => {
  it('reads the driver id through the public storage module (no driver internals)', async () => {
    const kernel = createTestKernel();
    const storage = new StorageModule({ driver: 'memory' });
    kernel.register(storage);
    await kernel.boot();
    assert.equal(kernel.getModule<StorageModule>('storage').getDriver().id, 'memory');
    await kernel.shutdown();
  });
});
