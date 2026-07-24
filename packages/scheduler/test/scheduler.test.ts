import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { SchedulerModule, Scheduler } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('Scheduler (unit)', () => {
  it('runs tasks and returns their results', async () => {
    const s = new Scheduler();
    const a = s.submit({ id: 'a', run: async () => 1 });
    const b = s.submit({ id: 'b', run: async () => 2 });
    assert.equal(await a, 1);
    assert.equal(await b, 2);
    await s.idle();
    assert.equal(s.stats().completed, 2);
  });

  it('respects target capacity (bounded concurrency)', async () => {
    let active = 0;
    let maxActive = 0;
    const s = new Scheduler({ defaultCapacity: 2 });
    const tasks = Array.from({ length: 6 }, (_, i) =>
      s.submit({
        id: `t${i}`,
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 20));
          active -= 1;
          return i;
        },
      }),
    );
    await Promise.all(tasks);
    assert.ok(maxActive <= 2, `maxActive=${maxActive} exceeded capacity 2`);
  });

  it('runs higher-priority tasks first when capacity is limited', async () => {
    const order: string[] = [];
    const s = new Scheduler({ defaultCapacity: 1 });
    // Block the single slot so the queue fills before any completes.
    s.submit({ id: 'blocker', run: async () => { await new Promise((r) => setTimeout(r, 30)); order.push('blocker'); } });
    await new Promise((r) => setTimeout(r, 5)); // let blocker start
    s.submit({ id: 'low', priority: 0, run: async () => { order.push('low'); } });
    s.submit({ id: 'high', priority: 10, run: async () => { order.push('high'); } });
    s.submit({ id: 'mid', priority: 5, run: async () => { order.push('mid'); } });
    await s.idle();
    assert.deepEqual(order, ['blocker', 'high', 'mid', 'low']);
  });

  it('honors dependencies', async () => {
    const s = new Scheduler({ defaultCapacity: 4 });
    const order: string[] = [];
    s.submit({ id: 'b', dependsOn: ['a'], run: async () => { order.push('b'); return 'b'; } });
    s.submit({ id: 'a', run: async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a'); return 'a'; } });
    await s.idle();
    assert.deepEqual(order, ['a', 'b']);
  });

  it('isolates capacity per registered target', async () => {
    let active = 0;
    let maxActive = 0;
    const s = new Scheduler();
    s.registerTarget({ id: 'gpu', kind: 'gpu', capacity: 1 });
    const tasks = Array.from({ length: 4 }, (_, i) =>
      s.submit({
        id: `g${i}`,
        target: 'gpu',
        run: async () => {
          active += 1; maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 15));
          active -= 1;
          return i;
        },
      }),
    );
    await Promise.all(tasks);
    assert.ok(maxActive <= 1);
  });
});

describe('SchedulerModule (kernel integration)', () => {
  let kernel: Kernel;
  let mod: SchedulerModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new SchedulerModule({ defaultCapacity: 2 }));
    await kernel.boot();
    mod = kernel.getModule<SchedulerModule>('scheduler');
  });

  it('submits tasks and tracks stats', async () => {
    await mod.submit({ run: async () => 42 });
    assert.equal(mod.stats().completed, 1);
  });

  it('emits task lifecycle events', async () => {
    const events: string[] = [];
    kernel.bus.onAny((p) => { /* not used */ });
    kernel.bus.on('scheduler.task.submitted', () => { events.push('submitted'); });
    kernel.bus.on('scheduler.task.completed', () => { events.push('completed'); });
    await mod.submit({ run: async () => 'ok' });
    assert.ok(events.includes('submitted'));
    assert.ok(events.includes('completed'));
  });

  it('registers additional targets', () => {
    mod.registerTarget({ id: 'edge', kind: 'edge', capacity: 8 });
    const tgt = mod.stats().targets.find((t) => t.id === 'edge');
    assert.ok(tgt);
    assert.equal(tgt!.capacity, 8);
  });
});
