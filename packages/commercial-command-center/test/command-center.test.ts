import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialEvidence,
} from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { CommercialHealthModule, type CommercialHealthService } from '@jataqi/commercial-health';
import { CommercialObservabilityModule } from '@jataqi/commercial-observability';
import { CommercialCommandCenterModule, type CommercialCommandCenterService } from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let approver: CommercialActor;
let other: CommercialActor;
let control: ReturnType<CommercialControlPlaneModule['getService']>;
let health: CommercialHealthService;
let commandCenter: CommercialCommandCenterService;

function evidence(id = 'command-center-evidence'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'command-center-test',
    observedAt: now,
    confidence: 95,
    summary: 'Controlled command-center evidence.',
    provenance: { source: 'command-center-test', collectedAt: now, correlationId: 'command-center-correlation' },
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  approver = { id: 'approver', tenantId: 'acme', roles: ['approver'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new CommercialEventStreamModule({ now: () => now }));
  kernel.register(new CommercialHealthModule());
  kernel.register(new CommercialObservabilityModule({ now: () => now }));
  kernel.register(new CommercialCommandCenterModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  health = kernel.getModule<CommercialHealthModule>('commercial-health').getService();
  commandCenter = kernel.getModule<CommercialCommandCenterModule>('commercial-command-center').getService();
});

async function pendingDecision() {
  const decision = await control.proposeDecision(operator, {
    tenantId: 'acme',
    productId: 'product-1',
    objective: 'Review controlled commercial action.',
    proposedAction: 'Wait for an approver.',
    actionType: 'PUBLISH_CONTENT',
    evidence: [evidence()],
    evidenceStrength: 80,
    riskScore: 30,
    complianceScore: 95,
    confidence: 80,
    authorizationLevel: 3,
    decisionReason: 'No matching policy exists, so approval and simulation are required.',
    provenance: { source: 'command-center-test', collectedAt: now, correlationId: 'command-center-correlation' },
  });
  await control.authorizeDecision(operator, decision.id);
  return decision;
}

describe('Commercial command center', () => {
  it('aggregates pending approval context, experiments, active kill switches, health, and safe observability without invoking an action', async () => {
    const decision = await pendingDecision();
    const experiment = await control.createExperiment(operator, {
      hypothesis: 'A bounded experiment improves a measured metric.', productId: 'product-1', control: 'control', variant: 'variant',
      objective: 'Record an approval-required experiment.', primaryMetric: 'conversion', sampleDefinition: 'consented segment', durationMs: 60_000,
      budget: { maximumDurationMs: 60_000, stoppingRule: 'Stop at the configured duration limit.' },
    });
    await control.setKillSwitch(admin, {
      scopeType: 'PRODUCT',
      scope: { tenantId: 'acme', productId: 'product-2' },
      active: true,
      reason: 'Controlled pause.',
    });
    await health.configureThreshold(admin, {
      metric: 'CAC',
      direction: 'HIGHER_IS_WORSE',
      warningRelativeChange: 0.2,
      criticalRelativeChange: 0.5,
    });
    await health.recordObservation(operator, {
      metric: 'CAC',
      value: 160,
      baseline: 100,
      unit: 'KES/customer',
      evidence: [evidence('cac-evidence')],
      provenance: { source: 'command-center-test', collectedAt: now },
    });

    const snapshot = await commandCenter.snapshot(operator);
    assert.equal(snapshot.approvals.length, 1);
    assert.equal(snapshot.approvals[0]?.decision?.id, decision.id);
    assert.equal(snapshot.activeKillSwitches.length, 1);
    assert.equal(snapshot.experiments.length, 1);
    assert.equal(snapshot.experiments[0]?.id, experiment.id);
    assert.equal(snapshot.health?.anomalies.length, 1);
    assert.equal(snapshot.health?.anomalies[0]?.recommendation, 'CONTAIN');
    assert.ok((snapshot.observability?.snapshot.capturedEventCount ?? 0) > 0, 'safe CCP event projections are visible to the read-only command center');
    assert.equal(snapshot.observability?.snapshot.activeIncidentCount, 0);
    assert.ok(snapshot.unavailable.includes('payments'), 'partial stack exposes missing subsystems explicitly');
    assert.equal(snapshot.financial, undefined);
  });

  it('delegates approval resolution to the control plane instead of bypassing roles/state checks', async () => {
    const decision = await pendingDecision();
    const before = await commandCenter.snapshot(approver);
    const request = before.approvals.find((item) => item.decision?.id === decision.id)?.approval;
    assert.ok(request);
    const resolved = await commandCenter.resolveApproval(
      approver,
      request!.id,
      'APPROVED',
      'Independent approver accepts bounded simulation.',
    );
    assert.equal(resolved.state, 'APPROVED');
    assert.equal((await control.getDecision(operator, decision.id))?.approvalState, 'APPROVED');
    await assert.rejects(
      () => commandCenter.resolveApproval(operator, request!.id, 'APPROVED', 'Requester self-approval.'),
      /approver role|required|already/,
    );
  });

  it('keeps aggregated control-plane views tenant-isolated', async () => {
    await pendingDecision();
    const otherSnapshot = await commandCenter.snapshot(other);
    assert.equal(otherSnapshot.approvals.length, 0);
    assert.equal(otherSnapshot.decisions.length, 0);
    assert.equal(otherSnapshot.actions.length, 0);
  });
});
