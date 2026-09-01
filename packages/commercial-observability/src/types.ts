import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';

/** Epistemic label for a metric sample; simulations never silently become measurements. */
export type CommercialMetricClassification = 'OBSERVED' | 'MEASURED' | 'SIMULATED';

/** Privacy-minimized operational dimensions; no customer identifiers or raw payload values are accepted. */
export interface CommercialObservabilityScope {
  productId?: string;
  ventureId?: string;
  campaignId?: string;
  market?: string;
  channel?: string;
  connectorId?: string;
  actionType?: string;
  environment?: 'sandbox' | 'staging' | 'production';
}

/** Safe metadata projection of a stored CCP event. It intentionally excludes actor, payload, and raw correlation identifiers. */
export interface CommercialEventProjection {
  id: string;
  tenantId: string;
  eventId: string;
  eventSequence: number;
  eventType: string;
  eventVersion: number;
  schemaVersion: number;
  source: string;
  entityReferenceHash?: string;
  correlationHash: string;
  causationHash?: string;
  payloadFieldCount: number;
  privacyClassification: PrivacyClassification;
  timestamp: number;
  capturedAt: number;
  createdAt: number;
}

/** Correlation trace composed only from safe event metadata. */
export interface CommercialTrace {
  id: string;
  tenantId: string;
  correlationHash: string;
  causationHashes: string[];
  eventIds: string[];
  eventTypes: string[];
  sources: string[];
  firstEventAt: number;
  lastEventAt: number;
  privacyClassification: PrivacyClassification;
  createdAt: number;
  updatedAt: number;
}

export interface CommercialMetricSample {
  id: string;
  tenantId: string;
  metric: string;
  value: number;
  unit: string;
  classification: CommercialMetricClassification;
  scope: CommercialObservabilityScope;
  evidence: CommercialEvidence[];
  evidenceStrength: number;
  provenance: CommercialProvenance;
  privacyClassification: PrivacyClassification;
  observedAt: number;
  createdAt: number;
}

export interface RecordCommercialMetricInput {
  metric: string;
  value: number;
  unit: string;
  classification: CommercialMetricClassification;
  scope?: CommercialObservabilityScope;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  privacyClassification?: PrivacyClassification;
  observedAt?: number;
}

export type AlertDirection = 'ABOVE_IS_WORSE' | 'BELOW_IS_WORSE';
export type CommercialAlertSeverity = 'WARNING' | 'CRITICAL';
export type CommercialAlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

/** A local alert rule. It may create a record but can never directly remediate, pause, spend, or execute. */
export interface CommercialAlertRule {
  id: string;
  tenantId: string;
  name: string;
  metric: string;
  scope?: CommercialObservabilityScope;
  direction: AlertDirection;
  warningThreshold?: number;
  criticalThreshold?: number;
  minimumEvidenceStrength: number;
  includeSimulated: boolean;
  cooldownMs: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConfigureCommercialAlertRuleInput {
  name: string;
  metric: string;
  scope?: CommercialObservabilityScope;
  direction: AlertDirection;
  warningThreshold?: number;
  criticalThreshold?: number;
  minimumEvidenceStrength?: number;
  includeSimulated?: boolean;
  cooldownMs?: number;
  active?: boolean;
}

export interface CommercialAlert {
  id: string;
  tenantId: string;
  ruleId: string;
  metricSampleId: string;
  severity: CommercialAlertSeverity;
  status: CommercialAlertStatus;
  summary: string;
  scope: CommercialObservabilityScope;
  createdAt: number;
  acknowledgedAt?: number;
  acknowledgedByActorId?: string;
  resolvedAt?: number;
  resolvedByActorId?: string;
  resolutionSummary?: string;
}

export type CommercialIncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type CommercialIncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';

/** A local incident record. It tracks review/response state but exposes no remediation executor. */
export interface CommercialIncident {
  id: string;
  tenantId: string;
  title: string;
  severity: CommercialIncidentSeverity;
  status: CommercialIncidentStatus;
  alertIds: string[];
  traceIds: string[];
  summary: string;
  evidence: CommercialEvidence[];
  privacyClassification: PrivacyClassification;
  createdByActorId: string;
  doesNotExecuteRemediation: true;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  closedAt?: number;
}

export interface CreateCommercialIncidentInput {
  title: string;
  severity: CommercialIncidentSeverity;
  alertIds?: string[];
  traceIds?: string[];
  summary: string;
  evidence: CommercialEvidence[];
  privacyClassification?: PrivacyClassification;
}

export interface CommercialIncidentUpdate {
  id: string;
  tenantId: string;
  incidentId: string;
  previousStatus: CommercialIncidentStatus;
  newStatus: CommercialIncidentStatus;
  actorId: string;
  summary: string;
  evidence: CommercialEvidence[];
  createdAt: number;
}

export interface UpdateCommercialIncidentInput {
  status: Exclude<CommercialIncidentStatus, 'OPEN'>;
  summary: string;
  evidence?: CommercialEvidence[];
}

export interface CommercialObservabilitySnapshot {
  tenantId: string;
  generatedAt: number;
  capturedEventCount: number;
  traceCount: number;
  metricCount: number;
  activeAlertCount: number;
  activeIncidentCount: number;
  criticalAlertCount: number;
  simulatedMetricCount: number;
}

export interface CommercialObservabilityConfig {
  now?: () => number;
}

export const CommercialObservabilityEvents = Object.freeze({
  EventCaptured: 'commercial.observability.event.captured',
  MetricRecorded: 'commercial.observability.metric.recorded',
  AlertRaised: 'commercial.observability.alert.raised',
  AlertAcknowledged: 'commercial.observability.alert.acknowledged',
  AlertResolved: 'commercial.observability.alert.resolved',
  IncidentCreated: 'commercial.observability.incident.created',
  IncidentUpdated: 'commercial.observability.incident.updated',
} as const);

export type { CommercialActor };
