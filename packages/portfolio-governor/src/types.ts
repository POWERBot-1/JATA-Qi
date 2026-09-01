import type { CommercialEvidence, CommercialProvenance, MonetaryValue, ResourceRequirement } from '@jataqi/commercial-control-plane';

export type PortfolioClassification = 'WINNER' | 'PROMISING' | 'STABLE' | 'UNDERPERFORMING' | 'PIVOT' | 'RETIRE';
export type PortfolioDecision = 'SCALE' | 'EXPERIMENT' | 'OPTIMIZE' | 'CHANGE_THESIS' | 'RETIRE' | 'HOLD';

export interface ProductPerformanceInput {
  productId: string;
  ventureId?: string;
  revenue?: MonetaryValue;
  growthScore: number;
  contributionMarginScore: number;
  retentionScore: number;
  pmfScore: number;
  confidenceScore: number;
  riskScore: number;
  strategicValueScore: number;
  capitalEfficiencyScore: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface PortfolioAssessment {
  id: string;
  tenantId: string;
  productId: string;
  ventureId?: string;
  performanceScore: number;
  confidenceScore: number;
  riskScore: number;
  classification: PortfolioClassification;
  decision: PortfolioDecision;
  reason: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface PortfolioPolicy {
  id: string;
  tenantId: string;
  winnerScore: number;
  promisingScore: number;
  stableScore: number;
  pivotScore: number;
  minimumConfidence: number;
  maximumScaleRisk: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConfigurePortfolioPolicyInput {
  winnerScore?: number;
  promisingScore?: number;
  stableScore?: number;
  pivotScore?: number;
  minimumConfidence?: number;
  maximumScaleRisk?: number;
}

export interface ResourceAllocationRecommendation {
  id: string;
  tenantId: string;
  assessmentId: string;
  productId: string;
  classification: PortfolioClassification;
  decision: PortfolioDecision;
  priorityScore: number;
  requestedResources: ResourceRequirement[];
  status: 'RECOMMENDATION_ONLY';
  rationale: string;
  evidence: CommercialEvidence[];
  createdAt: number;
}

export interface CreateResourceAllocationInput {
  assessmentId: string;
  requestedResources: ResourceRequirement[];
}

export const PortfolioEvents = Object.freeze({
  Assessed: 'portfolio.assessed',
  AllocationRecommended: 'portfolio.allocation.recommended',
} as const);
