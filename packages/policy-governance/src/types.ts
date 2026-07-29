// JATA Qi Policy & Governance Registry — types. The centralized, versioned,
// tenant-aware governance control plane that sits AFTER authorization:
//   SECURITY POLICY → AUTHORIZATION → POLICY & GOVERNANCE → ENTITLEMENTS/ORG/...
//
// Categories, scopes, effects and conditions are extensible data — the engine
// never hard-codes a fixed set of roles, categories or thresholds.

export type PolicyCategory =
  | 'SECURITY' | 'ACCESS' | 'ORGANIZATION' | 'COMMERCE' | 'AI' | 'AGENT' | 'TOOL'
  | 'DATA' | 'PRIVACY' | 'RETENTION' | 'SAFETY' | 'FINANCE' | 'APPROVAL' | 'USAGE'
  | 'CREDIT' | 'API' | 'MARKETPLACE' | 'DEPLOYMENT' | 'AUDIT' | 'GOVERNANCE' | string;

export type PolicyScope =
  | 'GLOBAL' | 'PLATFORM' | 'ORGANIZATION' | 'TEAM' | 'USER' | 'PROJECT'
  | 'WORKSPACE' | 'AGENT' | 'WORKFLOW' | 'TOOL' | 'RESOURCE' | 'TRANSACTION' | 'SESSION' | string;

export type PolicyEffect =
  | 'ALLOW'
  | 'DENY'
  | 'REQUIRE_APPROVAL'
  | 'REQUIRE_ROLE'
  | 'REQUIRE_ENTITLEMENT'
  | 'REQUIRE_CONSENT'
  | 'REQUIRE_HUMAN_REVIEW';

export type PolicyStatus = 'active' | 'inactive';

/** Declarative conditions (all must hold for a policy to match). */
export interface PolicyConditions {
  /** Numeric context value (e.g. amount) must be >= this. */
  amountGte?: number;
  amountLte?: number;
  /** Risk level (0..5) must be >= this. */
  riskMin?: number;
  riskMax?: number;
  /** Data classification must be one of these. */
  dataClassificationIn?: string[];
  /** For TOOL policies: tool id must be in / not in these lists. */
  toolIn?: string[];
  toolNotIn?: string[];
  /** For REQUIRE_ROLE: the role(s) that satisfy the policy. */
  requiredRoles?: string[];
  /** For REQUIRE_ENTITLEMENT: the entitlement key(s) that satisfy it. */
  requiredEntitlements?: string[];
}

export interface Policy {
  id: string;
  name: string;
  description?: string;
  category: PolicyCategory;
  scope: PolicyScope;
  /** Whom the policy applies to (e.g. 'user' | 'agent' | 'service'). */
  subjectType?: string;
  resourceType?: string;
  /** Action prefix to match (e.g. 'tool.invoke', 'finance.refund'). */
  action?: string;
  effect: PolicyEffect;
  conditions?: PolicyConditions;
  priority: number;
  version: number;
  status: PolicyStatus;
  createdBy: string;
  approvedBy?: string;
  /** Org id for ORGANIZATION-scoped policies (tenant isolation). */
  organizationId?: string;
  effectiveAt?: number;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PolicySubject {
  userId: string;
  organizationId?: string;
  roles?: string[];
  /** Entitlement keys the subject currently holds (from commerce). */
  entitlements?: string[];
  isAgent?: boolean;
  agentId?: string;
}

export interface PolicyContext {
  resource?: string;
  amount?: number;
  risk?: number;
  dataClassification?: string;
  toolId?: string;
  mode?: 'ENFORCE' | 'SIMULATE';
}

export type PolicyDecision =
  | 'ALLOW'
  | 'DENY'
  | 'REQUIRES_APPROVAL'
  | 'REQUIRES_CONSENT'
  | 'REQUIRES_HUMAN_REVIEW'
  | 'REQUIRES_ENTITLEMENT'
  | 'REQUIRES_ROLE';

export interface MatchedPolicy {
  id: string;
  name: string;
  version: number;
  effect: PolicyEffect;
  category: PolicyCategory;
  scope: PolicyScope;
}

export interface EvaluationResult {
  evaluationId: string;
  decision: PolicyDecision;
  matchedPolicies: MatchedPolicy[];
  requiredRole?: string;
  requiredEntitlement?: string;
  requiredApproval?: boolean;
  requiredConsent?: boolean;
  requiredHumanReview?: boolean;
  reason: string;
  policyVersion?: number;
  simulated: boolean;
  ts: number;
}

export interface PolicyOverride {
  id: string;
  scope: PolicyScope;
  organizationId?: string;
  action?: string;
  resource?: string;
  /** Forced outcome when the override applies. */
  decision: PolicyDecision;
  who: string;
  why: string;
  approval?: string;
  start: number;
  expiration: number;
  createdAt: number;
}

export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export const AUTONOMY_ORDER: Readonly<AutonomyLevel[]> = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

export interface AgentGovernance {
  id: string; // keyed by agentId
  agentId: string;
  organizationId?: string;
  allowedTools?: string[];
  blockedTools?: string[];
  allowedActions?: string[];
  blockedActions?: string[];
  maximumBudget?: number;
  maximumRuntimeMs?: number;
  maximumIterations?: number;
  allowedDataScopes?: string[];
  humanApprovalRequired?: boolean;
  maxAutonomy: AutonomyLevel;
}

export const GovernanceEvents = Object.freeze({
  PolicyCreated: 'governance.policy.created',
  PolicyUpdated: 'governance.policy.updated',
  PolicyDeactivated: 'governance.policy.deactivated',
  PolicyExpired: 'governance.policy.expired',
  PolicyEvaluated: 'governance.policy.evaluated',
  PolicyDenied: 'governance.policy.denied',
  PolicyApprovalRequired: 'governance.policy.approval_required',
  PolicyOverridden: 'governance.policy.overridden',
} as const);

/**
 * Precedence tiers (lower number = evaluated first / stronger). Explicit DENY
 * always wins. Among requirements, HUMAN_REVIEW > APPROVAL > CONSENT >
 * ENTITLEMENT > ROLE. Sensitive actions default to DENY.
 */
export const CATEGORY_TIER: Record<string, number> = {
  SAFETY: 0,
  SECURITY: 1,
  DATA: 2,
  PRIVACY: 2,
  RETENTION: 2,
  GOVERNANCE: 2,
  COMMERCE: 3,
  FINANCE: 3,
  API: 3,
  MARKETPLACE: 3,
  AGENT: 4,
  TOOL: 4,
  AI: 4,
  ORGANIZATION: 5,
  ACCESS: 6,
  USAGE: 6,
  CREDIT: 6,
  APPROVAL: 6,
  DEPLOYMENT: 6,
  AUDIT: 6,
};

/** Action prefixes that default to DENY when no policy explicitly allows them. */
export const SENSITIVE_ACTION_PREFIXES: readonly string[] = [
  'finance.', 'commerce.refund', 'commerce.payment', 'deploy', 'data.delete',
  'agent.autonomous', 'policy.', 'governance.',
];
