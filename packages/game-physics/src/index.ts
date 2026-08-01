// @jataqi/game-physics — NOVA Physics Engine (section 7). Public API.

export { PhysicsWorld, resolveContact, positionalCorrection, collide, solveDistance, rayBody } from './physics.js';
export type { PhysicsOptions, DistanceConstraint } from './physics.js';
export type { RigidBody, Collider, Contact, RaycastHit } from './types.js';
export { v3cross } from './physics.js';
