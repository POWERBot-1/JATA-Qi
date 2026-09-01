import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProbabilisticEngine, ProbabilisticEngineError } from '../src/index.js';

function hypotheses() {
  return [
    { id: 'h1', label: 'First explanation', probability: 0.5, confidence: 70, evidence: [], provenance: [], assumptions: [], dependencies: [], contradictionScore: 0 },
    { id: 'h2', label: 'Second explanation', probability: 0.5, confidence: 70, evidence: [], provenance: [], assumptions: [], dependencies: [], contradictionScore: 0 },
  ];
}

describe('JQB Probabilistic Engine', () => {
  it('creates normalized classical or quantum-inspired hypothesis metadata without claiming quantum-native execution', () => {
    const engine = new ProbabilisticEngine();
    const set = engine.createHypothesisSet({ substrate: 'QUANTUM_INSPIRED', hypotheses: [
      { label: 'A', confidence: 50, evidence: [], provenance: [], assumptions: [], dependencies: [], contradictionScore: 0 },
      { label: 'B', confidence: 50, evidence: [], provenance: [], assumptions: [], dependencies: [], contradictionScore: 0 },
    ] });
    assert.equal(set.substrate, 'QUANTUM_INSPIRED');
    assert.equal(set.hypotheses[0]?.probability, 0.5);
    assert.equal(set.hypotheses[1]?.probability, 0.5);
    assert.notEqual(set.substrate, 'QUANTUM_NATIVE');
  });

  it('applies classical Bayesian updating and reduces entropy for decisive evidence', () => {
    const engine = new ProbabilisticEngine();
    const prior = engine.createHypothesisSet({ hypotheses: hypotheses() });
    const update = engine.bayesianUpdate(prior, {
      id: 'e1', source: 'controlled-test', likelihoodByHypothesis: { h1: 0.8, h2: 0.2 }, assumptions: ['Likelihoods are calibrated.'],
    });
    assert.equal(update.method, 'CLASSICAL_BAYESIAN_UPDATE');
    assert.equal(update.normalizingConstant, 0.5);
    assert.equal(update.posterior.hypotheses.find((hypothesis) => hypothesis.id === 'h1')?.probability, 0.8);
    assert.equal(update.posterior.hypotheses.find((hypothesis) => hypothesis.id === 'h2')?.probability, 0.2);
    assert.ok(update.entropyAfter < update.entropyBefore);
    assert.ok(update.informationGain > 0);
  });

  it('ranks a deterministic beam by posterior probability and confidence', () => {
    const engine = new ProbabilisticEngine();
    const set = engine.createHypothesisSet({ hypotheses: [
      { id: 'a', label: 'A', probability: 0.2, confidence: 90, evidence: [], provenance: [], assumptions: [], dependencies: [], contradictionScore: 0 },
      { id: 'b', label: 'B', probability: 0.7, confidence: 40, evidence: [], provenance: [], assumptions: [], dependencies: [], contradictionScore: 0 },
      { id: 'c', label: 'C', probability: 0.1, confidence: 99, evidence: [], provenance: [], assumptions: [], dependencies: [], contradictionScore: 0 },
    ] });
    assert.deepEqual(engine.topHypotheses(set, 2).map((hypothesis) => hypothesis.id), ['b', 'a']);
  });

  it('calculates non-negative expected information gain over explicit scenarios', () => {
    const engine = new ProbabilisticEngine();
    const set = engine.createHypothesisSet({ hypotheses: hypotheses() });
    const gain = engine.expectedInformationGain(set, [
      { probability: 0.5, likelihoodByHypothesis: { h1: 0.9, h2: 0.1 } },
      { probability: 0.5, likelihoodByHypothesis: { h1: 0.1, h2: 0.9 } },
    ]);
    assert.ok(gain > 0);
  });

  it('rejects malformed or impossible evidence rather than inventing a posterior', () => {
    const engine = new ProbabilisticEngine();
    const set = engine.createHypothesisSet({ hypotheses: hypotheses() });
    assert.throws(() => engine.bayesianUpdate(set, { id: 'bad', source: 'test', likelihoodByHypothesis: { h1: 1 } }), ProbabilisticEngineError);
    assert.throws(() => engine.bayesianUpdate(set, { id: 'impossible', source: 'test', likelihoodByHypothesis: { h1: 0, h2: 0 } }), /posterior is undefined/);
    assert.throws(() => engine.createHypothesisSet({ substrate: 'QUANTUM_NATIVE' as never, hypotheses: hypotheses() }), ProbabilisticEngineError);
  });
});
