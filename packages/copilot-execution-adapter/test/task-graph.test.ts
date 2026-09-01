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
  CodingAgentActionType,
  CodingAgentExecutionError,
  CopilotExecutionAdapterModule,
  type CodingAgentTaskGraph,
  type CodingAgentWorker,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let graph: CodingAgentTaskGraph;

function evidence(id = 'engineering-evidence'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'engineering-task-test',
    observedAt: now,
    confidence: 90,
    summary: 'Controlled engineering task evidence.',
    provenance: { source: 'engineering-task-test', collectedAt: now, correlationId: 'engineering-correlation' },
  };
}

function worker(counters: Record<string, number>, overrides: Partial<CodingAgentWorker> = {}): CodingAgentWorker {
  return {
    id: 'worker-1',
    capabilities: ['typescript', 'testing'],
    environment: 'sandbox',
    maxAttempts: 2,
    defaultTimeoutMs: 100,
    async execute() {
      counters.execute = (counters.execute ?? 0) + 1;
      return {
        reportedSuccess: true,
        summary: 'Worker completed its bounded sandbox task.',
        taskResult: {
          summary: 'Implemented bounded task.',
          artifactReferences: ['sandbox://artifact/1'],
          testResults: [{ name: 'unit-test', passed: true }],
          patchReference: 'sandbox://patch/1',
        },
      };
    },
    async verify() {
      counters.verify = (counters.verify ?? 0) + 1;
      return { verified: true, evidence: [evidence('engineering-verification')], summary: 'Independent task checks passed.' };
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
  kernel.register(new CopilotExecutionAdapterModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  graph = kernel.getModule<CopilotExecutionAdapterModule>('copilot-execution-adapter').getTaskGraph();
  await control.createPolicy(admin, {
    version: 'engineering-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [CodingAgentActionType], maximumRiskScore: 70, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function task(overrides: Record<string, unknown> = {}) {
  return graph.createTask(operator, {
    ventureId: 'venture-1', productId: 'product-1', title: 'Implement bounded feature', description: 'Add a tested, isolated feature.',
    taskType: 'feature', priority: 10, estimatedComplexity: 3, requiredCapabilities: ['typescript', 'testing'],
    testRequirements: ['unit test'], completionCriteria: ['tests pass'], ...overrides,
  } as Parameters<typeof graph.createTask>[1]);
}

async function decision() {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', ventureId: 'venture-1', objective: 'Execute a bounded engineering task.',
    proposedAction: 'Run assigned coding worker in the sandbox.', actionType: CodingAgentActionType,
    evidence: [evidence()], evidenceStrength: 85, riskScore: 20, complianceScore: 95, confidence: 82,
    authorizationLevel: 2, decisionReason: 'Task graph and policy authorize a bounded sandbox worker.',
    provenance: { source: 'engineering-task-test', collectedAt: now, correlationId: 'engineering-correlation' },
  });
}

describe('Coding-agent task graph', () => {
  it('persists explicit task dependencies and only exposes a task as runnable after completion', async () => {
    const counters: Record<string, number> = {};
    graph.registerWorker(admin, worker(counters));
    const parent = await task({ title: 'Build shared contract' });
    const child = await task({ title: 'Build dependent feature', dependencies: [parent.id] });

    const blocked = await graph.queueTask(operator, child.id);
    assert.equal(blocked.status, 'BLOCKED');
    const readyParent = await graph.queueTask(operator, parent.id);
    await graph.assignTask(operator, readyParent.id, 'worker-1');
    const parentDecision = await decision();
    const running = await graph.executeTask(operator, parent.id, { decisionId: parentDecision.id, idempotencyKey: 'parent-task', dryRun: false });
    assert.equal(running.status, 'VERIFYING');
    const complete = await graph.verifyTask(operator, parent.id);
    assert.equal(complete.status, 'COMPLETED');

    const readyChild = await graph.queueTask(operator, child.id);
    assert.equal(readyChild.status, 'READY');
    assert.deepEqual((await graph.runnable(operator)).map((item) => item.id), [child.id]);
  });

  it('requires a capable, explicitly registered worker before assignment and execution', async () => {
    const created = await task();
    await graph.queueTask(operator, created.id);
    await assert.rejects(() => graph.assignTask(operator, created.id, 'missing-worker'), CodingAgentExecutionError);

    graph.registerWorker(admin, worker({}, { id: 'limited-worker', capabilities: ['typescript'] }));
    await assert.rejects(() => graph.assignTask(operator, created.id, 'limited-worker'), /lacks required capabilities/);
  });

  it('routes worker execution through commercial authorization and requires verification to complete', async () => {
    const counters: Record<string, number> = {};
    graph.registerWorker(admin, worker(counters));
    const created = await task();
    await graph.queueTask(operator, created.id);
    await graph.assignTask(operator, created.id, 'worker-1');
    const proposed = await decision();

    const executing = await graph.executeTask(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'task-1', dryRun: false });
    assert.equal(executing.status, 'VERIFYING');
    assert.equal(counters.execute, 1);
    assert.equal(executing.result?.patchReference, 'sandbox://patch/1');

    const completed = await graph.verifyTask(operator, created.id);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(counters.verify, 1);
    assert.equal(completed.verificationEvidence.length, 1);
  });

  it('uses dry-run by default and does not invoke the coding worker', async () => {
    const counters: Record<string, number> = {};
    graph.registerWorker(admin, worker(counters));
    const created = await task();
    await graph.queueTask(operator, created.id);
    await graph.assignTask(operator, created.id, 'worker-1');
    const proposed = await decision();
    const result = await graph.executeTask(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'dry-task' });
    assert.equal(result.status, 'VERIFYING');
    assert.equal(counters.execute ?? 0, 0);
  });

  it('bounds worker retries and enforces tenant isolation', async () => {
    let calls = 0;
    graph.registerWorker(admin, worker({}, {
      async execute() { calls++; throw new Error('sandbox worker failure'); },
    }));
    const created = await task({ maxAttempts: 2 });
    await graph.queueTask(operator, created.id);
    await graph.assignTask(operator, created.id, 'worker-1');
    const proposed = await decision();
    const failed = await graph.executeTask(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'failure-task', dryRun: false });
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.attemptCount, 2);
    assert.equal(calls, 2);
    await assert.rejects(() => graph.retryTask(operator, created.id), /retry limit/);
    assert.equal(await graph.getTask(other, created.id), undefined);
  });
});
