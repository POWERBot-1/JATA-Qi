import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import type { ResearchDomain, ResearchSafetyClassification } from '@jataqi/research-evidence';

/** High-level review categories, not permissions to operate in a regulated domain. */
export type HumanReviewType = 'SCIENTIFIC' | 'DOMAIN' | 'SAFETY' | 'ETHICS' | 'REGULATORY' | 'REPRODUCIBILITY';
export type AttestationDomainScope = ResearchDomain | 'ALL';

/**
 * The registry records an upstream assertion; it does not independently verify
 * a person's identity, qualifications, license, employer, or authorization.
 */
export type ReviewerVerificationStatus = 'DECLARED' | 'ORGANIZATION_ASSERTED' | 'REVOKED' | 'EXPIRED';

export interface HumanReviewerAttestation {
  id: string;
  tenantId: string;
  reviewerActorId: string;
  domainScopes: AttestationDomainScope[];
  reviewTypes: HumanReviewType[];
  competencyIds: string[];
  verificationStatus: ReviewerVerificationStatus;
  attestedByActorId: string;
  expiresAt?: number;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterHumanReviewerInput {
  reviewerActorId: string;
  domainScopes: AttestationDomainScope[];
  reviewTypes: HumanReviewType[];
  competencyIds: string[];
  verificationStatus: Extract<ReviewerVerificationStatus, 'DECLARED' | 'ORGANIZATION_ASSERTED'>;
  expiresAt?: number;
  provenance: CommercialProvenance;
}

export type HumanApprovalRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

/**
 * A research-review approval request. Even APPROVED means only that the
 * configured human-review quorum was recorded; it is never physical execution
 * authorization, regulatory clearance, certification, or a CCP policy change.
 */
export interface HumanApprovalRequest {
  id: string;
  tenantId: string;
  claimId: string;
  assessmentId?: string;
  evidenceRecordIds: string[];
  requestedByActorId: string;
  purposeSummary: string;
  requiredReviewTypes: HumanReviewType[];
  requiredCompetencyIds: string[];
  requiredApprovalCount: number;
  safetyClassification: ResearchSafetyClassification;
  privacyClassification: PrivacyClassification;
  status: HumanApprovalRequestStatus;
  expiresAt?: number;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface CreateHumanApprovalRequestInput {
  claimId: string;
  assessmentId?: string;
  evidenceRecordIds?: string[];
  purposeSummary: string;
  requiredReviewTypes: HumanReviewType[];
  requiredCompetencyIds: string[];
  requiredApprovalCount?: number;
  expiresAt?: number;
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

export type HumanApprovalVoteDecision = 'APPROVE' | 'REJECT';

/** Immutable hash-chained human review record; rationale is a bounded audit summary only. */
export interface HumanApprovalVote {
  id: string;
  tenantId: string;
  requestId: string;
  attestationId: string;
  reviewerActorId: string;
  decision: HumanApprovalVoteDecision;
  reviewTypes: HumanReviewType[];
  competencyIds: string[];
  rationaleSummary: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  sequence: number;
  previousHash: string;
  hash: string;
  createdAt: number;
}

export interface SubmitHumanApprovalVoteInput {
  attestationId: string;
  decision: HumanApprovalVoteDecision;
  reviewTypes: HumanReviewType[];
  competencyIds: string[];
  rationaleSummary: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface HumanApprovalProgress {
  request: HumanApprovalRequest;
  approvedVoteCount: number;
  rejectedVoteCount: number;
  coveredReviewTypes: HumanReviewType[];
  coveredCompetencyIds: string[];
  missingReviewTypes: HumanReviewType[];
  missingCompetencyIds: string[];
  quorumSatisfied: boolean;
  doesNotAuthorizePhysicalExecution: true;
}

export interface HumanApprovalIntegrityResult {
  tenantId: string;
  valid: boolean;
  voteCount: number;
  failure?: string;
}

export const HumanApprovalEvents = Object.freeze({
  ReviewerAttested: 'research.human_approval.reviewer.attested',
  ReviewerRevoked: 'research.human_approval.reviewer.revoked',
  RequestCreated: 'research.human_approval.request.created',
  VoteRecorded: 'research.human_approval.vote.recorded',
  RequestUpdated: 'research.human_approval.request.updated',
  RequestCancelled: 'research.human_approval.request.cancelled',
} as const);

export type { CommercialActor };
