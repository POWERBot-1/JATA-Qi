import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CommercialControlPlaneModule, type CommercialActor, type CommercialEvidence } from '@jataqi/commercial-control-plane';
import { CommercialHealthModule, type CommercialHealthService } from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let health: CommercialHealthService;

function evidence(id = 'health-evidence'): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 'commercial-health-test', observedAt: now, confidence: 95,
    summary: 'Controlled health evidence.', provenance: { source: 'commercial-health-test', collectedAt: now, correlationId: 'health-correlation' },
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new CommercialHealthModule());
  await kernel.boot();
  health = kernel.getModule<CommercialHealthModule>('commercial-health').getService();
});

describe('Commercial health', () => {
  it('detects critical conversion deterioration and recommends escalation without executing an action', async () => {
    await health.configureThreshold(admin, {
      metric: 'CONVERSION', direction: 'LOWER_IS_WORSE', warningRelativeChange: -0.2, criticalRelativeChange: -0.5,
      scope: { productId: 'product-1' },
    });
    const result = await health.recordObservation(operator, {
      productId: 'product-1', metric: 'CONVERSION', value: 40, baseline: 100, unit: 'signups/day', evidence: [evidence()],
      provenance: { source: 'commercial-health-test', collectedAt: now },
    });
    assert.equal(result.anomaly.severity, 'CRITICAL');
    assert.equal(result.anomaly.recommendation, 'ESCALATE');
    assert.match(result.anomaly.reason, /relativeChange/);
  });

  it('detects critical CAC deterioration and recommends containment rather than autonomous spend', async () => {
    await health.configureThreshold(admin, {
      metric: 'CAC', direction: 'HIGHER_IS_WORSE', warningRelativeChange: 0.2, criticalRelativeChange: 0.5,
    });
    const result = await health.recordObservation(operator, {
      metric: 'CAC', value: 160, baseline: 100, unit: 'KES/customer', currency: 'KES', evidence: [evidence()],
      provenance: { source: 'commercial-health-test', collectedAt: now },
    });
    assert.equal(result.anomaly.severity, 'CRITICAL');
    assert.equal(result.anomaly.recommendation, 'CONTAIN');
  });

  it('returns insufficient evidence rather than a fabricated anomaly without baseline/threshold data', async () => {
    const result = await health.recordObservation(operator, {
      metric: 'REVENUE', value: 100, unit: 'KES/day', evidence: [evidence()], provenance: { source: 'commercial-health-test', collectedAt: now },
    });
    assert.equal(result.anomaly.severity, 'INSUFFICIENT_EVIDENCE');
    assert.equal(result.anomaly.recommendation, 'MONITOR');
  });

  it('classifies material drift and zero-baseline uncertainty explicitly', async () => {
    const drift = await health.assessDrift(operator, {
      productId: 'product-1', dimension: 'AUDIENCE', baseline: 100, observed: 130, evidence: [evidence()], provenance: { source: 'commercial-health-test', collectedAt: now },
    });
    assert.equal(drift.state, 'EXPERIMENT_RECOMMENDED');
    assert.equal(drift.driftScore, 30);
    const insufficient = await health.assessDrift(operator, {
      dimension: 'PRICING', baseline: 0, observed: 10, evidence: [evidence('zero-baseline')], provenance: { source: 'commercial-health-test', collectedAt: now },
    });
    assert.equal(insufficient.state, 'INSUFFICIENT_EVIDENCE');
  });

  it('keeps anomaly and drift records tenant-isolated', async () => {
    await health.recordObservation(operator, { metric: 'TRAFFIC', value: 1, unit: 'visits', evidence: [evidence()], provenance: { source: 'commercial-health-test', collectedAt: now } });
    await health.assessDrift(operator, { dimension: 'MARKET', baseline: 10, observed: 10, evidence: [evidence()], provenance: { source: 'commercial-health-test', collectedAt: now } });
    assert.equal((await health.listAnomalies(other)).length, 0);
    assert.equal((await health.listDrift(other)).length, 0);
  });
});
