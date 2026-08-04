// Public API for @jataqi/policies.
export { PoliciesModule } from './policies-module.js';
export type { PoliciesConfig } from './policies-module.js';
export { evaluate, matches } from './engine.js';
export { PolicyEvents } from './types.js';
export type { PolicyEffect, PolicyMatch, Policy, PolicyContext, PolicyDecision, ControlStatus, ComplianceControl } from './types.js';
