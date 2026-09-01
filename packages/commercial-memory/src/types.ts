import type { CommercialEvidence, CommercialProvenance, EvidenceStatus, MonetaryValue, PrivacyClassification } from '@jataqi/commercial-control-plane';

export type CommercialMemoryKind = 'RAW_EVENT' | 'OBSERVATION' | 'DECISION' | 'ACTION' | 'OUTCOME' | 'EXPERIMENT' | 'LEARNING' | 'FAILURE' | 'PROHIBITED_STRATEGY';

export interface CommercialMemoryRecord {
  id: string;
  tenantId: string;
  sequence: number;
  previousHash: string;
  hash: string;
  kind: CommercialMemoryKind;
  productId?: string;
  ventureId?: string;
  campaignId?: string;
  channel?: string;
  market?: string;
  decisionId?: string;
  actionId?: string;
  title: string;
  summary: string;
  tags: string[];
  expected?: MetricExpectation;
  actual?: MetricObservation;
  evidence: CommercialEvidence[];
  confidence: number;
  provenance: CommercialProvenance;
  privacyClassification: PrivacyClassification;
  reusable: boolean;
  createdAt: number;
}

export interface MetricExpectation {
  metric: string;
  value: number;
  unit: string;
  currency?: string;
  method: string;
}

export interface MetricObservation {
  metric: string;
  value: number;
  unit: string;
  currency?: string;
  status: EvidenceStatus;
  observedAt: number;
  method: string;
}

export interface RecordCommercialMemoryInput {
  kind: CommercialMemoryKind;
  productId?: string;
  ventureId?: string;
  campaignId?: string;
  channel?: string;
  market?: string;
  decisionId?: string;
  actionId?: string;
  title: string;
  summary: string;
  tags?: string[];
  expected?: MetricExpectation;
  actual?: MetricObservation;
  evidence: CommercialEvidence[];
  confidence: number;
  provenance: CommercialProvenance;
  privacyClassification?: PrivacyClassification;
  reusable?: boolean;
}

export type AttributionNodeType = 'DECISION' | 'ACTION' | 'EXPOSURE' | 'INTERACTION' | 'CONVERSION' | 'PAYMENT' | 'REVENUE' | 'RETENTION' | 'REFERRAL' | 'OUTCOME' | 'EXPERIMENT' | 'LEARNING';
export type AttributionRelation = 'CORRELATION_SIGNAL' | 'CAUSAL_HYPOTHESIS' | 'CAUSAL_EVIDENCE';

export interface AttributionNode {
  id: string;
  tenantId: string;
  type: AttributionNodeType;
  entityId: string;
  productId?: string;
  campaignId?: string;
  createdAt: number;
}

export interface AttributionLink {
  id: string;
  tenantId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: AttributionRelation;
  confidence: number;
  causalMethod?: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface RecordAttributionLinkInput {
  from: Omit<AttributionNode, 'id' | 'tenantId' | 'createdAt'>;
  to: Omit<AttributionNode, 'id' | 'tenantId' | 'createdAt'>;
  relation: AttributionRelation;
  confidence: number;
  causalMethod?: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface RecordDecisionOutcomeInput {
  decisionId: string;
  actionId?: string;
  productId: string;
  expected: MetricExpectation;
  actual: MetricObservation;
  evidence: CommercialEvidence[];
  conclusion: string;
  learning: string;
  relation?: AttributionRelation;
  causalMethod?: string;
  channel?: string;
  campaignId?: string;
}

export interface CommercialMemoryQuery {
  kind?: CommercialMemoryKind;
  productId?: string;
  campaignId?: string;
  channel?: string;
  tags?: string[];
  reusableOnly?: boolean;
  limit?: number;
}

export const CommercialMemoryEvents = Object.freeze({
  Recorded: 'commercial.memory.recorded',
  AttributionLinked: 'commercial.memory.attribution.linked',
  LearningRecorded: 'commercial.memory.learning.recorded',
} as const);

export type { MonetaryValue };
