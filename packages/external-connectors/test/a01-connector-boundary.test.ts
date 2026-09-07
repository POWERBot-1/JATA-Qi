// A-01 wiring — external connector fabric. Proves that, with an installed
// boundary, connector registration is bound to capability manifests
// (unbound and over-privileged connectors are rejected), that execution of a
// bound connector is enforced at the boundary (default deny, deny-before-side
// effect), that a direct connector.execute call (bypassing the runtime) has no
// authority, and that the legacy no-boundary path is unchanged.
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
  type A01CapabilityManifest,
  type A01PrincipalBinding,
} from '@jataqi/authorization-boundary';
import {
  AutonomousActionRuntimeModule,
  type ActionExecutionContext,
  type ActionRuntimeService,
} from '@jataqi/autonomous-action-runtime';
import { ExternalConnectorModule, ExternalConnectorError, type ExternalConnector } from '../src/index.js';

const T0 = 1_700_000_000_000;
let now: number;
let admin: CommercialActor;
let operator: CommercialActor;

function evidence(id = 'evidence-1'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'connector-test',
    observedAt: now,
    confidence: 90,
    summary: 'Controlled test evidence.',
    provenance: { source: 'connector-test', collectedAt: now, correlationId: 'conn-corr' },
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
    version: 'connector-test-policy',
    scope: { tenantId: 'acme' },
    maximumAutonomyLevel: 4,
    allowExecution: true,
    allowedActionTypes: ['PUBLISH_CONTENT'],
    maximumRiskScore: 80,
    minimumComplianceScore: 80,
    minimumEvidenceStrength: 70,
  });
  const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
  const connectors = kernel.getModule<ExternalConnectorModule>('external-connectors').getRegistry();
  return { kernel, control, runtime, connectors };
}

/** A controllable fake external connector. */
function fakeConnector(overrides: Partial<ExternalConnector> = {}) {
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
      return { reportedSuccess: true, summary: 'Connector accepted request.', externalResponse: { requestId: `conn-${calls.length}` } };
    },
    async verify() {
      return { verified: true, evidence: [evidence('verify-1')], summary: 'Connector state verified.' };
    },
    async rollback() {
      return { confirmed: true, summary: 'Connector rollback verified.' };
    },
  };
  return { connector: { ...base, ...overrides } as ExternalConnector, calls };
}

async function planPublish(b: Booted, idempotencyKey: string, targetResource = 'res-1') {
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
    provenance: { source: 'connector-test', collectedAt: now, correlationId: 'conn-corr' },
  });
  return b.runtime.plan(operator, proposed.id, {
    targetSystem: 'sandbox-provider',
    targetResource,
    idempotencyKey,
    dryRun: false,
    rollbackStrategy: 'remove the sandbox publication',
  });
}

function manifestFor(tool: string, opts: Partial<A01CapabilityManifest> = {}): A01CapabilityManifest {
  return {
    capabilityId: 'connector.sandbox.publish',
    version: '1',
    description: 'Sandbox connector publish capability',
    allowedOperations: [{ tool, operation: 'PUBLISH_CONTENT' }],
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

describe('A-01 external-connectors: registration is bound to capability manifests', () => {
  it('41a unbound marketplace extension: a connector with no capability is rejected at registration', async () => {
    const b = await boot(true);
    assert.ok(b.connectors.getAuthorizationGate(), 'the registry picked up the installed boundary');
    const { connector } = fakeConnector();
    await assert.rejects(
      () => b.connectors.register(admin, connector),
      (err: unknown) => err instanceof ExternalConnectorError && /UNBOUND_CONNECTOR/.test(err.message),
    );
    assert.equal(b.connectors.list(operator).length, 0, 'no registration record is created for an unbound connector');
    await b.kernel.shutdown();
  });

  it('41c over-privileged extension: an action list beyond the manifest is rejected at registration', async () => {
    const b = await boot(true);
    const gate = b.connectors.getAuthorizationGate()!;
    // Manifest grants only PUBLISH_CONTENT.
    gate.manifestsRegistry.register(manifestFor('connector:any', { allowedOperations: [{ tool: 'connector:any', operation: 'PUBLISH_CONTENT' }] }));
    const { connector } = fakeConnector({ capabilityId: 'connector.sandbox.publish', supportedActions: ['PUBLISH_CONTENT', 'DELETE_ALL_DATA'] });
    await assert.rejects(
      () => b.connectors.register(admin, connector),
      (err: unknown) => err instanceof ExternalConnectorError && /OVER_PRIVILEGED_CONNECTOR/.test(err.message),
    );
    await b.kernel.shutdown();
  });

  it('41b ungranted extension: a bound connector with NO manifest registers but can never execute (fail-closed)', async () => {
    const b = await boot(true);
    const { connector } = fakeConnector({ capabilityId: 'connector.sandbox.publish' });
    // Registration succeeds: the grant (manifest) may be issued later.
    const registration = await b.connectors.register(admin, connector);
    assert.equal(registration.health, 'DISABLED');
    await b.connectors.activate(admin, registration.id);
    const planned = await planPublish(b, 'a01-conn-ungranted');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: principal(), capabilityId: 'connector.sandbox.publish' },
    });
    assert.equal(executed.executedExternally, false, 'no external I/O without a registered capability manifest');
    const reported = executed.action.result?.externalResponse as Record<string, unknown> | undefined;
    assert.equal(reported?.errorType, 'authorization_denied');
    assert.ok((reported?.reasonCodes as string[]).includes('UNKNOWN_CAPABILITY'), `got: ${JSON.stringify(reported)}`);
    await b.kernel.shutdown();
  });
});

describe('A-01 external-connectors: bound connector execution is boundary-enforced', () => {
  it('positive control: a granted connector executes with the sealed envelope in context', async () => {
    const b = await boot(true);
    const gate = b.connectors.getAuthorizationGate()!;
    const { connector, calls } = fakeConnector({ capabilityId: 'connector.sandbox.publish' });
    const registration = await b.connectors.register(admin, connector);
    await b.connectors.activate(admin, registration.id);
    // Grant bound to the concrete runtime adapter id.
    gate.manifestsRegistry.register(manifestFor(`connector:${registration.id}`));
    const planned = await planPublish(b, 'a01-conn-positive');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: principal(), capabilityId: 'connector.sandbox.publish' },
    });
    assert.equal(executed.executedExternally, true);
    assert.equal(executed.action.executionStatus, 'VERIFYING');
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.authorization?.envelope, 'the connector context carries the sealed envelope');
    assert.equal(calls[0]?.authorization?.envelope?.tenantId, 'acme');
    assert.equal(calls[0]?.authorization?.envelope?.tool, `connector:${registration.id}`);
    await b.kernel.shutdown();
  });

  it('cross-tenant principal: DENY before the connector runs (7: cross-tenant resource)', async () => {
    const b = await boot(true);
    const gate = b.connectors.getAuthorizationGate()!;
    const { connector, calls } = fakeConnector({ capabilityId: 'connector.sandbox.publish' });
    const registration = await b.connectors.register(admin, connector);
    await b.connectors.activate(admin, registration.id);
    gate.manifestsRegistry.register(manifestFor(`connector:${registration.id}`)); // tenantScopes: ['acme']
    const planned = await planPublish(b, 'a01-conn-cross-tenant');
    const executed = await b.runtime.execute(operator, planned.id, {
      authorization: { principal: principal({ id: 'user:mallory', tenantId: 'globex' }), capabilityId: 'connector.sandbox.publish' },
    });
    assert.equal(executed.executedExternally, false);
    assert.equal(calls.length, 0, 'the connector was never invoked');
    const reported = executed.action.result?.externalResponse as Record<string, unknown> | undefined;
    assert.ok(
      (reported?.reasonCodes as string[]).some((c) => c === 'TENANT_OUT_OF_SCOPE' || c === 'TENANT_SUBSTITUTION'),
      `got: ${JSON.stringify(reported)}`,
    );
    await b.kernel.shutdown();
  });

  it('28 connector bypass: calling connector.execute directly yields NO authority (no envelope, no credential)', async () => {
    const b = await boot(true);
    const gate = b.connectors.getAuthorizationGate()!;
    const { connector, calls } = fakeConnector({ capabilityId: 'connector.sandbox.publish' });
    const registration = await b.connectors.register(admin, connector);
    await b.connectors.activate(admin, registration.id);
    gate.manifestsRegistry.register(manifestFor(`connector:${registration.id}`));
    // A compromised component calls the connector directly, outside the runtime.
    await connector.execute({
      action: { id: 'forged', tenantId: 'acme' } as never,
      actor: operator,
      attempt: 1,
      signal: new AbortController().signal,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.authorization, undefined, 'a direct connector call carries no A-01 authority');
    await b.kernel.shutdown();
  });

  it('legacy composition without the boundary: an unbound connector registers and executes with no A-01 context', async () => {
    const b = await boot(false);
    assert.equal(b.connectors.getAuthorizationGate(), undefined, 'no boundary installed');
    const { connector, calls } = fakeConnector(); // no capabilityId
    const registration = await b.connectors.register(admin, connector);
    assert.equal(registration.health, 'DISABLED');
    await b.connectors.activate(admin, registration.id);
    const planned = await planPublish(b, 'a01-conn-legacy');
    const executed = await b.runtime.execute(operator, planned.id);
    assert.equal(executed.executedExternally, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.authorization, undefined, 'legacy path carries no A-01 context');
    await b.kernel.shutdown();
  });
});
