// ECS World tests — entities, components, queries, events, serialization.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { World, makeTransform, type Transform, type Lifetime } from '../src/index.js';

describe('World — entities & components', () => {
  it('creates unique entities and stores components', () => {
    const w = new World();
    const e1 = w.createEntity();
    const e2 = w.createEntity();
    assert.notEqual(e1, e2);
    w.add(e1, 'Name', { name: 'Player' });
    assert.equal(w.has(e1, 'Name'), true);
    assert.equal(w.get<{ name: string }>(e1, 'Name')!.name, 'Player');
    assert.equal(w.has(e2, 'Name'), false);
  });

  it('removes components and destroys entities', () => {
    const w = new World();
    const e = w.createEntity();
    w.add(e, 'Health', { hp: 10 });
    assert.equal(w.remove(e, 'Health'), true);
    assert.equal(w.has(e, 'Health'), false);
    assert.equal(w.destroyEntity(e), true);
    assert.equal(w.hasEntity(e), false);
  });

  it('throws on adding a component to a missing entity', () => {
    const w = new World();
    assert.throws(() => w.add(999, 'X', {}));
  });
});

describe('World — queries', () => {
  it('selects by all/any/none', () => {
    const w = new World();
    const a = w.createEntity(); // Transform + Velocity
    const b = w.createEntity(); // Transform only
    const c = w.createEntity(); // Transform + Velocity + Enemy
    w.add(a, 'Transform', makeTransform());
    w.add(a, 'Velocity', { velocity: [1, 0, 0] });
    w.add(b, 'Transform', makeTransform());
    w.add(c, 'Transform', makeTransform());
    w.add(c, 'Velocity', { velocity: [0, 1, 0] });
    w.add(c, 'Enemy', {});

    assert.deepEqual(w.query({ all: ['Transform', 'Velocity'] }).sort(), [a, c]);
    assert.deepEqual(w.query({ all: ['Transform'], none: ['Velocity'] }), [b]);
    assert.deepEqual(w.query({ any: ['Velocity', 'Enemy'] }).sort(), [a, c]);
  });
});

describe('World — stepping & priority', () => {
  it('runs systems in priority order each step', () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({ name: 'B', priority: 2, update: () => order.push('B') });
    w.addSystem({ name: 'A', priority: 1, update: () => order.push('A') });
    w.step(0.016);
    assert.deepEqual(order, ['A', 'B']);
    assert.equal(w.tick, 1);
  });
});

describe('World — events', () => {
  it('emits entity/component events', () => {
    const w = new World();
    const events: string[] = [];
    w.on('entity.created', () => { events.push('created'); });
    w.on('component.added', (e) => { events.push(`add:${e.component}`); });
    const e = w.createEntity();
    w.add(e, 'Tag', {});
    assert.deepEqual(events, ['created', 'add:Tag']);
  });
});

describe('World — serialize / load', () => {
  it('round-trips a world through JSON', () => {
    const w = new World();
    const e = w.createEntity();
    w.add<Transform>(e, 'Transform', makeTransform([1, 2, 3]));
    w.add<Lifetime>(e, 'Lifetime', { remaining: 5 });
    w.step(0.5);
    const data = JSON.parse(JSON.stringify(w.serialize()));

    const w2 = new World();
    w2.load(data);
    assert.equal(w2.hasEntity(e), true);
    const t = w2.get<Transform>(e, 'Transform')!;
    assert.deepEqual(t.position, [1, 2, 3]);
    assert.equal(w2.get<Lifetime>(e, 'Lifetime')!.remaining, 5);
    assert.equal(w2.time, w.time);
  });
});
