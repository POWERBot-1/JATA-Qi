// Pure entitlement evaluation. The Entitlement Engine is the single source of
// truth for "can this customer do X" — application code calls `check`, it never
// hard-codes plan checks.

import { UNLIMITED, type Entitlements, type EntitlementValue } from './types.js';

/** Is the feature granted at all (boolean or quota)? */
export function isGranted(entitlements: Entitlements | undefined, feature: string): boolean {
  if (!entitlements) return false;
  return feature in entitlements && entitlements[feature] !== false && entitlements[feature] !== 0;
}

/** The numeric quota for a metered feature, or UNLIMITED, or 0 if not granted. */
export function quotaFor(entitlements: Entitlements | undefined, feature: string): number {
  if (!entitlements) return 0;
  const v: EntitlementValue | undefined = entitlements[feature];
  if (v === undefined || v === false) return 0;
  if (v === true) return UNLIMITED;
  return v;
}

export interface EntitlementDecision {
  allowed: boolean;
  feature: string;
  quota: number;
  used: number;
  remaining: number;
  reason: string;
}

/** Evaluate a metered feature given usage so far this period. */
export function evaluate(
  entitlements: Entitlements | undefined,
  feature: string,
  used: number,
  requestedQty = 1,
): EntitlementDecision {
  const quota = quotaFor(entitlements, feature);
  if (quota === 0) {
    return { allowed: false, feature, quota: 0, used, remaining: 0, reason: `feature "${feature}" not granted` };
  }
  if (quota === UNLIMITED) {
    return { allowed: true, feature, quota: UNLIMITED, used, remaining: UNLIMITED, reason: 'unlimited' };
  }
  const remaining = Math.max(0, quota - used);
  const allowed = remaining >= requestedQty;
  return {
    allowed,
    feature,
    quota,
    used,
    remaining,
    reason: allowed ? 'within quota' : 'quota exceeded',
  };
}
