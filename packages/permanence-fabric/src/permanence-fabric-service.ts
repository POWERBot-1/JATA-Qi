import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor, CommercialProvenance, PrivacyClassification } from '@jataqi/commercial-control-plane';
import {
  PermanenceFabricEvents,
  type AttestJqRuntimeInput,
  type AuthorizeJqRuntimeInput,
  type CreateJqIdentityInput,
  type DeclareJqDiscoveryInput,
  type DeclareJqManifestationInput,
  type IssueJqUniversalIdentityPrintInput,
  type JqDiscoveryMethod,
  type JqDiscoveryRecord,
  type JqExternalSigner,
  type JqHandoverStatus,
  type JqIdentity,
  type JqIdentityScope,
  type JqIdentityVerification,
  type JqLineageEntry,
  type JqLineageEventType,
  type JqLineageVerification,
  type JqManifestation,
  type JqManifestationType,
  type JqPrintVerification,
  type JqRecoveryMethod,
  type JqResolution,
  type JqRootKey,
  type JqRootKeyRotation,
  type JqRuntimeAttestation,
  type JqRuntimeAuthorization,
  type JqRuntimeCapability,
  type JqRuntimeHandover,
  type JqRuntimeRevocation,
  type JqStateCheckpoint,
  type JqStateCheckpointStatus,
  type JqStateVerification,
  type JqUniversalIdentityPrint,
  type PlanJqRuntimeHandoverInput,
  type RecordJqStateCheckpointInput,
  type RevokeJqRuntimeInput,
  type RotateJqRootKeyInput,
} from './types.js';

const COLLECTIONS = Object.freeze({
  identities: 'permanence-fabric.identities',
  prints: 'permanence-fabric.identity-prints',
  runtimes: 'permanence-fabric.runtime-authorizations',
  attestations: 'permanence-fabric.runtime-attestations',
  checkpoints: 'permanence-fabric.state-checkpoints',
  discovery: 'permanence-fabric.discovery',
  manifestations: 'permanence-fabric.manifestations',
  lineage: 'permanence-fabric.lineage',
  rotations: 'permanence-fabric.root-key-rotations',
  revocations: 'permanence-fabric.runtime-revocations',
  handovers: 'permanence-fabric.runtime-handovers',
});

const MAX_LIST_ITEMS = 20;
const MAX_CAPABILITIES = 20;
const SIGNATURE_ALGORITHMS = new Set(['ED25519']);
const IDENTITY_SCOPES = new Set<JqIdentityScope>(['SYSTEM', 'TENANT']);
const DISCOVERY_METHODS = new Set<JqDiscoveryMethod>(['LOCAL_REGISTRY', 'AUTHENTICATED_REGISTRY', 'CONTENT_ADDRESS', 'QR', 'OS_INTEGRATION', 'APPLICATION_INTEGRATION', 'NETWORK_DISCOVERY', 'DNS_ALIAS']);
const RECOVERY_METHODS = new Set<JqRecoveryMethod>(['STATE_CHECKPOINT', 'AUTHORIZED_RUNTIME_HANDOVER', 'OFFLINE_ARCHIVE', 'MANUAL_ROOT_RECOVERY']);
const RUNTIME_CAPABILITIES = new Set<JqRuntimeCapability>(['INITIATE', 'AUTHENTICATE', 'LOAD_STATE', 'VERIFY_STATE', 'EXECUTE_CORE', 'SYNC_STATE', 'ATTEST', 'DECLARE_MANIFESTATION', 'MIGRATE', 'RECOVER', 'SHUTDOWN']);
const MANIFESTATION_TYPES = new Set<JqManifestationType>(['WEB', 'MOBILE', 'API', 'DESKTOP', 'AGENT', 'BUSINESS_PLATFORM', 'DEVELOPER_INTERFACE', 'OTHER']);
const PRIVACY_CLASSIFICATIONS = new Set<PrivacyClassification>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PERSONAL_DATA']);

export class PermanenceFabricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanenceFabricError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Classical cryptographic continuity foundation for JATA Qi.
 *
 * It stores public-key identity metadata, signed declarations, opaque state
 * references, and local lineage records. It never stores a private key, creates
 * an external runtime, resolves DNS/network locations, migrates a process,
 * grants a commercial action, or guarantees computational permanence.
 */
export class PermanenceFabricService {
  private api!: KernelApi;
  private identities!: ICollection<JqIdentity>;
  private prints!: ICollection<JqUniversalIdentityPrint>;
  private runtimes!: ICollection<JqRuntimeAuthorization>;
  private attestations!: ICollection<JqRuntimeAttestation>;
  private checkpoints!: ICollection<JqStateCheckpoint>;
  private discovery!: ICollection<JqDiscoveryRecord>;
  private manifestations!: ICollection<JqManifestation>;
  private lineage!: ICollection<JqLineageEntry>;
  private rotations!: ICollection<JqRootKeyRotation>;
  private revocations!: ICollection<JqRuntimeRevocation>;
  private handovers!: ICollection<JqRuntimeHandover>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.identities = await storage.collection<JqIdentity>(COLLECTIONS.identities);
    this.prints = await storage.collection<JqUniversalIdentityPrint>(COLLECTIONS.prints);
    this.runtimes = await storage.collection<JqRuntimeAuthorization>(COLLECTIONS.runtimes);
    this.attestations = await storage.collection<JqRuntimeAttestation>(COLLECTIONS.attestations);
    this.checkpoints = await storage.collection<JqStateCheckpoint>(COLLECTIONS.checkpoints);
    this.discovery = await storage.collection<JqDiscoveryRecord>(COLLECTIONS.discovery);
    this.manifestations = await storage.collection<JqManifestation>(COLLECTIONS.manifestations);
    this.lineage = await storage.collection<JqLineageEntry>(COLLECTIONS.lineage);
    this.rotations = await storage.collection<JqRootKeyRotation>(COLLECTIONS.rotations);
    this.revocations = await storage.collection<JqRuntimeRevocation>(COLLECTIONS.revocations);
    this.handovers = await storage.collection<JqRuntimeHandover>(COLLECTIONS.handovers);
  }

  /** Establish a JQ-ID using an injected root signer. The private root key never enters this service. */
  async createIdentity(actor: CommercialActor, input: CreateJqIdentityInput, rootSigner: JqExternalSigner): Promise<JqIdentity> {
    assertIdentityManager(actor);
    validateIdentityInput(input);
    const signer = normalizeSigner(rootSigner);
    const scope = input.scope ?? 'TENANT';
    if (scope === 'SYSTEM' && !actor.roles.includes('global_admin') && !actor.roles.includes('system')) {
      throw new PermanenceFabricError('Only a global administrator or system identity may create a SYSTEM JQ-ID.');
    }
    const now = Date.now();
    const id = `jq-${randomUUID()}`;
    const rootKey: JqRootKey = {
      keyId: signer.keyId,
      algorithm: signer.algorithm,
      publicKeyPem: signer.publicKeyPem,
      fingerprint: keyFingerprint(signer.publicKeyPem),
      status: 'ACTIVE',
      activatedAt: now,
    };
    const unsigned = {
      format: 'JQ-ID' as const,
      version: 1,
      identityId: id,
      tenantId: actor.tenantId,
      scope,
      label: cleanText(input.label, 'JQ-ID label', 240),
      rootKey: publicRootKey(rootKey),
      capabilityRootReference: optionalText(input.capabilityRootReference, 'Capability root reference', 500),
      stateRootReference: optionalText(input.stateRootReference, 'State root reference', 500),
      economicIdentityReference: optionalText(input.economicIdentityReference, 'Economic identity reference', 500),
      discoveryMethods: discoveryMethods(input.discoveryMethods ?? []),
      recoveryMethods: recoveryMethods(input.recoveryMethods ?? []),
      privacyClassification: privacyClassification(input.privacyClassification),
      provenance: sanitizeProvenance(input.provenance),
      createdAt: now,
    };
    // State-root references evolve through independently signed checkpoints, so
    // they are intentionally outside the immutable identity-genesis signature.
    const rootSignature = await signAndVerify(signer, identityCreationPayload(unsigned));
    const identity: JqIdentity = {
      id,
      tenantId: actor.tenantId,
      scope,
      label: unsigned.label,
      rootKeys: [rootKey],
      activeRootKeyId: rootKey.keyId,
      rootSignature,
      capabilityRootReference: unsigned.capabilityRootReference,
      stateRootReference: unsigned.stateRootReference,
      economicIdentityReference: unsigned.economicIdentityReference,
      discoveryMethods: unsigned.discoveryMethods,
      recoveryMethods: unsigned.recoveryMethods,
      lineageHeadHash: 'GENESIS',
      privacyClassification: unsigned.privacyClassification,
      provenance: unsigned.provenance,
      createdAt: now,
      updatedAt: now,
    };
    await this.identities.put(identity);
    const lineage = await this.appendLineage(identity, 'IDENTITY_CREATED', identity.id, actor.id, signer.keyId, digest(unsigned));
    await this.api.bus.emit(PermanenceFabricEvents.IdentityCreated, {
      identityId: lineage.identity.id,
      tenantId: lineage.identity.tenantId,
      scope: lineage.identity.scope,
      rootKeyFingerprint: rootKey.fingerprint,
      doesNotDependOnDnsOrRuntime: true,
    });
    return copy(lineage.identity);
  }

  /** Verify the original root self-signature and current root-key structure. */
  async verifyIdentity(actor: CommercialActor, identityId: string): Promise<JqIdentityVerification> {
    const identity = await this.requireIdentity(actor, identityId);
    const genesisRoot = [...identity.rootKeys].sort((first, second) => first.activatedAt - second.activatedAt || first.keyId.localeCompare(second.keyId))[0];
    if (!genesisRoot) return { valid: false, identityId: identity.id, reason: 'Identity has no root key.' };
    const payload = identityGenesisPayload(identity, genesisRoot);
    const valid = verifyCanonical(genesisRoot.publicKeyPem, payload, identity.rootSignature);
    return valid
      ? { valid: true, identityId: identity.id, activeRootKeyId: identity.activeRootKeyId }
      : { valid: false, identityId: identity.id, activeRootKeyId: identity.activeRootKeyId, reason: 'Initial root self-signature is invalid.' };
  }

  /** Issue a portable, root-signed JQ-UIP. It declares references; it does not test their reachability. */
  async issueIdentityPrint(actor: CommercialActor, identityId: string, input: IssueJqUniversalIdentityPrintInput, rootSigner: JqExternalSigner): Promise<JqUniversalIdentityPrint> {
    assertIdentityManager(actor);
    const identity = await this.requireIdentityForManager(actor, identityId);
    const signer = assertCurrentRootSigner(identity, rootSigner);
    const now = Date.now();
    const expiresAt = optionalFutureTime(input.expiresAt, 'JQ-UIP expiry', now);
    const discovery = (await this.discoveryFor(identity.id)).filter((record) => record.status === 'ACTIVE' && !isExpired(record.expiresAt, now));
    const authoritative = await this.authoritativeCheckpoint(identity.id);
    const root = currentRootKey(identity);
    const unsigned = {
      id: randomUUID(),
      format: 'JQ-UIP' as const,
      version: 1 as const,
      identityId: identity.id,
      tenantId: identity.tenantId,
      scope: identity.scope,
      label: identity.label,
      rootKey: publicRootKey(root),
      stateReference: authoritative?.stateReference ?? identity.stateRootReference,
      lineageReference: identity.lineageHeadHash,
      capabilityReference: identity.capabilityRootReference,
      economicIdentityReference: identity.economicIdentityReference,
      discovery: discovery.map((record) => ({ method: record.method, locatorReference: record.locatorReference, status: record.status })),
      recoveryMethods: [...identity.recoveryMethods],
      issuedAt: now,
      expiresAt,
      signerKeyId: signer.keyId,
      createdAt: now,
    };
    const signature = await signAndVerify(signer, unsigned);
    const print: JqUniversalIdentityPrint = { ...unsigned, signature };
    await this.prints.put(print);
    await this.api.bus.emit(PermanenceFabricEvents.IdentityPrintIssued, {
      identityId: identity.id,
      printId: print.id,
      signerKeyId: print.signerKeyId,
      expiresAt: print.expiresAt,
      doesNotProveReachability: true,
    });
    return copy(print);
  }

  /**
   * Check cryptographic self-consistency of a supplied JQ-UIP without a local
   * trust anchor. This alone does not establish that an arbitrary print is the
   * canonical JATA Qi identity; callers should use verifyIdentityPrintAgainstIdentity
   * when they possess an authorized local JQ-ID record.
   */
  verifyIdentityPrint(print: JqUniversalIdentityPrint, now = Date.now()): JqPrintVerification {
    try {
      if (!print || print.format !== 'JQ-UIP' || print.version !== 1) return { valid: false, reason: 'JQ-UIP format/version is invalid.' };
      if (isExpired(print.expiresAt, now)) return { valid: false, identityId: print.identityId, signerKeyId: print.signerKeyId, expiresAt: print.expiresAt, reason: 'JQ-UIP is expired.' };
      const valid = verifyCanonical(print.rootKey.publicKeyPem, identityPrintPayload(print), print.signature);
      return valid
        ? { valid: true, identityId: print.identityId, signerKeyId: print.signerKeyId, expiresAt: print.expiresAt }
        : { valid: false, identityId: print.identityId, signerKeyId: print.signerKeyId, expiresAt: print.expiresAt, reason: 'JQ-UIP signature is invalid.' };
    } catch (error) {
      return { valid: false, reason: safeError(error) };
    }
  }

  /**
   * Verify a portable print against an already trusted, tenant-authorized JQ-ID
   * record. This prevents an arbitrary self-signed print from impersonating a
   * canonical local identity merely by reusing a label or identity string.
   */
  async verifyIdentityPrintAgainstIdentity(actor: CommercialActor, print: JqUniversalIdentityPrint, now = Date.now()): Promise<JqPrintVerification> {
    const identity = await this.requireIdentity(actor, print.identityId);
    if (print.tenantId !== identity.tenantId || print.scope !== identity.scope) {
      return { valid: false, identityId: print.identityId, signerKeyId: print.signerKeyId, expiresAt: print.expiresAt, reason: 'JQ-UIP tenant or scope does not match the trusted identity.' };
    }
    const trustedRoot = identity.rootKeys.find((key) => key.keyId === print.rootKey.keyId && key.publicKeyPem === print.rootKey.publicKeyPem && key.fingerprint === print.rootKey.fingerprint && key.status !== 'REVOKED');
    if (!trustedRoot || print.signerKeyId !== trustedRoot.keyId || print.rootKey.fingerprint !== keyFingerprint(print.rootKey.publicKeyPem)) {
      return { valid: false, identityId: print.identityId, signerKeyId: print.signerKeyId, expiresAt: print.expiresAt, reason: 'JQ-UIP root key is not a trusted identity root.' };
    }
    if (trustedRoot.status === 'SUPERSEDED' && trustedRoot.supersededAt !== undefined && print.issuedAt > trustedRoot.supersededAt) {
      return { valid: false, identityId: print.identityId, signerKeyId: print.signerKeyId, expiresAt: print.expiresAt, reason: 'JQ-UIP was issued after its root key was superseded.' };
    }
    return this.verifyIdentityPrint(print, now);
  }

  /** Root-sign an authorization for a bounded runtime public key and declared core capabilities. */
  async authorizeRuntime(actor: CommercialActor, identityId: string, input: AuthorizeJqRuntimeInput, rootSigner: JqExternalSigner): Promise<JqRuntimeAuthorization> {
    assertIdentityManager(actor);
    validateRuntimeAuthorizationInput(input);
    const identity = await this.requireIdentityForManager(actor, identityId);
    const signer = assertCurrentRootSigner(identity, rootSigner);
    const now = Date.now();
    const authorization: Omit<JqRuntimeAuthorization, 'signature'> = {
      id: randomUUID(),
      tenantId: identity.tenantId,
      identityId: identity.id,
      runtimeId: cleanText(input.runtimeId, 'Runtime id', 240),
      keyId: cleanText(input.runtimeKeyId, 'Runtime key id', 180),
      algorithm: 'ED25519',
      publicKeyPem: normalizePublicKey(input.runtimePublicKeyPem),
      publicKeyFingerprint: keyFingerprint(normalizePublicKey(input.runtimePublicKeyPem)),
      capabilities: runtimeCapabilities(input.capabilities),
      softwareVersion: cleanText(input.softwareVersion, 'Runtime software version', 180),
      issuedAt: now,
      expiresAt: optionalFutureTime(input.expiresAt, 'Runtime authorization expiry', now),
      status: 'AUTHORIZED',
      issuerRootKeyId: signer.keyId,
      provenance: sanitizeProvenance(input.provenance),
      createdAt: now,
      updatedAt: now,
    };
    const signature = await signAndVerify(signer, runtimeAuthorizationPayload(authorization));
    const stored: JqRuntimeAuthorization = { ...authorization, signature };
    await this.runtimes.put(stored);
    await this.appendLineage(identity, 'RUNTIME_AUTHORIZED', stored.id, actor.id, signer.keyId, digest(runtimeAuthorizationPayload(authorization)));
    await this.api.bus.emit(PermanenceFabricEvents.RuntimeAuthorized, {
      identityId: identity.id,
      runtimeAuthorizationId: stored.id,
      runtimeId: stored.runtimeId,
      capabilities: stored.capabilities,
      expiresAt: stored.expiresAt,
    });
    return copy(stored);
  }

  /** Root-sign and retain a runtime revocation without deleting prior authorization history. */
  async revokeRuntime(actor: CommercialActor, identityId: string, runtimeAuthorizationId: string, input: RevokeJqRuntimeInput, rootSigner: JqExternalSigner): Promise<JqRuntimeAuthorization> {
    assertIdentityManager(actor);
    const identity = await this.requireIdentityForManager(actor, identityId);
    const signer = assertCurrentRootSigner(identity, rootSigner);
    const authorization = await this.requireRuntimeAuthorization(actor, runtimeAuthorizationId);
    if (authorization.identityId !== identity.id || authorization.tenantId !== identity.tenantId) throw new PermanenceFabricError('Runtime authorization is not associated with this JQ-ID.');
    if (authorization.status === 'REVOKED') return copy(authorization);
    const now = Date.now();
    const revocationUnsigned = {
      id: randomUUID(), tenantId: identity.tenantId, identityId: identity.id, runtimeAuthorizationId: authorization.id,
      reason: cleanText(input.reason, 'Runtime revocation reason', 640), signerKeyId: signer.keyId,
      provenance: sanitizeProvenance(input.provenance), createdAt: now,
    };
    const signature = await signAndVerify(signer, revocationUnsigned);
    const revocation: JqRuntimeRevocation = { ...revocationUnsigned, signature };
    const updated: JqRuntimeAuthorization = { ...authorization, status: 'REVOKED', revokedAt: now, revocationReason: revocation.reason, updatedAt: now };
    await this.revocations.put(revocation);
    await this.runtimes.put(updated);
    await this.appendLineage(identity, 'RUNTIME_REVOKED', revocation.id, actor.id, signer.keyId, digest(revocationUnsigned));
    await this.api.bus.emit(PermanenceFabricEvents.RuntimeRevoked, {
      identityId: identity.id, runtimeAuthorizationId: updated.id, runtimeId: updated.runtimeId, reason: updated.revocationReason,
    });
    return copy(updated);
  }

  /** Runtime-key-sign a bounded availability/integrity attestation after root authorization validation. */
  async attestRuntime(actor: CommercialActor, identityId: string, input: AttestJqRuntimeInput, runtimeSigner: JqExternalSigner): Promise<JqRuntimeAttestation> {
    assertRuntimeManager(actor);
    validateRuntimeAttestationInput(input);
    const identity = await this.requireIdentityForManager(actor, identityId);
    const authorization = await this.requireRuntimeAuthorization(actor, input.runtimeAuthorizationId);
    if (authorization.identityId !== identity.id || authorization.tenantId !== identity.tenantId) throw new PermanenceFabricError('Runtime authorization is not associated with this JQ-ID.');
    const now = Date.now();
    await this.assertValidRuntimeAuthorization(identity, authorization, now);
    const signer = assertRuntimeSigner(authorization, runtimeSigner);
    const capabilities = runtimeCapabilities(input.capabilitySnapshot);
    if (!capabilities.every((capability) => authorization.capabilities.includes(capability))) throw new PermanenceFabricError('Runtime attestation capability snapshot exceeds root-authorized runtime capabilities.');
    if (!capabilities.includes('ATTEST')) throw new PermanenceFabricError('Runtime attestation must include the ATTEST capability.');
    if (input.softwareVersion.trim() !== authorization.softwareVersion) throw new PermanenceFabricError('Runtime attestation software version must match the root-authorized runtime version.');
    if (authorization.expiresAt !== undefined && input.expiresAt > authorization.expiresAt) throw new PermanenceFabricError('Runtime attestation cannot outlive its root authorization.');
    if (input.stateCheckpointId) {
      const checkpoint = await this.requireCheckpoint(actor, input.stateCheckpointId);
      if (checkpoint.identityId !== identity.id || checkpoint.tenantId !== identity.tenantId) throw new PermanenceFabricError('Runtime attestation state checkpoint is not associated with this JQ-ID.');
    }
    const unsigned = {
      id: randomUUID(), tenantId: identity.tenantId, identityId: identity.id, runtimeAuthorizationId: authorization.id, runtimeId: authorization.runtimeId,
      softwareVersion: authorization.softwareVersion, stateCheckpointId: input.stateCheckpointId, integrityDigest: normalizeDigest(input.integrityDigest, 'Runtime integrity digest'),
      availability: input.availability, capabilitySnapshot: capabilities, issuedAt: now, expiresAt: input.expiresAt,
      signerKeyId: signer.keyId, provenance: sanitizeProvenance(input.provenance), createdAt: now,
    };
    const signature = await signAndVerify(signer, unsigned);
    const attestation: JqRuntimeAttestation = { ...unsigned, signature, status: 'VALID' };
    await this.attestations.put(attestation);
    await this.appendLineage(identity, 'RUNTIME_ATTESTED', attestation.id, actor.id, signer.keyId, digest(unsigned));
    await this.api.bus.emit(PermanenceFabricEvents.RuntimeAttested, {
      identityId: identity.id, runtimeAttestationId: attestation.id, runtimeAuthorizationId: authorization.id,
      runtimeId: authorization.runtimeId, availability: attestation.availability, expiresAt: attestation.expiresAt,
    });
    return copy(attestation);
  }

  /**
   * Store only a signed state-reference digest, never state bytes. Conflicting
   * parents/versions become explicit CONFLICTING checkpoints rather than silent
   * last-writer-wins authority.
   */
  async recordStateCheckpoint(actor: CommercialActor, identityId: string, input: RecordJqStateCheckpointInput, runtimeSigner: JqExternalSigner): Promise<JqStateCheckpoint> {
    assertRuntimeManager(actor);
    validateStateCheckpointInput(input);
    const identity = await this.requireIdentityForManager(actor, identityId);
    const authorization = await this.requireRuntimeAuthorization(actor, input.runtimeAuthorizationId);
    if (authorization.identityId !== identity.id || authorization.tenantId !== identity.tenantId) throw new PermanenceFabricError('Runtime authorization is not associated with this JQ-ID.');
    const now = Date.now();
    await this.assertValidRuntimeAuthorization(identity, authorization, now);
    if (!authorization.capabilities.includes('SYNC_STATE')) throw new PermanenceFabricError('Runtime authorization lacks the SYNC_STATE capability required for state checkpoints.');
    const signer = assertRuntimeSigner(authorization, runtimeSigner);
    const current = await this.authoritativeCheckpoint(identity.id);
    const parent = input.parentCheckpointId ? await this.requireCheckpoint(actor, input.parentCheckpointId) : undefined;
    if (parent && (parent.identityId !== identity.id || parent.tenantId !== identity.tenantId)) throw new PermanenceFabricError('State checkpoint parent is not associated with this JQ-ID.');
    let status: JqStateCheckpointStatus;
    if (!current) {
      status = input.recoverable ? 'RECOVERABLE' : 'AUTHORITATIVE';
    } else if (parent?.id === current.id && input.version > current.version && !input.recoverable) {
      status = 'AUTHORITATIVE';
    } else {
      status = 'CONFLICTING';
    }
    const unsigned = {
      id: randomUUID(), tenantId: identity.tenantId, identityId: identity.id, runtimeAuthorizationId: authorization.id, runtimeId: authorization.runtimeId,
      version: input.version, stateReference: cleanText(input.stateReference, 'State reference', 640), canonicalDigest: normalizeDigest(input.canonicalDigest, 'State canonical digest'),
      parentCheckpointId: input.parentCheckpointId, status, signerKeyId: signer.keyId, provenance: sanitizeProvenance(input.provenance), createdAt: now,
    };
    const signature = await signAndVerify(signer, unsigned);
    const checkpoint: JqStateCheckpoint = { ...unsigned, signature };
    if (status === 'AUTHORITATIVE' && current) await this.checkpoints.put({ ...current, status: 'STALE' });
    await this.checkpoints.put(checkpoint);
    const identityWithState = status === 'AUTHORITATIVE' ? { ...identity, stateRootReference: checkpoint.stateReference, updatedAt: now } : identity;
    await this.appendLineage(identityWithState, 'STATE_CHECKPOINT_RECORDED', checkpoint.id, actor.id, signer.keyId, digest(unsigned));
    await this.api.bus.emit(PermanenceFabricEvents.StateCheckpointRecorded, {
      identityId: identity.id, checkpointId: checkpoint.id, runtimeId: checkpoint.runtimeId, version: checkpoint.version,
      status: checkpoint.status, stateReference: checkpoint.stateReference,
    });
    return copy(checkpoint);
  }

  async verifyStateCheckpoint(actor: CommercialActor, checkpointId: string): Promise<JqStateVerification> {
    const checkpoint = await this.requireCheckpoint(actor, checkpointId);
    const identity = await this.requireIdentity(actor, checkpoint.identityId);
    const authorization = await this.requireRuntimeAuthorization(actor, checkpoint.runtimeAuthorizationId);
    try {
      await this.assertCryptographicRuntimeAuthorization(identity, authorization);
      if (authorization.status === 'REVOKED') throw new PermanenceFabricError('State checkpoint signer runtime authorization is revoked.');
      if (checkpoint.createdAt < authorization.issuedAt || (authorization.expiresAt !== undefined && checkpoint.createdAt > authorization.expiresAt)) {
        throw new PermanenceFabricError('State checkpoint was not recorded inside the runtime authorization validity window.');
      }
      const valid = verifyCanonical(authorization.publicKeyPem, stateCheckpointPayload(checkpoint), checkpoint.signature);
      return valid
        ? { valid: true, status: checkpoint.status, checkpoint: copy(checkpoint) }
        : { valid: false, status: checkpoint.status, checkpoint: copy(checkpoint), reason: 'State checkpoint signature is invalid.' };
    } catch (error) {
      return { valid: false, status: checkpoint.status, checkpoint: copy(checkpoint), reason: safeError(error) };
    }
  }

  /** Root-sign a discovery declaration; the locator stays optional access metadata, never identity authority. */
  async declareDiscovery(actor: CommercialActor, identityId: string, input: DeclareJqDiscoveryInput, rootSigner: JqExternalSigner): Promise<JqDiscoveryRecord> {
    assertIdentityManager(actor);
    validateDiscoveryInput(input);
    const identity = await this.requireIdentityForManager(actor, identityId);
    const signer = assertCurrentRootSigner(identity, rootSigner);
    const now = Date.now();
    const unsigned = {
      id: randomUUID(), tenantId: identity.tenantId, identityId: identity.id, method: input.method,
      locatorReference: cleanText(input.locatorReference, 'Discovery locator reference', 640), status: 'ACTIVE' as const,
      issuedAt: now, expiresAt: optionalFutureTime(input.expiresAt, 'Discovery expiry', now), signerKeyId: signer.keyId,
      provenance: sanitizeProvenance(input.provenance), createdAt: now, updatedAt: now,
    };
    const signature = await signAndVerify(signer, discoveryPayload(unsigned));
    const discovery: JqDiscoveryRecord = { ...unsigned, signature };
    await this.discovery.put(discovery);
    await this.appendLineage(identity, 'DISCOVERY_DECLARED', discovery.id, actor.id, signer.keyId, digest(discoveryPayload(unsigned)));
    await this.api.bus.emit(PermanenceFabricEvents.DiscoveryDeclared, {
      identityId: identity.id, discoveryId: discovery.id, method: discovery.method, status: discovery.status, doesNotProveReachability: true,
    });
    return copy(discovery);
  }

  /** Runtime-sign a manifestation declaration after validating runtime authorization and attestation. */
  async declareManifestation(actor: CommercialActor, identityId: string, input: DeclareJqManifestationInput, runtimeSigner: JqExternalSigner): Promise<JqManifestation> {
    assertRuntimeManager(actor);
    validateManifestationInput(input);
    const identity = await this.requireIdentityForManager(actor, identityId);
    const authorization = await this.requireRuntimeAuthorization(actor, input.runtimeAuthorizationId);
    if (authorization.identityId !== identity.id || authorization.tenantId !== identity.tenantId) throw new PermanenceFabricError('Runtime authorization is not associated with this JQ-ID.');
    const now = Date.now();
    await this.assertValidRuntimeAuthorization(identity, authorization, now);
    if (!authorization.capabilities.includes('DECLARE_MANIFESTATION')) throw new PermanenceFabricError('Runtime authorization lacks DECLARE_MANIFESTATION capability.');
    const signer = assertRuntimeSigner(authorization, runtimeSigner);
    const attestation = await this.requireAttestation(actor, input.runtimeAttestationId);
    if (attestation.identityId !== identity.id || attestation.runtimeAuthorizationId !== authorization.id || !isValidAttestation(attestation, now) || attestation.availability !== 'AVAILABLE') {
      throw new PermanenceFabricError('Manifestation requires a current AVAILABLE runtime attestation for the authorized runtime.');
    }
    const expiresAt = optionalFutureTime(input.expiresAt, 'Manifestation expiry', now);
    if (expiresAt !== undefined && expiresAt > attestation.expiresAt) throw new PermanenceFabricError('Manifestation cannot outlive its runtime attestation.');
    const unsigned = {
      id: randomUUID(), tenantId: identity.tenantId, identityId: identity.id, runtimeAuthorizationId: authorization.id, runtimeAttestationId: attestation.id,
      type: input.type, locatorReference: cleanText(input.locatorReference, 'Manifestation locator reference', 640),
      authenticationReference: optionalText(input.authenticationReference, 'Manifestation authentication reference', 500), status: 'ACTIVE' as const,
      issuedAt: now, expiresAt, signerKeyId: signer.keyId, provenance: sanitizeProvenance(input.provenance), createdAt: now, updatedAt: now,
    };
    const signature = await signAndVerify(signer, manifestationPayload(unsigned));
    const manifestation: JqManifestation = { ...unsigned, signature };
    await this.manifestations.put(manifestation);
    await this.appendLineage(identity, 'MANIFESTATION_DECLARED', manifestation.id, actor.id, signer.keyId, digest(manifestationPayload(unsigned)));
    await this.api.bus.emit(PermanenceFabricEvents.ManifestationDeclared, {
      identityId: identity.id, manifestationId: manifestation.id, runtimeId: authorization.runtimeId, type: manifestation.type, status: manifestation.status, doesNotProveReachability: true,
    });
    return copy(manifestation);
  }

  /** Rotate public root authority while retaining a dual-signed continuity record and stable JQ-ID. */
  async rotateRootKey(actor: CommercialActor, identityId: string, input: RotateJqRootKeyInput, currentRootSigner: JqExternalSigner, nextRootSigner: JqExternalSigner): Promise<{ identity: JqIdentity; rotation: JqRootKeyRotation }> {
    assertIdentityManager(actor);
    const identity = await this.requireIdentityForManager(actor, identityId);
    const current = assertCurrentRootSigner(identity, currentRootSigner);
    const next = normalizeSigner(nextRootSigner);
    if (next.keyId === current.keyId || keyFingerprint(next.publicKeyPem) === keyFingerprint(current.publicKeyPem)) throw new PermanenceFabricError('The next root key must be distinct from the current root key.');
    const now = Date.now();
    const nextRootKey: JqRootKey = { keyId: next.keyId, algorithm: next.algorithm, publicKeyPem: next.publicKeyPem, fingerprint: keyFingerprint(next.publicKeyPem), status: 'ACTIVE', activatedAt: now };
    const unsigned = {
      id: randomUUID(), tenantId: identity.tenantId, identityId: identity.id, previousRootKeyId: current.keyId,
      nextRootKey: publicRootKey(nextRootKey), provenance: sanitizeProvenance(input.provenance), createdAt: now,
    };
    const previousRootSignature = await signAndVerify(current, unsigned);
    const nextRootSignature = await signAndVerify(next, unsigned);
    const rotation: JqRootKeyRotation = { ...unsigned, nextRootKey, previousRootSignature, nextRootSignature };
    const rootKeys = identity.rootKeys.map((key) => key.keyId === current.keyId ? { ...key, status: 'SUPERSEDED' as const, supersededAt: now } : key).concat(nextRootKey);
    const updatedIdentity: JqIdentity = { ...identity, rootKeys, activeRootKeyId: nextRootKey.keyId, updatedAt: now };
    await this.rotations.put(rotation);
    const lineage = await this.appendLineage(updatedIdentity, 'ROOT_KEY_ROTATED', rotation.id, actor.id, current.keyId, digest(unsigned));
    await this.api.bus.emit(PermanenceFabricEvents.RootKeyRotated, {
      identityId: identity.id, rotationId: rotation.id, previousRootKeyId: current.keyId, nextRootKeyId: nextRootKey.keyId,
    });
    return { identity: copy(lineage.identity), rotation: copy(rotation) };
  }

  /**
   * Root-sign a verified local handover plan. It does not transfer a process,
   * execute the target, publish a location, or claim the target resumed core.
   */
  async planRuntimeHandover(actor: CommercialActor, identityId: string, input: PlanJqRuntimeHandoverInput, rootSigner: JqExternalSigner): Promise<JqRuntimeHandover> {
    assertIdentityManager(actor);
    validateHandoverInput(input);
    const identity = await this.requireIdentityForManager(actor, identityId);
    const signer = assertCurrentRootSigner(identity, rootSigner);
    const [source, target, attestation, checkpoint] = await Promise.all([
      this.requireRuntimeAuthorization(actor, input.sourceRuntimeAuthorizationId),
      this.requireRuntimeAuthorization(actor, input.targetRuntimeAuthorizationId),
      this.requireAttestation(actor, input.targetRuntimeAttestationId),
      this.requireCheckpoint(actor, input.stateCheckpointId),
    ]);
    if (source.identityId !== identity.id || target.identityId !== identity.id || attestation.identityId !== identity.id || checkpoint.identityId !== identity.id) throw new PermanenceFabricError('Handover records must belong to the same JQ-ID.');
    if (source.id === target.id) throw new PermanenceFabricError('Handover source and target runtimes must be distinct.');
    const now = Date.now();
    await this.assertValidRuntimeAuthorization(identity, target, now);
    if (!target.capabilities.includes('MIGRATE') || !target.capabilities.includes('LOAD_STATE') || !target.capabilities.includes('VERIFY_STATE')) {
      throw new PermanenceFabricError('Handover target requires root-authorized MIGRATE, LOAD_STATE, and VERIFY_STATE capabilities.');
    }
    if (attestation.runtimeAuthorizationId !== target.id || !isValidAttestation(attestation, now) || attestation.availability !== 'AVAILABLE') throw new PermanenceFabricError('Handover target requires a valid AVAILABLE runtime attestation.');
    const state = await this.verifyStateCheckpoint(actor, checkpoint.id);
    if (!state.valid || (checkpoint.status !== 'AUTHORITATIVE' && checkpoint.status !== 'RECOVERABLE')) throw new PermanenceFabricError('Handover requires a valid authoritative or recoverable state checkpoint.');
    const status: JqHandoverStatus = 'READY_TO_RESUME';
    const unsigned = {
      id: randomUUID(), tenantId: identity.tenantId, identityId: identity.id, sourceRuntimeAuthorizationId: source.id,
      targetRuntimeAuthorizationId: target.id, targetRuntimeAttestationId: attestation.id, stateCheckpointId: checkpoint.id,
      status, signerKeyId: signer.keyId, provenance: sanitizeProvenance(input.provenance), createdAt: now,
    };
    const signature = await signAndVerify(signer, unsigned);
    const handover: JqRuntimeHandover = { ...unsigned, signature };
    await this.handovers.put(handover);
    await this.appendLineage(identity, 'HANDOVER_PLANNED', handover.id, actor.id, signer.keyId, digest(unsigned));
    await this.api.bus.emit(PermanenceFabricEvents.HandoverPlanned, {
      identityId: identity.id, handoverId: handover.id, sourceRuntimeAuthorizationId: source.id, targetRuntimeAuthorizationId: target.id,
      status: handover.status, doesNotClaimRuntimeExecution: true,
    });
    return copy(handover);
  }

  /** Resolve locally declared, valid continuity records; no network/DNS lookup or reachability assertion is performed. */
  async resolve(actor: CommercialActor, identityId: string): Promise<JqResolution> {
    const identity = await this.requireIdentity(actor, identityId);
    const now = Date.now();
    const [prints, discovery, runtimeRecords, attestationRecords, manifestationRecords, authoritativeState] = await Promise.all([
      this.prints.query({ where: (print) => print.identityId === identity.id && !isExpired(print.expiresAt, now) }),
      this.discovery.query({ where: (record) => record.identityId === identity.id && record.status === 'ACTIVE' && !isExpired(record.expiresAt, now) }),
      this.runtimes.query({ where: (runtime) => runtime.identityId === identity.id }),
      this.attestations.query({ where: (attestation) => attestation.identityId === identity.id }),
      this.manifestations.query({ where: (manifestation) => manifestation.identityId === identity.id && manifestation.status === 'ACTIVE' && !isExpired(manifestation.expiresAt, now) }),
      this.authoritativeCheckpoint(identity.id),
    ]);
    const authorizedRuntimes: JqRuntimeAuthorization[] = [];
    for (const runtime of runtimeRecords) {
      try {
        await this.assertValidRuntimeAuthorization(identity, runtime, now);
        authorizedRuntimes.push(runtime);
      } catch {
        // Invalid/revoked/expired runtime authorizations are deliberately absent from a resolution.
      }
    }
    const authById = new Map(authorizedRuntimes.map((runtime) => [runtime.id, runtime]));
    const validAttestations = attestationRecords.filter((attestation) => {
      const authorization = authById.get(attestation.runtimeAuthorizationId);
      return authorization !== undefined && isValidAttestation(attestation, now) && verifyCanonical(authorization.publicKeyPem, runtimeAttestationPayload(attestation), attestation.signature);
    });
    const validAttestationIds = new Set(validAttestations.map((attestation) => attestation.id));
    const activeManifestations = manifestationRecords.filter((manifestation) => {
      const authorization = authById.get(manifestation.runtimeAuthorizationId);
      return authorization !== undefined && validAttestationIds.has(manifestation.runtimeAttestationId) && verifyCanonical(authorization.publicKeyPem, manifestationPayload(manifestation), manifestation.signature);
    });
    const availableAttestation = validAttestations.some((attestation) => attestation.availability === 'AVAILABLE');
    const status = !authoritativeState
      ? 'NO_AUTHORITATIVE_STATE'
      : !availableAttestation
        ? 'NO_ACTIVE_RUNTIME'
        : 'RESOLVED';
    const latestPrint = sorted(prints).at(-1);
    return {
      identity: copy(identity),
      print: latestPrint ? copy(latestPrint) : undefined,
      discovery: sorted(discovery).map(copy),
      authorizedRuntimes: sorted(authorizedRuntimes).map(copy),
      validAttestations: sorted(validAttestations).map(copy),
      activeManifestations: sorted(activeManifestations).map(copy),
      authoritativeState: authoritativeState ? copy(authoritativeState) : undefined,
      status,
      doesNotProveReachability: true,
    };
  }

  async getIdentity(actor: CommercialActor, identityId: string): Promise<JqIdentity | undefined> {
    const identity = await this.identities.get(identityId);
    return identity && canReadIdentity(actor, identity) ? copy(identity) : undefined;
  }

  async listIdentities(actor: CommercialActor): Promise<JqIdentity[]> {
    return sorted(await this.identities.query({ where: (identity) => canReadIdentity(actor, identity) })).map(copy);
  }

  async listIdentityPrints(actor: CommercialActor, identityId: string): Promise<JqUniversalIdentityPrint[]> {
    await this.requireIdentity(actor, identityId);
    return sorted(await this.prints.query({ where: (print) => print.identityId === identityId })).map(copy);
  }

  async listRuntimeAuthorizations(actor: CommercialActor, identityId: string): Promise<JqRuntimeAuthorization[]> {
    await this.requireIdentity(actor, identityId);
    return sorted(await this.runtimes.query({ where: (runtime) => runtime.identityId === identityId })).map(copy);
  }

  async listRuntimeAttestations(actor: CommercialActor, identityId: string): Promise<JqRuntimeAttestation[]> {
    await this.requireIdentity(actor, identityId);
    return sorted(await this.attestations.query({ where: (attestation) => attestation.identityId === identityId })).map(copy);
  }

  async listStateCheckpoints(actor: CommercialActor, identityId: string): Promise<JqStateCheckpoint[]> {
    await this.requireIdentity(actor, identityId);
    return sorted(await this.checkpoints.query({ where: (checkpoint) => checkpoint.identityId === identityId })).map(copy);
  }

  async listDiscovery(actor: CommercialActor, identityId: string): Promise<JqDiscoveryRecord[]> {
    await this.requireIdentity(actor, identityId);
    return sorted(await this.discovery.query({ where: (record) => record.identityId === identityId })).map(copy);
  }

  async listManifestations(actor: CommercialActor, identityId: string): Promise<JqManifestation[]> {
    await this.requireIdentity(actor, identityId);
    return sorted(await this.manifestations.query({ where: (manifestation) => manifestation.identityId === identityId })).map(copy);
  }

  async listHandovers(actor: CommercialActor, identityId: string): Promise<JqRuntimeHandover[]> {
    await this.requireIdentity(actor, identityId);
    return sorted(await this.handovers.query({ where: (handover) => handover.identityId === identityId })).map(copy);
  }

  async verifyLineage(actor: CommercialActor, identityId: string): Promise<JqLineageVerification> {
    await this.requireIdentity(actor, identityId);
    const entries = (await this.lineage.query({ where: (entry) => entry.identityId === identityId }))
      .sort((first, second) => first.sequence - second.sequence || first.createdAt - second.createdAt || first.id.localeCompare(second.id));
    let previousHash = 'GENESIS';
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.sequence !== index + 1) return { valid: false, entries: entries.length, failure: `Unexpected lineage sequence at ${entry.id}.` };
      if (entry.previousHash !== previousHash) return { valid: false, entries: entries.length, failure: `Lineage previous hash mismatch at ${entry.id}.` };
      if (entry.hash !== hashLineage({ ...entry, hash: '' })) return { valid: false, entries: entries.length, failure: `Lineage hash mismatch at ${entry.id}.` };
      previousHash = entry.hash;
    }
    return { valid: true, entries: entries.length };
  }

  private async requireIdentity(actor: CommercialActor, identityId: string): Promise<JqIdentity> {
    const identity = await this.getIdentity(actor, identityId);
    if (!identity) throw new PermanenceFabricError('JQ-ID identity not found.');
    return identity;
  }

  private async requireIdentityForManager(actor: CommercialActor, identityId: string): Promise<JqIdentity> {
    const identity = await this.requireIdentity(actor, identityId);
    if (identity.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new PermanenceFabricError('Cross-tenant JQ-ID management is not authorized.');
    if (identity.scope === 'SYSTEM' && !actor.roles.includes('global_admin') && !actor.roles.includes('system')) throw new PermanenceFabricError('SYSTEM JQ-ID management requires global/system authority.');
    return identity;
  }

  private async requireRuntimeAuthorization(actor: CommercialActor, authorizationId: string): Promise<JqRuntimeAuthorization> {
    const authorization = await this.runtimes.get(authorizationId);
    if (!authorization || !canReadTenant(actor, authorization.tenantId)) throw new PermanenceFabricError('JQ runtime authorization not found.');
    return authorization;
  }

  private async requireAttestation(actor: CommercialActor, attestationId: string): Promise<JqRuntimeAttestation> {
    const attestation = await this.attestations.get(attestationId);
    if (!attestation || !canReadTenant(actor, attestation.tenantId)) throw new PermanenceFabricError('JQ runtime attestation not found.');
    return attestation;
  }

  private async requireCheckpoint(actor: CommercialActor, checkpointId: string): Promise<JqStateCheckpoint> {
    const checkpoint = await this.checkpoints.get(checkpointId);
    if (!checkpoint || !canReadTenant(actor, checkpoint.tenantId)) throw new PermanenceFabricError('JQ state checkpoint not found.');
    return checkpoint;
  }

  private async authoritativeCheckpoint(identityId: string): Promise<JqStateCheckpoint | undefined> {
    return (await this.checkpoints.query({ where: (checkpoint) => checkpoint.identityId === identityId && checkpoint.status === 'AUTHORITATIVE' }))
      .sort((first, second) => second.version - first.version || second.createdAt - first.createdAt || second.id.localeCompare(first.id))[0];
  }

  private async discoveryFor(identityId: string): Promise<JqDiscoveryRecord[]> {
    return sorted(await this.discovery.query({ where: (record) => record.identityId === identityId }));
  }

  private async assertValidRuntimeAuthorization(identity: JqIdentity, authorization: JqRuntimeAuthorization, now: number): Promise<void> {
    if (authorization.status === 'REVOKED') throw new PermanenceFabricError('Runtime authorization is revoked.');
    if (isExpired(authorization.expiresAt, now) || authorization.status === 'EXPIRED') throw new PermanenceFabricError('Runtime authorization is expired.');
    await this.assertCryptographicRuntimeAuthorization(identity, authorization);
  }

  /** Verify the original root signature without treating a historically signed state as current runtime authority. */
  private async assertCryptographicRuntimeAuthorization(identity: JqIdentity, authorization: JqRuntimeAuthorization): Promise<void> {
    const root = identity.rootKeys.find((key) => key.keyId === authorization.issuerRootKeyId);
    if (!root || root.status === 'REVOKED') throw new PermanenceFabricError('Runtime authorization issuer root key is not trusted.');
    if (root.status === 'SUPERSEDED' && root.supersededAt !== undefined && authorization.issuedAt > root.supersededAt) {
      throw new PermanenceFabricError('Runtime authorization was issued after its root key was superseded.');
    }
    if (!verifyCanonical(root.publicKeyPem, runtimeAuthorizationPayload(authorization), authorization.signature)) throw new PermanenceFabricError('Runtime authorization signature is invalid.');
  }

  private async appendLineage(identity: JqIdentity, eventType: JqLineageEventType, subjectId: string, actorId: string, signerKeyId: string | undefined, sourceRecordDigest: string): Promise<{ entry: JqLineageEntry; identity: JqIdentity }> {
    const previous = (await this.lineage.query({ where: (entry) => entry.identityId === identity.id, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
    const now = Date.now();
    const draft: Omit<JqLineageEntry, 'hash'> = {
      id: randomUUID(), tenantId: identity.tenantId, identityId: identity.id, sequence: (previous?.sequence ?? 0) + 1,
      previousHash: previous?.hash ?? 'GENESIS', eventType, subjectId, actorId, signerKeyId, sourceRecordDigest, createdAt: now,
    };
    const entry: JqLineageEntry = { ...draft, hash: hashLineage({ ...draft, hash: '' }) };
    await this.lineage.put(entry);
    const updatedIdentity: JqIdentity = { ...identity, lineageHeadHash: entry.hash, updatedAt: now };
    await this.identities.put(updatedIdentity);
    return { entry, identity: updatedIdentity };
  }
}

function identityCreationPayload(value: Record<string, unknown>): Record<string, unknown> {
  const { stateRootReference: _stateRootReference, ...payload } = value;
  return payload;
}

function identityGenesisPayload(identity: JqIdentity, genesisRoot: JqRootKey): Record<string, unknown> {
  return {
    format: 'JQ-ID', version: 1, identityId: identity.id, tenantId: identity.tenantId, scope: identity.scope, label: identity.label,
    rootKey: publicRootKey(genesisRoot), capabilityRootReference: identity.capabilityRootReference,
    economicIdentityReference: identity.economicIdentityReference, discoveryMethods: identity.discoveryMethods, recoveryMethods: identity.recoveryMethods,
    privacyClassification: identity.privacyClassification, provenance: identity.provenance, createdAt: identity.createdAt,
  };
}

function identityPrintPayload(print: JqUniversalIdentityPrint): Record<string, unknown> {
  const { signature: _signature, ...payload } = print;
  return payload;
}

function runtimeAuthorizationPayload(authorization: Omit<JqRuntimeAuthorization, 'signature'> | JqRuntimeAuthorization): Record<string, unknown> {
  return {
    id: authorization.id, tenantId: authorization.tenantId, identityId: authorization.identityId, runtimeId: authorization.runtimeId,
    keyId: authorization.keyId, algorithm: authorization.algorithm, publicKeyPem: authorization.publicKeyPem, publicKeyFingerprint: authorization.publicKeyFingerprint,
    capabilities: authorization.capabilities, softwareVersion: authorization.softwareVersion, issuedAt: authorization.issuedAt, expiresAt: authorization.expiresAt,
    issuerRootKeyId: authorization.issuerRootKeyId, provenance: authorization.provenance, createdAt: authorization.createdAt,
  };
}

function runtimeAttestationPayload(attestation: JqRuntimeAttestation): Record<string, unknown> {
  return {
    id: attestation.id, tenantId: attestation.tenantId, identityId: attestation.identityId, runtimeAuthorizationId: attestation.runtimeAuthorizationId,
    runtimeId: attestation.runtimeId, softwareVersion: attestation.softwareVersion, stateCheckpointId: attestation.stateCheckpointId,
    integrityDigest: attestation.integrityDigest, availability: attestation.availability, capabilitySnapshot: attestation.capabilitySnapshot,
    issuedAt: attestation.issuedAt, expiresAt: attestation.expiresAt, signerKeyId: attestation.signerKeyId, provenance: attestation.provenance, createdAt: attestation.createdAt,
  };
}

function stateCheckpointPayload(checkpoint: JqStateCheckpoint): Record<string, unknown> {
  return {
    id: checkpoint.id, tenantId: checkpoint.tenantId, identityId: checkpoint.identityId, runtimeAuthorizationId: checkpoint.runtimeAuthorizationId,
    runtimeId: checkpoint.runtimeId, version: checkpoint.version, stateReference: checkpoint.stateReference, canonicalDigest: checkpoint.canonicalDigest,
    parentCheckpointId: checkpoint.parentCheckpointId, status: checkpoint.status, signerKeyId: checkpoint.signerKeyId,
    provenance: checkpoint.provenance, createdAt: checkpoint.createdAt,
  };
}

function discoveryPayload(record: Omit<JqDiscoveryRecord, 'signature'> | JqDiscoveryRecord): Record<string, unknown> {
  return {
    id: record.id, tenantId: record.tenantId, identityId: record.identityId, method: record.method, locatorReference: record.locatorReference,
    status: record.status, issuedAt: record.issuedAt, expiresAt: record.expiresAt, signerKeyId: record.signerKeyId,
    provenance: record.provenance, createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

function manifestationPayload(manifestation: Omit<JqManifestation, 'signature'> | JqManifestation): Record<string, unknown> {
  return {
    id: manifestation.id, tenantId: manifestation.tenantId, identityId: manifestation.identityId, runtimeAuthorizationId: manifestation.runtimeAuthorizationId,
    runtimeAttestationId: manifestation.runtimeAttestationId, type: manifestation.type, locatorReference: manifestation.locatorReference,
    authenticationReference: manifestation.authenticationReference, status: manifestation.status, issuedAt: manifestation.issuedAt,
    expiresAt: manifestation.expiresAt, signerKeyId: manifestation.signerKeyId, provenance: manifestation.provenance,
    createdAt: manifestation.createdAt, updatedAt: manifestation.updatedAt,
  };
}

function validateIdentityInput(input: CreateJqIdentityInput): void {
  if (!input || typeof input !== 'object') throw new PermanenceFabricError('JQ-ID identity input is required.');
  if (input.scope !== undefined && !IDENTITY_SCOPES.has(input.scope)) throw new PermanenceFabricError('JQ-ID identity scope is invalid.');
  cleanText(input.label, 'JQ-ID label', 240);
  optionalText(input.capabilityRootReference, 'Capability root reference', 500);
  optionalText(input.stateRootReference, 'State root reference', 500);
  optionalText(input.economicIdentityReference, 'Economic identity reference', 500);
  discoveryMethods(input.discoveryMethods ?? []);
  recoveryMethods(input.recoveryMethods ?? []);
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function validateRuntimeAuthorizationInput(input: AuthorizeJqRuntimeInput): void {
  if (!input || typeof input !== 'object') throw new PermanenceFabricError('Runtime authorization input is required.');
  cleanText(input.runtimeId, 'Runtime id', 240);
  cleanText(input.runtimeKeyId, 'Runtime key id', 180);
  normalizePublicKey(input.runtimePublicKeyPem);
  runtimeCapabilities(input.capabilities);
  cleanText(input.softwareVersion, 'Runtime software version', 180);
  optionalFutureTime(input.expiresAt, 'Runtime authorization expiry', Date.now());
  sanitizeProvenance(input.provenance);
}

function validateRuntimeAttestationInput(input: AttestJqRuntimeInput): void {
  if (!input || typeof input !== 'object') throw new PermanenceFabricError('Runtime attestation input is required.');
  cleanText(input.runtimeAuthorizationId, 'Runtime authorization id', 180);
  cleanText(input.softwareVersion, 'Runtime software version', 180);
  if (input.stateCheckpointId !== undefined) cleanText(input.stateCheckpointId, 'State checkpoint id', 180);
  normalizeDigest(input.integrityDigest, 'Runtime integrity digest');
  if (!['AVAILABLE', 'DEGRADED', 'UNAVAILABLE'].includes(input.availability)) throw new PermanenceFabricError('Runtime availability is invalid.');
  runtimeCapabilities(input.capabilitySnapshot);
  optionalFutureTime(input.expiresAt, 'Runtime attestation expiry', Date.now());
  sanitizeProvenance(input.provenance);
}

function validateStateCheckpointInput(input: RecordJqStateCheckpointInput): void {
  if (!input || typeof input !== 'object') throw new PermanenceFabricError('State checkpoint input is required.');
  cleanText(input.runtimeAuthorizationId, 'Runtime authorization id', 180);
  if (!Number.isInteger(input.version) || input.version < 1) throw new PermanenceFabricError('State checkpoint version must be a positive integer.');
  cleanText(input.stateReference, 'State reference', 640);
  normalizeDigest(input.canonicalDigest, 'State canonical digest');
  if (input.parentCheckpointId !== undefined) cleanText(input.parentCheckpointId, 'State checkpoint parent id', 180);
  sanitizeProvenance(input.provenance);
}

function validateDiscoveryInput(input: DeclareJqDiscoveryInput): void {
  if (!input || typeof input !== 'object') throw new PermanenceFabricError('Discovery input is required.');
  if (!DISCOVERY_METHODS.has(input.method)) throw new PermanenceFabricError('Discovery method is invalid.');
  cleanText(input.locatorReference, 'Discovery locator reference', 640);
  optionalFutureTime(input.expiresAt, 'Discovery expiry', Date.now());
  sanitizeProvenance(input.provenance);
}

function validateManifestationInput(input: DeclareJqManifestationInput): void {
  if (!input || typeof input !== 'object') throw new PermanenceFabricError('Manifestation input is required.');
  cleanText(input.runtimeAuthorizationId, 'Runtime authorization id', 180);
  cleanText(input.runtimeAttestationId, 'Runtime attestation id', 180);
  if (!MANIFESTATION_TYPES.has(input.type)) throw new PermanenceFabricError('Manifestation type is invalid.');
  cleanText(input.locatorReference, 'Manifestation locator reference', 640);
  optionalText(input.authenticationReference, 'Manifestation authentication reference', 500);
  optionalFutureTime(input.expiresAt, 'Manifestation expiry', Date.now());
  sanitizeProvenance(input.provenance);
}

function validateHandoverInput(input: PlanJqRuntimeHandoverInput): void {
  if (!input || typeof input !== 'object') throw new PermanenceFabricError('Runtime handover input is required.');
  for (const [name, value] of Object.entries({ sourceRuntimeAuthorizationId: input.sourceRuntimeAuthorizationId, targetRuntimeAuthorizationId: input.targetRuntimeAuthorizationId, targetRuntimeAttestationId: input.targetRuntimeAttestationId, stateCheckpointId: input.stateCheckpointId })) {
    cleanText(value, name, 180);
  }
  sanitizeProvenance(input.provenance);
}

function normalizeSigner(value: JqExternalSigner): JqExternalSigner {
  if (!value || typeof value !== 'object') throw new PermanenceFabricError('An injected JQ signer is required.');
  if (!SIGNATURE_ALGORITHMS.has(value.algorithm)) throw new PermanenceFabricError('Only ED25519 JQ signers are supported by this classical implementation.');
  if (typeof value.sign !== 'function') throw new PermanenceFabricError('Injected JQ signer must provide a sign function.');
  return {
    keyId: cleanText(value.keyId, 'JQ signer key id', 180),
    algorithm: 'ED25519',
    publicKeyPem: normalizePublicKey(value.publicKeyPem),
    sign: value.sign.bind(value),
  };
}

function assertCurrentRootSigner(identity: JqIdentity, signerInput: JqExternalSigner): JqExternalSigner {
  const signer = normalizeSigner(signerInput);
  const root = currentRootKey(identity);
  if (signer.keyId !== root.keyId || signer.publicKeyPem !== root.publicKeyPem || signer.algorithm !== root.algorithm) {
    throw new PermanenceFabricError('Injected signer does not match the active JQ root key.');
  }
  return signer;
}

function assertRuntimeSigner(authorization: JqRuntimeAuthorization, signerInput: JqExternalSigner): JqExternalSigner {
  const signer = normalizeSigner(signerInput);
  if (signer.keyId !== authorization.keyId || signer.publicKeyPem !== authorization.publicKeyPem || signer.algorithm !== authorization.algorithm) {
    throw new PermanenceFabricError('Injected signer does not match the root-authorized runtime key.');
  }
  return signer;
}

function currentRootKey(identity: JqIdentity): JqRootKey {
  const root = identity.rootKeys.find((key) => key.keyId === identity.activeRootKeyId && key.status === 'ACTIVE');
  if (!root) throw new PermanenceFabricError('JQ-ID has no active root key.');
  return root;
}

async function signAndVerify(signer: JqExternalSigner, payload: unknown): Promise<string> {
  const canonicalPayload = canonical(payload);
  const signature = await signer.sign(canonicalPayload);
  if (typeof signature !== 'string' || !signature.trim()) throw new PermanenceFabricError('Injected JQ signer returned an invalid signature.');
  if (!verifyCanonical(signer.publicKeyPem, payload, signature)) throw new PermanenceFabricError('Injected JQ signer signature failed local Ed25519 verification.');
  return signature;
}

function verifyCanonical(publicKeyPem: string, payload: unknown, signature: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verifySignature(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function publicRootKey(key: JqRootKey): Pick<JqRootKey, 'keyId' | 'algorithm' | 'publicKeyPem' | 'fingerprint'> {
  return { keyId: key.keyId, algorithm: key.algorithm, publicKeyPem: key.publicKeyPem, fingerprint: key.fingerprint };
}

function runtimeCapabilities(value: unknown): JqRuntimeCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CAPABILITIES) throw new PermanenceFabricError(`Runtime capabilities must contain one to ${MAX_CAPABILITIES} values.`);
  const capabilities = value.map((capability) => {
    if (typeof capability !== 'string' || !RUNTIME_CAPABILITIES.has(capability as JqRuntimeCapability)) throw new PermanenceFabricError('Runtime capability is invalid.');
    return capability as JqRuntimeCapability;
  });
  if (new Set(capabilities).size !== capabilities.length) throw new PermanenceFabricError('Runtime capabilities must be distinct.');
  return capabilities;
}

function discoveryMethods(value: unknown): JqDiscoveryMethod[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw new PermanenceFabricError(`Discovery methods must be an array with at most ${MAX_LIST_ITEMS} values.`);
  const methods = value.map((method) => {
    if (typeof method !== 'string' || !DISCOVERY_METHODS.has(method as JqDiscoveryMethod)) throw new PermanenceFabricError('Discovery method is invalid.');
    return method as JqDiscoveryMethod;
  });
  if (new Set(methods).size !== methods.length) throw new PermanenceFabricError('Discovery methods must be distinct.');
  return methods;
}

function recoveryMethods(value: unknown): JqRecoveryMethod[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw new PermanenceFabricError(`Recovery methods must be an array with at most ${MAX_LIST_ITEMS} values.`);
  const methods = value.map((method) => {
    if (typeof method !== 'string' || !RECOVERY_METHODS.has(method as JqRecoveryMethod)) throw new PermanenceFabricError('Recovery method is invalid.');
    return method as JqRecoveryMethod;
  });
  if (new Set(methods).size !== methods.length) throw new PermanenceFabricError('Recovery methods must be distinct.');
  return methods;
}

function sanitizeProvenance(value: unknown): CommercialProvenance {
  const provenance = record(value, 'Provenance');
  return {
    source: cleanText(provenance.source, 'Provenance source', 180),
    collectedAt: positiveTimestamp(provenance.collectedAt, 'Provenance collection time'),
    correlationId: optionalText(provenance.correlationId, 'Provenance correlation id', 180),
    causationId: optionalText(provenance.causationId, 'Provenance causation id', 180),
    sourceReference: optionalText(provenance.sourceReference, 'Provenance source reference', 500),
    contentHash: optionalText(provenance.contentHash, 'Provenance content hash', 180),
  };
}

function normalizePublicKey(value: unknown): string {
  // PEM is deliberately not passed through cleanText(): collapsing line breaks
  // would corrupt a valid public key. Private key material is never accepted.
  if (typeof value !== 'string') throw new PermanenceFabricError('Public key PEM must be a string.');
  const pem = value.trim();
  if (!pem || pem.length > 8_000) throw new PermanenceFabricError('Public key PEM is required and must be bounded.');
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new PermanenceFabricError('Public key must be an Ed25519 public key.');
  } catch (error) {
    if (error instanceof PermanenceFabricError) throw error;
    throw new PermanenceFabricError('Public key PEM could not be parsed as Ed25519.');
  }
  return pem;
}

function normalizeDigest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new PermanenceFabricError(`${name} must be a 64-character SHA-256 hex digest.`);
  return value.toLowerCase();
}

function optionalFutureTime(value: unknown, name: string, now: number): number | undefined {
  if (value === undefined) return undefined;
  const time = positiveTimestamp(value, name);
  if (time <= now) throw new PermanenceFabricError(`${name} must be in the future.`);
  return time;
}

function isExpired(expiresAt: number | undefined, now: number): boolean {
  return expiresAt !== undefined && expiresAt <= now;
}

function isValidAttestation(attestation: JqRuntimeAttestation, now: number): boolean {
  return attestation.status === 'VALID' && !isExpired(attestation.expiresAt, now);
}

function assertIdentityManager(actor: CommercialActor): void {
  assertActor(actor);
  if (!actor.roles.some((role) => role === 'admin' || role === 'global_admin' || role === 'system')) throw new PermanenceFabricError('JQ-ID identity management requires an administrator or system actor.');
}

function assertRuntimeManager(actor: CommercialActor): void {
  assertActor(actor);
  if (!actor.roles.some((role) => role === 'operator' || role === 'admin' || role === 'global_admin' || role === 'system')) throw new PermanenceFabricError('JQ runtime/state operations require an operator, administrator, or system actor.');
}

function assertActor(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new PermanenceFabricError('A tenant-bound JQ actor is required.');
}

function canReadIdentity(actor: CommercialActor, identity: JqIdentity): boolean {
  if (!canReadTenant(actor, identity.tenantId)) return false;
  return identity.scope !== 'SYSTEM' || actor.roles.includes('global_admin') || actor.roles.includes('system');
}

function canReadTenant(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function privacyClassification(value: unknown): PrivacyClassification {
  if (value === undefined) return 'INTERNAL';
  if (typeof value !== 'string' || !PRIVACY_CLASSIFICATIONS.has(value as PrivacyClassification)) throw new PermanenceFabricError('Privacy classification is invalid.');
  return value as PrivacyClassification;
}

function positiveTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new PermanenceFabricError(`${name} must be a positive finite timestamp.`);
  return value;
}

function cleanText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new PermanenceFabricError(`${name} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) throw new PermanenceFabricError(`${name} is required.`);
  return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : cleanText(value, name, maxLength);
}

function keyFingerprint(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex');
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function hashLineage(entry: JqLineageEntry): string {
  return digest(entry);
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const recordValue = value as Record<string, unknown>;
  return `{${Object.keys(recordValue).filter((key) => recordValue[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(recordValue[key])}`).join(',')}}`;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PermanenceFabricError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function sorted<T extends { id: string; createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Signature verification failed.';
  return message.replace(/\b(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 280);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
