import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CognitiveKernelModule, type CognitiveKernelService } from '@jataqi/cognitive-kernel';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import { ProbabilisticEngineModule } from '@jataqi/probabilistic-engine';
import { HypothesisEngineError, HypothesisEngineModule, type HypothesisEngineService } from '../src/index.js';

let actor: CommercialActor;
let other: CommercialActor;
let cognitive: CognitiveKernelService;
let hypotheses: HypothesisEngineService;

function provenance(source = 'hypothesis-test') {
  return { source, collectedAt: Date.now(), correlationId: 'hypothesis-correlation' };
}

async function createStateAndSession() {
  const state = await cognitive.createState(actor, { scope: 'competing explanations' });
  const session = await hypotheses.createSession(actor, {
    cognitiveStateId: state.id,
    provenance: provenance(),
    hypothesisSet: {
      hypotheses: [
        { id: 'h1', label: 'Demand is constrained by onboarding.', probability: 0.5, confidence: 70, evidence: [], provenance: [], assumptions: ['Cohort is representative.'], dependencies: [], contradictionScore: 0 },
        { id: 'h2', label: 'Demand is constrained by pricing.', probability: 0.5, confidence: 70, evidence: [], provenance: [], assumptions: ['Price sample is current.'], dependencies: [], contradictionScore: 0 },
      ],
    },
  });
  return { state, session };
}

beforeEach(async () => {
  actor = { id: 'scientist', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CognitiveKernelModule());
  kernel.register(new ProbabilisticEngineModule());
  kernel.register(new HypothesisEngineModule());
  await kernel.boot();
  cognitive = kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
  hypotheses = kernel.getModule<HypothesisEngineModule>('hypothesis-engine').getService();
});

describe('JQB Hypothesis Engine', () => {
  it('persists competing hypotheses and mirrors them into cognitive beliefs', async () => {
    const { state, session } = await createStateAndSession();
    assert.equal(session.status, 'ACTIVE');
    assert.equal(session.hypothesisSet.hypotheses.length, 2);
    assert.equal(Object.keys(session.cognitiveBeliefIds).length, 2);
    const beliefs = await cognitive.listBeliefs(actor, state.id);
    assert.equal(beliefs.length, 2);
    assert.ok(beliefs.every((belief) => belief.epistemicStatus === 'HYPOTHESIZED'));
  });

  it('applies a classical Bayesian revision and updates linked cognitive belief probabilities', async () => {
    const { state, session } = await createStateAndSession();
    const revised = await hypotheses.revise(actor, session.id, {
      evidence: { id: 'onboarding-study', source: 'controlled-study', likelihoodByHypothesis: { h1: 0.8, h2: 0.2 } },
      provenance: provenance('controlled-study'),
    });
    assert.equal(revised.revision.informationGain > 0, true);
    assert.equal(revised.session.hypothesisSet.hypotheses.find((hypothesis) => hypothesis.id === 'h1')?.probability, 0.8);
    const beliefs = await cognitive.listBeliefs(actor, state.id);
    assert.equal(beliefs.find((belief) => belief.id === session.cognitiveBeliefIds.h1)?.probability, 0.8);
    assert.equal(beliefs.find((belief) => belief.id === session.cognitiveBeliefIds.h1)?.epistemicStatus, 'HYPOTHESIZED');
    assert.equal((await hypotheses.listRevisions(actor, session.id)).length, 1);
  });

  it('ranks evidence plans by expected information gain without executing collection', async () => {
    const { session } = await createStateAndSession();
    const ranked = await hypotheses.rankInformationPlans(actor, session.id, [
      { id: 'weak', label: 'Weak observation', provenance: provenance(), scenarios: [
        { probability: 0.5, likelihoodByHypothesis: { h1: 0.55, h2: 0.45 } },
        { probability: 0.5, likelihoodByHypothesis: { h1: 0.45, h2: 0.55 } },
      ] },
      { id: 'strong', label: 'Strong discriminating experiment', provenance: provenance(), scenarios: [
        { probability: 0.5, likelihoodByHypothesis: { h1: 0.9, h2: 0.1 } },
        { probability: 0.5, likelihoodByHypothesis: { h1: 0.1, h2: 0.9 } },
      ] },
    ]);
    assert.equal(ranked[0]?.id, 'strong');
    assert.ok(ranked[0]!.expectedInformationGain > ranked[1]!.expectedInformationGain);
  });

  it('enforces tenant isolation and malformed-evidence rejection', async () => {
    const { session } = await createStateAndSession();
    assert.equal(await hypotheses.getSession(other, session.id), undefined);
    await assert.rejects(() => hypotheses.revise(actor, session.id, {
      evidence: { id: 'bad', source: 'test', likelihoodByHypothesis: { h1: 1 } }, provenance: provenance(),
    }), HypothesisEngineError);
  });

  it('persists hypothesis sessions across a filesystem restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jataqi-hypothesis-engine-'));
    try {
      const first = createTestKernel();
      first.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      first.register(new CognitiveKernelModule());
      first.register(new ProbabilisticEngineModule());
      first.register(new HypothesisEngineModule());
      await first.boot();
      const firstCognitive = first.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
      const firstHypotheses = first.getModule<HypothesisEngineModule>('hypothesis-engine').getService();
      const state = await firstCognitive.createState(actor, { scope: 'persisted hypotheses' });
      const session = await firstHypotheses.createSession(actor, {
        cognitiveStateId: state.id, provenance: provenance(),
        hypothesisSet: { hypotheses: [{ id: 'only', label: 'Persisted hypothesis', probability: 1, confidence: 60, evidence: [], provenance: [], assumptions: [], dependencies: [], contradictionScore: 0 }] },
      });
      await first.shutdown();
      const second = createTestKernel();
      second.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      second.register(new CognitiveKernelModule());
      second.register(new ProbabilisticEngineModule());
      second.register(new HypothesisEngineModule());
      await second.boot();
      const secondHypotheses = second.getModule<HypothesisEngineModule>('hypothesis-engine').getService();
      assert.equal((await secondHypotheses.getSession(actor, session.id))?.hypothesisSet.hypotheses[0]?.label, 'Persisted hypothesis');
      await second.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
