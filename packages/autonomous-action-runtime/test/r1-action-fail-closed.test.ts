// R1 ADVERSARIAL SUITE — autonomous action execution fails closed.
//
// INVARIANTS: B (absence = DENY), C, D, E, F, G, H, I (deny before side
// effect), N (autonomous actions cannot execute without authorization).
//
// Every case asserts at the ACTUAL SIDE-EFFECT BOUNDARY: the adapter records
// each invocation, and a denial is only accepted as proven when the adapter
// invocation count is zero. Asserting a returned error is NOT sufficient.

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
  testCapabilityManifest,
  testPrincipal,
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
const CAP = 'action.sandbox.publish';

let now = T0;
let admin: CommercialActor;
let operator: CommercialActor;

function evidence(id = 'evidence-1'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'r1-test',
    observedAt: now,
    confidence: 90,
    summary: 'Controlled R1 test evidence.',
    provenance: { source: 'r1-test', collectedAt: now, correlationId: 'r1-corr' },
  };
}

function manifest(): A01CapabilityManifest {
  return testCapabilityManifest({
    capabilityId: CAP,
    operations: [{ tool: 'sandbox-adapter', operation: 'PUBLISH_CONTENT' }],
    targets: [{ system: 'sandbox-provider', resourcePattern: 'res-*' }],
    tenantScopes: ['acme'],
    policyVersion: 'test-policy',
    createdAt: T0,
  });
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
    kernel.register(
      new AuthorizationBoundaryModule({ now: () => now, policyVersion: 'test-policy', ...(broker ? { broker } : {}) }),
    );
  }
  kernel.register(new AutonomousActionRuntimeModule());
  await kernel.boot();
  const control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  await control.createPolicy(admin, {
    version: 'r1-policy',
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
    decisionReason: 'Bounded sandbox delivery supported by measured evidence.',
    provenance: { source: 'r1-test', collectedAt: now, correlationId: 'r1-corr' },
  });
  return b.runtime.plan(operator, proposed.id, {
    targetSystem: 'sandbox-provider',
    targetResource: 'res-1',
    idempotencyKey,
    dryRun: false,
    rollbackStrategy: 'remove the sandbox publication',
  });
}

/** The side-effect probe: `calls` MUST stay empty for every denial. */
function probeAdapter() {
  const calls: ActionExecutionContext[] = [];
  const adapter: ActionExecutionAdapter = {
    id: 'sandbox-adapter',
    targetSystem: 'sandbox-provider',
    actionTypes: ['PUBLISH_CONTENT'],
    environment: 'sandbox',
    maxAttempts: 1,
    defaultTimeoutMs: 2_000,
    async execute(context) {
      calls.push(context);
      return { reportedSuccess: true, summary: 'external effect performed', externalResponse: { requestId: 'x' } };
    },
    async verify() {
      return { verified: true, evidence: [evidence('verify-1')], summary: 'verified' };
    },
    async rollback() {
      return { confirmed: true, summary: 'rolled back' };
    },
  };
  return { adapter, calls };
}

describe('R1 INVARIANT B/N — autonomous action runtime without an authoritative boundary', () => {
  it('DENIES and never invokes adapter.execute()', async () => {
    const b = await boot(false);
    assert.equal(b.runtime.getAuthorizationGate(), undefined, 'precondition: no boundary');
    const { adapter, calls } = probeAdapter();
    b.runtime.registerAdapter(adapter);
    const planned = await plannedAction(b, 'r1-absent');

    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }), capabilityId: CAP },
    });

    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0, 'INVARIANT I VIOLATED — the adapter was invoked with no boundary');
    const reported = executed.action.result?.externalResponse as Record<string, unknown> | undefined;
    assert.equal(reported?.errorType, 'authorization_denied');
    await b.kernel.shutdown();
  });
});

describe('R1 INVARIANTS C–H/N — adversarial denials at the action side-effect boundary', () => {
  async function denyCase(
    label: string,
    configure: (b: Booted) => void | Promise<void>,
    options: Parameters<ActionRuntimeService['execute']>[2],
    key: string,
    expectReason?: string,
  ): Promise<void> {
    const b = await boot(true);
    const { adapter, calls } = probeAdapter();
    b.runtime.registerAdapter(adapter);
    await configure(b);
    const planned = await plannedAction(b, key);
    const executed = await b.runtime.execute(operator, planned.id, options);

    assert.equal(executed.executedExternally, false, `${label}: no external effect may be reported`);
    assert.equal(calls.length, 0, `${label}: INVARIANT I VIOLATED — adapter.execute() ran despite denial`);
    const reported = executed.action.result?.externalResponse as Record<string, unknown> | undefined;
    assert.equal(reported?.errorType, 'authorization_denied', `${label}: expected an authorization denial`);
    if (expectReason) {
      assert.ok(
        (reported?.reasonCodes as string[] | undefined)?.includes(expectReason),
        `${label}: expected reason ${expectReason}, got ${JSON.stringify(reported?.reasonCodes)}`,
      );
    }
    await b.kernel.shutdown();
  }

  it('INVARIANT C — missing principal', async () => {
    await denyCase(
      'missing principal',
      (b) => {
        b.runtime.getAuthorizationGate()!.manifestsRegistry.register(manifest());
      },
      {},
      'r1-missing-principal',
      'MISSING_PRINCIPAL',
    );
  });

  it('INVARIANT C — forged principal (unrecognized authentication method)', async () => {
    const forged = {
      id: 'user:mallory',
      tenantId: 'acme',
      roles: [],
      authenticationMethod: 'SELF_ASSERTED',
      authenticationEventId: 'nope',
    } as unknown as A01PrincipalBinding;
    await denyCase(
      'forged principal',
      (b) => {
        b.runtime.getAuthorizationGate()!.manifestsRegistry.register(manifest());
      },
      { authorization: { principal: forged, capabilityId: CAP } },
      'r1-forged-principal',
      'FORGED_PRINCIPAL',
    );
  });

  it('INVARIANT D — missing capability (no manifest registered)', async () => {
    await denyCase(
      'missing capability',
      () => {},
      { authorization: { principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }), capabilityId: CAP } },
      'r1-missing-capability',
      'UNKNOWN_CAPABILITY',
    );
  });

  it('INVARIANT E — tenant mismatch (principal from another tenant)', async () => {
    await denyCase(
      'tenant mismatch',
      (b) => {
        b.runtime.getAuthorizationGate()!.manifestsRegistry.register(manifest());
      },
      {
        authorization: { principal: testPrincipal({ id: 'user:bob', tenantId: 'evilcorp' }), capabilityId: CAP },
      },
      'r1-tenant-mismatch',
    );
  });

  it('INVARIANT F — malformed authorization request (blank capability id)', async () => {
    await denyCase(
      'malformed request',
      (b) => {
        b.runtime.getAuthorizationGate()!.manifestsRegistry.register(manifest());
      },
      { authorization: { principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }), capabilityId: '   ' } },
      'r1-malformed',
    );
  });

  it('INVARIANT D — policy denial: the capability grants a different operation only', async () => {
    await denyCase(
      'policy denial',
      (b) => {
        b.runtime.getAuthorizationGate()!.manifestsRegistry.register(
          testCapabilityManifest({
            capabilityId: CAP,
            operations: [{ tool: 'sandbox-adapter', operation: 'ARCHIVE_CONTENT' }],
            targets: [{ system: 'sandbox-provider', resourcePattern: 'res-*' }],
            tenantScopes: ['acme'],
            policyVersion: 'test-policy',
            createdAt: T0,
          }),
        );
      },
      { authorization: { principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }), capabilityId: CAP } },
      'r1-op-denied',
      'OPERATION_NOT_ALLOWED',
    );
  });

  it('INVARIANT D — target substitution: the resource is outside the manifest pattern', async () => {
    await denyCase(
      'target substitution',
      (b) => {
        b.runtime.getAuthorizationGate()!.manifestsRegistry.register(
          testCapabilityManifest({
            capabilityId: CAP,
            operations: [{ tool: 'sandbox-adapter', operation: 'PUBLISH_CONTENT' }],
            targets: [{ system: 'sandbox-provider', resourcePattern: 'only-this-one' }],
            tenantScopes: ['acme'],
            policyVersion: 'test-policy',
            createdAt: T0,
          }),
        );
      },
      { authorization: { principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }), capabilityId: CAP } },
      'r1-target-substitution',
      'TARGET_NOT_ALLOWED',
    );
  });

  it('INVARIANT D — credential mismatch: a required credential scope is not held', async () => {
    const broker = new InMemoryCredentialBroker();
    const b = await boot(true, broker);
    const { adapter, calls } = probeAdapter();
    b.runtime.registerAdapter(adapter);
    b.runtime.getAuthorizationGate()!.manifestsRegistry.register(
      testCapabilityManifest({
        capabilityId: CAP,
        operations: [{ tool: 'sandbox-adapter', operation: 'PUBLISH_CONTENT' }],
        targets: [{ system: 'sandbox-provider', resourcePattern: 'res-*' }],
        tenantScopes: ['acme'],
        requiredCredentialScopes: ['publish:write'],
        policyVersion: 'test-policy',
        createdAt: T0,
      }),
    );
    const planned = await plannedAction(b, 'r1-credential-mismatch');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }), capabilityId: CAP },
    });

    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0, 'INVARIANT I VIOLATED — adapter ran without a valid credential');
    await b.kernel.shutdown();
  });

  it('INVARIANT I — positive control: a fully legitimate authorization DOES reach the adapter exactly once', async () => {
    const b = await boot(true);
    const { adapter, calls } = probeAdapter();
    b.runtime.registerAdapter(adapter);
    b.runtime.getAuthorizationGate()!.manifestsRegistry.register(manifest());
    const planned = await plannedAction(b, 'r1-positive');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }), capabilityId: CAP },
    });

    assert.equal(executed.executedExternally, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.authorization?.envelope, 'the adapter received the sealed envelope');
    await b.kernel.shutdown();
  });
});
