import type { CommercialEvidence, CommercialProvenance, EvidenceStatus, PrivacyClassification } from '@jataqi/commercial-control-plane';

export type CreativeAssetStatus = 'DRAFT' | 'VALIDATING' | 'APPROVED' | 'DISTRIBUTION_READY' | 'DISTRIBUTED' | 'DECAYING' | 'RETIRED' | 'BLOCKED';

export interface CommercialClaim {
  id: string;
  text: string;
  evidenceStatus: EvidenceStatus;
  evidence: CommercialEvidence[];
  confidence: number;
  permissionReference?: string;
  provenance: CommercialProvenance;
}

export interface CreativeAsset {
  id: string;
  tenantId: string;
  productId: string;
  campaignId?: string;
  title?: string;
  content: string;
  contentType: string;
  creativeGenome?: Record<string, unknown>;
  source: string;
  generationModel?: { id: string; version: string };
  promptLineageReference?: string;
  inputEvidence: CommercialEvidence[];
  claims: CommercialClaim[];
  brandVersion?: string;
  language: string;
  locale?: string;
  platform?: string;
  variant?: string;
  license?: string;
  rights?: string;
  permissionReference?: string;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  distributionHistory: CreativeDistributionRecord[];
  performance?: Record<string, unknown>;
  status: CreativeAssetStatus;
  blockReasons: string[];
  privacyClassification: PrivacyClassification;
}

export interface CreateCreativeAssetInput {
  productId: string;
  campaignId?: string;
  title?: string;
  content: string;
  contentType: string;
  creativeGenome?: Record<string, unknown>;
  source: string;
  generationModel?: { id: string; version: string };
  promptLineageReference?: string;
  inputEvidence: CommercialEvidence[];
  claims?: CommercialClaim[];
  brandVersion?: string;
  language: string;
  locale?: string;
  platform?: string;
  variant?: string;
  license?: string;
  rights?: string;
  permissionReference?: string;
  privacyClassification?: PrivacyClassification;
}

export interface BrandPolicy {
  id: string;
  tenantId: string;
  productId?: string;
  version: string;
  requiredBrandTerms?: string[];
  blockedPhrases?: string[];
  allowedLocales?: string[];
  minimumClaimConfidence?: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBrandPolicyInput {
  productId?: string;
  version: string;
  requiredBrandTerms?: string[];
  blockedPhrases?: string[];
  allowedLocales?: string[];
  minimumClaimConfidence?: number;
}

export interface CreativeValidation {
  id: string;
  tenantId: string;
  assetId: string;
  policyIds: string[];
  passed: boolean;
  reasons: string[];
  validatedAt: number;
}

export interface CreativeDistributionRecord {
  id: string;
  channel: string;
  connectorId?: string;
  externalReference?: string;
  simulated: boolean;
  confirmedAt?: number;
  evidence: CommercialEvidence[];
  result: 'SIMULATED' | 'CONFIRMED' | 'FAILED';
}

export interface RecordCreativeDistributionInput {
  channel: string;
  connectorId?: string;
  externalReference?: string;
  simulated?: boolean;
  confirmed: boolean;
  evidence: CommercialEvidence[];
}

export const VisibilityFabricEvents = Object.freeze({
  AssetCreated: 'visibility.asset.created',
  AssetValidated: 'visibility.asset.validated',
  AssetApproved: 'visibility.asset.approved',
  AssetDistributed: 'visibility.asset.distributed',
  AssetBlocked: 'visibility.asset.blocked',
} as const);
