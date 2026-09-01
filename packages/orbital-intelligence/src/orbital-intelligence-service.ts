import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { IBlobStore, ICollection } from '@jataqi/storage';
import { WorldModelModule } from '@jataqi/world-model';
import type { WorldModelService } from '@jataqi/world-model';
import { TemporalEngineModule } from '@jataqi/temporal-engine';
import type { TemporalEngineService } from '@jataqi/temporal-engine';
import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import {
  OrbitalIntelligenceEvents,
  type CompareOrbitalObservationsInput,
  type CreateEncryptedDataReferenceInput,
  type CreateOrbitalDataPolicyInput,
  type CreateOrbitalFusionAssessmentInput,
  type CreateOrbitalInformationRequestPlanInput,
  type CreateOrbitalMonitoringPlanInput,
  type GeospatialExtent,
  type EncryptedDataReference,
  type EncryptedDataReferenceAssessment,
  type EncryptedDataReferenceCipher,
  type EncryptedReferenceCipherRegistration,
  type EncryptedDataReferenceIntegrity,
  type EncryptedDataReferenceLedgerIntegrity,
  type OrbitalInformationRequestPlan,
  type OrbitalMonitoringPlan,
  type OiePlanState,
  type ObservationDataClass,
  type ObservationProviderAdapter,
  type ObservationProviderCapabilities,
  type ObservationProviderKind,
  type ObservationSourceStatus,
  type OrbitalAdapterContractState,
  type OrbitalChangeAssessment,
  type OrbitalDataPolicy,
  type OrbitalDataPolicyCheck,
  type OrbitalDataPolicyEvaluation,
  type OrbitalDataPolicyOutcome,
  type OrbitalDataQualityReport,
  type OrbitalEpistemicStatus,
  type OrbitalFusionAssessment,
  type OrbitalObservation,
  type OrbitalObservationIntegrityResult,
  type OrbitalObservationQuery,
  type OrbitalObservationSource,
  type OrbitalProviderAdapterRegistration,
  type OrbitalProviderContext,
  type OrbitalProviderContractReport,
  type RecordOrbitalObservationInput,
  type RecordOrbitalSourceAuthorizationInput,
  type RegisterOrbitalObservationSourceInput,
} from './types.js';

const SOURCES_COLLECTION = 'orbital-intelligence.sources';
const ADAPTER_REGISTRATIONS_COLLECTION = 'orbital-intelligence.adapter-registrations';
const ADAPTER_CONTRACT_REPORTS_COLLECTION = 'orbital-intelligence.adapter-contract-reports';
const DATA_POLICIES_COLLECTION = 'orbital-intelligence.data-policies';
const DATA_QUALITY_REPORTS_COLLECTION = 'orbital-intelligence.data-quality-reports';
const DATA_POLICY_EVALUATIONS_COLLECTION = 'orbital-intelligence.data-policy-evaluations';
const ENCRYPTED_REFERENCE_CIPHERS_COLLECTION = 'orbital-intelligence.encrypted-reference-ciphers';
const ENCRYPTED_REFERENCES_COLLECTION = 'orbital-intelligence.encrypted-references';
const ENCRYPTED_REFERENCE_ASSESSMENTS_COLLECTION = 'orbital-intelligence.encrypted-reference-assessments';
const MONITORING_PLANS_COLLECTION = 'orbital-intelligence.monitoring-plans';
const INFORMATION_REQUEST_PLANS_COLLECTION = 'orbital-intelligence.information-request-plans';
const ENCRYPTED_REFERENCES_BLOB_STORE = 'orbital-intelligence.encrypted-reference-envelopes';
const OBSERVATIONS_COLLECTION = 'orbital-intelligence.observations';
const FUSIONS_COLLECTION = 'orbital-intelligence.fusions';
const CHANGES_COLLECTION = 'orbital-intelligence.changes';
const MAX_LIST_ITEMS = 50;
const MAX_EVIDENCE = 100;
const SANDBOX_CONTRACT_TIMEOUT_MS = 10_000;
const PROVIDER_KINDS = new Set<ObservationProviderKind>(['SATELLITE_PROVIDER', 'SENSOR_PROVIDER', 'GEOSPATIAL_PROVIDER', 'WEATHER_PROVIDER', 'MARINE_PROVIDER', 'AVIATION_PROVIDER', 'GROUND_SENSOR', 'OPEN_DATA', 'CUSTOM_MISSION']);
const DATA_CLASSES = new Set<ObservationDataClass>([
  'OPTICAL', 'MULTISPECTRAL', 'HYPERSPECTRAL', 'SAR', 'THERMAL', 'RADAR_DERIVED', 'LIDAR_DERIVED', 'WEATHER', 'OCEANOGRAPHIC', 'ELEVATION', 'LAND_COVER', 'VEGETATION', 'SOIL_MOISTURE', 'AIS', 'ADS_B', 'GNSS_DERIVED', 'PUBLIC_GEOSPATIAL', 'GROUND_SENSOR', 'IOT', 'INFRASTRUCTURE', 'ECONOMIC', 'OPEN_SOURCE', 'USER_AUTHORIZED', 'OTHER',
]);
const EPISTEMIC_STATUSES = new Set<OrbitalEpistemicStatus>(['OBSERVED', 'DERIVED', 'INFERRED', 'PREDICTED', 'UNKNOWN', 'CONFLICTING']);
const FUSION_STATUSES = new Set<OrbitalFusionAssessment['epistemicStatus']>(['DERIVED', 'INFERRED', 'UNKNOWN', 'CONFLICTING']);
const PRIVACY_CLASSIFICATIONS = new Set<PrivacyClassification>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PERSONAL_DATA']);
const EVIDENCE_STATUSES = new Set<CommercialEvidence['status']>([
  'UNVERIFIED', 'PARTIAL', 'OBSERVED', 'MEASURED', 'CUSTOMER_CONFIRMED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED',
  'ESTIMATED', 'ASSUMPTION', 'PREDICTION', 'STALE', 'CONFLICTING', 'UNAVAILABLE',
]);

export class OrbitalIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrbitalIntelligenceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Provider-neutral, metadata-only Orbital Intelligence Engine foundation.
 * It records only authorized-reference observation metadata and does not connect
 * to satellite feeds, access classified/restricted systems, task sensors, run
 * computer vision, identify targets, track people, send alerts, or control any
 * physical system.
 */
export class OrbitalIntelligenceService {
  private api!: KernelApi;
  private world!: WorldModelService;
  private temporal!: TemporalEngineService;
  private sources!: ICollection<OrbitalObservationSource>;
  private adapterRegistrations!: ICollection<OrbitalProviderAdapterRegistration>;
  private adapterContractReports!: ICollection<OrbitalProviderContractReport>;
  private dataPolicies!: ICollection<OrbitalDataPolicy>;
  private dataQualityReports!: ICollection<OrbitalDataQualityReport>;
  private dataPolicyEvaluations!: ICollection<OrbitalDataPolicyEvaluation>;
  private referenceCipherRegistrations!: ICollection<EncryptedReferenceCipherRegistration>;
  private encryptedReferences!: ICollection<EncryptedDataReference>;
  private encryptedReferenceAssessments!: ICollection<EncryptedDataReferenceAssessment>;
  private monitoringPlans!: ICollection<OrbitalMonitoringPlan>;
  private informationRequestPlans!: ICollection<OrbitalInformationRequestPlan>;
  private encryptedReferenceBlobs!: IBlobStore;
  private observations!: ICollection<OrbitalObservation>;
  private fusions!: ICollection<OrbitalFusionAssessment>;
  private readonly adapters = new Map<string, ObservationProviderAdapter>();
  private readonly referenceCiphers = new Map<string, EncryptedDataReferenceCipher>();
  private changes!: ICollection<OrbitalChangeAssessment>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.sources = await storage.collection<OrbitalObservationSource>(SOURCES_COLLECTION);
    this.adapterRegistrations = await storage.collection<OrbitalProviderAdapterRegistration>(ADAPTER_REGISTRATIONS_COLLECTION);
    this.adapterContractReports = await storage.collection<OrbitalProviderContractReport>(ADAPTER_CONTRACT_REPORTS_COLLECTION);
    this.dataPolicies = await storage.collection<OrbitalDataPolicy>(DATA_POLICIES_COLLECTION);
    this.dataQualityReports = await storage.collection<OrbitalDataQualityReport>(DATA_QUALITY_REPORTS_COLLECTION);
    this.dataPolicyEvaluations = await storage.collection<OrbitalDataPolicyEvaluation>(DATA_POLICY_EVALUATIONS_COLLECTION);
    this.referenceCipherRegistrations = await storage.collection<EncryptedReferenceCipherRegistration>(ENCRYPTED_REFERENCE_CIPHERS_COLLECTION);
    this.encryptedReferences = await storage.collection<EncryptedDataReference>(ENCRYPTED_REFERENCES_COLLECTION);
    this.encryptedReferenceAssessments = await storage.collection<EncryptedDataReferenceAssessment>(ENCRYPTED_REFERENCE_ASSESSMENTS_COLLECTION);
    this.monitoringPlans = await storage.collection<OrbitalMonitoringPlan>(MONITORING_PLANS_COLLECTION);
    this.informationRequestPlans = await storage.collection<OrbitalInformationRequestPlan>(INFORMATION_REQUEST_PLANS_COLLECTION);
    this.encryptedReferenceBlobs = await storage.blobStore(ENCRYPTED_REFERENCES_BLOB_STORE);
    this.observations = await storage.collection<OrbitalObservation>(OBSERVATIONS_COLLECTION);
    this.fusions = await storage.collection<OrbitalFusionAssessment>(FUSIONS_COLLECTION);
    this.changes = await storage.collection<OrbitalChangeAssessment>(CHANGES_COLLECTION);
    this.world = kernel.getModule<WorldModelModule>('world-model').getService();
    this.temporal = kernel.getModule<TemporalEngineModule>('temporal-engine').getService();
    // Adapter implementations are in-process code and cannot survive restart.
    // Persisted descriptors are therefore explicitly marked unavailable until
    // the host re-registers an adapter; no stale connection is implied.
    for (const registration of await this.adapterRegistrations.all()) {
      if (registration.runtimeAdapterAvailable) {
        await this.adapterRegistrations.put({ ...registration, runtimeAdapterAvailable: false, updatedAt: Date.now() });
      }
    }
    // Cipher implementations are likewise in-process only. Persisted metadata
    // must not imply that an encryption key/cipher is available after restart.
    for (const registration of await this.referenceCipherRegistrations.all()) {
      if (registration.runtimeCipherAvailable) {
        await this.referenceCipherRegistrations.put({ ...registration, runtimeCipherAvailable: false, state: 'RUNTIME_UNAVAILABLE', updatedAt: Date.now() });
      }
    }
  }

  /** Register metadata for a potential source. Registration never connects to a provider. */
  async registerSource(actor: CommercialActor, input: RegisterOrbitalObservationSourceInput): Promise<OrbitalObservationSource> {
    assertAdministrator(actor);
    validateSourceInput(input);
    const now = Date.now();
    const source: OrbitalObservationSource = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      providerId: cleanText(input.providerId, 'Observation provider id', 180),
      kind: input.kind,
      source: cleanText(input.source, 'Observation source', 240),
      sensor: cleanText(input.sensor, 'Observation sensor', 240),
      supportedDataClasses: dataClasses(input.supportedDataClasses),
      requiredPermissions: textList(input.requiredPermissions, 'Required provider permissions', MAX_LIST_ITEMS, 180),
      licenseReference: cleanText(input.licenseReference, 'Source license reference', 640),
      provenance: sanitizeProvenance(input.provenance),
      status: 'DECLARED',
      createdAt: now,
      updatedAt: now,
    };
    await this.sources.put(source);
    await this.api.bus.emit(OrbitalIntelligenceEvents.SourceRegistered, {
      sourceId: source.id, tenantId: source.tenantId, providerId: source.providerId, kind: source.kind,
      status: source.status, doesNotConnectProvider: true,
    });
    return copy(source);
  }

  /**
   * Store an upstream authorization reference and evidence. This changes only
   * local registry state; it does not independently authenticate a provider.
   */
  async recordSourceAuthorization(actor: CommercialActor, sourceId: string, input: RecordOrbitalSourceAuthorizationInput): Promise<OrbitalObservationSource> {
    assertAdministrator(actor);
    validateSourceAuthorizationInput(input);
    const source = await this.requireSourceForActor(actor, sourceId);
    const now = Date.now();
    const updated: OrbitalObservationSource = {
      ...source,
      authorizationReference: cleanText(input.authorizationReference, 'Source authorization reference', 640),
      authorizationExpiresAt: optionalFutureTime(input.expiresAt, 'Source authorization expiry', now),
      authorizationEvidence: sanitizeEvidence(input.evidence),
      authorizationProvenance: sanitizeProvenance(input.provenance),
      status: 'AUTHORIZED_REFERENCE_RECORDED',
      updatedAt: now,
    };
    await this.sources.put(updated);
    await this.api.bus.emit(OrbitalIntelligenceEvents.SourceAuthorized, {
      sourceId: updated.id, tenantId: updated.tenantId, providerId: updated.providerId,
      status: updated.status, authorizationExpiresAt: updated.authorizationExpiresAt,
      doesNotIndependentlyVerifyProviderAuthorization: true,
    });
    return copy(updated);
  }

  /** Locally disable a source and block new observation recording from it. */
  async disableSource(actor: CommercialActor, sourceId: string, reason: string): Promise<OrbitalObservationSource> {
    assertAdministrator(actor);
    const source = await this.requireSourceForActor(actor, sourceId);
    const updated: OrbitalObservationSource = { ...source, status: 'DISABLED', updatedAt: Date.now() };
    await this.sources.put(updated);
    await this.api.bus.emit(OrbitalIntelligenceEvents.SourceDisabled, {
      sourceId: updated.id, tenantId: updated.tenantId, providerId: updated.providerId,
      status: updated.status, reason: cleanText(reason, 'Source disable reason', 640),
    });
    return copy(updated);
  }

  /**
   * Register an injected provider adapter in disabled/no-call state. The code
   * object remains memory-only, and registration never connects, authenticates,
   * retrieves data, tasks a sensor, or invokes a production provider.
   */
  async registerProviderAdapter(actor: CommercialActor, adapterInput: ObservationProviderAdapter): Promise<OrbitalProviderAdapterRegistration> {
    assertAdministrator(actor);
    const adapter = normalizeAdapter(adapterInput);
    const source = await this.requireSourceForActor(actor, adapter.sourceId);
    assertAdapterMatchesSource(adapter, source);
    if (this.adapters.has(adapter.id)) throw new OrbitalIntelligenceError(`Orbital provider adapter ${adapter.id} is already registered.`);
    const existing = await this.adapterRegistrations.query({ where: (registration) => registration.tenantId === source.tenantId && (registration.adapterId === adapter.id || registration.sourceId === source.id), limit: 1 });
    if (existing[0]) throw new OrbitalIntelligenceError(`An orbital provider adapter registration already exists for source ${source.id}.`);
    const now = Date.now();
    const registration: OrbitalProviderAdapterRegistration = {
      id: randomUUID(), tenantId: source.tenantId, sourceId: source.id, adapterId: adapter.id, environment: adapter.environment,
      credentialReference: adapter.credentialReference, state: 'REGISTERED', runtimeAdapterAvailable: true,
      registeredAt: now, createdAt: now, updatedAt: now,
    };
    this.adapters.set(registration.id, adapter);
    await this.adapterRegistrations.put(registration);
    await this.api.bus.emit(OrbitalIntelligenceEvents.AdapterRegistered, {
      registrationId: registration.id, sourceId: registration.sourceId, tenantId: registration.tenantId,
      adapterId: registration.adapterId, environment: registration.environment, doesNotConnectProvider: true,
    });
    return copy(registration);
  }

  /**
   * Run a bounded, explicit sandbox-only adapter contract probe. It may call
   * injected connect/authenticate/capability/availability functions, but never
   * retrieves observation data, tasks a sensor, or runs against production.
   */
  async runSandboxAdapterContract(actor: CommercialActor, registrationId: string): Promise<OrbitalProviderContractReport> {
    assertAdministrator(actor);
    const registration = await this.requireAdapterRegistration(actor, registrationId);
    const now = Date.now();
    const source = await this.requireSourceForActor(actor, registration.sourceId);
    const adapter = this.adapters.get(registration.id);
    if (registration.environment !== 'sandbox') {
      return this.saveContractReport(registration, {
        source, now, status: 'BLOCKED', connect: 'BLOCKED', authenticate: 'BLOCKED', capabilities: 'BLOCKED', availability: 'BLOCKED',
        reasons: ['Production adapter contracts are intentionally disabled by this package.'],
      });
    }
    if (!adapter || !registration.runtimeAdapterAvailable) {
      return this.saveContractReport(registration, {
        source, now, status: 'BLOCKED', connect: 'BLOCKED', authenticate: 'BLOCKED', capabilities: 'BLOCKED', availability: 'BLOCKED',
        reasons: ['Injected runtime adapter is unavailable; re-register it in the current process before testing.'],
      });
    }
    if (source.status !== 'AUTHORIZED_REFERENCE_RECORDED' || !source.authorizationReference || isExpired(source.authorizationExpiresAt, now)) {
      return this.saveContractReport(registration, {
        source, now, status: 'BLOCKED', connect: 'BLOCKED', authenticate: 'BLOCKED', capabilities: 'BLOCKED', availability: 'BLOCKED',
        reasons: ['Source lacks a current locally recorded authorization reference.'],
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SANDBOX_CONTRACT_TIMEOUT_MS);
    const context: OrbitalProviderContext = {
      tenantId: source.tenantId, sourceId: source.id, environment: 'sandbox', credentialReference: registration.credentialReference, signal: controller.signal,
    };
    let connect: OrbitalProviderContractReport['connect'] = adapter.connect ? 'BLOCKED' : 'NOT_APPLICABLE';
    let authenticate: OrbitalProviderContractReport['authenticate'] = adapter.authenticate ? 'BLOCKED' : 'NOT_APPLICABLE';
    let capabilities: OrbitalProviderContractReport['capabilities'] = 'BLOCKED';
    let availability: OrbitalProviderContractReport['availability'] = 'BLOCKED';
    let capability: ObservationProviderCapabilities | undefined;
    let availabilityReport: OrbitalProviderContractReport['availabilityReport'];
    const reasons: string[] = [];
    try {
      if (adapter.connect) {
        await withTimeout(adapter.connect(context), controller.signal);
        connect = 'PASSED';
      }
      if (adapter.authenticate) {
        await withTimeout(adapter.authenticate(context), controller.signal);
        authenticate = 'PASSED';
      }
      capability = await withTimeout(adapter.capabilities(context), controller.signal);
      validateAdapterCapabilities(capability, adapter, source);
      capability = sanitizeProviderCapabilities(capability);
      capabilities = 'PASSED';
      availabilityReport = await withTimeout(adapter.availability(context), controller.signal);
      validateAvailabilityReport(availabilityReport);
      availabilityReport = sanitizeAvailabilityReport(availabilityReport);
      availability = availabilityReport.available ? 'PASSED' : 'FAILED';
      if (!availabilityReport.available) reasons.push('Sandbox adapter reported unavailable.');
    } catch (error) {
      const summary = safeError(error);
      if (connect === 'BLOCKED' && adapter.connect) connect = 'FAILED';
      else if (authenticate === 'BLOCKED' && adapter.authenticate) authenticate = 'FAILED';
      else if (capabilities === 'BLOCKED') capabilities = 'FAILED';
      else availability = 'FAILED';
      reasons.push(summary);
    } finally {
      clearTimeout(timeout);
      try {
        await adapter.disconnect?.(context);
      } catch (error) {
        reasons.push(`Sandbox disconnect failed: ${safeError(error)}`);
      }
    }
    const status = connect !== 'FAILED' && authenticate !== 'FAILED' && capabilities === 'PASSED' && availability === 'PASSED' ? 'PASSED' : 'FAILED';
    return this.saveContractReport(registration, { source, now, status, connect, authenticate, capabilities, availability, capability, availabilityReport, reasons });
  }

  /** Remove an injected adapter from the active process; historic reports remain stored. */
  async unregisterProviderAdapter(actor: CommercialActor, registrationId: string): Promise<OrbitalProviderAdapterRegistration> {
    assertAdministrator(actor);
    const registration = await this.requireAdapterRegistration(actor, registrationId);
    this.adapters.delete(registration.id);
    const updated: OrbitalProviderAdapterRegistration = { ...registration, runtimeAdapterAvailable: false, state: 'UNAVAILABLE', updatedAt: Date.now() };
    await this.adapterRegistrations.put(updated);
    await this.api.bus.emit(OrbitalIntelligenceEvents.AdapterUnregistered, {
      registrationId: updated.id, sourceId: updated.sourceId, tenantId: updated.tenantId, adapterId: updated.adapterId,
    });
    return copy(updated);
  }

  /** Configure an explicit tenant-local data-use policy; it does not interpret a license or grant source access. */
  async createDataPolicy(actor: CommercialActor, input: CreateOrbitalDataPolicyInput): Promise<OrbitalDataPolicy> {
    assertAdministrator(actor);
    validateDataPolicyInput(input);
    const now = Date.now();
    const policy: OrbitalDataPolicy = {
      id: randomUUID(), tenantId: actor.tenantId, name: cleanText(input.name, 'Orbital data policy name', 240),
      allowedSourceIds: optionalUniqueIds(input.allowedSourceIds, 'Allowed source ids'),
      allowedProviderIds: optionalTextList(input.allowedProviderIds, 'Allowed provider ids', MAX_LIST_ITEMS, 180),
      allowedDataClasses: input.allowedDataClasses ? dataClasses(input.allowedDataClasses) : undefined,
      allowedLicenseReferences: optionalTextList(input.allowedLicenseReferences, 'Allowed license references', MAX_LIST_ITEMS, 640),
      requireCurrentSourceAuthorization: input.requireCurrentSourceAuthorization ?? true,
      minimumObservationConfidence: input.minimumObservationConfidence,
      minimumEvidenceConfidence: input.minimumEvidenceConfidence,
      maximumObservationAgeMs: input.maximumObservationAgeMs,
      allowedPrivacyClassifications: input.allowedPrivacyClassifications ? privacyClassifications(input.allowedPrivacyClassifications) : undefined,
      status: input.active === false ? 'DISABLED' : 'ACTIVE', createdByActorId: actor.id,
      provenance: sanitizeProvenance(input.provenance), createdAt: now, updatedAt: now,
    };
    await this.dataPolicies.put(policy);
    await this.api.bus.emit(OrbitalIntelligenceEvents.DataPolicyCreated, {
      policyId: policy.id, tenantId: policy.tenantId, status: policy.status, requiresCurrentSourceAuthorization: policy.requireCurrentSourceAuthorization,
    });
    return copy(policy);
  }

  async setDataPolicyActive(actor: CommercialActor, policyId: string, active: boolean): Promise<OrbitalDataPolicy> {
    assertAdministrator(actor);
    const policy = await this.requireDataPolicy(actor, policyId);
    const updated: OrbitalDataPolicy = { ...policy, status: active ? 'ACTIVE' : 'DISABLED', updatedAt: Date.now() };
    await this.dataPolicies.put(updated);
    return copy(updated);
  }

  /** Assess locally recorded metadata quality; it does not validate source data or legal rights externally. */
  async assessDataQuality(actor: CommercialActor, observationId: string): Promise<OrbitalDataQualityReport> {
    assertOperator(actor);
    const observation = await this.requireObservation(actor, observationId);
    const source = await this.requireSourceForActor(actor, observation.sourceId);
    const now = Date.now();
    const authorizationCurrent = source.status === 'AUTHORIZED_REFERENCE_RECORDED' && Boolean(source.authorizationReference) && !isExpired(source.authorizationExpiresAt, now);
    const averageEvidenceConfidence = observation.evidence.length
      ? round(observation.evidence.reduce((sum, evidence) => sum + evidence.confidence, 0) / observation.evidence.length)
      : 0;
    const observationAgeMs = Math.max(0, now - observation.acquisitionTime);
    const limitations: string[] = [
      'Quality is calculated from locally supplied metadata and does not inspect raw observation bytes.',
      'A recorded authorization reference is not independent verification of provider permission or license validity.',
    ];
    if (observation.epistemicStatus !== 'OBSERVED') limitations.push(`Observation epistemic status is ${observation.epistemicStatus}, not a directly observed fact.`);
    if (!authorizationCurrent) limitations.push('Source authorization reference is missing, disabled, or expired.');
    if (!source.licenseReference) limitations.push('Source license reference is missing.');
    const status: OrbitalDataQualityReport['status'] = !authorizationCurrent || !source.licenseReference || observation.evidence.length === 0
      ? 'INSUFFICIENT_METADATA'
      : observation.confidence < 40 || averageEvidenceConfidence < 40
        ? 'LOW'
        : observation.confidence < 70 || averageEvidenceConfidence < 70
          ? 'MODERATE'
          : 'HIGH';
    const report: OrbitalDataQualityReport = {
      id: randomUUID(), tenantId: observation.tenantId, observationId: observation.id, sourceId: source.id,
      assessedAt: now, observationAgeMs, sourceAuthorizationCurrent: authorizationCurrent, licenseReferenceRecorded: Boolean(source.licenseReference),
      evidenceCount: observation.evidence.length, averageEvidenceConfidence, observationConfidence: observation.confidence,
      status, limitations, createdAt: now,
    };
    await this.dataQualityReports.put(report);
    return copy(report);
  }

  /** Evaluate one active local data-use policy against one stored observation; no provider access/rights are granted. */
  async evaluateDataPolicy(actor: CommercialActor, policyId: string, observationId: string): Promise<OrbitalDataPolicyEvaluation> {
    assertOperator(actor);
    const policy = await this.requireDataPolicy(actor, policyId);
    if (policy.status !== 'ACTIVE') throw new OrbitalIntelligenceError('Only ACTIVE orbital data policies can be evaluated.');
    const observation = await this.requireObservation(actor, observationId);
    const source = await this.requireSourceForActor(actor, observation.sourceId);
    const quality = await this.assessDataQuality(actor, observation.id);
    const checks = evaluateDataPolicyChecks(policy, observation, source, quality);
    const outcome: OrbitalDataPolicyOutcome = checks.some((check) => check.outcome === 'BLOCK')
      ? 'BLOCK'
      : checks.some((check) => check.outcome === 'REVIEW')
        ? 'REVIEW'
        : 'LOCAL_ALLOW';
    const evaluation: OrbitalDataPolicyEvaluation = {
      id: randomUUID(), tenantId: observation.tenantId, policyId: policy.id, observationId: observation.id, qualityReportId: quality.id,
      outcome, checks, reason: policyEvaluationReason(outcome, checks), doesNotGrantProviderAccess: true, doesNotDetermineLicenseValidity: true, createdAt: Date.now(),
    };
    await this.dataPolicyEvaluations.put(evaluation);
    await this.api.bus.emit(OrbitalIntelligenceEvents.DataPolicyEvaluated, {
      evaluationId: evaluation.id, policyId: evaluation.policyId, observationId: evaluation.observationId, tenantId: evaluation.tenantId,
      outcome: evaluation.outcome, doesNotGrantProviderAccess: true, doesNotDetermineLicenseValidity: true,
    });
    return copy(evaluation);
  }

  /**
   * Register a host-injected encryption boundary. The cipher object remains
   * memory-only; no key material, decrypt function, or plaintext reference is
   * persisted by this registry.
   */
  async registerReferenceCipher(actor: CommercialActor, cipherInput: EncryptedDataReferenceCipher): Promise<EncryptedReferenceCipherRegistration> {
    assertAdministrator(actor);
    const cipher = normalizeReferenceCipher(cipherInput);
    if (this.referenceCiphers.has(cipher.id)) throw new OrbitalIntelligenceError(`Encrypted reference cipher ${cipher.id} is already registered.`);
    const existing = await this.referenceCipherRegistrations.query({ where: (registration) => registration.tenantId === actor.tenantId && (registration.cipherId === cipher.id || registration.keyId === cipher.keyId), limit: 1 });
    const now = Date.now();
    if (existing[0]) {
      const prior = existing[0];
      if (prior.cipherId !== cipher.id || prior.keyId !== cipher.keyId || prior.algorithm !== cipher.algorithm) {
        throw new OrbitalIntelligenceError('An encrypted-reference cipher registration conflicts with this cipher or key id.');
      }
      const rebound: EncryptedReferenceCipherRegistration = { ...prior, state: 'REGISTERED', runtimeCipherAvailable: true, updatedAt: now };
      this.referenceCiphers.set(rebound.id, cipher);
      await this.referenceCipherRegistrations.put(rebound);
      await this.api.bus.emit(OrbitalIntelligenceEvents.ReferenceCipherRegistered, {
        registrationId: rebound.id, tenantId: rebound.tenantId, cipherId: rebound.cipherId,
        keyId: rebound.keyId, algorithm: rebound.algorithm, reboundAfterRestart: true, doesNotExposeKeyMaterial: true,
      });
      return copy(rebound);
    }
    const registration: EncryptedReferenceCipherRegistration = {
      id: randomUUID(), tenantId: actor.tenantId, cipherId: cipher.id, keyId: cipher.keyId, algorithm: cipher.algorithm,
      state: 'REGISTERED', runtimeCipherAvailable: true, registeredAt: now, createdAt: now, updatedAt: now,
    };
    this.referenceCiphers.set(registration.id, cipher);
    await this.referenceCipherRegistrations.put(registration);
    await this.api.bus.emit(OrbitalIntelligenceEvents.ReferenceCipherRegistered, {
      registrationId: registration.id, tenantId: registration.tenantId, cipherId: registration.cipherId,
      keyId: registration.keyId, algorithm: registration.algorithm, doesNotExposeKeyMaterial: true,
    });
    return copy(registration);
  }

  /**
   * Encrypt and locally store only an opaque data locator envelope. The method
   * never accesses, retrieves, tasks, validates, or transmits the referenced
   * provider data. Plaintext is passed directly to the injected cipher and is
   * deliberately absent from returned/persisted metadata.
   */
  async createEncryptedDataReference(actor: CommercialActor, input: CreateEncryptedDataReferenceInput): Promise<EncryptedDataReference> {
    assertOperator(actor);
    validateEncryptedReferenceInput(input);
    const source = await this.requireSourceForActor(actor, input.sourceId);
    const now = Date.now();
    if (!hasCurrentSourceAuthorization(source, now)) {
      throw new OrbitalIntelligenceError('Encrypted data reference requires a source with a current locally recorded authorization reference.');
    }
    const registration = await this.requireReferenceCipherRegistration(actor, input.cipherRegistrationId);
    const cipher = this.referenceCiphers.get(registration.id);
    if (!cipher || !registration.runtimeCipherAvailable || registration.state !== 'REGISTERED') {
      throw new OrbitalIntelligenceError('Encrypted reference cipher is unavailable in this runtime; register an approved host cipher before creating a reference.');
    }
    const id = randomUUID();
    const contentHash = normalizeDigest(input.contentHash, 'Encrypted reference content hash');
    const plaintextReference = cleanText(input.dataReference, 'Encrypted data reference', 2_000);
    const aad = canonicalReferenceAad(actor.tenantId, source.id, id, contentHash);
    const encrypted = await cipher.encrypt(new TextEncoder().encode(plaintextReference), new TextEncoder().encode(aad));
    validateEncryptedEnvelope(encrypted, plaintextReference);
    const envelope: StoredEncryptedReferenceEnvelope = {
      format: 'OIE_ENCRYPTED_DATA_REFERENCE', version: 1, algorithm: cipher.algorithm, cipherId: cipher.id, keyId: cipher.keyId,
      initializationVector: toBase64(encrypted.initializationVector), authenticationTag: toBase64(encrypted.authenticationTag),
      ciphertext: toBase64(encrypted.ciphertext), additionalAuthenticatedDataHash: digestText(aad),
    };
    const blobKey = `reference:${id}`;
    const ciphertextHash = digestBytes(encrypted.ciphertext);
    try {
      await this.encryptedReferenceBlobs.put(blobKey, JSON.stringify(envelope), 'application/json');
      const previous = (await this.encryptedReferences.query({ where: (reference) => reference.tenantId === actor.tenantId, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
      const draft: Omit<EncryptedDataReference, 'hash'> = {
        id, tenantId: actor.tenantId, sequence: (previous?.sequence ?? 0) + 1, previousHash: previous?.hash ?? 'GENESIS',
        sourceId: source.id, contentHash, referenceType: input.referenceType,
        cipherRegistrationId: registration.id, cipherKeyId: registration.keyId, algorithm: registration.algorithm,
        encryptedBlobKey: blobKey, ciphertextHash, additionalAuthenticatedDataHash: envelope.additionalAuthenticatedDataHash,
        referenceHash: digestText(`${actor.tenantId}\u0000${source.id}\u0000${plaintextReference}`),
        privacyClassification: privacyClassification(input.privacyClassification), status: 'STORED_FOR_REVIEW',
        provenance: sanitizeProvenance(input.provenance), createdAt: now, updatedAt: now,
      };
      const reference: EncryptedDataReference = { ...draft, hash: hashEncryptedReference({ ...draft, hash: '' }) };
      await this.encryptedReferences.put(reference);
      await this.api.bus.emit(OrbitalIntelligenceEvents.EncryptedReferenceCreated, {
        referenceId: reference.id, tenantId: reference.tenantId, sourceId: reference.sourceId, referenceType: reference.referenceType,
        algorithm: reference.algorithm, status: reference.status, doesNotRetrieveOrTransmitData: true,
      });
      return copy(reference);
    } catch (error) {
      await this.encryptedReferenceBlobs.delete(blobKey).catch(() => false);
      throw error;
    }
  }

  /** Verify only local encrypted-envelope structure and hashes; it never decrypts or follows a provider locator. */
  async verifyEncryptedDataReference(actor: CommercialActor, referenceId: string): Promise<EncryptedDataReferenceIntegrity> {
    const reference = await this.requireEncryptedReference(actor, referenceId);
    const raw = await this.encryptedReferenceBlobs.getAsText(reference.encryptedBlobKey);
    if (!raw) return { referenceId: reference.id, tenantId: reference.tenantId, status: 'MISSING', cryptographicAuthenticationTagVerified: false, reason: 'Encrypted reference envelope is missing.' };
    try {
      const envelope = parseEncryptedEnvelope(raw);
      const registration = await this.referenceCipherRegistrations.get(reference.cipherRegistrationId);
      if (!registration || registration.tenantId !== reference.tenantId || registration.cipherId !== envelope.cipherId || registration.keyId !== reference.cipherKeyId || registration.algorithm !== reference.algorithm || envelope.algorithm !== reference.algorithm || envelope.keyId !== reference.cipherKeyId || envelope.additionalAuthenticatedDataHash !== reference.additionalAuthenticatedDataHash) {
        return { referenceId: reference.id, tenantId: reference.tenantId, status: 'CORRUPTED', cryptographicAuthenticationTagVerified: false, reason: 'Encrypted reference envelope metadata does not match its registry record.' };
      }
      const ciphertext = fromBase64(envelope.ciphertext);
      const ciphertextHash = digestBytes(ciphertext);
      if (ciphertextHash !== reference.ciphertextHash) return { referenceId: reference.id, tenantId: reference.tenantId, status: 'CORRUPTED', cryptographicAuthenticationTagVerified: false, reason: 'Encrypted reference ciphertext integrity hash differs from the registry record.', ciphertextHash };
      if (fromBase64(envelope.initializationVector).length === 0 || fromBase64(envelope.authenticationTag).length === 0) return { referenceId: reference.id, tenantId: reference.tenantId, status: 'CORRUPTED', cryptographicAuthenticationTagVerified: false, reason: 'Encrypted reference envelope has an invalid IV or authentication tag.', ciphertextHash };
      return { referenceId: reference.id, tenantId: reference.tenantId, status: 'VALID', cryptographicAuthenticationTagVerified: false, ciphertextHash };
    } catch (error) {
      return { referenceId: reference.id, tenantId: reference.tenantId, status: 'CORRUPTED', cryptographicAuthenticationTagVerified: false, reason: safeError(error) };
    }
  }

  /** Verify the tenant-local encrypted-reference metadata chain; this does not decrypt or follow any reference. */
  async verifyEncryptedReferenceLedger(actor: CommercialActor, tenantId = actor.tenantId): Promise<EncryptedDataReferenceLedgerIntegrity> {
    assertViewer(actor);
    if (tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new OrbitalIntelligenceError('Only a global administrator can verify another tenant encrypted-reference ledger.');
    const references = (await this.encryptedReferences.query({ where: (reference) => reference.tenantId === tenantId }))
      .sort((first, second) => first.sequence - second.sequence || first.createdAt - second.createdAt || first.id.localeCompare(second.id));
    let previousHash = 'GENESIS';
    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index]!;
      if (reference.sequence !== index + 1) return { tenantId, valid: false, referenceCount: references.length, failure: `Unexpected encrypted-reference sequence at ${reference.id}.` };
      if (reference.previousHash !== previousHash) return { tenantId, valid: false, referenceCount: references.length, failure: `Encrypted-reference previous hash mismatch at ${reference.id}.` };
      if (reference.hash !== hashEncryptedReference({ ...reference, hash: '' })) return { tenantId, valid: false, referenceCount: references.length, failure: `Encrypted-reference metadata hash mismatch at ${reference.id}.` };
      previousHash = reference.hash;
    }
    return { tenantId, valid: true, referenceCount: references.length };
  }

  /**
   * Bind a local policy evaluation to the exact observation holding this sealed
   * reference, then retain its outcome. This does not turn a local policy result
   * into provider access or a legal license determination.
   */
  async linkEncryptedReferencePolicyEvaluation(actor: CommercialActor, referenceId: string, evaluationId: string): Promise<EncryptedDataReference> {
    assertOperator(actor);
    const reference = await this.requireEncryptedReference(actor, referenceId);
    const evaluation = await this.dataPolicyEvaluations.get(evaluationId);
    if (!evaluation || evaluation.tenantId !== reference.tenantId) throw new OrbitalIntelligenceError('Orbital data policy evaluation is not available for this encrypted reference tenant.');
    const observation = await this.requireObservation(actor, evaluation.observationId);
    if (observation.encryptedDataReferenceId !== reference.id) throw new OrbitalIntelligenceError('Policy evaluation does not refer to an observation using this encrypted data reference.');
    const updated: EncryptedDataReference = {
      ...reference,
      policyEvaluationId: evaluation.id,
      // A local policy pass cannot independently verify provider authority or
      // license validity, so a sealed reference remains review-required until
      // a future authorized external verification boundary exists.
      status: evaluation.outcome === 'BLOCK' ? 'BLOCKED' : 'REVIEW_REQUIRED',
      updatedAt: Date.now(),
    };
    await this.encryptedReferences.put(updated);
    return copy(updated);
  }

  /** Assess sealed-reference integrity and locally recorded authorization/policy state without decrypting or contacting a provider. */
  async assessEncryptedDataReference(actor: CommercialActor, referenceId: string): Promise<EncryptedDataReferenceAssessment> {
    assertOperator(actor);
    const reference = await this.requireEncryptedReference(actor, referenceId);
    const source = await this.requireSourceForActor(actor, reference.sourceId);
    const integrity = await this.verifyEncryptedDataReference(actor, reference.id);
    const evaluation = reference.policyEvaluationId ? await this.dataPolicyEvaluations.get(reference.policyEvaluationId) : undefined;
    const policy = evaluation ? await this.dataPolicies.get(evaluation.policyId) : undefined;
    const quality = evaluation ? await this.dataQualityReports.get(evaluation.qualityReportId) : undefined;
    const checks: EncryptedDataReferenceAssessment['checks'] = [];
    checks.push(hasCurrentSourceAuthorization(source, Date.now())
      ? referenceCheckReview('source_authorization', 'A current local source authorization reference is recorded, but provider authorization remains externally unverified.')
      : referenceCheckBlock('source_authorization', 'Source authorization reference is missing, disabled, or expired.'));
    checks.push(evaluation?.outcome === 'LOCAL_ALLOW' && policy?.allowedLicenseReferences?.includes(source.licenseReference)
      ? referenceCheckReview('license_reference', 'License reference matches a local allowlist, but license validity and terms remain externally unverified.')
      : evaluation?.outcome === 'BLOCK'
        ? referenceCheckBlock('license_reference', 'Linked local policy evaluation blocked the source license reference.')
        : referenceCheckReview('license_reference', 'License reference validity cannot be locally verified without an applicable local policy evaluation.'));
    checks.push(!evaluation
      ? referenceCheckReview('policy_evaluation', 'No linked local data policy evaluation is recorded.')
      : evaluation.outcome === 'LOCAL_ALLOW'
        ? referenceCheckPass('policy_evaluation', 'Linked local data policy evaluation is LOCAL_ALLOW.')
        : evaluation.outcome === 'BLOCK'
          ? referenceCheckBlock('policy_evaluation', 'Linked local data policy evaluation is BLOCK.')
          : referenceCheckReview('policy_evaluation', 'Linked local data policy evaluation requires review.'));
    checks.push(!quality || !policy
      ? referenceCheckReview('evidence', 'Evidence confidence cannot be checked without a linked policy evaluation and quality report.')
      : policy.minimumEvidenceConfidence === undefined
        ? referenceCheckReview('evidence', 'No explicit evidence-confidence threshold is configured for the linked local policy.')
        : quality.averageEvidenceConfidence >= policy.minimumEvidenceConfidence
          ? referenceCheckPass('evidence', 'Linked quality report meets the configured evidence-confidence threshold.')
          : referenceCheckBlock('evidence', 'Linked quality report does not meet the configured evidence-confidence threshold.'));
    checks.push(!quality || !policy
      ? referenceCheckReview('freshness', 'Observation freshness cannot be checked without a linked policy evaluation and quality report.')
      : policy.maximumObservationAgeMs === undefined
        ? referenceCheckReview('freshness', 'No explicit maximum observation age is configured for the linked local policy.')
        : quality.observationAgeMs <= policy.maximumObservationAgeMs
          ? referenceCheckPass('freshness', 'Linked quality report is within the configured observation-age limit.')
          : referenceCheckBlock('freshness', 'Linked quality report exceeds the configured observation-age limit.'));
    checks.push(evaluation?.outcome === 'LOCAL_ALLOW' && policy?.allowedPrivacyClassifications?.includes(reference.privacyClassification)
      ? referenceCheckPass('privacy', 'Linked local policy evaluation passed the configured privacy classification check.')
      : evaluation?.outcome === 'BLOCK'
        ? referenceCheckBlock('privacy', 'Linked local policy evaluation blocked the observation privacy classification.')
        : referenceCheckReview('privacy', 'Privacy suitability requires an explicit linked policy allowlist.'));
    checks.push(integrity.status === 'VALID'
      ? referenceCheckPass('integrity', 'Encrypted reference envelope structure and ciphertext hash verify locally.')
      : referenceCheckBlock('integrity', integrity.reason ?? 'Encrypted reference integrity is not valid.'));
    const outcome: EncryptedDataReferenceAssessment['outcome'] = checks.some((check) => check.outcome === 'BLOCK')
      ? 'BLOCK'
      : checks.some((check) => check.outcome === 'REVIEW')
        ? 'REVIEW'
        : 'LOCAL_ALLOW';
    const assessment: EncryptedDataReferenceAssessment = {
      id: randomUUID(), tenantId: reference.tenantId, referenceId: reference.id, outcome, integrity, checks,
      reason: referenceAssessmentReason(outcome, checks), doesNotRetrieveOrTransmitData: true, doesNotGrantProviderAccess: true,
      doesNotDetermineLicenseValidity: true, createdAt: Date.now(),
    };
    await this.encryptedReferenceAssessments.put(assessment);
    await this.encryptedReferences.put({ ...reference, status: outcome === 'BLOCK' ? 'BLOCKED' : 'REVIEW_REQUIRED', updatedAt: assessment.createdAt });
    await this.api.bus.emit(OrbitalIntelligenceEvents.EncryptedReferenceAssessed, {
      assessmentId: assessment.id, referenceId: reference.id, tenantId: reference.tenantId, outcome: assessment.outcome,
      doesNotRetrieveOrTransmitData: true, doesNotGrantProviderAccess: true, doesNotDetermineLicenseValidity: true,
    });
    return copy(assessment);
  }

  /** Create a non-executing monitoring plan that remains REVIEW_REQUIRED or BLOCKED until external authorization is independently handled. */
  async createMonitoringPlan(actor: CommercialActor, input: CreateOrbitalMonitoringPlanInput): Promise<OrbitalMonitoringPlan> {
    assertOperator(actor);
    validateMonitoringPlanInput(input);
    const source = await this.requireSourceForActor(actor, input.sourceId);
    const review = planReview(source, input.dataClasses, privacyClassification(input.privacyClassification));
    const now = Date.now();
    const plan: OrbitalMonitoringPlan = {
      id: randomUUID(), tenantId: actor.tenantId, sourceId: source.id, dataClasses: dataClasses(input.dataClasses), extent: sanitizeExtent(input.extent),
      frequencyMs: input.frequencyMs, objective: cleanText(input.objective, 'Monitoring objective', 1_000), privacyClassification: privacyClassification(input.privacyClassification),
      state: review.state, reviewReasons: review.reasons, provenance: sanitizeProvenance(input.provenance), createdAt: now, updatedAt: now,
      doesNotScheduleOrRetrieveData: true,
    };
    await this.monitoringPlans.put(plan);
    await this.api.bus.emit(OrbitalIntelligenceEvents.MonitoringPlanCreated, {
      planId: plan.id, tenantId: plan.tenantId, sourceId: plan.sourceId, state: plan.state, doesNotScheduleOrRetrieveData: true,
    });
    return copy(plan);
  }

  /** Create a non-executing information request plan; it can never contact a provider or transmit the requested details. */
  async createInformationRequestPlan(actor: CommercialActor, input: CreateOrbitalInformationRequestPlanInput): Promise<OrbitalInformationRequestPlan> {
    assertOperator(actor);
    validateInformationRequestPlanInput(input);
    const source = await this.requireSourceForActor(actor, input.sourceId);
    const review = planReview(source, input.dataClasses, privacyClassification(input.privacyClassification));
    const now = Date.now();
    const plan: OrbitalInformationRequestPlan = {
      id: randomUUID(), tenantId: actor.tenantId, sourceId: source.id, dataClasses: dataClasses(input.dataClasses), extent: sanitizeExtent(input.extent),
      from: input.from, until: input.until, objective: cleanText(input.objective, 'Information request objective', 1_000),
      requiredEvidence: uniqueIds(input.requiredEvidence ?? [], 'Information request required evidence'), privacyClassification: privacyClassification(input.privacyClassification),
      state: review.state, reviewReasons: review.reasons, provenance: sanitizeProvenance(input.provenance), createdAt: now, updatedAt: now,
      doesNotRequestOrTransmitData: true,
    };
    await this.informationRequestPlans.put(plan);
    await this.api.bus.emit(OrbitalIntelligenceEvents.InformationRequestPlanCreated, {
      planId: plan.id, tenantId: plan.tenantId, sourceId: plan.sourceId, state: plan.state, doesNotRequestOrTransmitData: true,
    });
    return copy(plan);
  }

  /**
   * Normalize a supplied authorized observation reference. The service requires
   * a locally recorded authorization reference, but does not claim a live feed,
   * independent license validation, image analysis, or provider connection.
   */
  async recordObservation(actor: CommercialActor, input: RecordOrbitalObservationInput): Promise<OrbitalObservation> {
    assertOperator(actor);
    validateObservationInput(input);
    const source = await this.requireSourceForActor(actor, input.sourceId);
    const now = Date.now();
    if (source.status !== 'AUTHORIZED_REFERENCE_RECORDED' || !source.authorizationReference || isExpired(source.authorizationExpiresAt, now)) {
      throw new OrbitalIntelligenceError('Observation source is not locally authorized or its authorization reference has expired.');
    }
    if (!source.supportedDataClasses.includes(input.dataClass)) throw new OrbitalIntelligenceError(`Observation source does not declare data class ${input.dataClass}.`);
    const observationId = randomUUID();
    const contentHash = normalizeDigest(input.contentHash, 'Observation content hash');
    let dataReference: string;
    let encryptedDataReferenceId: string | undefined;
    let dataReferenceStatus: OrbitalObservation['dataReferenceStatus'];
    if (input.encryptedDataReferenceId) {
      const encryptedReference = await this.requireEncryptedReference(actor, input.encryptedDataReferenceId);
      if (encryptedReference.sourceId !== source.id || encryptedReference.contentHash !== contentHash) {
        throw new OrbitalIntelligenceError('Encrypted data reference source or content hash does not match this observation.');
      }
      const integrity = await this.verifyEncryptedDataReference(actor, encryptedReference.id);
      if (integrity.status !== 'VALID') throw new OrbitalIntelligenceError(`Encrypted data reference integrity is ${integrity.status}; observation metadata cannot link it.`);
      if (encryptedReference.status === 'BLOCKED') throw new OrbitalIntelligenceError('Encrypted data reference is blocked by local assessment.');
      dataReference = `sealed-reference:${encryptedReference.id}`;
      encryptedDataReferenceId = encryptedReference.id;
      dataReferenceStatus = 'ENCRYPTED_REFERENCE';
    } else {
      dataReference = cleanText(input.dataReference, 'Observation data reference', 1_000);
      dataReferenceStatus = 'PLAINTEXT_REFERENCE';
    }
    const extent = sanitizeExtent(input.extent);
    const evidence = sanitizeEvidence(input.evidence);
    const provenance = sanitizeProvenance(input.provenance);
    let worldEventId: string | undefined;
    let temporalEventId: string | undefined;
    if (input.worldModelId) {
      const model = await this.world.getModel(actor, input.worldModelId);
      if (!model || model.tenantId !== source.tenantId) throw new OrbitalIntelligenceError('Referenced world model is not available in this tenant.');
      const entityIds = uniqueIds(input.worldEntityIds ?? [], 'World entity ids');
      if (entityIds.length === 0) throw new OrbitalIntelligenceError('World-model observation integration requires at least one existing world entity id.');
      const worldEvent = await this.world.recordEvent(actor, model.id, {
        type: 'OIE_OBSERVATION_RECORDED', entityIds, timestamp: input.acquisitionTime, epistemicStatus: worldEpistemicStatus(input.epistemicStatus),
        confidence: input.confidence, payload: { observationId, sourceId: source.id, dataClass: input.dataClass, contentHash },
        evidence, provenance,
      });
      worldEventId = worldEvent.id;
    } else if ((input.worldEntityIds?.length ?? 0) > 0) {
      throw new OrbitalIntelligenceError('World entity ids require a worldModelId.');
    }
    if (input.timelineId) {
      const timeline = await this.temporal.getTimeline(actor, input.timelineId);
      if (!timeline || timeline.tenantId !== source.tenantId) throw new OrbitalIntelligenceError('Referenced timeline is not available in this tenant.');
      const temporalEvent = await this.temporal.recordEvent(actor, timeline.id, {
        type: 'OIE_OBSERVATION_RECORDED', occurredAt: input.acquisitionTime, epistemicStatus: temporalEpistemicStatus(input.epistemicStatus), confidence: input.confidence,
        payload: { observationId, sourceId: source.id, dataClass: input.dataClass, contentHash }, evidence, provenance,
      });
      temporalEventId = temporalEvent.id;
    }
    const previous = (await this.observations.query({ where: (observation) => observation.tenantId === source.tenantId, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
    const draft: Omit<OrbitalObservation, 'hash'> = {
      id: observationId,
      tenantId: source.tenantId,
      sequence: (previous?.sequence ?? 0) + 1,
      previousHash: previous?.hash ?? 'GENESIS',
      sourceId: source.id,
      providerId: source.providerId,
      sensor: source.sensor,
      dataClass: input.dataClass,
      extent,
      acquisitionTime: input.acquisitionTime,
      processingTime: input.processingTime,
      resolution: optionalText(input.resolution, 'Observation resolution', 180),
      spectralProperties: input.spectralProperties ? textList(input.spectralProperties, 'Spectral properties', MAX_LIST_ITEMS, 180) : undefined,
      qualitySummary: cleanText(input.qualitySummary, 'Observation quality summary', 800),
      dataReference, encryptedDataReferenceId, dataReferenceStatus, contentHash,
      observationSummary: cleanText(input.observationSummary, 'Observation summary', 1_000),
      detectionSummaries: textList(input.detectionSummaries ?? [], 'Detection summaries', MAX_LIST_ITEMS, 500),
      processingChain: textList(input.processingChain ?? [], 'Processing chain', MAX_LIST_ITEMS, 240),
      epistemicStatus: input.epistemicStatus,
      confidence: input.confidence,
      evidence,
      provenance,
      privacyClassification: privacyClassification(input.privacyClassification),
      worldModelId: input.worldModelId,
      worldEventId,
      timelineId: input.timelineId,
      temporalEventId,
      createdAt: now,
    };
    const observation: OrbitalObservation = { ...draft, hash: hashObservation({ ...draft, hash: '' }) };
    await this.observations.put(observation);
    await this.api.bus.emit(OrbitalIntelligenceEvents.ObservationRecorded, {
      observationId: observation.id, tenantId: observation.tenantId, sourceId: observation.sourceId, dataClass: observation.dataClass,
      epistemicStatus: observation.epistemicStatus, worldEventId, temporalEventId, doesNotClaimLiveProviderAccess: true,
    });
    return copy(observation);
  }

  /**
   * Store a metadata-level cross-observation assessment. It requires independent
   * providers and never labels its synthesis as directly observed sensor truth.
   */
  async createFusionAssessment(actor: CommercialActor, input: CreateOrbitalFusionAssessmentInput): Promise<OrbitalFusionAssessment> {
    assertOperator(actor);
    validateFusionInput(input);
    const observationIds = uniqueIds(input.observationIds, 'Fusion observation ids');
    if (observationIds.length < 2) throw new OrbitalIntelligenceError('Fusion assessment requires at least two observation ids.');
    const observations = await Promise.all(observationIds.map((id) => this.requireObservation(actor, id)));
    const first = observations[0]!;
    if (observations.some((observation) => observation.tenantId !== actor.tenantId || observation.extent.celestialBody !== first.extent.celestialBody || observation.extent.coordinateReferenceSystem !== first.extent.coordinateReferenceSystem)) {
      throw new OrbitalIntelligenceError('Fusion observations must share tenant, celestial body, and coordinate reference system.');
    }
    const extent = intersectExtents(observations.map((observation) => observation.extent));
    if (!extent) throw new OrbitalIntelligenceError('Fusion observations do not share an overlapping geographic extent.');
    const independentProviderCount = new Set(observations.map((observation) => observation.providerId)).size;
    if (independentProviderCount < 2) throw new OrbitalIntelligenceError('Fusion assessment requires observations from at least two independent declared providers.');
    const assessment: OrbitalFusionAssessment = {
      id: randomUUID(), tenantId: actor.tenantId, observationIds, independentProviderCount, extent,
      timeRange: { from: Math.min(...observations.map((observation) => observation.acquisitionTime)), until: Math.max(...observations.map((observation) => observation.acquisitionTime)) },
      interpretationSummary: cleanText(input.interpretationSummary, 'Fusion interpretation summary', 1_000),
      epistemicStatus: input.epistemicStatus, confidence: input.confidence, evidence: sanitizeEvidence(input.evidence), provenance: sanitizeProvenance(input.provenance), createdAt: Date.now(),
    };
    await this.fusions.put(assessment);
    await this.api.bus.emit(OrbitalIntelligenceEvents.FusionAssessed, {
      fusionId: assessment.id, tenantId: assessment.tenantId, observationIds: assessment.observationIds,
      independentProviderCount: assessment.independentProviderCount, epistemicStatus: assessment.epistemicStatus,
    });
    return copy(assessment);
  }

  /** Compare supplied numeric features across ordered observations; no image-analysis or target-identification claim is made. */
  async compareObservations(actor: CommercialActor, input: CompareOrbitalObservationsInput): Promise<OrbitalChangeAssessment> {
    assertOperator(actor);
    validateChangeInput(input);
    const [baseline, current] = await Promise.all([
      this.requireObservation(actor, input.baselineObservationId),
      this.requireObservation(actor, input.currentObservationId),
    ]);
    if (baseline.id === current.id || baseline.tenantId !== current.tenantId || baseline.extent.celestialBody !== current.extent.celestialBody || baseline.extent.coordinateReferenceSystem !== current.extent.coordinateReferenceSystem) {
      throw new OrbitalIntelligenceError('Change comparison requires distinct observations from the same tenant/body/coordinate reference system.');
    }
    if (current.acquisitionTime <= baseline.acquisitionTime) throw new OrbitalIntelligenceError('Current observation must be later than baseline observation for temporal change comparison.');
    if (!intersectExtents([baseline.extent, current.extent])) throw new OrbitalIntelligenceError('Change comparison observations do not overlap geographically.');
    const absoluteChange = input.currentValue - input.baselineValue;
    const change: OrbitalChangeAssessment = {
      id: randomUUID(), tenantId: actor.tenantId, baselineObservationId: baseline.id, currentObservationId: current.id,
      feature: cleanText(input.feature, 'Change feature', 240), baselineValue: input.baselineValue, currentValue: input.currentValue,
      absoluteChange, relativeChange: input.baselineValue === 0 ? undefined : absoluteChange / Math.abs(input.baselineValue),
      unit: cleanText(input.unit, 'Change unit', 180), epistemicStatus: 'DERIVED', confidence: input.confidence,
      evidence: sanitizeEvidence(input.evidence), provenance: sanitizeProvenance(input.provenance), createdAt: Date.now(),
    };
    await this.changes.put(change);
    await this.api.bus.emit(OrbitalIntelligenceEvents.ChangeAssessed, {
      changeId: change.id, tenantId: change.tenantId, baselineObservationId: change.baselineObservationId,
      currentObservationId: change.currentObservationId, epistemicStatus: change.epistemicStatus,
    });
    return copy(change);
  }

  /** Storage-only spatiotemporal query over authorized-reference observation metadata. */
  async queryObservations(actor: CommercialActor, query: OrbitalObservationQuery = {}): Promise<OrbitalObservation[]> {
    assertViewer(actor);
    validateQuery(query);
    const intersects = query.intersects ? sanitizeExtent(query.intersects) : undefined;
    const dataClassSet = query.dataClasses ? new Set(dataClasses(query.dataClasses)) : undefined;
    const statusSet = query.epistemicStatuses ? new Set(epistemicStatuses(query.epistemicStatuses)) : undefined;
    const observations = await this.observations.query({
      where: (observation) => canRead(actor, observation.tenantId) &&
        (query.sourceId === undefined || observation.sourceId === query.sourceId) &&
        (query.providerId === undefined || observation.providerId === query.providerId) &&
        (dataClassSet === undefined || dataClassSet.has(observation.dataClass)) &&
        (query.celestialBody === undefined || observation.extent.celestialBody === cleanText(query.celestialBody, 'Query celestial body', 120)) &&
        (query.coordinateReferenceSystem === undefined || observation.extent.coordinateReferenceSystem === cleanText(query.coordinateReferenceSystem, 'Query coordinate reference system', 120)) &&
        (query.from === undefined || observation.acquisitionTime >= query.from) &&
        (query.until === undefined || observation.acquisitionTime <= query.until) &&
        (statusSet === undefined || statusSet.has(observation.epistemicStatus)) &&
        (intersects === undefined || extentsIntersect(observation.extent, intersects)),
      orderBy: 'acquisitionTime', order: 'asc', limit: query.limit,
    });
    return observations.map(copy);
  }

  async getSource(actor: CommercialActor, sourceId: string): Promise<OrbitalObservationSource | undefined> {
    const source = await this.sources.get(sourceId);
    return source && canRead(actor, source.tenantId) ? copy(source) : undefined;
  }

  async listSources(actor: CommercialActor): Promise<OrbitalObservationSource[]> {
    return sorted(await this.sources.query({ where: (source) => canRead(actor, source.tenantId) })).map(copy);
  }

  async getProviderAdapterRegistration(actor: CommercialActor, registrationId: string): Promise<OrbitalProviderAdapterRegistration | undefined> {
    const registration = await this.adapterRegistrations.get(registrationId);
    return registration && canRead(actor, registration.tenantId) ? copy(registration) : undefined;
  }

  async listProviderAdapterRegistrations(actor: CommercialActor): Promise<OrbitalProviderAdapterRegistration[]> {
    return sorted(await this.adapterRegistrations.query({ where: (registration) => canRead(actor, registration.tenantId) })).map(copy);
  }

  async listProviderContractReports(actor: CommercialActor, registrationId?: string): Promise<OrbitalProviderContractReport[]> {
    if (registrationId) await this.requireAdapterRegistration(actor, registrationId);
    return sorted(await this.adapterContractReports.query({ where: (report) => canRead(actor, report.tenantId) && (registrationId === undefined || report.registrationId === registrationId) })).map(copy);
  }

  async getDataPolicy(actor: CommercialActor, policyId: string): Promise<OrbitalDataPolicy | undefined> {
    const policy = await this.dataPolicies.get(policyId);
    return policy && canRead(actor, policy.tenantId) ? copy(policy) : undefined;
  }

  async listDataPolicies(actor: CommercialActor): Promise<OrbitalDataPolicy[]> {
    return sorted(await this.dataPolicies.query({ where: (policy) => canRead(actor, policy.tenantId) })).map(copy);
  }

  async listDataQualityReports(actor: CommercialActor, observationId?: string): Promise<OrbitalDataQualityReport[]> {
    if (observationId) await this.requireObservation(actor, observationId);
    return sorted(await this.dataQualityReports.query({ where: (report) => canRead(actor, report.tenantId) && (observationId === undefined || report.observationId === observationId) })).map(copy);
  }

  async listDataPolicyEvaluations(actor: CommercialActor, policyId?: string, observationId?: string): Promise<OrbitalDataPolicyEvaluation[]> {
    if (policyId) await this.requireDataPolicy(actor, policyId);
    if (observationId) await this.requireObservation(actor, observationId);
    return sorted(await this.dataPolicyEvaluations.query({ where: (evaluation) => canRead(actor, evaluation.tenantId) && (policyId === undefined || evaluation.policyId === policyId) && (observationId === undefined || evaluation.observationId === observationId) })).map(copy);
  }

  async getReferenceCipherRegistration(actor: CommercialActor, registrationId: string): Promise<EncryptedReferenceCipherRegistration | undefined> {
    const registration = await this.referenceCipherRegistrations.get(registrationId);
    return registration && canRead(actor, registration.tenantId) ? copy(registration) : undefined;
  }

  async listReferenceCipherRegistrations(actor: CommercialActor): Promise<EncryptedReferenceCipherRegistration[]> {
    return sorted(await this.referenceCipherRegistrations.query({ where: (registration) => canRead(actor, registration.tenantId) })).map(copy);
  }

  async getEncryptedDataReference(actor: CommercialActor, referenceId: string): Promise<EncryptedDataReference | undefined> {
    const reference = await this.encryptedReferences.get(referenceId);
    return reference && canRead(actor, reference.tenantId) ? copy(reference) : undefined;
  }

  async listEncryptedDataReferences(actor: CommercialActor, sourceId?: string): Promise<EncryptedDataReference[]> {
    if (sourceId) await this.requireSourceForActor(actor, sourceId);
    return sorted(await this.encryptedReferences.query({ where: (reference) => canRead(actor, reference.tenantId) && (sourceId === undefined || reference.sourceId === sourceId) })).map(copy);
  }

  async listEncryptedDataReferenceAssessments(actor: CommercialActor, referenceId?: string): Promise<EncryptedDataReferenceAssessment[]> {
    if (referenceId) await this.requireEncryptedReference(actor, referenceId);
    return sorted(await this.encryptedReferenceAssessments.query({ where: (assessment) => canRead(actor, assessment.tenantId) && (referenceId === undefined || assessment.referenceId === referenceId) })).map(copy);
  }

  async listMonitoringPlans(actor: CommercialActor): Promise<OrbitalMonitoringPlan[]> {
    return sorted(await this.monitoringPlans.query({ where: (plan) => canRead(actor, plan.tenantId) })).map(copy);
  }

  async listInformationRequestPlans(actor: CommercialActor): Promise<OrbitalInformationRequestPlan[]> {
    return sorted(await this.informationRequestPlans.query({ where: (plan) => canRead(actor, plan.tenantId) })).map(copy);
  }

  async getObservation(actor: CommercialActor, observationId: string): Promise<OrbitalObservation | undefined> {
    const observation = await this.observations.get(observationId);
    return observation && canRead(actor, observation.tenantId) ? copy(observation) : undefined;
  }

  async listFusionAssessments(actor: CommercialActor): Promise<OrbitalFusionAssessment[]> {
    return sorted(await this.fusions.query({ where: (assessment) => canRead(actor, assessment.tenantId) })).map(copy);
  }

  async listChangeAssessments(actor: CommercialActor): Promise<OrbitalChangeAssessment[]> {
    return sorted(await this.changes.query({ where: (assessment) => canRead(actor, assessment.tenantId) })).map(copy);
  }

  /** Verify the local hash chain over observation metadata; this is not source-data or provider verification. */
  async verifyObservationIntegrity(actor: CommercialActor, tenantId = actor.tenantId): Promise<OrbitalObservationIntegrityResult> {
    assertViewer(actor);
    if (tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new OrbitalIntelligenceError('Only a global administrator can verify another tenant observation ledger.');
    const observations = (await this.observations.query({ where: (observation) => observation.tenantId === tenantId }))
      .sort((first, second) => first.sequence - second.sequence || first.createdAt - second.createdAt || first.id.localeCompare(second.id));
    let previousHash = 'GENESIS';
    for (let index = 0; index < observations.length; index += 1) {
      const observation = observations[index]!;
      if (observation.sequence !== index + 1) return { tenantId, valid: false, observationCount: observations.length, failure: `Unexpected sequence at observation ${observation.id}.` };
      if (observation.previousHash !== previousHash) return { tenantId, valid: false, observationCount: observations.length, failure: `Previous hash mismatch at observation ${observation.id}.` };
      if (observation.hash !== hashObservation({ ...observation, hash: '' })) return { tenantId, valid: false, observationCount: observations.length, failure: `Hash mismatch at observation ${observation.id}.` };
      previousHash = observation.hash;
    }
    return { tenantId, valid: true, observationCount: observations.length };
  }

  private async saveContractReport(
    registration: OrbitalProviderAdapterRegistration,
    input: Omit<OrbitalProviderContractReport, 'id' | 'tenantId' | 'registrationId' | 'sourceId' | 'environment' | 'didNotRetrieveData' | 'didNotTaskSensor' | 'createdAt'> & { source: OrbitalObservationSource; now: number },
  ): Promise<OrbitalProviderContractReport> {
    const { source, now, ...result } = input;
    const report: OrbitalProviderContractReport = {
      id: randomUUID(), tenantId: registration.tenantId, registrationId: registration.id, sourceId: source.id,
      environment: registration.environment, ...result, didNotRetrieveData: true, didNotTaskSensor: true, createdAt: now,
    };
    await this.adapterContractReports.put(report);
    const state: OrbitalAdapterContractState = report.status === 'PASSED'
      ? 'SANDBOX_CONTRACT_PASSED'
      : report.status === 'FAILED'
        ? 'FAILED'
        : registration.state;
    await this.adapterRegistrations.put({ ...registration, state, lastContractAt: now, lastContractReportId: report.id, updatedAt: now });
    await this.api.bus.emit(OrbitalIntelligenceEvents.AdapterContractCompleted, {
      registrationId: registration.id, sourceId: source.id, tenantId: registration.tenantId, environment: registration.environment,
      status: report.status, didNotRetrieveData: true, didNotTaskSensor: true,
    });
    return report;
  }

  private async requireAdapterRegistration(actor: CommercialActor, registrationId: string): Promise<OrbitalProviderAdapterRegistration> {
    const registration = await this.getProviderAdapterRegistration(actor, registrationId);
    if (!registration || registration.tenantId !== actor.tenantId) throw new OrbitalIntelligenceError('Orbital provider adapter registration not found for this tenant.');
    return registration;
  }

  private async requireDataPolicy(actor: CommercialActor, policyId: string): Promise<OrbitalDataPolicy> {
    const policy = await this.getDataPolicy(actor, policyId);
    if (!policy || policy.tenantId !== actor.tenantId) throw new OrbitalIntelligenceError('Orbital data policy not found for this tenant.');
    return policy;
  }

  private async requireReferenceCipherRegistration(actor: CommercialActor, registrationId: string): Promise<EncryptedReferenceCipherRegistration> {
    const registration = await this.getReferenceCipherRegistration(actor, registrationId);
    if (!registration || registration.tenantId !== actor.tenantId) throw new OrbitalIntelligenceError('Encrypted reference cipher registration not found for this tenant.');
    return registration;
  }

  private async requireEncryptedReference(actor: CommercialActor, referenceId: string): Promise<EncryptedDataReference> {
    const reference = await this.getEncryptedDataReference(actor, referenceId);
    if (!reference || reference.tenantId !== actor.tenantId) throw new OrbitalIntelligenceError('Encrypted data reference not found for this tenant.');
    return reference;
  }

  private async requireSourceForActor(actor: CommercialActor, sourceId: string): Promise<OrbitalObservationSource> {
    const source = await this.getSource(actor, sourceId);
    if (!source || source.tenantId !== actor.tenantId) throw new OrbitalIntelligenceError('Orbital observation source not found for this tenant.');
    return source;
  }

  private async requireObservation(actor: CommercialActor, observationId: string): Promise<OrbitalObservation> {
    const observation = await this.getObservation(actor, observationId);
    if (!observation || observation.tenantId !== actor.tenantId) throw new OrbitalIntelligenceError('Orbital observation not found for this tenant.');
    return observation;
  }
}

interface StoredEncryptedReferenceEnvelope {
  format: 'OIE_ENCRYPTED_DATA_REFERENCE';
  version: 1;
  algorithm: 'AES_256_GCM';
  cipherId: string;
  keyId: string;
  initializationVector: string;
  authenticationTag: string;
  ciphertext: string;
  additionalAuthenticatedDataHash: string;
}

function normalizeReferenceCipher(value: EncryptedDataReferenceCipher): EncryptedDataReferenceCipher {
  if (!value || typeof value !== 'object') throw new OrbitalIntelligenceError('An encrypted data-reference cipher is required.');
  if (value.algorithm !== 'AES_256_GCM') throw new OrbitalIntelligenceError('Only AES_256_GCM encrypted-reference ciphers are supported.');
  if (typeof value.encrypt !== 'function') throw new OrbitalIntelligenceError('Encrypted data-reference cipher must provide an encrypt function.');
  return {
    id: cleanText(value.id, 'Encrypted reference cipher id', 180),
    keyId: cleanText(value.keyId, 'Encrypted reference cipher key id', 180),
    algorithm: 'AES_256_GCM',
    encrypt: value.encrypt.bind(value),
  };
}

function validateEncryptedReferenceInput(input: CreateEncryptedDataReferenceInput): void {
  if (!input || typeof input !== 'object') throw new OrbitalIntelligenceError('Encrypted data reference input is required.');
  cleanText(input.sourceId, 'Encrypted reference source id', 180);
  normalizeDigest(input.contentHash, 'Encrypted reference content hash');
  if (!['CONTENT_ADDRESS', 'OBJECT_STORE', 'DATASET', 'ARCHIVE', 'OTHER'].includes(input.referenceType)) throw new OrbitalIntelligenceError('Encrypted reference type is invalid.');
  cleanText(input.dataReference, 'Encrypted data reference', 2_000);
  cleanText(input.cipherRegistrationId, 'Encrypted reference cipher registration id', 180);
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function validateEncryptedEnvelope(
  value: { ciphertext: Uint8Array; initializationVector: Uint8Array; authenticationTag: Uint8Array },
  plaintext: string,
): void {
  if (!value || !(value.ciphertext instanceof Uint8Array) || !(value.initializationVector instanceof Uint8Array) || !(value.authenticationTag instanceof Uint8Array)) {
    throw new OrbitalIntelligenceError('Encrypted reference cipher returned an invalid envelope.');
  }
  if (value.ciphertext.length === 0 || value.initializationVector.length !== 12 || value.authenticationTag.length !== 16) {
    throw new OrbitalIntelligenceError('Encrypted reference envelope must contain ciphertext, a 12-byte IV, and a 16-byte authentication tag.');
  }
  const plainBytes = new TextEncoder().encode(plaintext);
  if (bytesEqual(value.ciphertext, plainBytes)) throw new OrbitalIntelligenceError('Encrypted reference cipher returned plaintext bytes instead of ciphertext.');
}

function parseEncryptedEnvelope(raw: string): StoredEncryptedReferenceEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OrbitalIntelligenceError('Encrypted reference envelope is not valid JSON.');
  }
  const envelope = record(value, 'Encrypted reference envelope');
  if (envelope.format !== 'OIE_ENCRYPTED_DATA_REFERENCE' || envelope.version !== 1 || envelope.algorithm !== 'AES_256_GCM') {
    throw new OrbitalIntelligenceError('Encrypted reference envelope format/version/algorithm is invalid.');
  }
  const parsed: StoredEncryptedReferenceEnvelope = {
    format: 'OIE_ENCRYPTED_DATA_REFERENCE', version: 1, algorithm: 'AES_256_GCM',
    cipherId: cleanText(envelope.cipherId, 'Encrypted reference envelope cipher id', 180),
    keyId: cleanText(envelope.keyId, 'Encrypted reference envelope key id', 180),
    initializationVector: base64(envelope.initializationVector, 'Encrypted reference initialization vector'),
    authenticationTag: base64(envelope.authenticationTag, 'Encrypted reference authentication tag'),
    ciphertext: base64(envelope.ciphertext, 'Encrypted reference ciphertext'),
    additionalAuthenticatedDataHash: normalizeDigest(envelope.additionalAuthenticatedDataHash, 'Encrypted reference authenticated-data hash'),
  };
  return parsed;
}

function canonicalReferenceAad(tenantId: string, sourceId: string, referenceId: string, contentHash: string): string {
  return `OIE_ENCRYPTED_DATA_REFERENCE|${tenantId}|${sourceId}|${referenceId}|${contentHash}`;
}

function hasCurrentSourceAuthorization(source: OrbitalObservationSource, now: number): boolean {
  return source.status === 'AUTHORIZED_REFERENCE_RECORDED' && Boolean(source.authorizationReference) && !isExpired(source.authorizationExpiresAt, now);
}

function planReview(source: OrbitalObservationSource, requestedDataClasses: readonly ObservationDataClass[], privacy: PrivacyClassification): { state: OiePlanState; reasons: string[] } {
  const blocked: string[] = [];
  const review: string[] = [];
  if (source.status === 'DISABLED') blocked.push('Source is locally disabled.');
  if (!requestedDataClasses.every((dataClass) => source.supportedDataClasses.includes(dataClass))) blocked.push('Requested data class is not declared by the selected source.');
  if (!hasCurrentSourceAuthorization(source, Date.now())) blocked.push('Source has no current locally recorded authorization reference.');
  if (blocked.length) return { state: 'BLOCKED', reasons: blocked };
  review.push('Recorded source authorization is an upstream reference, not independently verified provider authorization.');
  review.push('License reference validity and applicable terms require qualified human/legal review.');
  review.push('No live provider availability, observation freshness, or data-quality result is available for a non-executing plan.');
  review.push('No data policy evaluation is linked to this planned future observation.');
  if (privacy === 'RESTRICTED' || privacy === 'PERSONAL_DATA') review.push('Requested privacy classification requires additional privacy review before any external request.');
  return { state: 'REVIEW_REQUIRED', reasons: review };
}

function validateMonitoringPlanInput(input: CreateOrbitalMonitoringPlanInput): void {
  if (!input || typeof input !== 'object') throw new OrbitalIntelligenceError('Monitoring plan input is required.');
  cleanText(input.sourceId, 'Monitoring source id', 180);
  dataClasses(input.dataClasses);
  sanitizeExtent(input.extent);
  if (!Number.isInteger(input.frequencyMs) || input.frequencyMs < 1_000 || input.frequencyMs > 31_536_000_000) throw new OrbitalIntelligenceError('Monitoring frequency must be an integer from 1000 to 31536000000 milliseconds.');
  cleanText(input.objective, 'Monitoring objective', 1_000);
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function validateInformationRequestPlanInput(input: CreateOrbitalInformationRequestPlanInput): void {
  if (!input || typeof input !== 'object') throw new OrbitalIntelligenceError('Information request plan input is required.');
  cleanText(input.sourceId, 'Information request source id', 180);
  dataClasses(input.dataClasses);
  sanitizeExtent(input.extent);
  positiveTimestamp(input.from, 'Information request start time');
  positiveTimestamp(input.until, 'Information request end time');
  if (input.from > input.until) throw new OrbitalIntelligenceError('Information request time range is invalid.');
  cleanText(input.objective, 'Information request objective', 1_000);
  uniqueIds(input.requiredEvidence ?? [], 'Information request required evidence');
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function referenceAssessmentReason(outcome: EncryptedDataReferenceAssessment['outcome'], checks: readonly EncryptedDataReferenceAssessment['checks'][number][]): string {
  const flagged = checks.filter((check) => check.outcome !== 'PASS').map((check) => check.detail);
  return outcome === 'LOCAL_ALLOW'
    ? 'Encrypted reference passed configured local integrity and linked-policy metadata checks; this does not grant provider access or determine license validity.'
    : flagged.join(' ');
}

function referenceCheckPass(name: EncryptedDataReferenceAssessment['checks'][number]['name'], detail: string): EncryptedDataReferenceAssessment['checks'][number] { return { name, outcome: 'PASS', detail }; }
function referenceCheckReview(name: EncryptedDataReferenceAssessment['checks'][number]['name'], detail: string): EncryptedDataReferenceAssessment['checks'][number] { return { name, outcome: 'REVIEW', detail }; }
function referenceCheckBlock(name: EncryptedDataReferenceAssessment['checks'][number]['name'], detail: string): EncryptedDataReferenceAssessment['checks'][number] { return { name, outcome: 'BLOCK', detail }; }

function toBase64(value: Uint8Array): string { return Buffer.from(value).toString('base64'); }
function fromBase64(value: string): Uint8Array { return new Uint8Array(Buffer.from(base64(value, 'Base64 value'), 'base64')); }
function base64(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new OrbitalIntelligenceError(`${name} must be a non-empty base64 string.`);
  const normalized = value.trim();
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) throw new OrbitalIntelligenceError(`${name} is invalid base64.`);
  return normalized;
}
function digestText(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function digestBytes(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function bytesEqual(first: Uint8Array, second: Uint8Array): boolean { return first.length === second.length && first.every((value, index) => value === second[index]); }

function normalizeAdapter(value: ObservationProviderAdapter): ObservationProviderAdapter {
  if (!value || typeof value !== 'object') throw new OrbitalIntelligenceError('An injected orbital provider adapter is required.');
  if (typeof value.capabilities !== 'function' || typeof value.availability !== 'function') throw new OrbitalIntelligenceError('Orbital provider adapter must provide capabilities and availability functions.');
  if (!PROVIDER_KINDS.has(value.kind)) throw new OrbitalIntelligenceError('Orbital provider adapter kind is invalid.');
  if (value.environment !== 'sandbox' && value.environment !== 'production') throw new OrbitalIntelligenceError('Orbital provider adapter environment is invalid.');
  return {
    id: cleanText(value.id, 'Orbital provider adapter id', 180),
    sourceId: cleanText(value.sourceId, 'Orbital provider adapter source id', 180),
    providerId: cleanText(value.providerId, 'Orbital provider adapter provider id', 180),
    kind: value.kind,
    source: cleanText(value.source, 'Orbital provider adapter source', 240),
    sensor: cleanText(value.sensor, 'Orbital provider adapter sensor', 240),
    environment: value.environment,
    credentialReference: optionalText(value.credentialReference, 'Orbital provider credential reference', 500),
    connect: value.connect?.bind(value),
    authenticate: value.authenticate?.bind(value),
    capabilities: value.capabilities.bind(value),
    availability: value.availability.bind(value),
    disconnect: value.disconnect?.bind(value),
  };
}

function assertAdapterMatchesSource(adapter: ObservationProviderAdapter, source: OrbitalObservationSource): void {
  if (adapter.providerId !== source.providerId || adapter.kind !== source.kind || adapter.source !== source.source || adapter.sensor !== source.sensor) {
    throw new OrbitalIntelligenceError('Orbital provider adapter identity does not match its registered source declaration.');
  }
}

function validateAdapterCapabilities(value: unknown, adapter: ObservationProviderAdapter, source: OrbitalObservationSource): asserts value is ObservationProviderCapabilities {
  const capability = record(value, 'Orbital provider capabilities');
  const providerId = cleanText(capability.providerId, 'Capability provider id', 180);
  const kind = capability.kind;
  const sourceName = cleanText(capability.source, 'Capability source', 240);
  const sensor = cleanText(capability.sensor, 'Capability sensor', 240);
  if (providerId !== adapter.providerId || providerId !== source.providerId || kind !== adapter.kind || kind !== source.kind || sourceName !== adapter.source || sourceName !== source.source || sensor !== adapter.sensor || sensor !== source.sensor) {
    throw new OrbitalIntelligenceError('Orbital provider capabilities do not match the registered adapter/source identity.');
  }
  const classes = dataClasses(capability.supportedDataClasses);
  if (!classes.every((dataClass) => source.supportedDataClasses.includes(dataClass))) throw new OrbitalIntelligenceError('Orbital provider capabilities include an undeclared source data class.');
  const permissions = textList(capability.requiredPermissions, 'Capability required permissions', MAX_LIST_ITEMS, 180);
  if (!source.requiredPermissions.every((permission) => permissions.includes(permission))) throw new OrbitalIntelligenceError('Orbital provider capabilities omit a required source permission.');
  if (capability.sandboxSupported !== true || capability.metadataIngestionSupported !== true) throw new OrbitalIntelligenceError('Sandbox contract requires declared sandbox and metadata-ingestion support.');
  if (typeof capability.productionSupported !== 'boolean') throw new OrbitalIntelligenceError('Orbital provider production support declaration is invalid.');
}

function sanitizeProviderCapabilities(value: ObservationProviderCapabilities): ObservationProviderCapabilities {
  return {
    providerId: cleanText(value.providerId, 'Capability provider id', 180),
    kind: value.kind,
    source: cleanText(value.source, 'Capability source', 240),
    sensor: cleanText(value.sensor, 'Capability sensor', 240),
    supportedDataClasses: dataClasses(value.supportedDataClasses),
    requiredPermissions: textList(value.requiredPermissions, 'Capability required permissions', MAX_LIST_ITEMS, 180),
    sandboxSupported: value.sandboxSupported,
    productionSupported: value.productionSupported,
    metadataIngestionSupported: value.metadataIngestionSupported,
  };
}

function validateAvailabilityReport(value: unknown): asserts value is { available: boolean; observedAt: number; summary?: string } {
  const report = record(value, 'Orbital provider availability report');
  if (typeof report.available !== 'boolean') throw new OrbitalIntelligenceError('Orbital provider availability report must include a boolean availability value.');
  positiveTimestamp(report.observedAt, 'Orbital provider availability timestamp');
  optionalText(report.summary, 'Orbital provider availability summary', 640);
}

function sanitizeAvailabilityReport(value: { available: boolean; observedAt: number; summary?: string }): { available: boolean; observedAt: number; summary?: string } {
  return { available: value.available, observedAt: value.observedAt, summary: optionalText(value.summary, 'Orbital provider availability summary', 640) };
}

function withTimeout<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new OrbitalIntelligenceError('Sandbox adapter contract timed out.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OrbitalIntelligenceError('Sandbox adapter contract timed out.'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Injected adapter contract step failed.';
  return message.replace(/\b(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 320);
}

function validateSourceInput(input: RegisterOrbitalObservationSourceInput): void {
  if (!input || typeof input !== 'object') throw new OrbitalIntelligenceError('Observation source input is required.');
  cleanText(input.providerId, 'Observation provider id', 180);
  if (!PROVIDER_KINDS.has(input.kind)) throw new OrbitalIntelligenceError('Observation provider kind is invalid.');
  cleanText(input.source, 'Observation source', 240);
  cleanText(input.sensor, 'Observation sensor', 240);
  dataClasses(input.supportedDataClasses);
  textList(input.requiredPermissions, 'Required provider permissions', MAX_LIST_ITEMS, 180);
  cleanText(input.licenseReference, 'Source license reference', 640);
  sanitizeProvenance(input.provenance);
}

function validateDataPolicyInput(input: CreateOrbitalDataPolicyInput): void {
  if (!input || typeof input !== 'object') throw new OrbitalIntelligenceError('Orbital data policy input is required.');
  cleanText(input.name, 'Orbital data policy name', 240);
  optionalUniqueIds(input.allowedSourceIds, 'Allowed source ids');
  optionalTextList(input.allowedProviderIds, 'Allowed provider ids', MAX_LIST_ITEMS, 180);
  if (input.allowedDataClasses) dataClasses(input.allowedDataClasses);
  optionalTextList(input.allowedLicenseReferences, 'Allowed license references', MAX_LIST_ITEMS, 640);
  if (input.requireCurrentSourceAuthorization !== undefined && typeof input.requireCurrentSourceAuthorization !== 'boolean') throw new OrbitalIntelligenceError('Source authorization requirement must be boolean.');
  if (input.minimumObservationConfidence !== undefined) assertPercent(input.minimumObservationConfidence, 'Minimum observation confidence');
  if (input.minimumEvidenceConfidence !== undefined) assertPercent(input.minimumEvidenceConfidence, 'Minimum evidence confidence');
  if (input.maximumObservationAgeMs !== undefined && (!Number.isInteger(input.maximumObservationAgeMs) || input.maximumObservationAgeMs < 0 || input.maximumObservationAgeMs > 31_536_000_000)) throw new OrbitalIntelligenceError('Maximum observation age must be an integer from 0 to 31536000000 milliseconds.');
  if (input.allowedPrivacyClassifications) privacyClassifications(input.allowedPrivacyClassifications);
  if (input.active !== undefined && typeof input.active !== 'boolean') throw new OrbitalIntelligenceError('Orbital data policy active state must be boolean.');
  sanitizeProvenance(input.provenance);
}

function evaluateDataPolicyChecks(
  policy: OrbitalDataPolicy,
  observation: OrbitalObservation,
  source: OrbitalObservationSource,
  quality: OrbitalDataQualityReport,
): OrbitalDataPolicyCheck[] {
  const checks: OrbitalDataPolicyCheck[] = [];
  checks.push(policy.allowedSourceIds === undefined || policy.allowedSourceIds.includes(source.id)
    ? pass('source', policy.allowedSourceIds === undefined ? 'No source allowlist is configured.' : 'Source is on the configured allowlist.')
    : block('source', 'Source is not on the configured allowlist.'));
  checks.push(policy.allowedProviderIds === undefined || policy.allowedProviderIds.includes(source.providerId)
    ? pass('provider', policy.allowedProviderIds === undefined ? 'No provider allowlist is configured.' : 'Provider is on the configured allowlist.')
    : block('provider', 'Provider is not on the configured allowlist.'));
  checks.push(policy.allowedDataClasses === undefined || policy.allowedDataClasses.includes(observation.dataClass)
    ? pass('data_class', policy.allowedDataClasses === undefined ? 'No data-class allowlist is configured.' : 'Data class is on the configured allowlist.')
    : block('data_class', 'Data class is not on the configured allowlist.'));
  checks.push(policy.requireCurrentSourceAuthorization
    ? quality.sourceAuthorizationCurrent ? pass('authorization', 'A current local source authorization reference is recorded.') : block('authorization', 'Source authorization reference is missing, disabled, or expired.')
    : pass('authorization', 'Current source authorization is not required by this local policy.'));
  checks.push(policy.allowedLicenseReferences === undefined
    ? review('license_reference', 'No license-reference allowlist is configured; this registry does not determine license validity.')
    : policy.allowedLicenseReferences.includes(source.licenseReference)
      ? pass('license_reference', 'Source license reference is on the configured allowlist.')
      : block('license_reference', 'Source license reference is not on the configured allowlist.'));
  checks.push(policy.minimumObservationConfidence === undefined || quality.observationConfidence >= policy.minimumObservationConfidence
    ? pass('observation_confidence', policy.minimumObservationConfidence === undefined ? 'No minimum observation-confidence threshold is configured.' : 'Observation confidence meets the configured threshold.')
    : block('observation_confidence', 'Observation confidence is below the configured threshold.'));
  checks.push(policy.minimumEvidenceConfidence === undefined || quality.averageEvidenceConfidence >= policy.minimumEvidenceConfidence
    ? pass('evidence_confidence', policy.minimumEvidenceConfidence === undefined ? 'No minimum evidence-confidence threshold is configured.' : 'Average evidence confidence meets the configured threshold.')
    : block('evidence_confidence', 'Average evidence confidence is below the configured threshold.'));
  checks.push(policy.maximumObservationAgeMs === undefined || quality.observationAgeMs <= policy.maximumObservationAgeMs
    ? pass('freshness', policy.maximumObservationAgeMs === undefined ? 'No maximum observation-age threshold is configured.' : 'Observation age is within the configured maximum.')
    : block('freshness', 'Observation age exceeds the configured maximum.'));
  checks.push(policy.allowedPrivacyClassifications === undefined || policy.allowedPrivacyClassifications.includes(observation.privacyClassification)
    ? pass('privacy', policy.allowedPrivacyClassifications === undefined ? 'No privacy-classification allowlist is configured.' : 'Observation privacy classification is allowed.')
    : block('privacy', 'Observation privacy classification is not allowed by the local policy.'));
  return checks;
}

function policyEvaluationReason(outcome: OrbitalDataPolicyOutcome, checks: readonly OrbitalDataPolicyCheck[]): string {
  const flagged = checks.filter((check) => check.outcome !== 'PASS').map((check) => check.detail);
  if (outcome === 'LOCAL_ALLOW') return 'All configured local data policy checks passed; this does not grant provider access or determine license validity.';
  return flagged.join(' ');
}

function pass(name: OrbitalDataPolicyCheck['name'], detail: string): OrbitalDataPolicyCheck { return { name, outcome: 'PASS', detail }; }
function block(name: OrbitalDataPolicyCheck['name'], detail: string): OrbitalDataPolicyCheck { return { name, outcome: 'BLOCK', detail }; }
function review(name: OrbitalDataPolicyCheck['name'], detail: string): OrbitalDataPolicyCheck { return { name, outcome: 'REVIEW', detail }; }

function validateSourceAuthorizationInput(input: RecordOrbitalSourceAuthorizationInput): void {
  if (!input || typeof input !== 'object') throw new OrbitalIntelligenceError('Observation source authorization input is required.');
  cleanText(input.authorizationReference, 'Source authorization reference', 640);
  if (input.expiresAt !== undefined) positiveTimestamp(input.expiresAt, 'Source authorization expiry');
  sanitizeEvidence(input.evidence);
  sanitizeProvenance(input.provenance);
}

function validateObservationInput(input: RecordOrbitalObservationInput): void {
  if (!input || typeof input !== 'object') throw new OrbitalIntelligenceError('Orbital observation input is required.');
  cleanText(input.sourceId, 'Observation source id', 180);
  if (!DATA_CLASSES.has(input.dataClass)) throw new OrbitalIntelligenceError('Observation data class is invalid.');
  sanitizeExtent(input.extent);
  positiveTimestamp(input.acquisitionTime, 'Observation acquisition time');
  if (input.processingTime !== undefined) {
    positiveTimestamp(input.processingTime, 'Observation processing time');
    if (input.processingTime < input.acquisitionTime) throw new OrbitalIntelligenceError('Observation processing time cannot precede acquisition time.');
  }
  optionalText(input.resolution, 'Observation resolution', 180);
  if (input.spectralProperties) textList(input.spectralProperties, 'Spectral properties', MAX_LIST_ITEMS, 180);
  cleanText(input.qualitySummary, 'Observation quality summary', 800);
  const hasPlainReference = input.dataReference !== undefined;
  const hasEncryptedReference = input.encryptedDataReferenceId !== undefined;
  if (hasPlainReference === hasEncryptedReference) throw new OrbitalIntelligenceError('Exactly one of observation dataReference or encryptedDataReferenceId is required.');
  if (hasPlainReference) cleanText(input.dataReference, 'Observation data reference', 1_000);
  if (hasEncryptedReference) cleanText(input.encryptedDataReferenceId, 'Encrypted data reference id', 180);
  normalizeDigest(input.contentHash, 'Observation content hash');
  cleanText(input.observationSummary, 'Observation summary', 1_000);
  textList(input.detectionSummaries ?? [], 'Detection summaries', MAX_LIST_ITEMS, 500);
  textList(input.processingChain ?? [], 'Processing chain', MAX_LIST_ITEMS, 240);
  if (!EPISTEMIC_STATUSES.has(input.epistemicStatus)) throw new OrbitalIntelligenceError('Observation epistemic status is invalid.');
  assertPercent(input.confidence, 'Observation confidence');
  sanitizeEvidence(input.evidence);
  sanitizeProvenance(input.provenance);
  privacyClassification(input.privacyClassification);
  if (input.worldModelId !== undefined) cleanText(input.worldModelId, 'World model id', 180);
  if (input.worldEntityIds !== undefined) uniqueIds(input.worldEntityIds, 'World entity ids');
  if (input.timelineId !== undefined) cleanText(input.timelineId, 'Timeline id', 180);
}

function validateFusionInput(input: CreateOrbitalFusionAssessmentInput): void {
  if (!input || typeof input !== 'object') throw new OrbitalIntelligenceError('Fusion assessment input is required.');
  uniqueIds(input.observationIds, 'Fusion observation ids');
  cleanText(input.interpretationSummary, 'Fusion interpretation summary', 1_000);
  if (!FUSION_STATUSES.has(input.epistemicStatus)) throw new OrbitalIntelligenceError('Fusion epistemic status is invalid.');
  assertPercent(input.confidence, 'Fusion confidence');
  sanitizeEvidence(input.evidence);
  sanitizeProvenance(input.provenance);
}

function validateChangeInput(input: CompareOrbitalObservationsInput): void {
  if (!input || typeof input !== 'object') throw new OrbitalIntelligenceError('Change assessment input is required.');
  cleanText(input.baselineObservationId, 'Baseline observation id', 180);
  cleanText(input.currentObservationId, 'Current observation id', 180);
  cleanText(input.feature, 'Change feature', 240);
  if (!Number.isFinite(input.baselineValue) || !Number.isFinite(input.currentValue)) throw new OrbitalIntelligenceError('Change feature values must be finite.');
  cleanText(input.unit, 'Change unit', 180);
  assertPercent(input.confidence, 'Change confidence');
  sanitizeEvidence(input.evidence);
  sanitizeProvenance(input.provenance);
}

function validateQuery(query: OrbitalObservationQuery): void {
  if (!query || typeof query !== 'object') throw new OrbitalIntelligenceError('Observation query must be an object.');
  if (query.sourceId !== undefined) cleanText(query.sourceId, 'Query source id', 180);
  if (query.providerId !== undefined) cleanText(query.providerId, 'Query provider id', 180);
  if (query.dataClasses) dataClasses(query.dataClasses);
  if (query.celestialBody !== undefined) cleanText(query.celestialBody, 'Query celestial body', 120);
  if (query.coordinateReferenceSystem !== undefined) cleanText(query.coordinateReferenceSystem, 'Query coordinate reference system', 120);
  if (query.intersects) sanitizeExtent(query.intersects);
  if (query.from !== undefined) positiveTimestamp(query.from, 'Query from time');
  if (query.until !== undefined) positiveTimestamp(query.until, 'Query until time');
  if (query.from !== undefined && query.until !== undefined && query.from > query.until) throw new OrbitalIntelligenceError('Observation query time range is invalid.');
  if (query.epistemicStatuses) epistemicStatuses(query.epistemicStatuses);
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1_000)) throw new OrbitalIntelligenceError('Observation query limit must be an integer from 1 to 1000.');
}

function sanitizeExtent(value: unknown): GeospatialExtent {
  const extent = record(value, 'Geospatial extent');
  const celestialBody = cleanText(extent.celestialBody, 'Celestial body', 120);
  const coordinateReferenceSystem = cleanText(extent.coordinateReferenceSystem, 'Coordinate reference system', 120);
  if (!Array.isArray(extent.boundingBox) || extent.boundingBox.length !== 4 || extent.boundingBox.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
    throw new OrbitalIntelligenceError('Geospatial bounding box must contain four finite coordinates.');
  }
  const boundingBox = [...extent.boundingBox] as [number, number, number, number];
  if (boundingBox[0] > boundingBox[2] || boundingBox[1] > boundingBox[3]) throw new OrbitalIntelligenceError('Geospatial bounding box minimum values cannot exceed maximum values.');
  if (celestialBody.toLocaleUpperCase() === 'EARTH' && coordinateReferenceSystem.toLocaleUpperCase() === 'EPSG:4326') {
    if (boundingBox[0] < -180 || boundingBox[2] > 180 || boundingBox[1] < -90 || boundingBox[3] > 90) throw new OrbitalIntelligenceError('EPSG:4326 Earth bounding box exceeds longitude/latitude bounds.');
  }
  const minimumAltitude = optionalFinite(extent.minimumAltitude, 'Minimum altitude');
  const maximumAltitude = optionalFinite(extent.maximumAltitude, 'Maximum altitude');
  if (minimumAltitude !== undefined && maximumAltitude !== undefined && minimumAltitude > maximumAltitude) throw new OrbitalIntelligenceError('Geospatial altitude range is invalid.');
  return { celestialBody, coordinateReferenceSystem, boundingBox, minimumAltitude, maximumAltitude };
}

function intersectExtents(extents: readonly GeospatialExtent[]): GeospatialExtent | undefined {
  const first = extents[0];
  if (!first || extents.some((extent) => extent.celestialBody !== first.celestialBody || extent.coordinateReferenceSystem !== first.coordinateReferenceSystem)) return undefined;
  const minX = Math.max(...extents.map((extent) => extent.boundingBox[0]));
  const minY = Math.max(...extents.map((extent) => extent.boundingBox[1]));
  const maxX = Math.min(...extents.map((extent) => extent.boundingBox[2]));
  const maxY = Math.min(...extents.map((extent) => extent.boundingBox[3]));
  if (minX > maxX || minY > maxY) return undefined;
  const minimumAltitude = Math.max(...extents.map((extent) => extent.minimumAltitude ?? Number.NEGATIVE_INFINITY));
  const maximumAltitude = Math.min(...extents.map((extent) => extent.maximumAltitude ?? Number.POSITIVE_INFINITY));
  if (minimumAltitude > maximumAltitude) return undefined;
  return {
    celestialBody: first.celestialBody,
    coordinateReferenceSystem: first.coordinateReferenceSystem,
    boundingBox: [minX, minY, maxX, maxY],
    minimumAltitude: minimumAltitude === Number.NEGATIVE_INFINITY ? undefined : minimumAltitude,
    maximumAltitude: maximumAltitude === Number.POSITIVE_INFINITY ? undefined : maximumAltitude,
  };
}

function extentsIntersect(first: GeospatialExtent, second: GeospatialExtent): boolean {
  return intersectExtents([first, second]) !== undefined;
}

function dataClasses(value: unknown): ObservationDataClass[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DATA_CLASSES.size) throw new OrbitalIntelligenceError(`Observation data classes must contain one to ${DATA_CLASSES.size} values.`);
  const classes = value.map((item) => {
    if (typeof item !== 'string' || !DATA_CLASSES.has(item as ObservationDataClass)) throw new OrbitalIntelligenceError('Observation data class is invalid.');
    return item as ObservationDataClass;
  });
  if (new Set(classes).size !== classes.length) throw new OrbitalIntelligenceError('Observation data classes must be distinct.');
  return classes;
}

function epistemicStatuses(value: unknown): OrbitalEpistemicStatus[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > EPISTEMIC_STATUSES.size) throw new OrbitalIntelligenceError('Observation epistemic status query requires a valid non-empty list.');
  const statuses = value.map((item) => {
    if (typeof item !== 'string' || !EPISTEMIC_STATUSES.has(item as OrbitalEpistemicStatus)) throw new OrbitalIntelligenceError('Observation epistemic status is invalid.');
    return item as OrbitalEpistemicStatus;
  });
  if (new Set(statuses).size !== statuses.length) throw new OrbitalIntelligenceError('Observation epistemic statuses must be distinct.');
  return statuses;
}

function sanitizeEvidence(value: unknown): CommercialEvidence[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE) throw new OrbitalIntelligenceError(`Observation evidence must contain one to ${MAX_EVIDENCE} records.`);
  const ids = new Set<string>();
  return value.map((item) => {
    const evidence = record(item, 'Evidence record');
    const id = cleanText(evidence.id, 'Evidence id', 120);
    if (ids.has(id)) throw new OrbitalIntelligenceError(`Duplicate evidence id ${id}.`);
    ids.add(id);
    const status = evidence.status;
    if (typeof status !== 'string' || !EVIDENCE_STATUSES.has(status as CommercialEvidence['status'])) throw new OrbitalIntelligenceError('Evidence status is invalid.');
    return {
      id,
      status: status as CommercialEvidence['status'],
      source: cleanText(evidence.source, 'Evidence source', 180),
      observedAt: positiveTimestamp(evidence.observedAt, 'Evidence observation time'),
      confidence: assertPercent(evidence.confidence, 'Evidence confidence'),
      summary: cleanText(evidence.summary, 'Evidence summary', 640),
      provenance: sanitizeProvenance(evidence.provenance),
      validUntil: optionalFinite(evidence.validUntil, 'Evidence validity time'),
      privacyClassification: privacyClassification(evidence.privacyClassification),
    };
  });
}

function sanitizeProvenance(value: unknown): CommercialProvenance {
  const provenance = record(value, 'Provenance');
  return {
    source: cleanText(provenance.source, 'Provenance source', 180),
    collectedAt: positiveTimestamp(provenance.collectedAt, 'Provenance collection time'),
    correlationId: optionalText(provenance.correlationId, 'Provenance correlation id', 180),
    causationId: optionalText(provenance.causationId, 'Provenance causation id', 180),
    sourceReference: optionalText(provenance.sourceReference, 'Provenance source reference', 640),
    contentHash: optionalText(provenance.contentHash, 'Provenance content hash', 180),
  };
}

function worldEpistemicStatus(status: OrbitalEpistemicStatus): 'OBSERVED' | 'INFERRED' | 'HYPOTHESIZED' | 'SIMULATED' | 'UNKNOWN' {
  switch (status) {
    case 'OBSERVED': return 'OBSERVED';
    case 'DERIVED':
    case 'INFERRED': return 'INFERRED';
    case 'PREDICTED': return 'HYPOTHESIZED';
    case 'UNKNOWN':
    case 'CONFLICTING': return 'UNKNOWN';
  }
}

function temporalEpistemicStatus(status: OrbitalEpistemicStatus): 'OBSERVED' | 'INFERRED' | 'HYPOTHESIZED' | 'SIMULATED' | 'UNKNOWN' {
  return worldEpistemicStatus(status);
}

function hashObservation(observation: OrbitalObservation): string {
  return createHash('sha256').update(stable(observation)).digest('hex');
}

function hashEncryptedReference(reference: EncryptedDataReference): string {
  // Policy/readiness status is mutable and separately recorded in assessment
  // records. The chain protects immutable encrypted-reference identity and
  // ciphertext metadata without making a later review status look like data
  // corruption or forcing a last-writer-wins chain rewrite.
  const {
    hash: _hash,
    status: _status,
    policyEvaluationId: _policyEvaluationId,
    updatedAt: _updatedAt,
    ...immutable
  } = reference;
  return createHash('sha256').update(stable(immutable)).digest('hex');
}

function normalizeDigest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new OrbitalIntelligenceError(`${name} must be a 64-character SHA-256 hex digest.`);
  return value.toLowerCase();
}

function isExpired(value: number | undefined, now: number): boolean {
  return value !== undefined && value <= now;
}

function optionalFutureTime(value: unknown, name: string, now: number): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = positiveTimestamp(value, name);
  if (timestamp <= now) throw new OrbitalIntelligenceError(`${name} must be in the future.`);
  return timestamp;
}

function textList(value: unknown, name: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new OrbitalIntelligenceError(`${name} must be an array with at most ${maximumItems} item(s).`);
  const values = value.map((item) => cleanText(item, name, maximumLength));
  if (new Set(values).size !== values.length) throw new OrbitalIntelligenceError(`${name} must not contain duplicate values.`);
  return values;
}

function uniqueIds(value: unknown, name: string): string[] {
  const values = textList(value, name, MAX_LIST_ITEMS, 180);
  return values;
}

function optionalUniqueIds(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  const values = uniqueIds(value, name);
  if (values.length === 0) throw new OrbitalIntelligenceError(`${name} must be non-empty when configured.`);
  return values;
}

function optionalTextList(value: unknown, name: string, maximumItems: number, maximumLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  const values = textList(value, name, maximumItems, maximumLength);
  if (values.length === 0) throw new OrbitalIntelligenceError(`${name} must be non-empty when configured.`);
  return values;
}

function privacyClassifications(value: unknown): PrivacyClassification[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PRIVACY_CLASSIFICATIONS.size) throw new OrbitalIntelligenceError('Allowed privacy classifications must be a non-empty valid list.');
  const classifications = value.map((item) => privacyClassification(item));
  if (new Set(classifications).size !== classifications.length) throw new OrbitalIntelligenceError('Allowed privacy classifications must be distinct.');
  return classifications;
}

function round(value: number): number { return Math.round(value * 100) / 100; }

function privacyClassification(value: unknown): PrivacyClassification {
  if (value === undefined) return 'INTERNAL';
  if (typeof value !== 'string' || !PRIVACY_CLASSIFICATIONS.has(value as PrivacyClassification)) throw new OrbitalIntelligenceError('Privacy classification is invalid.');
  return value as PrivacyClassification;
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : cleanText(value, name, maxLength);
}

function positiveTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new OrbitalIntelligenceError(`${name} must be a positive finite timestamp.`);
  return value;
}

function optionalFinite(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new OrbitalIntelligenceError(`${name} must be finite.`);
  return value;
}

function assertPercent(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new OrbitalIntelligenceError(`${name} must be a number from 0 to 100.`);
  return value;
}

function cleanText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new OrbitalIntelligenceError(`${name} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) throw new OrbitalIntelligenceError(`${name} is required.`);
  return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function assertViewer(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new OrbitalIntelligenceError('A tenant-bound orbital-intelligence actor is required.');
}

function assertOperator(actor: CommercialActor): void {
  assertViewer(actor);
  if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new OrbitalIntelligenceError('An orbital-intelligence operator role is required.');
}

function assertAdministrator(actor: CommercialActor): void {
  assertViewer(actor);
  if (!actor.roles.some((role) => ['admin', 'global_admin', 'system'].includes(role))) throw new OrbitalIntelligenceError('An orbital-intelligence administrator role is required.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrbitalIntelligenceError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const recordValue = value as Record<string, unknown>;
  return `{${Object.keys(recordValue).filter((key) => recordValue[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(recordValue[key])}`).join(',')}}`;
}

function sorted<T extends { id: string; createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
