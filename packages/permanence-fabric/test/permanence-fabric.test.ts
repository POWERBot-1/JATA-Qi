import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signPayload } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import {
  PermanenceFabricError,
  PermanenceFabricModule,
  type JqExternalSigner,
  type JqRuntimeCapability,
  type PermanenceFabricService,
} from '../src/index.js';

const admin: CommercialActor = { id: 'permanence-admin', tenantId: 'acme', roles: ['admin'] };
const operator: CommercialActor = { id: 'permanence-operator', tenantId: 'acme', roles: ['operator'] };
const globalAdmin: CommercialActor = { id: 'permanence-global-admin', tenantId: 'acme', roles: ['global_admin'] };
const other: CommercialActor = { id: 'permanence-other', tenantId: 'other', roles: ['admin'] };

function provenance(source = 'permanence-fabric-test') {
  return { source, collectedAt: Date.now(), correlationId: 'permanence-test-correlation' };
}

function signer(keyId: string): JqExternalSigner & { privateKeyMarker: string } {
  const pair = generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyMarker = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    keyId,
    algorithm: 'ED25519',
    publicKeyPem,
    privateKeyMarker,
    // Isolated test-only in-memory signer. The library receives this function
    // and public key, never a private-key field.
    sign: (canonicalPayload) => signPayload(null, Buffer.from(canonicalPayload), pair.privateKey).toString('base64'),
  };
}

async function boot(storage: StorageModuleConfig = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule(storage));
  kernel.register(new PermanenceFabricModule());
  await kernel.boot();
  return {
    kernel,
    service: kernel.getModule<PermanenceFabricModule>('permanence-fabric').getService(),
  };
}

async function createIdentity(service: PermanenceFabricService, root = signer('root-key')) {
  const identity = await service.createIdentity(admin, {
    label: 'JATA Qi continuity test identity',
    capabilityRootReference: 'capability-root:local-test',
    stateRootReference: 'state-root:initial-reference',
    economicIdentityReference: 'economic-reference:provider-agnostic',
    discoveryMethods: ['LOCAL_REGISTRY', 'CONTENT_ADDRESS'],
    recoveryMethods: ['STATE_CHECKPOINT', 'AUTHORIZED_RUNTIME_HANDOVER'],
    provenance: provenance(),
  }, root);
  return { identity, root };
}

async function authorizeRuntime(
  service: PermanenceFabricService,
  identityId: string,
  root: JqExternalSigner,
  runtime: JqExternalSigner,
  runtimeId = 'runtime-a',
  capabilities: JqRuntimeCapability[] = ['ATTEST', 'SYNC_STATE', 'LOAD_STATE', 'VERIFY_STATE', 'DECLARE_MANIFESTATION', 'MIGRATE', 'RECOVER'],
) {
  return service.authorizeRuntime(admin, identityId, {
    runtimeId,
    runtimeKeyId: runtime.keyId,
    runtimePublicKeyPem: runtime.publicKeyPem,
    capabilities,
    softwareVersion: '1.0.0',
    provenance: provenance(`authorize-${runtimeId}`),
  }, root);
}

function digest(char: string): string {
  return char.repeat(64);
}

describe('JATA Qi Permanence Fabric', () => {
  it('creates a classical cryptographic JQ-ID and portable signed JQ-UIP without persisting a root private key', async () => {
    const { kernel, service } = await boot();
    try {
      const { identity, root } = await createIdentity(service);
      assert.match(identity.id, /^jq-/);
      assert.equal(identity.activeRootKeyId, root.keyId);
      assert.equal((await service.verifyIdentity(admin, identity.id)).valid, true);
      await service.declareDiscovery(admin, identity.id, {
        method: 'LOCAL_REGISTRY', locatorReference: 'local-registry://jata-qi-test', provenance: provenance(),
      }, root);
      const print = await service.issueIdentityPrint(admin, identity.id, {}, root);
      assert.equal(print.format, 'JQ-UIP');
      assert.equal(service.verifyIdentityPrint(print).valid, true, 'self-consistency is useful but is not a local trust-anchor check');
      assert.equal((await service.verifyIdentityPrintAgainstIdentity(admin, print)).valid, true);
      assert.equal(JSON.stringify(identity).includes(root.privateKeyMarker), false, 'private root key material is not persisted in the identity record');
      assert.equal(JSON.stringify(print).includes(root.privateKeyMarker), false, 'private root key material is not present in the portable print');
      assert.equal(service.verifyIdentityPrint({ ...print, label: 'forged label' }).valid, false);
    } finally {
      await kernel.shutdown();
    }
  });

  it('authorizes and attests a bounded runtime, records an authorized state checkpoint, and resolves active manifestations without asserting reachability', async () => {
    const { kernel, service } = await boot();
    try {
      const { identity, root } = await createIdentity(service);
      const runtime = signer('runtime-a-key');
      const authorization = await authorizeRuntime(service, identity.id, root, runtime);
      const checkpoint = await service.recordStateCheckpoint(operator, identity.id, {
        runtimeAuthorizationId: authorization.id,
        version: 1,
        stateReference: 'content-addressed://state-v1',
        canonicalDigest: digest('a'),
        provenance: provenance('state-v1'),
      }, runtime);
      assert.equal(checkpoint.status, 'AUTHORITATIVE');
      assert.equal((await service.verifyStateCheckpoint(operator, checkpoint.id)).valid, true);
      const attestation = await service.attestRuntime(operator, identity.id, {
        runtimeAuthorizationId: authorization.id,
        softwareVersion: '1.0.0',
        stateCheckpointId: checkpoint.id,
        integrityDigest: digest('b'),
        availability: 'AVAILABLE',
        capabilitySnapshot: ['ATTEST', 'SYNC_STATE', 'LOAD_STATE', 'VERIFY_STATE', 'DECLARE_MANIFESTATION'],
        expiresAt: Date.now() + 60_000,
        provenance: provenance('runtime-a-attestation'),
      }, runtime);
      const manifestation = await service.declareManifestation(operator, identity.id, {
        runtimeAuthorizationId: authorization.id,
        runtimeAttestationId: attestation.id,
        type: 'API',
        locatorReference: 'https://optional-doorway.example/jata-qi',
        authenticationReference: 'attestation:runtime-a',
        provenance: provenance('api-manifestation'),
      }, runtime);
      assert.equal(manifestation.status, 'ACTIVE');
      const resolution = await service.resolve(admin, identity.id);
      assert.equal(resolution.status, 'RESOLVED');
      assert.equal(resolution.authoritativeState?.id, checkpoint.id);
      assert.equal(resolution.activeManifestations[0]?.id, manifestation.id);
      assert.equal(resolution.doesNotProveReachability, true);
    } finally {
      await kernel.shutdown();
    }
  });

  it('retains conflicting state branches instead of silently applying last-writer-wins authority', async () => {
    const { kernel, service } = await boot();
    try {
      const { identity, root } = await createIdentity(service);
      const runtime = signer('runtime-state-key');
      const authorization = await authorizeRuntime(service, identity.id, root, runtime);
      const first = await service.recordStateCheckpoint(operator, identity.id, {
        runtimeAuthorizationId: authorization.id, version: 1, stateReference: 'cas://state-1', canonicalDigest: digest('1'), provenance: provenance(),
      }, runtime);
      const second = await service.recordStateCheckpoint(operator, identity.id, {
        runtimeAuthorizationId: authorization.id, version: 2, stateReference: 'cas://state-2', canonicalDigest: digest('2'), parentCheckpointId: first.id, provenance: provenance(),
      }, runtime);
      const conflicting = await service.recordStateCheckpoint(operator, identity.id, {
        runtimeAuthorizationId: authorization.id, version: 3, stateReference: 'cas://competing-state-3', canonicalDigest: digest('3'), parentCheckpointId: first.id, provenance: provenance(),
      }, runtime);
      assert.equal(second.status, 'AUTHORITATIVE');
      assert.equal(conflicting.status, 'CONFLICTING');
      const states = await service.listStateCheckpoints(operator, identity.id);
      assert.equal(states.find((checkpoint) => checkpoint.id === first.id)?.status, 'STALE');
      assert.equal(states.find((checkpoint) => checkpoint.id === second.id)?.status, 'AUTHORITATIVE');
      assert.equal(states.find((checkpoint) => checkpoint.id === conflicting.id)?.status, 'CONFLICTING');
    } finally {
      await kernel.shutdown();
    }
  });

  it('rotates root authority without changing JQ-ID and revokes a runtime without deleting its audit/lineage history', async () => {
    const { kernel, service } = await boot();
    try {
      const { identity, root } = await createIdentity(service);
      const runtime = signer('runtime-revocable-key');
      const authorization = await authorizeRuntime(service, identity.id, root, runtime);
      const nextRoot = signer('root-key-rotated');
      const rotation = await service.rotateRootKey(admin, identity.id, { provenance: provenance('root-rotation') }, root, nextRoot);
      assert.equal(rotation.identity.id, identity.id);
      assert.equal(rotation.identity.activeRootKeyId, nextRoot.keyId);
      assert.equal((await service.verifyIdentity(admin, identity.id)).valid, true);
      await assert.rejects(
        () => service.authorizeRuntime(admin, identity.id, {
          runtimeId: 'old-root-runtime', runtimeKeyId: runtime.keyId, runtimePublicKeyPem: runtime.publicKeyPem,
          capabilities: ['ATTEST'], softwareVersion: '1.0.0', provenance: provenance(),
        }, root),
        PermanenceFabricError,
      );
      const revoked = await service.revokeRuntime(admin, identity.id, authorization.id, { reason: 'Controlled test revocation.', provenance: provenance() }, nextRoot);
      assert.equal(revoked.status, 'REVOKED');
      assert.equal((await service.listRuntimeAuthorizations(admin, identity.id)).length, 1);
      assert.equal((await service.verifyLineage(admin, identity.id)).valid, true);
    } finally {
      await kernel.shutdown();
    }
  });

  it('creates a root-signed ready-to-resume handover plan only after target attestation and state integrity checks, without executing migration', async () => {
    const { kernel, service } = await boot();
    try {
      const { identity, root } = await createIdentity(service);
      const sourceSigner = signer('runtime-source-key');
      const targetSigner = signer('runtime-target-key');
      const source = await authorizeRuntime(service, identity.id, root, sourceSigner, 'runtime-source');
      const target = await authorizeRuntime(service, identity.id, root, targetSigner, 'runtime-target');
      const checkpoint = await service.recordStateCheckpoint(operator, identity.id, {
        runtimeAuthorizationId: source.id, version: 1, stateReference: 'cas://handover-state', canonicalDigest: digest('c'), provenance: provenance('source-checkpoint'),
      }, sourceSigner);
      const targetAttestation = await service.attestRuntime(operator, identity.id, {
        runtimeAuthorizationId: target.id, softwareVersion: '1.0.0', integrityDigest: digest('d'), availability: 'AVAILABLE',
        capabilitySnapshot: ['ATTEST', 'SYNC_STATE', 'LOAD_STATE', 'VERIFY_STATE', 'DECLARE_MANIFESTATION', 'MIGRATE', 'RECOVER'],
        expiresAt: Date.now() + 60_000, provenance: provenance('target-attestation'),
      }, targetSigner);
      const handover = await service.planRuntimeHandover(admin, identity.id, {
        sourceRuntimeAuthorizationId: source.id, targetRuntimeAuthorizationId: target.id, targetRuntimeAttestationId: targetAttestation.id,
        stateCheckpointId: checkpoint.id, provenance: provenance('handover-plan'),
      }, root);
      assert.equal(handover.status, 'READY_TO_RESUME');
      assert.equal((await service.listHandovers(admin, identity.id))[0]?.id, handover.id);
      assert.equal((await service.verifyLineage(admin, identity.id)).valid, true);
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists continuity records across a filesystem restart and keeps JQ-ID records tenant-isolated', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'jataqi-permanence-fabric-'));
    const root = signer('persistent-root-key');
    try {
      const first = await boot({ driver: 'filesystem', fsRoot: rootDirectory });
      const { identity } = await createIdentity(first.service, root);
      await first.service.declareDiscovery(admin, identity.id, {
        method: 'CONTENT_ADDRESS', locatorReference: 'cas://jq-uip/persistent', provenance: provenance(),
      }, root);
      const print = await first.service.issueIdentityPrint(admin, identity.id, {}, root);
      await first.kernel.shutdown();

      const second = await boot({ driver: 'filesystem', fsRoot: rootDirectory });
      assert.equal((await second.service.getIdentity(admin, identity.id))?.id, identity.id);
      assert.equal((await second.service.listIdentityPrints(admin, identity.id))[0]?.id, print.id);
      assert.equal(await second.service.getIdentity(other, identity.id), undefined);
      await assert.rejects(() => second.service.listDiscovery(other, identity.id), PermanenceFabricError);
      assert.equal((await second.service.verifyLineage(admin, identity.id)).valid, true);
      await second.kernel.shutdown();
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it('requires global/system authority for a SYSTEM JQ-ID', async () => {
    const { kernel, service } = await boot();
    try {
      const root = signer('system-root-key');
      await assert.rejects(
        () => service.createIdentity(admin, { label: 'system identity', scope: 'SYSTEM', provenance: provenance() }, root),
        PermanenceFabricError,
      );
      const identity = await service.createIdentity(globalAdmin, { label: 'system identity', scope: 'SYSTEM', provenance: provenance() }, root);
      assert.equal(identity.scope, 'SYSTEM');
      assert.equal((await service.verifyIdentity(globalAdmin, identity.id)).valid, true);
    } finally {
      await kernel.shutdown();
    }
  });
});
