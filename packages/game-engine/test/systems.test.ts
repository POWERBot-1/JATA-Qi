// Built-in systems + simulation loop tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  World, SimulationLoop, KinematicsSystem, LifetimeSystem, TransformHierarchySystem,
  makeTransform, type Transform, type Velocity, type WorldTransform,
} from '../src/index.js';

describe('KinematicsSystem', () => {
  it('integrates linear velocity into position', () => {
    const w = new World();
    w.addSystem(new KinematicsSystem());
    const e = w.createEntity();
    w.add(e, 'Transform', makeTransform([0, 0, 0]));
    w.add<Velocity>(e, 'Velocity', { velocity: [10, 0, 0] });
    w.step(0.5);
    const t = w.get<Transform>(e, 'Transform')!;
    assert.deepEqual(t.position, [5, 0, 0]);
  });
});

describe('LifetimeSystem', () => {
  it('destroys expired entities', () => {
    const w = new World();
    w.addSystem(new LifetimeSystem());
    const e = w.createEntity();
    w.add(e, 'Lifetime', { remaining: 1 });
    w.step(0.5);
    assert.equal(w.hasEntity(e), true);
    w.step(0.6);
    assert.equal(w.hasEntity(e), false);
  });
});

describe('TransformHierarchySystem', () => {
  it('composes child transforms under a parent', () => {
    const w = new World();
    w.addSystem(new TransformHierarchySystem());
    const parent = w.createEntity();
    w.add(parent, 'Transform', makeTransform([10, 0, 0]));
    const child = w.createEntity();
    w.add<Transform>(child, 'Transform', { ...makeTransform([1, 0, 0]), parent });
    w.step(0);
    const cw = w.get<WorldTransform>(child, 'WorldTransform')!;
    assert.equal(cw.position[0], 11); // parent 10 + child local 1
    const pw = w.get<WorldTransform>(parent, 'WorldTransform')!;
    assert.equal(pw.position[0], 10);
  });
});

describe('SimulationLoop', () => {
  it('advances in fixed steps and carries the remainder', () => {
    const w = new World();
    w.addSystem(new KinematicsSystem());
    const e = w.createEntity();
    w.add(e, 'Transform', makeTransform([0, 0, 0]));
    w.add<Velocity>(e, 'Velocity', { velocity: [60, 0, 0] });
    const loop = new SimulationLoop(w, 1 / 60);
    // 100ms at 60Hz -> 6 full steps, ~40ms remainder.
    const r = loop.advance(0.1);
    assert.equal(r.steps, 6);
    assert.ok(r.remainder < 1 / 60);
    // 6 steps * (1/60) * 60 = 6 units.
    const t = w.get<Transform>(e, 'Transform')!;
    assert.equal(t.position[0], 6);
  });

  it('caps steps to avoid the spiral of death', () => {
    const w = new World();
    const loop = new SimulationLoop(w, 1 / 60);
    const r = loop.advance(10, 5); // huge backlog
    assert.equal(r.steps, 5);
    assert.equal(loop.carried, 0);
  });

  it('is deterministic: two identical worlds evolve identically', () => {
    function build(): World {
      const w = new World();
      w.addSystem(new KinematicsSystem());
      const e = w.createEntity();
      w.add(e, 'Transform', makeTransform([0, 0, 0]));
      w.add<Velocity>(e, 'Velocity', { velocity: [3, 1, 2] });
      return w;
    }
    const a = build();
    const b = build();
    for (let i = 0; i < 100; i++) { a.step(0.1); b.step(0.1); }
    assert.deepEqual(a.get<Transform>(1, 'Transform')!.position, b.get<Transform>(1, 'Transform')!.position);
  });
});
