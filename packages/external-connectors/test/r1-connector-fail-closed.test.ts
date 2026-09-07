// R1 ADVERSARIAL SUITE — external connectors fail closed.
//
// INVARIANTS: B (absence = DENY), C, D, E, I, M (external connectors cannot
// execute without authorization).
//
// The connector's `execute` is the real side-effect boundary here: every
// denial case asserts the provider function was NEVER entered.

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
  testCapabilityManifest,
  testPrincipal,
  type A01PrincipalBinding,
} from '@jataqi/authorization-boundary';
import {
  AutonomousActionRuntimeModule,
  type ActionExecutionContext,
  type ActionRuntimeService,
} from '@jataqi/autonomous-action-runtime';
import { ExternalConnectorModule, type ExternalConnector } from '../src/index.js';

const T0 = 1_700_000_000_000;
const CAP = 'connector.sandbox.publish';
let now = T0;
let admin: CommercialActor;
let operator: CommercialActor;

function evidence(id = 'evidence-1'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'r1-connector-test',
    observedAt: now,
    confidence: 90,
    summary: 'Controlled R1 evidence.',
    provenance: { source: 'r1-connector-test', collectedAt: now, correlationId: 'r1-conn' },
  };
}

interface Booted {
  kernel: ReturnType<typeof createTestKernel>;
  control: CommercialControlPlaneService;
  runtime: ActionRuntimeService;
  connectors: ReturnType<ExternalConnectorModule['getRegistry']>;
}

async function boot(withBoundary: boolean): Promise<Booted> {
  now = T0;
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  if (withBoundary) kernel.register(new AuthorizationBoundaryModule({ now: () => now, policyVersion: 'test-policy' }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new ExternalConnectorModule());
  await kernel.boot();
  const control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  await control.createPolicy(admin, {
    version: 'r1-connector-policy',
    scope: { tenantId: 'acme' },
    maximumAutonomyLevel: 4,
    allowExecution: true,
    allowedActionTypes: ['PUBLISH_CONTENT'],
    maximumRiskScore: 80,
    minimumComplianceScore: 80,
    minimumEvidenceStrength: 70,
  });
  return {
    kernel,
    control,
    runtime: kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService(),
    connectors: kernel.getModule<ExternalConnectorModule>('external-connectors').getRegistry(),
  };
}

/** Provider probe: `calls` MUST stay empty on every denial. */
function probeConnector(overrides: Partial<ExternalConnector> = {}) {
  const calls: ActionExecutionContext[] = [];
  const base: ExternalConnector = {
    id: 'sandbox-connector',
    providerId: 'sandbox-provider',
    providerType: 'sandbox',
    targetSystem: 'sandbox-provider',
    environment: 'sandbox',
    supportedActions: ['PUBLISH_CONTENT'],
    authenticationMethod: 'service-account',
    requiredPermissions: ['publish'],
    rollbackSupport: true,
    webhookSupport: false,
    sandboxSupport: true,
    productionSupport: false,
    credentialReference: 'secret://sandbox/test',
    capabilityId: CAP,
    capabilityVersion: '1',
    async health() {
      return { health: 'HEALTHY', observedAt: now };
    },
    async capabilities() {
      return {
        providerId: 'sandbox-provider',
        providerType: 'sandbox',
        supportedActions: ['PUBLISH_CONTENT'],
        authenticationMethod: 'service-account',
        requiredPermissions: ['publish'],
        rollbackSupport: true,
        webhookSupport: false,
        sandboxSupport: true,
        productionSupport: false,
      };
    },
    async execute(context) {
      calls.push(context);
      return { reportedSuccess: true, summary: 'external provider invoked', externalResponse: { requestId: 'r' } };
    },
    async verify() {
      return { verified: true, evidence: [evidence('verify-1')], summary: 'verified' };
    },
    async rollback() {
      return { confirmed: true, summary: 'rolled back' };
    },
  };
  return { connector: { ...base, ...overrides } as ExternalConnector, calls };
}

async function planPublish(b: Booted, idempotencyKey: string, targetResource = 'res-1') {
  const proposed = await b.control.proposeDecision(operator, {
    tenantId: 'acme',
    productId: 'product-1',
    ventureId: 'venture-1',
    objective: 'Publish through a connector.',
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
    provenance: { source: 'r1-connector-test', collectedAt: now, correlationId: 'r1-conn' },
  });
  return b.runtime.plan(operator, proposed.id, {
    targetSystem: 'sandbox-provider',
    targetResource,
    idempotencyKey,
    dryRun: false,
    rollbackStrategy: 'remove the publication',
  });
}

/**
 * Register the capability manifest. The executable adapter the registry
 * installs is named `connector:<registrationId>`, so the manifest's allowed
 * operations must be bound to that exact tool identity — no wildcard.
 */
function registerManifestForTool(b: Booted, tool: string, resourcePattern = 'res-*'): void {
  const gate = b.connectors.getAuthorizationGate();
  assert.ok(gate, 'precondition: boundary installed');
  gate!.manifestsRegistry.register(
    testCapabilityManifest({
      capabilityId: CAP,
      operations: [{ tool, operation: 'PUBLISH_CONTENT' }],
      targets: [{ system: 'sandbox-provider', resourcePattern }],
      tenantScopes: ['acme'],
      policyVersion: 'test-policy',
      createdAt: T0,
    }),
  );
}

function registerManifest(b: Booted, overrides: Parameters<typeof testCapabilityManifest>[0] | undefined = undefined): void {
  const gate = b.connectors.getAuthorizationGate();
  assert.ok(gate, 'precondition: boundary installed');
  gate!.manifestsRegistry.register(
    testCapabilityManifest(
      overrides ?? {
        capabilityId: CAP,
        operations: [{ tool: 'connector:sandbox-connector', operation: 'PUBLISH_CONTENT' }],
        targets: [{ system: 'sandbox-provider', resourcePattern: 'res-*' }],
        tenantScopes: ['acme'],
        policyVersion: 'test-policy',
        createdAt: T0,
      },
    ),
  );
}

describe('R1 INVARIANT B/M — external connectors without an authoritative boundary', () => {
  it('a connector cannot REGISTER, so it can never become executable', async () => {
    const b = await boot(false);
    assert.equal(b.connectors.getAuthorizationGate(), undefined, 'precondition: no boundary');
    const { connector, calls } = probeConnector();

    await assert.rejects(() => b.connectors.register(admin, connector), /AUTHORIZATION_BOUNDARY_ABSENT/);
    assert.equal(b.connectors.list(admin).length, 0, 'no registration exists');
    assert.equal(calls.length, 0, 'INVARIANT I: provider code was never reached');
    await b.kernel.shutdown();
  });

  it('a connector that declares a capability is ALSO refused without a boundary (no partial trust)', async () => {
    const b = await boot(false);
    const { connector, calls } = probeConnector({ capabilityId: CAP, capabilityVersion: '1' });
    await assert.rejects(() => b.connectors.register(admin, connector), /AUTHORIZATION_BOUNDARY_ABSENT/);
    assert.equal(calls.length, 0);
    await b.kernel.shutdown();
  });

  it('no runtime adapter is installed, so the action runtime has nothing to execute', async () => {
    const b = await boot(false);
    const { connector } = probeConnector();
    await assert.rejects(() => b.connectors.register(admin, connector), /AUTHORIZATION_BOUNDARY_ABSENT/);
    assert.equal(b.runtime.listAdapters().length, 0, 'no executable adapter exists');
    await b.kernel.shutdown();
  });
});

describe('R1 INVARIANTS C–E/M — adversarial connector denials at the provider boundary', () => {
  it('INVARIANT M — an UNBOUND connector is rejected at registration behind the boundary', async () => {
    const b = await boot(true);
    const { connector, calls } = probeConnector({ capabilityId: undefined as unknown as string });
    await assert.rejects(() => b.connectors.register(admin, connector), /UNBOUND_CONNECTOR/);
    assert.equal(calls.length, 0);
    await b.kernel.shutdown();
  });

  it('INVARIANT M — an OVER-PRIVILEGED connector (action outside the manifest) is rejected', async () => {
    const b = await boot(true);
    registerManifest(b);
    const { connector, calls } = probeConnector({ supportedActions: ['PUBLISH_CONTENT', 'DELETE_EVERYTHING'] });
    await assert.rejects(() => b.connectors.register(admin, connector), /OVER_PRIVILEGED_CONNECTOR/);
    assert.equal(calls.length, 0, 'provider code must be unreachable');
    await b.kernel.shutdown();
  });

  it('INVARIANT C — an activated connector still cannot execute without a valid principal', async () => {
    const b = await boot(true);
    registerManifest(b);
    const { connector, calls } = probeConnector();
    const registration = await b.connectors.register(admin, connector);
    await b.connectors.activate(admin, registration.id);
    const planned = await planPublish(b, 'r1-conn-no-principal');

    const executed = await b.runtime.execute(operator, planned.id, {});

    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0, 'INVARIANT I VIOLATED — provider executed with no principal');
    await b.kernel.shutdown();
  });

  it('INVARIANT C — a forged principal cannot reach the provider', async () => {
    const b = await boot(true);
    registerManifest(b);
    const { connector, calls } = probeConnector();
    const registration = await b.connectors.register(admin, connector);
    await b.connectors.activate(admin, registration.id);
    const planned = await planPublish(b, 'r1-conn-forged');

    const forged = {
      id: 'user:mallory',
      tenantId: 'acme',
      roles: [],
      authenticationMethod: 'SELF_ASSERTED',
      authenticationEventId: '',
    } as unknown as A01PrincipalBinding;
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: forged, capabilityId: CAP },
    });

    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0);
    await b.kernel.shutdown();
  });

  it('INVARIANT D — a missing capability grant cannot reach the provider', async () => {
    const b = await boot(true);
    registerManifest(b);
    const { connector, calls } = probeConnector();
    const registration = await b.connectors.register(admin, connector);
    await b.connectors.activate(admin, registration.id);
    const planned = await planPublish(b, 'r1-conn-nocap');

    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: {
        principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }),
        capabilityId: 'connector.not.granted',
      },
    });

    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0);
    await b.kernel.shutdown();
  });

  it('INVARIANT E — a tenant mismatch cannot reach the provider', async () => {
    const b = await boot(true);
    registerManifest(b);
    const { connector, calls } = probeConnector();
    const registration = await b.connectors.register(admin, connector);
    await b.connectors.activate(admin, registration.id);
    const planned = await planPublish(b, 'r1-conn-tenant');

    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: testPrincipal({ id: 'user:bob', tenantId: 'evilcorp' }), capabilityId: CAP },
    });

    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0);
    await b.kernel.shutdown();
  });

  it('INVARIANT M — policy denial (target outside the manifest) prevents external invocation', async () => {
    const b = await boot(true);
    const { connector, calls } = probeConnector();
    const registration = await b.connectors.register(admin, connector);
    // Everything is correct EXCEPT the target: the manifest permits only
    // `allowed-only`, the action targets `res-1`.
    registerManifestForTool(b, `connector:${registration.id}`, 'allowed-only');
    await b.connectors.activate(admin, registration.id);
    const planned = await planPublish(b, 'r1-conn-target', 'res-1');

    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }), capabilityId: CAP },
    });

    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0, 'a policy denial must prevent external invocation');
    await b.kernel.shutdown();
  });

  it('INVARIANT I — positive control: a fully legitimate connector call DOES reach the provider once', async () => {
    const b = await boot(true);
    const { connector, calls } = probeConnector();
    const registration = await b.connectors.register(admin, connector);
    // The manifest is bound to the EXACT executable adapter identity.
    registerManifestForTool(b, `connector:${registration.id}`);
    await b.connectors.activate(admin, registration.id);
    const planned = await planPublish(b, 'r1-conn-positive');

    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: testPrincipal({ id: 'user:alice', tenantId: 'acme' }), capabilityId: CAP },
    });

    assert.equal(executed.executedExternally, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.authorization?.envelope, 'the provider received the sealed envelope');
    await b.kernel.shutdown();
  });
});
