import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signPayload } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { PermanenceFabricModule, type JqExternalSigner, type PermanenceFabricService } from '@jataqi/permanence-fabric';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import {
  CapabilityFabricError,
  CapabilityFabricModule,
  type CapabilityFabricService,
  type RegisterEngineGenomeInput,
  type RegisterJqCapabilityInput,
} from '../src/index.js';

const admin: CommercialActor = { id: 'capability-admin', tenantId: 'acme', roles: ['admin'] };
const operator: CommercialActor = { id: 'capability-operator', tenantId: 'acme', roles: ['operator'] };
const other: CommercialActor = { id: 'capability-other', tenantId: 'other', roles: ['operator'] };

function provenance(source = 'capability-fabric-test') {
  return { source, collectedAt: Date.now(), correlationId: 'capability-fabric-correlation' };
}

function evidence(id = 'capability-evidence'): CommercialEvidence {
  const now = Date.now();
  return { id, status: 'MEASURED', source: 'capability-fabric-test', observedAt: now, confidence: 90, summary: 'Bounded controlled capability verification evidence.', provenance: { source: 'capability-fabric-test', collectedAt: now } };
}

function signer(keyId: string): JqExternalSigner {
  const pair = generateKeyPairSync('ed25519');
  return {
    keyId,
    algorithm: 'ED25519',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (payload) => signPayload(null, Buffer.from(payload), pair.privateKey).toString('base64'),
  };
}

async function boot(storage: StorageModuleConfig = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule(storage));
  kernel.register(new PermanenceFabricModule());
  kernel.register(new CapabilityFabricModule());
  await kernel.boot();
  return {
    kernel,
    permanence: kernel.getModule<PermanenceFabricModule>('permanence-fabric').getService(),
    service: kernel.getModule<CapabilityFabricModule>('capability-fabric').getService(),
  };
}

function capabilityInput(overrides: Partial<RegisterJqCapabilityInput> = {}): RegisterJqCapabilityInput {
  return {
    name: 'Bounded analysis capability', version: '1.0.0', capabilityClass: 'DATA_ANALYSIS',
    description: 'A metadata-only capability used to test lifecycle and access boundaries.',
    requiredPermissionIds: ['analyze'], safetyClass: 'CLASS_0_INFORMATIONAL', riskScore: 10,
    authorizationPolicySummary: 'Requires a scoped analyze grant.', verificationMethod: 'Controlled sandbox validation evidence.',
    auditRequirements: ['lifecycle evidence', 'access assessment'], provenance: provenance(),
    ...overrides,
  };
}

async function advanceCapabilityToAvailable(service: CapabilityFabricService, capabilityId: string) {
  let capability = await service.transitionCapability(admin, capabilityId, { state: 'REGISTERED', reason: 'Metadata registered.', provenance: provenance() });
  capability = await service.transitionCapability(admin, capability.id, { state: 'VERIFIED', reason: 'Verification evidence recorded.', evidence: [evidence('verified')], provenance: provenance() });
  capability = await service.transitionCapability(admin, capability.id, { state: 'SANDBOXED', reason: 'Sandbox evidence recorded.', evidence: [evidence('sandboxed')], provenance: provenance() });
  capability = await service.transitionCapability(admin, capability.id, { state: 'CERTIFIED', reason: 'Local registry certification evidence recorded.', evidence: [evidence('certified')], provenance: provenance() });
  return service.transitionCapability(admin, capability.id, { state: 'AVAILABLE', reason: 'Dependencies are locally available.', evidence: [evidence('available')], provenance: provenance() });
}

async function makeAvailable(service: CapabilityFabricService, input: RegisterJqCapabilityInput = capabilityInput()) {
  const capability = await service.registerCapability(admin, input);
  return advanceCapabilityToAvailable(service, capability.id);
}

function engineInput(capabilityId: string, overrides: Partial<RegisterEngineGenomeInput> = {}): RegisterEngineGenomeInput {
  return {
    engineId: 'analysis-engine', name: 'Analysis Engine', version: '1.0.0', description: 'Metadata-only engine genome for governed registry testing.',
    capabilityIds: [capabilityId], inputSchema: { id: 'analysis-input', version: '1', contentHash: 'a'.repeat(64) }, outputSchema: { id: 'analysis-output', version: '1', contentHash: 'b'.repeat(64) },
    stateModelSummary: 'No runtime state is created by the registry.', securityPolicySummary: 'No direct tool or external execution is allowed.',
    resourcePolicySummary: 'No resource allocation occurs during registry operations.', authorizationPolicySummary: 'Separate capability grants and execution policy are required.',
    latencyProfileSummary: 'Registry metadata only.', reliabilityTarget: 90, costModelSummary: 'No runtime cost is asserted.', energyModelSummary: 'No energy measurement is asserted.',
    owner: 'capability-test-owner', safetyClass: 'CLASS_0_INFORMATIONAL', provenance: provenance(),
    ...overrides,
  };
}

async function advanceEngineToAvailable(service: CapabilityFabricService, engineId: string) {
  let engine = await service.transitionEngineGenome(admin, engineId, { state: 'REGISTERED', reason: 'Metadata registered.', provenance: provenance() });
  engine = await service.transitionEngineGenome(admin, engine.id, { state: 'VERIFIED', reason: 'Verification evidence recorded.', evidence: [evidence('engine-verified')], provenance: provenance() });
  engine = await service.transitionEngineGenome(admin, engine.id, { state: 'SANDBOXED', reason: 'Sandbox evidence recorded.', evidence: [evidence('engine-sandboxed')], provenance: provenance() });
  engine = await service.transitionEngineGenome(admin, engine.id, { state: 'CERTIFIED', reason: 'Local certification evidence recorded.', evidence: [evidence('engine-certified')], provenance: provenance() });
  return service.transitionEngineGenome(admin, engine.id, { state: 'AVAILABLE', reason: 'Capability requirements are available.', evidence: [evidence('engine-available')], provenance: provenance() });
}

describe('JQ Capability Fabric', () => {
  it('keeps capability existence separate from availability and explicit subject authorization', async () => {
    const { kernel, service } = await boot();
    try {
      const proposed = await service.registerCapability(admin, capabilityInput());
      assert.equal(proposed.lifecycleState, 'PROPOSED');
      await assert.rejects(() => service.transitionCapability(admin, proposed.id, { state: 'AVAILABLE', reason: 'Skip verification.', evidence: [evidence()], provenance: provenance() }), CapabilityFabricError);
      const capability = await makeAvailable(service, capabilityInput({ name: 'Available analysis capability' }));
      const before = await service.assessCapabilityAccess(operator, capability.id);
      assert.equal(before.outcome, 'AVAILABLE_REQUIRES_GRANT');
      const grant = await service.grantCapability(admin, capability.id, { subjectActorId: operator.id, permissionIds: ['analyze'], scope: 'analysis:project-1', provenance: provenance() });
      const after = await service.assessCapabilityAccess(operator, capability.id);
      assert.equal(after.outcome, 'AVAILABLE_AND_AUTHORIZED');
      assert.equal(after.doesNotAuthorizeExecution, true);
      await service.revokeCapabilityGrant(admin, grant.id, { reason: 'Controlled revocation.', provenance: provenance() });
      assert.equal((await service.assessCapabilityAccess(operator, capability.id)).outcome, 'AVAILABLE_REQUIRES_GRANT');
    } finally {
      await kernel.shutdown();
    }
  });

  it('enforces dependency availability and produces a deterministic capability graph', async () => {
    const { kernel, service } = await boot();
    try {
      const dependency = await service.registerCapability(admin, capabilityInput({ name: 'Dependency capability', requiredPermissionIds: [] }));
      const dependent = await service.registerCapability(admin, capabilityInput({ name: 'Dependent capability', dependencies: [dependency.id], requiredPermissionIds: [] }));
      let transition = await service.transitionCapability(admin, dependent.id, { state: 'REGISTERED', reason: 'Registered.', provenance: provenance() });
      transition = await service.transitionCapability(admin, transition.id, { state: 'VERIFIED', reason: 'Verified.', evidence: [evidence('dependent-verified')], provenance: provenance() });
      transition = await service.transitionCapability(admin, transition.id, { state: 'SANDBOXED', reason: 'Sandboxed.', evidence: [evidence('dependent-sandboxed')], provenance: provenance() });
      transition = await service.transitionCapability(admin, transition.id, { state: 'CERTIFIED', reason: 'Certified.', evidence: [evidence('dependent-certified')], provenance: provenance() });
      await assert.rejects(() => service.transitionCapability(admin, transition.id, { state: 'AVAILABLE', reason: 'Dependency not available.', evidence: [evidence('dependent-available')], provenance: provenance() }), CapabilityFabricError);
      await advanceCapabilityToAvailable(service, dependency.id);
      const availableDependent = await service.transitionCapability(admin, transition.id, { state: 'AVAILABLE', reason: 'Original dependency is now available.', evidence: [evidence('dependent-retry')], provenance: provenance() });
      assert.equal(availableDependent.lifecycleState, 'AVAILABLE');
      const graph = await service.graph(operator);
      assert.ok(graph.nodes.some((node) => node.id === dependent.id));
      assert.ok(graph.edges.some((edge) => edge.fromId === dependent.id && edge.toId === dependency.id && edge.type === 'DEPENDS_ON'));
    } finally {
      await kernel.shutdown();
    }
  });

  it('registers composable ENGINE_GENOME metadata and blocks activation until referenced capabilities and engines are available', async () => {
    const { kernel, service } = await boot();
    try {
      const capability = await makeAvailable(service, capabilityInput({ name: 'Engine capability', requiredPermissionIds: [] }));
      const base = await service.registerEngineGenome(admin, engineInput(capability.id, { engineId: 'base-engine', name: 'Base Engine' }));
      const availableBase = await advanceEngineToAvailable(service, base.id);
      const composite = await service.registerEngineGenome(admin, engineInput(capability.id, { engineId: 'composite-engine', name: 'Composite Engine', composedEngineIds: [availableBase.id] }));
      const availableComposite = await advanceEngineToAvailable(service, composite.id);
      assert.equal(availableComposite.lifecycleState, 'AVAILABLE');
      const graph = await service.graph(operator);
      assert.ok(graph.edges.some((edge) => edge.fromId === composite.id && edge.toId === base.id && edge.type === 'COMPOSES'));
    } finally {
      await kernel.shutdown();
    }
  });

  it('requires a root-authorized runtime when a capability declares runtime requirements', async () => {
    const { kernel, permanence, service } = await boot();
    try {
      const root = signer('capability-root');
      const identity = await permanence.createIdentity(admin, { label: 'Capability identity', provenance: provenance() }, root);
      const runtime = signer('capability-runtime');
      const runtimeAuthorization = await permanence.authorizeRuntime(admin, identity.id, {
        runtimeId: 'capability-runtime', runtimeKeyId: runtime.keyId, runtimePublicKeyPem: runtime.publicKeyPem,
        capabilities: ['SYNC_STATE', 'ATTEST'], softwareVersion: '1.0.0', provenance: provenance(),
      }, root);
      const capability = await makeAvailable(service, capabilityInput({
        name: 'Runtime-bound capability', identityId: identity.id, requiredRuntimeCapabilities: ['SYNC_STATE'],
      }));
      await service.grantCapability(admin, capability.id, { subjectActorId: operator.id, permissionIds: ['analyze'], provenance: provenance() });
      assert.equal((await service.assessCapabilityAccess(operator, capability.id)).outcome, 'AVAILABLE_REQUIRES_RUNTIME');
      assert.equal((await service.assessCapabilityAccess(operator, capability.id, { runtimeAuthorizationId: runtimeAuthorization.id })).outcome, 'AVAILABLE_AND_AUTHORIZED');
    } finally {
      await kernel.shutdown();
    }
  });

  it('does not activate physical/high-impact capability metadata even after local lifecycle evidence and grants exist', async () => {
    const { kernel, service } = await boot();
    try {
      const capability = await makeAvailable(service, capabilityInput({
        name: 'Physical boundary capability', capabilityClass: 'ROBOTICS', safetyClass: 'CLASS_3_PHYSICAL_OR_HIGH_IMPACT', requiredPermissionIds: ['operate'], riskScore: 90,
      }));
      await service.grantCapability(admin, capability.id, { subjectActorId: operator.id, permissionIds: ['operate'], provenance: provenance() });
      assert.equal((await service.assessCapabilityAccess(operator, capability.id)).outcome, 'BLOCKED_SAFETY_REVIEW');
      await assert.rejects(() => service.registerEngineGenome(admin, engineInput(capability.id, {
        engineId: 'unsafe-actuator-engine', actuatorsRequired: ['physical-device-command'], safetyClass: 'CLASS_0_INFORMATIONAL',
      })), CapabilityFabricError);
      await assert.rejects(() => service.transitionCapability(admin, capability.id, { state: 'ACTIVE', reason: 'Unsafe registry-only activation.', evidence: [evidence('physical-active')], provenance: provenance() }), CapabilityFabricError);
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists registry records and preserves a tamper-evident tenant audit chain across filesystem restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-capability-fabric-'));
    try {
      const first = await boot({ driver: 'filesystem', fsRoot: root });
      const capability = await first.service.registerCapability(admin, capabilityInput({ name: 'Persistent capability' }));
      await first.service.transitionCapability(admin, capability.id, { state: 'REGISTERED', reason: 'Persisted registration.', provenance: provenance() });
      assert.equal((await first.service.verifyAuditIntegrity(admin)).valid, true);
      await first.kernel.shutdown();

      const second = await boot({ driver: 'filesystem', fsRoot: root });
      assert.equal((await second.service.getCapability(admin, capability.id))?.lifecycleState, 'REGISTERED');
      assert.equal((await second.service.verifyAuditIntegrity(admin)).entries, 2);
      assert.equal(await second.service.getCapability(other, capability.id), undefined);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
