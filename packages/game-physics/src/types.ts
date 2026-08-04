// NOVA physics — types. A lightweight 3D rigid-body physics engine: spheres and
// axis-aligned boxes, semi-implicit Euler integration, impulse-based collision
// resolution with positional correction, distance constraints, and raycasts.

import type { Vec3 } from '@jataqi/game-engine';

export type Collider =
  | { kind: 'sphere'; radius: number }
  | { kind: 'aabb'; half: Vec3 };

export interface RigidBody {
  id: number;
  position: Vec3;
  velocity: Vec3;
  /** Accumulated force for this step (cleared each step). */
  force: Vec3;
  mass: number;
  /** Inverse mass (0 for static / infinite-mass bodies). */
  invMass: number;
  restitution: number;
  friction: number;
  collider: Collider;
  isStatic: boolean;
  /** Layers bitmask for selective collision (default all). */
  layers: number;
  /** User tag. */
  tag?: string;
}

export interface Contact {
  a: RigidBody;
  b: RigidBody;
  /** Unit normal from A to B. */
  normal: Vec3;
  /** Penetration depth. */
  depth: number;
}

export interface RaycastHit {
  body: RigidBody;
  point: Vec3;
  distance: number;
  normal: Vec3;
}
