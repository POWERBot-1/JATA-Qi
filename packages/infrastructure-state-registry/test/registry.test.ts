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
  InfrastructureProvisionActionType,
  InfrastructureStateRegistryModule,
  type InfrastructureAdapter,
  type InfrastructureStateRegistry,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let registry: InfrastructureStateRegistry;

function evidence(id = 'infra-evidence'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'infrastructure-test',
    observedAt: now,
    confidence: 93,
    summary: 'Controlled infrastructure validation evidence.',
    provenance: { source: 'infrastructure-test', collectedAt: now, correlationId: 'infra-correlation' },
  };
}

function adapter(counters: Record<string, number>, healthy = true, overrides: Partial<InfrastructureAdapter> = {}): InfrastructureAdapter {
  return {
    id: 'sandbox-infra', provider: 'sandbox-cloud', resourceTypes: ['VPS', 'DNS_RECORD', 'TLS_CERTIFICATE'], environments: ['sandbox', 'staging', 'production'],
    maxAttempts: 2, defaultTimeoutMs: 100, productionEnabled: false,
    async provision() {
      counters.provision = (counters.provision ?? 0) + 1;
      return { reportedSuccess: true, summary: 'Sandbox provider accepted provisioning request.', externalResponse: { resourceId: 'provider-1' } };
    },
    async verify() {
      counters.verify = (counters.verify ?? 0) + 1;
      return {
        verified: healthy,
        evidence: [evidence('infra-verification')], health: healthy ? 'HEALTHY' : 'FAILED',
        observedState: healthy ? { hostname: 'app.example.test', version: 'v1' } : { hostname: 'unreachable' },
      };
    },
    async rollback() {
      counters.rollback = (counters.rollback ?? 0) + 1;
      return { confirmed: true, summary: 'Sandbox resource removal verified.' };
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
  kernel.register(new InfrastructureStateRegistryModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  registry = kernel.getModule<InfrastructureStateRegistryModule>('infrastructure-state-registry').getRegistry();
  await control.createPolicy(admin, {
    version: 'infrastructure-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [InfrastructureProvisionActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function resource(environment: 'sandbox' | 'production' = 'sandbox') {
  return registry.createResource(operator, {
    productId: 'product-1', ventureId: 'venture-1', resourceType: 'VPS', provider: 'sandbox-cloud', region: 'test-region', environment,
    owner: 'operations', credentialReference: 'secret://infra/sandbox', expectedState: { hostname: 'app.example.test', version: 'v1' },
    estimatedCost: { amount: 50, currency: 'KES' }, validationEvidence: [evidence()],
  });
}

async function decision() {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', ventureId: 'venture-1', objective: 'Provision a controlled sandbox resource.',
    proposedAction: 'Provision the approved resource through a registered adapter.', actionType: InfrastructureProvisionActionType,
    evidence: [evidence()], evidenceStrength: 85, riskScore: 20, complianceScore: 95, confidence: 80, authorizationLevel: 2,
    decisionReason: 'Pre-provisioning checks are evidenced and the provider adapter is sandbox-bound.',
    provenance: { source: 'infrastructure-test', collectedAt: now, correlationId: 'infra-correlation' },
  });
}

describe('Infrastructure State Registry', () => {
  it('requires an explicit provider adapter for an infrastructure resource', async () => {
    const created = await resource();
    await assert.rejects(() => registry.queueProvision(operator, created.id, 'missing'), /adapter not found/);
  });

  it('keeps provisioning in VERIFYING until health and expected state are independently confirmed', async () => {
    const counters: Record<string, number> = {};
    registry.registerAdapter(admin, adapter(counters));
    const created = await resource();
    await registry.queueProvision(operator, created.id, 'sandbox-infra');
    const proposed = await decision();
    const provisioning = await registry.provision(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'infra-1', dryRun: false });
    assert.equal(provisioning.status, 'VERIFYING');
    assert.equal(counters.provision, 1);
    const active = await registry.verifyProvision(operator, created.id);
    assert.equal(active.status, 'ACTIVE');
    assert.equal(active.health, 'HEALTHY');
    assert.equal(active.driftState, 'IN_SYNC');
    assert.equal(counters.verify, 1);

    const rolledBack = await registry.rollback(operator, created.id);
    assert.equal(rolledBack.status, 'RETIRED');
    assert.equal(counters.rollback, 1);
  });

  it('records observed drift as reconciliation required instead of silently changing expected state', async () => {
    const created = await resource();
    const observed = await registry.recordObservedState(operator, created.id, {
      observedState: { hostname: 'unexpected.example.test', version: 'v2' }, health: 'HEALTHY', evidence: [evidence('drift-evidence')],
    });
    assert.equal(observed.driftState, 'DRIFT_DETECTED');
    assert.equal(observed.status, 'RECONCILIATION_REQUIRED');
    assert.deepEqual(observed.expectedState, { hostname: 'app.example.test', version: 'v1' });
  });

  it('blocks production provisioning when explicit production enablement is absent', async () => {
    const counters: Record<string, number> = {};
    registry.registerAdapter(admin, adapter(counters, true, { productionEnabled: false }));
    const created = await resource('production');
    const queued = await registry.queueProvision(operator, created.id, 'sandbox-infra');
    assert.equal(queued.status, 'BLOCKED');
    assert.equal(counters.provision ?? 0, 0);
  });

  it('uses dry-run by default and preserves tenant isolation', async () => {
    const counters: Record<string, number> = {};
    registry.registerAdapter(admin, adapter(counters));
    const created = await resource();
    await registry.queueProvision(operator, created.id, 'sandbox-infra');
    const proposed = await decision();
    const result = await registry.provision(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'infra-dry' });
    assert.equal(result.status, 'VERIFYING');
    assert.equal(counters.provision ?? 0, 0);
    assert.equal(await registry.getResource(other, created.id), undefined);
  });
});
