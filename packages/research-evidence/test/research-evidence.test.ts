import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { CognitiveKernelModule, type CognitiveKernelService } from '@jataqi/cognitive-kernel';
import { ReproducibilityModule, type ReproducibilityService } from '@jataqi/reproducibility';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import {
  ResearchEvidenceError,
  ResearchEvidenceModule,
  type ResearchEvidenceService,
} from '../src/index.js';

const actor: CommercialActor = { id: 'research-evidence-user', tenantId: 'acme', roles: ['operator'] };
const other: CommercialActor = { id: 'other-research-evidence-user', tenantId: 'other', roles: ['operator'] };

function provenance(source = 'research-evidence-test') {
  return { source, collectedAt: Date.now(), correlationId: 'research-evidence-correlation' };
}

function evidence(id: string, source: string, status: CommercialEvidence['status'] = 'MEASURED'): CommercialEvidence {
  const now = Date.now();
  return {
    id,
    source,
    status,
    observedAt: now,
    confidence: 90,
    summary: `Bounded ${status.toLowerCase()} research evidence summary for ${id}.`,
    provenance: provenance(source),
  };
}

async function boot(storage: StorageModuleConfig = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule(storage));
  kernel.register(new CognitiveKernelModule());
  kernel.register(new ReproducibilityModule());
  kernel.register(new ResearchEvidenceModule());
  await kernel.boot();
  return {
    kernel,
    cognitive: kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService(),
    reproducibility: kernel.getModule<ReproducibilityModule>('reproducibility').getService(),
    service: kernel.getModule<ResearchEvidenceModule>('research-evidence').getService(),
  };
}

async function createClaim(
  cognitive: CognitiveKernelService,
  service: ResearchEvidenceService,
  overrides: Record<string, unknown> = {},
) {
  const state = await cognitive.createState(actor, { scope: 'research evidence test state' });
  return service.createClaim(actor, {
    domain: 'GENERAL',
    safetyClassification: 'STANDARD',
    hypothesis: 'The supplied evidence supports a bounded research hypothesis.',
    assumptions: ['The referenced sources are applicable to the scoped hypothesis.'],
    limitations: ['The registry does not execute or independently validate source work.'],
    provenance: provenance(),
    ...overrides,
    cognitiveStateId: state.id,
  } as Parameters<ResearchEvidenceService['createClaim']>[1]);
}

async function reproducibleRecord(service: ReproducibilityService) {
  const input = {
    kind: 'SIMULATION' as const,
    datasetReferences: [{ id: 'dataset-a', version: 'v1', contentHash: 'dataset-hash' }],
    algorithm: { id: 'classical-baseline', version: '1.0.0', contentHash: 'algorithm-hash' },
    environment: { id: 'node', version: '22', contentHash: 'environment-hash' },
    parameters: { iterations: 10 },
    deterministic: true,
    output: { result: 'bounded' },
    provenance: provenance('reproducibility-record'),
  };
  const record = await service.record(actor, input);
  await service.verify(actor, record.id, {
    ...input,
    provenance: provenance('reproducibility-verification'),
  });
  return record.id;
}

describe('research evidence foundation', () => {
  it('records high-level evidence metadata and conditionally supports only independently strong evidence with a linked reproducible record', async () => {
    const { kernel, cognitive, reproducibility, service } = await boot();
    try {
      const claim = await createClaim(cognitive, service);
      const reproducibilityRecordId = await reproducibleRecord(reproducibility);
      await service.recordEvidence(actor, {
        claimId: claim.id,
        kind: 'MEASUREMENT',
        epistemicStatus: 'OBSERVED',
        summary: 'A bounded measurement summary was supplied.',
        methodologySummary: 'High-level measurement metadata only.',
        limitations: ['One supplied source does not settle the hypothesis.'],
        evidence: [evidence('measurement-a', 'independent-source-a')],
        provenance: provenance(),
      });
      await service.recordEvidence(actor, {
        claimId: claim.id,
        kind: 'REPLICATION',
        epistemicStatus: 'OBSERVED',
        summary: 'A bounded replication metadata summary was supplied.',
        methodologySummary: 'High-level reproducibility reference only.',
        limitations: ['The registry does not claim physical independent replication.'],
        evidence: [evidence('replication-b', 'independent-source-b', 'VERIFIED')],
        reproducibilityRecordIds: [reproducibilityRecordId],
        provenance: provenance(),
      });
      const assessment = await service.assessClaim(actor, claim.id);
      assert.equal(assessment.status, 'CONDITIONALLY_SUPPORTED');
      assert.equal(assessment.independentStrongSourceCount, 2);
      assert.equal(assessment.physicalExecutionAuthorization, 'NOT_AUTHORIZED');
      assert.equal(assessment.nextStep, 'NO_ACTION');
      assert.match(assessment.conclusionSummary, /not a discovery/i);
    } finally {
      await kernel.shutdown();
    }
  });

  it('keeps simulation evidence explicitly simulated and requires reproduction rather than treating it as a physical result', async () => {
    const { kernel, cognitive, service } = await boot();
    try {
      const claim = await createClaim(cognitive, service);
      await service.recordEvidence(actor, {
        claimId: claim.id,
        kind: 'SIMULATION',
        epistemicStatus: 'SIMULATED',
        summary: 'A simulated output was supplied as a bounded summary.',
        methodologySummary: 'Classical simulation metadata only.',
        limitations: ['Simulation does not establish real-world performance.'],
        evidence: [evidence('simulation-input', 'simulation-source', 'PREDICTION')],
        provenance: provenance(),
      });
      const assessment = await service.assessClaim(actor, claim.id);
      assert.equal(assessment.simulationOnly, true);
      assert.equal(assessment.status, 'REPRODUCIBILITY_REQUIRED');
      assert.equal(assessment.nextStep, 'REQUEST_REPRODUCTION');
      await assert.rejects(() => service.recordEvidence(actor, {
        claimId: claim.id, kind: 'SIMULATION', epistemicStatus: 'OBSERVED', summary: 'Invalid status.', methodologySummary: 'High-level metadata.', limitations: [], evidence: [evidence('invalid-simulation', 'source')], provenance: provenance(),
      }), ResearchEvidenceError);
    } finally {
      await kernel.shutdown();
    }
  });

  it('retains explicitly conflicting evidence instead of inventing a research conclusion', async () => {
    const { kernel, cognitive, service } = await boot();
    try {
      const claim = await createClaim(cognitive, service);
      await service.recordEvidence(actor, {
        claimId: claim.id,
        kind: 'ANALYSIS',
        epistemicStatus: 'INFERRED',
        summary: 'An analysis reports an unresolved contradiction.',
        methodologySummary: 'High-level analysis metadata only.',
        limitations: ['Conflict remains unresolved.'],
        evidence: [evidence('conflicting-source', 'source-a', 'CONFLICTING')],
        provenance: provenance(),
      });
      const assessment = await service.assessClaim(actor, claim.id);
      assert.equal(assessment.status, 'CONFLICTING_EVIDENCE');
      assert.equal(assessment.nextStep, 'NO_ACTION');
      assert.match(assessment.conclusionSummary, /retains the conflict/i);
    } finally {
      await kernel.shutdown();
    }
  });

  it('forces regulated-domain claims toward human/regulatory review and never grants physical execution', async () => {
    const { kernel, cognitive, service } = await boot();
    try {
      await assert.rejects(() => createClaim(cognitive, service, { domain: 'MEDICAL', safetyClassification: 'STANDARD' }), ResearchEvidenceError);
      const claim = await createClaim(cognitive, service, { domain: 'MEDICAL', safetyClassification: 'REGULATED_OR_HAZARDOUS' });
      const assessment = await service.assessClaim(actor, claim.id);
      assert.equal(assessment.regulatedWorkRequiresHumanReview, true);
      assert.equal(assessment.nextStep, 'REQUEST_HUMAN_REVIEW_AND_REGULATORY_GATE');
      assert.equal(assessment.physicalExecutionAuthorization, 'NOT_AUTHORIZED');
      assert.match(assessment.conclusionSummary, /not a fact or discovery/i);
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists hash-chained records across filesystem restart and enforces tenant isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-research-evidence-'));
    try {
      const first = await boot({ driver: 'filesystem', fsRoot: root });
      const claim = await createClaim(first.cognitive, first.service);
      const record = await first.service.recordEvidence(actor, {
        claimId: claim.id,
        kind: 'OBSERVATION',
        epistemicStatus: 'OBSERVED',
        summary: 'A bounded observed research summary.',
        methodologySummary: 'High-level observation metadata only.',
        limitations: ['No independent validation is performed.'],
        evidence: [evidence('persistent-evidence', 'persistent-source')],
        provenance: provenance(),
      });
      assert.deepEqual(await first.service.verifyIntegrity(actor), { tenantId: actor.tenantId, valid: true, recordCount: 1 });
      await first.kernel.shutdown();

      const second = await boot({ driver: 'filesystem', fsRoot: root });
      assert.equal((await second.service.getClaim(actor, claim.id))?.status, 'UNDER_REVIEW');
      assert.equal((await second.service.listEvidence(actor, claim.id))[0]?.hash, record.hash);
      assert.equal(await second.service.getClaim(other, claim.id), undefined);
      await assert.rejects(() => second.service.listEvidence(other, claim.id), ResearchEvidenceError);
      await second.kernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
