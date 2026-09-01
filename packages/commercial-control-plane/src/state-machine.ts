import type { CampaignState, ProductCommercialState } from './types.js';

const productForward: readonly ProductCommercialState[] = [
  'IDEA',
  'DISCOVERED',
  'VALIDATING',
  'PMF_TESTING',
  'COLD_START',
  'INITIAL_SIGNAL',
  'EARLY_TRACTION',
  'REPEATABLE_ACQUISITION',
  'ORGANIC_PROPAGATION',
  'COMMERCIAL_SCALE',
  'MARKET_EXPANSION',
  'GLOBAL_SCALE',
];

const productControlStates = new Set<ProductCommercialState>([
  'PAUSED',
  'BLOCKED',
  'UNDER_REVIEW',
  'DEGRADED',
  'REPAIRING',
  'RETESTING',
  'PIVOTING',
  'RETIRED',
]);

const campaignForward: readonly CampaignState[] = [
  'DRAFT',
  'HYPOTHESIS',
  'VALIDATING',
  'APPROVED',
  'QUEUED',
  'AUTHORIZING',
  'READY',
  'PUBLISHING',
  'PUBLISHED',
  'TELEMETRY_ACTIVE',
  'OPTIMIZING',
  'COMPLETED',
  'DECAYING',
  'RETIRED',
];

const campaignFailureStates = new Set<CampaignState>([
  'BLOCKED',
  'REJECTED',
  'RATE_LIMITED',
  'AUTHORIZATION_FAILED',
  'POLICY_BLOCKED',
  'PLATFORM_REJECTED',
  'CONTENT_REJECTED',
  'NETWORK_ERROR',
  'CREDENTIAL_EXPIRED',
  'HUMAN_REVIEW_REQUIRED',
  'ECONOMICALLY_UNVIABLE',
]);

/**
 * Product lifecycle transitions are explicit. Forward states move one stage at
 * a time; control states may interrupt an active lifecycle, and repair/retest/
 * pivot have narrowly defined re-entry paths.
 */
export function isProductTransitionAllowed(from: ProductCommercialState, to: ProductCommercialState): boolean {
  if (from === to || from === 'RETIRED') return false;
  if (to === 'RETIRED') return true;

  const fromIndex = productForward.indexOf(from);
  const toIndex = productForward.indexOf(to);
  if (fromIndex >= 0 && toIndex >= 0) return toIndex === fromIndex + 1;

  if (fromIndex >= 0 && productControlStates.has(to)) return true;
  if (from === 'PAUSED' || from === 'BLOCKED' || from === 'UNDER_REVIEW' || from === 'DEGRADED') {
    return to === 'REPAIRING' || to === 'RETESTING' || to === 'PIVOTING';
  }
  if (from === 'REPAIRING') return to === 'RETESTING' || to === 'BLOCKED' || to === 'PAUSED';
  if (from === 'RETESTING') return to === 'VALIDATING' || to === 'PMF_TESTING' || to === 'COLD_START' || to === 'DEGRADED' || to === 'PIVOTING';
  if (from === 'PIVOTING') return to === 'DISCOVERED' || to === 'VALIDATING';
  return false;
}

/** Campaign transitions distinguish normal progress from observable failure states. */
export function isCampaignTransitionAllowed(from: CampaignState, to: CampaignState): boolean {
  if (from === to || from === 'RETIRED' || from === 'REJECTED') return false;
  if (to === 'RETIRED') return true;

  const fromIndex = campaignForward.indexOf(from);
  const toIndex = campaignForward.indexOf(to);
  if (fromIndex >= 0 && toIndex >= 0) return toIndex === fromIndex + 1;

  if (fromIndex >= 0 && campaignFailureStates.has(to)) return true;
  if (campaignFailureStates.has(from)) {
    return to === 'DRAFT' || to === 'HYPOTHESIS' || to === 'VALIDATING' || to === 'AUTHORIZING' || to === 'READY';
  }
  return false;
}

export function assertProductTransition(from: ProductCommercialState, to: ProductCommercialState): void {
  if (!isProductTransitionAllowed(from, to)) {
    throw new Error(`Commercial product transition is not allowed: ${from} -> ${to}`);
  }
}

export function assertCampaignTransition(from: CampaignState, to: CampaignState): void {
  if (!isCampaignTransitionAllowed(from, to)) {
    throw new Error(`Commercial campaign transition is not allowed: ${from} -> ${to}`);
  }
}
