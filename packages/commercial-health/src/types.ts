import type { CommercialEvidence, CommercialProvenance, MonetaryValue } from '@jataqi/commercial-control-plane';

export type CommercialMetric = 'TRAFFIC' | 'ATTENTION' | 'CONVERSION' | 'REVENUE' | 'CAC' | 'ROAS' | 'RETENTION' | 'REFUNDS' | 'CHURN' | 'SENTIMENT' | 'REFERRALS' | 'SPEND' | 'API_BEHAVIOR' | 'CONNECTOR_HEALTH' | 'CONTENT_PERFORMANCE';
export type AnomalySeverity = 'NORMAL' | 'UNUSUAL' | 'WARNING' | 'CRITICAL' | 'INSUFFICIENT_EVIDENCE';
export type ContainmentRecommendation = 'MONITOR' | 'REDUCE' | 'PAUSE' | 'CONTAIN' | 'ESCALATE';
export type DriftDimension = 'AUDIENCE' | 'MARKET' | 'CREATIVE' | 'PLATFORM' | 'PRODUCT' | 'PRICING' | 'CONVERSION' | 'PMF' | 'ECONOMIC_CONDITIONS' | 'CUSTOMER_EXPECTATIONS';
export type DriftState = 'NO_DRIFT' | 'DRIFT_DETECTED' | 'REVIEW_REQUIRED' | 'EXPERIMENT_RECOMMENDED' | 'INSUFFICIENT_EVIDENCE';

export interface CommercialMetricObservation {
  id: string;
  tenantId: string;
  productId?: string;
  campaignId?: string;
  channel?: string;
  metric: CommercialMetric;
  value: number;
  unit: string;
  currency?: string;
  baseline?: number;
  observedAt: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface RecordMetricObservationInput {
  productId?: string;
  campaignId?: string;
  channel?: string;
  metric: CommercialMetric;
  value: number;
  unit: string;
  currency?: string;
  baseline?: number;
  observedAt?: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface CommercialHealthThreshold {
  id: string;
  tenantId: string;
  metric: CommercialMetric;
  /** A negative relative change that triggers warning, e.g. -0.2 for a 20% drop. */
  warningRelativeChange?: number;
  criticalRelativeChange?: number;
  warningAbsoluteValue?: number;
  criticalAbsoluteValue?: number;
  direction: 'LOWER_IS_WORSE' | 'HIGHER_IS_WORSE';
  scope?: { productId?: string; campaignId?: string; channel?: string };
  createdAt: number;
  updatedAt: number;
}

export interface ConfigureCommercialHealthThresholdInput extends Omit<CommercialHealthThreshold, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'> {}

export interface CommercialAnomaly {
  id: string;
  tenantId: string;
  observationId: string;
  productId?: string;
  campaignId?: string;
  channel?: string;
  metric: CommercialMetric;
  severity: AnomalySeverity;
  recommendation: ContainmentRecommendation;
  relativeChange?: number;
  thresholdId?: string;
  reason: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface DriftAssessment {
  id: string;
  tenantId: string;
  productId?: string;
  dimension: DriftDimension;
  baseline: number;
  observed: number;
  driftScore: number;
  state: DriftState;
  reason: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface AssessDriftInput {
  productId?: string;
  dimension: DriftDimension;
  baseline: number;
  observed: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export const CommercialHealthEvents = Object.freeze({
  ObservationRecorded: 'commercial.health.observation.recorded',
  AnomalyDetected: 'commercial.anomaly.detected',
  DriftAssessed: 'commercial.drift.assessed',
} as const);

export type { MonetaryValue };
