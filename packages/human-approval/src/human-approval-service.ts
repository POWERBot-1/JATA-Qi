import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { ResearchEvidenceModule } from '@jataqi/research-evidence';
import type { ResearchEvidenceService, ResearchClaim } from '@jataqi/research-evidence';
import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import {
  HumanApprovalEvents,
  type AttestationDomainScope,
  type CreateHumanApprovalRequestInput,
  type HumanApprovalIntegrityResult,
  type HumanApprovalProgress,
  type HumanApprovalRequest,
  type HumanApprovalRequestStatus,
  type HumanApprovalVote,
  type HumanApprovalVoteDecision,
  type HumanReviewType,
  type HumanReviewerAttestation,
  type RegisterHumanReviewerInput,
  type ReviewerVerificationStatus,
  type SubmitHumanApprovalVoteInput,
} from './types.js';

const ATTESTATIONS_COLLECTION = 'human-approval.reviewer-attestations';
const REQUESTS_COLLECTION = 'human-approval.requests';
const VOTES_COLLECTION = 'human-approval.votes';
const MAX_APPROVALS = 5;
const MAX_EVIDENCE = 100;
const MAX_TEXT_LIST = 20;
const REVIEW_TYPES = new Set<HumanReviewType>(['SCIENTIFIC', 'DOMAIN', 'SAFETY', 'ETHICS', 'REGULATORY', 'REPRODUCIBILITY']);
const DOMAINS = new Set<AttestationDomainScope>(['ALL', 'GENERAL', 'SOFTWARE', 'MATERIALS', 'LIFE_SCIENCES', 'MEDICAL', 'AEROSPACE', 'NUCLEAR', 'SEMICONDUCTOR']);
const REVIEWER_VERIFICATION_STATUSES = new Set<ReviewerVerificationStatus>(['DECLARED', 'ORGANIZATION_ASSERTED', 'REVOKED', 'EXPIRED']);
const VOTE_DECISIONS = new Set<HumanApprovalVoteDecision>(['APPROVE', 'REJECT']);
const EVIDENCE_STATUSES = new Set<CommercialEvidence['status']>([
  'UNVERIFIED', 'PARTIAL', 'OBSERVED', 'MEASURED', 'CUSTOMER_CONFIRMED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED',
  'ESTIMATED', 'ASSUMPTION', 'PREDICTION', 'STALE', 'CONFLICTING', 'UNAVAILABLE',
]);
// Customer confirmation is not sufficient scientific evidence for a regulated
// safety/regulatory approval vote in this research-review boundary.
const REGULATED_STRONG_EVIDENCE = new Set<CommercialEvidence['status']>(['MEASURED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED']);
const PRIVACY_CLASSIFICATIONS = new Set<PrivacyClassification>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PERSONAL_DATA']);
const PRIVACY_RANK: Record<PrivacyClassification, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, PERSONAL_DATA: 4 };

export interface HumanApprovalConfig {
  /** Injectable clock for deterministic expiry handling. */
  now?: () => number;
}

export class HumanApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HumanApprovalError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Research-review quorum and attestation registry. It records human review
 * metadata and compact rationales but does not independently verify identity or
 * qualifications, alter a regulatory system, invoke external services, or
 * authorize a physical experiment/action.
 */
export class HumanApprovalService {
  private api!: KernelApi;
  private research!: ResearchEvidenceService;
  private attestations!: ICollection<HumanReviewerAttestation>;
  private requests!: ICollection<HumanApprovalRequest>;
  private votes!: ICollection<HumanApprovalVote>;
  private readonly now: () => number;

  constructor(config: HumanApprovalConfig = {}) {
    this.now = config.now ?? (() => Date.now());
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.attestations = await storage.collection<HumanReviewerAttestation>(ATTESTATIONS_COLLECTION);
    this.requests = await storage.collection<HumanApprovalRequest>(REQUESTS_COLLECTION);
    this.votes = await storage.collection<HumanApprovalVote>(VOTES_COLLECTION);
    this.research = kernel.getModule<ResearchEvidenceModule>('research-evidence').getService();
  }

  /**
   * Record an upstream reviewer attestation. The status remains an assertion in
   * this registry—no identity, license, competency, or organization check is
   * performed by JATA Qi itself.
   */
  async registerReviewer(actor: CommercialActor, input: RegisterHumanReviewerInput): Promise<HumanReviewerAttestation> {
    assertAdministrator(actor);
    validateAttestationInput(input, this.now());
    const now = this.now();
    const attestation: HumanReviewerAttestation = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      reviewerActorId: requiredText(input.reviewerActorId, 'Reviewer actor id', 180),
      domainScopes: domainScopes(input.domainScopes),
      reviewTypes: reviewTypes(input.reviewTypes),
      competencyIds: textList(input.competencyIds, 'Reviewer competency ids', MAX_TEXT_LIST, 160),
      verificationStatus: input.verificationStatus,
      attestedByActorId: actor.id,
      expiresAt: optionalFutureTime(input.expiresAt, 'Attestation expiry', now),
      provenance: sanitizeProvenance(input.provenance),
      createdAt: now,
      updatedAt: now,
    };
    await this.attestations.put(attestation);
    await this.api.bus.emit(HumanApprovalEvents.ReviewerAttested, {
      attestationId: attestation.id,
      tenantId: attestation.tenantId,
      reviewerActorId: attestation.reviewerActorId,
      verificationStatus: attestation.verificationStatus,
      reviewTypes: attestation.reviewTypes,
    });
    return copy(attestation);
  }

  /** Mark an attestation revoked; historical votes remain retained and auditable. */
  async revokeReviewer(actor: CommercialActor, attestationId: string): Promise<HumanReviewerAttestation> {
    assertAdministrator(actor);
    const attestation = await this.requireAttestation(actor, attestationId);
    if (attestation.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new HumanApprovalError('An administrator cannot revoke an attestation from another tenant.');
    const updated: HumanReviewerAttestation = { ...attestation, verificationStatus: 'REVOKED', updatedAt: this.now() };
    await this.attestations.put(updated);
    await this.api.bus.emit(HumanApprovalEvents.ReviewerRevoked, {
      attestationId: updated.id,
      tenantId: updated.tenantId,
      reviewerActorId: updated.reviewerActorId,
    });
    return copy(updated);
  }

  /** Create a non-executing research-review request linked to an existing research claim. */
  async createRequest(actor: CommercialActor, input: CreateHumanApprovalRequestInput): Promise<HumanApprovalRequest> {
    assertActor(actor);
    validateRequestInput(input, this.now());
    const claim = await this.requireClaimForActor(actor, input.claimId);
    const evidenceRecordIds = textList(input.evidenceRecordIds ?? [], 'Research evidence record ids', MAX_TEXT_LIST, 120);
    const availableEvidenceIds = new Set((await this.research.listEvidence(actor, claim.id)).map((record) => record.id));
    for (const evidenceRecordId of evidenceRecordIds) {
      if (!availableEvidenceIds.has(evidenceRecordId)) throw new HumanApprovalError(`Evidence record ${evidenceRecordId} is not attached to this research claim.`);
    }
    const linkedAssessment = input.assessmentId
      ? (await this.research.listAssessments(actor, claim.id)).find((candidate) => candidate.id === input.assessmentId)
      : undefined;
    if (input.assessmentId && !linkedAssessment) throw new HumanApprovalError('The approval request assessment is not available for this research claim.');
    const requiredReviewTypes = reviewTypes(input.requiredReviewTypes);
    const requiredApprovalCount = approvalCount(input.requiredApprovalCount);
    if (claim.safetyClassification === 'REGULATED_OR_HAZARDOUS') {
      if (!linkedAssessment || !linkedAssessment.regulatedWorkRequiresHumanReview) {
        throw new HumanApprovalError('Regulated/hazardous research approval requires a linked regulated research assessment.');
      }
      if (!requiredReviewTypes.includes('SAFETY') || !requiredReviewTypes.includes('REGULATORY') || requiredApprovalCount < 2) {
        throw new HumanApprovalError('Regulated/hazardous research approval requires SAFETY and REGULATORY review types plus at least two distinct human approvals.');
      }
    }
    const privacy = privacyClassification(input.privacyClassification ?? claim.privacyClassification);
    if (PRIVACY_RANK[privacy] < PRIVACY_RANK[claim.privacyClassification]) throw new HumanApprovalError('An approval request cannot be less restrictive than its research claim.');
    const now = this.now();
    const request: HumanApprovalRequest = {
      id: randomUUID(),
      tenantId: claim.tenantId,
      claimId: claim.id,
      assessmentId: input.assessmentId,
      evidenceRecordIds,
      requestedByActorId: actor.id,
      purposeSummary: requiredText(input.purposeSummary, 'Approval purpose summary', 800),
      requiredReviewTypes,
      requiredCompetencyIds: textList(input.requiredCompetencyIds, 'Required competency ids', MAX_TEXT_LIST, 160),
      requiredApprovalCount,
      safetyClassification: claim.safetyClassification,
      privacyClassification: privacy,
      status: 'PENDING',
      expiresAt: optionalFutureTime(input.expiresAt, 'Approval request expiry', now),
      provenance: sanitizeProvenance(input.provenance),
      createdAt: now,
      updatedAt: now,
    };
    await this.requests.put(request);
    await this.api.bus.emit(HumanApprovalEvents.RequestCreated, {
      requestId: request.id,
      tenantId: request.tenantId,
      claimId: request.claimId,
      requiredReviewTypes: request.requiredReviewTypes,
      requiredApprovalCount: request.requiredApprovalCount,
      safetyClassification: request.safetyClassification,
      doesNotAuthorizePhysicalExecution: true,
    });
    return copy(request);
  }

  /**
   * Record one immutable vote from an active, matching human attestation. A
   * configured quorum merely changes the request record; it never grants an
   * external or physical execution right.
   */
  async submitVote(actor: CommercialActor, requestId: string, input: SubmitHumanApprovalVoteInput): Promise<{ request: HumanApprovalRequest; vote: HumanApprovalVote; progress: HumanApprovalProgress }> {
    assertApprover(actor);
    validateVoteInput(input);
    let request = await this.requireRequest(actor, requestId);
    request = await this.expireIfNeeded(request);
    if (request.status !== 'PENDING') throw new HumanApprovalError(`Approval request is ${request.status} and cannot accept another vote.`);
    if (request.requestedByActorId === actor.id) throw new HumanApprovalError('A requestor cannot vote on their own approval request.');
    const claim = await this.requireClaimForActor(actor, request.claimId);
    if (claim.tenantId !== request.tenantId) throw new HumanApprovalError('Approval request claim tenant mismatch.');
    const attestation = await this.requireAttestation(actor, input.attestationId);
    if (attestation.tenantId !== request.tenantId) throw new HumanApprovalError('Reviewer attestation is not in the request tenant.');
    if (attestation.reviewerActorId !== actor.id) throw new HumanApprovalError('A reviewer may only submit using their own attestation.');
    if (!isActiveAttestation(attestation, this.now())) throw new HumanApprovalError('Reviewer attestation is not active.');
    if (request.safetyClassification === 'REGULATED_OR_HAZARDOUS' && attestation.verificationStatus !== 'ORGANIZATION_ASSERTED') {
      throw new HumanApprovalError('Regulated/hazardous approval requires an ORGANIZATION_ASSERTED reviewer attestation; this registry does not independently verify it.');
    }
    if (!attestation.domainScopes.includes('ALL') && !attestation.domainScopes.includes(claim.domain)) throw new HumanApprovalError('Reviewer attestation does not cover this research domain.');
    const selectedReviewTypes = reviewTypes(input.reviewTypes);
    if (!selectedReviewTypes.every((type) => request.requiredReviewTypes.includes(type))) throw new HumanApprovalError('Vote review types must be required by the approval request.');
    if (!selectedReviewTypes.every((type) => attestation.reviewTypes.includes(type))) throw new HumanApprovalError('Reviewer attestation does not cover all submitted review types.');
    const selectedCompetencies = textList(input.competencyIds, 'Vote competency ids', MAX_TEXT_LIST, 160);
    if (!selectedCompetencies.every((competency) => attestation.competencyIds.includes(competency))) throw new HumanApprovalError('Reviewer attestation does not cover all submitted competency ids.');
    const priorVotes = await this.votesFor(request.id);
    if (priorVotes.some((vote) => vote.reviewerActorId === actor.id || vote.attestationId === attestation.id)) throw new HumanApprovalError('A reviewer may cast only one immutable vote per approval request.');

    const voteEvidence = sanitizeEvidenceList(input.evidence, true);
    if (request.safetyClassification === 'REGULATED_OR_HAZARDOUS' && input.decision === 'APPROVE') {
      assertRegulatedApprovalEvidence(voteEvidence, this.now());
    }
    const vote = await this.appendVote({
      tenantId: request.tenantId,
      requestId: request.id,
      attestationId: attestation.id,
      reviewerActorId: actor.id,
      decision: input.decision,
      reviewTypes: selectedReviewTypes,
      competencyIds: selectedCompetencies,
      rationaleSummary: requiredText(input.rationaleSummary, 'Approval rationale summary', 800),
      evidence: voteEvidence,
      provenance: sanitizeProvenance(input.provenance),
    });
    const votes = [...priorVotes, vote];
    const nextStatus = statusForVotes(request, votes, this.now());
    const updated = nextStatus === request.status ? request : { ...request, status: nextStatus, updatedAt: vote.createdAt };
    if (updated !== request) await this.requests.put(updated);
    const progress = approvalProgress(updated, votes);
    await this.api.bus.emit(HumanApprovalEvents.VoteRecorded, {
      requestId: request.id,
      voteId: vote.id,
      reviewerActorId: vote.reviewerActorId,
      decision: vote.decision,
      reviewTypes: vote.reviewTypes,
      requestStatus: updated.status,
      doesNotAuthorizePhysicalExecution: true,
    });
    if (updated !== request) await this.api.bus.emit(HumanApprovalEvents.RequestUpdated, {
      requestId: updated.id,
      tenantId: updated.tenantId,
      status: updated.status,
      approvedVoteCount: progress.approvedVoteCount,
      quorumSatisfied: progress.quorumSatisfied,
      doesNotAuthorizePhysicalExecution: true,
    });
    return { request: copy(updated), vote: copy(vote), progress: copy(progress) };
  }

  /** Explicitly refresh expiry state; reads do not silently mutate an approval record. */
  async refreshRequest(actor: CommercialActor, requestId: string): Promise<HumanApprovalRequest> {
    assertActor(actor);
    const request = await this.requireRequest(actor, requestId);
    return copy(await this.expireIfNeeded(request));
  }

  /** Cancel a pending request. It retains all review/audit history and cannot erase votes. */
  async cancelRequest(actor: CommercialActor, requestId: string, reason: string): Promise<HumanApprovalRequest> {
    assertActor(actor);
    const request = await this.requireRequest(actor, requestId);
    if (request.requestedByActorId !== actor.id && !isAdministrator(actor)) throw new HumanApprovalError('Only the requestor or an administrator can cancel an approval request.');
    const current = await this.expireIfNeeded(request);
    if (current.status !== 'PENDING') throw new HumanApprovalError(`Approval request is ${current.status} and cannot be cancelled.`);
    const reasonSummary = requiredText(reason, 'Cancellation reason', 640);
    const updated: HumanApprovalRequest = { ...current, status: 'CANCELLED', updatedAt: this.now() };
    await this.requests.put(updated);
    await this.api.bus.emit(HumanApprovalEvents.RequestCancelled, {
      requestId: updated.id,
      tenantId: updated.tenantId,
      reason: reasonSummary,
      doesNotAuthorizePhysicalExecution: true,
    });
    return copy(updated);
  }

  async getRequest(actor: CommercialActor, requestId: string): Promise<HumanApprovalRequest | undefined> {
    const request = await this.requests.get(requestId);
    return request && canRead(actor, request.tenantId) ? copy(request) : undefined;
  }

  async listRequests(actor: CommercialActor): Promise<HumanApprovalRequest[]> {
    return sorted(await this.requests.query({ where: (request) => canRead(actor, request.tenantId) })).map(copy);
  }

  async listVotes(actor: CommercialActor, requestId: string): Promise<HumanApprovalVote[]> {
    const request = await this.requireRequest(actor, requestId);
    return (await this.votesFor(request.id)).map(copy);
  }

  async getProgress(actor: CommercialActor, requestId: string): Promise<HumanApprovalProgress> {
    const request = await this.refreshRequest(actor, requestId);
    return approvalProgress(request, await this.votesFor(request.id));
  }

  async getReviewer(actor: CommercialActor, attestationId: string): Promise<HumanReviewerAttestation | undefined> {
    const attestation = await this.attestations.get(attestationId);
    return attestation && canRead(actor, attestation.tenantId) ? copy(attestation) : undefined;
  }

  async listReviewers(actor: CommercialActor): Promise<HumanReviewerAttestation[]> {
    return sorted(await this.attestations.query({ where: (attestation) => canRead(actor, attestation.tenantId) })).map(copy);
  }

  /** Verify only local vote-record integrity; it does not verify human identity or decision truth. */
  async verifyIntegrity(actor: CommercialActor, tenantId = actor.tenantId): Promise<HumanApprovalIntegrityResult> {
    assertActor(actor);
    if (tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new HumanApprovalError('Only a global administrator can verify another tenant approval ledger.');
    const votes = [...await this.votes.query({ where: (vote) => vote.tenantId === tenantId })]
      .sort((first, second) => first.sequence - second.sequence || first.createdAt - second.createdAt || first.id.localeCompare(second.id));
    let previousHash = 'GENESIS';
    for (let index = 0; index < votes.length; index += 1) {
      const vote = votes[index]!;
      if (vote.sequence !== index + 1) return { tenantId, valid: false, voteCount: votes.length, failure: `Unexpected sequence at vote ${vote.id}.` };
      if (vote.previousHash !== previousHash) return { tenantId, valid: false, voteCount: votes.length, failure: `Previous hash mismatch at vote ${vote.id}.` };
      if (vote.hash !== hashVote({ ...vote, hash: '' })) return { tenantId, valid: false, voteCount: votes.length, failure: `Hash mismatch at vote ${vote.id}.` };
      previousHash = vote.hash;
    }
    return { tenantId, valid: true, voteCount: votes.length };
  }

  private async requireRequest(actor: CommercialActor, requestId: string): Promise<HumanApprovalRequest> {
    const request = await this.getRequest(actor, requestId);
    if (!request) throw new HumanApprovalError('Human approval request not found.');
    return request;
  }

  private async requireAttestation(actor: CommercialActor, attestationId: string): Promise<HumanReviewerAttestation> {
    const attestation = await this.getReviewer(actor, attestationId);
    if (!attestation) throw new HumanApprovalError('Human reviewer attestation not found.');
    return attestation;
  }

  private async requireClaimForActor(actor: CommercialActor, claimId: string): Promise<ResearchClaim> {
    const claim = await this.research.getClaim(actor, claimId);
    if (!claim || claim.tenantId !== actor.tenantId) throw new HumanApprovalError('Research claim not found for this tenant.');
    return claim;
  }

  private async votesFor(requestId: string): Promise<HumanApprovalVote[]> {
    return sorted(await this.votes.query({ where: (vote) => vote.requestId === requestId }));
  }

  private async appendVote(input: Omit<HumanApprovalVote, 'id' | 'sequence' | 'previousHash' | 'hash' | 'createdAt'>): Promise<HumanApprovalVote> {
    const previous = (await this.votes.query({ where: (vote) => vote.tenantId === input.tenantId, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
    const draft: Omit<HumanApprovalVote, 'hash'> = {
      id: randomUUID(),
      ...copy(input),
      sequence: (previous?.sequence ?? 0) + 1,
      previousHash: previous?.hash ?? 'GENESIS',
      createdAt: this.now(),
    };
    const vote: HumanApprovalVote = { ...draft, hash: hashVote({ ...draft, hash: '' }) };
    await this.votes.put(vote);
    return vote;
  }

  private async expireIfNeeded(request: HumanApprovalRequest): Promise<HumanApprovalRequest> {
    if (request.status === 'PENDING' && request.expiresAt !== undefined && request.expiresAt <= this.now()) {
      const expired: HumanApprovalRequest = { ...request, status: 'EXPIRED', updatedAt: this.now() };
      await this.requests.put(expired);
      await this.api.bus.emit(HumanApprovalEvents.RequestUpdated, {
        requestId: expired.id,
        tenantId: expired.tenantId,
        status: expired.status,
        reason: 'Approval request expiry time reached.',
        doesNotAuthorizePhysicalExecution: true,
      });
      return expired;
    }
    return request;
  }
}

function statusForVotes(request: HumanApprovalRequest, votes: readonly HumanApprovalVote[], now: number): HumanApprovalRequestStatus {
  if (request.expiresAt !== undefined && request.expiresAt <= now) return 'EXPIRED';
  if (votes.some((vote) => vote.decision === 'REJECT')) return 'REJECTED';
  return approvalProgress(request, votes).quorumSatisfied ? 'APPROVED' : 'PENDING';
}

function approvalProgress(request: HumanApprovalRequest, votes: readonly HumanApprovalVote[]): HumanApprovalProgress {
  const approved = votes.filter((vote) => vote.decision === 'APPROVE');
  const rejected = votes.filter((vote) => vote.decision === 'REJECT');
  const coveredReviewTypes = reviewTypesFrom(approved.flatMap((vote) => vote.reviewTypes));
  const coveredCompetencyIds = unique(approved.flatMap((vote) => vote.competencyIds));
  const missingReviewTypes = request.requiredReviewTypes.filter((type) => !coveredReviewTypes.includes(type));
  const missingCompetencyIds = request.requiredCompetencyIds.filter((competency) => !coveredCompetencyIds.includes(competency));
  const quorumSatisfied = approved.length >= request.requiredApprovalCount && missingReviewTypes.length === 0 && missingCompetencyIds.length === 0 && rejected.length === 0;
  return {
    request: copy(request),
    approvedVoteCount: approved.length,
    rejectedVoteCount: rejected.length,
    coveredReviewTypes,
    coveredCompetencyIds,
    missingReviewTypes,
    missingCompetencyIds,
    quorumSatisfied,
    doesNotAuthorizePhysicalExecution: true,
  };
}

function validateAttestationInput(input: RegisterHumanReviewerInput, now: number): void {
  if (!input || typeof input !== 'object') throw new HumanApprovalError('Reviewer attestation input is required.');
  requiredText(input.reviewerActorId, 'Reviewer actor id', 180);
  domainScopes(input.domainScopes);
  reviewTypes(input.reviewTypes);
  textList(input.competencyIds, 'Reviewer competency ids', MAX_TEXT_LIST, 160);
  if (input.verificationStatus !== 'DECLARED' && input.verificationStatus !== 'ORGANIZATION_ASSERTED') throw new HumanApprovalError('New reviewer verification status must be DECLARED or ORGANIZATION_ASSERTED.');
  optionalFutureTime(input.expiresAt, 'Attestation expiry', now);
  sanitizeProvenance(input.provenance);
}

function validateRequestInput(input: CreateHumanApprovalRequestInput, now: number): void {
  if (!input || typeof input !== 'object') throw new HumanApprovalError('Human approval request input is required.');
  requiredText(input.claimId, 'Research claim id', 120);
  if (input.assessmentId !== undefined) requiredText(input.assessmentId, 'Research assessment id', 120);
  textList(input.evidenceRecordIds ?? [], 'Research evidence record ids', MAX_TEXT_LIST, 120);
  requiredText(input.purposeSummary, 'Approval purpose summary', 800);
  reviewTypes(input.requiredReviewTypes);
  textList(input.requiredCompetencyIds, 'Required competency ids', MAX_TEXT_LIST, 160);
  approvalCount(input.requiredApprovalCount);
  optionalFutureTime(input.expiresAt, 'Approval request expiry', now);
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function validateVoteInput(input: SubmitHumanApprovalVoteInput): void {
  if (!input || typeof input !== 'object') throw new HumanApprovalError('Human approval vote input is required.');
  requiredText(input.attestationId, 'Reviewer attestation id', 120);
  if (typeof input.decision !== 'string' || !VOTE_DECISIONS.has(input.decision as HumanApprovalVoteDecision)) throw new HumanApprovalError('Approval vote decision is invalid.');
  reviewTypes(input.reviewTypes);
  textList(input.competencyIds, 'Vote competency ids', MAX_TEXT_LIST, 160);
  requiredText(input.rationaleSummary, 'Approval rationale summary', 800);
  sanitizeEvidenceList(input.evidence, true);
  sanitizeProvenance(input.provenance);
}

function domainScopes(value: unknown): AttestationDomainScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DOMAINS.size) throw new HumanApprovalError(`Reviewer domain scopes must contain one to ${DOMAINS.size} values.`);
  const scopes = value.map((scope) => {
    if (typeof scope !== 'string' || !DOMAINS.has(scope as AttestationDomainScope)) throw new HumanApprovalError('Reviewer domain scope is invalid.');
    return scope as AttestationDomainScope;
  });
  if (new Set(scopes).size !== scopes.length) throw new HumanApprovalError('Reviewer domain scopes must be distinct.');
  return scopes;
}

function reviewTypes(value: unknown): HumanReviewType[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > REVIEW_TYPES.size) throw new HumanApprovalError(`Human review types must contain one to ${REVIEW_TYPES.size} values.`);
  const types = value.map((type) => {
    if (typeof type !== 'string' || !REVIEW_TYPES.has(type as HumanReviewType)) throw new HumanApprovalError('Human review type is invalid.');
    return type as HumanReviewType;
  });
  if (new Set(types).size !== types.length) throw new HumanApprovalError('Human review types must be distinct.');
  return types;
}

function reviewTypesFrom(value: readonly string[]): HumanReviewType[] {
  return [...new Set(value)].filter((type): type is HumanReviewType => REVIEW_TYPES.has(type as HumanReviewType)).sort();
}

function approvalCount(value: unknown): number {
  const count = value ?? 1;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_APPROVALS) throw new HumanApprovalError(`Required approval count must be an integer from 1 to ${MAX_APPROVALS}.`);
  return count as number;
}

function isActiveAttestation(attestation: HumanReviewerAttestation, now: number): boolean {
  return (attestation.verificationStatus === 'DECLARED' || attestation.verificationStatus === 'ORGANIZATION_ASSERTED') && (attestation.expiresAt === undefined || attestation.expiresAt > now);
}

function sanitizeEvidenceList(value: unknown, required: boolean): CommercialEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE || (required && value.length === 0)) throw new HumanApprovalError(`Vote evidence must be an array with ${required ? 'at least one and ' : ''}at most ${MAX_EVIDENCE} record(s).`);
  const ids = new Set<string>();
  return value.map((item) => {
    const evidence = record(item, 'Evidence record');
    const id = requiredText(evidence.id, 'Evidence id', 120);
    if (ids.has(id)) throw new HumanApprovalError(`Duplicate evidence id ${id}.`);
    ids.add(id);
    const status = evidence.status;
    if (typeof status !== 'string' || !EVIDENCE_STATUSES.has(status as CommercialEvidence['status'])) throw new HumanApprovalError('Evidence status is invalid.');
    return {
      id,
      status: status as CommercialEvidence['status'],
      source: requiredText(evidence.source, 'Evidence source', 180),
      observedAt: finite(evidence.observedAt, 'Evidence observation time'),
      confidence: percent(evidence.confidence, 'Evidence confidence'),
      summary: requiredText(evidence.summary, 'Evidence summary', 640),
      provenance: sanitizeProvenance(evidence.provenance),
      validUntil: optionalFinite(evidence.validUntil, 'Evidence validity time'),
      privacyClassification: privacyClassification(evidence.privacyClassification),
    };
  });
}

function assertRegulatedApprovalEvidence(evidence: readonly CommercialEvidence[], now: number): void {
  if (evidence.some((item) => item.status === 'CONFLICTING')) {
    throw new HumanApprovalError('A regulated/hazardous approval vote cannot be approved from explicitly conflicting evidence.');
  }
  const hasCurrentStrongEvidence = evidence.some((item) => REGULATED_STRONG_EVIDENCE.has(item.status) && item.status !== 'STALE' && (item.validUntil === undefined || item.validUntil >= now));
  if (!hasCurrentStrongEvidence) {
    throw new HumanApprovalError('A regulated/hazardous approval vote requires at least one current measured/demonstrated/repeated/verified evidence record.');
  }
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
  if (typeof value !== 'string' || !PRIVACY_CLASSIFICATIONS.has(value as PrivacyClassification)) throw new HumanApprovalError('Privacy classification is invalid.');
  return value as PrivacyClassification;
}

function textList(value: unknown, name: string, maximumItems = MAX_TEXT_LIST, maximumLength = 320): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new HumanApprovalError(`${name} must be an array with at most ${maximumItems} item(s).`);
  return unique(value.map((item) => requiredText(item, name, maximumLength)));
}

function requiredText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new HumanApprovalError(`${name} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) throw new HumanApprovalError(`${name} is required.`);
  return bounded(clean, maximumLength);
}

function optionalText(value: unknown, name: string, maximumLength: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, maximumLength);
}

function optionalFutureTime(value: unknown, name: string, now: number): number | undefined {
  if (value === undefined) return undefined;
  const time = finite(value, name);
  if (time <= now) throw new HumanApprovalError(`${name} must be in the future.`);
  return time;
}

function optionalFinite(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : finite(value, name);
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HumanApprovalError(`${name} must be finite.`);
  return value;
}

function percent(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new HumanApprovalError(`${name} must be a finite number from 0 to 100.`);
  return value;
}

function assertActor(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new HumanApprovalError('A tenant-bound human-approval actor is required.');
}

function assertApprover(actor: CommercialActor): void {
  assertActor(actor);
  if (!actor.roles.some((role) => role === 'approver' || role === 'admin' || role === 'global_admin' || role === 'system')) throw new HumanApprovalError('An approver or administrator role is required to submit a human-approval vote.');
}

function assertAdministrator(actor: CommercialActor): void {
  assertActor(actor);
  if (!isAdministrator(actor)) throw new HumanApprovalError('An administrator role is required for reviewer attestations.');
}

function isAdministrator(actor: CommercialActor): boolean {
  return actor.roles.some((role) => role === 'admin' || role === 'global_admin' || role === 'system');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function sorted<T extends { id: string; createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
}

function hashVote(vote: HumanApprovalVote): string {
  return createHash('sha256').update(stable(vote)).digest('hex');
}

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HumanApprovalError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
