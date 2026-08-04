// Physics engine tests — collision detection, impulse resolution, gravity,
// distance constraints, raycasting, and determinism.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsWorld, collide, type RigidBody } from '../src/index.js';

function sphere(id: number, pos: [number, number, number], vel: [number, number, number] = [0, 0, 0], radius = 1, mass = 1): RigidBody {
  return {
    id, position: pos, velocity: vel, force: [0, 0, 0], mass, invMass: 1 / mass,
    restitution: 1, friction: 0, collider: { kind: 'sphere', radius }, isStatic: false, layers: 0xffffffff,
  };
}
function staticBox(pos: [number, number, number], half: [number, number, number]): RigidBody {
  return {
    id: 99, position: pos, velocity: [0, 0, 0], force: [0, 0, 0], mass: 0, invMass: 0,
    restitution: 0.5, friction: 0.2, collider: { kind: 'aabb', half }, isStatic: true, layers: 0xffffffff,
  };
}

describe('collision detection', () => {
  it('detects sphere-sphere overlap with depth and normal', () => {
    const a = sphere(1, [0, 0, 0]);
    const b = sphere(2, [1.5, 0, 0], [0, 0, 0], 1, 1); // overlap 0.5
    const c = collide(a, b)!;
    assert.ok(c);
    assert.equal(c.depth.toFixed(2), '0.50');
    assert.equal(c.normal[0], 1); // points from A to B
  });

  it('reports no contact when spheres are separate', () => {
    const a = sphere(1, [0, 0, 0]);
    const b = sphere(2, [3, 0, 0]);
    assert.equal(collide(a, b), undefined);
  });

  it('detects AABB-AABB on the minimum axis', () => {
    const w = new PhysicsWorld();
    const a = w.addBody({ position: [0, 0, 0], velocity: [0, 0, 0], force: [0, 0, 0], mass: 1, invMass: 1, restitution: 0, friction: 0, collider: { kind: 'aabb', half: [1, 1, 1] }, isStatic: false, layers: 0xffffffff });
    const b = w.addBody({ position: [1.5, 0, 0], velocity: [0, 0, 0], force: [0, 0, 0], mass: 1, invMass: 1, restitution: 0, friction: 0, collider: { kind: 'aabb', half: [1, 1, 1] }, isStatic: false, layers: 0xffffffff });
    const c = collide(a, b)!;
    assert.ok(c);
    assert.equal(c.depth.toFixed(2), '0.50');
    assert.equal(Math.abs(c.normal[0]), 1);
  });
});

describe('impulse resolution', () => {
  it('two equal spheres head-on swap velocity (e=1)', () => {
    const w = new PhysicsWorld({ gravity: [0, 0, 0] });
    const a = w.addBody({ ...sphere(1, [-2, 0, 0], [5, 0, 0]) });
    const b = w.addBody({ ...sphere(2, [2, 0, 0], [-5, 0, 0]) });
    // Step until they collide then resolve.
    for (let i = 0; i < 60; i++) w.step(0.016);
    // After an elastic head-on collision of equal masses, velocities reverse.
    assert.ok(a.velocity[0] < 0, 'a should move left after collision');
    assert.ok(b.velocity[0] > 0, 'b should move right after collision');
  });

  it('a static wall stops a moving sphere', () => {
    const w = new PhysicsWorld({ gravity: [0, 0, 0] });
    const ball = w.addBody({ ...sphere(1, [0, 0, 0], [1, 0, 0], 1, 1) });
    const wall = w.addBody({ ...staticBox([5, 0, 0], [0.5, 5, 5]) });
    for (let i = 0; i < 200; i++) w.step(0.016);
    // Ball must not tunnel through the wall.
    assert.ok(ball.position[0] < wall.position[0] + 1);
  });
});

describe('gravity + settling', () => {
  it('a falling sphere settles on a static floor', () => {
    const w = new PhysicsWorld({ gravity: [0, -20, 0] });
    const ball = w.addBody({ ...sphere(1, [0, 10, 0], [0, 0, 0], 1, 1) });
    ball.restitution = 0.2;
    const floor = w.addBody({ ...staticBox([0, -1, 0], [10, 1, 10]) });
    void floor;
    for (let i = 0; i < 600; i++) w.step(0.016);
    // Ball should rest near the floor surface (floor top at y=0, sphere radius 1).
    assert.ok(ball.position[1] < 3, `ball settled too high: ${ball.position[1]}`);
    assert.ok(Math.abs(ball.velocity[1]) < 1, 'ball should be nearly at rest');
  });

  it('free fall matches kinematics approximately', () => {
    const w = new PhysicsWorld({ gravity: [0, -10, 0] });
    const ball = w.addBody({ ...sphere(1, [0, 0, 0], [0, 0, 0], 1, 1) });
    const dt = 0.02;
    for (let i = 0; i < 50; i++) w.step(dt); // 1s of free fall
    // y = -0.5 * g * t^2 = -5.
    assert.ok(Math.abs(ball.position[1] - (-5)) < 0.2, `y=${ball.position[1]}`);
  });
});

describe('distance constraint', () => {
  it('holds two bodies at a fixed distance', () => {
    const w = new PhysicsWorld({ gravity: [0, 0, 0] });
    const a = w.addBody({ ...sphere(1, [0, 0, 0], [0, 0, 0], 0.5, 1) });
    const b = w.addBody({ ...sphere(2, [3, 0, 0], [0, 0, 0], 0.5, 1) });
    w.addConstraint({ a, b, length: 3, stiffness: 1 });
    a.velocity = [2, 0, 0]; // try to separate them
    for (let i = 0; i < 60; i++) w.step(0.016);
    const d = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
    assert.ok(Math.abs(d - 3) < 0.1, `distance=${d}`);
  });
});

describe('raycasting', () => {
  it('hits a sphere and reports distance + normal', () => {
    const w = new PhysicsWorld({ gravity: [0, 0, 0] });
    w.addBody({ ...sphere(1, [0, 0, 5], [0, 0, 0], 1, 1) });
    const hit = w.raycast([0, 0, 0], [0, 0, 1])!;
    assert.ok(hit);
    assert.ok(hit.distance > 0);
    assert.equal(hit.body.id, 1);
  });

  it('returns undefined when nothing is hit', () => {
    const w = new PhysicsWorld({ gravity: [0, 0, 0] });
    w.addBody({ ...sphere(1, [100, 0, 0], [0, 0, 0], 1, 1) });
    assert.equal(w.raycast([0, 0, 0], [0, 0, 1]), undefined);
  });

  it('hits an AABB box', () => {
    const w = new PhysicsWorld({ gravity: [0, 0, 0] });
    w.addBody({ ...staticBox([0, 0, 5], [1, 1, 1]) });
    const hit = w.raycast([0, 0, 0], [0, 0, 1])!;
    assert.ok(hit);
    assert.equal(hit.body.collider.kind, 'aabb');
  });
});

describe('determinism', () => {
  it('identical worlds evolve identically', () => {
    function build(): PhysicsWorld {
      const w = new PhysicsWorld({ gravity: [0, -9.81, 0] });
      w.addBody({ ...sphere(1, [0, 5, 0], [1, 0, 0], 1, 1) });
      w.addBody({ ...staticBox([0, -1, 0], [5, 1, 5]) });
      return w;
    }
    const a = build();
    const b = build();
    for (let i = 0; i < 200; i++) { a.step(0.016); b.step(0.016); }
    const ba = a.listBodies()[0]!;
    const bb = b.listBodies()[0]!;
    assert.deepEqual(ba.position, bb.position);
    assert.deepEqual(ba.velocity, bb.velocity);
  });
});
