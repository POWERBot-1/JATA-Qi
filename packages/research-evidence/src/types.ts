import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';

/** High-level research area classification; it does not enable domain operations. */
export type ResearchDomain =
  | 'GENERAL'
  | 'SOFTWARE'
  | 'MATERIALS'
  | 'LIFE_SCIENCES'
  | 'MEDICAL'
  | 'AEROSPACE'
  | 'NUCLEAR'
  | 'SEMICONDUCTOR';

/** Risk label used to route later human/regulatory gates, never to authorize work. */
export type ResearchSafetyClassification = 'STANDARD' | 'SENSITIVE' | 'REGULATED_OR_HAZARDOUS';

export type ResearchClaimStatus =
  | 'OPEN'
  | 'UNDER_REVIEW'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CONFLICTING_EVIDENCE'
  | 'REPRODUCIBILITY_REQUIRED'
  | 'CONDITIONALLY_SUPPORTED';

/** Persistent hypothesis record. A claim is never automatically promoted to a discovery or fact. */
export interface ResearchClaim {
  id: string;
  tenantId: string;
  cognitiveStateId: string;
  domain: ResearchDomain;
  safetyClassification: ResearchSafetyClassification;
  hypothesis: string;
  assumptions: string[];
  limitations: string[];
  privacyClassification: PrivacyClassification;
  status: ResearchClaimStatus;
  latestAssessmentId?: string;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface CreateResearchClaimInput {
  cognitiveStateId: string;
  domain: ResearchDomain;
  safetyClassification: ResearchSafetyClassification;
  hypothesis: string;
  assumptions: string[];
  limitations: string[];
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

export type ResearchEvidenceKind =
  | 'OBSERVATION'
  | 'MEASUREMENT'
  | 'SIMULATION'
  | 'ANALYSIS'
  | 'LITERATURE'
  | 'REPLICATION'
  | 'EXPERT_REVIEW'
  | 'REGULATORY_RECORD';

export type ResearchEpistemicStatus = 'OBSERVED' | 'INFERRED' | 'HYPOTHESIZED' | 'SIMULATED' | 'UNKNOWN';

/**
 * High-level, hash-chained evidence metadata. It intentionally stores concise
 * summaries and references, not raw datasets, wet-lab protocols, or executable
 * physical experiment instructions.
 */
export interface ResearchEvidenceRecord {
  id: string;
  tenantId: string;
  claimId: string;
  sequence: number;
  previousHash: string;
  hash: string;
  kind: ResearchEvidenceKind;
  epistemicStatus: ResearchEpistemicStatus;
  summary: string;
  methodologySummary: string;
  limitations: string[];
  evidence: CommercialEvidence[];
  reproducibilityRecordIds: string[];
  safetyClassification: ResearchSafetyClassification;
  privacyClassification: PrivacyClassification;
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface RecordResearchEvidenceInput {
  claimId: string;
  kind: ResearchEvidenceKind;
  epistemicStatus: ResearchEpistemicStatus;
  summary: string;
  methodologySummary: string;
  limitations: string[];
  evidence: CommercialEvidence[];
  reproducibilityRecordIds?: string[];
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

export type ResearchAssessmentStatus = 'INSUFFICIENT_EVIDENCE' | 'CONFLICTING_EVIDENCE' | 'REPRODUCIBILITY_REQUIRED' | 'CONDITIONALLY_SUPPORTED';

export type ResearchNextStep = 'NO_ACTION' | 'GATHER_EVIDENCE' | 'REQUEST_REPRODUCTION' | 'REQUEST_HUMAN_REVIEW_AND_REGULATORY_GATE';

/**
 * A deterministic assessment of recorded evidence metadata. It is not a
 * discovery claim, a physical authorization, a clinical conclusion, or a
 * substitute for qualified review.
 */
export interface ResearchClaimAssessment {
  id: string;
  tenantId: string;
  claimId: string;
  evidenceRecordIds: string[];
  evidenceIds: string[];
  reproducibilityRecordIds: string[];
  independentStrongSourceCount: number;
  strongEvidenceCount: number;
  simulationOnly: boolean;
  status: ResearchAssessmentStatus;
  conclusionSummary: string;
  uncertaintySummary: string;
  nextStep: ResearchNextStep;
  regulatedWorkRequiresHumanReview: boolean;
  physicalExecutionAuthorization: 'NOT_AUTHORIZED';
  createdAt: number;
}

export interface ResearchEvidenceIntegrityResult {
  tenantId: string;
  valid: boolean;
  recordCount: number;
  failure?: string;
}

export const ResearchEvidenceEvents = Object.freeze({
  ClaimCreated: 'research.evidence.claim.created',
  EvidenceRecorded: 'research.evidence.recorded',
  ClaimAssessed: 'research.evidence.claim.assessed',
} as const);

export type { CommercialActor };
