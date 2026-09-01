import type { CommercialEvidence, CommercialProvenance, EvidenceStatus, MonetaryValue } from '@jataqi/commercial-control-plane';

export type OpportunityState = 'DISCOVERED' | 'VALIDATING' | 'VALIDATED' | 'APPROVAL_REQUIRED' | 'APPROVED' | 'REJECTED' | 'RETIRED';
export type OpportunityRecommendation = 'PURSUE_VALIDATION' | 'RUN_EXPERIMENT' | 'WAIT_FOR_EVIDENCE' | 'DO_NOT_PURSUE' | 'HUMAN_REVIEW';

export interface EstimateRange {
  low: number;
  likely: number;
  high: number;
  currency?: string;
  evidenceStatus: EvidenceStatus;
  calculationMethod: string;
}

export interface OpportunityFactors {
  demand: number;
  monetization: number;
  marketSize: number;
  competitionGap: number;
  buildability: number;
  distributionPotential: number;
  retentionPotential: number;
  grossMarginPotential: number;
  capitalEfficiency: number;
  timeToMarket: number;
  defensibility: number;
  technicalRisk: number;
  regulatoryRisk: number;
}

export interface CommercialOpportunity {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  market?: string;
  targetCustomer?: string;
  evidence: CommercialEvidence[];
  factors: OpportunityFactors;
  opportunityScore: number;
  confidenceScore: number;
  riskScore: number;
  expectedRevenue: EstimateRange;
  expectedCost: EstimateRange;
  expectedTimeToRevenueDays: EstimateRange;
  state: OpportunityState;
  recommendation: OpportunityRecommendation;
  recommendationReason: string;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOpportunityInput {
  title: string;
  description: string;
  market?: string;
  targetCustomer?: string;
  evidence: CommercialEvidence[];
  factors: OpportunityFactors;
  expectedRevenue: EstimateRange;
  expectedCost: EstimateRange;
  expectedTimeToRevenueDays: EstimateRange;
  provenance: CommercialProvenance;
}

export type ReadinessStatus = 'GO' | 'BLOCKED' | 'HUMAN_REVIEW';
export type ReadinessRequirement =
  | 'PRODUCT_READY'
  | 'PMF_READY'
  | 'TRUST_READY'
  | 'PROOF_READY'
  | 'CONVERSION_READY'
  | 'PAYMENT_READY'
  | 'IDENTITY_READY'
  | 'PLATFORM_READY'
  | 'PERMISSIONS_READY'
  | 'COMPLIANCE_READY'
  | 'TELEMETRY_READY'
  | 'ECONOMICS_READY'
  | 'SECURITY_READY'
  | 'RECOVERY_READY'
  | 'GOVERNANCE_READY'
  | 'KILL_SWITCH_READY'
  | 'SUPPORT_READY';

export interface ReadinessRequirementResult {
  requirement: ReadinessRequirement;
  passed: boolean;
  hardBlocker: boolean;
  evidence: CommercialEvidence[];
  remediation?: string;
  owner?: string;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface CommercialReadinessReport {
  id: string;
  tenantId: string;
  productId: string;
  score: number;
  status: ReadinessStatus;
  requirements: ReadinessRequirementResult[];
  createdAt: number;
  provenance: CommercialProvenance;
}

export interface EvaluateReadinessInput {
  productId: string;
  requirements: ReadinessRequirementResult[];
  provenance: CommercialProvenance;
}

export const CommercialIntelligenceEvents = Object.freeze({
  OpportunityScored: 'opportunity.scored',
  OpportunityRecommendation: 'opportunity.recommendation',
  ReadinessEvaluated: 'commercial.readiness.evaluated',
} as const);

export type { MonetaryValue };
