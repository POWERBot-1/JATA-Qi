import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';

/** Deliberate reviewer specializations for JQB's structured critique layer. */
export type ReviewerRole =
  | 'RESEARCH_AGENT'
  | 'CRITIC_AGENT'
  | 'STATISTICS_AGENT'
  | 'DOMAIN_AGENT'
  | 'SAFETY_AGENT'
  | 'RED_TEAM_AGENT'
  | 'REPRODUCIBILITY_AGENT';

/** A reviewer conclusion, not a factual finding or action authorization. */
export type ReviewVerdict =
  | 'SUPPORTS'
  | 'CHALLENGES'
  | 'INCONCLUSIVE'
  | 'SAFETY_ESCALATION_RECOMMENDED'
  | 'REPRODUCIBILITY_REQUIRED';

/**
 * These are review-level dispositions only. This package has no execution,
 * connector, credential, policy-bypass, or action-runtime capability.
 */
export type ReviewActionDisposition =
  | 'NO_ACTION'
  | 'GATHER_EVIDENCE'
  | 'REQUEST_HUMAN_REVIEW'
  | 'REQUEST_REPRODUCTION'
  | 'ESCALATE_SAFETY'
  | 'GOVERNED_ACTION_CANDIDATE';

export interface CritiqueActionProposal {
  disposition: ReviewActionDisposition;
  /** Bounded, auditable summary; never an executable command or tool payload. */
  summary: string;
}

export type ClaimPosition = 'SUPPORTS' | 'CHALLENGES' | 'UNCERTAIN';

/** A concise, evidence-referenced assertion; no hidden reasoning trace is stored. */
export interface ReviewClaim {
  proposition: string;
  position: ClaimPosition;
  evidenceIds: string[];
  confidence: number;
  uncertainty?: string;
}

/**
 * The only accepted reviewer output format. It intentionally contains concise
 * audit summaries, evidence references, assumptions, and uncertainty—not a
 * model prompt, raw tool transcript, or hidden chain-of-thought.
 */
export interface StructuredReviewMessage {
  hypothesis: string;
  evidenceIds: string[];
  assumptions: string[];
  confidence: number;
  proposedAction: CritiqueActionProposal;
  uncertainty: string[];
  verdict: ReviewVerdict;
  conclusionSummary: string;
  claims?: ReviewClaim[];
  safetyConcerns?: string[];
  consistencyConcerns?: string[];
  provenance: CommercialProvenance;
}

export interface ReviewerDescriptor {
  id: string;
  role: ReviewerRole;
  label?: string;
  capabilitySummary?: string;
}

/**
 * Application-injected reviewer boundary. No reviewer is bundled or invoked by
 * default. Hosts are responsible for sandboxing/restricting injected code.
 */
export interface MultiAgentReviewer extends ReviewerDescriptor {
  review(request: MultiAgentReviewRequest): Promise<StructuredReviewMessage> | StructuredReviewMessage;
}

/** A data-only request with no connector, tool, credential, or action handle. */
export interface MultiAgentReviewRequest {
  deliberationId: string;
  tenantId: string;
  cognitiveStateId: string;
  title: string;
  hypothesis: string;
  evidence: CommercialEvidence[];
  assumptions: string[];
  confidence: number;
  proposedAction: CritiqueActionProposal;
  uncertainty: string[];
  requestedRoles: ReviewerRole[];
  privacyClassification: PrivacyClassification;
}

export interface MultiAgentCognitionConfig {
  /** Optional application-injected reviewers. The default is an empty registry. */
  reviewers?: readonly MultiAgentReviewer[];
  /** Maximum explicit attempts per reviewer/deliberation. Default 2; bounded to 1–3. */
  maxReviewAttempts?: number;
}

export type DeliberationStatus =
  | 'OPEN'
  | 'UNDER_REVIEW'
  | 'READY_FOR_SYNTHESIS'
  | 'SYNTHESIZED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'SAFETY_ESCALATED';

/** Persistent, tenant-bound deliberation over a hypothesis—not a decision to execute. */
export interface MultiAgentDeliberation {
  id: string;
  tenantId: string;
  cognitiveStateId: string;
  title: string;
  hypothesis: string;
  evidence: CommercialEvidence[];
  assumptions: string[];
  confidence: number;
  proposedAction: CritiqueActionProposal;
  uncertainty: string[];
  requestedRoles: ReviewerRole[];
  status: DeliberationStatus;
  privacyClassification: PrivacyClassification;
  provenance: CommercialProvenance;
  latestSynthesisId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMultiAgentDeliberationInput {
  cognitiveStateId: string;
  title: string;
  hypothesis: string;
  evidence: CommercialEvidence[];
  assumptions: string[];
  confidence: number;
  proposedAction: CritiqueActionProposal;
  uncertainty: string[];
  requestedRoles: ReviewerRole[];
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

export type DeliberationReviewState = 'COMPLETED' | 'FAILED';

export interface DeliberationReview {
  id: string;
  tenantId: string;
  deliberationId: string;
  reviewerId: string;
  reviewerRole: ReviewerRole;
  attempt: number;
  state: DeliberationReviewState;
  message?: StructuredReviewMessage;
  /** Bounded/redacted diagnostic only; no error stack or raw provider response. */
  failureCode?: 'REVIEWER_ERROR' | 'INVALID_RESPONSE';
  failureSummary?: string;
  createdAt: number;
}

export type DisagreementKind =
  | 'HYPOTHESIS_POSITION_CONFLICT'
  | 'CLAIM_POSITION_CONFLICT'
  | 'ACTION_RECOMMENDATION_CONFLICT'
  | 'SAFETY_CONCERN';

/** A retained, auditable disagreement. It is never silently erased by synthesis. */
export interface MultiAgentDisagreement {
  id: string;
  tenantId: string;
  deliberationId: string;
  reviewIds: string[];
  kind: DisagreementKind;
  subjectSummary: string;
  positionSummaries: string[];
  evidenceIds: string[];
  status: 'OPEN';
  createdAt: number;
}

export type EvidenceQuality = 'NONE' | 'INSUFFICIENT' | 'MIXED' | 'SUFFICIENT';

/** Deterministic review of supplied evidence metadata; it does not collect evidence. */
export interface DeliberationEvidenceCheck {
  id: string;
  tenantId: string;
  deliberationId: string;
  evidenceIds: string[];
  independentSourceCount: number;
  strongEvidenceIds: string[];
  weakEvidenceIds: string[];
  uncertainEvidenceIds: string[];
  staleEvidenceIds: string[];
  conflictingEvidenceIds: string[];
  quality: EvidenceQuality;
  sufficientForDecisionSupport: boolean;
  issues: string[];
  createdAt: number;
}

export type ConsistencyReviewStatus = 'CONSISTENT' | 'CONFLICTING' | 'INSUFFICIENT_REVIEW';

/** Deterministic structural consistency review; not a factual or safety certification. */
export interface DeliberationConsistencyReview {
  id: string;
  tenantId: string;
  deliberationId: string;
  completedReviewIds: string[];
  completedRoles: ReviewerRole[];
  missingRoles: ReviewerRole[];
  disagreementIds: string[];
  status: ConsistencyReviewStatus;
  issues: string[];
  createdAt: number;
}

export type SafetyReviewStatus = 'NOT_REVIEWED' | 'NO_CONCERN_RECORDED' | 'ESCALATION_RECOMMENDED';

/**
 * Safety review is an advisory record. "NO_CONCERN_RECORDED" is explicitly not
 * a safety approval, operational authorization, or physical-world clearance.
 */
export interface DeliberationSafetyReview {
  id: string;
  tenantId: string;
  deliberationId: string;
  reviewIds: string[];
  safetyReviewerRoles: ReviewerRole[];
  concernCount: number;
  status: SafetyReviewStatus;
  recommendation: 'CONTINUE_REVIEW' | 'REQUEST_HUMAN_SAFETY_REVIEW' | 'NO_ACTION';
  doesNotAuthorizeAction: true;
  createdAt: number;
}

export type SynthesisStatus =
  | 'SAFETY_ESCALATION'
  | 'INSUFFICIENT_EVIDENCE'
  | 'REPRODUCIBILITY_REQUIRED'
  | 'DISAGREEMENT_UNRESOLVED'
  | 'HYPOTHESIS_CONDITIONALLY_SUPPORTED'
  | 'HYPOTHESIS_CHALLENGED'
  | 'INCONCLUSIVE';

export type DeliberationRecommendation =
  | 'NO_ACTION'
  | 'GATHER_EVIDENCE'
  | 'REQUEST_HUMAN_REVIEW'
  | 'REQUEST_REPRODUCTION'
  | 'ESCALATE_SAFETY'
  | 'CONSIDER_SEPARATE_GOVERNED_AUTHORIZATION';

/**
 * An auditable synthesis of review records. Its execution field is permanently
 * NOT_AUTHORIZED so another governed system must assess any real action.
 */
export interface DeliberationSynthesis {
  id: string;
  tenantId: string;
  deliberationId: string;
  evidenceCheckId: string;
  consistencyReviewId: string;
  safetyReviewId: string;
  reviewIds: string[];
  unresolvedDisagreementIds: string[];
  status: SynthesisStatus;
  hypothesisStatus: 'RETAINED_AS_HYPOTHESIS';
  conclusionSummary: string;
  uncertaintySummary: string;
  recommendation: DeliberationRecommendation;
  executionAuthorization: 'NOT_AUTHORIZED';
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface RequestedReviewRun {
  reviews: DeliberationReview[];
  unavailableRoles: ReviewerRole[];
}

export const MultiAgentCognitionEvents = Object.freeze({
  DeliberationCreated: 'jqb.multi_agent.deliberation.created',
  ReviewRecorded: 'jqb.multi_agent.review.recorded',
  ReviewFailed: 'jqb.multi_agent.review.failed',
  DisagreementDetected: 'jqb.multi_agent.disagreement.detected',
  EvidenceChecked: 'jqb.multi_agent.evidence.checked',
  ConsistencyReviewed: 'jqb.multi_agent.consistency.reviewed',
  SafetyReviewed: 'jqb.multi_agent.safety.reviewed',
  Synthesized: 'jqb.multi_agent.synthesized',
} as const);

export type { CommercialActor };
