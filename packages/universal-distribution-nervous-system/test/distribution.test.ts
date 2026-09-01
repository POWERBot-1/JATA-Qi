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
import { ExternalConnectorModule, type ExternalConnector, type ExternalConnectorRegistry } from '@jataqi/external-connectors';
import { UniversalVisibilityFabricModule, type UniversalVisibilityFabricService } from '@jataqi/universal-visibility-fabric';
import {
  DistributionPublishActionType,
  DistributionError,
  UniversalDistributionNervousSystemModule,
  type UniversalDistributionService,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let approver: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let connectors: ExternalConnectorRegistry;
let visibility: UniversalVisibilityFabricService;
let distribution: UniversalDistributionService;

function evidence(id = 'distribution-evidence', status: CommercialEvidence['status'] = 'VERIFIED'): CommercialEvidence {
  return {
    id, status, source: 'distribution-test', observedAt: now, confidence: 95,
    summary: 'Controlled distribution evidence.', provenance: { source: 'distribution-test', collectedAt: now, correlationId: 'distribution-correlation' },
  };
}

function connector(counters: Record<string, number>): ExternalConnector {
  return {
    id: 'social-connector', providerId: 'sandbox-social', providerType: 'social', targetSystem: 'sandbox-social-api', environment: 'sandbox',
    supportedActions: [DistributionPublishActionType], authenticationMethod: 'oauth', requiredPermissions: ['publish'],
    rollbackSupport: true, webhookSupport: true, sandboxSupport: true, productionSupport: false,
    async health() { counters.health = (counters.health ?? 0) + 1; return { health: 'HEALTHY', observedAt: now }; },
    async capabilities() { counters.capabilities = (counters.capabilities ?? 0) + 1; return { providerId: 'sandbox-social', providerType: 'social', supportedActions: [DistributionPublishActionType], authenticationMethod: 'oauth', requiredPermissions: ['publish'], rollbackSupport: true, webhookSupport: true, sandboxSupport: true, productionSupport: false }; },
    async execute() { counters.execute = (counters.execute ?? 0) + 1; return { reportedSuccess: true, summary: 'Sandbox platform accepted post.', externalResponse: { externalReference: 'post-1' } }; },
    async verify() { counters.verify = (counters.verify ?? 0) + 1; return { verified: true, evidence: [evidence('publication-verification')], summary: 'Sandbox post read-back succeeded.' }; },
    async rollback() { return { confirmed: true }; },
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
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new ExternalConnectorModule());
  kernel.register(new UniversalVisibilityFabricModule());
  kernel.register(new UniversalDistributionNervousSystemModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  connectors = kernel.getModule<ExternalConnectorModule>('external-connectors').getRegistry();
  visibility = kernel.getModule<UniversalVisibilityFabricModule>('universal-visibility-fabric').getService();
  distribution = kernel.getModule<UniversalDistributionNervousSystemModule>('universal-distribution-nervous-system').getService();
  await control.createPolicy(admin, {
    version: 'distribution-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 4, allowExecution: true,
    allowedActionTypes: [DistributionPublishActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function approvedAsset() {
  const asset = await visibility.createAsset(operator, {
    productId: 'product-1', content: 'Evidence-backed JATA Qi announcement.', contentType: 'text/plain', source: 'test', language: 'en', inputEvidence: [evidence()],
    claims: [{ id: 'claim', text: 'Measured activation result.', evidenceStatus: 'VERIFIED', evidence: [evidence('claim-evidence')], confidence: 90, provenance: { source: 'test', collectedAt: now } }],
  });
  const validation = await visibility.validateAsset(operator, asset.id);
  await visibility.approveAsset(approver, asset.id, validation.id);
  return asset;
}

async function decision(connectorId: string) {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', objective: 'Publish an approved evidence-backed announcement.',
    proposedAction: 'Publish through the healthy sandbox connector.', actionType: DistributionPublishActionType, connectorId,
    evidence: [evidence()], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85, authorizationLevel: 3,
    decisionReason: 'Asset, connector, and platform capability have been explicitly validated.',
    provenance: { source: 'distribution-test', collectedAt: now, correlationId: 'distribution-correlation' },
  });
}

describe('Universal Distribution Nervous System', () => {
  it('blocks a plan until both creative approval and a healthy active connector exist', async () => {
    const counters: Record<string, number> = {};
    const registration = await connectors.register(admin, connector(counters));
    const asset = await visibility.createAsset(operator, {
      productId: 'product-1', content: 'Draft asset.', contentType: 'text/plain', source: 'test', language: 'en', inputEvidence: [evidence()],
    });
    const plan = await distribution.createPlan(operator, { productId: 'product-1', assetId: asset.id, connectorId: registration.id, channel: 'sandbox-social' });
    const blocked = await distribution.preparePlan(operator, plan.id);
    assert.equal(blocked.state, 'BLOCKED');
    assert.match(blocked.failureReason ?? '', /not approved/);
    assert.equal(counters.execute ?? 0, 0);
  });

  it('models external algorithm reach as non-guaranteed and requires independent publication verification', async () => {
    const counters: Record<string, number> = {};
    const registration = await connectors.register(admin, connector(counters));
    await connectors.activate(admin, registration.id);
    const asset = await approvedAsset();
    const plan = await distribution.createPlan(operator, {
      productId: 'product-1', assetId: asset.id, connectorId: registration.id, channel: 'sandbox-social',
      expectedReach: { value: 100, confidence: 30, method: 'sandbox estimate' },
    });
    assert.equal(plan.algorithmBoundary.guaranteedReach, false);
    assert.equal(plan.expectedReach?.simulated, true);
    await distribution.preparePlan(operator, plan.id);
    const proposed = await decision(registration.id);
    const publishing = await distribution.executePlan(operator, plan.id, { decisionId: proposed.id, idempotencyKey: 'publish-1', dryRun: false });
    assert.equal(publishing.state, 'VERIFYING');
    assert.equal(counters.execute, 1);
    const published = await distribution.verifyPublication(operator, plan.id);
    assert.equal(published.state, 'PUBLISHED');
    assert.equal(published.externalReference, 'post-1');
    assert.equal(counters.verify, 1);
  });

  it('uses dry-run by default and cannot represent a simulation as published', async () => {
    const counters: Record<string, number> = {};
    const registration = await connectors.register(admin, connector(counters));
    await connectors.activate(admin, registration.id);
    const asset = await approvedAsset();
    const plan = await distribution.createPlan(operator, { productId: 'product-1', assetId: asset.id, connectorId: registration.id, channel: 'sandbox-social' });
    await distribution.preparePlan(operator, plan.id);
    const proposed = await decision(registration.id);
    const simulated = await distribution.executePlan(operator, plan.id, { decisionId: proposed.id, idempotencyKey: 'publish-dry' });
    assert.equal(simulated.state, 'SIMULATED');
    assert.equal(counters.execute ?? 0, 0);
    await assert.rejects(() => distribution.verifyPublication(operator, plan.id), /simulated distribution/);
  });

  it('keeps distribution plans tenant-isolated', async () => {
    const counters: Record<string, number> = {};
    const registration = await connectors.register(admin, connector(counters));
    const asset = await approvedAsset();
    const plan = await distribution.createPlan(operator, { productId: 'product-1', assetId: asset.id, connectorId: registration.id, channel: 'sandbox-social' });
    assert.equal(await distribution.getPlan(other, plan.id), undefined);
    assert.equal((await distribution.listPlans(other)).length, 0);
  });
});
