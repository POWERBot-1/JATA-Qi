// Built-in components and systems — the small set every game reuses: linear
// kinematics (Velocity + Transform), angular velocity, lifetime expiry, and a
// hierarchy that composes child local transforms under parent world transforms.

import { mat4Mul, mat4TRS, quatAxisAngle, quatMul, quatNormalize, quatSlerp, v3add, v3cross, v3scale } from './math.js';
import type { World } from './world.js';
import type { EntityId, System, Transform } from './types.js';

/** Velocity component (units/second). */
export interface Velocity { velocity: [number, number, number]; }
/** Angular velocity (axis * speed, radians/second). */
export interface AngularVelocity { axis: [number, number, number]; speed: number; }
/** Lifetime in seconds; the entity is destroyed when it reaches 0. */
export interface Lifetime { remaining: number; }
/** World-space transform cached by the hierarchy system. */
export interface WorldTransform { matrix: number[]; position: [number, number, number]; }

/** Default Transform component factory. */
export function makeTransform(
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number, number] = [0, 0, 0, 1],
  scale: [number, number, number] = [1, 1, 1],
): Transform {
  return { position: [...position] as Transform['position'], rotation: [...rotation] as Transform['rotation'], scale: [...scale] as Transform['scale'] };
}

/** Integrates linear + angular velocity into the Transform. */
export class KinematicsSystem implements System {
  readonly name = 'nova.Kinematics';
  readonly query = { all: ['Transform', 'Velocity'] as const };
  update(world: World, dt: number): void {
    for (const e of world.query({ all: ['Transform', 'Velocity'] })) {
      const t = world.require<Transform>(e, 'Transform');
      const v = world.require<Velocity>(e, 'Velocity');
      t.position = v3add(t.position, v3scale(v.velocity, dt));
    }
    for (const e of world.query({ all: ['Transform', 'AngularVelocity'] })) {
      const t = world.require<Transform>(e, 'Transform');
      const av = world.require<AngularVelocity>(e, 'AngularVelocity');
      const delta = quatAxisAngle(av.axis, av.speed * dt);
      t.rotation = quatNormalize(quatMul(delta, t.rotation));
    }
  }
}

/** Destroys entities whose Lifetime has expired. */
export class LifetimeSystem implements System {
  readonly name = 'nova.Lifetime';
  readonly priority = 100; // runs after movement
  update(world: World, dt: number): void {
    for (const e of world.query({ all: ['Lifetime'] })) {
      const l = world.require<Lifetime>(e, 'Lifetime');
      l.remaining -= dt;
      if (l.remaining <= 0) world.destroyEntity(e);
    }
  }
}

function mat4Identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * Composes local Transforms under their parent into a cached WorldTransform
 * (a 4x4 matrix + world position). Roots (no parent) use their local transform.
 * Roots are processed before children so parent world matrices are ready.
 */
export class TransformHierarchySystem implements System {
  readonly name = 'nova.TransformHierarchy';
  readonly query = { all: ['Transform'] as const };
  update(world: World, dt: number): void {
    void dt;
    const ents = world.query({ all: ['Transform'] });
    const roots = ents.filter((e) => !world.require<Transform>(e, 'Transform').parent);
    const children = ents.filter((e) => !!world.require<Transform>(e, 'Transform').parent);
    const identity = mat4Identity();
    for (const e of roots) this.compute(world, e, identity);
    for (const e of children) {
      const t = world.require<Transform>(e, 'Transform');
      const parent = t.parent && world.hasEntity(t.parent) ? world.get<WorldTransform>(t.parent, 'WorldTransform') : undefined;
      this.compute(world, e, parent?.matrix ?? identity);
    }
  }

  private compute(world: World, e: EntityId, parentMatrix: number[]): void {
    const t = world.require<Transform>(e, 'Transform');
    const local = mat4TRS(t.position, quatNormalize(t.rotation), t.scale);
    const matrix = parentMatrix === mat4Identity() ? local : mat4Mul(parentMatrix, local);
    const pos = [matrix[12]!, matrix[13]!, matrix[14]!] as [number, number, number];
    const existing = world.get<WorldTransform>(e, 'WorldTransform');
    if (existing) { existing.matrix = matrix; existing.position = pos; }
    else world.add(e, 'WorldTransform', { matrix, position: pos });
  }
}

export { quatSlerp, v3cross };
