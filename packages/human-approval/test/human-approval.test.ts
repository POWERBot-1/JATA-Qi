import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { CognitiveKernelModule, type CognitiveKernelService } from '@jataqi/cognitive-kernel';
import { ReproducibilityModule } from '@jataqi/reproducibility';
import { ResearchEvidenceModule, type ResearchEvidenceService } from '@jataqi/research-evidence';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import {
  HumanApprovalError,
  HumanApprovalModule,
  type HumanApprovalConfig,
  type HumanApprovalService,
  type SubmitHumanApprovalVoteInput,
} from '../src/index.js';

const requester: CommercialActor = { id: 'research-requester', tenantId: 'acme', roles: ['operator'] };
const admin: CommercialActor = { id: 'research-admin', tenantId: 'acme', roles: ['admin'] };
const scientificReviewer: CommercialActor = { id: 'scientific-reviewer', tenantId: 'acme', roles: ['approver'] };
const safetyReviewer: CommercialActor = { id: 'safety-reviewer', tenantId: 'acme', roles: ['approver'] };
const regulatoryReviewer: CommercialActor = { id: 'regulatory-reviewer', tenantId: 'acme', roles: ['approver'] };
const other: CommercialActor = { id: 'other', tenantId: 'other', roles: ['approver'] };

function provenance(source = 'human-approval-test') {
  return { source, collectedAt: Date.now(), correlationId: 'human-approval-correlation' };
}

function evidence(id: string, status: CommercialEvidence['status'] = 'MEASURED'): CommercialEvidence {
  const now = Date.now();
  return {
    id,
    status,
    source: `source-${id}`,
    observedAt: now,
    confidence: 90,
    summary: `Bounded approval evidence summary for ${id}.`,
    provenance: provenance(`source-${id}`),
  };
}

async function boot(options: { storage?: StorageModuleConfig; config?: HumanApprovalConfig } = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule(options.storage));
  kernel.register(new CognitiveKernelModule());
  kernel.register(new ReproducibilityModule());
  kernel.register(new ResearchEvidenceModule());
  kernel.register(new HumanApprovalModule(options.config));
  await kernel.boot();
  return {
    kernel,
    cognitive: kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService(),
    research: kernel.getModule<ResearchEvidenceModule>('research-evidence').getService(),
    service: kernel.getModule<HumanApprovalModule>('human-approval').getService(),
  };
}

async function createClaim(
  cognitive: CognitiveKernelService,
  research: ResearchEvidenceService,
  overrides: Record<string, unknown> = {},
) {
  const state = await cognitive.createState(requester, { scope: 'human approval test state' });
  return research.createClaim(requester, {
    domain: 'GENERAL',
    safetyClassification: 'STANDARD',
    hypothesis: 'A bounded research claim needs qualified human review.',
    assumptions: ['Reviewers consider only supplied evidence metadata.'],
    limitations: ['No physical action follows an approval.'],
    provenance: provenance(),
    ...overrides,
    cognitiveStateId: state.id,
  } as Parameters<ResearchEvidenceService['createClaim']>[1]);
}

async function registerScientificReviewer(service: HumanApprovalService, actor = scientificReviewer) {
  return service.registerReviewer(admin, {
    reviewerActorId: actor.id,
    domainScopes: ['GENERAL'],
    reviewTypes: ['SCIENTIFIC', 'DOMAIN'],
    competencyIds: ['evidence-review', 'domain-analysis'],
    verificationStatus: 'ORGANIZATION_ASSERTED',
    provenance: provenance(),
  });
}

async function standardRequest(service: HumanApprovalService, claimId: string) {
  return service.createRequest(requester, {
    claimId,
    purposeSummary: 'Request bounded human review of supplied research metadata.',
    requiredReviewTypes: ['SCIENTIFIC', 'DOMAIN'],
    requiredCompetencyIds: ['evidence-review', 'domain-analysis'],
    requiredApprovalCount: 1,
    provenance: provenance(),
  });
}

function voteInput(attestationId: string, overrides: Partial<SubmitHumanApprovalVoteInput> = {}): SubmitHumanApprovalVoteInput {
  return {
    attestationId,
    decision: 'APPROVE',
    reviewTypes: ['SCIENTIFIC', 'DOMAIN'],
    competencyIds: ['evidence-review', 'domain-analysis'],
    rationaleSummary: 'A bounded human review of the supplied evidence metadata was recorded.',
    evidence: [evidence(`vote-${attestationId}`, 'VERIFIED')],
    provenance: provenance(),
    ...overrides,
  };
}

describe('research human approval foundation', () => {
  it('requires an attested, non-requestor human reviewer and records quorum approval without physical authorization', async () => {
    const { kernel, cognitive, research, service } = await boot();
    try {
      const claim = await createClaim(cognitive, research);
      const attestation = await registerScientificReviewer(service);
      const request = await standardRequest(service, claim.id);
      const requesterWithApproverRole: CommercialActor = { ...requester, roles: ['operator', 'approver'] };
      await assert.rejects(() => service.submitVote(requesterWithApproverRole, request.id, voteInput(attestation.id)), HumanApprovalError);
      const result = await service.submitVote(scientificReviewer, request.id, voteInput(attestation.id));
      assert.equal(result.request.status, 'APPROVED');
      assert.equal(result.progress.quorumSatisfied, true);
      assert.deepEqual(result.progress.missingReviewTypes, []);
      assert.deepEqual(result.progress.missingCompetencyIds, []);
      assert.equal(result.progress.doesNotAuthorizePhysicalExecution, true);
      assert.equal((await service.listVotes(requester, request.id)).length, 1);
    } finally {
      await kernel.shutdown();
    }
  });

  it('requires linked regulated assessment, organization-asserted reviewers, safety/regulatory coverage, and two distinct approvals', async () => {
    const { kernel, cognitive, research, service } = await boot();
    try {
      const claim = await createClaim(cognitive, research, { domain: 'MEDICAL', safetyClassification: 'REGULATED_OR_HAZARDOUS' });
      const assessment = await research.assessClaim(requester, claim.id);
      await assert.rejects(() => service.createRequest(requester, {
        claimId: claim.id,
        purposeSummary: 'Invalid under-specified regulated review.',
        requiredReviewTypes: ['SAFETY'],
        requiredCompetencyIds: ['safety-review'],
        requiredApprovalCount: 1,
        provenance: provenance(),
      }), HumanApprovalError);
      const declared = await service.registerReviewer(admin, {
        reviewerActorId: 'declared-safety-reviewer', domainScopes: ['MEDICAL'], reviewTypes: ['SAFETY'], competencyIds: ['safety-review'], verificationStatus: 'DECLARED', provenance: provenance(),
      });
      const safety = await service.registerReviewer(admin, {
        reviewerActorId: safetyReviewer.id, domainScopes: ['MEDICAL'], reviewTypes: ['SAFETY'], competencyIds: ['safety-review'], verificationStatus: 'ORGANIZATION_ASSERTED', provenance: provenance(),
      });
      const regulatory = await service.registerReviewer(admin, {
        reviewerActorId: regulatoryReviewer.id, domainScopes: ['MEDICAL'], reviewTypes: ['REGULATORY'], competencyIds: ['regulatory-review'], verificationStatus: 'ORGANIZATION_ASSERTED', provenance: provenance(),
      });
      const request = await service.createRequest(requester, {
        claimId: claim.id,
        assessmentId: assessment.id,
        purposeSummary: 'Qualified human and regulatory review of a regulated research claim.',
        requiredReviewTypes: ['SAFETY', 'REGULATORY'],
        requiredCompetencyIds: ['safety-review', 'regulatory-review'],
        requiredApprovalCount: 2,
        provenance: provenance(),
      });
      const declaredReviewer: CommercialActor = { id: 'declared-safety-reviewer', tenantId: 'acme', roles: ['approver'] };
      await assert.rejects(() => service.submitVote(declaredReviewer, request.id, voteInput(declared.id, {
        reviewTypes: ['SAFETY'], competencyIds: ['safety-review'],
      })), HumanApprovalError);
      await assert.rejects(() => service.submitVote(safetyReviewer, request.id, voteInput(safety.id, {
        reviewTypes: ['SAFETY'], competencyIds: ['safety-review'], evidence: [evidence('weak-regulated-vote', 'PREDICTION')],
      })), HumanApprovalError);
      const first = await service.submitVote(safetyReviewer, request.id, voteInput(safety.id, {
        reviewTypes: ['SAFETY'], competencyIds: ['safety-review'],
      }));
      assert.equal(first.request.status, 'PENDING');
      const second = await service.submitVote(regulatoryReviewer, request.id, voteInput(regulatory.id, {
        reviewTypes: ['REGULATORY'], competencyIds: ['regulatory-review'],
      }));
      assert.equal(second.request.status, 'APPROVED');
      assert.equal(second.progress.approvedVoteCount, 2);
      assert.deepEqual(second.progress.coveredReviewTypes, ['REGULATORY', 'SAFETY']);
      assert.equal(second.progress.doesNotAuthorizePhysicalExecution, true);
    } finally {
      await kernel.shutdown();
    }
  });

  it('retains a rejection as a terminal request state rather than accepting later votes', async () => {
    const { kernel, cognitive, research, service } = await boot();
    try {
      const claim = await createClaim(cognitive, research);
      const attestation = await registerScientificReviewer(service);
      const request = await standardRequest(service, claim.id);
      const rejected = await service.submitVote(scientificReviewer, request.id, voteInput(attestation.id, {
        decision: 'REJECT', rationaleSummary: 'The supplied evidence metadata is insufficient for this review request.',
      }));
      assert.equal(rejected.request.status, 'REJECTED');
      assert.equal(rejected.progress.rejectedVoteCount, 1);
      await assert.rejects(() => service.submitVote(scientificReviewer, request.id, voteInput(attestation.id)), HumanApprovalError);
    } finally {
      await kernel.shutdown();
    }
  });

  it('requires explicit expiry refresh and does not allow a vote after expiration', async () => {
    let now = 1_000;
    const { kernel, cognitive, research, service } = await boot({ config: { now: () => now } });
    try {
      const claim = await createClaim(cognitive, research);
      const attestation = await registerScientificReviewer(service);
      const request = await service.createRequest(requester, {
        claimId: claim.id,
        purposeSummary: 'A request with a bounded expiry.',
        requiredReviewTypes: ['SCIENTIFIC'],
        requiredCompetencyIds: ['evidence-review'],
        expiresAt: 2_000,
        provenance: provenance(),
      });
      now = 2_000;
      assert.equal((await service.refreshRequest(requester, request.id)).status, 'EXPIRED');
      await assert.rejects(() => service.submitVote(scientificReviewer, request.id, voteInput(attestation.id, {
        reviewTypes: ['SCIENTIFIC'], competencyIds: ['evidence-review'],
      })), HumanApprovalError);
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists reviewer/request/vote audit records across restart, verifies the local chain, and enforces tenant isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-human-approval-'));
    try {
      const first = await boot({ storage: { driver: 'filesystem', fsRoot: root } });
      const claim = await createClaim(first.cognitive, first.research);
      const attestation = await registerScientificReviewer(first.service);
      const request = await standardRequest(first.service, claim.id);
      const result = await first.service.submitVote(scientificReviewer, request.id, voteInput(attestation.id));
      assert.equal(result.request.status, 'APPROVED');
      assert.deepEqual(await first.service.verifyIntegrity(requester), { tenantId: 'acme', valid: true, voteCount: 1 });
      await first.kernel.shutdown();

      const second = await boot({ storage: { driver: 'filesystem', fsRoot: root } });
      assert.equal((await second.service.getRequest(requester, request.id))?.status, 'APPROVED');
      assert.equal((await second.service.listVotes(requester, request.id))[0]?.hash, result.vote.hash);
      assert.equal(await second.service.getRequest(other, request.id), undefined);
      await assert.rejects(() => second.service.listVotes(other, request.id), HumanApprovalError);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
