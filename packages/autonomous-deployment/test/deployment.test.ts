import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialControlPlaneService,
  type CommercialEvidence,
} from '@jataqi/commercial-control-plane';
import {
  AutonomousDeploymentModule,
  DeploymentActionType,
  type DeploymentAdapter,
  type DeploymentService,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let deployments: DeploymentService;

function evidence(id = 'deployment-evidence'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'deployment-test',
    observedAt: now,
    confidence: 94,
    summary: 'Controlled pre-deployment evidence.',
    provenance: { source: 'deployment-test', collectedAt: now, correlationId: 'deployment-correlation' },
  };
}

function adapter(counters: Record<string, number>, healthy = true, overrides: Partial<DeploymentAdapter> = {}): DeploymentAdapter {
  return {
    id: 'sandbox-deployer',
    targetSystem: 'sandbox-cluster',
    environments: ['sandbox', 'staging', 'production'],
    maxAttempts: 2,
    defaultTimeoutMs: 100,
    productionEnabled: false,
    async deploy() {
      counters.deploy = (counters.deploy ?? 0) + 1;
      return { reportedSuccess: true, summary: 'Sandbox provider accepted deployment.', externalResponse: { deploymentId: 'provider-1' } };
    },
    async verify() {
      counters.verify = (counters.verify ?? 0) + 1;
      return {
        verified: healthy,
        evidence: [evidence('deployment-verification')],
        summary: healthy ? 'Health and smoke checks passed.' : 'Health endpoint failed.',
        healthChecks: [
          { name: 'health', required: true, passed: healthy, observedAt: now },
          { name: 'smoke', required: true, passed: healthy, observedAt: now },
        ],
        observedReleaseVersion: '1.0.0',
      };
    },
    async rollback() {
      counters.rollback = (counters.rollback ?? 0) + 1;
      return { confirmed: true, summary: 'Sandbox rollback state verified.' };
    },
    ...overrides,
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
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new AutonomousDeploymentModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  deployments = kernel.getModule<AutonomousDeploymentModule>('autonomous-deployment').getService();
  await control.createPolicy(admin, {
    version: 'deployment-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [DeploymentActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function deployment(environment: 'sandbox' | 'production' = 'sandbox') {
  return deployments.createDeployment(operator, {
    ventureId: 'venture-1', productId: 'product-1', releaseVersion: '1.0.0', artifactReference: 'sandbox://artifact/1',
    targetSystem: 'sandbox-cluster', environment, rollbackTarget: '1.0.0-previous', requiredHealthChecks: ['health', 'smoke'], validationEvidence: [evidence()],
  });
}

async function decision() {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', ventureId: 'venture-1', objective: 'Deploy a validated sandbox artifact.',
    proposedAction: 'Execute the approved deployment plan.', actionType: DeploymentActionType,
    evidence: [evidence()], evidenceStrength: 85, riskScore: 20, complianceScore: 95, confidence: 80, authorizationLevel: 2,
    decisionReason: 'Artifact tests and required pre-deployment validation have passed.',
    provenance: { source: 'deployment-test', collectedAt: now, correlationId: 'deployment-correlation' },
  });
}

describe('Autonomous deployment', () => {
  it('requires an explicitly registered adapter for the declared target and environment', async () => {
    const created = await deployment();
    await assert.rejects(() => deployments.queueDeployment(operator, created.id, 'missing'), /adapter not found/);
  });

  it('records provider acceptance as verifying and marks healthy only after health verification', async () => {
    const counters: Record<string, number> = {};
    deployments.registerAdapter(admin, adapter(counters));
    const created = await deployment();
    const queued = await deployments.queueDeployment(operator, created.id, 'sandbox-deployer');
    const proposed = await decision();
    const running = await deployments.executeDeployment(operator, queued.id, { decisionId: proposed.id, idempotencyKey: 'deployment-1', dryRun: false });
    assert.equal(running.state, 'VERIFYING');
    assert.equal(counters.deploy, 1);

    const healthy = await deployments.verifyDeployment(operator, created.id);
    assert.equal(healthy.state, 'HEALTHY');
    assert.equal(healthy.healthChecks.length, 2);
    assert.equal(counters.verify, 1);

    const rolledBack = await deployments.rollbackDeployment(operator, created.id);
    assert.equal(rolledBack.state, 'ROLLED_BACK');
    assert.equal(counters.rollback, 1);
  });

  it('does not mark a deployment healthy when a required health check fails', async () => {
    deployments.registerAdapter(admin, adapter({}, false));
    const created = await deployment();
    await deployments.queueDeployment(operator, created.id, 'sandbox-deployer');
    const proposed = await decision();
    await deployments.executeDeployment(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'deployment-fail', dryRun: false });
    const failed = await deployments.verifyDeployment(operator, created.id);
    assert.equal(failed.state, 'FAILED');
  });

  it('blocks production deployment when the adapter has not been explicitly enabled', async () => {
    const counters: Record<string, number> = {};
    deployments.registerAdapter(admin, adapter(counters, true, { productionEnabled: false }));
    const created = await deployment('production');
    const blocked = await deployments.queueDeployment(operator, created.id, 'sandbox-deployer');
    assert.equal(blocked.state, 'BLOCKED');
    assert.equal(counters.deploy ?? 0, 0);
  });

  it('uses dry-run by default and keeps deployments tenant-isolated', async () => {
    const counters: Record<string, number> = {};
    deployments.registerAdapter(admin, adapter(counters));
    const created = await deployment();
    await deployments.queueDeployment(operator, created.id, 'sandbox-deployer');
    const proposed = await decision();
    const result = await deployments.executeDeployment(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'deployment-dry' });
    assert.equal(result.state, 'VERIFYING');
    assert.equal(counters.deploy ?? 0, 0);
    assert.equal(await deployments.getDeployment(other, created.id), undefined);
  });
});
