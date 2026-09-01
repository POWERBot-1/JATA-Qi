import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialEvidence, CommercialProvenance, EvidenceStatus } from '@jataqi/commercial-control-plane';
import {
  VisibilityFabricEvents,
  type BrandPolicy,
  type CommercialClaim,
  type CreateBrandPolicyInput,
  type CreateCreativeAssetInput,
  type CreativeAsset,
  type CreativeDistributionRecord,
  type CreativeValidation,
  type RecordCreativeDistributionInput,
} from './types.js';

const ASSETS_COLLECTION = 'visibility-fabric.assets';
const POLICIES_COLLECTION = 'visibility-fabric.brand-policies';
const VALIDATIONS_COLLECTION = 'visibility-fabric.validations';
const VERIFIED_CLAIM_STATUSES = new Set<EvidenceStatus>(['MEASURED', 'DEMONSTRATED', 'CUSTOMER_CONFIRMED', 'REPEATED', 'VERIFIED']);

export class VisibilityFabricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisibilityFabricError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Universal creative artifact registry. It stores platform-neutral content and
 * claim provenance, but cannot publish content itself. Distribution is only
 * recorded as confirmed when confirmation evidence is supplied.
 */
export class UniversalVisibilityFabricService {
  private assets!: ICollection<CreativeAsset>;
  private policies!: ICollection<BrandPolicy>;
  private validations!: ICollection<CreativeValidation>;
  private controlPlane!: CommercialControlPlaneService;

  async init(kernel: KernelApi): Promise<void> {
    const storage = kernel.getModule<StorageModule>('storage');
    this.assets = await storage.collection<CreativeAsset>(ASSETS_COLLECTION);
    this.policies = await storage.collection<BrandPolicy>(POLICIES_COLLECTION);
    this.validations = await storage.collection<CreativeValidation>(VALIDATIONS_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  async createBrandPolicy(actor: CommercialActor, input: CreateBrandPolicyInput): Promise<BrandPolicy> {
    assertAdministrator(actor);
    if (!input.version.trim()) throw new VisibilityFabricError('Brand policy version is required.');
    if (input.minimumClaimConfidence !== undefined) assertScore(input.minimumClaimConfidence, 'Brand policy minimum claim confidence');
    const now = Date.now();
    const policy: BrandPolicy = {
      id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, version: input.version,
      requiredBrandTerms: uniqueTrimmed(input.requiredBrandTerms), blockedPhrases: uniqueTrimmed(input.blockedPhrases), allowedLocales: uniqueTrimmed(input.allowedLocales),
      minimumClaimConfidence: input.minimumClaimConfidence, active: true, createdAt: now, updatedAt: now,
    };
    await this.policies.put(policy);
    return copy(policy);
  }

  async createAsset(actor: CommercialActor, input: CreateCreativeAssetInput): Promise<CreativeAsset> {
    assertManager(actor);
    validateAssetInput(input);
    const now = Date.now();
    const asset: CreativeAsset = {
      id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, campaignId: input.campaignId, title: input.title,
      content: input.content, contentType: input.contentType, creativeGenome: input.creativeGenome ? copy(input.creativeGenome) : undefined,
      source: input.source, generationModel: input.generationModel ? copy(input.generationModel) : undefined, promptLineageReference: input.promptLineageReference,
      inputEvidence: copy(input.inputEvidence), claims: copy(input.claims ?? []), brandVersion: input.brandVersion, language: input.language, locale: input.locale,
      platform: input.platform, variant: input.variant, license: input.license, rights: input.rights, permissionReference: input.permissionReference,
      contentHash: contentHash(input), createdAt: now, updatedAt: now, distributionHistory: [], status: 'DRAFT', blockReasons: [],
      privacyClassification: input.privacyClassification ?? 'INTERNAL',
    };
    await this.assets.put(asset);
    await this.emit(actor, VisibilityFabricEvents.AssetCreated, asset.id, { assetId: asset.id, productId: asset.productId, contentHash: asset.contentHash });
    return copy(asset);
  }

  /** Validate claims, brand constraints, and locale constraints without publishing the asset. */
  async validateAsset(actor: CommercialActor, assetId: string): Promise<CreativeValidation> {
    assertManager(actor);
    const asset = await this.requireAsset(actor, assetId);
    if (asset.status === 'RETIRED') throw new VisibilityFabricError('A retired creative asset cannot be validated.');
    const policies = (await this.policies.all()).filter((policy) => policy.active && policy.tenantId === asset.tenantId && (policy.productId === undefined || policy.productId === asset.productId));
    const reasons = validateAssetAgainstPolicies(asset, policies);
    const validation: CreativeValidation = { id: randomUUID(), tenantId: asset.tenantId, assetId: asset.id, policyIds: policies.map((policy) => policy.id), passed: reasons.length === 0, reasons, validatedAt: Date.now() };
    await this.validations.put(validation);
    const updated: CreativeAsset = { ...asset, status: validation.passed ? 'VALIDATING' : 'BLOCKED', blockReasons: validation.passed ? [] : reasons, updatedAt: Date.now() };
    await this.assets.put(updated);
    await this.emit(actor, validation.passed ? VisibilityFabricEvents.AssetValidated : VisibilityFabricEvents.AssetBlocked, asset.id, { assetId: asset.id, validationId: validation.id, passed: validation.passed, reasons });
    return copy(validation);
  }

  async approveAsset(actor: CommercialActor, assetId: string, validationId: string): Promise<CreativeAsset> {
    assertApprover(actor);
    const asset = await this.requireAsset(actor, assetId);
    const validation = await this.validations.get(validationId);
    if (!validation || validation.tenantId !== asset.tenantId || validation.assetId !== asset.id || !validation.passed) throw new VisibilityFabricError('A passing validation for this asset is required before approval.');
    if (asset.status !== 'VALIDATING') throw new VisibilityFabricError(`Asset cannot be approved from ${asset.status}.`);
    const updated: CreativeAsset = { ...asset, status: 'APPROVED', updatedAt: Date.now() };
    await this.assets.put(updated);
    await this.emit(actor, VisibilityFabricEvents.AssetApproved, asset.id, { assetId: asset.id, validationId });
    return copy(updated);
  }

  /** Record a result; simulation is distinct from independently confirmed distribution. */
  async recordDistribution(actor: CommercialActor, assetId: string, input: RecordCreativeDistributionInput): Promise<CreativeAsset> {
    assertManager(actor);
    const asset = await this.requireAsset(actor, assetId);
    if (!['APPROVED', 'DISTRIBUTION_READY', 'DISTRIBUTED'].includes(asset.status)) throw new VisibilityFabricError(`Asset ${asset.id} is not approved for distribution.`);
    if (!input.channel.trim()) throw new VisibilityFabricError('Distribution channel is required.');
    const simulated = input.simulated ?? false;
    if (input.confirmed && simulated) throw new VisibilityFabricError('A simulated distribution cannot be recorded as externally confirmed.');
    if (input.confirmed && (!input.evidence.length || input.evidence.some((item) => !VERIFIED_CLAIM_STATUSES.has(item.status)))) {
      throw new VisibilityFabricError('Confirmed distribution requires measured, demonstrated, customer-confirmed, repeated, or verified evidence.');
    }
    const now = Date.now();
    const record: CreativeDistributionRecord = {
      id: randomUUID(), channel: input.channel, connectorId: input.connectorId, externalReference: input.externalReference,
      simulated, confirmedAt: input.confirmed ? now : undefined, evidence: copy(input.evidence), result: simulated ? 'SIMULATED' : input.confirmed ? 'CONFIRMED' : 'FAILED',
    };
    const updated: CreativeAsset = {
      ...asset, distributionHistory: [...asset.distributionHistory, record], status: input.confirmed ? 'DISTRIBUTED' : asset.status,
      updatedAt: now,
    };
    await this.assets.put(updated);
    await this.emit(actor, VisibilityFabricEvents.AssetDistributed, asset.id, { assetId: asset.id, distributionId: record.id, result: record.result, channel: record.channel });
    return copy(updated);
  }

  async getAsset(actor: CommercialActor, assetId: string): Promise<CreativeAsset | undefined> {
    const asset = await this.assets.get(assetId);
    return asset && canRead(actor, asset.tenantId) ? copy(asset) : undefined;
  }

  async listAssets(actor: CommercialActor): Promise<CreativeAsset[]> {
    return (await this.assets.all()).filter((asset) => canRead(actor, asset.tenantId)).map(copy);
  }

  private async requireAsset(actor: CommercialActor, assetId: string): Promise<CreativeAsset> {
    const asset = await this.getAsset(actor, assetId);
    if (!asset) throw new VisibilityFabricError('Creative asset not found.');
    return asset;
  }

  private async emit(actor: CommercialActor, eventType: string, entityId: string, payload: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'universal-visibility-fabric', collectedAt: now, correlationId: entityId };
    await this.controlPlane.publishEvent(actor, { eventType, source: 'universal-visibility-fabric', entityId, correlationId: entityId, payload, provenance, privacyClassification: 'INTERNAL', idempotencyKey: `${eventType}:${entityId}` });
  }
}

function validateAssetAgainstPolicies(asset: CreativeAsset, policies: readonly BrandPolicy[]): string[] {
  const reasons: string[] = [];
  const content = `${asset.title ?? ''}\n${asset.content}`.toLocaleLowerCase();
  for (const claim of asset.claims) {
    if (!claim.text.trim()) reasons.push(`Claim ${claim.id} has no text.`);
    if (!claim.evidence.length || !VERIFIED_CLAIM_STATUSES.has(claim.evidenceStatus)) reasons.push(`Claim ${claim.id} is ${claim.evidenceStatus} and cannot be approved as a supported marketing claim.`);
  }
  for (const policy of policies) {
    for (const phrase of policy.blockedPhrases ?? []) if (content.includes(phrase.toLocaleLowerCase())) reasons.push(`Asset contains blocked phrase "${phrase}" from policy ${policy.id}.`);
    for (const term of policy.requiredBrandTerms ?? []) if (!content.includes(term.toLocaleLowerCase())) reasons.push(`Asset is missing required brand term "${term}" from policy ${policy.id}.`);
    if (policy.allowedLocales?.length && asset.locale && !policy.allowedLocales.includes(asset.locale)) reasons.push(`Asset locale ${asset.locale} is not allowed by policy ${policy.id}.`);
    if (policy.minimumClaimConfidence !== undefined) {
      for (const claim of asset.claims) if (claim.confidence < policy.minimumClaimConfidence) reasons.push(`Claim ${claim.id} confidence is below policy ${policy.id} minimum.`);
    }
  }
  return [...new Set(reasons)];
}

function validateAssetInput(input: CreateCreativeAssetInput): void {
  for (const [name, value] of Object.entries({ productId: input.productId, content: input.content, contentType: input.contentType, source: input.source, language: input.language })) {
    if (!value.trim()) throw new VisibilityFabricError(`Creative asset ${name} is required.`);
  }
  if (!input.inputEvidence.length) throw new VisibilityFabricError('Creative assets require input evidence/provenance.');
  for (const claim of input.claims ?? []) validateClaim(claim);
}

function validateClaim(claim: CommercialClaim): void {
  if (!claim.id.trim() || !claim.text.trim() || !claim.provenance.source.trim() || !Number.isFinite(claim.provenance.collectedAt)) throw new VisibilityFabricError('Every claim requires id, text, and provenance.');
  assertScore(claim.confidence, 'Claim confidence');
}

function contentHash(input: CreateCreativeAssetInput): string {
  return createHash('sha256').update(JSON.stringify({ title: input.title, content: input.content, contentType: input.contentType, productId: input.productId, campaignId: input.campaignId, locale: input.locale, variant: input.variant })).digest('hex');
}

function uniqueTrimmed(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function assertScore(value: number, name: string): void { if (!Number.isFinite(value) || value < 0 || value > 100) throw new VisibilityFabricError(`${name} must be from 0 to 100.`); }
function assertAdministrator(actor: CommercialActor): void { if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new VisibilityFabricError('Commercial administrator role is required.'); }
function assertApprover(actor: CommercialActor): void { if (!actor.roles.some((role) => ['approver', 'admin', 'global_admin'].includes(role))) throw new VisibilityFabricError('Commercial approver role is required.'); }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new VisibilityFabricError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
