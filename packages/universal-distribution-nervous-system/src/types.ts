import type { CommercialEvidence } from '@jataqi/commercial-control-plane';

export const DistributionPublishActionType = 'DISTRIBUTION_PUBLISH';

export type DistributionState =
  | 'DRAFT'
  | 'READY'
  | 'QUEUED'
  | 'PUBLISHING'
  | 'VERIFYING'
  | 'PUBLISHED'
  | 'SIMULATED'
  | 'BLOCKED'
  | 'FAILED'
  | 'RATE_LIMITED'
  | 'AUTHORIZATION_FAILED'
  | 'POLICY_BLOCKED'
  | 'PLATFORM_REJECTED'
  | 'CONTENT_REJECTED'
  | 'NETWORK_ERROR'
  | 'CREDENTIAL_EXPIRED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'ECONOMICALLY_UNVIABLE'
  | 'RETIRED';

/** Explicit boundary: platform delivery/recommendation is external and never guaranteed. */
export interface DistributionAlgorithmBoundary {
  controlledByJataQi: Array<'WHAT' | 'WHEN' | 'WHERE' | 'FORMAT' | 'AUDIENCE_SELECTION' | 'MESSAGE' | 'FREQUENCY' | 'EXPERIMENTATION' | 'QUALITY' | 'PROOF' | 'CONVERSION' | 'LEARNING'>;
  controlledByExternalPlatform: Array<'RECOMMENDATION' | 'RANKING' | 'DELIVERY' | 'REACH' | 'DISCOVERY' | 'MODERATION'>;
  guaranteedReach: false;
}

export interface DistributionPlan {
  id: string;
  tenantId: string;
  productId: string;
  campaignId?: string;
  assetId: string;
  connectorId: string;
  channel: string;
  market?: string;
  audienceSegmentId?: string;
  scheduledAt?: number;
  frequencyCap?: number;
  expectedReach?: { value: number; confidence: number; method: string; simulated: boolean };
  algorithmBoundary: DistributionAlgorithmBoundary;
  state: DistributionState;
  actionId?: string;
  externalReference?: string;
  evidence: CommercialEvidence[];
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
}

export interface CreateDistributionPlanInput {
  productId: string;
  campaignId?: string;
  assetId: string;
  connectorId: string;
  channel: string;
  market?: string;
  audienceSegmentId?: string;
  scheduledAt?: number;
  frequencyCap?: number;
  expectedReach?: { value: number; confidence: number; method: string; simulated?: boolean };
}

export interface ExecuteDistributionInput {
  decisionId: string;
  idempotencyKey: string;
  dryRun?: boolean;
}

export const DistributionEvents = Object.freeze({
  PlanCreated: 'distribution.plan.created',
  PlanReady: 'distribution.plan.ready',
  Publishing: 'distribution.publishing',
  Published: 'distribution.published',
  Failed: 'distribution.failed',
} as const);
