import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { CognitiveKernelModule, type CognitiveKernelService } from '@jataqi/cognitive-kernel';
import { ReproducibilityModule, type ReproducibilityService } from '@jataqi/reproducibility';
import { ResearchEvidenceModule, type ResearchEvidenceService } from '@jataqi/research-evidence';
import { HumanApprovalModule, type HumanApprovalService } from '@jataqi/human-approval';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import {
  RegulatoryGateError,
  RegulatoryGateModule,
  type CreateRegulatoryGateInput,
  type RegulatoryGateService,
} from '../src/index.js';

const requester: CommercialActor = { id: 'regulatory-requester', tenantId: 'acme', roles: ['operator'] };
const admin: CommercialActor = { id: 'regulatory-admin', tenantId: 'acme', roles: ['admin'] };
const reviewer: CommercialActor = { id: 'regulatory-reviewer', tenantId: 'acme', roles: ['approver'] };
const other: CommercialActor = { id: 'other-regulatory-user', tenantId: 'other', roles: ['operator'] };

function provenance(source = 'regulatory-gate-test') {
  return { source, collectedAt: Date.now(), correlationId: 'regulatory-gate-correlation' };
}

function evidence(id: string, source: string, status: CommercialEvidence['status'] = 'MEASURED'): CommercialEvidence {
  const now = Date.now();
  return {
    id,
    source,
    status,
    observedAt: now,
    confidence: 90,
    summary: `Bounded evidence summary for ${id}.`,
    provenance: provenance(source),
  };
}

async function boot(storage: StorageModuleConfig = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule(storage));
  kernel.register(new CognitiveKernelModule());
  kernel.register(new ReproducibilityModule());
  kernel.register(new ResearchEvidenceModule());
  kernel.register(new HumanApprovalModule());
  kernel.register(new RegulatoryGateModule());
  await kernel.boot();
  return {
    kernel,
    cognitive: kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService(),
    reproducibility: kernel.getModule<ReproducibilityModule>('reproducibility').getService(),
    research: kernel.getModule<ResearchEvidenceModule>('research-evidence').getService(),
    approvals: kernel.getModule<HumanApprovalModule>('human-approval').getService(),
    gates: kernel.getModule<RegulatoryGateModule>('regulatory-gates').getService(),
  };
}

async function createClaim(cognitive: CognitiveKernelService, research: ResearchEvidenceService) {
  const state = await cognitive.createState(requester, { scope: 'regulatory gate test state' });
  return research.createClaim(requester, {
    cognitiveStateId: state.id,
    domain: 'GENERAL',
    safetyClassification: 'STANDARD',
    hypothesis: 'The local research claim has supplied evidence for review.',
    assumptions: ['The supplied metadata is within the configured scope.'],
    limitations: ['No physical action follows local gate evaluation.'],
    provenance: provenance(),
  });
}

async function createReproducibleRecord(reproducibility: ReproducibilityService) {
  const input = {
    kind: 'SIMULATION' as const,
    datasetReferences: [{ id: 'dataset-a', version: 'v1', contentHash: 'dataset-hash' }],
    algorithm: { id: 'classical-baseline', version: '1.0.0', contentHash: 'algorithm-hash' },
    environment: { id: 'node', version: '22', contentHash: 'environment-hash' },
    parameters: { samples: 3 },
    deterministic: true,
    output: { result: 'bounded' },
    provenance: provenance('repro-record'),
  };
  const recorded = await reproducibility.record(requester, input);
  await reproducibility.verify(requester, recorded.id, { ...input, provenance: provenance('repro-verification') });
  return recorded.id;
}

async function conditionallySupportedClaim(
  cognitive: CognitiveKernelService,
  reproducibility: ReproducibilityService,
  research: ResearchEvidenceService,
) {
  const claim = await createClaim(cognitive, research);
  const reproducibilityRecordId = await createReproducibleRecord(reproducibility);
  await research.recordEvidence(requester, {
    claimId: claim.id,
    kind: 'MEASUREMENT',
    epistemicStatus: 'OBSERVED',
    summary: 'First supplied strong evidence metadata.',
    methodologySummary: 'High-level measurement summary.',
    limitations: ['First source alone is insufficient.'],
    evidence: [evidence('source-a', 'independent-a')],
    provenance: provenance(),
  });
  await research.recordEvidence(requester, {
    claimId: claim.id,
    kind: 'REPLICATION',
    epistemicStatus: 'OBSERVED',
    summary: 'Second supplied strong reproducibility metadata.',
    methodologySummary: 'High-level replication summary.',
    limitations: ['No physical replication claim is made.'],
    evidence: [evidence('source-b', 'independent-b', 'VERIFIED')],
    reproducibilityRecordIds: [reproducibilityRecordId],
    provenance: provenance(),
  });
  const assessment = await research.assessClaim(requester, claim.id);
  assert.equal(assessment.status, 'CONDITIONALLY_SUPPORTED');
  return { claim, assessment };
}

async function approvedHumanReview(approvals: HumanApprovalService, claimId: string) {
  const attestation = await approvals.registerReviewer(admin, {
    reviewerActorId: reviewer.id,
    domainScopes: ['GENERAL'],
    reviewTypes: ['SCIENTIFIC', 'DOMAIN'],
    competencyIds: ['evidence-review', 'domain-review'],
    verificationStatus: 'ORGANIZATION_ASSERTED',
    provenance: provenance(),
  });
  const request = await approvals.createRequest(requester, {
    claimId,
    purposeSummary: 'Qualified review of supplied local research evidence.',
    requiredReviewTypes: ['SCIENTIFIC', 'DOMAIN'],
    requiredCompetencyIds: ['evidence-review', 'domain-review'],
    requiredApprovalCount: 1,
    provenance: provenance(),
  });
  const result = await approvals.submitVote(reviewer, request.id, {
    attestationId: attestation.id,
    decision: 'APPROVE',
    reviewTypes: ['SCIENTIFIC', 'DOMAIN'],
    competencyIds: ['evidence-review', 'domain-review'],
    rationaleSummary: 'Bounded qualified review of supplied evidence metadata.',
    evidence: [evidence('human-review-evidence', 'human-review-source', 'VERIFIED')],
    provenance: provenance(),
  });
  assert.equal(result.request.status, 'APPROVED');
  return request.id;
}

function localGateInput(overrides: Partial<CreateRegulatoryGateInput> = {}): CreateRegulatoryGateInput {
  return {
    name: 'Local research review gate',
    jurisdictionLabel: 'Configured local review context only',
    regulatoryContextSummary: 'This is a locally configured evidence/review checklist, not legal advice or authority clearance.',
    domainScopes: ['GENERAL'],
    safetyClassifications: ['STANDARD'],
    requirements: [
      { id: 'assessment', kind: 'RESEARCH_ASSESSMENT', label: 'Conditionally supported assessment', rationaleSummary: 'Require a local conditionally-supported assessment.', acceptedAssessmentStatuses: ['CONDITIONALLY_SUPPORTED'] },
      { id: 'evidence', kind: 'INDEPENDENT_EVIDENCE', label: 'Independent evidence', rationaleSummary: 'Require independent current strong evidence sources.', minimumIndependentStrongSources: 2 },
      { id: 'reproducibility', kind: 'REPRODUCIBILITY', label: 'Reproducibility', rationaleSummary: 'Require linked reproducibility metadata.' },
      { id: 'human', kind: 'HUMAN_APPROVAL', label: 'Qualified human review', rationaleSummary: 'Require configured human-review coverage.', requiredHumanReviewTypes: ['SCIENTIFIC', 'DOMAIN'], minimumApprovedRequests: 1 },
      { id: 'documentation', kind: 'DOCUMENTATION_REFERENCE', label: 'Documentation reference', rationaleSummary: 'Require a supplied documentation reference.' },
    ],
    provenance: provenance(),
    ...overrides,
  };
}

describe('local regulatory gate foundation', () => {
  it('evaluates configured local evidence/reproducibility/human/documentation requirements without claiming compliance or physical authorization', async () => {
    const { kernel, cognitive, reproducibility, research, approvals, gates } = await boot();
    try {
      const { claim, assessment } = await conditionallySupportedClaim(cognitive, reproducibility, research);
      const approvalRequestId = await approvedHumanReview(approvals, claim.id);
      const gate = await gates.createGate(admin, localGateInput());
      await assert.rejects(() => gates.evaluate(requester, { gateId: gate.id, claimId: claim.id, provenance: provenance() }), RegulatoryGateError);
      await gates.activateGate(admin, gate.id);
      const evaluation = await gates.evaluate(requester, {
        gateId: gate.id,
        claimId: claim.id,
        assessmentId: assessment.id,
        approvalRequestIds: [approvalRequestId],
        documentationReferences: ['document:local-review-v1'],
        provenance: provenance(),
      });
      assert.equal(evaluation.status, 'SATISFIED_FOR_REVIEW');
      assert.equal(evaluation.localRequirementsSatisfied, true);
      assert.equal(evaluation.isComplianceCertification, false);
      assert.equal(evaluation.physicalExecutionAuthorization, 'NOT_AUTHORIZED');
      assert.equal(evaluation.checks.every((check) => check.state === 'SATISFIED'), true);
    } finally {
      await kernel.shutdown();
    }
  });

  it('keeps an external regulatory confirmation requirement pending rather than fabricating authority clearance', async () => {
    const { kernel, cognitive, research, gates } = await boot();
    try {
      const claim = await createClaim(cognitive, research);
      const gate = await gates.createGate(admin, localGateInput({
        name: 'External confirmation gate',
        requirements: [{ id: 'authority', kind: 'EXTERNAL_REGULATORY_CONFIRMATION', label: 'External authority confirmation', rationaleSummary: 'Do not assume a local record proves external confirmation.' }],
      }));
      await gates.activateGate(admin, gate.id);
      const evaluation = await gates.evaluate(requester, { gateId: gate.id, claimId: claim.id, provenance: provenance() });
      assert.equal(evaluation.status, 'PENDING_EXTERNAL_VERIFICATION');
      assert.equal(evaluation.externalRegulatoryVerificationPending, true);
      assert.equal(evaluation.localRequirementsSatisfied, true);
      assert.match(evaluation.checks[0]?.summary ?? '', /no authority connector/i);
      assert.equal(evaluation.isComplianceCertification, false);
    } finally {
      await kernel.shutdown();
    }
  });

  it('reports missing configured human review as pending rather than accepting a synthetic approval', async () => {
    const { kernel, cognitive, research, gates } = await boot();
    try {
      const claim = await createClaim(cognitive, research);
      const gate = await gates.createGate(admin, localGateInput({
        name: 'Human review required gate',
        requirements: [{ id: 'human', kind: 'HUMAN_APPROVAL', label: 'Human review', rationaleSummary: 'Require a real recorded local human review.', requiredHumanReviewTypes: ['SAFETY'], minimumApprovedRequests: 1 }],
      }));
      await gates.activateGate(admin, gate.id);
      const evaluation = await gates.evaluate(requester, { gateId: gate.id, claimId: claim.id, provenance: provenance() });
      assert.equal(evaluation.status, 'PENDING_HUMAN_REVIEW');
      assert.equal(evaluation.approvedHumanReviewCount, 0);
      assert.equal(evaluation.checks[0]?.state, 'PENDING_HUMAN_REVIEW');
    } finally {
      await kernel.shutdown();
    }
  });

  it('requires administrator-managed templates and preserves gate/evaluation isolation and audit integrity across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-regulatory-gates-'));
    try {
      const first = await boot({ driver: 'filesystem', fsRoot: root });
      const claim = await createClaim(first.cognitive, first.research);
      await assert.rejects(() => first.gates.createGate(requester, localGateInput()), RegulatoryGateError);
      const gate = await first.gates.createGate(admin, localGateInput({
        name: 'Persistent external confirmation gate',
        requirements: [{ id: 'authority', kind: 'EXTERNAL_REGULATORY_CONFIRMATION', label: 'External confirmation', rationaleSummary: 'Local system cannot verify an authority.' }],
      }));
      await first.gates.activateGate(admin, gate.id);
      const evaluation = await first.gates.evaluate(requester, { gateId: gate.id, claimId: claim.id, provenance: provenance() });
      assert.deepEqual(await first.gates.verifyIntegrity(requester), { tenantId: 'acme', valid: true, evaluationCount: 1 });
      await first.kernel.shutdown();

      const second = await boot({ driver: 'filesystem', fsRoot: root });
      assert.equal((await second.gates.getGate(requester, gate.id))?.status, 'ACTIVE');
      assert.equal((await second.gates.getEvaluation(requester, evaluation.id))?.hash, evaluation.hash);
      assert.equal(await second.gates.getGate(other, gate.id), undefined);
      assert.equal(await second.gates.getEvaluation(other, evaluation.id), undefined);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
