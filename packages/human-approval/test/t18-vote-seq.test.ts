import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CognitiveKernelModule, type CognitiveKernelService } from '@jataqi/cognitive-kernel';
import { ReproducibilityModule } from '@jataqi/reproducibility';
import { ResearchEvidenceModule, type ResearchEvidenceService } from '@jataqi/research-evidence';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import {
  HumanApprovalModule,
  type HumanApprovalService,
  type HumanApprovalVote,
  type HumanReviewerAttestation,
  type SubmitHumanApprovalVoteInput,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

// T-18 per-tenant CAS vote sequencing over real PostgreSQL. Fail-hard: if
// PostgreSQL cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let service: HumanApprovalService;
let cognitive: CognitiveKernelService;
let research: ResearchEvidenceService;

const requester: CommercialActor = { id: 't18-requester', tenantId: 'acme', roles: ['operator'] };
const admin: CommercialActor = { id: 't18-admin', tenantId: 'acme', roles: ['admin'] };

function provenance(source = 't18-test') {
  return { source, collectedAt: Date.now(), correlationId: 't18-correlation' };
}

async function createClaim(as: CommercialActor) {
  const state = await cognitive.createState(as, { scope: 't18 vote-seq state' });
  return research.createClaim(as, {
    domain: 'GENERAL',
    safetyClassification: 'STANDARD',
    hypothesis: 'Concurrent votes must sequence without collision.',
    assumptions: ['Reviewers consider only supplied evidence metadata.'],
    limitations: ['No physical action follows an approval.'],
    provenance: provenance(),
    cognitiveStateId: state.id,
  } as Parameters<ResearchEvidenceService['createClaim']>[1]);
}

async function registerReviewer(asAdmin: CommercialActor, reviewerId: string) {
  return service.registerReviewer(asAdmin, {
    reviewerActorId: reviewerId,
    domainScopes: ['GENERAL'],
    reviewTypes: ['SCIENTIFIC', 'DOMAIN'],
    competencyIds: ['evidence-review', 'domain-analysis'],
    verificationStatus: 'ORGANIZATION_ASSERTED',
    provenance: provenance(),
  });
}

async function createRequest(as: CommercialActor, claimId: string) {
  return service.createRequest(as, {
    claimId,
    purposeSummary: 'T-18 concurrent vote sequencing.',
    requiredReviewTypes: ['SCIENTIFIC', 'DOMAIN'],
    requiredCompetencyIds: ['evidence-review', 'domain-analysis'],
    requiredApprovalCount: 5,
    provenance: provenance(),
  });
}

function voteInput(attestationId: string, tag: string): SubmitHumanApprovalVoteInput {
  const now = Date.now();
  const evidence: CommercialEvidence = {
    id: `t18-${tag}`,
    status: 'VERIFIED',
    source: `source-t18-${tag}`,
    observedAt: now,
    confidence: 90,
    summary: 'T-18 vote evidence.',
    provenance: provenance(),
  };
  return {
    attestationId,
    decision: 'APPROVE',
    reviewTypes: ['SCIENTIFIC', 'DOMAIN'],
    competencyIds: ['evidence-review', 'domain-analysis'],
    rationaleSummary: 'A bounded concurrent review vote was recorded.',
    evidence: [evidence],
    provenance: provenance(),
  };
}

function assertChain(votes: readonly HumanApprovalVote[]): void {
  const sorted = [...votes].sort((a, b) => a.sequence - b.sequence);
  const sequences = sorted.map((v) => v.sequence);
  assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, i) => i + 1));
  assert.equal(sorted[0]?.previousHash, 'GENESIS');
  for (let i = 1; i < sorted.length; i += 1) {
    assert.equal(sorted[i]?.previousHash, sorted[i - 1]?.hash);
  }
}

before(async () => {
  pg = await bootR2Postgres('r2t18', 60000);
  const booted = await bootR2StorageKernel(pg.connectionString);
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: booted.driver }));
  kernel.register(new CognitiveKernelModule());
  kernel.register(new ReproducibilityModule());
  kernel.register(new ResearchEvidenceModule());
  kernel.register(new HumanApprovalModule());
  await kernel.boot();
  cognitive = kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
  research = kernel.getModule<ResearchEvidenceModule>('research-evidence').getService();
  service = kernel.getModule<HumanApprovalModule>('human-approval').getService();
});

after(async () => {
  await pg.stop();
});

describe('T-18 vote sequencing over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('sequences 5 concurrent votes 1..5 with an intact hash chain', async () => {
    const claim = await createClaim(requester);
    const request = await createRequest(requester, claim.id);
    const voters: CommercialActor[] = Array.from({ length: 5 }, (_, i) => ({
      id: `t18-voter-${process.pid}-${i}`,
      tenantId: 'acme',
      roles: ['approver'],
    }));
    const attestations: HumanReviewerAttestation[] = [];
    for (const voter of voters) {
      attestations.push(await registerReviewer(admin, voter.id));
    }
    const results = await Promise.all(
      voters.map((voter, i) =>
        service.submitVote(voter, request.id, voteInput(attestations[i]?.id ?? '', `c1-${i}`)),
      ),
    );
    assert.equal(results.length, 5);
    const votes = await service.listVotes(requester, request.id);
    assert.equal(votes.length, 5);
    // Fresh tenant counter: sequences start at 1 (no other acme votes yet).
    assertChain(votes);
  });

  it('continues the tenant counter across requests and isolates tenants', async () => {
    const claim = await createClaim(requester);
    const request = await createRequest(requester, claim.id);
    const voters: CommercialActor[] = Array.from({ length: 2 }, (_, i) => ({
      id: `t18-voter2-${process.pid}-${i}`,
      tenantId: 'acme',
      roles: ['approver'],
    }));
    const attestations: HumanReviewerAttestation[] = [];
    for (const voter of voters) {
      attestations.push(await registerReviewer(admin, voter.id));
    }
    await Promise.all(
      voters.map((voter, i) =>
        service.submitVote(voter, request.id, voteInput(attestations[i]?.id ?? '', `c2-${i}`)),
      ),
    );
    const votes = await service.listVotes(requester, request.id);
    assert.deepEqual(
      votes.map((v) => v.sequence).sort((a, b) => a - b),
      [6, 7],
      'tenant counter continues across requests (5 prior acme votes)',
    );

    // Other tenant: its own counter starts at 1.
    const otherAdmin: CommercialActor = { id: 't18-other-admin', tenantId: 'other', roles: ['admin'] };
    const otherRequester: CommercialActor = { id: 't18-other-requester', tenantId: 'other', roles: ['operator'] };
    const otherReviewer: CommercialActor = { id: `t18-other-voter-${process.pid}`, tenantId: 'other', roles: ['approver'] };
    const otherClaim = await createClaim(otherRequester);
    const otherRequest = await createRequest(otherRequester, otherClaim.id);
    const otherAttestation = await registerReviewer(otherAdmin, otherReviewer.id);
    await service.submitVote(otherReviewer, otherRequest.id, voteInput(otherAttestation.id, 'other-0'));
    const otherVotes = await service.listVotes(otherRequester, otherRequest.id);
    assert.deepEqual(otherVotes.map((v) => v.sequence), [1]);
    assertChain(otherVotes);
  });
});
