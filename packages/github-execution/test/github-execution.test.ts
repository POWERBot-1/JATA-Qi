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
import { ExternalConnectorModule } from '@jataqi/external-connectors';
import {
  GitHubExecutionError,
  GitHubExecutionModule,
  type GitHubExecutionClient,
  type GitHubExecutionService,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let control: CommercialControlPlaneService;
let github: GitHubExecutionService;

function evidence(id = 'github-evidence'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'github-execution-test',
    observedAt: now,
    confidence: 92,
    summary: 'Controlled GitHub execution evidence.',
    provenance: { source: 'github-execution-test', collectedAt: now, correlationId: 'github-correlation' },
  };
}

function client(counters: Record<string, number>, health: 'HEALTHY' | 'AUTHORIZATION_REQUIRED' = 'HEALTHY'): GitHubExecutionClient {
  return {
    async connect() { counters.connect = (counters.connect ?? 0) + 1; },
    async authenticate() { counters.authenticate = (counters.authenticate ?? 0) + 1; },
    async health() {
      counters.health = (counters.health ?? 0) + 1;
      return { health, observedAt: now, reason: health === 'HEALTHY' ? undefined : 'Permission grant is missing.' };
    },
    async capabilities() {
      counters.capabilities = (counters.capabilities ?? 0) + 1;
      return {
        providerId: 'github', providerType: 'source-control', supportedActions: ['GITHUB_BRANCH_CREATE'],
        authenticationMethod: 'github-app-or-oauth', requiredPermissions: ['contents:write'],
        rollbackSupport: true, webhookSupport: true, sandboxSupport: true, productionSupport: true,
      };
    },
    async execute() {
      counters.execute = (counters.execute ?? 0) + 1;
      return { reportedSuccess: true, summary: 'Mock GitHub accepted branch request.', externalResponse: { ref: 'refs/heads/feature/test' } };
    },
    async verify() {
      counters.verify = (counters.verify ?? 0) + 1;
      return { verified: true, evidence: [evidence('github-verification')], summary: 'Mock GitHub branch was read back.' };
    },
    async rollback() {
      counters.rollback = (counters.rollback ?? 0) + 1;
      return { confirmed: true, summary: 'Mock branch deletion was read back.' };
    },
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
  kernel.register(new GitHubExecutionModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  github = kernel.getModule<GitHubExecutionModule>('github-execution').getService();
  await control.createPolicy(admin, {
    version: 'github-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 4, allowExecution: true,
    allowedActionTypes: ['GITHUB_BRANCH_CREATE'], maximumRiskScore: 80, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function createDecision(connectorId: string) {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', objective: 'Create a controlled feature branch.',
    proposedAction: 'Create the branch after policy authorization.', actionType: 'GITHUB_BRANCH_CREATE', connectorId,
    evidence: [evidence()], evidenceStrength: 85, riskScore: 20, complianceScore: 95, confidence: 82,
    authorizationLevel: 3, decisionReason: 'A sandbox task graph requires an isolated feature branch.',
    provenance: { source: 'github-execution-test', collectedAt: now, correlationId: 'github-correlation' },
  });
}

describe('GitHub Execution', () => {
  it('reports an unconfigured GitHub connection as blocked without attempting a provider operation', async () => {
    const connection = await github.configure(admin, { credentialReference: 'secret://github/acme' });
    assert.equal(connection.status, 'BLOCKED_CREDENTIALS');
    assert.equal(connection.connectorHealth, 'AUTHORIZATION_REQUIRED');
    const activated = await github.activate(admin, connection.id);
    assert.equal(activated.status, 'BLOCKED_CREDENTIALS');
    await assert.rejects(
      () => github.plan(operator, 'missing-decision', { connectionId: connection.id, idempotencyKey: 'blocked' }),
      GitHubExecutionError,
    );
  });

  it('requires capability/health activation and control-plane authorization before a sandbox operation', async () => {
    const counters: Record<string, number> = {};
    const connection = await github.configure(admin, {
      credentialReference: 'secret://github/acme', client: client(counters), supportedActions: ['GITHUB_BRANCH_CREATE'],
      requiredPermissions: ['contents:write'], environment: 'sandbox',
    });
    const activated = await github.activate(admin, connection.id);
    assert.equal(activated.status, 'CONNECTED');
    assert.equal(counters.connect, 1);
    assert.equal(counters.authenticate, 1);
    assert.equal(counters.capabilities, 1);
    assert.equal(counters.health, 1);
    assert.ok(activated.connectorRegistrationId);

    const proposed = await createDecision(activated.connectorRegistrationId!);
    const planned = await github.plan(operator, proposed.id, { connectionId: activated.id, idempotencyKey: 'github-branch-1', dryRun: false });
    const run = await github.execute(operator, activated.id, planned.id);
    assert.equal(run.status, 'CONNECTED');
    assert.equal(run.executedExternally, true);
    assert.equal(run.executionState, 'VERIFYING');
    const completed = await github.verify(operator, activated.id, planned.id);
    assert.equal(completed.executionStatus, 'COMPLETED');
    assert.equal(counters.execute, 1);
    assert.equal(counters.verify, 1);
  });

  it('maps an authorization-required provider response to a blocked permission state', async () => {
    const counters: Record<string, number> = {};
    const connection = await github.configure(admin, {
      credentialReference: 'secret://github/acme', client: client(counters, 'AUTHORIZATION_REQUIRED'),
      supportedActions: ['GITHUB_BRANCH_CREATE'], requiredPermissions: ['contents:write'],
    });
    const activated = await github.activate(admin, connection.id);
    assert.equal(activated.status, 'BLOCKED_PERMISSION');
    assert.equal(activated.connectorHealth, 'AUTHORIZATION_REQUIRED');
  });

  it('keeps production execution behind explicit enablement and live verification', async () => {
    const counters: Record<string, number> = {};
    const staged = await github.configure(admin, {
      credentialReference: 'secret://github/acme-production', client: client(counters),
      supportedActions: ['GITHUB_BRANCH_CREATE'], requiredPermissions: ['contents:write'], environment: 'production', productionEnabled: false,
    });
    const awaiting = await github.activate(admin, staged.id);
    assert.equal(awaiting.status, 'READY_FOR_APPROVAL');
    assert.equal(counters.connect ?? 0, 0, 'production connector was not contacted before explicit enablement');

    const enabled = await github.configure(admin, {
      credentialReference: 'secret://github/acme-production', client: client(counters),
      supportedActions: ['GITHUB_BRANCH_CREATE'], requiredPermissions: ['contents:write'], environment: 'production', productionEnabled: true,
    });
    const connected = await github.activate(admin, enabled.id);
    assert.equal(connected.status, 'CONNECTED');
    const decision = await createDecision(connected.connectorRegistrationId!);
    const action = await github.plan(operator, decision.id, { connectionId: connected.id, idempotencyKey: 'production-branch', dryRun: false });
    await assert.rejects(() => github.execute(operator, connected.id, action.id), /LIVE_VERIFIED/);
    await assert.rejects(() => github.markLiveVerified(admin, connected.id, []), /requires one or more independently measured/);
    const live = await github.markLiveVerified(admin, connected.id, [evidence('production-connection-verification')]);
    assert.equal(live.status, 'LIVE_VERIFIED');
  });
});
