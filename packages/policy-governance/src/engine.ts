// Pure policy evaluation engine. Deterministic precedence:
//   EXPLICIT DENY  >  (requirements: HUMAN_REVIEW > APPROVAL > CONSENT >
//                      ENTITLEMENT > ROLE)  >  ALLOW  >  DEFAULT
// Sensitive actions default to DENY; everything else defaults to ALLOW.
// Organization-scoped policies never apply to subjects in other orgs.

import { randomUUID } from 'node:crypto';
import {
  AUTONOMY_ORDER, CATEGORY_TIER, SENSITIVE_ACTION_PREFIXES,
} from './types.js';
import type {
  AutonomyLevel, EvaluationResult, MatchedPolicy, Policy, PolicyContext,
  PolicyDecision, PolicyOverride, PolicySubject,
} from './types.js';

/** Does a policy apply to this subject+action+resource+context? */
export function matches(policy: Policy, subject: PolicySubject, action: string, context: PolicyContext): boolean {
  if (policy.action !== undefined) {
    if (!action || (action !== policy.action && !action.startsWith(`${policy.action}.`))) return false;
  }
  if (policy.subjectType !== undefined) {
    const kind = subject.isAgent ? 'agent' : 'user';
    if (policy.subjectType !== kind && policy.subjectType !== 'service') return false;
  }
  // Tenant isolation: an ORGANIZATION-scoped policy only applies within its org.
  if (policy.scope === 'ORGANIZATION' && policy.organizationId !== undefined) {
    if (subject.organizationId !== policy.organizationId) return false;
  }
  if (policy.resourceType !== undefined && context.resource !== undefined) {
    if (context.resource !== policy.resourceType && !context.resource.startsWith(`${policy.resourceType}.`)) return false;
  }
  const c = policy.conditions;
  if (c) {
    if (c.amountGte !== undefined && (context.amount ?? 0) < c.amountGte) return false;
    if (c.amountLte !== undefined && (context.amount ?? 0) > c.amountLte) return false;
    if (c.riskMin !== undefined && (context.risk ?? 0) < c.riskMin) return false;
    if (c.riskMax !== undefined && (context.risk ?? 0) > c.riskMax) return false;
    if (c.dataClassificationIn?.length && !c.dataClassificationIn.includes(context.dataClassification ?? '')) return false;
    if (c.toolIn?.length && !c.toolIn.includes(context.toolId ?? '')) return false;
    if (c.toolNotIn?.length && c.toolNotIn.includes(context.toolId ?? '')) return false;
  }
  return true;
}

export function isEffective(policy: Policy, now: number): boolean {
  if (policy.status !== 'active') return false;
  if (policy.effectiveAt !== undefined && now < policy.effectiveAt) return false;
  if (policy.expiresAt !== undefined && now > policy.expiresAt) return false;
  return true;
}

export function isSensitive(action: string): boolean {
  return SENSITIVE_ACTION_PREFIXES.some((p) => action === p || action.startsWith(p));
}

// Requirement strength (lower = stronger / reported first).
const REQ_RANK: Record<string, number> = {
  REQUIRES_HUMAN_REVIEW: 0,
  REQUIRES_APPROVAL: 1,
  REQUIRES_CONSENT: 2,
  REQUIRES_ENTITLEMENT: 3,
  REQUIRES_ROLE: 4,
};

export interface EvaluateOptions {
  defaultAllow?: boolean;
}

/** Core evaluation. Pure: takes the policy list + active overrides. */
export function evaluate(
  policies: Policy[],
  overrides: PolicyOverride[],
  subject: PolicySubject,
  action: string,
  context: PolicyContext,
  opts: EvaluateOptions = {},
): EvaluationResult {
  const now = Date.now();
  const simulated = context.mode === 'SIMULATE';
  const effective = policies.filter((p) => isEffective(p, now));
  const matched = effective.filter((p) => matches(p, subject, action, context));
  const matchedSummary: MatchedPolicy[] = matched.map((p) => ({
    id: p.id, name: p.name, version: p.version, effect: p.effect,
    category: p.category, scope: p.scope,
  }));

  // Mandatory safety denies cannot be overridden.
  const safetyDeny = matched.find((p) => p.effect === 'DENY' && CATEGORY_TIER[p.category] === CATEGORY_TIER.SAFETY);
  const anyDeny = matched.some((p) => p.effect === 'DENY');

  // Active overrides matching this context.
  const activeOverride = overrides.find((o) => {
    if (now < o.start || now > o.expiration) return false;
    if (o.action !== undefined && action !== o.action && !action.startsWith(`${o.action}.`)) return false;
    if (o.organizationId !== undefined && subject.organizationId !== o.organizationId) return false;
    return true;
  });

  const result: EvaluationResult = {
    evaluationId: randomUUID(),
    decision: 'ALLOW',
    matchedPolicies: matchedSummary,
    reason: '',
    simulated,
    ts: now,
  };
  if (matched.length) result.policyVersion = Math.max(...matched.map((p) => p.version));

  if (safetyDeny) {
    result.decision = 'DENY';
    result.reason = `Denied by mandatory safety policy "${safetyDeny.name}" (v${safetyDeny.version})`;
    return result;
  }
  if (anyDeny) {
    const d = matched.find((p) => p.effect === 'DENY')!;
    result.decision = 'DENY';
    result.reason = `Denied by policy "${d.name}" (v${d.version}, ${d.category})`;
    return result;
  }

  // Collect unsatisfied requirements.
  let requiredRole: string | undefined;
  let requiredEntitlement: string | undefined;
  let requiredApproval = false;
  let requiredConsent = false;
  let requiredHumanReview = false;
  const unsatisfied: PolicyDecision[] = [];

  for (const p of matched) {
    if (p.effect === 'ALLOW') continue;
    if (p.effect === 'REQUIRE_ROLE') {
      const roles = p.conditions?.requiredRoles ?? [];
      const ok = roles.length === 0 || (subject.roles?.some((r) => roles.includes(r)) ?? false);
      if (!ok) {
        if (!requiredRole && roles.length) requiredRole = roles.join(',');
        unsatisfied.push('REQUIRES_ROLE');
      }
    } else if (p.effect === 'REQUIRE_ENTITLEMENT') {
      const ents = p.conditions?.requiredEntitlements ?? [];
      const ok = ents.length === 0 || (subject.entitlements?.some((e) => ents.includes(e)) ?? false);
      if (!ok) {
        if (!requiredEntitlement && ents.length) requiredEntitlement = ents.join(',');
        unsatisfied.push('REQUIRES_ENTITLEMENT');
      }
    } else if (p.effect === 'REQUIRE_APPROVAL') {
      requiredApproval = true;
      unsatisfied.push('REQUIRES_APPROVAL');
    } else if (p.effect === 'REQUIRE_CONSENT') {
      requiredConsent = true;
      unsatisfied.push('REQUIRES_CONSENT');
    } else if (p.effect === 'REQUIRE_HUMAN_REVIEW') {
      requiredHumanReview = true;
      unsatisfied.push('REQUIRES_HUMAN_REVIEW');
    }
  }

  if (unsatisfied.length > 0) {
    // Report the strongest unsatisfied requirement.
    unsatisfied.sort((a, b) => REQ_RANK[a]! - REQ_RANK[b]!);
    const decision = unsatisfied[0]!;
    result.decision = decision;
    result.requiredRole = requiredRole;
    result.requiredEntitlement = requiredEntitlement;
    result.requiredApproval = decision === 'REQUIRES_APPROVAL' || requiredApproval;
    result.requiredConsent = decision === 'REQUIRES_CONSENT' || requiredConsent;
    result.requiredHumanReview = decision === 'REQUIRES_HUMAN_REVIEW' || requiredHumanReview;
    result.reason = `${decision.replace('REQUIRES_', 'Requires ')} (matched ${unsatisfied.length} requirement policy/policies)`;
    // An override may still permit the action despite a requirement.
    if (activeOverride && activeOverride.decision === 'ALLOW') {
      result.decision = 'ALLOW';
      result.reason = 'Allowed by temporary override (audited)';
    }
    return result;
  }

  // No deny, no unsatisfied requirement.
  const allowed = matched.some((p) => p.effect === 'ALLOW');
  if (allowed) {
    result.decision = 'ALLOW';
    result.reason = 'Allowed by policy';
    return result;
  }

  // Default: sensitive actions deny; otherwise configurable default.
  const def = isSensitive(action) ? 'DENY' : (opts.defaultAllow === false ? 'DENY' : 'ALLOW');
  result.decision = def;
  result.reason = def === 'DENY' ? `No allow policy; action "${action}" is sensitive (default deny)` : 'No matching policy (default allow)';
  if (def === 'ALLOW' && activeOverride) {
    // nothing to override
  }
  if (def === 'DENY' && activeOverride && activeOverride.decision === 'ALLOW') {
    result.decision = 'ALLOW';
    result.reason = 'Allowed by temporary override (audited)';
  }
  return result;
}

/** Compare a requested autonomy level against an allowed maximum. */
export function autonomyAllowed(max: AutonomyLevel, requested: AutonomyLevel): boolean {
  return AUTONOMY_ORDER.indexOf(requested) <= AUTONOMY_ORDER.indexOf(max);
}
