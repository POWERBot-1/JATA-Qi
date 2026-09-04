import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { emitPlainEnveloped } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type {
  CommercialActor,
  CommercialControlPlaneService,
  CommercialEvent,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import { CommercialControlPlaneEvents, commercialEventFromEnvelope } from '@jataqi/commercial-control-plane';
import {
  CommercialObservabilityEvents,
  type AlertDirection,
  type CommercialAlert,
  type CommercialAlertRule,
  type CommercialAlertSeverity,
  type CommercialEventProjection,
  type CommercialIncident,
  type CommercialIncidentStatus,
  type CommercialIncidentUpdate,
  type CommercialMetricClassification,
  type CommercialMetricSample,
  type CommercialObservabilityConfig,
  type CommercialObservabilityScope,
  type CommercialObservabilitySnapshot,
  type CommercialTrace,
  type ConfigureCommercialAlertRuleInput,
  type CreateCommercialIncidentInput,
  type RecordCommercialMetricInput,
  type UpdateCommercialIncidentInput,
} from './types.js';

const EVENT_PROJECTIONS_COLLECTION = 'commercial-observability.event-projections';
const TRACES_COLLECTION = 'commercial-observability.traces';
const METRICS_COLLECTION = 'commercial-observability.metrics';
const ALERT_RULES_COLLECTION = 'commercial-observability.alert-rules';
const ALERTS_COLLECTION = 'commercial-observability.alerts';
const INCIDENTS_COLLECTION = 'commercial-observability.incidents';
const INCIDENT_UPDATES_COLLECTION = 'commercial-observability.incident-updates';
const MAX_EVIDENCE = 100;
const MAX_SCOPE_VALUE = 160;
const MAX_TRACE_EVENTS = 500;
const METRIC_CLASSIFICATIONS = new Set<CommercialMetricClassification>(['OBSERVED', 'MEASURED', 'SIMULATED']);
const EVIDENCE_STATUSES = new Set<CommercialEvidence['status']>([
  'UNVERIFIED', 'PARTIAL', 'OBSERVED', 'MEASURED', 'CUSTOMER_CONFIRMED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED',
  'ESTIMATED', 'ASSUMPTION', 'PREDICTION', 'STALE', 'CONFLICTING', 'UNAVAILABLE',
]);
const ALERT_DIRECTIONS = new Set<AlertDirection>(['ABOVE_IS_WORSE', 'BELOW_IS_WORSE']);
const PRIVACY_CLASSIFICATIONS = new Set<PrivacyClassification>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PERSONAL_DATA']);
const PRIVACY_RANK: Record<PrivacyClassification, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, PERSONAL_DATA: 4 };
const INCIDENT_SEVERITIES = new Set<CommercialIncident['severity']>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export class CommercialObservabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialObservabilityError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Tenant-bound commercial telemetry/SRE foundation. It projects CCP event
 * metadata, records explicitly classified metrics, and manages alert/incident
 * records. It intentionally has no external telemetry exporter, background
 * worker, action adapter, remediation executor, or policy-bypass path.
 */
export class CommercialObservabilityService {
  private api!: KernelApi;
  private controlPlane!: CommercialControlPlaneService;
  private projections!: ICollection<CommercialEventProjection>;
  private traces!: ICollection<CommercialTrace>;
  private metrics!: ICollection<CommercialMetricSample>;
  private alertRules!: ICollection<CommercialAlertRule>;
  private alerts!: ICollection<CommercialAlert>;
  private incidents!: ICollection<CommercialIncident>;
  private incidentUpdates!: ICollection<CommercialIncidentUpdate>;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly clock: () => number;

  constructor(config: CommercialObservabilityConfig = {}) {
    this.clock = config.now ?? (() => Date.now());
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.projections = await storage.collection<CommercialEventProjection>(EVENT_PROJECTIONS_COLLECTION);
    this.traces = await storage.collection<CommercialTrace>(TRACES_COLLECTION);
    this.metrics = await storage.collection<CommercialMetricSample>(METRICS_COLLECTION);
    this.alertRules = await storage.collection<CommercialAlertRule>(ALERT_RULES_COLLECTION);
    this.alerts = await storage.collection<CommercialAlert>(ALERTS_COLLECTION);
    this.incidents = await storage.collection<CommercialIncident>(INCIDENTS_COLLECTION);
    this.incidentUpdates = await storage.collection<CommercialIncidentUpdate>(INCIDENT_UPDATES_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();

    // Observability must not make a commercial event fail solely because a
    // telemetry projection cannot be stored. The original durable CCP event
    // remains the canonical record and errors are logged for host repair.
    // F-01f enveloped cutover: capture first-class envelopes (the
    // control-plane producer is enveloped; the guard still drops anything
    // that does not decode to a CommercialEvent).
    this.unsubscribers.push(kernel.bus.onEnveloped(CommercialControlPlaneEvents.EventRecorded, async (_topic, envelope) => {
      const payload = commercialEventFromEnvelope(envelope);
      if (!isCommercialEvent(payload)) return;
      try {
        await this.captureEvent(payload);
      } catch (error) {
        kernel.logger.error('commercial observability failed to capture control-plane event', error as Error);
      }
    }));
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  /** Configure a local alert policy. Alerting is record-only and never executes remediation. */
  async configureAlertRule(actor: CommercialActor, input: ConfigureCommercialAlertRuleInput): Promise<CommercialAlertRule> {
    assertAdministrator(actor);
    validateAlertRuleInput(input);
    const now = this.clock();
    const scope = input.scope ? sanitizeScope(input.scope) : undefined;
    const existing = await this.alertRules.query({
      where: (rule) => rule.tenantId === actor.tenantId && rule.name === cleanText(input.name, 'Alert rule name', 180) && rule.metric === cleanText(input.metric, 'Alert rule metric', 180) && sameScope(rule.scope, scope),
      limit: 1,
    });
    if (existing[0]) throw new CommercialObservabilityError(`A matching alert rule already exists: ${existing[0].id}.`);
    const rule: CommercialAlertRule = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      name: cleanText(input.name, 'Alert rule name', 180),
      metric: cleanText(input.metric, 'Alert rule metric', 180),
      scope,
      direction: input.direction,
      warningThreshold: input.warningThreshold,
      criticalThreshold: input.criticalThreshold,
      minimumEvidenceStrength: input.minimumEvidenceStrength ?? 0,
      includeSimulated: input.includeSimulated ?? false,
      cooldownMs: input.cooldownMs ?? 0,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    await this.alertRules.put(rule);
    return copy(rule);
  }

  async setAlertRuleActive(actor: CommercialActor, ruleId: string, active: boolean): Promise<CommercialAlertRule> {
    assertAdministrator(actor);
    const rule = await this.requireAlertRule(actor, ruleId);
    const updated = { ...rule, active, updatedAt: this.clock() };
    await this.alertRules.put(updated);
    return copy(updated);
  }

  /**
   * Record an explicitly classified sample and create local alert records for
   * matching rules. Simulated metrics are excluded unless a rule explicitly
   * opts in; neither sample nor alert has a remediation side effect.
   */
  async recordMetric(actor: CommercialActor, input: RecordCommercialMetricInput): Promise<{ sample: CommercialMetricSample; alerts: CommercialAlert[] }> {
    assertManager(actor);
    validateMetricInput(input, this.clock());
    const now = this.clock();
    const evidence = sanitizeEvidence(input.evidence);
    const sample: CommercialMetricSample = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      metric: cleanText(input.metric, 'Metric name', 180),
      value: input.value,
      unit: cleanText(input.unit, 'Metric unit', 120),
      classification: input.classification,
      scope: sanitizeScope(input.scope ?? {}),
      evidence,
      evidenceStrength: averageEvidenceStrength(evidence),
      provenance: sanitizeProvenance(input.provenance),
      privacyClassification: privacyClassification(input.privacyClassification),
      observedAt: input.observedAt ?? now,
      createdAt: now,
    };
    await this.metrics.put(sample);
    const raised: CommercialAlert[] = [];
    const rules = await this.alertRules.query({
      where: (rule) => rule.tenantId === sample.tenantId && rule.active && rule.metric === sample.metric && scopeMatches(rule.scope, sample.scope),
    });
    for (const rule of rules.sort((first, second) => first.id.localeCompare(second.id))) {
      if (sample.classification === 'SIMULATED' && !rule.includeSimulated) continue;
      if (sample.evidenceStrength < rule.minimumEvidenceStrength) continue;
      const severity = alertSeverity(rule, sample.value);
      if (!severity || await this.isCoolingDown(rule, now)) continue;
      const alert: CommercialAlert = {
        id: randomUUID(),
        tenantId: sample.tenantId,
        ruleId: rule.id,
        metricSampleId: sample.id,
        severity,
        status: 'OPEN',
        summary: `${severity} alert from rule ${rule.name}: ${sample.metric}=${sample.value} ${sample.unit}. Alerting has no remediation side effect.`,
        scope: copy(sample.scope),
        createdAt: now,
      };
      await this.alerts.put(alert);
      raised.push(alert);
      await this.emitTelemetryEvent(CommercialObservabilityEvents.AlertRaised, alert.tenantId, actor.id, alert.id, safeAlertEvent(alert));
    }
    await this.emitTelemetryEvent(CommercialObservabilityEvents.MetricRecorded, sample.tenantId, actor.id, sample.id, {
      sampleId: sample.id,
      tenantId: sample.tenantId,
      metric: sample.metric,
      classification: sample.classification,
      evidenceStrength: sample.evidenceStrength,
      alertIds: raised.map((alert) => alert.id),
    });
    return { sample: copy(sample), alerts: raised.map(copy) };
  }

  async acknowledgeAlert(actor: CommercialActor, alertId: string): Promise<CommercialAlert> {
    assertManager(actor);
    const alert = await this.requireAlert(actor, alertId);
    if (alert.status !== 'OPEN') throw new CommercialObservabilityError(`Alert is ${alert.status} and cannot be acknowledged.`);
    const updated: CommercialAlert = { ...alert, status: 'ACKNOWLEDGED', acknowledgedAt: this.clock(), acknowledgedByActorId: actor.id };
    await this.alerts.put(updated);
    await this.emitTelemetryEvent(CommercialObservabilityEvents.AlertAcknowledged, updated.tenantId, actor.id, updated.id, safeAlertEvent(updated));
    return copy(updated);
  }

  /** Resolve only the local alert record; it does not assert that an external system recovered. */
  async resolveAlert(actor: CommercialActor, alertId: string, resolutionSummary: string): Promise<CommercialAlert> {
    assertManager(actor);
    const alert = await this.requireAlert(actor, alertId);
    if (alert.status === 'RESOLVED') return copy(alert);
    const updated: CommercialAlert = {
      ...alert,
      status: 'RESOLVED',
      resolvedAt: this.clock(),
      resolvedByActorId: actor.id,
      resolutionSummary: cleanText(resolutionSummary, 'Alert resolution summary', 640),
    };
    await this.alerts.put(updated);
    await this.emitTelemetryEvent(CommercialObservabilityEvents.AlertResolved, updated.tenantId, actor.id, updated.id, safeAlertEvent(updated));
    return copy(updated);
  }

  /** Create a local incident record; it is never an automatic remediation request. */
  async createIncident(actor: CommercialActor, input: CreateCommercialIncidentInput): Promise<CommercialIncident> {
    assertManager(actor);
    validateIncidentInput(input);
    const alertIds = uniqueIds(input.alertIds ?? [], 'Incident alert ids');
    const traceIds = uniqueIds(input.traceIds ?? [], 'Incident trace ids');
    for (const alertId of alertIds) {
      const alert = await this.requireAlert(actor, alertId);
      if (alert.tenantId !== actor.tenantId) throw new CommercialObservabilityError('Incident alert references must remain in the actor tenant.');
    }
    for (const traceId of traceIds) {
      const trace = await this.requireTrace(actor, traceId);
      if (trace.tenantId !== actor.tenantId) throw new CommercialObservabilityError('Incident trace references must remain in the actor tenant.');
    }
    const now = this.clock();
    const incident: CommercialIncident = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      title: cleanText(input.title, 'Incident title', 240),
      severity: input.severity,
      status: 'OPEN',
      alertIds,
      traceIds,
      summary: cleanText(input.summary, 'Incident summary', 800),
      evidence: sanitizeEvidence(input.evidence),
      privacyClassification: privacyClassification(input.privacyClassification),
      createdByActorId: actor.id,
      doesNotExecuteRemediation: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.incidents.put(incident);
    await this.emitTelemetryEvent(CommercialObservabilityEvents.IncidentCreated, incident.tenantId, actor.id, incident.id, safeIncidentEvent(incident));
    return copy(incident);
  }

  /** Persist a bounded local incident state update; no remediation capability exists in this service. */
  async updateIncident(actor: CommercialActor, incidentId: string, input: UpdateCommercialIncidentInput): Promise<{ incident: CommercialIncident; update: CommercialIncidentUpdate }> {
    assertManager(actor);
    const incident = await this.requireIncident(actor, incidentId);
    validateIncidentUpdateInput(input);
    if (!incidentTransitionAllowed(incident.status, input.status)) {
      throw new CommercialObservabilityError(`Incident transition ${incident.status} -> ${input.status} is not allowed.`);
    }
    const evidence = sanitizeEvidence(input.evidence ?? [], input.status === 'RESOLVED' || input.status === 'CLOSED');
    const now = this.clock();
    const updated: CommercialIncident = {
      ...incident,
      status: input.status,
      updatedAt: now,
      resolvedAt: input.status === 'RESOLVED' ? now : incident.resolvedAt,
      closedAt: input.status === 'CLOSED' ? now : incident.closedAt,
    };
    const update: CommercialIncidentUpdate = {
      id: randomUUID(),
      tenantId: incident.tenantId,
      incidentId: incident.id,
      previousStatus: incident.status,
      newStatus: input.status,
      actorId: actor.id,
      summary: cleanText(input.summary, 'Incident update summary', 800),
      evidence,
      createdAt: now,
    };
    await this.incidents.put(updated);
    await this.incidentUpdates.put(update);
    await this.emitTelemetryEvent(CommercialObservabilityEvents.IncidentUpdated, updated.tenantId, actor.id, update.id, {
      incidentId: updated.id,
      tenantId: updated.tenantId,
      previousStatus: update.previousStatus,
      status: updated.status,
      updateId: update.id,
      doesNotExecuteRemediation: true,
    });
    return { incident: copy(updated), update: copy(update) };
  }

  async snapshot(actor: CommercialActor): Promise<CommercialObservabilitySnapshot> {
    assertViewer(actor);
    const [projections, traces, metrics, alerts, incidents] = await Promise.all([
      this.projections.query({ where: (projection) => canRead(actor, projection.tenantId) }),
      this.traces.query({ where: (trace) => canRead(actor, trace.tenantId) }),
      this.metrics.query({ where: (metric) => canRead(actor, metric.tenantId) }),
      this.alerts.query({ where: (alert) => canRead(actor, alert.tenantId) }),
      this.incidents.query({ where: (incident) => canRead(actor, incident.tenantId) }),
    ]);
    return {
      tenantId: actor.tenantId,
      generatedAt: this.clock(),
      capturedEventCount: projections.length,
      traceCount: traces.length,
      metricCount: metrics.length,
      activeAlertCount: alerts.filter((alert) => alert.status !== 'RESOLVED').length,
      activeIncidentCount: incidents.filter((incident) => !['RESOLVED', 'CLOSED'].includes(incident.status)).length,
      criticalAlertCount: alerts.filter((alert) => alert.severity === 'CRITICAL' && alert.status !== 'RESOLVED').length,
      simulatedMetricCount: metrics.filter((metric) => metric.classification === 'SIMULATED').length,
    };
  }

  async listEventProjections(actor: CommercialActor): Promise<CommercialEventProjection[]> {
    return sorted(await this.projections.query({ where: (projection) => canRead(actor, projection.tenantId) })).map(copy);
  }

  async listTraces(actor: CommercialActor): Promise<CommercialTrace[]> {
    return sorted(await this.traces.query({ where: (trace) => canRead(actor, trace.tenantId) })).map(copy);
  }

  async listMetricSamples(actor: CommercialActor): Promise<CommercialMetricSample[]> {
    return sorted(await this.metrics.query({ where: (sample) => canRead(actor, sample.tenantId) })).map(copy);
  }

  async listAlertRules(actor: CommercialActor): Promise<CommercialAlertRule[]> {
    return sorted(await this.alertRules.query({ where: (rule) => canRead(actor, rule.tenantId) })).map(copy);
  }

  async listAlerts(actor: CommercialActor): Promise<CommercialAlert[]> {
    return sorted(await this.alerts.query({ where: (alert) => canRead(actor, alert.tenantId) })).map(copy);
  }

  async listIncidents(actor: CommercialActor): Promise<CommercialIncident[]> {
    return sorted(await this.incidents.query({ where: (incident) => canRead(actor, incident.tenantId) })).map(copy);
  }

  async listIncidentUpdates(actor: CommercialActor, incidentId: string): Promise<CommercialIncidentUpdate[]> {
    await this.requireIncident(actor, incidentId);
    return sorted(await this.incidentUpdates.query({ where: (update) => update.incidentId === incidentId })).map(copy);
  }

  /**
   * F-01b enveloped producer: telemetry events are first-class envelopes with
   * tenant/actor/correlation; the exact privacy-minimized legacy payload is
   * preserved for existing subscribers (single emission, no topic renames).
   */
  private emitTelemetryEvent(
    event: string,
    tenantId: string,
    actorId: string,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return emitPlainEnveloped(this.api.bus, event, payload, {
      source: 'commercial-observability',
      tenantId,
      actor: actorId,
      correlationId,
    });
  }

  private async captureEvent(event: CommercialEvent): Promise<void> {
    const existing = await this.projections.get(event.id);
    if (existing) return;
    const now = this.clock();
    const correlationHash = hashReference(event.tenantId, event.correlationId);
    const projection: CommercialEventProjection = {
      id: event.id,
      tenantId: event.tenantId,
      eventId: event.id,
      eventSequence: event.sequence,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      schemaVersion: event.schemaVersion,
      source: event.source,
      entityReferenceHash: event.entityId ? hashReference(event.tenantId, event.entityId) : undefined,
      correlationHash,
      causationHash: event.causationId ? hashReference(event.tenantId, event.causationId) : undefined,
      payloadFieldCount: Object.keys(event.payload).length,
      privacyClassification: event.privacyClassification,
      timestamp: event.timestamp,
      capturedAt: now,
      createdAt: now,
    };
    await this.projections.put(projection);
    const traceId = `${event.tenantId}:${correlationHash}`;
    const trace = await this.traces.get(traceId);
    const updatedTrace: CommercialTrace = trace
      ? {
        ...trace,
        causationHashes: appendUnique(trace.causationHashes, projection.causationHash),
        eventIds: appendUnique(trace.eventIds, projection.eventId),
        eventTypes: appendUnique(trace.eventTypes, projection.eventType),
        sources: appendUnique(trace.sources, projection.source),
        lastEventAt: Math.max(trace.lastEventAt, projection.timestamp),
        privacyClassification: strictestPrivacy(trace.privacyClassification, projection.privacyClassification),
        updatedAt: now,
      }
      : {
        id: traceId,
        tenantId: event.tenantId,
        correlationHash,
        causationHashes: projection.causationHash ? [projection.causationHash] : [],
        eventIds: [projection.eventId],
        eventTypes: [projection.eventType],
        sources: [projection.source],
        firstEventAt: projection.timestamp,
        lastEventAt: projection.timestamp,
        privacyClassification: projection.privacyClassification,
        createdAt: now,
        updatedAt: now,
      };
    await this.traces.put(updatedTrace);
    await this.emitTelemetryEvent(CommercialObservabilityEvents.EventCaptured, projection.tenantId, event.actor ?? 'commercial-observability-system', event.correlationId, {
      projectionId: projection.id,
      tenantId: projection.tenantId,
      eventId: projection.eventId,
      eventType: projection.eventType,
      traceId: updatedTrace.id,
    });
  }

  private async isCoolingDown(rule: CommercialAlertRule, now: number): Promise<boolean> {
    if (rule.cooldownMs === 0) return false;
    const recent = await this.alerts.query({
      where: (alert) => alert.tenantId === rule.tenantId && alert.ruleId === rule.id && alert.status !== 'RESOLVED' && alert.createdAt > now - rule.cooldownMs,
      limit: 1,
    });
    return recent.length > 0;
  }

  private async requireAlertRule(actor: CommercialActor, ruleId: string): Promise<CommercialAlertRule> {
    const rule = await this.alertRules.get(ruleId);
    if (!rule || !canRead(actor, rule.tenantId)) throw new CommercialObservabilityError('Commercial alert rule not found.');
    return rule;
  }

  private async requireAlert(actor: CommercialActor, alertId: string): Promise<CommercialAlert> {
    const alert = await this.alerts.get(alertId);
    if (!alert || !canRead(actor, alert.tenantId)) throw new CommercialObservabilityError('Commercial alert not found.');
    return alert;
  }

  private async requireTrace(actor: CommercialActor, traceId: string): Promise<CommercialTrace> {
    const trace = await this.traces.get(traceId);
    if (!trace || !canRead(actor, trace.tenantId)) throw new CommercialObservabilityError('Commercial trace not found.');
    return trace;
  }

  private async requireIncident(actor: CommercialActor, incidentId: string): Promise<CommercialIncident> {
    const incident = await this.incidents.get(incidentId);
    if (!incident || !canRead(actor, incident.tenantId)) throw new CommercialObservabilityError('Commercial incident not found.');
    return incident;
  }
}

function validateAlertRuleInput(input: ConfigureCommercialAlertRuleInput): void {
  if (!input || typeof input !== 'object') throw new CommercialObservabilityError('Commercial alert rule input is required.');
  cleanText(input.name, 'Alert rule name', 180);
  cleanText(input.metric, 'Alert rule metric', 180);
  if (!ALERT_DIRECTIONS.has(input.direction)) throw new CommercialObservabilityError('Alert rule direction is invalid.');
  if (input.warningThreshold === undefined && input.criticalThreshold === undefined) throw new CommercialObservabilityError('At least one alert threshold is required.');
  for (const threshold of [input.warningThreshold, input.criticalThreshold]) if (threshold !== undefined && !Number.isFinite(threshold)) throw new CommercialObservabilityError('Alert thresholds must be finite.');
  if (input.warningThreshold !== undefined && input.criticalThreshold !== undefined) {
    const correct = input.direction === 'ABOVE_IS_WORSE'
      ? input.criticalThreshold >= input.warningThreshold
      : input.criticalThreshold <= input.warningThreshold;
    if (!correct) throw new CommercialObservabilityError('Critical threshold must be at least as severe as warning threshold.');
  }
  if (input.minimumEvidenceStrength !== undefined) assertPercent(input.minimumEvidenceStrength, 'Minimum evidence strength');
  if (input.cooldownMs !== undefined && (!Number.isInteger(input.cooldownMs) || input.cooldownMs < 0 || input.cooldownMs > 86_400_000)) throw new CommercialObservabilityError('Alert cooldown must be an integer from 0 to 86400000 milliseconds.');
  if (input.scope) sanitizeScope(input.scope);
}

function validateMetricInput(input: RecordCommercialMetricInput, now: number): void {
  if (!input || typeof input !== 'object') throw new CommercialObservabilityError('Commercial metric input is required.');
  cleanText(input.metric, 'Metric name', 180);
  cleanText(input.unit, 'Metric unit', 120);
  if (!Number.isFinite(input.value)) throw new CommercialObservabilityError('Metric value must be finite.');
  if (!METRIC_CLASSIFICATIONS.has(input.classification)) throw new CommercialObservabilityError('Metric classification is invalid.');
  if (!input.evidence.length) throw new CommercialObservabilityError('Commercial metric records require at least one evidence record.');
  sanitizeEvidence(input.evidence);
  sanitizeProvenance(input.provenance);
  if (input.scope) sanitizeScope(input.scope);
  privacyClassification(input.privacyClassification);
  if (input.observedAt !== undefined && (!Number.isFinite(input.observedAt) || input.observedAt <= 0 || input.observedAt > now + 60_000)) throw new CommercialObservabilityError('Metric observation time must be a valid timestamp.');
}

function validateIncidentInput(input: CreateCommercialIncidentInput): void {
  if (!input || typeof input !== 'object') throw new CommercialObservabilityError('Commercial incident input is required.');
  cleanText(input.title, 'Incident title', 240);
  if (!INCIDENT_SEVERITIES.has(input.severity)) throw new CommercialObservabilityError('Incident severity is invalid.');
  cleanText(input.summary, 'Incident summary', 800);
  if (!input.evidence.length) throw new CommercialObservabilityError('Commercial incidents require at least one evidence record.');
  sanitizeEvidence(input.evidence);
  uniqueIds(input.alertIds ?? [], 'Incident alert ids');
  uniqueIds(input.traceIds ?? [], 'Incident trace ids');
  privacyClassification(input.privacyClassification);
}

function validateIncidentUpdateInput(input: UpdateCommercialIncidentInput): void {
  if (!input || typeof input !== 'object') throw new CommercialObservabilityError('Commercial incident update input is required.');
  if (!['ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED'].includes(input.status)) throw new CommercialObservabilityError('Incident update status is invalid.');
  cleanText(input.summary, 'Incident update summary', 800);
  if (input.evidence) sanitizeEvidence(input.evidence);
}

function sanitizeScope(value: CommercialObservabilityScope): CommercialObservabilityScope {
  const source = record(value, 'Commercial observability scope');
  const scope: CommercialObservabilityScope = {};
  for (const key of ['productId', 'ventureId', 'campaignId', 'market', 'channel', 'connectorId', 'actionType'] as const) {
    if (source[key] !== undefined) scope[key] = cleanText(source[key], `Scope ${key}`, MAX_SCOPE_VALUE);
  }
  if (source.environment !== undefined) {
    if (source.environment !== 'sandbox' && source.environment !== 'staging' && source.environment !== 'production') throw new CommercialObservabilityError('Scope environment is invalid.');
    scope.environment = source.environment;
  }
  return scope;
}

function sanitizeEvidence(value: unknown, required = true): CommercialEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE || (required && value.length === 0)) throw new CommercialObservabilityError(`Evidence must contain ${required ? 'at least one and ' : ''}at most ${MAX_EVIDENCE} records.`);
  const ids = new Set<string>();
  return value.map((item) => {
    const evidence = record(item, 'Evidence record');
    const id = cleanText(evidence.id, 'Evidence id', 120);
    if (ids.has(id)) throw new CommercialObservabilityError(`Duplicate evidence id ${id}.`);
    ids.add(id);
    const status = evidence.status;
    if (typeof status !== 'string' || !EVIDENCE_STATUSES.has(status as CommercialEvidence['status'])) throw new CommercialObservabilityError('Evidence status is invalid.');
    return {
      id,
      status: status as CommercialEvidence['status'],
      source: cleanText(evidence.source, 'Evidence source', 180),
      observedAt: validTimestamp(evidence.observedAt, 'Evidence observation time'),
      confidence: assertPercent(evidence.confidence, 'Evidence confidence'),
      summary: cleanText(evidence.summary, 'Evidence summary', 640),
      provenance: sanitizeProvenance(evidence.provenance),
      validUntil: optionalTimestamp(evidence.validUntil, 'Evidence validity time'),
      privacyClassification: privacyClassification(evidence.privacyClassification),
    };
  });
}

function sanitizeProvenance(value: unknown): CommercialProvenance {
  const provenance = record(value, 'Provenance');
  return {
    source: cleanText(provenance.source, 'Provenance source', 180),
    collectedAt: validTimestamp(provenance.collectedAt, 'Provenance collection time'),
    correlationId: optionalText(provenance.correlationId, 'Provenance correlation id', 180),
    causationId: optionalText(provenance.causationId, 'Provenance causation id', 180),
    sourceReference: optionalText(provenance.sourceReference, 'Provenance source reference', 320),
    contentHash: optionalText(provenance.contentHash, 'Provenance content hash', 180),
  };
}

function alertSeverity(rule: CommercialAlertRule, value: number): CommercialAlertSeverity | undefined {
  const critical = rule.criticalThreshold !== undefined && (rule.direction === 'ABOVE_IS_WORSE' ? value >= rule.criticalThreshold : value <= rule.criticalThreshold);
  if (critical) return 'CRITICAL';
  const warning = rule.warningThreshold !== undefined && (rule.direction === 'ABOVE_IS_WORSE' ? value >= rule.warningThreshold : value <= rule.warningThreshold);
  return warning ? 'WARNING' : undefined;
}

function scopeMatches(ruleScope: CommercialObservabilityScope | undefined, sampleScope: CommercialObservabilityScope): boolean {
  if (!ruleScope) return true;
  return (Object.keys(ruleScope) as Array<keyof CommercialObservabilityScope>).every((key) => ruleScope[key] === sampleScope[key]);
}

function sameScope(first: CommercialObservabilityScope | undefined, second: CommercialObservabilityScope | undefined): boolean {
  const firstKeys = Object.keys(first ?? {}) as Array<keyof CommercialObservabilityScope>;
  const secondKeys = Object.keys(second ?? {}) as Array<keyof CommercialObservabilityScope>;
  return firstKeys.length === secondKeys.length && firstKeys.every((key) => first?.[key] === second?.[key]);
}

function incidentTransitionAllowed(current: CommercialIncidentStatus, next: Exclude<CommercialIncidentStatus, 'OPEN'>): boolean {
  const transitions: Record<CommercialIncidentStatus, CommercialIncidentStatus[]> = {
    OPEN: ['ACKNOWLEDGED', 'MITIGATING', 'RESOLVED'],
    ACKNOWLEDGED: ['MITIGATING', 'RESOLVED'],
    MITIGATING: ['RESOLVED'],
    RESOLVED: ['CLOSED'],
    CLOSED: [],
  };
  return transitions[current].includes(next);
}

function isCommercialEvent(value: unknown): value is CommercialEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<CommercialEvent>;
  return typeof event.id === 'string' && typeof event.tenantId === 'string' && typeof event.eventType === 'string' && typeof event.eventVersion === 'number' && typeof event.schemaVersion === 'number' && typeof event.source === 'string' && typeof event.correlationId === 'string' && typeof event.timestamp === 'number' && event.payload !== null && typeof event.payload === 'object' && typeof event.privacyClassification === 'string';
}

function appendUnique(values: readonly string[], value: string | undefined): string[] {
  if (!value) return [...values];
  const merged = [...new Set([...values, value])];
  return merged.length > MAX_TRACE_EVENTS ? merged.slice(-MAX_TRACE_EVENTS) : merged;
}

function strictestPrivacy(first: PrivacyClassification, second: PrivacyClassification): PrivacyClassification {
  return PRIVACY_RANK[second] > PRIVACY_RANK[first] ? second : first;
}

function hashReference(tenantId: string, value: string): string {
  return createHash('sha256').update(`${tenantId}\u0000${value}`).digest('hex');
}

function averageEvidenceStrength(evidence: readonly CommercialEvidence[]): number {
  return evidence.length ? Math.round(evidence.reduce((sum, item) => sum + item.confidence, 0) / evidence.length * 100) / 100 : 0;
}

function safeAlertEvent(alert: CommercialAlert): Record<string, unknown> {
  return { alertId: alert.id, tenantId: alert.tenantId, ruleId: alert.ruleId, metricSampleId: alert.metricSampleId, severity: alert.severity, status: alert.status };
}

function safeIncidentEvent(incident: CommercialIncident): Record<string, unknown> {
  return { incidentId: incident.id, tenantId: incident.tenantId, severity: incident.severity, status: incident.status, alertIds: incident.alertIds, traceIds: incident.traceIds, doesNotExecuteRemediation: true };
}

function uniqueIds(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_TRACE_EVENTS) throw new CommercialObservabilityError(`${name} must be an array with at most ${MAX_TRACE_EVENTS} value(s).`);
  const ids = value.map((item) => cleanText(item, name, 180));
  if (new Set(ids).size !== ids.length) throw new CommercialObservabilityError(`${name} must not contain duplicate values.`);
  return ids;
}

function cleanText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new CommercialObservabilityError(`${name} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) throw new CommercialObservabilityError(`${name} is required.`);
  return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : cleanText(value, name, maxLength);
}

function validTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new CommercialObservabilityError(`${name} must be a positive finite timestamp.`);
  return value;
}

function optionalTimestamp(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : validTimestamp(value, name);
}

function assertPercent(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new CommercialObservabilityError(`${name} must be a number from 0 to 100.`);
  return value;
}

function privacyClassification(value: unknown): PrivacyClassification {
  if (value === undefined) return 'INTERNAL';
  if (typeof value !== 'string' || !PRIVACY_CLASSIFICATIONS.has(value as PrivacyClassification)) throw new CommercialObservabilityError('Privacy classification is invalid.');
  return value as PrivacyClassification;
}

function assertViewer(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new CommercialObservabilityError('A tenant-bound observability actor is required.');
}

function assertManager(actor: CommercialActor): void {
  assertViewer(actor);
  if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new CommercialObservabilityError('A commercial operator role is required.');
}

function assertAdministrator(actor: CommercialActor): void {
  assertViewer(actor);
  if (!actor.roles.some((role) => ['admin', 'global_admin', 'system'].includes(role))) throw new CommercialObservabilityError('A commercial administrator role is required.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommercialObservabilityError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function sorted<T extends { id: string; createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
