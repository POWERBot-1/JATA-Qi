import { describe, it } from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { WorldModelModule, type WorldModelService } from '@jataqi/world-model';
import { TemporalEngineModule, type TemporalEngineService } from '@jataqi/temporal-engine';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import {
  OrbitalIntelligenceError,
  OrbitalIntelligenceModule,
  type ObservationProviderAdapter,
  type OrbitalIntelligenceService,
} from '../src/index.js';

const admin: CommercialActor = { id: 'oie-admin', tenantId: 'acme', roles: ['admin'] };
const operator: CommercialActor = { id: 'oie-operator', tenantId: 'acme', roles: ['operator'] };
const other: CommercialActor = { id: 'oie-other', tenantId: 'other', roles: ['operator'] };

function now(): number { return Date.now(); }
function provenance(source = 'oie-test') { return { source, collectedAt: now(), correlationId: 'oie-test-correlation' }; }
function evidence(id: string, source = `source-${id}`, status: CommercialEvidence['status'] = 'MEASURED'): CommercialEvidence {
  const timestamp = now();
  return { id, source, status, observedAt: timestamp, confidence: 90, summary: `Bounded evidence summary for ${id}.`, provenance: { source, collectedAt: timestamp } };
}
function hash(char: string): string { return char.repeat(64); }
function extent() { return { celestialBody: 'EARTH', coordinateReferenceSystem: 'EPSG:4326', boundingBox: [36.7, -1.4, 37.0, -1.1] as [number, number, number, number] }; }

async function boot(storage: StorageModuleConfig = {}) {
  const kernel = createTestKernel();
  const storageModule = new StorageModule(storage);
  kernel.register(storageModule);
  kernel.register(new WorldModelModule());
  kernel.register(new TemporalEngineModule());
  kernel.register(new OrbitalIntelligenceModule());
  await kernel.boot();
  return {
    kernel,
    storage: storageModule,
    world: kernel.getModule<WorldModelModule>('world-model').getService(),
    temporal: kernel.getModule<TemporalEngineModule>('temporal-engine').getService(),
    service: kernel.getModule<OrbitalIntelligenceModule>('orbital-intelligence').getService(),
  };
}

async function authorizedSource(service: OrbitalIntelligenceService, providerId = 'provider-a', dataClasses: Array<'OPTICAL' | 'SAR'> = ['OPTICAL']) {
  const source = await service.registerSource(admin, {
    providerId,
    kind: 'SATELLITE_PROVIDER',
    source: `${providerId}-authorized-reference`,
    sensor: `${providerId}-sensor`,
    supportedDataClasses: dataClasses,
    requiredPermissions: ['read-observations'],
    licenseReference: `license:${providerId}`,
    provenance: provenance(providerId),
  });
  return service.recordSourceAuthorization(admin, source.id, {
    authorizationReference: `authorization:${providerId}:reference`, evidence: [evidence(`authorization-${providerId}`)], provenance: provenance(`authorization-${providerId}`),
  });
}

function encryptedReferenceCipher(id = 'test-reference-cipher') {
  const key = randomBytes(32);
  return {
    id,
    keyId: `${id}-key`,
    algorithm: 'AES_256_GCM' as const,
    async encrypt(plaintext: Uint8Array, additionalAuthenticatedData: Uint8Array) {
      const initializationVector = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, initializationVector);
      cipher.setAAD(Buffer.from(additionalAuthenticatedData));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
      return { ciphertext: new Uint8Array(ciphertext), initializationVector: new Uint8Array(initializationVector), authenticationTag: new Uint8Array(cipher.getAuthTag()) };
    },
  };
}

function providerAdapter(
  sourceId: string,
  providerId: string,
  counters: Record<string, number>,
  environment: 'sandbox' | 'production' = 'sandbox',
): ObservationProviderAdapter {
  return {
    id: `adapter-${providerId}-${environment}`,
    sourceId,
    providerId,
    kind: 'SATELLITE_PROVIDER',
    source: `${providerId}-authorized-reference`,
    sensor: `${providerId}-sensor`,
    environment,
    credentialReference: `secret://oie/${providerId}`,
    async connect(context) {
      assert.equal(context.credentialReference, `secret://oie/${providerId}`);
      counters.connect = (counters.connect ?? 0) + 1;
    },
    async authenticate() { counters.authenticate = (counters.authenticate ?? 0) + 1; },
    async capabilities() {
      counters.capabilities = (counters.capabilities ?? 0) + 1;
      return {
        providerId,
        kind: 'SATELLITE_PROVIDER',
        source: `${providerId}-authorized-reference`,
        sensor: `${providerId}-sensor`,
        supportedDataClasses: ['OPTICAL'],
        requiredPermissions: ['read-observations'],
        sandboxSupported: true,
        productionSupported: false,
        metadataIngestionSupported: true,
      };
    },
    async availability() {
      counters.availability = (counters.availability ?? 0) + 1;
      return { available: true, observedAt: now(), summary: 'Sandbox adapter availability only.' };
    },
    async disconnect() { counters.disconnect = (counters.disconnect ?? 0) + 1; },
  };
}

async function observation(
  service: OrbitalIntelligenceService,
  sourceId: string,
  overrides: Record<string, unknown> = {},
) {
  return service.recordObservation(operator, {
    sourceId,
    dataClass: 'OPTICAL',
    extent: extent(),
    acquisitionTime: now() - 10,
    processingTime: now(),
    resolution: 'metadata-declared-resolution',
    spectralProperties: ['metadata-only'],
    qualitySummary: 'Supplier-declared quality metadata; no independent sensor validation.',
    dataReference: 'content-addressed://authorized-observation-reference',
    contentHash: hash('a'),
    observationSummary: 'A bounded authorized-reference observation summary.',
    detectionSummaries: ['No target-identification claim is made.'],
    processingChain: ['supplier normalization declared by source'],
    epistemicStatus: 'OBSERVED',
    confidence: 75,
    evidence: [evidence(`observation-${sourceId}`)],
    provenance: provenance(`observation-${sourceId}`),
    ...overrides,
  } as Parameters<OrbitalIntelligenceService['recordObservation']>[1]);
}

describe('JATA Qi Orbital Intelligence Engine foundation', () => {
  it('has no source/provider access by default and rejects observation recording before a local authorization reference is recorded', async () => {
    const { kernel, service } = await boot();
    try {
      assert.deepEqual(await service.listSources(operator), []);
      const declared = await service.registerSource(admin, {
        providerId: 'declared-provider', kind: 'OPEN_DATA', source: 'declared-source', sensor: 'declared-sensor',
        supportedDataClasses: ['PUBLIC_GEOSPATIAL'], requiredPermissions: [], licenseReference: 'license:declared', provenance: provenance(),
      });
      await assert.rejects(() => observation(service, declared.id), OrbitalIntelligenceError);
      assert.equal(declared.status, 'DECLARED');
    } finally {
      await kernel.shutdown();
    }
  });

  it('records authorized-reference observation metadata with a hash chain and supports storage-only spatial/temporal queries', async () => {
    const { kernel, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const record = await observation(service, source.id);
      assert.equal(record.providerId, 'provider-a');
      assert.equal(record.epistemicStatus, 'OBSERVED');
      assert.equal(record.sequence, 1);
      assert.equal((await service.queryObservations(operator, { intersects: extent(), dataClasses: ['OPTICAL'] }))[0]?.id, record.id);
      assert.equal((await service.queryObservations(operator, { intersects: { ...extent(), boundingBox: [-10, -10, -9, -9] } })).length, 0);
      assert.deepEqual(await service.verifyObservationIntegrity(operator), { tenantId: 'acme', valid: true, observationCount: 1 });
    } finally {
      await kernel.shutdown();
    }
  });

  it('links a supplied observation to the existing tenant-bound World Model and Temporal Engine without copying raw sensor content', async () => {
    const { kernel, world, temporal, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const model = await world.createModel(operator, { name: 'Authorized observation world model' });
      const entity = await world.addEntity(operator, model.id, {
        type: 'region', name: 'Test region', epistemicStatus: 'OBSERVED', confidence: 90, provenance: provenance(),
      });
      const timeline = await temporal.createTimeline(operator, { name: 'Authorized observation timeline', worldModelId: model.id });
      const record = await observation(service, source.id, { worldModelId: model.id, worldEntityIds: [entity.id], timelineId: timeline.id });
      assert.ok(record.worldEventId);
      assert.ok(record.temporalEventId);
      const replay = await temporal.replay(operator, timeline.id);
      assert.equal(replay.length, 1);
      assert.equal(replay[0]?.payload.observationId, record.id);
      assert.equal(JSON.stringify(replay).includes('content-addressed://authorized-observation-reference'), false, 'only the content hash is sent to linked temporal state');
    } finally {
      await kernel.shutdown();
    }
  });

  it('requires independent providers for metadata fusion and keeps fusion/change outputs derived rather than observed facts', async () => {
    const { kernel, service } = await boot();
    try {
      const firstSource = await authorizedSource(service, 'provider-a', ['OPTICAL']);
      const secondSource = await authorizedSource(service, 'provider-b', ['SAR']);
      const baseline = await observation(service, firstSource.id, { acquisitionTime: now() - 1_000, processingTime: now() - 900, contentHash: hash('b') });
      const current = await observation(service, secondSource.id, { dataClass: 'SAR', acquisitionTime: now() - 100, processingTime: now(), contentHash: hash('c') });
      const fusion = await service.createFusionAssessment(operator, {
        observationIds: [baseline.id, current.id], interpretationSummary: 'Independent supplied observation metadata is consistent with a bounded change hypothesis.',
        epistemicStatus: 'DERIVED', confidence: 65, evidence: [evidence('fusion-evidence')], provenance: provenance(),
      });
      assert.equal(fusion.independentProviderCount, 2);
      assert.equal(fusion.epistemicStatus, 'DERIVED');
      const change = await service.compareObservations(operator, {
        baselineObservationId: baseline.id, currentObservationId: current.id, feature: 'reported vegetation index', baselineValue: 0.4, currentValue: 0.6,
        unit: 'index', confidence: 60, evidence: [evidence('change-evidence')], provenance: provenance(),
      });
      assert.equal(change.epistemicStatus, 'DERIVED');
      assert.ok(Math.abs(change.absoluteChange - 0.2) < 1e-12);
      assert.ok(Math.abs((change.relativeChange ?? 0) - 0.5) < 1e-12);
    } finally {
      await kernel.shutdown();
    }
  });

  it('registers an injected provider adapter without connecting, authenticating, retrieving data, or tasking a sensor', async () => {
    const { kernel, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const counters: Record<string, number> = {};
      const registration = await service.registerProviderAdapter(admin, providerAdapter(source.id, 'provider-a', counters));
      assert.equal(registration.state, 'REGISTERED');
      assert.equal(registration.runtimeAdapterAvailable, true);
      assert.equal(counters.connect ?? 0, 0);
      assert.equal(counters.authenticate ?? 0, 0);
      assert.equal(counters.capabilities ?? 0, 0);
      assert.equal(counters.availability ?? 0, 0);
    } finally {
      await kernel.shutdown();
    }
  });

  it('runs only an explicit sandbox contract probe and records no retrieval/tasking capability', async () => {
    const { kernel, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const counters: Record<string, number> = {};
      const registration = await service.registerProviderAdapter(admin, providerAdapter(source.id, 'provider-a', counters));
      const report = await service.runSandboxAdapterContract(admin, registration.id);
      assert.equal(report.status, 'PASSED');
      assert.equal(report.connect, 'PASSED');
      assert.equal(report.authenticate, 'PASSED');
      assert.equal(report.capabilities, 'PASSED');
      assert.equal(report.availability, 'PASSED');
      assert.equal(report.didNotRetrieveData, true);
      assert.equal(report.didNotTaskSensor, true);
      assert.equal(counters.connect, 1);
      assert.equal(counters.authenticate, 1);
      assert.equal(counters.capabilities, 1);
      assert.equal(counters.availability, 1);
      assert.equal(counters.disconnect, 1);
      assert.equal((await service.getProviderAdapterRegistration(admin, registration.id))?.state, 'SANDBOX_CONTRACT_PASSED');
    } finally {
      await kernel.shutdown();
    }
  });

  it('blocks production adapter probes without invoking an injected provider and marks stale runtime adapters unavailable after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-oie-adapter-'));
    try {
      const first = await boot({ driver: 'filesystem', fsRoot: root });
      const source = await authorizedSource(first.service);
      const productionCounters: Record<string, number> = {};
      const production = await first.service.registerProviderAdapter(admin, providerAdapter(source.id, 'provider-a', productionCounters, 'production'));
      const report = await first.service.runSandboxAdapterContract(admin, production.id);
      assert.equal(report.status, 'BLOCKED');
      assert.equal(productionCounters.connect ?? 0, 0);
      assert.equal(productionCounters.capabilities ?? 0, 0);
      await first.kernel.shutdown();

      const second = await boot({ driver: 'filesystem', fsRoot: root });
      assert.equal((await second.service.getProviderAdapterRegistration(admin, production.id))?.runtimeAdapterAvailable, false);
      const afterRestart = await second.service.runSandboxAdapterContract(admin, production.id);
      assert.equal(afterRestart.status, 'BLOCKED');
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('assesses locally recorded quality and returns REVIEW when a policy does not include a configured license-reference allowlist', async () => {
    const { kernel, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const record = await observation(service, source.id);
      const quality = await service.assessDataQuality(operator, record.id);
      assert.equal(quality.status, 'HIGH');
      assert.equal(quality.sourceAuthorizationCurrent, true);
      const policy = await service.createDataPolicy(admin, {
        name: 'Metadata-only review policy', provenance: provenance('quality-policy'),
      });
      const evaluation = await service.evaluateDataPolicy(operator, policy.id, record.id);
      assert.equal(evaluation.outcome, 'REVIEW');
      assert.equal(evaluation.doesNotGrantProviderAccess, true);
      assert.equal(evaluation.doesNotDetermineLicenseValidity, true);
      assert.ok(evaluation.checks.some((check) => check.name === 'license_reference' && check.outcome === 'REVIEW'));
    } finally {
      await kernel.shutdown();
    }
  });

  it('allows only configured local metadata while retaining privacy/freshness/authorization checks', async () => {
    const { kernel, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const record = await observation(service, source.id);
      const policy = await service.createDataPolicy(admin, {
        name: 'Approved metadata checklist',
        allowedSourceIds: [source.id],
        allowedProviderIds: ['provider-a'],
        allowedDataClasses: ['OPTICAL'],
        allowedLicenseReferences: ['license:provider-a'],
        requireCurrentSourceAuthorization: true,
        minimumObservationConfidence: 70,
        minimumEvidenceConfidence: 80,
        maximumObservationAgeMs: 60_000,
        allowedPrivacyClassifications: ['INTERNAL'],
        provenance: provenance('allow-policy'),
      });
      const allowed = await service.evaluateDataPolicy(operator, policy.id, record.id);
      assert.equal(allowed.outcome, 'LOCAL_ALLOW');
      const restricted = await observation(service, source.id, { contentHash: hash('e'), privacyClassification: 'RESTRICTED' });
      const blocked = await service.evaluateDataPolicy(operator, policy.id, restricted.id);
      assert.equal(blocked.outcome, 'BLOCK');
      assert.ok(blocked.checks.some((check) => check.name === 'privacy' && check.outcome === 'BLOCK'));
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists data policy, quality, and evaluation records across restart with tenant isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-oie-quality-'));
    try {
      const first = await boot({ driver: 'filesystem', fsRoot: root });
      const source = await authorizedSource(first.service);
      const record = await observation(first.service, source.id);
      const policy = await first.service.createDataPolicy(admin, {
        name: 'Persistent quality policy', allowedLicenseReferences: ['license:provider-a'], provenance: provenance('persistent-policy'),
      });
      const evaluation = await first.service.evaluateDataPolicy(operator, policy.id, record.id);
      await first.kernel.shutdown();

      const second = await boot({ driver: 'filesystem', fsRoot: root });
      assert.equal((await second.service.getDataPolicy(admin, policy.id))?.name, 'Persistent quality policy');
      assert.equal((await second.service.listDataQualityReports(operator, record.id)).length, 1);
      assert.equal((await second.service.listDataPolicyEvaluations(operator, policy.id, record.id))[0]?.id, evaluation.id);
      assert.equal((await second.service.listDataPolicies(other)).length, 0);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stores an encrypted opaque data reference through a local blob boundary without persisting or returning its plaintext locator', async () => {
    const { kernel, storage, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const cipher = encryptedReferenceCipher();
      const registration = await service.registerReferenceCipher(admin, cipher);
      const plaintextLocator = 'object-store://private-provider/opaque-object';
      const reference = await service.createEncryptedDataReference(operator, {
        sourceId: source.id, contentHash: hash('f'), referenceType: 'OBJECT_STORE', dataReference: plaintextLocator,
        cipherRegistrationId: registration.id, provenance: provenance('sealed-reference'),
      });
      assert.equal(reference.status, 'STORED_FOR_REVIEW');
      assert.equal(JSON.stringify(reference).includes(plaintextLocator), false);
      const blob = await storage.blobStore('orbital-intelligence.encrypted-reference-envelopes');
      const envelope = await blob.getAsText(reference.encryptedBlobKey);
      assert.ok(envelope);
      assert.equal(envelope!.includes(plaintextLocator), false);
      const integrity = await service.verifyEncryptedDataReference(operator, reference.id);
      assert.equal(integrity.status, 'VALID');
      assert.equal(integrity.cryptographicAuthenticationTagVerified, false, 'the metadata verifier intentionally never decrypts the locator');
      assert.deepEqual(await service.verifyEncryptedReferenceLedger(operator), { tenantId: 'acme', valid: true, referenceCount: 1 });
      const assessment = await service.assessEncryptedDataReference(operator, reference.id);
      assert.equal(assessment.outcome, 'REVIEW', 'no local policy evaluation is linked yet');
      assert.equal(assessment.doesNotRetrieveOrTransmitData, true);
      assert.equal(assessment.doesNotGrantProviderAccess, true);
      assert.equal((await service.verifyEncryptedReferenceLedger(operator)).valid, true);
    } finally {
      await kernel.shutdown();
    }
  });

  it('links an encrypted reference to a policy-evaluated observation without retaining the original data locator in the observation', async () => {
    const { kernel, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const registration = await service.registerReferenceCipher(admin, encryptedReferenceCipher('secure-observation-cipher'));
      const reference = await service.createEncryptedDataReference(operator, {
        sourceId: source.id, contentHash: hash('b'), referenceType: 'CONTENT_ADDRESS', dataReference: 'cas://private-observation-reference',
        cipherRegistrationId: registration.id, privacyClassification: 'INTERNAL', provenance: provenance('secure-observation-reference'),
      });
      const secureObservation = await observation(service, source.id, {
        dataReference: undefined, encryptedDataReferenceId: reference.id, contentHash: hash('b'),
      });
      assert.equal(secureObservation.dataReferenceStatus, 'ENCRYPTED_REFERENCE');
      assert.equal(secureObservation.dataReference, `sealed-reference:${reference.id}`);
      assert.equal(JSON.stringify(secureObservation).includes('cas://private-observation-reference'), false);
      const policy = await service.createDataPolicy(admin, {
        name: 'Secure reference local policy', allowedSourceIds: [source.id], allowedProviderIds: ['provider-a'],
        allowedDataClasses: ['OPTICAL'], allowedLicenseReferences: ['license:provider-a'],
        minimumObservationConfidence: 70, minimumEvidenceConfidence: 80, allowedPrivacyClassifications: ['INTERNAL'],
        provenance: provenance('secure-reference-policy'),
      });
      const evaluation = await service.evaluateDataPolicy(operator, policy.id, secureObservation.id);
      assert.equal(evaluation.outcome, 'LOCAL_ALLOW');
      const linked = await service.linkEncryptedReferencePolicyEvaluation(operator, reference.id, evaluation.id);
      assert.equal(linked.policyEvaluationId, evaluation.id, 'the policy evaluation link is retained on the reference');
      assert.equal(linked.status, 'REVIEW_REQUIRED', 'a local policy pass cannot verify provider authority or license validity');
      const assessment = await service.assessEncryptedDataReference(operator, reference.id);
      assert.equal(assessment.outcome, 'REVIEW', 'externally unverifiable authority/license caveats cap the assessment at REVIEW');
      const outcomes = new Map(assessment.checks.map((check) => [check.name, check.outcome]));
      assert.equal(outcomes.get('policy_evaluation'), 'PASS', 'the linked LOCAL_ALLOW policy evaluation is recognized');
      assert.equal(outcomes.get('privacy'), 'PASS', 'the allowlisted privacy classification is recognized');
      assert.equal(outcomes.get('integrity'), 'PASS', 'the local envelope integrity check passes');
      assert.equal(outcomes.get('source_authorization'), 'REVIEW', 'provider authorization remains externally unverified');
      assert.equal(outcomes.get('license_reference'), 'REVIEW', 'license validity remains externally unverified');
    } finally {
      await kernel.shutdown();
    }
  });

  it('detects encrypted-reference envelope corruption and blocks its local assessment without following the locator', async () => {
    const { kernel, storage, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const registration = await service.registerReferenceCipher(admin, encryptedReferenceCipher('corruption-cipher'));
      const reference = await service.createEncryptedDataReference(operator, {
        sourceId: source.id, contentHash: hash('c'), referenceType: 'ARCHIVE', dataReference: 'archive://private-reference',
        cipherRegistrationId: registration.id, provenance: provenance('corruption-reference'),
      });
      const blob = await storage.blobStore('orbital-intelligence.encrypted-reference-envelopes');
      await blob.put(reference.encryptedBlobKey, '{"format":"tampered"}', 'application/json');
      const integrity = await service.verifyEncryptedDataReference(operator, reference.id);
      assert.equal(integrity.status, 'CORRUPTED');
      const assessment = await service.assessEncryptedDataReference(operator, reference.id);
      assert.equal(assessment.outcome, 'BLOCK');
      assert.ok(assessment.checks.some((check) => check.name === 'integrity' && check.outcome === 'BLOCK'));
    } finally {
      await kernel.shutdown();
    }
  });

  it('creates monitoring and information-request plans as non-executing REVIEW or BLOCK records', async () => {
    const { kernel, service } = await boot();
    try {
      const source = await authorizedSource(service);
      const monitoring = await service.createMonitoringPlan(operator, {
        sourceId: source.id, dataClasses: ['OPTICAL'], extent: extent(), frequencyMs: 60_000,
        objective: 'Prepare a monitored observation plan without scheduling any provider request.', provenance: provenance('monitoring-plan'),
      });
      const information = await service.createInformationRequestPlan(operator, {
        sourceId: source.id, dataClasses: ['OPTICAL'], extent: extent(), from: now() - 60_000, until: now(),
        objective: 'Prepare a provider information request for human review only.', requiredEvidence: ['authorization-record'], provenance: provenance('information-plan'),
      });
      assert.equal(monitoring.state, 'REVIEW_REQUIRED');
      assert.equal(monitoring.doesNotScheduleOrRetrieveData, true);
      assert.equal(information.state, 'REVIEW_REQUIRED');
      assert.equal(information.doesNotRequestOrTransmitData, true);
      const declared = await service.registerSource(admin, {
        providerId: 'declared-provider', kind: 'OPEN_DATA', source: 'declared-source', sensor: 'declared-sensor',
        supportedDataClasses: ['PUBLIC_GEOSPATIAL'], requiredPermissions: [], licenseReference: 'license:declared', provenance: provenance('declared'),
      });
      const blocked = await service.createMonitoringPlan(operator, {
        sourceId: declared.id, dataClasses: ['PUBLIC_GEOSPATIAL'], extent: extent(), frequencyMs: 60_000,
        objective: 'This cannot schedule an unauthorized source.', provenance: provenance('blocked-monitoring'),
      });
      assert.equal(blocked.state, 'BLOCKED');
      assert.ok(blocked.reviewReasons.some((reason) => /authorization/i.test(reason)));
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists encrypted reference integrity metadata across restart while requiring explicit cipher re-registration and preserving tenant isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-oie-encrypted-reference-'));
    const cipher = encryptedReferenceCipher('persistent-reference-cipher');
    try {
      const first = await boot({ driver: 'filesystem', fsRoot: root });
      const source = await authorizedSource(first.service);
      const registration = await first.service.registerReferenceCipher(admin, cipher);
      const reference = await first.service.createEncryptedDataReference(operator, {
        sourceId: source.id, contentHash: hash('d'), referenceType: 'DATASET', dataReference: 'dataset://private-persistent-reference',
        cipherRegistrationId: registration.id, provenance: provenance('persistent-reference'),
      });
      await first.kernel.shutdown();

      const second = await boot({ driver: 'filesystem', fsRoot: root });
      assert.equal((await second.service.getReferenceCipherRegistration(admin, registration.id))?.runtimeCipherAvailable, false);
      assert.equal((await second.service.verifyEncryptedDataReference(operator, reference.id)).status, 'VALID');
      assert.equal(await second.service.getEncryptedDataReference(other, reference.id), undefined);
      await assert.rejects(() => second.service.verifyEncryptedDataReference(other, reference.id), OrbitalIntelligenceError);
      await assert.rejects(() => second.service.createEncryptedDataReference(operator, {
        sourceId: source.id, contentHash: hash('e'), referenceType: 'DATASET', dataReference: 'dataset://requires-cipher-rebind',
        cipherRegistrationId: registration.id, provenance: provenance('without-rebind'),
      }), OrbitalIntelligenceError);
      const rebound = await second.service.registerReferenceCipher(admin, cipher);
      assert.equal(rebound.id, registration.id);
      assert.equal(rebound.runtimeCipherAvailable, true);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists sources and observations across filesystem restart while retaining tenant isolation and source disablement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-oie-'));
    try {
      const first = await boot({ driver: 'filesystem', fsRoot: root });
      const source = await authorizedSource(first.service);
      const record = await observation(first.service, source.id);
      await first.kernel.shutdown();

      const second = await boot({ driver: 'filesystem', fsRoot: root });
      assert.equal((await second.service.getSource(operator, source.id))?.status, 'AUTHORIZED_REFERENCE_RECORDED');
      assert.equal((await second.service.getObservation(operator, record.id))?.contentHash, record.contentHash);
      assert.equal(await second.service.getObservation(other, record.id), undefined);
      await second.service.disableSource(admin, source.id, 'Controlled source disablement.');
      await assert.rejects(() => observation(second.service, source.id), OrbitalIntelligenceError);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
