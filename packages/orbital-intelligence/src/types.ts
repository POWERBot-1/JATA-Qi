import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';

/** Provider-neutral observation source categories. No source is connected by this package by default. */
export type ObservationProviderKind =
  | 'SATELLITE_PROVIDER'
  | 'SENSOR_PROVIDER'
  | 'GEOSPATIAL_PROVIDER'
  | 'WEATHER_PROVIDER'
  | 'MARINE_PROVIDER'
  | 'AVIATION_PROVIDER'
  | 'GROUND_SENSOR'
  | 'OPEN_DATA'
  | 'CUSTOM_MISSION';

export type ObservationDataClass =
  | 'OPTICAL'
  | 'MULTISPECTRAL'
  | 'HYPERSPECTRAL'
  | 'SAR'
  | 'THERMAL'
  | 'RADAR_DERIVED'
  | 'LIDAR_DERIVED'
  | 'WEATHER'
  | 'OCEANOGRAPHIC'
  | 'ELEVATION'
  | 'LAND_COVER'
  | 'VEGETATION'
  | 'SOIL_MOISTURE'
  | 'AIS'
  | 'ADS_B'
  | 'GNSS_DERIVED'
  | 'PUBLIC_GEOSPATIAL'
  | 'GROUND_SENSOR'
  | 'IOT'
  | 'INFRASTRUCTURE'
  | 'ECONOMIC'
  | 'OPEN_SOURCE'
  | 'USER_AUTHORIZED'
  | 'OTHER';

export type ObservationSourceStatus = 'DECLARED' | 'AUTHORIZED_REFERENCE_RECORDED' | 'DISABLED';

/** A data-only context. Credential values are never accepted; only a secret-manager reference may be supplied. */
export interface OrbitalProviderContext {
  tenantId: string;
  sourceId: string;
  environment: 'sandbox' | 'production';
  credentialReference?: string;
  signal: AbortSignal;
}

export interface ObservationProviderCapabilities {
  providerId: string;
  kind: ObservationProviderKind;
  source: string;
  sensor: string;
  supportedDataClasses: ObservationDataClass[];
  requiredPermissions: string[];
  sandboxSupported: boolean;
  productionSupported: boolean;
  /** Metadata/data retrieval capability declaration only; this package never invokes retrieval. */
  metadataIngestionSupported: boolean;
}

/**
 * Provider connector contract for future injected adapters. The current OIE
 * package can only run an explicit sandbox contract probe; it cannot retrieve
 * sensor data, task a sensor, or call a production provider.
 */
export interface ObservationProviderAdapter {
  id: string;
  sourceId: string;
  providerId: string;
  kind: ObservationProviderKind;
  source: string;
  sensor: string;
  environment: 'sandbox' | 'production';
  /** Secret identifier only, never a secret value. */
  credentialReference?: string;
  connect?(context: OrbitalProviderContext): Promise<void>;
  authenticate?(context: OrbitalProviderContext): Promise<void>;
  capabilities(context: OrbitalProviderContext): Promise<ObservationProviderCapabilities>;
  availability(context: OrbitalProviderContext): Promise<{ available: boolean; observedAt: number; summary?: string }>;
  disconnect?(context: OrbitalProviderContext): Promise<void>;
}

export type SatelliteProviderAdapter = ObservationProviderAdapter;
export type SensorAdapter = ObservationProviderAdapter;
export type GeospatialProviderAdapter = ObservationProviderAdapter;
export type WeatherProviderAdapter = ObservationProviderAdapter;
export type MarineProviderAdapter = ObservationProviderAdapter;
export type AviationProviderAdapter = ObservationProviderAdapter;
export type GroundSensorAdapter = ObservationProviderAdapter;
export type OpenDataAdapter = ObservationProviderAdapter;
export type CustomMissionAdapter = ObservationProviderAdapter;

export type OrbitalAdapterContractState = 'REGISTERED' | 'SANDBOX_CONTRACT_PASSED' | 'FAILED' | 'UNAVAILABLE';

/** Persisted descriptor for an injected adapter. The implementation itself is never persisted. */
export interface OrbitalProviderAdapterRegistration {
  id: string;
  tenantId: string;
  sourceId: string;
  adapterId: string;
  environment: 'sandbox' | 'production';
  credentialReference?: string;
  state: OrbitalAdapterContractState;
  runtimeAdapterAvailable: boolean;
  registeredAt: number;
  createdAt: number;
  lastContractAt?: number;
  lastContractReportId?: string;
  updatedAt: number;
}

export type OrbitalProviderContractStatus = 'PASSED' | 'FAILED' | 'BLOCKED';
export type OrbitalProviderContractStep = 'NOT_APPLICABLE' | 'PASSED' | 'FAILED' | 'BLOCKED';

/** Explicit sandbox-only adapter probe; it never retrieves data, tasks sensors, or touches production adapters. */
export interface OrbitalProviderContractReport {
  id: string;
  tenantId: string;
  registrationId: string;
  sourceId: string;
  environment: 'sandbox' | 'production';
  status: OrbitalProviderContractStatus;
  connect: OrbitalProviderContractStep;
  authenticate: OrbitalProviderContractStep;
  capabilities: OrbitalProviderContractStep;
  availability: OrbitalProviderContractStep;
  capability?: ObservationProviderCapabilities;
  availabilityReport?: { available: boolean; observedAt: number; summary?: string };
  reasons: string[];
  didNotRetrieveData: true;
  didNotTaskSensor: true;
  createdAt: number;
}


/** Metadata-only source registration; credentials and provider responses are never stored here. */
export interface OrbitalObservationSource {
  id: string;
  tenantId: string;
  providerId: string;
  kind: ObservationProviderKind;
  source: string;
  sensor: string;
  supportedDataClasses: ObservationDataClass[];
  requiredPermissions: string[];
  licenseReference: string;
  provenance: CommercialProvenance;
  authorizationReference?: string;
  authorizationExpiresAt?: number;
  authorizationEvidence?: CommercialEvidence[];
  authorizationProvenance?: CommercialProvenance;
  status: ObservationSourceStatus;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterOrbitalObservationSourceInput {
  providerId: string;
  kind: ObservationProviderKind;
  source: string;
  sensor: string;
  supportedDataClasses: ObservationDataClass[];
  requiredPermissions: string[];
  licenseReference: string;
  provenance: CommercialProvenance;
}

/** An upstream authorization reference is recorded, not independently verified by JATA Qi. */
export interface RecordOrbitalSourceAuthorizationInput {
  authorizationReference: string;
  expiresAt?: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export type OrbitalDataPolicyStatus = 'ACTIVE' | 'DISABLED';

/**
 * Local data-use policy. License references are matched as configured metadata;
 * this registry does not interpret licenses or provide a legal determination.
 */
export interface OrbitalDataPolicy {
  id: string;
  tenantId: string;
  name: string;
  allowedSourceIds?: string[];
  allowedProviderIds?: string[];
  allowedDataClasses?: ObservationDataClass[];
  allowedLicenseReferences?: string[];
  requireCurrentSourceAuthorization: boolean;
  minimumObservationConfidence?: number;
  minimumEvidenceConfidence?: number;
  maximumObservationAgeMs?: number;
  allowedPrivacyClassifications?: PrivacyClassification[];
  status: OrbitalDataPolicyStatus;
  createdByActorId: string;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOrbitalDataPolicyInput {
  name: string;
  allowedSourceIds?: string[];
  allowedProviderIds?: string[];
  allowedDataClasses?: ObservationDataClass[];
  allowedLicenseReferences?: string[];
  requireCurrentSourceAuthorization?: boolean;
  minimumObservationConfidence?: number;
  minimumEvidenceConfidence?: number;
  maximumObservationAgeMs?: number;
  allowedPrivacyClassifications?: PrivacyClassification[];
  active?: boolean;
  provenance: CommercialProvenance;
}

export interface OrbitalDataQualityReport {
  id: string;
  tenantId: string;
  observationId: string;
  sourceId: string;
  assessedAt: number;
  observationAgeMs: number;
  sourceAuthorizationCurrent: boolean;
  licenseReferenceRecorded: boolean;
  evidenceCount: number;
  averageEvidenceConfidence: number;
  observationConfidence: number;
  status: 'INSUFFICIENT_METADATA' | 'LOW' | 'MODERATE' | 'HIGH';
  limitations: string[];
  createdAt: number;
}

/** LOCAL_ALLOW means only the configured local metadata checks passed. */
export type OrbitalDataPolicyOutcome = 'LOCAL_ALLOW' | 'BLOCK' | 'REVIEW';

export interface OrbitalDataPolicyCheck {
  name: 'source' | 'provider' | 'data_class' | 'authorization' | 'license_reference' | 'observation_confidence' | 'evidence_confidence' | 'freshness' | 'privacy';
  outcome: 'PASS' | 'BLOCK' | 'REVIEW';
  detail: string;
}

/** A local policy result, never a legal conclusion, provider approval, or access grant. */
export interface OrbitalDataPolicyEvaluation {
  id: string;
  tenantId: string;
  policyId: string;
  observationId: string;
  qualityReportId: string;
  outcome: OrbitalDataPolicyOutcome;
  checks: OrbitalDataPolicyCheck[];
  reason: string;
  doesNotGrantProviderAccess: true;
  doesNotDetermineLicenseValidity: true;
  createdAt: number;
}

export type EncryptedDataReferenceAlgorithm = 'AES_256_GCM';

/**
 * Host-injected encryption boundary. The cipher implementation/key is never
 * persisted by OIE, and this interface intentionally exposes no decryption API.
 */
export interface EncryptedDataReferenceCipher {
  id: string;
  keyId: string;
  algorithm: EncryptedDataReferenceAlgorithm;
  encrypt(plaintext: Uint8Array, additionalAuthenticatedData: Uint8Array): Promise<{ ciphertext: Uint8Array; initializationVector: Uint8Array; authenticationTag: Uint8Array }>;
}

/**
 * Future object-store boundary. This release only uses the existing local
 * Storage BlobStore for encrypted envelopes and never invokes an external
 * object store, provider, or transport adapter.
 */
export interface EncryptedDataReferenceStoreAdapter {
  id: string;
  providerId: string;
  environment: 'sandbox' | 'production';
  credentialReference?: string;
  supportsEncryptedEnvelopeStorage: boolean;
  supportsIntegrityVerification: boolean;
}

export type EncryptedReferenceCipherState = 'REGISTERED' | 'RUNTIME_UNAVAILABLE';

/** Persisted cipher descriptor; private keys/material and cipher code are never stored. */
export interface EncryptedReferenceCipherRegistration {
  id: string;
  tenantId: string;
  cipherId: string;
  keyId: string;
  algorithm: EncryptedDataReferenceAlgorithm;
  state: EncryptedReferenceCipherState;
  runtimeCipherAvailable: boolean;
  registeredAt: number;
  createdAt: number;
  updatedAt: number;
}

export type EncryptedDataReferenceType = 'CONTENT_ADDRESS' | 'OBJECT_STORE' | 'DATASET' | 'ARCHIVE' | 'OTHER';
export type EncryptedDataReferenceStatus = 'STORED_FOR_REVIEW' | 'LOCAL_POLICY_ALLOWED' | 'REVIEW_REQUIRED' | 'BLOCKED';

/**
 * Metadata for an encrypted opaque data locator. Neither the original locator
 * nor provider data bytes are stored in this document or returned by OIE.
 */
export interface EncryptedDataReference {
  id: string;
  tenantId: string;
  sequence: number;
  previousHash: string;
  hash: string;
  sourceId: string;
  contentHash: string;
  referenceType: EncryptedDataReferenceType;
  cipherRegistrationId: string;
  cipherKeyId: string;
  algorithm: EncryptedDataReferenceAlgorithm;
  encryptedBlobKey: string;
  ciphertextHash: string;
  additionalAuthenticatedDataHash: string;
  referenceHash: string;
  privacyClassification: PrivacyClassification;
  status: EncryptedDataReferenceStatus;
  policyEvaluationId?: string;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface CreateEncryptedDataReferenceInput {
  sourceId: string;
  contentHash: string;
  referenceType: EncryptedDataReferenceType;
  /** Passed directly to the injected cipher; it is never stored or returned. */
  dataReference: string;
  cipherRegistrationId: string;
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

export interface EncryptedDataReferenceLedgerIntegrity {
  tenantId: string;
  valid: boolean;
  referenceCount: number;
  failure?: string;
}

export interface EncryptedDataReferenceIntegrity {
  referenceId: string;
  tenantId: string;
  status: 'VALID' | 'MISSING' | 'CORRUPTED';
  /** This metadata-only verifier never decrypts and therefore cannot verify the GCM tag cryptographically. */
  cryptographicAuthenticationTagVerified: false;
  reason?: string;
  ciphertextHash?: string;
}

/** Policy/readiness result for a sealed reference; it never grants source access or license validity. */
export interface EncryptedDataReferenceAssessment {
  id: string;
  tenantId: string;
  referenceId: string;
  outcome: 'LOCAL_ALLOW' | 'REVIEW' | 'BLOCK';
  integrity: EncryptedDataReferenceIntegrity;
  checks: Array<{ name: 'source_authorization' | 'license_reference' | 'policy_evaluation' | 'evidence' | 'freshness' | 'privacy' | 'integrity'; outcome: 'PASS' | 'REVIEW' | 'BLOCK'; detail: string }>;
  reason: string;
  doesNotRetrieveOrTransmitData: true;
  doesNotGrantProviderAccess: true;
  doesNotDetermineLicenseValidity: true;
  createdAt: number;
}

export type OiePlanState = 'DRAFT' | 'REVIEW_REQUIRED' | 'BLOCKED' | 'PAUSED';

/** Non-executing desired-observation plan; it cannot schedule, task, fetch, or transmit data. */
export interface OrbitalMonitoringPlan {
  id: string;
  tenantId: string;
  sourceId: string;
  dataClasses: ObservationDataClass[];
  extent: GeospatialExtent;
  frequencyMs: number;
  objective: string;
  privacyClassification: PrivacyClassification;
  state: OiePlanState;
  reviewReasons: string[];
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
  doesNotScheduleOrRetrieveData: true;
}

export interface CreateOrbitalMonitoringPlanInput {
  sourceId: string;
  dataClasses: ObservationDataClass[];
  extent: GeospatialExtent;
  frequencyMs: number;
  objective: string;
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

/** Non-executing information request plan. It prepares a review record only. */
export interface OrbitalInformationRequestPlan {
  id: string;
  tenantId: string;
  sourceId: string;
  dataClasses: ObservationDataClass[];
  extent: GeospatialExtent;
  from: number;
  until: number;
  objective: string;
  requiredEvidence: string[];
  privacyClassification: PrivacyClassification;
  state: OiePlanState;
  reviewReasons: string[];
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
  doesNotRequestOrTransmitData: true;
}

export interface CreateOrbitalInformationRequestPlanInput {
  sourceId: string;
  dataClasses: ObservationDataClass[];
  extent: GeospatialExtent;
  from: number;
  until: number;
  objective: string;
  requiredEvidence?: string[];
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

export interface GeospatialExtent {
  celestialBody: string;
  coordinateReferenceSystem: string;
  /** [minimum longitude/x, minimum latitude/y, maximum longitude/x, maximum latitude/y]. */
  boundingBox: [number, number, number, number];
  minimumAltitude?: number;
  maximumAltitude?: number;
}

export type OrbitalEpistemicStatus = 'OBSERVED' | 'DERIVED' | 'INFERRED' | 'PREDICTED' | 'UNKNOWN' | 'CONFLICTING';

/**
 * Immutable normalized observation metadata. References/hashes point to data
 * managed by an authorized external store; imagery or raw sensor bytes are not
 * copied into the JATA Qi repository or this registry.
 */
export interface OrbitalObservation {
  id: string;
  tenantId: string;
  sequence: number;
  previousHash: string;
  hash: string;
  sourceId: string;
  providerId: string;
  sensor: string;
  dataClass: ObservationDataClass;
  extent: GeospatialExtent;
  acquisitionTime: number;
  processingTime?: number;
  resolution?: string;
  spectralProperties?: string[];
  qualitySummary: string;
  /** Legacy plain reference or a sealed placeholder. New secure records use encryptedDataReferenceId. */
  dataReference: string;
  encryptedDataReferenceId?: string;
  dataReferenceStatus: 'PLAINTEXT_REFERENCE' | 'ENCRYPTED_REFERENCE';
  contentHash: string;
  observationSummary: string;
  detectionSummaries: string[];
  processingChain: string[];
  epistemicStatus: OrbitalEpistemicStatus;
  confidence: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  privacyClassification: PrivacyClassification;
  worldModelId?: string;
  worldEventId?: string;
  timelineId?: string;
  temporalEventId?: string;
  createdAt: number;
}

export interface RecordOrbitalObservationInput {
  sourceId: string;
  dataClass: ObservationDataClass;
  extent: GeospatialExtent;
  acquisitionTime: number;
  processingTime?: number;
  resolution?: string;
  spectralProperties?: string[];
  qualitySummary: string;
  /** Exactly one of dataReference or encryptedDataReferenceId must be supplied. */
  dataReference?: string;
  encryptedDataReferenceId?: string;
  contentHash: string;
  observationSummary: string;
  detectionSummaries?: string[];
  processingChain?: string[];
  epistemicStatus: OrbitalEpistemicStatus;
  confidence: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  privacyClassification?: PrivacyClassification;
  /** Optional integration with the existing tenant-bound World Model. */
  worldModelId?: string;
  worldEntityIds?: string[];
  /** Optional integration with the existing tenant-bound Temporal Engine. */
  timelineId?: string;
}

export interface OrbitalObservationQuery {
  sourceId?: string;
  providerId?: string;
  dataClasses?: ObservationDataClass[];
  celestialBody?: string;
  coordinateReferenceSystem?: string;
  intersects?: GeospatialExtent;
  from?: number;
  until?: number;
  epistemicStatuses?: OrbitalEpistemicStatus[];
  limit?: number;
}

/** Metadata assessment across independently supplied observations; no pixel-level fusion is claimed. */
export interface OrbitalFusionAssessment {
  id: string;
  tenantId: string;
  observationIds: string[];
  independentProviderCount: number;
  extent: GeospatialExtent;
  timeRange: { from: number; until: number };
  interpretationSummary: string;
  epistemicStatus: Exclude<OrbitalEpistemicStatus, 'OBSERVED' | 'PREDICTED'>;
  confidence: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface CreateOrbitalFusionAssessmentInput {
  observationIds: string[];
  interpretationSummary: string;
  epistemicStatus: OrbitalFusionAssessment['epistemicStatus'];
  confidence: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

/** Deterministic comparison of supplied feature values, not a computer-vision or target-identification claim. */
export interface OrbitalChangeAssessment {
  id: string;
  tenantId: string;
  baselineObservationId: string;
  currentObservationId: string;
  feature: string;
  baselineValue: number;
  currentValue: number;
  absoluteChange: number;
  relativeChange?: number;
  unit: string;
  epistemicStatus: 'DERIVED';
  confidence: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface CompareOrbitalObservationsInput {
  baselineObservationId: string;
  currentObservationId: string;
  feature: string;
  baselineValue: number;
  currentValue: number;
  unit: string;
  confidence: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface OrbitalObservationIntegrityResult {
  tenantId: string;
  valid: boolean;
  observationCount: number;
  failure?: string;
}

export const OrbitalIntelligenceEvents = Object.freeze({
  SourceRegistered: 'oie.source.registered',
  SourceAuthorized: 'oie.source.authorization.recorded',
  SourceDisabled: 'oie.source.disabled',
  AdapterRegistered: 'oie.adapter.registered',
  AdapterUnregistered: 'oie.adapter.unregistered',
  AdapterContractCompleted: 'oie.adapter.contract.completed',
  DataPolicyCreated: 'oie.data_policy.created',
  DataPolicyEvaluated: 'oie.data_policy.evaluated',
  ReferenceCipherRegistered: 'oie.encrypted_reference.cipher.registered',
  EncryptedReferenceCreated: 'oie.encrypted_reference.created',
  EncryptedReferenceAssessed: 'oie.encrypted_reference.assessed',
  MonitoringPlanCreated: 'oie.monitoring_plan.created',
  InformationRequestPlanCreated: 'oie.information_request_plan.created',
  ObservationRecorded: 'oie.observation.recorded',
  FusionAssessed: 'oie.fusion.assessed',
  ChangeAssessed: 'oie.change.assessed',
} as const);

export type { CommercialActor };
