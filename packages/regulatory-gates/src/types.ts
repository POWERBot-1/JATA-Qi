import type {
  CommercialActor,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import type {
  ResearchAssessmentStatus,
  ResearchDomain,
  ResearchSafetyClassification,
} from '@jataqi/research-evidence';
import type { HumanApprovalRequestStatus, HumanReviewType } from '@jataqi/human-approval';

/**
 * Configured requirement categories. These are generic governance categories,
 * not a jurisdiction-specific legal ruleset or a regulatory approval claim.
 */
export type RegulatoryRequirementKind =
  | 'RESEARCH_ASSESSMENT'
  | 'INDEPENDENT_EVIDENCE'
  | 'REPRODUCIBILITY'
  | 'HUMAN_APPROVAL'
  | 'DOCUMENTATION_REFERENCE'
  | 'EXTERNAL_REGULATORY_CONFIRMATION';

export interface RegulatoryGateRequirement {
  id: string;
  kind: RegulatoryRequirementKind;
  label: string;
  rationaleSummary: string;
  acceptedAssessmentStatuses?: ResearchAssessmentStatus[];
  minimumIndependentStrongSources?: number;
  requiredHumanReviewTypes?: HumanReviewType[];
  minimumApprovedRequests?: number;
}

export type RegulatoryGateLifecycleStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

/**
 * A tenant-configured gate template. It is deliberately generic: configuring a
 * jurisdiction label does not make JATA Qi an authoritative legal source.
 */
export interface RegulatoryGate {
  id: string;
  tenantId: string;
  name: string;
  jurisdictionLabel: string;
  regulatoryContextSummary: string;
  domainScopes: Array<ResearchDomain | 'ALL'>;
  safetyClassifications: ResearchSafetyClassification[];
  requirements: RegulatoryGateRequirement[];
  privacyClassification: PrivacyClassification;
  status: RegulatoryGateLifecycleStatus;
  createdByActorId: string;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRegulatoryGateInput {
  name: string;
  jurisdictionLabel: string;
  regulatoryContextSummary: string;
  domainScopes: Array<ResearchDomain | 'ALL'>;
  safetyClassifications: ResearchSafetyClassification[];
  requirements: RegulatoryGateRequirement[];
  privacyClassification?: PrivacyClassification;
  provenance: CommercialProvenance;
}

export type RegulatoryRequirementState = 'SATISFIED' | 'BLOCKED' | 'PENDING_HUMAN_REVIEW' | 'PENDING_EXTERNAL_VERIFICATION';

export interface RegulatoryRequirementCheck {
  requirementId: string;
  kind: RegulatoryRequirementKind;
  state: RegulatoryRequirementState;
  summary: string;
  references: string[];
}

export type RegulatoryGateEvaluationStatus = 'SATISFIED_FOR_REVIEW' | 'BLOCKED' | 'PENDING_HUMAN_REVIEW' | 'PENDING_EXTERNAL_VERIFICATION';

/**
 * A local deterministic gate evaluation. `SATISFIED_FOR_REVIEW` only means the
 * configured local metadata requirements were met; it is not legal compliance,
 * regulatory clearance, certification, or authorization to execute physically.
 */
export interface RegulatoryGateEvaluation {
  id: string;
  tenantId: string;
  gateId: string;
  claimId: string;
  assessmentId?: string;
  approvalRequestIds: string[];
  documentationReferences: string[];
  checks: RegulatoryRequirementCheck[];
  status: RegulatoryGateEvaluationStatus;
  localRequirementsSatisfied: boolean;
  externalRegulatoryVerificationPending: boolean;
  approvedHumanReviewCount: number;
  approvedHumanReviewTypes: HumanReviewType[];
  approvalRequestStatuses: Record<string, HumanApprovalRequestStatus>;
  isComplianceCertification: false;
  physicalExecutionAuthorization: 'NOT_AUTHORIZED';
  provenance: CommercialProvenance;
  sequence: number;
  previousHash: string;
  hash: string;
  createdAt: number;
}

export interface EvaluateRegulatoryGateInput {
  gateId: string;
  claimId: string;
  /** Optional exact evidence assessment; defaults to the latest claim assessment. */
  assessmentId?: string;
  approvalRequestIds?: string[];
  documentationReferences?: string[];
  provenance: CommercialProvenance;
}

export interface RegulatoryGateIntegrityResult {
  tenantId: string;
  valid: boolean;
  evaluationCount: number;
  failure?: string;
}

export const RegulatoryGateEvents = Object.freeze({
  GateCreated: 'research.regulatory_gate.created',
  GateActivated: 'research.regulatory_gate.activated',
  GateRetired: 'research.regulatory_gate.retired',
  Evaluated: 'research.regulatory_gate.evaluated',
} as const);

export type { CommercialActor };
