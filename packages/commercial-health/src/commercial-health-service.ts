import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialProvenance } from '@jataqi/commercial-control-plane';
import {
  CommercialHealthEvents,
  type AssessDriftInput,
  type CommercialAnomaly,
  type CommercialHealthThreshold,
  type CommercialMetric,
  type CommercialMetricObservation,
  type ConfigureCommercialHealthThresholdInput,
  type RecordMetricObservationInput,
  type DriftAssessment,
} from './types.js';

const THRESHOLDS_COLLECTION = 'commercial-health.thresholds';
const OBSERVATIONS_COLLECTION = 'commercial-health.observations';
const ANOMALIES_COLLECTION = 'commercial-health.anomalies';
const DRIFT_COLLECTION = 'commercial-health.drift';

export class CommercialHealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialHealthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Evidence-bound health engine. It detects and records anomalies/drift, but
 * produces recommendations only; any pause, containment, or spending change
 * must travel through a separate Commercial Control Plane decision/action.
 */
export class CommercialHealthService {
  private thresholds!: ICollection<CommercialHealthThreshold>;
  private observations!: ICollection<CommercialMetricObservation>;
  private anomalies!: ICollection<CommercialAnomaly>;
  private drifts!: ICollection<DriftAssessment>;
  private controlPlane!: CommercialControlPlaneService;

  async init(kernel: KernelApi): Promise<void> {
    const storage = kernel.getModule<StorageModule>('storage');
    this.thresholds = await storage.collection<CommercialHealthThreshold>(THRESHOLDS_COLLECTION);
    this.observations = await storage.collection<CommercialMetricObservation>(OBSERVATIONS_COLLECTION);
    this.anomalies = await storage.collection<CommercialAnomaly>(ANOMALIES_COLLECTION);
    this.drifts = await storage.collection<DriftAssessment>(DRIFT_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  async configureThreshold(actor: CommercialActor, input: ConfigureCommercialHealthThresholdInput): Promise<CommercialHealthThreshold> {
    assertAdministrator(actor);
    validateThreshold(input);
    const now = Date.now();
    const existing = (await this.thresholds.query({ where: (threshold) => threshold.tenantId === actor.tenantId && threshold.metric === input.metric && sameScope(threshold.scope, input.scope), limit: 1 }))[0];
    const threshold: CommercialHealthThreshold = existing
      ? { ...existing, ...copy(input), updatedAt: now }
      : { id: randomUUID(), tenantId: actor.tenantId, ...copy(input), createdAt: now, updatedAt: now };
    await this.thresholds.put(threshold);
    return copy(threshold);
  }

  async recordObservation(actor: CommercialActor, input: RecordMetricObservationInput): Promise<{ observation: CommercialMetricObservation; anomaly: CommercialAnomaly }> {
    assertManager(actor);
    validateObservation(input);
    const observation: CommercialMetricObservation = {
      id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, campaignId: input.campaignId, channel: input.channel,
      metric: input.metric, value: input.value, unit: input.unit, currency: input.currency, baseline: input.baseline,
      observedAt: input.observedAt ?? Date.now(), evidence: copy(input.evidence), provenance: copy(input.provenance),
    };
    await this.observations.put(observation);
    const threshold = selectThreshold(await this.thresholds.all(), observation);
    const anomaly = evaluate(observation, threshold);
    await this.anomalies.put(anomaly);
    await this.emit(actor, CommercialHealthEvents.ObservationRecorded, observation.id, { observationId: observation.id, metric: observation.metric, value: observation.value });
    await this.emit(actor, CommercialHealthEvents.AnomalyDetected, anomaly.id, { anomalyId: anomaly.id, observationId: observation.id, metric: anomaly.metric, severity: anomaly.severity, recommendation: anomaly.recommendation });
    return { observation: copy(observation), anomaly: copy(anomaly) };
  }

  async assessDrift(actor: CommercialActor, input: AssessDriftInput): Promise<DriftAssessment> {
    assertManager(actor);
    if (!input.evidence.length || !input.provenance.source.trim() || !Number.isFinite(input.baseline) || !Number.isFinite(input.observed)) throw new CommercialHealthError('Drift assessment requires finite baseline/observed values, evidence, and provenance.');
    const score = input.baseline === 0 ? undefined : Math.abs((input.observed - input.baseline) / Math.abs(input.baseline)) * 100;
    const state = score === undefined ? 'INSUFFICIENT_EVIDENCE' : score >= 50 ? 'REVIEW_REQUIRED' : score >= 20 ? 'EXPERIMENT_RECOMMENDED' : 'NO_DRIFT';
    const assessment: DriftAssessment = {
      id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, dimension: input.dimension, baseline: input.baseline, observed: input.observed,
      driftScore: score ?? 0, state, reason: score === undefined ? 'Baseline is zero; relative drift cannot be computed safely.' : `Observed relative drift is ${round(score)}%.`,
      evidence: copy(input.evidence), provenance: copy(input.provenance), createdAt: Date.now(),
    };
    await this.drifts.put(assessment);
    await this.emit(actor, CommercialHealthEvents.DriftAssessed, assessment.id, { assessmentId: assessment.id, dimension: assessment.dimension, state: assessment.state, driftScore: assessment.driftScore });
    return copy(assessment);
  }

  async listAnomalies(actor: CommercialActor): Promise<CommercialAnomaly[]> {
    return (await this.anomalies.all()).filter((anomaly) => canRead(actor, anomaly.tenantId)).map(copy);
  }

  async listDrift(actor: CommercialActor): Promise<DriftAssessment[]> {
    return (await this.drifts.all()).filter((assessment) => canRead(actor, assessment.tenantId)).map(copy);
  }

  private async emit(actor: CommercialActor, eventType: string, entityId: string, payload: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'commercial-health', collectedAt: now, correlationId: entityId };
    await this.controlPlane.publishEvent(actor, { eventType, source: 'commercial-health', entityId, correlationId: entityId, payload, provenance, privacyClassification: 'INTERNAL', idempotencyKey: `${eventType}:${entityId}` });
  }
}

function selectThreshold(all: readonly CommercialHealthThreshold[], observation: CommercialMetricObservation): CommercialHealthThreshold | undefined {
  return all
    .filter((threshold) => threshold.tenantId === observation.tenantId && threshold.metric === observation.metric && scopeMatches(threshold.scope, observation))
    .sort((a, b) => scopeSize(b.scope) - scopeSize(a.scope) || b.updatedAt - a.updatedAt)[0];
}

function evaluate(observation: CommercialMetricObservation, threshold: CommercialHealthThreshold | undefined): CommercialAnomaly {
  const now = Date.now();
  if (!threshold || !observation.evidence.length || observation.baseline === undefined) {
    return {
      id: randomUUID(), tenantId: observation.tenantId, observationId: observation.id, productId: observation.productId, campaignId: observation.campaignId, channel: observation.channel,
      metric: observation.metric, severity: 'INSUFFICIENT_EVIDENCE', recommendation: 'MONITOR', reason: threshold ? 'A baseline is required for threshold comparison.' : 'No matching health threshold is configured.',
      evidence: copy(observation.evidence), provenance: copy(observation.provenance), createdAt: now,
    };
  }
  const relativeChange = observation.baseline === 0 ? undefined : (observation.value - observation.baseline) / Math.abs(observation.baseline);
  const critical = breaches(observation.value, relativeChange, threshold, 'critical');
  const warning = !critical && breaches(observation.value, relativeChange, threshold, 'warning');
  const severity = critical ? 'CRITICAL' : warning ? 'WARNING' : relativeChange !== undefined && Math.abs(relativeChange) >= 0.1 ? 'UNUSUAL' : 'NORMAL';
  const recommendation = severity === 'CRITICAL' ? criticalRecommendation(observation.metric) : severity === 'WARNING' ? warningRecommendation(observation.metric) : severity === 'UNUSUAL' ? 'REDUCE' : 'MONITOR';
  return {
    id: randomUUID(), tenantId: observation.tenantId, observationId: observation.id, productId: observation.productId, campaignId: observation.campaignId, channel: observation.channel,
    metric: observation.metric, severity, recommendation, relativeChange, thresholdId: threshold.id,
    reason: `${observation.metric} observed=${observation.value}, baseline=${observation.baseline}, relativeChange=${relativeChange === undefined ? 'unavailable' : round(relativeChange)}.`,
    evidence: copy(observation.evidence), provenance: copy(observation.provenance), createdAt: now,
  };
}

function breaches(value: number, relative: number | undefined, threshold: CommercialHealthThreshold, level: 'warning' | 'critical'): boolean {
  const relativeLimit = level === 'critical' ? threshold.criticalRelativeChange : threshold.warningRelativeChange;
  const absoluteLimit = level === 'critical' ? threshold.criticalAbsoluteValue : threshold.warningAbsoluteValue;
  if (threshold.direction === 'LOWER_IS_WORSE') {
    return (relativeLimit !== undefined && relative !== undefined && relative <= relativeLimit) || (absoluteLimit !== undefined && value <= absoluteLimit);
  }
  return (relativeLimit !== undefined && relative !== undefined && relative >= relativeLimit) || (absoluteLimit !== undefined && value >= absoluteLimit);
}

function criticalRecommendation(metric: CommercialMetric): CommercialAnomaly['recommendation'] {
  return ['CAC', 'ROAS', 'REFUNDS', 'CHURN', 'SPEND'].includes(metric) ? 'CONTAIN' : 'ESCALATE';
}
function warningRecommendation(metric: CommercialMetric): CommercialAnomaly['recommendation'] {
  return ['CAC', 'REFUNDS', 'CHURN', 'SPEND'].includes(metric) ? 'PAUSE' : 'REDUCE';
}
function validateThreshold(input: ConfigureCommercialHealthThresholdInput): void {
  const values = [input.warningRelativeChange, input.criticalRelativeChange, input.warningAbsoluteValue, input.criticalAbsoluteValue];
  if (values.every((value) => value === undefined)) throw new CommercialHealthError('At least one health threshold must be configured.');
  for (const value of values) if (value !== undefined && !Number.isFinite(value)) throw new CommercialHealthError('Health threshold values must be finite.');
  if (input.warningRelativeChange !== undefined && input.criticalRelativeChange !== undefined) {
    const correct = input.direction === 'LOWER_IS_WORSE' ? input.criticalRelativeChange <= input.warningRelativeChange : input.criticalRelativeChange >= input.warningRelativeChange;
    if (!correct) throw new CommercialHealthError('Critical relative threshold must be at least as severe as warning threshold.');
  }
}
function validateObservation(input: RecordMetricObservationInput): void {
  if (!Number.isFinite(input.value) || !input.unit.trim() || !input.evidence.length || !input.provenance.source.trim()) throw new CommercialHealthError('Metric observation requires finite value, unit, evidence, and provenance.');
  if (input.baseline !== undefined && !Number.isFinite(input.baseline)) throw new CommercialHealthError('Metric baseline must be finite.');
}
function scopeMatches(scope: CommercialHealthThreshold['scope'], observation: CommercialMetricObservation): boolean { return (!scope?.productId || scope.productId === observation.productId) && (!scope?.campaignId || scope.campaignId === observation.campaignId) && (!scope?.channel || scope.channel === observation.channel); }
function sameScope(a: CommercialHealthThreshold['scope'], b: CommercialHealthThreshold['scope']): boolean { return a?.productId === b?.productId && a?.campaignId === b?.campaignId && a?.channel === b?.channel; }
function scopeSize(scope: CommercialHealthThreshold['scope']): number { return Number(Boolean(scope?.productId)) + Number(Boolean(scope?.campaignId)) + Number(Boolean(scope?.channel)); }
function round(value: number): number { return Math.round(value * 10000) / 10000; }
function assertAdministrator(actor: CommercialActor): void { if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new CommercialHealthError('Commercial administrator role is required.'); }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new CommercialHealthError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
