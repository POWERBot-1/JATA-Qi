// @jataqi/game-engine — NOVA Universal Game Engine core (ECS + simulation).
// Public API.

export { World } from './world.js';
export type {
  EntityId, ComponentName, ComponentStore, Query, System, WorldEvent,
  Transform, Name, MeshRef, Camera, Light,
} from './types.js';
export { SimulationLoop } from './loop.js';
export type { StepResult } from './loop.js';
export {
  KinematicsSystem, LifetimeSystem, TransformHierarchySystem, makeTransform,
} from './systems.js';
export type { Velocity, AngularVelocity, Lifetime, WorldTransform } from './systems.js';
export {
  vec2, vec3, quat, v2add, v2sub, v2scale, v2dot, v2len, v2dist, v2norm,
  v3add, v3sub, v3scale, v3dot, v3cross, v3len, v3dist, v3norm, v3lerp,
  quatAxisAngle, quatMul, quatNormalize, quatRotate, quatSlerp,
  mat4Identity, mat4TRS, mat4Mul, clamp, lerp, toRad, toDeg,
} from './math.js';
export type { Vec2, Vec3, Vec4, Quat, Mat4 } from './math.js';
