import type { CommercialActor, CommercialProvenance, PrivacyClassification } from '@jataqi/commercial-control-plane';

/**
 * Current implementation uses classical Ed25519 signatures. "Quantum JATA Qi"
 * is an architectural continuity name here, not a claim of quantum hardware,
 * quantum-native computation, quantum advantage, or quantum-safe cryptography.
 */
export type JqSignatureAlgorithm = 'ED25519';

/** A signer is injected by the host; no private key is persisted or loaded by this package. */
export interface JqExternalSigner {
  keyId: string;
  algorithm: JqSignatureAlgorithm;
  publicKeyPem: string;
  sign(canonicalPayload: string): Promise<string> | string;
}

export type JqIdentityScope = 'SYSTEM' | 'TENANT';
/** Declared recovery paths; declarations do not prove a backup or target runtime is available. */
export type JqRecoveryMethod = 'STATE_CHECKPOINT' | 'AUTHORIZED_RUNTIME_HANDOVER' | 'OFFLINE_ARCHIVE' | 'MANUAL_ROOT_RECOVERY';
export type JqRootKeyStatus = 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

export interface JqRootKey {
  keyId: string;
  algorithm: JqSignatureAlgorithm;
  publicKeyPem: string;
  fingerprint: string;
  status: JqRootKeyStatus;
  activatedAt: number;
  supersededAt?: number;
  revokedAt?: number;
}

/**
 * Permanent computational identity metadata. It stores only public keys and
 * opaque references—not private keys, DNS/IP authority, cloud credentials, or
 * a runtime-specific implementation location.
 */
export interface JqIdentity {
  id: string;
  tenantId: string;
  scope: JqIdentityScope;
  label: string;
  rootKeys: JqRootKey[];
  activeRootKeyId: string;
  /** Self-signature proving control of the initial root key at identity creation. */
  rootSignature: string;
  capabilityRootReference?: string;
  stateRootReference?: string;
  economicIdentityReference?: string;
  discoveryMethods: JqDiscoveryMethod[];
  recoveryMethods: JqRecoveryMethod[];
  lineageHeadHash: string;
  privacyClassification: PrivacyClassification;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface CreateJqIdentityInput {
  scope?: JqIdentityScope;
  label: string;
  capabilityRootReference?: string;
  stateRootReference?: string;
  economicIdentityReference?: string;
  discoveryMethods?: JqDiscoveryMethod[];
  recoveryMethods?: JqRecoveryMethod[];
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

/** Portable, signed JATA Qi Universal Identity Print (JQ-UIP). */
export interface JqUniversalIdentityPrint {
  id: string;
  format: 'JQ-UIP';
  version: 1;
  identityId: string;
  tenantId: string;
  scope: JqIdentityScope;
  label: string;
  rootKey: Pick<JqRootKey, 'keyId' | 'algorithm' | 'publicKeyPem' | 'fingerprint'>;
  stateReference?: string;
  lineageReference: string;
  capabilityReference?: string;
  economicIdentityReference?: string;
  discovery: Array<Pick<JqDiscoveryRecord, 'method' | 'locatorReference' | 'status'>>;
  recoveryMethods: JqRecoveryMethod[];
  issuedAt: number;
  expiresAt?: number;
  signerKeyId: string;
  signature: string;
  createdAt: number;
}

export interface IssueJqUniversalIdentityPrintInput {
  expiresAt?: number;
}

export interface JqIdentityVerification {
  valid: boolean;
  reason?: string;
  identityId?: string;
  activeRootKeyId?: string;
}

export interface JqPrintVerification {
  valid: boolean;
  reason?: string;
  identityId?: string;
  signerKeyId?: string;
  expiresAt?: number;
}

export type JqRuntimeCapability =
  | 'INITIATE'
  | 'AUTHENTICATE'
  | 'LOAD_STATE'
  | 'VERIFY_STATE'
  | 'EXECUTE_CORE'
  | 'SYNC_STATE'
  | 'ATTEST'
  | 'DECLARE_MANIFESTATION'
  | 'MIGRATE'
  | 'RECOVER'
  | 'SHUTDOWN';

export type JqRuntimeAuthorizationStatus = 'AUTHORIZED' | 'REVOKED' | 'EXPIRED';

/** Root-signed delegation of bounded core/runtime capabilities to a public key. */
export interface JqRuntimeAuthorization {
  id: string;
  tenantId: string;
  identityId: string;
  runtimeId: string;
  keyId: string;
  algorithm: JqSignatureAlgorithm;
  publicKeyPem: string;
  publicKeyFingerprint: string;
  capabilities: JqRuntimeCapability[];
  softwareVersion: string;
  issuedAt: number;
  expiresAt?: number;
  status: JqRuntimeAuthorizationStatus;
  revokedAt?: number;
  revocationReason?: string;
  issuerRootKeyId: string;
  signature: string;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface AuthorizeJqRuntimeInput {
  runtimeId: string;
  runtimeKeyId: string;
  runtimePublicKeyPem: string;
  capabilities: JqRuntimeCapability[];
  softwareVersion: string;
  expiresAt?: number;
  provenance: CommercialProvenance;
}

export type JqRuntimeAvailability = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
export type JqRuntimeAttestationStatus = 'VALID' | 'EXPIRED' | 'REVOKED';

/** Runtime-key-signed report. It is cryptographically valid when verified, but not an independent infrastructure health guarantee. */
export interface JqRuntimeAttestation {
  id: string;
  tenantId: string;
  identityId: string;
  runtimeAuthorizationId: string;
  runtimeId: string;
  softwareVersion: string;
  stateCheckpointId?: string;
  integrityDigest: string;
  availability: JqRuntimeAvailability;
  capabilitySnapshot: JqRuntimeCapability[];
  issuedAt: number;
  expiresAt: number;
  signerKeyId: string;
  signature: string;
  status: JqRuntimeAttestationStatus;
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface RevokeJqRuntimeInput {
  reason: string;
  provenance: CommercialProvenance;
}

/** Root-signed revocation record; it retains authorization history rather than deleting it. */
export interface JqRuntimeRevocation {
  id: string;
  tenantId: string;
  identityId: string;
  runtimeAuthorizationId: string;
  reason: string;
  signerKeyId: string;
  signature: string;
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface AttestJqRuntimeInput {
  runtimeAuthorizationId: string;
  softwareVersion: string;
  stateCheckpointId?: string;
  integrityDigest: string;
  availability: JqRuntimeAvailability;
  capabilitySnapshot: JqRuntimeCapability[];
  expiresAt: number;
  provenance: CommercialProvenance;
}

export type JqStateCheckpointStatus = 'AUTHORITATIVE' | 'STALE' | 'CONFLICTING' | 'RECOVERABLE';

/** Signed metadata checkpoint; state bytes remain in a separate authorized store/reference. */
export interface JqStateCheckpoint {
  id: string;
  tenantId: string;
  identityId: string;
  runtimeAuthorizationId: string;
  runtimeId: string;
  version: number;
  stateReference: string;
  canonicalDigest: string;
  parentCheckpointId?: string;
  status: JqStateCheckpointStatus;
  signerKeyId: string;
  signature: string;
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface RecordJqStateCheckpointInput {
  runtimeAuthorizationId: string;
  version: number;
  stateReference: string;
  canonicalDigest: string;
  parentCheckpointId?: string;
  recoverable?: boolean;
  provenance: CommercialProvenance;
}

export interface JqStateVerification {
  valid: boolean;
  status?: JqStateCheckpointStatus;
  reason?: string;
  checkpoint?: JqStateCheckpoint;
}

export type JqDiscoveryMethod =
  | 'LOCAL_REGISTRY'
  | 'AUTHENTICATED_REGISTRY'
  | 'CONTENT_ADDRESS'
  | 'QR'
  | 'OS_INTEGRATION'
  | 'APPLICATION_INTEGRATION'
  | 'NETWORK_DISCOVERY'
  | 'DNS_ALIAS';

export type JqDiscoveryStatus = 'DECLARED' | 'ACTIVE' | 'REVOKED';

/** A signed discovery declaration. It does not prove the referenced endpoint is reachable. */
export interface JqDiscoveryRecord {
  id: string;
  tenantId: string;
  identityId: string;
  method: JqDiscoveryMethod;
  locatorReference: string;
  status: JqDiscoveryStatus;
  issuedAt: number;
  expiresAt?: number;
  signerKeyId: string;
  signature: string;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface DeclareJqDiscoveryInput {
  method: JqDiscoveryMethod;
  locatorReference: string;
  expiresAt?: number;
  provenance: CommercialProvenance;
}

export type JqManifestationType = 'WEB' | 'MOBILE' | 'API' | 'DESKTOP' | 'AGENT' | 'BUSINESS_PLATFORM' | 'DEVELOPER_INTERFACE' | 'OTHER';
export type JqManifestationStatus = 'DECLARED' | 'ACTIVE' | 'REVOKED';

/** Runtime-signed representation declaration. A locator is an optional doorway, never the identity itself. */
export interface JqManifestation {
  id: string;
  tenantId: string;
  identityId: string;
  runtimeAuthorizationId: string;
  runtimeAttestationId: string;
  type: JqManifestationType;
  locatorReference: string;
  authenticationReference?: string;
  status: JqManifestationStatus;
  issuedAt: number;
  expiresAt?: number;
  signerKeyId: string;
  signature: string;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface DeclareJqManifestationInput {
  runtimeAuthorizationId: string;
  runtimeAttestationId: string;
  type: JqManifestationType;
  locatorReference: string;
  authenticationReference?: string;
  expiresAt?: number;
  provenance: CommercialProvenance;
}

export type JqLineageEventType =
  | 'IDENTITY_CREATED'
  | 'ROOT_KEY_ROTATED'
  | 'RUNTIME_AUTHORIZED'
  | 'RUNTIME_REVOKED'
  | 'RUNTIME_ATTESTED'
  | 'STATE_CHECKPOINT_RECORDED'
  | 'DISCOVERY_DECLARED'
  | 'MANIFESTATION_DECLARED'
  | 'HANDOVER_PLANNED';

/** Per-identity hash chain. It preserves local continuity history but is not an independent immutable ledger service. */
export interface JqLineageEntry {
  id: string;
  tenantId: string;
  identityId: string;
  sequence: number;
  previousHash: string;
  hash: string;
  eventType: JqLineageEventType;
  subjectId: string;
  actorId: string;
  signerKeyId?: string;
  sourceRecordDigest: string;
  createdAt: number;
}

export interface JqLineageVerification {
  valid: boolean;
  entries: number;
  failure?: string;
}

export interface JqRootKeyRotation {
  id: string;
  tenantId: string;
  identityId: string;
  previousRootKeyId: string;
  nextRootKey: JqRootKey;
  previousRootSignature: string;
  nextRootSignature: string;
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface RotateJqRootKeyInput {
  provenance: CommercialProvenance;
}

export type JqHandoverStatus = 'PLANNED' | 'TARGET_ATTESTED' | 'STATE_VERIFIED' | 'READY_TO_RESUME' | 'CANCELLED';

/** A signed handover plan only; it neither migrates processes nor claims the target resumed execution. */
export interface JqRuntimeHandover {
  id: string;
  tenantId: string;
  identityId: string;
  sourceRuntimeAuthorizationId: string;
  targetRuntimeAuthorizationId: string;
  targetRuntimeAttestationId: string;
  stateCheckpointId: string;
  status: JqHandoverStatus;
  signerKeyId: string;
  signature: string;
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface PlanJqRuntimeHandoverInput {
  sourceRuntimeAuthorizationId: string;
  targetRuntimeAuthorizationId: string;
  targetRuntimeAttestationId: string;
  stateCheckpointId: string;
  provenance: CommercialProvenance;
}

export interface JqResolution {
  identity: JqIdentity;
  print?: JqUniversalIdentityPrint;
  discovery: JqDiscoveryRecord[];
  authorizedRuntimes: JqRuntimeAuthorization[];
  validAttestations: JqRuntimeAttestation[];
  activeManifestations: JqManifestation[];
  authoritativeState?: JqStateCheckpoint;
  status: 'RESOLVED' | 'NO_ACTIVE_RUNTIME' | 'NO_AUTHORITATIVE_STATE';
  doesNotProveReachability: true;
}

export const PermanenceFabricEvents = Object.freeze({
  IdentityCreated: 'jq.permanence.identity.created',
  IdentityPrintIssued: 'jq.permanence.identity_print.issued',
  RootKeyRotated: 'jq.permanence.root_key.rotated',
  RuntimeAuthorized: 'jq.permanence.runtime.authorized',
  RuntimeRevoked: 'jq.permanence.runtime.revoked',
  RuntimeAttested: 'jq.permanence.runtime.attested',
  StateCheckpointRecorded: 'jq.permanence.state.checkpoint.recorded',
  DiscoveryDeclared: 'jq.permanence.discovery.declared',
  ManifestationDeclared: 'jq.permanence.manifestation.declared',
  HandoverPlanned: 'jq.permanence.handover.planned',
} as const);

export type { CommercialActor };
