import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { ResearchEvidenceModule } from '@jataqi/research-evidence';
import type {
  ResearchClaim,
  ResearchClaimAssessment,
  ResearchEvidenceService,
  ResearchAssessmentStatus,
  ResearchDomain,
  ResearchSafetyClassification,
} from '@jataqi/research-evidence';
import { HumanApprovalModule } from '@jataqi/human-approval';
import type { HumanApprovalProgress, HumanApprovalRequest, HumanApprovalService, HumanReviewType } from '@jataqi/human-approval';
import type { CommercialActor, CommercialProvenance, PrivacyClassification } from '@jataqi/commercial-control-plane';
import {
  RegulatoryGateEvents,
  type CreateRegulatoryGateInput,
  type EvaluateRegulatoryGateInput,
  type RegulatoryGate,
  type RegulatoryGateEvaluation,
  type RegulatoryGateEvaluationStatus,
  type RegulatoryGateIntegrityResult,
  type RegulatoryGateLifecycleStatus,
  type RegulatoryGateRequirement,
  type RegulatoryRequirementCheck,
  type RegulatoryRequirementKind,
  type RegulatoryRequirementState,
} from './types.js';

const GATES_COLLECTION = 'regulatory-gates.gates';
const EVALUATIONS_COLLECTION = 'regulatory-gates.evaluations';
const MAX_REQUIREMENTS = 20;
const MAX_TEXT_LIST = 20;
const MAX_APPROVAL_REQUESTS = 20;
const MAX_REQUIRED_APPROVAL_REQUESTS = 5;
const DOMAINS = new Set<ResearchDomain | 'ALL'>(['ALL', 'GENERAL', 'SOFTWARE', 'MATERIALS', 'LIFE_SCIENCES', 'MEDICAL', 'AEROSPACE', 'NUCLEAR', 'SEMICONDUCTOR']);
const SAFETY_CLASSIFICATIONS = new Set<ResearchSafetyClassification>(['STANDARD', 'SENSITIVE', 'REGULATED_OR_HAZARDOUS']);
const REQUIREMENT_KINDS = new Set<RegulatoryRequirementKind>(['RESEARCH_ASSESSMENT', 'INDEPENDENT_EVIDENCE', 'REPRODUCIBILITY', 'HUMAN_APPROVAL', 'DOCUMENTATION_REFERENCE', 'EXTERNAL_REGULATORY_CONFIRMATION']);
const REVIEW_TYPES = new Set<HumanReviewType>(['SCIENTIFIC', 'DOMAIN', 'SAFETY', 'ETHICS', 'REGULATORY', 'REPRODUCIBILITY']);
const ASSESSMENT_STATUSES = new Set<ResearchAssessmentStatus>(['INSUFFICIENT_EVIDENCE', 'CONFLICTING_EVIDENCE', 'REPRODUCIBILITY_REQUIRED', 'CONDITIONALLY_SUPPORTED']);
const PRIVACY_CLASSIFICATIONS = new Set<PrivacyClassification>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PERSONAL_DATA']);

export class RegulatoryGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegulatoryGateError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Local, tenant-scoped regulatory-gate registry. It evaluates only explicitly
 * configured metadata requirements against already stored evidence/approval
 * records. It neither supplies legal advice nor communicates with authorities,
 * alters external compliance state, or authorizes a physical action.
 */
export class RegulatoryGateService {
  private api!: KernelApi;
  private research!: ResearchEvidenceService;
  private approvals!: HumanApprovalService;
  private gates!: ICollection<RegulatoryGate>;
  private evaluations!: ICollection<RegulatoryGateEvaluation>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.gates = await storage.collection<RegulatoryGate>(GATES_COLLECTION);
    this.evaluations = await storage.collection<RegulatoryGateEvaluation>(EVALUATIONS_COLLECTION);
    this.research = kernel.getModule<ResearchEvidenceModule>('research-evidence').getService();
    this.approvals = kernel.getModule<HumanApprovalModule>('human-approval').getService();
  }

  /** Create a draft local gate. Activation is explicit and administrator-only. */
  async createGate(actor: CommercialActor, input: CreateRegulatoryGateInput): Promise<RegulatoryGate> {
    assertAdministrator(actor);
    validateGateInput(input);
    const now = Date.now();
    const gate: RegulatoryGate = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      name: requiredText(input.name, 'Regulatory gate name', 180),
      jurisdictionLabel: requiredText(input.jurisdictionLabel, 'Jurisdiction label', 180),
      regulatoryContextSummary: requiredText(input.regulatoryContextSummary, 'Regulatory context summary', 800),
      domainScopes: domainScopes(input.domainScopes),
      safetyClassifications: safetyClassifications(input.safetyClassifications),
      requirements: sanitizeRequirements(input.requirements),
      privacyClassification: privacyClassification(input.privacyClassification),
      status: 'DRAFT',
      createdByActorId: actor.id,
      provenance: sanitizeProvenance(input.provenance),
      createdAt: now,
      updatedAt: now,
    };
    await this.gates.put(gate);
    await this.api.bus.emit(RegulatoryGateEvents.GateCreated, {
      gateId: gate.id,
      tenantId: gate.tenantId,
      status: gate.status,
      requirementCount: gate.requirements.length,
      isComplianceCertification: false,
    });
    return copy(gate);
  }

  /** Activate a draft local template; this is not an external regulatory operation. */
  async activateGate(actor: CommercialActor, gateId: string): Promise<RegulatoryGate> {
    assertAdministrator(actor);
    const gate = await this.requireGateForActor(actor, gateId);
    if (gate.status !== 'DRAFT') throw new RegulatoryGateError(`Regulatory gate is ${gate.status} and cannot be activated.`);
    const updated: RegulatoryGate = { ...gate, status: 'ACTIVE', updatedAt: Date.now() };
    await this.gates.put(updated);
    await this.api.bus.emit(RegulatoryGateEvents.GateActivated, {
      gateId: updated.id,
      tenantId: updated.tenantId,
      status: updated.status,
      isComplianceCertification: false,
    });
    return copy(updated);
  }

  /** Retire a local template; historical evaluations remain retained. */
  async retireGate(actor: CommercialActor, gateId: string): Promise<RegulatoryGate> {
    assertAdministrator(actor);
    const gate = await this.requireGateForActor(actor, gateId);
    if (gate.status === 'RETIRED') return copy(gate);
    const updated: RegulatoryGate = { ...gate, status: 'RETIRED', updatedAt: Date.now() };
    await this.gates.put(updated);
    await this.api.bus.emit(RegulatoryGateEvents.GateRetired, {
      gateId: updated.id,
      tenantId: updated.tenantId,
      status: updated.status,
      isComplianceCertification: false,
    });
    return copy(updated);
  }

  /**
   * Evaluate an active local gate against records that already exist in this
   * tenant. An external-regulatory-confirmation requirement always remains
   * pending external verification here because no authority connector exists.
   */
  async evaluate(actor: CommercialActor, input: EvaluateRegulatoryGateInput): Promise<RegulatoryGateEvaluation> {
    assertActor(actor);
    validateEvaluationInput(input);
    const gate = await this.requireGateForActor(actor, input.gateId);
    if (gate.status !== 'ACTIVE') throw new RegulatoryGateError(`Regulatory gate is ${gate.status}; only an ACTIVE gate can be evaluated.`);
    const claim = await this.requireClaimForActor(actor, input.claimId);
    if (!gate.domainScopes.includes('ALL') && !gate.domainScopes.includes(claim.domain)) throw new RegulatoryGateError('Regulatory gate does not apply to this research domain.');
    if (!gate.safetyClassifications.includes(claim.safetyClassification)) throw new RegulatoryGateError('Regulatory gate does not apply to this research safety classification.');

    const assessments = await this.research.listAssessments(actor, claim.id);
    const assessment = input.assessmentId
      ? assessments.find((candidate) => candidate.id === input.assessmentId)
      : assessments[assessments.length - 1];
    if (input.assessmentId && !assessment) throw new RegulatoryGateError('Requested research assessment is not available for this claim.');
    const approvalRequestIds = textList(input.approvalRequestIds ?? [], 'Human approval request ids', MAX_APPROVAL_REQUESTS, 120);
    const approvalData = await this.approvalData(actor, claim, approvalRequestIds);
    const documentationReferences = textList(input.documentationReferences ?? [], 'Documentation references', MAX_TEXT_LIST, 240);
    const checks = gate.requirements.map((requirement) => this.evaluateRequirement(requirement, assessment, approvalData, documentationReferences));
    const status = evaluationStatus(checks);
    const localRequirementsSatisfied = checks.filter((check) => check.kind !== 'EXTERNAL_REGULATORY_CONFIRMATION').every((check) => check.state === 'SATISFIED');
    const externalRegulatoryVerificationPending = checks.some((check) => check.state === 'PENDING_EXTERNAL_VERIFICATION');
    const evaluation = await this.appendEvaluation({
      tenantId: gate.tenantId,
      gateId: gate.id,
      claimId: claim.id,
      assessmentId: assessment?.id,
      approvalRequestIds,
      documentationReferences,
      checks,
      status,
      localRequirementsSatisfied,
      externalRegulatoryVerificationPending,
      approvedHumanReviewCount: approvalData.approvedRequests.length,
      approvedHumanReviewTypes: approvalData.approvedReviewTypes,
      approvalRequestStatuses: approvalData.statuses,
      isComplianceCertification: false,
      physicalExecutionAuthorization: 'NOT_AUTHORIZED',
      provenance: sanitizeProvenance(input.provenance),
    });
    await this.api.bus.emit(RegulatoryGateEvents.Evaluated, {
      gateId: gate.id,
      claimId: claim.id,
      evaluationId: evaluation.id,
      status: evaluation.status,
      localRequirementsSatisfied: evaluation.localRequirementsSatisfied,
      externalRegulatoryVerificationPending: evaluation.externalRegulatoryVerificationPending,
      isComplianceCertification: false,
      physicalExecutionAuthorization: evaluation.physicalExecutionAuthorization,
    });
    return copy(evaluation);
  }

  async getGate(actor: CommercialActor, gateId: string): Promise<RegulatoryGate | undefined> {
    const gate = await this.gates.get(gateId);
    return gate && canRead(actor, gate.tenantId) ? copy(gate) : undefined;
  }

  async listGates(actor: CommercialActor): Promise<RegulatoryGate[]> {
    return sorted(await this.gates.query({ where: (gate) => canRead(actor, gate.tenantId) })).map(copy);
  }

  async getEvaluation(actor: CommercialActor, evaluationId: string): Promise<RegulatoryGateEvaluation | undefined> {
    const evaluation = await this.evaluations.get(evaluationId);
    return evaluation && canRead(actor, evaluation.tenantId) ? copy(evaluation) : undefined;
  }

  async listEvaluations(actor: CommercialActor, gateId?: string, claimId?: string): Promise<RegulatoryGateEvaluation[]> {
    if (gateId) await this.requireGateForActor(actor, gateId);
    if (claimId) await this.requireClaimForActor(actor, claimId);
    return sorted(await this.evaluations.query({ where: (evaluation) => canRead(actor, evaluation.tenantId) && (gateId === undefined || evaluation.gateId === gateId) && (claimId === undefined || evaluation.claimId === claimId) })).map(copy);
  }

  /** Verify local evaluation-record integrity only; this is not compliance verification. */
  async verifyIntegrity(actor: CommercialActor, tenantId = actor.tenantId): Promise<RegulatoryGateIntegrityResult> {
    assertActor(actor);
    if (tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new RegulatoryGateError('Only a global administrator can verify another tenant gate ledger.');
    const evaluations = [...await this.evaluations.query({ where: (evaluation) => evaluation.tenantId === tenantId })]
      .sort((first, second) => first.sequence - second.sequence || first.createdAt - second.createdAt || first.id.localeCompare(second.id));
    let previousHash = 'GENESIS';
    for (let index = 0; index < evaluations.length; index += 1) {
      const evaluation = evaluations[index]!;
      if (evaluation.sequence !== index + 1) return { tenantId, valid: false, evaluationCount: evaluations.length, failure: `Unexpected sequence at evaluation ${evaluation.id}.` };
      if (evaluation.previousHash !== previousHash) return { tenantId, valid: false, evaluationCount: evaluations.length, failure: `Previous hash mismatch at evaluation ${evaluation.id}.` };
      if (evaluation.hash !== hashEvaluation({ ...evaluation, hash: '' })) return { tenantId, valid: false, evaluationCount: evaluations.length, failure: `Hash mismatch at evaluation ${evaluation.id}.` };
      previousHash = evaluation.hash;
    }
    return { tenantId, valid: true, evaluationCount: evaluations.length };
  }

  private async approvalData(actor: CommercialActor, claim: ResearchClaim, requestIds: readonly string[]): Promise<ApprovalData> {
    const approvedRequests: HumanApprovalRequest[] = [];
    const approvedReviewTypes: HumanReviewType[] = [];
    const statuses: Record<string, HumanApprovalRequest['status']> = {};
    for (const requestId of requestIds) {
      const progress = await this.approvals.getProgress(actor, requestId);
      const request = progress.request;
      if (request.tenantId !== claim.tenantId || request.claimId !== claim.id) throw new RegulatoryGateError(`Human approval request ${requestId} is not linked to this research claim.`);
      statuses[request.id] = request.status;
      if (request.status === 'APPROVED' && progress.quorumSatisfied) {
        approvedRequests.push(request);
        approvedReviewTypes.push(...progress.coveredReviewTypes);
      }
    }
    return { approvedRequests, approvedReviewTypes: uniqueReviewTypes(approvedReviewTypes), statuses };
  }

  private evaluateRequirement(
    requirement: RegulatoryGateRequirement,
    assessment: ResearchClaimAssessment | undefined,
    approvalData: ApprovalData,
    documentationReferences: readonly string[],
  ): RegulatoryRequirementCheck {
    switch (requirement.kind) {
      case 'RESEARCH_ASSESSMENT': {
        const accepted = requirement.acceptedAssessmentStatuses ?? ['CONDITIONALLY_SUPPORTED'];
        const met = assessment !== undefined && accepted.includes(assessment.status);
        return {
          requirementId: requirement.id,
          kind: requirement.kind,
          state: met ? 'SATISFIED' : 'BLOCKED',
          summary: met ? `Research assessment ${assessment!.id} has an accepted local status.` : 'No selected research assessment has an accepted configured status.',
          references: assessment ? [assessment.id] : [],
        };
      }
      case 'INDEPENDENT_EVIDENCE': {
        const minimumSources = requirement.minimumIndependentStrongSources ?? 2;
        const met = assessment !== undefined && assessment.independentStrongSourceCount >= minimumSources;
        return {
          requirementId: requirement.id,
          kind: requirement.kind,
          state: met ? 'SATISFIED' : 'BLOCKED',
          summary: met ? `Selected assessment records at least ${minimumSources} independent strong evidence source(s).` : `Selected assessment does not record the configured ${minimumSources} independent strong evidence source(s).`,
          references: assessment ? assessment.evidenceRecordIds : [],
        };
      }
      case 'REPRODUCIBILITY': {
        const met = assessment !== undefined && assessment.status === 'CONDITIONALLY_SUPPORTED' && assessment.reproducibilityRecordIds.length > 0 && !assessment.simulationOnly;
        return {
          requirementId: requirement.id,
          kind: requirement.kind,
          state: met ? 'SATISFIED' : 'BLOCKED',
          summary: met ? 'Selected assessment includes non-simulation evidence with linked reproducibility records.' : 'Selected assessment does not meet the local reproducibility requirement.',
          references: assessment?.reproducibilityRecordIds ?? [],
        };
      }
      case 'HUMAN_APPROVAL': {
        const requiredCount = requirement.minimumApprovedRequests ?? 1;
        const requiredTypes = requirement.requiredHumanReviewTypes ?? [];
        const missingTypes = requiredTypes.filter((type) => !approvalData.approvedReviewTypes.includes(type));
        const met = approvalData.approvedRequests.length >= requiredCount && missingTypes.length === 0;
        return {
          requirementId: requirement.id,
          kind: requirement.kind,
          state: met ? 'SATISFIED' : 'PENDING_HUMAN_REVIEW',
          summary: met ? 'Configured approved human-review quorum and review-type coverage are present.' : `Human review remains pending: ${approvalData.approvedRequests.length}/${requiredCount} approved request(s); missing types: ${missingTypes.join(', ') || 'none'}.`,
          references: approvalData.approvedRequests.map((request) => request.id),
        };
      }
      case 'DOCUMENTATION_REFERENCE': {
        const met = documentationReferences.length > 0;
        return {
          requirementId: requirement.id,
          kind: requirement.kind,
          state: met ? 'SATISFIED' : 'BLOCKED',
          summary: met ? 'At least one supplied documentation reference is present.' : 'No documentation reference was supplied for this configured local requirement.',
          references: [...documentationReferences],
        };
      }
      case 'EXTERNAL_REGULATORY_CONFIRMATION':
        return {
          requirementId: requirement.id,
          kind: requirement.kind,
          state: 'PENDING_EXTERNAL_VERIFICATION',
          summary: 'External regulatory confirmation is not verified by this local registry; no authority connector or clearance claim exists.',
          references: [],
        };
    }
  }

  private async requireGateForActor(actor: CommercialActor, gateId: string): Promise<RegulatoryGate> {
    const gate = await this.getGate(actor, gateId);
    if (!gate || gate.tenantId !== actor.tenantId) throw new RegulatoryGateError('Regulatory gate not found for this tenant.');
    return gate;
  }

  private async requireClaimForActor(actor: CommercialActor, claimId: string): Promise<ResearchClaim> {
    const claim = await this.research.getClaim(actor, claimId);
    if (!claim || claim.tenantId !== actor.tenantId) throw new RegulatoryGateError('Research claim not found for this tenant.');
    return claim;
  }

  private async appendEvaluation(input: Omit<RegulatoryGateEvaluation, 'id' | 'sequence' | 'previousHash' | 'hash' | 'createdAt'>): Promise<RegulatoryGateEvaluation> {
    const previous = (await this.evaluations.query({ where: (evaluation) => evaluation.tenantId === input.tenantId, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
    const draft: Omit<RegulatoryGateEvaluation, 'hash'> = {
      id: randomUUID(),
      ...copy(input),
      sequence: (previous?.sequence ?? 0) + 1,
      previousHash: previous?.hash ?? 'GENESIS',
      createdAt: Date.now(),
    };
    const evaluation: RegulatoryGateEvaluation = { ...draft, hash: hashEvaluation({ ...draft, hash: '' }) };
    await this.evaluations.put(evaluation);
    return evaluation;
  }
}

interface ApprovalData {
  approvedRequests: HumanApprovalRequest[];
  approvedReviewTypes: HumanReviewType[];
  statuses: Record<string, HumanApprovalRequest['status']>;
}

function evaluationStatus(checks: readonly RegulatoryRequirementCheck[]): RegulatoryGateEvaluationStatus {
  if (checks.some((check) => check.state === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((check) => check.state === 'PENDING_EXTERNAL_VERIFICATION')) return 'PENDING_EXTERNAL_VERIFICATION';
  if (checks.some((check) => check.state === 'PENDING_HUMAN_REVIEW')) return 'PENDING_HUMAN_REVIEW';
  return 'SATISFIED_FOR_REVIEW';
}

function validateGateInput(input: CreateRegulatoryGateInput): void {
  if (!input || typeof input !== 'object') throw new RegulatoryGateError('Regulatory gate input is required.');
  requiredText(input.name, 'Regulatory gate name', 180);
  requiredText(input.jurisdictionLabel, 'Jurisdiction label', 180);
  requiredText(input.regulatoryContextSummary, 'Regulatory context summary', 800);
  domainScopes(input.domainScopes);
  safetyClassifications(input.safetyClassifications);
  sanitizeRequirements(input.requirements);
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function validateEvaluationInput(input: EvaluateRegulatoryGateInput): void {
  if (!input || typeof input !== 'object') throw new RegulatoryGateError('Regulatory gate evaluation input is required.');
  requiredText(input.gateId, 'Regulatory gate id', 120);
  requiredText(input.claimId, 'Research claim id', 120);
  if (input.assessmentId !== undefined) requiredText(input.assessmentId, 'Research assessment id', 120);
  textList(input.approvalRequestIds ?? [], 'Human approval request ids', MAX_APPROVAL_REQUESTS, 120);
  textList(input.documentationReferences ?? [], 'Documentation references', MAX_TEXT_LIST, 240);
  sanitizeProvenance(input.provenance);
}

function sanitizeRequirements(value: unknown): RegulatoryGateRequirement[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REQUIREMENTS) throw new RegulatoryGateError(`Regulatory gate requires one to ${MAX_REQUIREMENTS} requirement(s).`);
  const ids = new Set<string>();
  return value.map((item) => {
    const requirement = record(item, 'Regulatory gate requirement');
    const id = requiredText(requirement.id, 'Regulatory requirement id', 120);
    if (ids.has(id)) throw new RegulatoryGateError(`Duplicate regulatory requirement id ${id}.`);
    ids.add(id);
    const kind = requirement.kind;
    if (typeof kind !== 'string' || !REQUIREMENT_KINDS.has(kind as RegulatoryRequirementKind)) throw new RegulatoryGateError('Regulatory requirement kind is invalid.');
    const sanitized: RegulatoryGateRequirement = {
      id,
      kind: kind as RegulatoryRequirementKind,
      label: requiredText(requirement.label, 'Regulatory requirement label', 240),
      rationaleSummary: requiredText(requirement.rationaleSummary, 'Regulatory requirement rationale summary', 640),
    };
    if (requirement.acceptedAssessmentStatuses !== undefined) sanitized.acceptedAssessmentStatuses = assessmentStatuses(requirement.acceptedAssessmentStatuses);
    if (requirement.minimumIndependentStrongSources !== undefined) sanitized.minimumIndependentStrongSources = positiveInteger(requirement.minimumIndependentStrongSources, 'Minimum independent strong sources', 10);
    if (requirement.requiredHumanReviewTypes !== undefined) sanitized.requiredHumanReviewTypes = humanReviewTypes(requirement.requiredHumanReviewTypes);
    if (requirement.minimumApprovedRequests !== undefined) sanitized.minimumApprovedRequests = positiveInteger(requirement.minimumApprovedRequests, 'Minimum approved requests', MAX_REQUIRED_APPROVAL_REQUESTS);
    validateRequirementConfiguration(sanitized);
    return sanitized;
  });
}

function validateRequirementConfiguration(requirement: RegulatoryGateRequirement): void {
  if (requirement.kind === 'RESEARCH_ASSESSMENT' && !(requirement.acceptedAssessmentStatuses?.length)) {
    throw new RegulatoryGateError('A RESEARCH_ASSESSMENT requirement needs accepted assessment statuses.');
  }
  if (requirement.kind === 'INDEPENDENT_EVIDENCE' && requirement.minimumIndependentStrongSources === undefined) {
    throw new RegulatoryGateError('An INDEPENDENT_EVIDENCE requirement needs a minimum independent strong-source count.');
  }
  if (requirement.kind === 'HUMAN_APPROVAL' && (!(requirement.requiredHumanReviewTypes?.length) || requirement.minimumApprovedRequests === undefined)) {
    throw new RegulatoryGateError('A HUMAN_APPROVAL requirement needs review-type coverage and minimum approved-request count.');
  }
}

function domainScopes(value: unknown): Array<ResearchDomain | 'ALL'> {
  if (!Array.isArray(value) || value.length === 0 || value.length > DOMAINS.size) throw new RegulatoryGateError(`Gate domain scopes must contain one to ${DOMAINS.size} values.`);
  const scopes = value.map((scope) => {
    if (typeof scope !== 'string' || !DOMAINS.has(scope as ResearchDomain | 'ALL')) throw new RegulatoryGateError('Gate domain scope is invalid.');
    return scope as ResearchDomain | 'ALL';
  });
  if (new Set(scopes).size !== scopes.length) throw new RegulatoryGateError('Gate domain scopes must be distinct.');
  return scopes;
}

function safetyClassifications(value: unknown): ResearchSafetyClassification[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SAFETY_CLASSIFICATIONS.size) throw new RegulatoryGateError(`Gate safety classifications must contain one to ${SAFETY_CLASSIFICATIONS.size} values.`);
  const classifications = value.map((classification) => {
    if (typeof classification !== 'string' || !SAFETY_CLASSIFICATIONS.has(classification as ResearchSafetyClassification)) throw new RegulatoryGateError('Gate safety classification is invalid.');
    return classification as ResearchSafetyClassification;
  });
  if (new Set(classifications).size !== classifications.length) throw new RegulatoryGateError('Gate safety classifications must be distinct.');
  return classifications;
}

function assessmentStatuses(value: unknown): ResearchAssessmentStatus[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ASSESSMENT_STATUSES.size) throw new RegulatoryGateError('Accepted assessment statuses must be a non-empty valid list.');
  const statuses = value.map((status) => {
    if (typeof status !== 'string' || !ASSESSMENT_STATUSES.has(status as ResearchAssessmentStatus)) throw new RegulatoryGateError('Accepted assessment status is invalid.');
    return status as ResearchAssessmentStatus;
  });
  if (new Set(statuses).size !== statuses.length) throw new RegulatoryGateError('Accepted assessment statuses must be distinct.');
  return statuses;
}

function humanReviewTypes(value: unknown): HumanReviewType[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > REVIEW_TYPES.size) throw new RegulatoryGateError('Required human review types must be a non-empty valid list.');
  const types = value.map((type) => {
    if (typeof type !== 'string' || !REVIEW_TYPES.has(type as HumanReviewType)) throw new RegulatoryGateError('Required human review type is invalid.');
    return type as HumanReviewType;
  });
  if (new Set(types).size !== types.length) throw new RegulatoryGateError('Required human review types must be distinct.');
  return types;
}

function uniqueReviewTypes(types: readonly HumanReviewType[]): HumanReviewType[] {
  return [...new Set(types)].sort();
}

function positiveInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new RegulatoryGateError(`${name} must be an integer from 1 to ${maximum}.`);
  return value as number;
}

function sanitizeProvenance(value: unknown): CommercialProvenance {
  const provenance = record(value, 'Provenance');
  return {
    source: requiredText(provenance.source, 'Provenance source', 180),
    collectedAt: finite(provenance.collectedAt, 'Provenance collection time'),
    correlationId: optionalText(provenance.correlationId, 'Provenance correlation id', 180),
    causationId: optionalText(provenance.causationId, 'Provenance causation id', 180),
    sourceReference: optionalText(provenance.sourceReference, 'Provenance source reference', 320),
    contentHash: optionalText(provenance.contentHash, 'Provenance content hash', 180),
  };
}

function privacyClassification(value: unknown): PrivacyClassification {
  if (value === undefined) return 'INTERNAL';
  if (typeof value !== 'string' || !PRIVACY_CLASSIFICATIONS.has(value as PrivacyClassification)) throw new RegulatoryGateError('Privacy classification is invalid.');
  return value as PrivacyClassification;
}

function textList(value: unknown, name: string, maximumItems = MAX_TEXT_LIST, maximumLength = 320): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new RegulatoryGateError(`${name} must be an array with at most ${maximumItems} item(s).`);
  const values = value.map((item) => requiredText(item, name, maximumLength));
  if (new Set(values).size !== values.length) throw new RegulatoryGateError(`${name} must not contain duplicates.`);
  return values;
}

function requiredText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new RegulatoryGateError(`${name} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) throw new RegulatoryGateError(`${name} is required.`);
  return bounded(clean, maximumLength);
}

function optionalText(value: unknown, name: string, maximumLength: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, maximumLength);
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RegulatoryGateError(`${name} must be finite.`);
  return value;
}

function assertActor(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new RegulatoryGateError('A tenant-bound regulatory-gate actor is required.');
}

function assertAdministrator(actor: CommercialActor): void {
  assertActor(actor);
  if (!actor.roles.some((role) => role === 'admin' || role === 'global_admin' || role === 'system')) throw new RegulatoryGateError('An administrator role is required to manage regulatory gates.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function sorted<T extends { id: string; createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
}

function hashEvaluation(evaluation: RegulatoryGateEvaluation): string {
  return createHash('sha256').update(stable(evaluation)).digest('hex');
}

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RegulatoryGateError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
