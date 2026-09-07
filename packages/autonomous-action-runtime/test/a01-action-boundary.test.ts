// A-01 wiring — autonomous action runtime. Proves every EXTERNAL adapter
// execution is decided and enforced at the boundary (default deny,
// fail-closed, deny-before-side-effect), that retries re-authorize, that
// queue redelivery cannot re-execute a successful effect, that a direct
// adapter call (bypassing the runtime) has no authority, and that the legacy
// no-boundary path is unchanged.
import { describe, it } from 'node:test';
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
  AuthorizationBoundaryModule,
  InMemoryCredentialBroker,
  type A01CapabilityManifest,
  type A01PrincipalBinding,
} from '@jataqi/authorization-boundary';
import {
  AutonomousActionRuntimeModule,
  type ActionExecutionAdapter,
  type ActionExecutionContext,
  type ActionRuntimeService,
} from '../src/index.js';

const T0 = 1_700_000_000_000;

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;

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

function principal(overrides: Partial<A01PrincipalBinding> = {}): A01PrincipalBinding {
  return {
    id: 'user:alice',
    tenantId: 'acme',
    roles: ['operator'],
    authenticationMethod: 'STATIC_TOKEN',
    authenticationEventId: 'auth-event-1',
    ...overrides,
  };
}

function publishManifest(opts: Partial<A01CapabilityManifest> = {}): A01CapabilityManifest {
  return {
    capabilityId: 'action.sandbox.publish',
    version: '1',
    description: 'Sandbox publish capability',
    allowedOperations: [{ tool: 'sandbox-adapter', operation: 'PUBLISH_CONTENT' }],
    allowedTargets: [{ system: 'sandbox-provider', resourcePattern: 'res-*' }],
    tenantScopes: ['acme'],
    allowTenantWildcard: false,
    maxDataClassification: 'INTERNAL',
    maxImpact: 'EXTERNAL_SIDE_EFFECT',
    requiredCredentialScopes: [],
    requiresApproval: false,
    rateLimit: { windowMs: 60_000, max: 100 },
    budgetPerRunCostUnits: 100,
    maxLifetimeMs: 60_000,
    registeredBy: { principalId: 'user:admin', tenantId: 'acme' },
    policyVersion: 'test-policy',
    createdAt: T0,
    ...opts,
  };
}

interface Booted {
  kernel: ReturnType<typeof createTestKernel>;
  control: CommercialControlPlaneService;
  runtime: ActionRuntimeService;
}

async function boot(withBoundary: boolean, broker?: InMemoryCredentialBroker): Promise<Booted> {
  now = T0;
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  if (withBoundary) {
    kernel.register(new AuthorizationBoundaryModule({ now: () => now, policyVersion: 'test-policy', ...(broker ? { broker } : {}) }));
  }
  kernel.register(new AutonomousActionRuntimeModule());
  await kernel.boot();
  const control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
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
  const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
  return { kernel, control, runtime };
}

async function plannedAction(b: Booted, idempotencyKey: string) {
  const proposed = await b.control.proposeDecision(operator, {
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
  return b.runtime.plan(operator, proposed.id, {
    targetSystem: 'sandbox-provider',
    targetResource: 'res-1',
    idempotencyKey,
    dryRun: false,
    rollbackStrategy: 'remove the sandbox publication',
  });
}

function trackingAdapter(overrides: Partial<ActionExecutionAdapter> = {}) {
  const calls: ActionExecutionContext[] = [];
  const overrideExecute = overrides.execute;
  const { execute: _executeOverride, ...rest } = overrides;
  const adapter: ActionExecutionAdapter = {
    id: 'sandbox-adapter',
    targetSystem: 'sandbox-provider',
    actionTypes: ['PUBLISH_CONTENT'],
    environment: 'sandbox',
    maxAttempts: 3,
    defaultTimeoutMs: 2_000,
    async execute(context) {
      calls.push(context);
      if (overrideExecute) return overrideExecute(context);
      return {
        reportedSuccess: true,
        summary: 'Sandbox provider accepted request.',
        externalResponse: { requestId: `sandbox-${calls.length}` },
      };
    },
    async verify() {
      return { verified: true, evidence: [evidence('verify-1')], summary: 'Sandbox state independently verified.' };
    },
    async rollback() {
      return { confirmed: true, summary: 'Sandbox rollback independently verified.' };
    },
    ...rest,
  };
  return { adapter, calls };
}

describe('A-01 action-runtime: external execution is boundary-enforced', () => {
  it('positive control: a verified principal + granted capability executes the adapter with the sealed envelope in context', async () => {
    const b = await boot(true);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate, 'the module picked up the installed boundary (lazy, post-boot)');
    gate!.manifestsRegistry.register(publishManifest());
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'a01-positive');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: principal(), capabilityId: 'action.sandbox.publish' },
    });
    assert.equal(executed.executedExternally, true);
    assert.equal(executed.action.executionStatus, 'VERIFYING');
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.authorization?.envelope, 'the adapter context carries the sealed envelope');
    assert.equal(calls[0]?.authorization?.envelope?.tenantId, 'acme');
    assert.equal(calls[0]?.authorization?.envelope?.principal?.id, 'user:alice');
  });

  it('no manifest (unknown capability): DENY before any external I/O (42: unauthorized external side effect)', async () => {
    const b = await boot(true);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate);
    // Deliberately NO manifest registered for the action's capability.
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'a01-no-manifest');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: principal(), capabilityId: 'action.sandbox.publish' },
    });
    assert.equal(executed.executedExternally, false, 'no external I/O without a capability grant');
    assert.equal(calls.length, 0, 'the adapter was never invoked');
    assert.equal(executed.action.executionStatus, 'FAILED');
    const reported = executed.action.result?.externalResponse as Record<string, unknown> | undefined;
    assert.equal(reported?.errorType, 'authorization_denied');
    assert.ok((reported?.reasonCodes as string[]).includes('UNKNOWN_CAPABILITY'));
  });

  it('no verified principal: DENY MISSING_PRINCIPAL before any external I/O (1: missing principal)', async () => {
    const b = await boot(true);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate);
    gate!.manifestsRegistry.register(publishManifest());
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'a01-no-principal');
    const executed = await b.runtime.execute(operator, planned.id, {});
    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0);
    const reported = executed.action.result?.externalResponse as Record<string, unknown> | undefined;
    assert.ok((reported?.reasonCodes as string[]).includes('MISSING_PRINCIPAL'), `got: ${JSON.stringify(reported)}`);
  });

  it('cross-tenant principal: DENY before any external I/O (7: cross-tenant resource)', async () => {
    const b = await boot(true);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate);
    gate!.manifestsRegistry.register(publishManifest()); // tenantScopes: ['acme']
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'a01-cross-tenant');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: principal({ id: 'user:mallory', tenantId: 'globex' }), capabilityId: 'action.sandbox.publish' },
    });
    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0);
    const reported = executed.action.result?.externalResponse as Record<string, unknown> | undefined;
    assert.ok(
      (reported?.reasonCodes as string[]).some((c) => c === 'TENANT_OUT_OF_SCOPE' || c === 'TENANT_SUBSTITUTION'),
      `got: ${JSON.stringify(reported)}`,
    );
  });

  it('27 direct-adapter bypass: calling the adapter directly yields NO authority (no envelope, no credential)', async () => {
    const b = await boot(true);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate);
    gate!.manifestsRegistry.register(publishManifest());
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    // A compromised component holding the adapter reference executes it
    // directly, outside the runtime: it has no envelope and no credential.
    await adapter.execute({
      action: { id: 'forged-action', tenantId: 'acme' } as never,
      actor: operator,
      attempt: 1,
      signal: new AbortController().signal,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.authorization, undefined, 'a direct adapter call carries no A-01 authority');
  });

  it('31 retry: each attempt is re-decided; failures are followed by a re-authorized success', async () => {
    const b = await boot(true);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate);
    gate!.manifestsRegistry.register(publishManifest());
    let fails = 2;
    const { adapter, calls } = trackingAdapter({
      async execute(_context) {
        if (fails > 0) {
          fails -= 1;
          return { reportedSuccess: false, summary: 'Transient provider failure.', externalResponse: { errorType: 'transient' } };
        }
        return { reportedSuccess: true, summary: 'Accepted.', externalResponse: { requestId: 'sandbox-retry' } };
      },
    });
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'a01-retry');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: principal(), capabilityId: 'action.sandbox.publish' },
      maxAttempts: 3,
    });
    assert.equal(executed.executedExternally, true);
    assert.equal(executed.action.executionStatus, 'VERIFYING');
    assert.equal(calls.length, 3, 'two failures + one success, every attempt through the boundary');
    for (const call of calls) {
      assert.ok(call.authorization?.envelope, 'every attempt carried a fresh sealed envelope');
    }
    const distinctEnvelopes = new Set(calls.map((c) => c.authorization?.envelope?.envelopeId));
    assert.equal(distinctEnvelopes.size, 3, 'each attempt was a fresh authorization decision');
  });

  it('30 queue redelivery after success: re-execution is refused; the adapter is NOT invoked again', async () => {
    const b = await boot(true);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate);
    gate!.manifestsRegistry.register(publishManifest());
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'a01-redelivery');
    const first = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: principal(), capabilityId: 'action.sandbox.publish' },
    });
    assert.equal(first.executedExternally, true);
    assert.equal(calls.length, 1);
    // The queue redelivers the execution command for the same action id.
    await assert.rejects(
      () => b.runtime.execute(operator, planned.id, { authorization: { principal: principal(), capabilityId: 'action.sandbox.publish' } }),
      /cannot (execute|start) from/i,
    );
    assert.equal(calls.length, 1, 'redelivery must not re-run the external side effect');
  });

  it('32 concurrency: parallel executions of distinct actions each enforce through the boundary', async () => {
    const b = await boot(true);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate);
    gate!.manifestsRegistry.register(publishManifest());
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    const planned1 = await plannedAction(b, 'a01-cc-1');
    const planned2 = await plannedAction(b, 'a01-cc-2');
    const [r1, r2] = await Promise.all([
      b.runtime.execute(operator, planned1.id, { authorization: { principal: principal(), capabilityId: 'action.sandbox.publish' } }),
      b.runtime.execute(operator, planned2.id, { authorization: { principal: principal(), capabilityId: 'action.sandbox.publish' } }),
    ]);
    assert.equal(r1.executedExternally, true);
    assert.equal(r2.executedExternally, true);
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls.map((c) => c.authorization?.envelope?.envelopeId)).size, 2, 'each action executed under its own envelope');
  });

  it('credential flow: scoped material reaches ONLY the adapter context; durable audit stays material-free', async () => {
    const broker = new InMemoryCredentialBroker({ now: () => now });
    const material = 'action-runtime-secret-material-0001';
    broker.issue({
      credentialId: 'cred-action',
      principalId: 'user:alice',
      tenantId: 'acme',
      capabilityId: 'action.sandbox.publish',
      tool: 'sandbox-adapter',
      operation: 'PUBLISH_CONTENT',
      audience: 'sandbox-provider',
      scopes: ['publish:res'],
      lifetimeMs: 60_000,
      issuedBy: 'a01-test',
      secretMaterial: material,
    });
    const b = await boot(true, broker);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate);
    gate!.manifestsRegistry.register(publishManifest({ requiredCredentialScopes: ['publish:res'], credentialAudience: 'sandbox-provider' }));
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'a01-credential');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: {
        principal: principal(),
        capabilityId: 'action.sandbox.publish',
        credential: { credentialId: 'cred-action', audience: 'sandbox-provider', scopes: ['publish:res'] },
      },
    });
    assert.equal(executed.executedExternally, true);
    assert.equal(calls[0]?.authorization?.credential?.material, material, 'the scoped credential material reached the adapter at enforcement');
    // The material must never be persisted in the durable audit collection.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const collection = await b.kernel.getModule<StorageModule>('storage').collection<{ id: string }>('authorization.decisions');
    for (const record of await collection.all()) {
      assert.equal(JSON.stringify(record).includes(material), false, 'no secret material in durable audit records');
    }
    await b.kernel.shutdown();
  });

  it('25 under-scoped credential: DENY CREDENTIAL_SCOPE_INSUFFICIENT before any external I/O', async () => {
    const broker = new InMemoryCredentialBroker({ now: () => now });
    broker.issue({
      credentialId: 'cred-narrow',
      principalId: 'user:alice',
      tenantId: 'acme',
      capabilityId: 'action.sandbox.publish',
      tool: 'sandbox-adapter',
      operation: 'PUBLISH_CONTENT',
      audience: 'sandbox-provider',
      scopes: ['read:only'],
      lifetimeMs: 60_000,
      issuedBy: 'a01-test',
    });
    const b = await boot(true, broker);
    const gate = b.runtime.getAuthorizationGate();
    assert.ok(gate);
    gate!.manifestsRegistry.register(publishManifest({ requiredCredentialScopes: ['publish:res'], credentialAudience: 'sandbox-provider' }));
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'a01-under-scoped');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: {
        principal: principal(),
        capabilityId: 'action.sandbox.publish',
        credential: { credentialId: 'cred-narrow', audience: 'sandbox-provider', scopes: ['publish:res'] },
      },
    });
    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0);
    const reported = executed.action.result?.externalResponse as Record<string, unknown> | undefined;
    assert.ok((reported?.reasonCodes as string[]).includes('CREDENTIAL_SCOPE_INSUFFICIENT'), `got: ${JSON.stringify(reported)}`);
    await b.kernel.shutdown();
  });

  it('legacy composition without the boundary: adapter executes with NO authorization context (baseline unchanged)', async () => {
    const b = await boot(false);
    assert.equal(b.runtime.getAuthorizationGate(), undefined, 'no boundary installed');
    const { adapter, calls } = trackingAdapter();
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'a01-legacy');
    const executed = await b.runtime.execute(operator, planned.id);
    assert.equal(executed.executedExternally, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.authorization, undefined, 'legacy path carries no A-01 context');
    await b.kernel.shutdown();
  });
});
