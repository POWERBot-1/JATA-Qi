import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialControlPlaneService,
  type CommercialEvidence,
} from '@jataqi/commercial-control-plane';
import {
  ActionRuntimeError,
  AutonomousActionRuntimeModule,
  type ActionExecutionAdapter,
  type ActionRuntimeService,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let otherTenant: CommercialActor;
let control: CommercialControlPlaneService;
let runtime: ActionRuntimeService;

function evidence(id = 'evidence-1'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'runtime-test',
    observedAt: now,
    confidence: 90,
    summary: 'Controlled test evidence.',
    provenance: { source: 'runtime-test', collectedAt: now, correlationId: 'runtime-corr' },
  };
}

function adapter(overrides: Partial<ActionExecutionAdapter> = {}): ActionExecutionAdapter {
  return {
    id: 'sandbox-adapter',
    targetSystem: 'sandbox-provider',
    actionTypes: ['PUBLISH_CONTENT'],
    environment: 'sandbox',
    maxAttempts: 3,
    defaultTimeoutMs: 100,
    async execute() {
      return {
        reportedSuccess: true,
        summary: 'Sandbox provider accepted request.',
        externalResponse: { requestId: 'sandbox-1' },
      };
    },
    async verify() {
      return {
        verified: true,
        evidence: [evidence('verify-1')],
        summary: 'Sandbox state independently verified.',
      };
    },
    async rollback() {
      return { confirmed: true, summary: 'Sandbox rollback independently verified.' };
    },
    ...overrides,
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  otherTenant = { id: 'other', tenantId: 'other', roles: ['operator'] };

  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AutonomousActionRuntimeModule());
  await kernel.boot();

  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  await control.createPolicy(admin, {
    version: 'runtime-test-policy',
    scope: { tenantId: 'acme' },
    maximumAutonomyLevel: 4,
    allowExecution: true,
    allowedActionTypes: ['PUBLISH_CONTENT'],
    maximumRiskScore: 80,
    minimumComplianceScore: 80,
    minimumEvidenceStrength: 70,
  });
  runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
});

async function decision() {
  return control.proposeDecision(operator, {
    tenantId: 'acme',
    productId: 'product-1',
    ventureId: 'venture-1',
    objective: 'Publish a verified announcement.',
    proposedAction: 'Publish the approved announcement.',
    actionType: 'PUBLISH_CONTENT',
    estimatedCost: { amount: 5, currency: 'KES' },
    evidence: [evidence()],
    evidenceStrength: 85,
    riskScore: 20,
    complianceScore: 95,
    confidence: 80,
    authorizationLevel: 3,
    decisionReason: 'Bounded sandbox delivery is supported by measured evidence.',
    provenance: { source: 'runtime-test', collectedAt: now, correlationId: 'runtime-corr' },
  });
}

describe('Autonomous Action Runtime', () => {
  it('requires an explicit adapter capability before an action can be planned', async () => {
    const proposed = await decision();
    await assert.rejects(
      () => runtime.plan(operator, proposed.id, {
        targetSystem: 'sandbox-provider',
        idempotencyKey: 'no-adapter',
        dryRun: false,
      }),
      ActionRuntimeError,
    );
  });

  it('delegates authorization and completes only after independent adapter verification', async () => {
    runtime.registerAdapter(adapter());
    const proposed = await decision();
    const planned = await runtime.plan(operator, proposed.id, {
      targetSystem: 'sandbox-provider',
      idempotencyKey: 'real-action-1',
      dryRun: false,
      rollbackStrategy: 'remove the sandbox publication',
    });
    const executed = await runtime.execute(operator, planned.id);
    assert.equal(executed.executedExternally, true);
    assert.equal(executed.action.executionStatus, 'VERIFYING');

    const verified = await runtime.verify(operator, planned.id);
    assert.equal(verified.executionStatus, 'COMPLETED');
    assert.equal(verified.verificationStatus, 'VERIFIED');

    const rolledBack = await runtime.rollback(operator, planned.id);
    assert.equal(rolledBack.executionStatus, 'ROLLED_BACK');
    assert.equal(rolledBack.rollbackStatus, 'VERIFIED');
    assert.equal((await control.verifyLedgerIntegrity(operator)).valid, true);
  });

  it('never invokes an adapter for a dry-run action and labels the result as simulated', async () => {
    let calls = 0;
    runtime.registerAdapter(adapter({
      async execute() {
        calls++;
        return { reportedSuccess: true };
      },
    }));
    const proposed = await decision();
    const planned = await runtime.plan(operator, proposed.id, {
      targetSystem: 'sandbox-provider',
      idempotencyKey: 'dry-run-1',
    });
    assert.equal(planned.dryRun, true);
    const executed = await runtime.execute(operator, planned.id);
    assert.equal(calls, 0);
    assert.equal(executed.executedExternally, false);
    assert.equal(executed.action.executionStatus, 'VERIFYING');
    assert.equal(executed.action.result?.externalResponse?.mode, 'SIMULATED');
  });

  it('bounds retries and leaves a failed action observable when all attempts fail', async () => {
    let calls = 0;
    runtime.registerAdapter(adapter({
      maxAttempts: 2,
      async execute() {
        calls++;
        throw new Error('transient connector failure');
      },
    }));
    const proposed = await decision();
    const planned = await runtime.plan(operator, proposed.id, {
      targetSystem: 'sandbox-provider',
      idempotencyKey: 'retry-1',
      dryRun: false,
    });
    const executed = await runtime.execute(operator, planned.id, { maxAttempts: 5 });
    assert.equal(calls, 2);
    assert.equal(executed.attempts, 2);
    assert.equal(executed.action.executionStatus, 'FAILED');
    assert.match(executed.action.error ?? '', /transient connector failure/);
  });

  it('turns timeouts into observable failures and preserves tenant isolation', async () => {
    runtime.registerAdapter(adapter({
      defaultTimeoutMs: 5,
      async execute(context) {
        return new Promise((resolve) => {
          context.signal.addEventListener('abort', () => resolve({
            reportedSuccess: false,
            summary: 'adapter observed abort',
          }));
        });
      },
    }));
    const proposed = await decision();
    const planned = await runtime.plan(operator, proposed.id, {
      targetSystem: 'sandbox-provider',
      idempotencyKey: 'timeout-1',
      dryRun: false,
    });
    const executed = await runtime.execute(operator, planned.id, { timeoutMs: 5 });
    assert.equal(executed.action.executionStatus, 'FAILED');
    assert.match(executed.action.error ?? '', /timed out/);
    assert.equal(await runtime.getAction(otherTenant, planned.id), undefined);
  });
});
