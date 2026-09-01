import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { CognitiveKernelModule, type CognitiveKernelService } from '@jataqi/cognitive-kernel';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import {
  MultiAgentCognitionError,
  MultiAgentCognitionModule,
  type CreateMultiAgentDeliberationInput,
  type MultiAgentCognitionService,
  type MultiAgentReviewer,
  type ReviewerRole,
  type StructuredReviewMessage,
} from '../src/index.js';

const actor: CommercialActor = { id: 'researcher', tenantId: 'acme', roles: ['operator'] };
const other: CommercialActor = { id: 'other-researcher', tenantId: 'other', roles: ['operator'] };
const hypothesis = 'The observed activation change is explained by onboarding friction.';

function provenance(source = 'multi-agent-test') {
  return { source, collectedAt: Date.now(), correlationId: 'multi-agent-correlation' };
}

function evidence(
  id: string,
  source: string,
  status: CommercialEvidence['status'] = 'MEASURED',
  overrides: Partial<CommercialEvidence> = {},
): CommercialEvidence {
  const now = Date.now();
  return {
    id,
    status,
    source,
    observedAt: now,
    confidence: 90,
    summary: `Concise ${status.toLowerCase()} evidence summary for ${id}.`,
    provenance: provenance(source),
    ...overrides,
  };
}

function reviewMessage(overrides: Partial<StructuredReviewMessage> = {}): StructuredReviewMessage {
  return {
    hypothesis,
    evidenceIds: ['study-a', 'study-b'],
    assumptions: ['The supplied cohort definition is stable.'],
    confidence: 70,
    proposedAction: { disposition: 'GATHER_EVIDENCE', summary: 'Collect independently measured follow-up evidence.' },
    uncertainty: ['The observed period may not generalize.'],
    verdict: 'INCONCLUSIVE',
    conclusionSummary: 'The evidence is retained for structured review without being promoted to a fact.',
    provenance: provenance('injected-test-reviewer'),
    ...overrides,
  };
}

function reviewer(
  id: string,
  role: ReviewerRole,
  response: StructuredReviewMessage | ((request: Parameters<MultiAgentReviewer['review']>[0]) => StructuredReviewMessage | Promise<StructuredReviewMessage>),
): MultiAgentReviewer {
  return {
    id,
    role,
    label: `Deterministic ${role}`,
    capabilitySummary: 'Isolated deterministic test reviewer; no external service or action invocation.',
    review: async (request) => typeof response === 'function' ? response(request) : response,
  };
}

async function boot(reviewers: MultiAgentReviewer[] = [], storage: StorageModuleConfig = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule(storage));
  kernel.register(new CognitiveKernelModule());
  kernel.register(new MultiAgentCognitionModule({ reviewers }));
  await kernel.boot();
  return {
    kernel,
    cognitive: kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService(),
    service: kernel.getModule<MultiAgentCognitionModule>('multi-agent-cognition').getService(),
  };
}

async function createDeliberation(
  cognitive: CognitiveKernelService,
  service: MultiAgentCognitionService,
  overrides: Partial<CreateMultiAgentDeliberationInput> = {},
) {
  const state = await cognitive.createState(actor, { scope: 'multi-agent critique test state' });
  const input: CreateMultiAgentDeliberationInput = {
    title: 'Activation-friction critique',
    hypothesis,
    evidence: [evidence('study-a', 'independent-source-a'), evidence('study-b', 'independent-source-b', 'VERIFIED')],
    assumptions: ['The measurement window is representative.'],
    confidence: 65,
    proposedAction: { disposition: 'GATHER_EVIDENCE', summary: 'Request a bounded follow-up measurement.' },
    uncertainty: ['Unmeasured cohort changes may confound the result.'],
    requestedRoles: ['RESEARCH_AGENT', 'CRITIC_AGENT'],
    provenance: provenance(),
    ...overrides,
    // Tests cannot replace this tenant-bound state reference through overrides.
    cognitiveStateId: state.id,
  };
  return service.createDeliberation(actor, input);
}

describe('JQB multi-agent cognition', () => {
  it('does not fabricate a reviewer, model output, or action when the default reviewer registry is empty', async () => {
    const { kernel, cognitive, service } = await boot();
    try {
      const deliberation = await createDeliberation(cognitive, service);
      assert.deepEqual(service.listReviewers(), []);
      const run = await service.runRequestedReviews(actor, deliberation.id);
      assert.equal(run.reviews.length, 0);
      assert.deepEqual(run.unavailableRoles, ['RESEARCH_AGENT', 'CRITIC_AGENT']);

      const synthesis = await service.synthesize(actor, deliberation.id);
      assert.equal(synthesis.status, 'INSUFFICIENT_EVIDENCE');
      assert.equal(synthesis.recommendation, 'GATHER_EVIDENCE');
      assert.equal(synthesis.executionAuthorization, 'NOT_AUTHORIZED');
      assert.equal(synthesis.hypothesisStatus, 'RETAINED_AS_HYPOTHESIS');
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists structured positions and retains reviewer/claim/action disagreement rather than collapsing it into a fact', async () => {
    const researchResponse: StructuredReviewMessage & { hiddenChainOfThought: string } = {
      ...reviewMessage({
        verdict: 'SUPPORTS',
        proposedAction: { disposition: 'GATHER_EVIDENCE', summary: 'Gather a further independent measurement.' },
        claims: [{ proposition: 'Onboarding friction explains the change.', position: 'SUPPORTS', evidenceIds: ['study-a'], confidence: 75 }],
        conclusionSummary: 'A supporting interpretation is conditionally plausible under the recorded assumptions.',
      }),
      // Extra non-contract material must not be persisted by the structured boundary.
      hiddenChainOfThought: 'This must never enter the audit record.',
    };
    const research = reviewer('research-reviewer', 'RESEARCH_AGENT', researchResponse);
    const critic = reviewer('critic-reviewer', 'CRITIC_AGENT', reviewMessage({
      verdict: 'CHALLENGES',
      proposedAction: { disposition: 'NO_ACTION', summary: 'Do not act until confounders are measured.' },
      claims: [{ proposition: 'Onboarding friction explains the change.', position: 'CHALLENGES', evidenceIds: ['study-b'], confidence: 80 }],
      conclusionSummary: 'The current evidence has plausible confounders and does not establish the hypothesis.',
    }));
    const { kernel, cognitive, service } = await boot([research, critic]);
    try {
      const deliberation = await createDeliberation(cognitive, service);
      const run = await service.runRequestedReviews(actor, deliberation.id);
      assert.equal(run.reviews.length, 2);
      assert.deepEqual(run.unavailableRoles, []);
      const repeated = await service.runReview(actor, deliberation.id, 'research-reviewer');
      assert.equal(repeated.id, run.reviews[0]?.id, 'completed reviewers are idempotent');

      const reviews = await service.listReviews(actor, deliberation.id);
      assert.equal(reviews.length, 2);
      assert.equal(JSON.stringify(reviews).includes('hiddenChainOfThought'), false);
      assert.equal(JSON.stringify(reviews).includes('This must never enter'), false);
      const disagreements = await service.listDisagreements(actor, deliberation.id);
      assert.ok(disagreements.some((item) => item.kind === 'HYPOTHESIS_POSITION_CONFLICT'));
      assert.ok(disagreements.some((item) => item.kind === 'CLAIM_POSITION_CONFLICT'));
      assert.ok(disagreements.some((item) => item.kind === 'ACTION_RECOMMENDATION_CONFLICT'));

      const synthesis = await service.synthesize(actor, deliberation.id);
      assert.equal(synthesis.status, 'DISAGREEMENT_UNRESOLVED');
      assert.equal(synthesis.recommendation, 'REQUEST_HUMAN_REVIEW');
      assert.equal(synthesis.executionAuthorization, 'NOT_AUTHORIZED');
      assert.match(synthesis.conclusionSummary, /does not collapse/i);
    } finally {
      await kernel.shutdown();
    }
  });

  it('classifies stale, uncertain, and conflicting evidence explicitly instead of treating it as decision support', async () => {
    const { kernel, cognitive, service } = await boot();
    try {
      const deliberation = await createDeliberation(cognitive, service, {
        evidence: [
          evidence('expired-measurement', 'source-a', 'MEASURED', { validUntil: Date.now() - 1 }),
          evidence('forecast', 'source-b', 'PREDICTION'),
          evidence('conflict', 'source-c', 'CONFLICTING'),
        ],
      });
      const check = await service.checkEvidence(actor, deliberation.id);
      assert.equal(check.sufficientForDecisionSupport, false);
      assert.equal(check.quality, 'MIXED');
      assert.deepEqual(check.staleEvidenceIds, ['expired-measurement']);
      assert.deepEqual(check.uncertainEvidenceIds, ['forecast']);
      assert.deepEqual(check.conflictingEvidenceIds, ['conflict']);
      assert.ok(check.issues.some((issue) => /stale/i.test(issue)));
      assert.ok(check.issues.some((issue) => /conflict/i.test(issue)));
    } finally {
      await kernel.shutdown();
    }
  });

  it('turns a safety reviewer finding into an advisory escalation with no direct action authorization', async () => {
    const safety = reviewer('safety-reviewer', 'SAFETY_AGENT', reviewMessage({
      verdict: 'SAFETY_ESCALATION_RECOMMENDED',
      proposedAction: { disposition: 'ESCALATE_SAFETY', summary: 'Obtain qualified human safety review before considering any action.' },
      safetyConcerns: ['The proposed action boundary is insufficiently specified.'],
      conclusionSummary: 'Safety review requires human escalation; no operational action is recommended.',
    }));
    const redTeam = reviewer('red-team-reviewer', 'RED_TEAM_AGENT', reviewMessage({
      verdict: 'INCONCLUSIVE',
      proposedAction: { disposition: 'NO_ACTION', summary: 'Do not proceed while safety scope remains unresolved.' },
      conclusionSummary: 'Red-team review cannot rule out boundary failures from the supplied summaries.',
    }));
    const { kernel, cognitive, service } = await boot([safety, redTeam]);
    try {
      const deliberation = await createDeliberation(cognitive, service, {
        requestedRoles: ['SAFETY_AGENT', 'RED_TEAM_AGENT'],
        proposedAction: { disposition: 'GOVERNED_ACTION_CANDIDATE', summary: 'A non-executing candidate for separate governance review.' },
      });
      await service.runRequestedReviews(actor, deliberation.id);
      const safetyAssessment = await service.assessSafety(actor, deliberation.id);
      assert.equal(safetyAssessment.status, 'ESCALATION_RECOMMENDED');
      assert.equal(safetyAssessment.recommendation, 'NO_ACTION');
      assert.equal(safetyAssessment.doesNotAuthorizeAction, true);
      const synthesis = await service.synthesize(actor, deliberation.id);
      assert.equal(synthesis.status, 'SAFETY_ESCALATION');
      assert.equal(synthesis.recommendation, 'ESCALATE_SAFETY');
      assert.equal(synthesis.executionAuthorization, 'NOT_AUTHORIZED');
    } finally {
      await kernel.shutdown();
    }
  });

  it('does not ignore an explicit safety escalation merely because it was surfaced by a non-safety reviewer', async () => {
    const research = reviewer('research-safety-escalation', 'RESEARCH_AGENT', reviewMessage({
      verdict: 'SAFETY_ESCALATION_RECOMMENDED',
      proposedAction: { disposition: 'ESCALATE_SAFETY', summary: 'Escalate to qualified safety review.' },
      safetyConcerns: ['The supplied boundary leaves a material safety question unresolved.'],
    }));
    const critic = reviewer('critic-no-concern', 'CRITIC_AGENT', reviewMessage({
      verdict: 'INCONCLUSIVE',
      proposedAction: { disposition: 'NO_ACTION', summary: 'No action while the safety question remains unresolved.' },
    }));
    const { kernel, cognitive, service } = await boot([research, critic]);
    try {
      const deliberation = await createDeliberation(cognitive, service);
      await service.runRequestedReviews(actor, deliberation.id);
      const safetyAssessment = await service.assessSafety(actor, deliberation.id);
      assert.equal(safetyAssessment.status, 'ESCALATION_RECOMMENDED');
      assert.deepEqual(safetyAssessment.safetyReviewerRoles, []);
      assert.equal((await service.synthesize(actor, deliberation.id)).status, 'SAFETY_ESCALATION');
    } finally {
      await kernel.shutdown();
    }
  });

  it('records malformed injected output as a bounded failed review and enforces tenant isolation', async () => {
    const invalid = reviewer('invalid-reviewer', 'RESEARCH_AGENT', reviewMessage({ evidenceIds: ['not-attached'] }));
    const critic = reviewer('valid-critic', 'CRITIC_AGENT', reviewMessage({ verdict: 'INCONCLUSIVE' }));
    const { kernel, cognitive, service } = await boot([invalid, critic]);
    try {
      const deliberation = await createDeliberation(cognitive, service);
      const failed = await service.runReview(actor, deliberation.id, 'invalid-reviewer');
      assert.equal(failed.state, 'FAILED');
      assert.equal(failed.failureCode, 'INVALID_RESPONSE');
      assert.match(failed.failureSummary ?? '', /not attached/i);
      assert.equal(await service.getDeliberation(other, deliberation.id), undefined);
      await assert.rejects(() => service.listReviews(other, deliberation.id), MultiAgentCognitionError);
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists deliberations, structured reviews, and non-authorizing synthesis across a filesystem restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-multi-agent-cognition-'));
    const research = reviewer('persistent-research', 'RESEARCH_AGENT', reviewMessage({ verdict: 'SUPPORTS' }));
    const critic = reviewer('persistent-critic', 'CRITIC_AGENT', reviewMessage({ verdict: 'SUPPORTS' }));
    try {
      const first = await boot([research, critic], { driver: 'filesystem', fsRoot: root });
      const deliberation = await createDeliberation(first.cognitive, first.service);
      await first.service.runRequestedReviews(actor, deliberation.id);
      const synthesis = await first.service.synthesize(actor, deliberation.id);
      assert.equal(synthesis.status, 'HYPOTHESIS_CONDITIONALLY_SUPPORTED');
      await first.kernel.shutdown();

      const second = await boot([research, critic], { driver: 'filesystem', fsRoot: root });
      const restored = await second.service.getDeliberation(actor, deliberation.id);
      assert.equal(restored?.latestSynthesisId, synthesis.id);
      assert.equal((await second.service.listReviews(actor, deliberation.id)).length, 2);
      assert.equal((await second.service.listSyntheses(actor, deliberation.id))[0]?.executionAuthorization, 'NOT_AUTHORIZED');
      assert.equal(await second.service.getDeliberation(other, deliberation.id), undefined);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
