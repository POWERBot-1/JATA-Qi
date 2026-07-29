// JATA Qi Policies — types. A declarative governance policy engine plus a
// compliance-control registry (master directive #18). Policies are data, not
// hard-coded checks; high-risk actions can be governed to require approval.

export type PolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface PolicyMatch {
  /** Action prefix to match, e.g. 'tool.invoke' or 'commerce.refund'. */
  action?: string;
  /** Exact resource id or prefix. */
  resource?: string;
  /** Minimum risk level (0..5) to match. */
  riskMin?: number;
  /** Restrict to an organization id. */
  organizationId?: string;
}

export interface Policy {
  id: string;
  name: string;
  description?: string;
  effect: PolicyEffect;
  match: PolicyMatch;
  /** Higher priority is evaluated first within an effect. */
  priority: number;
  status: 'active' | 'disabled';
  createdAt: number;
}

export interface PolicyContext {
  action?: string;
  resource?: string;
  risk?: number;
  organizationId?: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  matched: string[]; // policy ids that matched
  reason: string;
}

export type ControlStatus = 'implemented' | 'partial' | 'planned' | 'not_implemented';

export interface ComplianceControl {
  id: string;
  framework: string; // e.g. 'GDPR', 'HIPAA', 'SOC2', 'ISO27001'
  requirement: string;
  control: string;
  status: ControlStatus;
  evidence: string[];
  linkedPolicyId?: string;
  notes?: string;
  createdAt: number;
}

export const PolicyEvents = Object.freeze({
  PolicyCreated: 'policy.created',
  DecisionDeny: 'policy.decision.deny',
} as const);
