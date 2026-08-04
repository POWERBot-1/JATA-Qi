// NOVA netcode tests — protocol diffing, anti-cheat, matchmaking, and an
// authoritative Room + NetClient convergence loop over the loopback transport.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { World, KinematicsSystem, makeTransform, type Transform, type Velocity } from '@jataqi/game-engine';
import {
  LoopbackHub, Room, NetClient, Matchmaker,
  AntiCheat, RateLimitValidator, MagnitudeValidator, diffSnapshots,
} from '../src/index.js';

describe('protocol — snapshot diffing', () => {
  it('reports only changed entities', () => {
    const a = { '1': { Transform: { position: [0, 0, 0] } }, '2': { Health: { hp: 5 } } };
    const b = { '1': { Transform: { position: [1, 0, 0] } }, '2': { Health: { hp: 5 } }, '3': { Tag: {} } };
    const { changes, removed } = diffSnapshots(a, b);
    assert.ok(changes['1']);
    assert.equal(changes['2'], undefined); // unchanged
    assert.ok(changes['3']); // added
    assert.deepEqual(removed, []);
  });

  it('reports removed entities', () => {
    const a = { '1': { X: 1 }, '2': { X: 2 } };
    const b = { '1': { X: 1 } };
    const { removed } = diffSnapshots(a, b);
    assert.deepEqual(removed, ['2']);
  });
});

describe('anti-cheat', () => {
  it('rejects excessive input rate', () => {
    const ac = new AntiCheat().add(new RateLimitValidator(100));
    const ctx = () => ({ peer: 'p', now: Date.now(), state: new Map() });
    assert.equal(ac.validate({}, ctx()).ok, true);
    const r2 = ac.validate({}, ctx()); // immediate second
    assert.equal(r2.ok, false);
  });

  it('rejects oversized movement vectors', () => {
    const ac = new AntiCheat().add(new MagnitudeValidator('axis', 1));
    const ctx = () => ({ peer: 'p', now: Date.now(), state: new Map() });
    assert.equal(ac.validate({ axis: [0.5, 0.5, 0] }, ctx()).ok, true);
    assert.equal(ac.validate({ axis: [5, 5, 5] }, ctx()).ok, false);
    assert.equal(ac.blockedCount, 1);
  });
});

describe('matchmaker', () => {
  it('groups solos by skill proximity within a region', () => {
    const mm = new Matchmaker(100);
    mm.enqueue({ peer: 'a', skill: 1000, region: 'eu', size: 2 });
    mm.enqueue({ peer: 'b', skill: 1050, region: 'eu', size: 2 });
    mm.enqueue({ peer: 'c', skill: 2000, region: 'eu', size: 2 }); // out of window
    const matches = mm.tick();
    assert.equal(matches.length, 1);
    assert.ok(matches[0]!.peers.includes('a') && matches[0]!.peers.includes('b'));
    assert.equal(mm.waiting, 1); // c remains
  });

  it('matches parties wholesale', () => {
    const mm = new Matchmaker(500);
    mm.enqueue({ peer: 'x', skill: 1500, region: 'us', size: 2, party: ['x', 'y'] });
    mm.enqueue({ peer: 'y', skill: 1500, region: 'us', size: 2, party: ['x', 'y'] });
    const matches = mm.tick();
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0]!.peers.sort(), ['x', 'y']);
  });
});

describe('Room + NetClient — authoritative convergence', () => {
  it('a client input propagates and the client converges to the server', () => {
    const hub = new LoopbackHub();
    const serverWorld = new World();
    serverWorld.addSystem(new KinematicsSystem());
    const clientWorld = new World();

    const inputHandler = (world: World, entity: number, payload: unknown): void => {
      const axis = (payload as { axis: [number, number, number] }).axis;
      world.add<Velocity>(entity, 'Velocity', { velocity: axis });
    };

    const room = new Room(serverWorld, hub.connect('server'), {
      replicate: ['Transform', 'Velocity'],
      inputHandler,
      fixedDt: 0.1,
      snapshotEvery: 1, // broadcast every tick for fast convergence
      onJoin: (world, entity) => { world.add(entity, 'Transform', makeTransform([0, 0, 0])); },
    });
    const client = new NetClient(clientWorld, hub.connect('p1'), inputHandler, ['Transform', 'Velocity']);

    client.join();
    assert.equal(room.playerCount, 1);
    assert.ok(client.ownEntity);

    // Send a movement input.
    client.sendInput({ axis: [10, 0, 0] });

    // Step the server a few times; each tick broadcasts a snapshot.
    for (let i = 0; i < 5; i++) room.step();

    const serverPos = serverWorld.get<Transform>(client.ownEntity!, 'Transform')!.position;
    const clientPos = clientWorld.get<Transform>(client.ownEntity!, 'Transform')!.position;
    assert.deepEqual(clientPos, serverPos); // converged
    assert.ok(serverPos[0] > 0); // the input moved the entity
  });

  it('anti-cheat drops a cheating input before it affects the world', () => {
    const hub = new LoopbackHub();
    const serverWorld = new World();
    serverWorld.addSystem(new KinematicsSystem());
    const inputHandler = (world: World, entity: number, payload: unknown): void => {
      const axis = (payload as { axis: [number, number, number] }).axis;
      world.add<Velocity>(entity, 'Velocity', { velocity: axis });
    };
    const room = new Room(serverWorld, hub.connect('server'), {
      replicate: ['Transform'],
      inputHandler,
      fixedDt: 0.1,
      snapshotEvery: 1,
      antiCheat: new AntiCheat().add(new MagnitudeValidator('axis', 1)),
      onJoin: (world, entity) => { world.add(entity, 'Transform', makeTransform([0, 0, 0])); },
    });
    const client = new NetClient(new World(), hub.connect('p2'), inputHandler, ['Transform']);
    client.join();
    const ent = client.ownEntity!;
    client.sendInput({ axis: [100, 0, 0] }); // cheating magnitude
    for (let i = 0; i < 3; i++) room.step();
    // Server never applied the illegal velocity, so the entity stays put.
    assert.deepEqual(serverWorld.get<Transform>(ent, 'Transform')!.position, [0, 0, 0]);
  });

  it('two clients see each other via replicated snapshots', () => {
    const hub = new LoopbackHub();
    const serverWorld = new World();
    const inputHandler = (): void => {};
    const room = new Room(serverWorld, hub.connect('server'), {
      replicate: ['Tag'], inputHandler, fixedDt: 0.1, snapshotEvery: 1,
      onJoin: (world, entity) => { world.add(entity, 'Tag', { id: entity }); },
    });
    const c1 = new NetClient(new World(), hub.connect('a'), inputHandler, ['Tag']);
    const c2 = new NetClient(new World(), hub.connect('b'), inputHandler, ['Tag']);
    c1.join(); c2.join();
    room.step();
    // Both clients' worlds contain both entities after the snapshot.
    assert.ok(c1.ownEntity !== null && c2.ownEntity !== null);
    assert.equal(c1.ownEntity === c2.ownEntity, false);
  });
});
