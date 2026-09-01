// Deterministic, machine-enforced commercial policy evaluation.
// This module contains no model prompting or implicit approvals: absence of a
// matching policy is intentionally conservative.

import type {
  AuthorizationOutcome,
  AutonomyPolicy,
  CommercialDecision,
  CommercialScope,
} from './types.js';

export interface PolicyEvaluation {
  outcome: AuthorizationOutcome;
  policy?: AutonomyPolicy;
  reasons: string[];
  requiresApproval: boolean;
  simulationOnly: boolean;
}

/** Match a scope only when every populated scope field agrees with the target. */
export function scopeMatches(scope: CommercialScope, target: Pick<CommercialDecision, 'tenantId' | 'ventureId' | 'productId' | 'campaignId' | 'market' | 'channel' | 'connectorId' | 'actionType'>): boolean {
  const fields: Array<keyof CommercialScope> = [
    'tenantId',
    'ventureId',
    'productId',
    'market',
    'campaignId',
    'channel',
    'connectorId',
    'actionType',
  ];
  for (const field of fields) {
    const expected = scope[field];
    if (expected === undefined) continue;
    if (target[field] !== expected) return false;
  }
  return true;
}

/** More specific policy scopes win; ties use newest update then lexical id. */
export function selectPolicy(policies: readonly AutonomyPolicy[], decision: CommercialDecision, now: number): AutonomyPolicy | undefined {
  return policies
    .filter((policy) => policy.active && (policy.expiresAt === undefined || policy.expiresAt > now))
    .filter((policy) => scopeMatches(policy.scope, decision))
    .sort((a, b) => {
      const specificity = scopeSpecificity(b.scope) - scopeSpecificity(a.scope);
      if (specificity !== 0) return specificity;
      const freshness = b.updatedAt - a.updatedAt;
      if (freshness !== 0) return freshness;
      return a.id.localeCompare(b.id);
    })[0];
}

export function evaluatePolicy(policy: AutonomyPolicy | undefined, decision: CommercialDecision): PolicyEvaluation {
  if (!policy) {
    return {
      outcome: 'HUMAN_APPROVAL_REQUIRED',
      reasons: ['No active autonomy policy matches this commercial decision; default-deny execution applies.'],
      requiresApproval: true,
      simulationOnly: true,
    };
  }

  const reasons: string[] = [];
  if (decision.authorizationLevel > policy.maximumAutonomyLevel) {
    return {
      outcome: 'DENY',
      policy,
      reasons: [`Requested autonomy level ${decision.authorizationLevel} exceeds policy maximum ${policy.maximumAutonomyLevel}.`],
      requiresApproval: false,
      simulationOnly: true,
    };
  }
  if (policy.deniedActionTypes?.includes(decision.actionType)) {
    return {
      outcome: 'DENY',
      policy,
      reasons: [`Action type ${decision.actionType} is denied by policy.`],
      requiresApproval: false,
      simulationOnly: true,
    };
  }
  if (policy.allowedActionTypes && !policy.allowedActionTypes.includes(decision.actionType)) {
    return {
      outcome: 'DENY',
      policy,
      reasons: [`Action type ${decision.actionType} is not in the policy allow-list.`],
      requiresApproval: false,
      simulationOnly: true,
    };
  }
  if (policy.maximumRiskScore !== undefined && decision.riskScore > policy.maximumRiskScore) {
    return {
      outcome: 'DENY',
      policy,
      reasons: [`Risk score ${decision.riskScore} exceeds policy maximum ${policy.maximumRiskScore}.`],
      requiresApproval: false,
      simulationOnly: true,
    };
  }
  if (policy.minimumComplianceScore !== undefined && decision.complianceScore < policy.minimumComplianceScore) {
    return {
      outcome: 'DENY',
      policy,
      reasons: [`Compliance score ${decision.complianceScore} is below policy minimum ${policy.minimumComplianceScore}.`],
      requiresApproval: false,
      simulationOnly: true,
    };
  }
  if (policy.minimumEvidenceStrength !== undefined && decision.evidenceStrength < policy.minimumEvidenceStrength) {
    return {
      outcome: 'WAIT',
      policy,
      reasons: [`Evidence strength ${decision.evidenceStrength} is below policy minimum ${policy.minimumEvidenceStrength}.`],
      requiresApproval: false,
      simulationOnly: true,
    };
  }
  if (!policy.allowExecution) {
    return {
      outcome: 'HUMAN_APPROVAL_REQUIRED',
      policy,
      reasons: ['Policy permits evaluation but not autonomous execution.'],
      requiresApproval: true,
      simulationOnly: true,
    };
  }

  const requiresApproval = decision.requiredApproval || (
    policy.approvalRiskThreshold !== undefined && decision.riskScore >= policy.approvalRiskThreshold
  );
  if (requiresApproval) reasons.push('An approval is required by the decision or risk policy.');
  if (policy.requireSimulation) reasons.push('Policy requires a simulation or dry-run before real execution.');

  return {
    outcome: requiresApproval ? 'HUMAN_APPROVAL_REQUIRED' : policy.requireSimulation ? 'TEST' : 'ALLOW',
    policy,
    reasons: reasons.length > 0 ? reasons : ['Policy checks passed.'],
    requiresApproval,
    simulationOnly: policy.requireSimulation ?? false,
  };
}

export function scopeSpecificity(scope: CommercialScope): number {
  return Object.values(scope).filter((value) => value !== undefined).length;
}
