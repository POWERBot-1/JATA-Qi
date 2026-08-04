// PhysicsWorld — integrates rigid bodies, detects and resolves collisions, and
// solves distance constraints. Deterministic given a fixed dt (semi-implicit
// Euler), so replays and lockstep simulation are reproducible.

import { v3add, v3cross, v3dot, v3len, v3norm, v3scale, v3sub, type Vec3 } from '@jataqi/game-engine';
import type { Contact, RaycastHit, RigidBody } from './types.js';

export interface PhysicsOptions {
  gravity?: Vec3;
  /** Positional correction factor (0..1, Baumgarte). */
  correction?: number;
  /** Slop to avoid jitter. */
  slop?: number;
  /** Solver iterations for constraints. */
  iterations?: number;
}

export class PhysicsWorld {
  readonly gravity: Vec3;
  private bodies: RigidBody[] = [];
  private nextId = 1;
  private readonly correction: number;
  private readonly slop: number;
  private readonly iterations: number;
  private constraints: DistanceConstraint[] = [];

  constructor(opts: PhysicsOptions = {}) {
    this.gravity = opts.gravity ?? [0, -9.81, 0];
    this.correction = opts.correction ?? 0.4;
    this.slop = opts.slop ?? 0.01;
    this.iterations = opts.iterations ?? 8;
  }

  addBody(body: Omit<RigidBody, 'id'> & { id?: number }): RigidBody {
    const full: RigidBody = { ...body, id: body.id ?? this.nextId++ };
    this.bodies.push(full);
    return full;
  }

  removeBody(id: number): boolean {
    const before = this.bodies.length;
    this.bodies = this.bodies.filter((b) => b.id !== id);
    return this.bodies.length !== before;
  }

  getBody(id: number): RigidBody | undefined { return this.bodies.find((b) => b.id === id); }
  listBodies(): RigidBody[] { return [...this.bodies]; }

  addConstraint(c: DistanceConstraint): void { this.constraints.push(c); }

  /** Apply an impulse to a body (used by controllers / character movement). */
  applyImpulse(body: RigidBody, impulse: Vec3): void {
    if (body.isStatic) return;
    body.velocity = v3add(body.velocity, v3scale(impulse, body.invMass));
  }

  /** Advance the simulation by dt seconds. */
  step(dt: number): void {
    if (dt <= 0) return;
    // 1. Integrate forces -> velocity, velocity -> position.
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      b.velocity = v3add(b.velocity, v3scale(v3add(b.force, v3scale(this.gravity, b.mass)), b.invMass * dt));
      b.position = v3add(b.position, v3scale(b.velocity, dt));
      b.force = [0, 0, 0];
    }
    // 2. Detect + resolve contacts over a few iterations.
    for (let it = 0; it < this.iterations; it++) {
      const contacts = this.detectContacts();
      for (const c of contacts) resolveContact(c);
      for (const c of contacts) positionalCorrection(c, this.correction, this.slop);
      for (const con of this.constraints) solveDistance(con);
    }
  }

  /** Detect all pairwise contacts (broadphase = brute force; fine for moderate counts). */
  private detectContacts(): Contact[] {
    const contacts: Contact[] = [];
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = this.bodies[i]!;
        const b = this.bodies[j]!;
        if (a.isStatic && b.isStatic) continue;
        if ((a.layers & b.layers) === 0) continue;
        const c = collide(a, b);
        if (c) contacts.push(c);
      }
    }
    return contacts;
  }

  /** Cast a ray against all bodies; returns the nearest hit or undefined. */
  raycast(origin: Vec3, dir: Vec3, maxDist = Infinity): RaycastHit | undefined {
    const d = v3norm(dir);
    let best: RaycastHit | undefined;
    for (const body of this.bodies) {
      const hit = rayBody(origin, d, body);
      if (hit && hit.distance <= maxDist && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }
}

export interface DistanceConstraint {
  a: RigidBody;
  b: RigidBody;
  length: number;
  stiffness: number; // 0..1
}

/** Solve a distance (stick/rod) constraint by positional projection. */
export function solveDistance(c: DistanceConstraint): void {
  const delta = v3sub(c.b.position, c.a.position);
  const dist = v3len(delta) || 1e-9;
  const diff = (dist - c.length) / dist;
  const invSum = c.a.invMass + c.b.invMass;
  if (invSum === 0) return;
  const correction = (c.stiffness * diff) / invSum;
  if (!c.a.isStatic) c.a.position = v3add(c.a.position, v3scale(delta, correction * c.a.invMass));
  if (!c.b.isStatic) c.b.position = v3sub(c.b.position, v3scale(delta, correction * c.b.invMass));
}

/** Dispatch collision detection by collider kind. */
export function collide(a: RigidBody, b: RigidBody): Contact | undefined {
  if (a.collider.kind === 'sphere' && b.collider.kind === 'sphere') return sphereSphere(a, b);
  if (a.collider.kind === 'aabb' && b.collider.kind === 'aabb') return aabbAabb(a, b);
  if (a.collider.kind === 'sphere' && b.collider.kind === 'aabb') return sphereAabb(a, b);
  if (a.collider.kind === 'aabb' && b.collider.kind === 'sphere') {
    const c = sphereAabb(b, a);
    return c ? { ...c, normal: v3scale(c.normal, -1) as Vec3 } : undefined;
  }
  return undefined;
}

function sphereSphere(a: RigidBody, b: RigidBody): Contact | undefined {
  if (a.collider.kind !== 'sphere' || b.collider.kind !== 'sphere') return undefined;
  const delta = v3sub(b.position, a.position);
  const dist = v3len(delta);
  const r = a.collider.radius + b.collider.radius;
  if (dist >= r) return undefined;
  const normal = dist > 1e-9 ? v3scale(delta, 1 / dist) : [0, 1, 0] as Vec3;
  return { a, b, normal, depth: r - dist };
}

function aabbAabb(a: RigidBody, b: RigidBody): Contact | undefined {
  if (a.collider.kind !== 'aabb' || b.collider.kind !== 'aabb') return undefined;
  const ah = a.collider.half;
  const bh = b.collider.half;
  const dx = b.position[0] - a.position[0];
  const px = ah[0] + bh[0] - Math.abs(dx);
  if (px <= 0) return undefined;
  const dy = b.position[1] - a.position[1];
  const py = ah[1] + bh[1] - Math.abs(dy);
  if (py <= 0) return undefined;
  const dz = b.position[2] - a.position[2];
  const pz = ah[2] + bh[2] - Math.abs(dz);
  if (pz <= 0) return undefined;
  // Minimum penetration axis = contact normal.
  if (px < py && px < pz) return { a, b, normal: [Math.sign(dx) || 1, 0, 0], depth: px };
  if (py < pz) return { a, b, normal: [0, Math.sign(dy) || 1, 0], depth: py };
  return { a, b, normal: [0, 0, Math.sign(dz) || 1], depth: pz };
}

function sphereAabb(s: RigidBody, box: RigidBody): Contact | undefined {
  if (s.collider.kind !== 'sphere' || box.collider.kind !== 'aabb') return undefined;
  const half = box.collider.half;
  // Closest point on the AABB to the sphere center.
  const cx = clamp(s.position[0], box.position[0] - half[0], box.position[0] + half[0]);
  const cy = clamp(s.position[1], box.position[1] - half[1], box.position[1] + half[1]);
  const cz = clamp(s.position[2], box.position[2] - half[2], box.position[2] + half[2]);
  const delta: Vec3 = [s.position[0] - cx, s.position[1] - cy, s.position[2] - cz];
  const dist = v3len(delta);
  if (dist >= s.collider.radius) return undefined;
  const normal = dist > 1e-9 ? v3scale(delta, 1 / dist) : [0, 1, 0] as Vec3;
  return { a: s, b: box, normal, depth: s.collider.radius - dist };
}

/** Resolve a contact with an impulse along the contact normal. */
export function resolveContact(c: Contact): void {
  const { a, b, normal } = c;
  const rv = v3sub(b.velocity, a.velocity);
  const velAlongNormal = v3dot(rv, normal);
  if (velAlongNormal > 0) return; // separating
  const e = Math.min(a.restitution, b.restitution);
  const j = (-(1 + e) * velAlongNormal) / (a.invMass + b.invMass);
  const impulse = v3scale(normal, j);
  if (!a.isStatic) a.velocity = v3sub(a.velocity, v3scale(impulse, a.invMass));
  if (!b.isStatic) b.velocity = v3add(b.velocity, v3scale(impulse, b.invMass));
  // Simple Coulomb friction tangent impulse.
  const rv2 = v3sub(b.velocity, a.velocity);
  const tangent = v3norm(v3sub(rv2, v3scale(normal, v3dot(rv2, normal))));
  const jt = (-v3dot(rv2, tangent)) / (a.invMass + b.invMass);
  const mu = Math.sqrt(a.friction * b.friction);
  const frictionImpulse = v3scale(tangent, clamp(jt, -j * mu, j * mu));
  if (!a.isStatic) a.velocity = v3sub(a.velocity, v3scale(frictionImpulse, a.invMass));
  if (!b.isStatic) b.velocity = v3add(b.velocity, v3scale(frictionImpulse, b.invMass));
}

/** Push overlapping bodies apart to avoid sinking (Baumgarte). */
export function positionalCorrection(c: Contact, percent: number, slop: number): void {
  const invSum = c.a.invMass + c.b.invMass;
  if (invSum === 0) return;
  const corr = (Math.max(c.depth - slop, 0) / invSum) * percent;
  const move = v3scale(c.normal, corr);
  if (!c.a.isStatic) c.a.position = v3sub(c.a.position, v3scale(move, c.a.invMass));
  if (!c.b.isStatic) c.b.position = v3add(c.b.position, v3scale(move, c.b.invMass));
}

/** Ray vs body (sphere or AABB). */
export function rayBody(origin: Vec3, dir: Vec3, body: RigidBody): RaycastHit | undefined {
  if (body.collider.kind === 'sphere') return raySphere(origin, dir, body);
  return rayAabb(origin, dir, body);
}

function raySphere(origin: Vec3, dir: Vec3, body: RigidBody): RaycastHit | undefined {
  if (body.collider.kind !== 'sphere') return undefined;
  const m = v3sub(origin, body.position);
  const b = v3dot(m, dir);
  const c = v3dot(m, m) - body.collider.radius * body.collider.radius;
  if (c > 0 && b > 0) return undefined; // ray origin outside, pointing away
  const disc = b * b - c;
  if (disc < 0) return undefined;
  const t = -b - Math.sqrt(disc);
  const tt = t < 0 ? 0 : t;
  const point = v3add(origin, v3scale(dir, tt));
  const normal = v3norm(v3sub(point, body.position));
  return { body, point, distance: tt, normal };
}

function rayAabb(origin: Vec3, dir: Vec3, body: RigidBody): RaycastHit | undefined {
  if (body.collider.kind !== 'aabb') return undefined;
  const half = body.collider.half;
  const min: Vec3 = [body.position[0] - half[0], body.position[1] - half[1], body.position[2] - half[2]];
  const max: Vec3 = [body.position[0] + half[0], body.position[1] + half[1], body.position[2] + half[2]];
  let tmin = 0;
  let tmax = Infinity;
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const o = origin[i]!;
    const d = dir[i]!;
    if (Math.abs(d) < 1e-9) {
      if (o < min[i]! || o > max[i]!) return undefined;
    } else {
      let t1 = (min[i]! - o) / d;
      let t2 = (max[i]! - o) / d;
      let n: Vec3 = [0, 0, 0]; n[i] = -1;
      if (t1 > t2) { [t1, t2] = [t2, t1]; n = [0, 0, 0]; n[i] = 1; }
      if (t1 > tmin) { tmin = t1; normal = n; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return undefined;
    }
  }
  const point: Vec3 = [origin[0]! + dir[0]! * tmin, origin[1]! + dir[1]! * tmin, origin[2]! + dir[2]! * tmin];
  return { body, point, distance: tmin, normal };
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

export { v3cross };
