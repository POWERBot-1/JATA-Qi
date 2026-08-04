// Pure policy evaluation. Deny wins over require_approval wins over allow.
// The default effect (no matching policy) is configurable.

import type { Policy, PolicyContext, PolicyDecision, PolicyEffect } from './types.js';

const EFFECT_RANK: Record<PolicyEffect, number> = { allow: 1, require_approval: 2, deny: 3 };

/** Does a policy's match predicate apply to the context? */
export function matches(p: Policy, ctx: PolicyContext): boolean {
  const m = p.match;
  if (m.action !== undefined) {
    if (!ctx.action) return false;
    if (ctx.action !== m.action && !ctx.action.startsWith(`${m.action}.`)) return false;
  }
  if (m.resource !== undefined) {
    if (!ctx.resource || (ctx.resource !== m.resource && !ctx.resource.startsWith(`${m.resource}.`))) return false;
  }
  if (m.riskMin !== undefined) {
    if ((ctx.risk ?? 0) < m.riskMin) return false;
  }
  if (m.organizationId !== undefined) {
    if (ctx.organizationId !== m.organizationId) return false;
  }
  return true;
}

/**
 * Evaluate the effective decision for a context. Deny is strongest; then
 * require_approval; then allow. With no matching policy, returns `defaultEffect`.
 */
export function evaluate(policies: Policy[], ctx: PolicyContext, defaultEffect: PolicyEffect = 'allow'): PolicyDecision {
  const active = policies.filter((p) => p.status === 'active' && matches(p, ctx));
  if (active.length === 0) {
    return { effect: defaultEffect, matched: [], reason: 'no matching policy (default)' };
  }
  active.sort((a, b) => b.priority - a.priority);
  const matched = active.map((p) => p.id);
  let strongest: PolicyEffect = 'allow';
  for (const p of active) {
    if (EFFECT_RANK[p.effect] > EFFECT_RANK[strongest]) strongest = p.effect;
  }
  return { effect: strongest, matched, reason: `${active.length} matching policy/policies` };
}
