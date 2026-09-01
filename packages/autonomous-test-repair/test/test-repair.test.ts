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
  AutonomousTestRepairModule,
  TestRepairActionType,
  TestRepairError,
  type TestRepairLoop,
  type TestRepairWorker,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let loop: TestRepairLoop;

function evidence(id = 'test-repair-evidence'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'test-repair-test',
    observedAt: now,
    confidence: 95,
    summary: 'Controlled validation evidence.',
    provenance: { source: 'test-repair-test', collectedAt: now, correlationId: 'test-repair-correlation' },
  };
}

function worker(counters: Record<string, number>, failing = false): TestRepairWorker {
  return {
    id: failing ? 'failing-runner' : 'runner-1',
    profiles: ['node-workspace'],
    environment: 'sandbox',
    maxAttempts: 2,
    defaultTimeoutMs: 100,
    async execute() {
      counters.execute = (counters.execute ?? 0) + 1;
      return {
        reportedSuccess: true,
        summary: failing ? 'Test suite contains a regression.' : 'All controlled checks completed.',
        testRepairResult: {
          summary: failing ? 'Regression detected.' : 'All checks passed.',
          build: [{ name: 'build', passed: true }],
          tests: [{ name: 'unit', passed: !failing, detail: failing ? 'Expected assertion failed.' : undefined }],
          security: [{ name: 'security', passed: true }],
          regression: [{ name: 'regression', passed: true }],
          artifactReferences: ['sandbox://test-report/1'],
        },
      };
    },
    async verify() {
      counters.verify = (counters.verify ?? 0) + 1;
      return { verified: true, evidence: [evidence('test-repair-verification')], summary: 'Independent runner report verified.' };
    },
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
  kernel.register(new AutonomousTestRepairModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  loop = kernel.getModule<AutonomousTestRepairModule>('autonomous-test-repair').getLoop();
  await control.createPolicy(admin, {
    version: 'test-repair-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [TestRepairActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function run() {
  return loop.createRun(operator, {
    productId: 'product-1', ventureId: 'venture-1',
    request: { profile: 'node-workspace', target: 'sandbox://repository/1', requiredChecks: ['build', 'unit', 'security', 'regression'] },
    maxAttempts: 2,
  });
}

async function decision() {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', ventureId: 'venture-1', objective: 'Validate a bounded engineering change.',
    proposedAction: 'Run the approved sandbox test profile.', actionType: TestRepairActionType,
    evidence: [evidence()], evidenceStrength: 85, riskScore: 20, complianceScore: 95, confidence: 80, authorizationLevel: 2,
    decisionReason: 'The local test profile is allowlisted through an injected runner.',
    provenance: { source: 'test-repair-test', collectedAt: now, correlationId: 'test-repair-correlation' },
  });
}

describe('Autonomous test/repair loop', () => {
  it('requires an explicitly registered profile-capable runner', async () => {
    const created = await run();
    await assert.rejects(() => loop.assignWorker(operator, created.id, 'missing'), TestRepairError);
    loop.registerWorker(admin, worker({}));
    const assigned = await loop.assignWorker(operator, created.id, 'runner-1');
    assert.equal(assigned.state, 'QUEUED');
  });

  it('runs a bounded profile through action authorization and requires verification', async () => {
    const counters: Record<string, number> = {};
    loop.registerWorker(admin, worker(counters));
    const created = await run();
    await loop.assignWorker(operator, created.id, 'runner-1');
    const proposed = await decision();
    const executed = await loop.executeRun(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'test-run-1', dryRun: false });
    assert.equal(executed.state, 'VERIFYING');
    assert.equal(counters.execute, 1);
    const verified = await loop.verifyRun(operator, created.id);
    assert.equal(verified.state, 'VERIFIED');
    assert.equal(verified.verificationEvidence.length, 1);
    assert.equal(counters.verify, 1);
  });

  it('never invokes the runner for the default dry-run path', async () => {
    const counters: Record<string, number> = {};
    loop.registerWorker(admin, worker(counters));
    const created = await run();
    await loop.assignWorker(operator, created.id, 'runner-1');
    const proposed = await decision();
    const executed = await loop.executeRun(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'test-run-dry' });
    assert.equal(executed.state, 'VERIFYING');
    assert.equal(counters.execute ?? 0, 0);
  });

  it('records failed checks as diagnostics and proposes but never applies a repair', async () => {
    loop.registerWorker(admin, worker({}, true));
    const created = await run();
    await loop.assignWorker(operator, created.id, 'failing-runner');
    const proposed = await decision();
    const failed = await loop.executeRun(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'test-run-fail', dryRun: false });
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.diagnostics.length, 1);

    const proposal = await loop.proposeRepair(operator, created.id, {
      patchReference: 'sandbox://patch/proposed-1', summary: 'Correct the regression assertion.', risk: 'LOW',
      testPlan: ['unit', 'regression'], evidence: [evidence('repair-proposal-evidence')],
    });
    assert.equal(proposal.state, 'PATCH_PROPOSED');
    assert.equal(proposal.proposals[0]?.appliedAt, undefined);
    await assert.rejects(() => loop.queuePatchValidation(operator, created.id), /requires external approval/);
  });

  it('keeps run records tenant-isolated', async () => {
    const created = await run();
    assert.equal(await loop.getRun(other, created.id), undefined);
    assert.equal((await loop.listRuns(other)).length, 0);
  });
});
