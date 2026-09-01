import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { AutonomousActionRuntimeModule, type ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import { CommercialControlPlaneModule, type CommercialActor, type CommercialControlPlaneService, type CommercialEvidence } from '@jataqi/commercial-control-plane';
import { ExternalConnectorError, ExternalConnectorModule, type ExternalConnector, type ExternalConnectorRegistry } from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let control: CommercialControlPlaneService;
let runtime: ActionRuntimeService;
let registry: ExternalConnectorRegistry;

function evidence(id = 'connector-evidence'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'connector-test',
    observedAt: now,
    confidence: 95,
    summary: 'Controlled connector test evidence.',
    provenance: { source: 'connector-test', collectedAt: now, correlationId: 'connector-correlation' },
  };
}

function connector(counters: Record<string, number>, overrides: Partial<ExternalConnector> = {}): ExternalConnector {
  return {
    id: 'test-email-connector',
    providerId: 'test-email',
    providerType: 'email',
    targetSystem: 'test-email-api',
    environment: 'sandbox',
    supportedActions: ['PUBLISH_CONTENT'],
    authenticationMethod: 'oauth',
    requiredPermissions: ['send'],
    rollbackSupport: true,
    webhookSupport: true,
    sandboxSupport: true,
    productionSupport: false,
    credentialReference: 'secret://connectors/test-email',
    async connect() { counters.connect = (counters.connect ?? 0) + 1; },
    async authenticate() { counters.authenticate = (counters.authenticate ?? 0) + 1; },
    async health() {
      counters.health = (counters.health ?? 0) + 1;
      return { health: 'HEALTHY', observedAt: now };
    },
    async capabilities() {
      counters.capabilities = (counters.capabilities ?? 0) + 1;
      return {
        providerId: 'test-email', providerType: 'email', supportedActions: ['PUBLISH_CONTENT'], authenticationMethod: 'oauth',
        requiredPermissions: ['send'], rollbackSupport: true, webhookSupport: true, sandboxSupport: true, productionSupport: false,
      };
    },
    async execute() {
      counters.execute = (counters.execute ?? 0) + 1;
      return { reportedSuccess: true, summary: 'Sandbox mail accepted.', externalResponse: { messageId: 'mail-1' } };
    },
    async verify() {
      counters.verify = (counters.verify ?? 0) + 1;
      return { verified: true, evidence: [evidence('connector-verification')], summary: 'Sandbox delivery verified.' };
    },
    async rollback() {
      counters.rollback = (counters.rollback ?? 0) + 1;
      return { confirmed: true, summary: 'Sandbox mail withdrawal confirmed.' };
    },
    async disconnect() { counters.disconnect = (counters.disconnect ?? 0) + 1; },
    ...overrides,
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new ExternalConnectorModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
  registry = kernel.getModule<ExternalConnectorModule>('external-connectors').getRegistry();
  await control.createPolicy(admin, {
    version: 'connector-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 4, allowExecution: true,
    allowedActionTypes: ['PUBLISH_CONTENT'], maximumRiskScore: 80, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function decision(connectorId: string) {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', objective: 'Send a consented test message.',
    proposedAction: 'Send approved sandbox email.', actionType: 'PUBLISH_CONTENT', connectorId,
    evidence: [evidence()], evidenceStrength: 85, riskScore: 20, complianceScore: 95, confidence: 80,
    authorizationLevel: 3, decisionReason: 'Controlled sandbox connector test.',
    provenance: { source: 'connector-test', collectedAt: now, correlationId: 'connector-correlation' },
  });
}

describe('External Connector Fabric', () => {
  it('does not activate or execute a connector merely because it is registered', async () => {
    const counters: Record<string, number> = {};
    const registration = await registry.register(admin, connector(counters));
    assert.equal(registration.health, 'DISABLED');
    assert.equal(registration.connected, false);
    assert.equal(counters.connect ?? 0, 0);
    assert.equal(runtime.listAdapters().length, 0);

    const proposed = await decision(registration.id);
    await assert.rejects(
      () => runtime.plan(operator, proposed.id, { targetSystem: 'test-email-api', idempotencyKey: 'inactive-connector', dryRun: false }),
      /No registered adapter|authorization outcome is DENY/,
    );
  });

  it('discovers capabilities and health before exposing a connector to the action runtime', async () => {
    const counters: Record<string, number> = {};
    const registration = await registry.register(admin, connector(counters));
    const activated = await registry.activate(admin, registration.id);
    assert.equal(activated.registration.connected, true);
    assert.equal(activated.health.health, 'HEALTHY');
    assert.equal(counters.connect, 1);
    assert.equal(counters.authenticate, 1);
    assert.equal(counters.capabilities, 1);
    assert.equal(counters.health, 1);
    assert.equal(runtime.listAdapters().length, 1);

    const proposed = await decision(registration.id);
    const planned = await runtime.plan(operator, proposed.id, { targetSystem: 'test-email-api', idempotencyKey: 'active-connector', dryRun: false });
    const execution = await runtime.execute(operator, planned.id);
    assert.equal(execution.action.executionStatus, 'VERIFYING');
    await runtime.verify(operator, planned.id);
    assert.equal(counters.execute, 1);
    assert.equal(counters.verify, 1);
  });

  it('exposes a non-executing connector contract report and deactivation removes execution capability', async () => {
    const counters: Record<string, number> = {};
    const registration = await registry.register(admin, connector(counters));
    const report = await registry.contractReport(admin, registration.id);
    assert.equal(report.actionContractReady, true);
    assert.equal(counters.execute ?? 0, 0);
    assert.equal(counters.verify ?? 0, 0);

    await registry.activate(admin, registration.id);
    const deactivated = await registry.deactivate(admin, registration.id, 'Controlled test shutdown.');
    assert.equal(deactivated.health, 'DISABLED');
    assert.equal(runtime.listAdapters().length, 0);
    assert.equal(counters.disconnect, 1);
  });

  it('does not allow cross-tenant connector access', async () => {
    const counters: Record<string, number> = {};
    const registration = await registry.register(admin, connector(counters));
    const other = { id: 'other-admin', tenantId: 'other', roles: ['admin'] as const };
    assert.equal(registry.get(other, registration.id), undefined);
    await assert.rejects(() => registry.activate(other, registration.id), ExternalConnectorError);
  });
});
