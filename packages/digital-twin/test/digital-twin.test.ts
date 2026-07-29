import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalTwinModule, step, project } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('twin-engine (pure)', () => {
  it('applies transition rules simultaneously', () => {
    // next.a = state.a + state.b ; next.b = state.b (unchanged)
    const next = step({ a: 1, b: 2 }, [{ key: 'a', from: [{ key: 'a', factor: 1 }, { key: 'b', factor: 1 }] }]);
    assert.deepEqual(next, { a: 3, b: 2 });
  });

  it('projects a trajectory', () => {
    // population grows 10% each step
    const traj = project({ pop: 100 }, [{ key: 'pop', from: [{ key: 'pop', factor: 1.1 }] }], 3);
    assert.equal(traj.length, 4); // initial + 3 steps
    assert.ok(Math.abs(traj[3]!.pop! - 133.1) < 0.1);
  });
});

describe('DigitalTwinModule (kernel integration)', () => {
  let kernel: Kernel;
  let dt: DigitalTwinModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalTwinModule());
    await kernel.boot();
    dt = kernel.getModule<DigitalTwinModule>('digital-twin');
  });

  it('registers, lists, and filters twins', async () => {
    await dt.register({ type: 'city', name: 'Nairobi', state: { pop: 100, jobs: 50 } });
    await dt.register({ type: 'factory', name: 'Plant1', state: { units: 0 } });
    assert.equal((await dt.list()).length, 2);
    assert.equal((await dt.list('factory')).length, 1);
  });

  it('steps a twin forward and records snapshot history', async () => {
    const t = await dt.register({ type: 'pond', name: 'P', state: { water: 100 } });
    // next.water = -10 + 1 * water  (drain 10 units)
    const stepped = await dt.step(t.id, [{ key: 'water', add: -10, from: [{ key: 'water', factor: 1 }] }]);
    assert.equal(stepped.state.water, 90);
    assert.equal(stepped.history.length, 2); // initial + 1 step
    assert.equal(stepped.history[1]!.t, 1);
  });

  it('projects without persisting', async () => {
    const t = await dt.register({ type: 'acct', name: 'A', state: { balance: 1000 } });
    const traj = await dt.project(t.id, [{ key: 'balance', from: [{ key: 'balance', factor: 1.05 }] }], 4);
    assert.equal(traj.length, 5);
    assert.ok(traj[4]!.balance! > 1200);
    // twin state unchanged
    const fresh = await dt.get(t.id);
    assert.equal(fresh!.state.balance, 1000);
  });

  it('updates partial state', async () => {
    const t = await dt.register({ type: 'sensor', name: 'S', state: { temp: 20, hum: 50 } });
    const u = await dt.update(t.id, { temp: 25 });
    assert.equal(u.state.temp, 25);
    assert.equal(u.state.hum, 50);
  });

  it('emits a stepped event', async () => {
    let fired = false;
    kernel.bus.on('twin.stepped', () => { fired = true; });
    const t = await dt.register({ type: 'x', name: 'x', state: { v: 1 } });
    await dt.step(t.id, [{ key: 'v', add: 1 }]);
    assert.equal(fired, true);
  });
});
