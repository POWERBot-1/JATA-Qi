// Public API for @jataqi/policy-governance.
export { PolicyGovernanceModule } from './policy-governance-module.js';
export type { CreatePolicyInput, AgentCheckContext, AgentCheckResult } from './policy-governance-module.js';
export { evaluate, matches, isEffective, isSensitive, autonomyAllowed } from './engine.js';
export {
  GovernanceEvents, CATEGORY_TIER, SENSITIVE_ACTION_PREFIXES, AUTONOMY_ORDER,
} from './types.js';
export type {
  PolicyCategory, PolicyScope, PolicyEffect, PolicyStatus, PolicyConditions,
  Policy, PolicySubject, PolicyContext, PolicyDecision, MatchedPolicy,
  EvaluationResult, PolicyOverride, AutonomyLevel, AgentGovernance,
} from './types.js';
