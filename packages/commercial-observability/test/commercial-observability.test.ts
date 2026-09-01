import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialControlPlaneService,
  type CommercialEvidence,
} from '@jataqi/commercial-control-plane';
import {
  CommercialObservabilityError,
  CommercialObservabilityModule,
  type CommercialObservabilityService,
} from '../src/index.js';

const admin: CommercialActor = { id: 'observability-admin', tenantId: 'acme', roles: ['admin'] };
const operator: CommercialActor = { id: 'observability-operator', tenantId: 'acme', roles: ['operator'] };
const other: CommercialActor = { id: 'observability-other', tenantId: 'other', roles: ['operator'] };

function provenance(now: number, source = 'commercial-observability-test') {
  return { source, collectedAt: now, correlationId: 'observability-correlation' };
}

function evidence(now: number, id = 'observability-evidence', status: CommercialEvidence['status'] = 'MEASURED'): CommercialEvidence {
  return {
    id,
    status,
    source: `source-${id}`,
    observedAt: now,
    confidence: 90,
    summary: `Bounded evidence summary for ${id}.`,
    provenance: provenance(now, `source-${id}`),
  };
}

async function boot(now: () => number, storage: StorageModuleConfig = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule(storage));
  kernel.register(new CommercialControlPlaneModule({ now }));
  kernel.register(new CommercialObservabilityModule({ now }));
  await kernel.boot();
  return {
    kernel,
    control: kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService(),
    observability: kernel.getModule<CommercialObservabilityModule>('commercial-observability').getService(),
  };
}

async function publishSensitiveEvent(control: CommercialControlPlaneService, now: number) {
  return control.publishEvent(operator, {
    eventType: 'distribution.telemetry.received',
    source: 'sandbox-distribution-adapter',
    entityId: 'customer-or-prospect-raw-id',
    correlationId: 'private-correlation-value',
    payload: { email: 'private@example.com', rawToken: 'never-project-this' },
    provenance: provenance(now),
    privacyClassification: 'CONFIDENTIAL',
    idempotencyKey: `observability-event-${now}`,
  });
}

async function recordCriticalMetric(service: CommercialObservabilityService, now: number, classification: 'MEASURED' | 'SIMULATED' = 'MEASURED') {
  return service.recordMetric(operator, {
    metric: 'CAC',
    value: 160,
    unit: 'KES/customer',
    classification,
    scope: { productId: 'product-1', environment: 'sandbox' },
    evidence: [evidence(now, `cac-${classification}-${now}`, classification === 'SIMULATED' ? 'PREDICTION' : 'MEASURED')],
    provenance: provenance(now),
  });
}

describe('Commercial observability', () => {
  it('projects CCP events into privacy-minimized trace metadata without copying raw payloads or correlation/entity identifiers', async () => {
    let now = 1_000;
    const { kernel, control, observability } = await boot(() => now);
    try {
      const event = await publishSensitiveEvent(control, now);
      const projections = await observability.listEventProjections(operator);
      const traces = await observability.listTraces(operator);
      assert.equal(projections.length, 1);
      assert.equal(projections[0]?.eventId, event.id);
      assert.equal(projections[0]?.payloadFieldCount, 2);
      assert.equal(projections[0]?.privacyClassification, 'CONFIDENTIAL');
      const serialized = JSON.stringify({ projections, traces });
      assert.equal(serialized.includes('private@example.com'), false);
      assert.equal(serialized.includes('never-project-this'), false);
      assert.equal(serialized.includes('private-correlation-value'), false);
      assert.equal(serialized.includes('customer-or-prospect-raw-id'), false);
      assert.equal(traces.length, 1);
      assert.deepEqual(traces[0]?.eventIds, [event.id]);
      assert.deepEqual(traces[0]?.eventTypes, ['distribution.telemetry.received']);
    } finally {
      await kernel.shutdown();
    }
  });

  it('keeps simulated metrics distinct and ignores them by default while raising a record-only critical alert for measured evidence', async () => {
    let now = 2_000;
    const { kernel, observability } = await boot(() => now);
    try {
      await observability.configureAlertRule(admin, {
        name: 'CAC deterioration',
        metric: 'CAC',
        scope: { productId: 'product-1' },
        direction: 'ABOVE_IS_WORSE',
        warningThreshold: 120,
        criticalThreshold: 150,
        minimumEvidenceStrength: 80,
        cooldownMs: 1_000,
      });
      const simulated = await recordCriticalMetric(observability, now, 'SIMULATED');
      assert.equal(simulated.alerts.length, 0);
      const measured = await recordCriticalMetric(observability, now, 'MEASURED');
      assert.equal(measured.alerts.length, 1);
      assert.equal(measured.alerts[0]?.severity, 'CRITICAL');
      const cooling = await recordCriticalMetric(observability, now, 'MEASURED');
      assert.equal(cooling.alerts.length, 0, 'the local alert record respects cooldown; it does not repeatedly invoke a remediation');
      const snapshot = await observability.snapshot(operator);
      assert.equal(snapshot.metricCount, 3);
      assert.equal(snapshot.simulatedMetricCount, 1);
      assert.equal(snapshot.criticalAlertCount, 1);
      assert.equal(snapshot.activeAlertCount, 1);
    } finally {
      await kernel.shutdown();
    }
  });

  it('tracks an incident lifecycle with evidence-bound closure and never exposes a remediation executor', async () => {
    let now = 3_000;
    const { kernel, control, observability } = await boot(() => now);
    try {
      const event = await publishSensitiveEvent(control, now);
      await observability.configureAlertRule(admin, {
        name: 'Connector failure', metric: 'connector_error_rate', direction: 'ABOVE_IS_WORSE', warningThreshold: 0.1, criticalThreshold: 0.5,
      });
      const metric = await observability.recordMetric(operator, {
        metric: 'connector_error_rate', value: 0.8, unit: 'ratio', classification: 'MEASURED', evidence: [evidence(now, 'connector-error')], provenance: provenance(now),
      });
      const traceId = (await observability.listTraces(operator)).find((trace) => trace.eventIds.includes(event.id))?.id;
      assert.ok(traceId);
      const incident = await observability.createIncident(operator, {
        title: 'Connector telemetry anomaly', severity: 'HIGH', alertIds: metric.alerts.map((alert) => alert.id), traceIds: [traceId!],
        summary: 'A bounded local incident record for a measured connector anomaly.', evidence: [evidence(now, 'incident-evidence')],
      });
      assert.equal(incident.doesNotExecuteRemediation, true);
      const acknowledged = await observability.updateIncident(operator, incident.id, { status: 'ACKNOWLEDGED', summary: 'Human operator acknowledged the local incident.' });
      assert.equal(acknowledged.incident.status, 'ACKNOWLEDGED');
      await observability.updateIncident(operator, incident.id, { status: 'MITIGATING', summary: 'Mitigation planning is being reviewed; no action was executed.' });
      await assert.rejects(
        () => observability.updateIncident(operator, incident.id, { status: 'RESOLVED', summary: 'Unsupported resolution.' }),
        CommercialObservabilityError,
      );
      now += 1;
      const resolved = await observability.updateIncident(operator, incident.id, { status: 'RESOLVED', summary: 'Local incident record resolved after review.', evidence: [evidence(now, 'resolution-evidence', 'VERIFIED')] });
      assert.equal(resolved.incident.status, 'RESOLVED');
      assert.equal((await observability.listIncidentUpdates(operator, incident.id)).length, 3);
      const alert = await observability.acknowledgeAlert(operator, metric.alerts[0]!.id);
      assert.equal(alert.status, 'ACKNOWLEDGED');
      assert.equal((await observability.resolveAlert(operator, alert.id, 'Local alert record resolved after incident review.')).status, 'RESOLVED');
    } finally {
      await kernel.shutdown();
    }
  });

  it('enforces alert configuration and tenant isolation', async () => {
    const now = 4_000;
    const { kernel, observability } = await boot(() => now);
    try {
      await assert.rejects(() => observability.configureAlertRule(operator, {
        name: 'Unauthorized rule', metric: 'CAC', direction: 'ABOVE_IS_WORSE', warningThreshold: 1,
      }), CommercialObservabilityError);
      const rule = await observability.configureAlertRule(admin, {
        name: 'Authorized rule', metric: 'CAC', direction: 'ABOVE_IS_WORSE', warningThreshold: 1,
      });
      assert.equal((await observability.listAlertRules(other)).length, 0);
      await assert.rejects(() => observability.setAlertRuleActive(other, rule.id, false), CommercialObservabilityError);
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists safe event/trace/metric/alert/incident records across a filesystem restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-commercial-observability-'));
    let now = 5_000;
    try {
      const first = await boot(() => now, { driver: 'filesystem', fsRoot: root });
      const event = await publishSensitiveEvent(first.control, now);
      await first.observability.configureAlertRule(admin, {
        name: 'Persistent CAC rule', metric: 'CAC', direction: 'ABOVE_IS_WORSE', warningThreshold: 100,
      });
      const metric = await recordCriticalMetric(first.observability, now);
      const incident = await first.observability.createIncident(operator, {
        title: 'Persistent local incident', severity: 'MEDIUM', alertIds: metric.alerts.map((alert) => alert.id),
        summary: 'Persisted local observability incident.', evidence: [evidence(now, 'persistent-incident')],
      });
      await first.kernel.shutdown();

      const second = await boot(() => now, { driver: 'filesystem', fsRoot: root });
      assert.equal((await second.observability.listEventProjections(operator))[0]?.eventId, event.id);
      assert.equal((await second.observability.listTraces(operator)).length, 1);
      assert.equal((await second.observability.listMetricSamples(operator)).length, 1);
      assert.equal((await second.observability.listAlerts(operator)).length, 1);
      assert.equal((await second.observability.listIncidents(operator))[0]?.id, incident.id);
      assert.equal((await second.observability.listEventProjections(other)).length, 0);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
