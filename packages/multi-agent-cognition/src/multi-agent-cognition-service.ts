import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CognitiveKernelModule } from '@jataqi/cognitive-kernel';
import type { CognitiveKernelService } from '@jataqi/cognitive-kernel';
import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import {
  MultiAgentCognitionEvents,
  type ClaimPosition,
  type ConsistencyReviewStatus,
  type CreateMultiAgentDeliberationInput,
  type CritiqueActionProposal,
  type DeliberationConsistencyReview,
  type DeliberationEvidenceCheck,
  type DeliberationRecommendation,
  type DeliberationReview,
  type DeliberationSafetyReview,
  type DeliberationStatus,
  type DeliberationSynthesis,
  type DisagreementKind,
  type EvidenceQuality,
  type MultiAgentCognitionConfig,
  type MultiAgentDeliberation,
  type MultiAgentDisagreement,
  type MultiAgentReviewRequest,
  type MultiAgentReviewer,
  type RequestedReviewRun,
  type ReviewActionDisposition,
  type ReviewClaim,
  type ReviewerDescriptor,
  type ReviewerRole,
  type ReviewVerdict,
  type SafetyReviewStatus,
  type StructuredReviewMessage,
  type SynthesisStatus,
} from './types.js';

const DELIBERATIONS_COLLECTION = 'multi-agent-cognition.deliberations';
const REVIEWS_COLLECTION = 'multi-agent-cognition.reviews';
const DISAGREEMENTS_COLLECTION = 'multi-agent-cognition.disagreements';
const EVIDENCE_CHECKS_COLLECTION = 'multi-agent-cognition.evidence-checks';
const CONSISTENCY_REVIEWS_COLLECTION = 'multi-agent-cognition.consistency-reviews';
const SAFETY_REVIEWS_COLLECTION = 'multi-agent-cognition.safety-reviews';
const SYNTHESES_COLLECTION = 'multi-agent-cognition.syntheses';

const MAX_REVIEW_ATTEMPTS = 3;
const MAX_EVIDENCE = 100;
const MAX_TEXT_LIST = 20;
const MAX_CLAIMS = 20;
const REVIEWER_ROLES = new Set<ReviewerRole>([
  'RESEARCH_AGENT',
  'CRITIC_AGENT',
  'STATISTICS_AGENT',
  'DOMAIN_AGENT',
  'SAFETY_AGENT',
  'RED_TEAM_AGENT',
  'REPRODUCIBILITY_AGENT',
]);
const REVIEW_VERDICTS = new Set<ReviewVerdict>([
  'SUPPORTS',
  'CHALLENGES',
  'INCONCLUSIVE',
  'SAFETY_ESCALATION_RECOMMENDED',
  'REPRODUCIBILITY_REQUIRED',
]);
const ACTION_DISPOSITIONS = new Set<ReviewActionDisposition>([
  'NO_ACTION',
  'GATHER_EVIDENCE',
  'REQUEST_HUMAN_REVIEW',
  'REQUEST_REPRODUCTION',
  'ESCALATE_SAFETY',
  'GOVERNED_ACTION_CANDIDATE',
]);
const CLAIM_POSITIONS = new Set<ClaimPosition>(['SUPPORTS', 'CHALLENGES', 'UNCERTAIN']);
const EVIDENCE_STATUSES = new Set<CommercialEvidence['status']>([
  'UNVERIFIED',
  'PARTIAL',
  'OBSERVED',
  'MEASURED',
  'CUSTOMER_CONFIRMED',
  'DEMONSTRATED',
  'REPEATED',
  'VERIFIED',
  'ESTIMATED',
  'ASSUMPTION',
  'PREDICTION',
  'STALE',
  'CONFLICTING',
  'UNAVAILABLE',
]);
const PRIVACY_CLASSIFICATIONS = new Set<PrivacyClassification>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PERSONAL_DATA']);
const STRONG_EVIDENCE = new Set<CommercialEvidence['status']>(['MEASURED', 'CUSTOMER_CONFIRMED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED']);
const WEAK_EVIDENCE = new Set<CommercialEvidence['status']>(['UNVERIFIED', 'PARTIAL', 'OBSERVED']);

export class MultiAgentCognitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultiAgentCognitionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * JQB structured multi-agent critique coordinator.
 *
 * This service stores concise, auditable reviewer positions and deterministic
 * evidence/consistency/safety assessments. It ships with no reviewer, model,
 * tool, connector, credential, command execution, or direct-action capability.
 * An application may explicitly inject reviewer implementations; those injected
 * implementations remain a host-controlled trust/sandboxing responsibility.
 */
export class MultiAgentCognitionService {
  private api!: KernelApi;
  private cognitive!: CognitiveKernelService;
  private deliberations!: ICollection<MultiAgentDeliberation>;
  private reviews!: ICollection<DeliberationReview>;
  private disagreements!: ICollection<MultiAgentDisagreement>;
  private evidenceChecks!: ICollection<DeliberationEvidenceCheck>;
  private consistencyReviews!: ICollection<DeliberationConsistencyReview>;
  private safetyReviews!: ICollection<DeliberationSafetyReview>;
  private syntheses!: ICollection<DeliberationSynthesis>;
  private readonly reviewers = new Map<string, MultiAgentReviewer>();
  private readonly maxReviewAttempts: number;

  constructor(config: MultiAgentCognitionConfig = {}) {
    this.maxReviewAttempts = normalizeReviewAttempts(config.maxReviewAttempts);
    for (const reviewer of config.reviewers ?? []) this.registerReviewer(reviewer);
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.deliberations = await storage.collection<MultiAgentDeliberation>(DELIBERATIONS_COLLECTION);
    this.reviews = await storage.collection<DeliberationReview>(REVIEWS_COLLECTION);
    this.disagreements = await storage.collection<MultiAgentDisagreement>(DISAGREEMENTS_COLLECTION);
    this.evidenceChecks = await storage.collection<DeliberationEvidenceCheck>(EVIDENCE_CHECKS_COLLECTION);
    this.consistencyReviews = await storage.collection<DeliberationConsistencyReview>(CONSISTENCY_REVIEWS_COLLECTION);
    this.safetyReviews = await storage.collection<DeliberationSafetyReview>(SAFETY_REVIEWS_COLLECTION);
    this.syntheses = await storage.collection<DeliberationSynthesis>(SYNTHESES_COLLECTION);
    this.cognitive = kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
  }

  /** Register a host-provided reviewer. No reviewer is present by default. */
  registerReviewer(reviewer: MultiAgentReviewer): ReviewerDescriptor {
    const normalized = normalizeReviewer(reviewer);
    if (this.reviewers.has(normalized.id)) throw new MultiAgentCognitionError(`Reviewer ${normalized.id} is already registered.`);
    this.reviewers.set(normalized.id, normalized);
    return reviewerDescriptor(normalized);
  }

  /** Remove an injected reviewer from future explicit review runs. Historical reviews remain. */
  unregisterReviewer(reviewerId: string): boolean {
    return this.reviewers.delete(reviewerId.trim());
  }

  /** Returns descriptors only; reviewer implementation details and credentials are never exposed. */
  listReviewers(): ReviewerDescriptor[] {
    return [...this.reviewers.values()].map(reviewerDescriptor).sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id));
  }

  async createDeliberation(actor: CommercialActor, input: CreateMultiAgentDeliberationInput): Promise<MultiAgentDeliberation> {
    assertActor(actor);
    validateCreateInput(input);
    const state = await this.cognitive.getState(actor, input.cognitiveStateId);
    if (!state || state.tenantId !== actor.tenantId) {
      throw new MultiAgentCognitionError('A cognitive state from the actor tenant is required for multi-agent deliberation.');
    }
    const now = Date.now();
    const deliberation: MultiAgentDeliberation = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      cognitiveStateId: state.id,
      title: requiredText(input.title, 'Deliberation title', 180),
      hypothesis: requiredText(input.hypothesis, 'Deliberation hypothesis', 1_000),
      evidence: sanitizeEvidenceList(input.evidence),
      assumptions: textList(input.assumptions, 'Deliberation assumptions'),
      confidence: percent(input.confidence, 'Deliberation confidence'),
      proposedAction: sanitizeAction(input.proposedAction),
      uncertainty: textList(input.uncertainty, 'Deliberation uncertainty'),
      requestedRoles: requestedRoles(input.requestedRoles),
      status: 'OPEN',
      privacyClassification: privacyClassification(input.privacyClassification),
      provenance: sanitizeProvenance(input.provenance),
      createdAt: now,
      updatedAt: now,
    };
    await this.deliberations.put(deliberation);
    await this.api.bus.emit(MultiAgentCognitionEvents.DeliberationCreated, {
      deliberationId: deliberation.id,
      tenantId: deliberation.tenantId,
      cognitiveStateId: deliberation.cognitiveStateId,
      requestedRoles: deliberation.requestedRoles,
      evidenceCount: deliberation.evidence.length,
    });
    return copy(deliberation);
  }

  /**
   * Explicitly ask one registered reviewer for a data-only structured critique.
   * A completed reviewer is idempotent; failures are persisted with a bounded
   * diagnostic so no fictitious review is substituted.
   */
  async runReview(actor: CommercialActor, deliberationId: string, reviewerId: string): Promise<DeliberationReview> {
    assertActor(actor);
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    const reviewer = this.reviewers.get(reviewerId.trim());
    if (!reviewer) throw new MultiAgentCognitionError(`Reviewer ${reviewerId} is not registered.`);
    if (!deliberation.requestedRoles.includes(reviewer.role)) {
      throw new MultiAgentCognitionError(`Reviewer role ${reviewer.role} was not requested for this deliberation.`);
    }

    const historical = await this.reviewsFor(deliberation.id);
    const completed = historical.find((review) => review.reviewerId === reviewer.id && review.state === 'COMPLETED');
    if (completed) return copy(completed);
    const attempt = historical.filter((review) => review.reviewerId === reviewer.id).length + 1;
    if (attempt > this.maxReviewAttempts) {
      throw new MultiAgentCognitionError(`Reviewer ${reviewer.id} reached the ${this.maxReviewAttempts}-attempt limit for this deliberation.`);
    }

    let record: DeliberationReview;
    try {
      const response = await reviewer.review(reviewRequest(deliberation));
      const message = sanitizeReviewMessage(response, deliberation);
      record = {
        id: randomUUID(),
        tenantId: deliberation.tenantId,
        deliberationId: deliberation.id,
        reviewerId: reviewer.id,
        reviewerRole: reviewer.role,
        attempt,
        state: 'COMPLETED',
        message,
        createdAt: Date.now(),
      };
    } catch (error) {
      const invalidResponse = error instanceof MultiAgentCognitionError;
      record = {
        id: randomUUID(),
        tenantId: deliberation.tenantId,
        deliberationId: deliberation.id,
        reviewerId: reviewer.id,
        reviewerRole: reviewer.role,
        attempt,
        state: 'FAILED',
        failureCode: invalidResponse ? 'INVALID_RESPONSE' : 'REVIEWER_ERROR',
        failureSummary: safeFailureSummary(error),
        createdAt: Date.now(),
      };
      await this.reviews.put(record);
      await this.refreshReviewStatus(deliberation);
      await this.api.bus.emit(MultiAgentCognitionEvents.ReviewFailed, {
        deliberationId: deliberation.id,
        reviewId: record.id,
        reviewerId: record.reviewerId,
        reviewerRole: record.reviewerRole,
        attempt: record.attempt,
        failureCode: record.failureCode,
      });
      return copy(record);
    }

    await this.reviews.put(record);
    await this.detectDisagreements(deliberation, record);
    await this.refreshReviewStatus(deliberation);
    await this.api.bus.emit(MultiAgentCognitionEvents.ReviewRecorded, {
      deliberationId: deliberation.id,
      reviewId: record.id,
      reviewerId: record.reviewerId,
      reviewerRole: record.reviewerRole,
      attempt: record.attempt,
      verdict: record.message?.verdict,
    });
    return copy(record);
  }

  /**
   * Explicitly run at most one eligible injected reviewer for every requested
   * role. It does not invent absent reviewers, start background work, or retry
   * indefinitely.
   */
  async runRequestedReviews(actor: CommercialActor, deliberationId: string): Promise<RequestedReviewRun> {
    assertActor(actor);
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    const existing = await this.reviewsFor(deliberation.id);
    const reviews: DeliberationReview[] = [];
    const unavailableRoles: ReviewerRole[] = [];

    for (const role of deliberation.requestedRoles) {
      if (existing.some((review) => review.reviewerRole === role && review.state === 'COMPLETED')) continue;
      const reviewer = [...this.reviewers.values()]
        .filter((candidate) => candidate.role === role)
        .sort((a, b) => a.id.localeCompare(b.id))
        .find((candidate) => existing.filter((review) => review.reviewerId === candidate.id).length < this.maxReviewAttempts);
      if (!reviewer) {
        unavailableRoles.push(role);
        continue;
      }
      const review = await this.runReview(actor, deliberation.id, reviewer.id);
      reviews.push(review);
      existing.push(review);
    }
    return { reviews: reviews.map(copy), unavailableRoles };
  }

  /** Persist a deterministic quality assessment of evidence already attached to a deliberation. */
  async checkEvidence(actor: CommercialActor, deliberationId: string): Promise<DeliberationEvidenceCheck> {
    assertActor(actor);
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    return this.recordEvidenceCheck(deliberation);
  }

  /** Persist a deterministic structural consistency assessment of completed reviews and role coverage. */
  async assessConsistency(actor: CommercialActor, deliberationId: string): Promise<DeliberationConsistencyReview> {
    assertActor(actor);
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    return this.recordConsistencyReview(deliberation);
  }

  /**
   * Persist a dedicated advisory safety review. A record of no concern is never
   * a safety approval, operational authorization, or physical-world clearance.
   */
  async assessSafety(actor: CommercialActor, deliberationId: string): Promise<DeliberationSafetyReview> {
    assertActor(actor);
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    return this.recordSafetyReview(deliberation);
  }

  /**
   * Synthesize only stored structured reviews. The result always retains the
   * hypothesis label and permanently reports NOT_AUTHORIZED for execution.
   */
  async synthesize(actor: CommercialActor, deliberationId: string): Promise<DeliberationSynthesis> {
    assertActor(actor);
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    const evidenceCheck = await this.recordEvidenceCheck(deliberation);
    const consistencyReview = await this.recordConsistencyReview(deliberation);
    const safetyReview = await this.recordSafetyReview(deliberation);
    const completed = (await this.reviewsFor(deliberation.id)).filter((review) => review.state === 'COMPLETED' && review.message);
    const disagreements = await this.disagreementsFor(deliberation.id);
    const result = synthesisResult(deliberation, completed, disagreements, evidenceCheck, consistencyReview, safetyReview);
    const now = Date.now();
    const synthesis: DeliberationSynthesis = {
      id: randomUUID(),
      tenantId: deliberation.tenantId,
      deliberationId: deliberation.id,
      evidenceCheckId: evidenceCheck.id,
      consistencyReviewId: consistencyReview.id,
      safetyReviewId: safetyReview.id,
      reviewIds: completed.map((review) => review.id),
      unresolvedDisagreementIds: disagreements.map((disagreement) => disagreement.id),
      status: result.status,
      hypothesisStatus: 'RETAINED_AS_HYPOTHESIS',
      conclusionSummary: result.conclusionSummary,
      uncertaintySummary: result.uncertaintySummary,
      recommendation: result.recommendation,
      executionAuthorization: 'NOT_AUTHORIZED',
      provenance: {
        source: 'multi-agent-cognition',
        collectedAt: now,
        correlationId: deliberation.id,
        causationId: deliberation.provenance.causationId,
      },
      createdAt: now,
    };
    await this.syntheses.put(synthesis);
    const status = deliberationStatusForSynthesis(synthesis.status);
    await this.deliberations.put({ ...deliberation, status, latestSynthesisId: synthesis.id, updatedAt: now });
    await this.api.bus.emit(MultiAgentCognitionEvents.Synthesized, {
      deliberationId: deliberation.id,
      synthesisId: synthesis.id,
      status: synthesis.status,
      recommendation: synthesis.recommendation,
      executionAuthorization: synthesis.executionAuthorization,
    });
    return copy(synthesis);
  }

  async getDeliberation(actor: CommercialActor, deliberationId: string): Promise<MultiAgentDeliberation | undefined> {
    const deliberation = await this.deliberations.get(deliberationId);
    return deliberation && canRead(actor, deliberation.tenantId) ? copy(deliberation) : undefined;
  }

  async listDeliberations(actor: CommercialActor): Promise<MultiAgentDeliberation[]> {
    return sorted(await this.deliberations.query({ where: (deliberation) => canRead(actor, deliberation.tenantId) })).map(copy);
  }

  async listReviews(actor: CommercialActor, deliberationId: string): Promise<DeliberationReview[]> {
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    return (await this.reviewsFor(deliberation.id)).map(copy);
  }

  async listDisagreements(actor: CommercialActor, deliberationId: string): Promise<MultiAgentDisagreement[]> {
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    return (await this.disagreementsFor(deliberation.id)).map(copy);
  }

  async listEvidenceChecks(actor: CommercialActor, deliberationId: string): Promise<DeliberationEvidenceCheck[]> {
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    return sorted(await this.evidenceChecks.query({ where: (check) => check.deliberationId === deliberation.id })).map(copy);
  }

  async listConsistencyReviews(actor: CommercialActor, deliberationId: string): Promise<DeliberationConsistencyReview[]> {
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    return sorted(await this.consistencyReviews.query({ where: (review) => review.deliberationId === deliberation.id })).map(copy);
  }

  async listSafetyReviews(actor: CommercialActor, deliberationId: string): Promise<DeliberationSafetyReview[]> {
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    return sorted(await this.safetyReviews.query({ where: (review) => review.deliberationId === deliberation.id })).map(copy);
  }

  async listSyntheses(actor: CommercialActor, deliberationId: string): Promise<DeliberationSynthesis[]> {
    const deliberation = await this.requireDeliberation(actor, deliberationId);
    return sorted(await this.syntheses.query({ where: (synthesis) => synthesis.deliberationId === deliberation.id })).map(copy);
  }

  private async requireDeliberation(actor: CommercialActor, deliberationId: string): Promise<MultiAgentDeliberation> {
    const deliberation = await this.getDeliberation(actor, deliberationId);
    if (!deliberation) throw new MultiAgentCognitionError('Multi-agent deliberation not found.');
    return deliberation;
  }

  private async reviewsFor(deliberationId: string): Promise<DeliberationReview[]> {
    return sorted(await this.reviews.query({ where: (review) => review.deliberationId === deliberationId }));
  }

  private async disagreementsFor(deliberationId: string): Promise<MultiAgentDisagreement[]> {
    return sorted(await this.disagreements.query({ where: (disagreement) => disagreement.deliberationId === deliberationId }));
  }

  private async refreshReviewStatus(deliberation: MultiAgentDeliberation): Promise<void> {
    const completedRoles = new Set((await this.reviewsFor(deliberation.id))
      .filter((review) => review.state === 'COMPLETED')
      .map((review) => review.reviewerRole));
    const status: DeliberationStatus = completedRoles.size === 0
      ? 'UNDER_REVIEW'
      : deliberation.requestedRoles.every((role) => completedRoles.has(role))
        ? 'READY_FOR_SYNTHESIS'
        : 'UNDER_REVIEW';
    await this.deliberations.put({ ...deliberation, status, updatedAt: Date.now() });
  }

  private async detectDisagreements(deliberation: MultiAgentDeliberation, review: DeliberationReview): Promise<void> {
    if (review.state !== 'COMPLETED' || !review.message) return;
    const priorReviews = (await this.reviewsFor(deliberation.id)).filter((candidate) => candidate.id !== review.id && candidate.state === 'COMPLETED' && candidate.message);
    const message = review.message;

    if (isSafetyConcern(message)) {
      await this.appendDisagreement(deliberation, {
        reviewIds: [review.id],
        kind: 'SAFETY_CONCERN',
        subjectSummary: 'A reviewer recorded a safety concern requiring human assessment before any separate action consideration.',
        positionSummaries: [`${review.reviewerRole} recommends safety escalation.`],
        evidenceIds: message.evidenceIds,
      });
    }

    for (const prior of priorReviews) {
      const priorMessage = prior.message!;
      if (opposingVerdicts(message.verdict, priorMessage.verdict)) {
        await this.appendDisagreement(deliberation, {
          reviewIds: [prior.id, review.id],
          kind: 'HYPOTHESIS_POSITION_CONFLICT',
          subjectSummary: `Reviewer positions conflict on the recorded hypothesis: ${bounded(deliberation.hypothesis, 220)}.`,
          positionSummaries: [
            `${prior.reviewerRole}: ${priorMessage.verdict}.`,
            `${review.reviewerRole}: ${message.verdict}.`,
          ],
          evidenceIds: unique([...priorMessage.evidenceIds, ...message.evidenceIds]),
        });
      }
      if (actionConflict(priorMessage.proposedAction.disposition, message.proposedAction.disposition)) {
        await this.appendDisagreement(deliberation, {
          reviewIds: [prior.id, review.id],
          kind: 'ACTION_RECOMMENDATION_CONFLICT',
          subjectSummary: 'Reviewer action dispositions differ; this package does not select or execute either action.',
          positionSummaries: [
            `${prior.reviewerRole}: ${priorMessage.proposedAction.disposition}.`,
            `${review.reviewerRole}: ${message.proposedAction.disposition}.`,
          ],
          evidenceIds: unique([...priorMessage.evidenceIds, ...message.evidenceIds]),
        });
      }
      for (const claim of message.claims ?? []) {
        for (const earlierClaim of priorMessage.claims ?? []) {
          if (normalize(claim.proposition) === normalize(earlierClaim.proposition) && opposingPositions(claim.position, earlierClaim.position)) {
            await this.appendDisagreement(deliberation, {
              reviewIds: [prior.id, review.id],
              kind: 'CLAIM_POSITION_CONFLICT',
              subjectSummary: `Reviewer claims conflict on: ${bounded(claim.proposition, 220)}.`,
              positionSummaries: [
                `${prior.reviewerRole}: ${earlierClaim.position}.`,
                `${review.reviewerRole}: ${claim.position}.`,
              ],
              evidenceIds: unique([...earlierClaim.evidenceIds, ...claim.evidenceIds]),
            });
          }
        }
      }
    }
  }

  private async appendDisagreement(
    deliberation: MultiAgentDeliberation,
    input: Omit<MultiAgentDisagreement, 'id' | 'tenantId' | 'deliberationId' | 'status' | 'createdAt'>,
  ): Promise<MultiAgentDisagreement> {
    const disagreement: MultiAgentDisagreement = {
      id: randomUUID(),
      tenantId: deliberation.tenantId,
      deliberationId: deliberation.id,
      reviewIds: unique(input.reviewIds),
      kind: input.kind,
      subjectSummary: bounded(input.subjectSummary, 300),
      positionSummaries: textList(input.positionSummaries, 'Disagreement positions'),
      evidenceIds: unique(input.evidenceIds),
      status: 'OPEN',
      createdAt: Date.now(),
    };
    await this.disagreements.put(disagreement);
    await this.api.bus.emit(MultiAgentCognitionEvents.DisagreementDetected, {
      deliberationId: deliberation.id,
      disagreementId: disagreement.id,
      kind: disagreement.kind,
      reviewIds: disagreement.reviewIds,
    });
    return disagreement;
  }

  private async recordEvidenceCheck(deliberation: MultiAgentDeliberation): Promise<DeliberationEvidenceCheck> {
    const now = Date.now();
    const strongEvidenceIds: string[] = [];
    const weakEvidenceIds: string[] = [];
    const uncertainEvidenceIds: string[] = [];
    const staleEvidenceIds: string[] = [];
    const conflictingEvidenceIds: string[] = [];
    const validSources = new Set<string>();
    const strongSources = new Set<string>();

    for (const evidence of deliberation.evidence) {
      const stale = evidence.status === 'STALE' || (evidence.validUntil !== undefined && evidence.validUntil < now);
      if (stale) {
        staleEvidenceIds.push(evidence.id);
        continue;
      }
      if (evidence.status === 'CONFLICTING') {
        conflictingEvidenceIds.push(evidence.id);
        continue;
      }
      const source = normalize(evidence.source);
      validSources.add(source);
      if (STRONG_EVIDENCE.has(evidence.status)) {
        strongEvidenceIds.push(evidence.id);
        strongSources.add(source);
      } else if (WEAK_EVIDENCE.has(evidence.status)) weakEvidenceIds.push(evidence.id);
      else uncertainEvidenceIds.push(evidence.id);
    }

    const independentSourceCount = validSources.size;
    const sufficientForDecisionSupport = strongEvidenceIds.length >= 2 && strongSources.size >= 2 && conflictingEvidenceIds.length === 0;
    const issues: string[] = [];
    if (deliberation.evidence.length === 0) issues.push('No evidence was supplied; the hypothesis cannot be treated as supported.');
    if (strongEvidenceIds.length < 2) issues.push('Fewer than two current strong evidence records are attached.');
    if (strongSources.size < 2 && deliberation.evidence.length > 0) issues.push('Fewer than two independent current strong-evidence sources are attached.');
    if (weakEvidenceIds.length > 0) issues.push(`${weakEvidenceIds.length} evidence record(s) remain unverified, partial, or observational.`);
    if (uncertainEvidenceIds.length > 0) issues.push(`${uncertainEvidenceIds.length} evidence record(s) are estimated, assumed, predicted, unavailable, or otherwise uncertain.`);
    if (staleEvidenceIds.length > 0) issues.push(`${staleEvidenceIds.length} evidence record(s) are stale or past their validity window.`);
    if (conflictingEvidenceIds.length > 0) issues.push(`${conflictingEvidenceIds.length} evidence record(s) explicitly report conflict.`);
    const quality: EvidenceQuality = deliberation.evidence.length === 0
      ? 'NONE'
      : sufficientForDecisionSupport
        ? 'SUFFICIENT'
        : conflictingEvidenceIds.length > 0 || (strongEvidenceIds.length > 0 && (weakEvidenceIds.length > 0 || uncertainEvidenceIds.length > 0 || staleEvidenceIds.length > 0))
          ? 'MIXED'
          : 'INSUFFICIENT';
    const check: DeliberationEvidenceCheck = {
      id: randomUUID(),
      tenantId: deliberation.tenantId,
      deliberationId: deliberation.id,
      evidenceIds: deliberation.evidence.map((evidence) => evidence.id),
      independentSourceCount,
      strongEvidenceIds,
      weakEvidenceIds,
      uncertainEvidenceIds,
      staleEvidenceIds,
      conflictingEvidenceIds,
      quality,
      sufficientForDecisionSupport,
      issues,
      createdAt: now,
    };
    await this.evidenceChecks.put(check);
    await this.api.bus.emit(MultiAgentCognitionEvents.EvidenceChecked, {
      deliberationId: deliberation.id,
      evidenceCheckId: check.id,
      quality: check.quality,
      sufficientForDecisionSupport: check.sufficientForDecisionSupport,
    });
    return check;
  }

  private async recordConsistencyReview(deliberation: MultiAgentDeliberation): Promise<DeliberationConsistencyReview> {
    const completed = (await this.reviewsFor(deliberation.id)).filter((review) => review.state === 'COMPLETED');
    const completedRoles = unique(completed.map((review) => review.reviewerRole)) as ReviewerRole[];
    const missingRoles = deliberation.requestedRoles.filter((role) => !completedRoles.includes(role));
    const disagreements = await this.disagreementsFor(deliberation.id);
    const actionCandidateWithoutSafety = deliberation.proposedAction.disposition === 'GOVERNED_ACTION_CANDIDATE' && !deliberation.requestedRoles.includes('SAFETY_AGENT');
    const issues: string[] = [];
    if (missingRoles.length > 0) issues.push(`Missing requested reviewer role(s): ${missingRoles.join(', ')}.`);
    if (actionCandidateWithoutSafety) issues.push('A governed-action candidate requires a requested SAFETY_AGENT review before it can be considered outside this package.');
    if (disagreements.length > 0) issues.push(`${disagreements.length} retained disagreement record(s) require explicit consideration.`);
    const status: ConsistencyReviewStatus = missingRoles.length > 0 || actionCandidateWithoutSafety
      ? 'INSUFFICIENT_REVIEW'
      : disagreements.length > 0
        ? 'CONFLICTING'
        : 'CONSISTENT';
    const review: DeliberationConsistencyReview = {
      id: randomUUID(),
      tenantId: deliberation.tenantId,
      deliberationId: deliberation.id,
      completedReviewIds: completed.map((item) => item.id),
      completedRoles,
      missingRoles,
      disagreementIds: disagreements.map((item) => item.id),
      status,
      issues,
      createdAt: Date.now(),
    };
    await this.consistencyReviews.put(review);
    await this.api.bus.emit(MultiAgentCognitionEvents.ConsistencyReviewed, {
      deliberationId: deliberation.id,
      consistencyReviewId: review.id,
      status: review.status,
      missingRoles: review.missingRoles,
      disagreementCount: review.disagreementIds.length,
    });
    return review;
  }

  private async recordSafetyReview(deliberation: MultiAgentDeliberation): Promise<DeliberationSafetyReview> {
    const allCompleted = (await this.reviewsFor(deliberation.id)).filter((review) => review.state === 'COMPLETED' && review.message);
    const dedicatedSafetyReviews = allCompleted.filter((review) => review.reviewerRole === 'SAFETY_AGENT' || review.reviewerRole === 'RED_TEAM_AGENT');
    // Any structured reviewer may surface a safety concern. A non-safety role is
    // not treated as a safety certification, but its escalation is never ignored.
    const concernReviews = allCompleted.filter((review) => isSafetyConcern(review.message!));
    const considered = new Map<string, DeliberationReview>();
    for (const item of [...dedicatedSafetyReviews, ...concernReviews]) considered.set(item.id, item);
    const concernCount = concernReviews.reduce((count, review) => count + Math.max(1, review.message!.safetyConcerns?.length ?? 0), 0);
    const actionCandidate = deliberation.proposedAction.disposition === 'GOVERNED_ACTION_CANDIDATE';
    const status: SafetyReviewStatus = concernCount > 0
      ? 'ESCALATION_RECOMMENDED'
      : dedicatedSafetyReviews.length === 0
        ? 'NOT_REVIEWED'
        : 'NO_CONCERN_RECORDED';
    const review: DeliberationSafetyReview = {
      id: randomUUID(),
      tenantId: deliberation.tenantId,
      deliberationId: deliberation.id,
      reviewIds: sorted([...considered.values()]).map((item) => item.id),
      safetyReviewerRoles: unique(dedicatedSafetyReviews.map((item) => item.reviewerRole)) as ReviewerRole[],
      concernCount,
      status,
      recommendation: status === 'ESCALATION_RECOMMENDED'
        ? 'NO_ACTION'
        : status === 'NOT_REVIEWED' && actionCandidate
          ? 'REQUEST_HUMAN_SAFETY_REVIEW'
          : 'CONTINUE_REVIEW',
      doesNotAuthorizeAction: true,
      createdAt: Date.now(),
    };
    await this.safetyReviews.put(review);
    await this.api.bus.emit(MultiAgentCognitionEvents.SafetyReviewed, {
      deliberationId: deliberation.id,
      safetyReviewId: review.id,
      status: review.status,
      concernCount: review.concernCount,
      doesNotAuthorizeAction: true,
    });
    return review;
  }
}

function synthesisResult(
  deliberation: MultiAgentDeliberation,
  reviews: DeliberationReview[],
  disagreements: MultiAgentDisagreement[],
  evidence: DeliberationEvidenceCheck,
  consistency: DeliberationConsistencyReview,
  safety: DeliberationSafetyReview,
): Pick<DeliberationSynthesis, 'status' | 'conclusionSummary' | 'uncertaintySummary' | 'recommendation'> {
  const completedRoles = unique(reviews.map((review) => review.reviewerRole));
  const evidenceIssues = evidence.issues.length ? evidence.issues.join(' ') : 'Current evidence metadata met the minimum configured deterministic review threshold.';
  const reviewIssues = consistency.issues.length ? consistency.issues.join(' ') : 'All requested review roles completed without a detected structural disagreement.';
  let status: SynthesisStatus;
  let recommendation: DeliberationRecommendation;
  let conclusionSummary: string;

  if (safety.status === 'ESCALATION_RECOMMENDED') {
    status = 'SAFETY_ESCALATION';
    recommendation = 'ESCALATE_SAFETY';
    conclusionSummary = `A structured safety or red-team review recorded ${safety.concernCount} concern(s). The hypothesis remains unverified and no action is authorized.`;
  } else if (!evidence.sufficientForDecisionSupport || consistency.status === 'INSUFFICIENT_REVIEW') {
    status = 'INSUFFICIENT_EVIDENCE';
    recommendation = deliberation.proposedAction.disposition === 'NO_ACTION' ? 'NO_ACTION' : 'GATHER_EVIDENCE';
    conclusionSummary = `The review cannot support the recorded hypothesis because evidence quality or required review coverage is insufficient. The hypothesis remains a hypothesis, not a fact.`;
  } else if (reviews.some((review) => review.message?.verdict === 'REPRODUCIBILITY_REQUIRED')) {
    status = 'REPRODUCIBILITY_REQUIRED';
    recommendation = 'REQUEST_REPRODUCTION';
    conclusionSummary = 'A reviewer requested reproducibility work before the recorded hypothesis can be relied upon. No replication result is fabricated by this synthesis.';
  } else if (disagreements.length > 0 || consistency.status === 'CONFLICTING') {
    status = 'DISAGREEMENT_UNRESOLVED';
    recommendation = 'REQUEST_HUMAN_REVIEW';
    conclusionSummary = `Structured reviewers retain ${disagreements.length} disagreement record(s). The service does not collapse those positions into a fact or select an action.`;
  } else {
    const supports = reviews.filter((review) => review.message?.verdict === 'SUPPORTS').length;
    const challenges = reviews.filter((review) => review.message?.verdict === 'CHALLENGES').length;
    if (supports > challenges) {
      status = 'HYPOTHESIS_CONDITIONALLY_SUPPORTED';
      recommendation = recommendationForSupportedHypothesis(deliberation);
      conclusionSummary = 'Completed structured reviewers conditionally support the hypothesis under the recorded evidence and assumptions. It remains a hypothesis, not verified knowledge.';
    } else if (challenges > supports) {
      status = 'HYPOTHESIS_CHALLENGED';
      recommendation = deliberation.proposedAction.disposition === 'NO_ACTION' ? 'NO_ACTION' : 'GATHER_EVIDENCE';
      conclusionSummary = 'Completed structured reviewers challenge the hypothesis. The critique is not proof of the opposite proposition, and no action is authorized.';
    } else {
      status = 'INCONCLUSIVE';
      recommendation = deliberation.proposedAction.disposition === 'NO_ACTION' ? 'NO_ACTION' : 'GATHER_EVIDENCE';
      conclusionSummary = 'Completed structured reviewers are inconclusive. The system retains uncertainty and does not promote the hypothesis into a fact.';
    }
  }

  return {
    status,
    recommendation,
    conclusionSummary,
    uncertaintySummary: `Completed reviewer roles: ${completedRoles.length ? completedRoles.join(', ') : 'none'}. ${evidenceIssues} ${reviewIssues} Execution remains NOT_AUTHORIZED.`,
  };
}

function recommendationForSupportedHypothesis(deliberation: MultiAgentDeliberation): DeliberationRecommendation {
  switch (deliberation.proposedAction.disposition) {
    case 'NO_ACTION': return 'NO_ACTION';
    case 'GATHER_EVIDENCE': return 'GATHER_EVIDENCE';
    case 'REQUEST_HUMAN_REVIEW': return 'REQUEST_HUMAN_REVIEW';
    case 'REQUEST_REPRODUCTION': return 'REQUEST_REPRODUCTION';
    case 'ESCALATE_SAFETY': return 'ESCALATE_SAFETY';
    case 'GOVERNED_ACTION_CANDIDATE': return 'CONSIDER_SEPARATE_GOVERNED_AUTHORIZATION';
  }
}

function deliberationStatusForSynthesis(status: SynthesisStatus): DeliberationStatus {
  if (status === 'SAFETY_ESCALATION') return 'SAFETY_ESCALATED';
  if (status === 'INSUFFICIENT_EVIDENCE') return 'INSUFFICIENT_EVIDENCE';
  return 'SYNTHESIZED';
}

function reviewRequest(deliberation: MultiAgentDeliberation): MultiAgentReviewRequest {
  return {
    deliberationId: deliberation.id,
    tenantId: deliberation.tenantId,
    cognitiveStateId: deliberation.cognitiveStateId,
    title: deliberation.title,
    hypothesis: deliberation.hypothesis,
    evidence: deliberation.evidence.map(copy),
    assumptions: [...deliberation.assumptions],
    confidence: deliberation.confidence,
    proposedAction: copy(deliberation.proposedAction),
    uncertainty: [...deliberation.uncertainty],
    requestedRoles: [...deliberation.requestedRoles],
    privacyClassification: deliberation.privacyClassification,
  };
}

function normalizeReviewer(reviewer: MultiAgentReviewer): MultiAgentReviewer {
  if (!reviewer || typeof reviewer !== 'object') throw new MultiAgentCognitionError('A reviewer object is required.');
  const candidate = reviewer as MultiAgentReviewer;
  const id = requiredText(candidate.id, 'Reviewer id', 120);
  if (!REVIEWER_ROLES.has(candidate.role)) throw new MultiAgentCognitionError('Reviewer role is invalid.');
  if (typeof candidate.review !== 'function') throw new MultiAgentCognitionError(`Reviewer ${id} must provide a review function.`);
  return {
    id,
    role: candidate.role,
    label: candidate.label === undefined ? undefined : requiredText(candidate.label, 'Reviewer label', 180),
    capabilitySummary: candidate.capabilitySummary === undefined ? undefined : requiredText(candidate.capabilitySummary, 'Reviewer capability summary', 320),
    review: candidate.review.bind(candidate),
  };
}

function reviewerDescriptor(reviewer: MultiAgentReviewer): ReviewerDescriptor {
  return {
    id: reviewer.id,
    role: reviewer.role,
    label: reviewer.label,
    capabilitySummary: reviewer.capabilitySummary,
  };
}

function validateCreateInput(input: CreateMultiAgentDeliberationInput): void {
  if (!input || typeof input !== 'object') throw new MultiAgentCognitionError('Deliberation input is required.');
  requiredText(input.cognitiveStateId, 'Cognitive state id', 120);
  requiredText(input.title, 'Deliberation title', 180);
  requiredText(input.hypothesis, 'Deliberation hypothesis', 1_000);
  sanitizeEvidenceList(input.evidence);
  textList(input.assumptions, 'Deliberation assumptions');
  percent(input.confidence, 'Deliberation confidence');
  sanitizeAction(input.proposedAction);
  textList(input.uncertainty, 'Deliberation uncertainty');
  requestedRoles(input.requestedRoles);
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function sanitizeReviewMessage(value: unknown, deliberation: MultiAgentDeliberation): StructuredReviewMessage {
  const message = record(value, 'Reviewer response');
  const hypothesis = requiredText(message.hypothesis, 'Reviewer hypothesis', 1_000);
  if (normalize(hypothesis) !== normalize(deliberation.hypothesis)) {
    throw new MultiAgentCognitionError('Reviewer response must address the exact recorded hypothesis.');
  }
  const evidenceIds = textList(message.evidenceIds, 'Reviewer evidence references', MAX_EVIDENCE, 120);
  const knownEvidence = new Set(deliberation.evidence.map((evidence) => evidence.id));
  for (const evidenceId of evidenceIds) {
    if (!knownEvidence.has(evidenceId)) throw new MultiAgentCognitionError(`Reviewer referenced evidence ${evidenceId} that is not attached to this deliberation.`);
  }
  const verdict = message.verdict;
  if (typeof verdict !== 'string' || !REVIEW_VERDICTS.has(verdict as ReviewVerdict)) throw new MultiAgentCognitionError('Reviewer verdict is invalid.');
  const proposedAction = sanitizeAction(message.proposedAction);
  const safetyConcerns = optionalTextList(message.safetyConcerns, 'Reviewer safety concerns');
  if ((verdict === 'SAFETY_ESCALATION_RECOMMENDED' || safetyConcerns.length > 0) && !['NO_ACTION', 'ESCALATE_SAFETY'].includes(proposedAction.disposition)) {
    throw new MultiAgentCognitionError('A reviewer safety concern must recommend NO_ACTION or ESCALATE_SAFETY.');
  }
  const claims = optionalClaims(message.claims, knownEvidence);
  return {
    hypothesis,
    evidenceIds,
    assumptions: textList(message.assumptions, 'Reviewer assumptions'),
    confidence: percent(message.confidence, 'Reviewer confidence'),
    proposedAction,
    uncertainty: textList(message.uncertainty, 'Reviewer uncertainty'),
    verdict: verdict as ReviewVerdict,
    conclusionSummary: requiredText(message.conclusionSummary, 'Reviewer conclusion summary', 640),
    claims: claims.length ? claims : undefined,
    safetyConcerns: safetyConcerns.length ? safetyConcerns : undefined,
    consistencyConcerns: optionalTextList(message.consistencyConcerns, 'Reviewer consistency concerns'),
    provenance: sanitizeProvenance(message.provenance),
  };
}

function optionalClaims(value: unknown, knownEvidence: Set<string>): ReviewClaim[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CLAIMS) throw new MultiAgentCognitionError(`Reviewer claims must be an array with at most ${MAX_CLAIMS} items.`);
  return value.map((claim) => {
    const candidate = record(claim, 'Reviewer claim');
    const position = candidate.position;
    if (typeof position !== 'string' || !CLAIM_POSITIONS.has(position as ClaimPosition)) throw new MultiAgentCognitionError('Reviewer claim position is invalid.');
    const evidenceIds = textList(candidate.evidenceIds, 'Reviewer claim evidence references', MAX_EVIDENCE, 120);
    for (const evidenceId of evidenceIds) {
      if (!knownEvidence.has(evidenceId)) throw new MultiAgentCognitionError(`Reviewer claim referenced evidence ${evidenceId} that is not attached to this deliberation.`);
    }
    const uncertainty = candidate.uncertainty === undefined ? undefined : requiredText(candidate.uncertainty, 'Reviewer claim uncertainty', 320);
    return {
      proposition: requiredText(candidate.proposition, 'Reviewer claim proposition', 500),
      position: position as ClaimPosition,
      evidenceIds,
      confidence: percent(candidate.confidence, 'Reviewer claim confidence'),
      uncertainty,
    };
  });
}

function sanitizeEvidenceList(value: unknown): CommercialEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) throw new MultiAgentCognitionError(`Deliberation evidence must be an array with at most ${MAX_EVIDENCE} records.`);
  const ids = new Set<string>();
  return value.map((item) => {
    const evidence = record(item, 'Evidence record');
    const id = requiredText(evidence.id, 'Evidence id', 120);
    if (ids.has(id)) throw new MultiAgentCognitionError(`Duplicate evidence id ${id}.`);
    ids.add(id);
    const status = evidence.status;
    if (typeof status !== 'string' || !EVIDENCE_STATUSES.has(status as CommercialEvidence['status'])) throw new MultiAgentCognitionError('Evidence status is invalid.');
    const validUntil = optionalFinite(evidence.validUntil, 'Evidence validity time');
    return {
      id,
      status: status as CommercialEvidence['status'],
      source: requiredText(evidence.source, 'Evidence source', 180),
      observedAt: finite(evidence.observedAt, 'Evidence observation time'),
      confidence: percent(evidence.confidence, 'Evidence confidence'),
      summary: requiredText(evidence.summary, 'Evidence summary', 640),
      provenance: sanitizeProvenance(evidence.provenance),
      validUntil,
      privacyClassification: privacyClassification(evidence.privacyClassification),
    };
  });
}

function sanitizeAction(value: unknown): CritiqueActionProposal {
  const action = record(value, 'Proposed action');
  const disposition = action.disposition;
  if (typeof disposition !== 'string' || !ACTION_DISPOSITIONS.has(disposition as ReviewActionDisposition)) {
    throw new MultiAgentCognitionError('Proposed action disposition is invalid.');
  }
  return {
    disposition: disposition as ReviewActionDisposition,
    summary: requiredText(action.summary, 'Proposed action summary', 640),
  };
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

function requestedRoles(value: unknown): ReviewerRole[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > REVIEWER_ROLES.size) {
    throw new MultiAgentCognitionError(`At least two and at most ${REVIEWER_ROLES.size} distinct reviewer roles are required.`);
  }
  const roles = value.map((role) => {
    if (typeof role !== 'string' || !REVIEWER_ROLES.has(role as ReviewerRole)) throw new MultiAgentCognitionError('Requested reviewer role is invalid.');
    return role as ReviewerRole;
  });
  if (new Set(roles).size !== roles.length) throw new MultiAgentCognitionError('Requested reviewer roles must be distinct.');
  return roles;
}

function privacyClassification(value: unknown): PrivacyClassification {
  if (value === undefined) return 'INTERNAL';
  if (typeof value !== 'string' || !PRIVACY_CLASSIFICATIONS.has(value as PrivacyClassification)) {
    throw new MultiAgentCognitionError('Privacy classification is invalid.');
  }
  return value as PrivacyClassification;
}

function textList(value: unknown, name: string, maximumItems = MAX_TEXT_LIST, maximumLength = 320): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new MultiAgentCognitionError(`${name} must be an array with at most ${maximumItems} item(s).`);
  }
  return unique(value.map((item) => requiredText(item, name, maximumLength)));
}

function optionalTextList(value: unknown, name: string): string[] {
  return value === undefined ? [] : textList(value, name);
}

function requiredText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new MultiAgentCognitionError(`${name} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) throw new MultiAgentCognitionError(`${name} is required.`);
  return bounded(clean, maximumLength);
}

function optionalText(value: unknown, name: string, maximumLength: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, maximumLength);
}

function percent(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new MultiAgentCognitionError(`${name} must be a finite number from 0 to 100.`);
  }
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MultiAgentCognitionError(`${name} must be finite.`);
  return value;
}

function optionalFinite(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : finite(value, name);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MultiAgentCognitionError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function isSafetyConcern(message: StructuredReviewMessage): boolean {
  return message.verdict === 'SAFETY_ESCALATION_RECOMMENDED' || (message.safetyConcerns?.length ?? 0) > 0 || message.proposedAction.disposition === 'ESCALATE_SAFETY';
}

function opposingVerdicts(first: ReviewVerdict, second: ReviewVerdict): boolean {
  return (first === 'SUPPORTS' && second === 'CHALLENGES') || (first === 'CHALLENGES' && second === 'SUPPORTS');
}

function opposingPositions(first: ClaimPosition, second: ClaimPosition): boolean {
  return (first === 'SUPPORTS' && second === 'CHALLENGES') || (first === 'CHALLENGES' && second === 'SUPPORTS');
}

function actionConflict(first: ReviewActionDisposition, second: ReviewActionDisposition): boolean {
  if (first === second) return false;
  return first === 'GOVERNED_ACTION_CANDIDATE' || second === 'GOVERNED_ACTION_CANDIDATE' || first === 'NO_ACTION' || second === 'NO_ACTION' || first === 'ESCALATE_SAFETY' || second === 'ESCALATE_SAFETY';
}

function normalizeReviewAttempts(value: number | undefined): number {
  const attempts = value ?? 2;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_REVIEW_ATTEMPTS) {
    throw new MultiAgentCognitionError(`Maximum reviewer attempts must be an integer from 1 to ${MAX_REVIEW_ATTEMPTS}.`);
  }
  return attempts;
}

function assertActor(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) {
    throw new MultiAgentCognitionError('A tenant-bound cognitive actor is required.');
  }
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function safeFailureSummary(error: unknown): string {
  const source = error instanceof Error ? error.message : 'Reviewer did not produce a valid result.';
  return bounded(source.replace(/\b(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]'), 280);
}

function sorted<T extends { id: string; createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
