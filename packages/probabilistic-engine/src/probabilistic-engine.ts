import { randomUUID } from 'node:crypto';
import type {
  BayesianUpdateResult,
  CreateHypothesisInput,
  CreateHypothesisSetInput,
  Hypothesis,
  HypothesisSet,
  InformationScenario,
  LikelihoodEvidence,
} from './types.js';

export class ProbabilisticEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbabilisticEngineError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Classical probability engine. "QUANTUM_INSPIRED" is a metadata classification
 * for compatible mathematical exploration only; no quantum-state, hardware, or
 * quantum-advantage claim is made by this implementation.
 */
export class ProbabilisticEngine {
  createHypothesisSet(input: CreateHypothesisSetInput): HypothesisSet {
    if (!input.hypotheses.length) throw new ProbabilisticEngineError('A hypothesis set requires at least one hypothesis.');
    if (input.substrate !== undefined && input.substrate !== 'CLASSICAL' && input.substrate !== 'QUANTUM_INSPIRED') {
      throw new ProbabilisticEngineError('This engine supports only CLASSICAL or QUANTUM_INSPIRED metadata.');
    }
    const ids = new Set<string>();
    const suppliedProbabilities = input.hypotheses.map((hypothesis) => hypothesis.probability);
    const useUniform = suppliedProbabilities.every((probability) => probability === undefined);
    const raw = input.hypotheses.map((hypothesis, index) => {
      const id = hypothesis.id ?? randomUUID();
      if (ids.has(id)) throw new ProbabilisticEngineError(`Duplicate hypothesis id "${id}".`);
      ids.add(id);
      validateHypothesis(hypothesis);
      return {
        id,
        label: hypothesis.label,
        probability: useUniform ? 1 / input.hypotheses.length : hypothesis.probability ?? 0,
        confidence: hypothesis.confidence,
        evidence: [...hypothesis.evidence],
        provenance: [...hypothesis.provenance],
        assumptions: [...hypothesis.assumptions],
        dependencies: [...hypothesis.dependencies],
        expectedUtility: hypothesis.expectedUtility,
        contradictionScore: hypothesis.contradictionScore,
        temporalValidity: hypothesis.temporalValidity ? structuredClone(hypothesis.temporalValidity) : undefined,
        causalRelevance: hypothesis.causalRelevance,
        _index: index,
      };
    });
    const normalized = normalize(raw.map((hypothesis) => hypothesis.probability));
    const now = Date.now();
    return {
      id: randomUUID(),
      substrate: input.substrate ?? 'CLASSICAL',
      hypotheses: raw.map(({ _index, ...hypothesis }) => ({ ...hypothesis, probability: normalized[_index]! })),
      createdAt: now,
      updatedAt: now,
    };
  }

  bayesianUpdate(prior: HypothesisSet, evidence: LikelihoodEvidence): BayesianUpdateResult {
    validateSet(prior);
    if (!evidence.id.trim() || !evidence.source.trim()) throw new ProbabilisticEngineError('Evidence id and source are required.');
    const likelihoods = prior.hypotheses.map((hypothesis) => {
      const likelihood = evidence.likelihoodByHypothesis[hypothesis.id];
      if (likelihood === undefined) throw new ProbabilisticEngineError(`Evidence is missing likelihood for hypothesis "${hypothesis.id}".`);
      assertProbability(likelihood, `Likelihood for ${hypothesis.id}`);
      return likelihood;
    });
    const weights = prior.hypotheses.map((hypothesis, index) => hypothesis.probability * likelihoods[index]!);
    const normalizingConstant = weights.reduce((sum, value) => sum + value, 0);
    if (normalizingConstant <= 0) throw new ProbabilisticEngineError('Evidence assigns zero total likelihood; posterior is undefined.');
    const probabilities = weights.map((weight) => weight / normalizingConstant);
    const posterior: HypothesisSet = {
      id: randomUUID(),
      substrate: prior.substrate,
      hypotheses: prior.hypotheses.map((hypothesis, index) => ({
        ...structuredClone(hypothesis),
        probability: probabilities[index]!,
        evidence: [...hypothesis.evidence, evidence.id],
        provenance: [...hypothesis.provenance, evidence.source],
        assumptions: [...hypothesis.assumptions, ...(evidence.assumptions ?? [])],
      })),
      createdAt: prior.createdAt,
      updatedAt: Date.now(),
    };
    const entropyBefore = this.entropy(prior);
    const entropyAfter = this.entropy(posterior);
    return {
      prior: structuredClone(prior), posterior, evidenceId: evidence.id, normalizingConstant,
      entropyBefore, entropyAfter, informationGain: entropyBefore - entropyAfter, method: 'CLASSICAL_BAYESIAN_UPDATE',
    };
  }

  entropy(set: HypothesisSet): number {
    validateSet(set);
    return set.hypotheses.reduce((sum, hypothesis) => hypothesis.probability === 0 ? sum : sum - hypothesis.probability * Math.log2(hypothesis.probability), 0);
  }

  /** Expected entropy reduction across explicitly provided possible observations. */
  expectedInformationGain(set: HypothesisSet, scenarios: InformationScenario[]): number {
    validateSet(set);
    if (!scenarios.length) throw new ProbabilisticEngineError('At least one information scenario is required.');
    const probabilitySum = scenarios.reduce((sum, scenario) => {
      assertProbability(scenario.probability, 'Scenario probability');
      for (const hypothesis of set.hypotheses) {
        const likelihood = scenario.likelihoodByHypothesis[hypothesis.id];
        if (likelihood === undefined) throw new ProbabilisticEngineError(`Scenario is missing likelihood for hypothesis "${hypothesis.id}".`);
        assertProbability(likelihood, `Scenario likelihood for ${hypothesis.id}`);
      }
      return sum + scenario.probability;
    }, 0);
    if (Math.abs(probabilitySum - 1) > 1e-9) throw new ProbabilisticEngineError('Information scenario probabilities must sum to 1.');
    const priorEntropy = this.entropy(set);
    let expectedPosteriorEntropy = 0;
    for (const scenario of scenarios) {
      const weights = set.hypotheses.map((hypothesis) => hypothesis.probability * scenario.likelihoodByHypothesis[hypothesis.id]!);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      if (total === 0) continue; // An impossible observation contributes no posterior branch.
      const posterior: HypothesisSet = { ...set, hypotheses: set.hypotheses.map((hypothesis, index) => ({ ...hypothesis, probability: weights[index]! / total })) };
      expectedPosteriorEntropy += scenario.probability * this.entropy(posterior);
    }
    return priorEntropy - expectedPosteriorEntropy;
  }

  /** Deterministic beam selection; no claim is made that this is a quantum search. */
  topHypotheses(set: HypothesisSet, width = 3): Hypothesis[] {
    validateSet(set);
    if (!Number.isInteger(width) || width < 1) throw new ProbabilisticEngineError('Beam width must be a positive integer.');
    return [...set.hypotheses]
      .sort((a, b) => b.probability - a.probability || b.confidence - a.confidence || a.id.localeCompare(b.id))
      .slice(0, width)
      .map((hypothesis) => structuredClone(hypothesis));
  }
}

function validateHypothesis(hypothesis: CreateHypothesisInput): void {
  if (!hypothesis.label.trim()) throw new ProbabilisticEngineError('Hypothesis label is required.');
  if (hypothesis.probability !== undefined) assertProbability(hypothesis.probability, 'Hypothesis probability');
  assertProbability(hypothesis.confidence / 100, 'Hypothesis confidence');
  assertProbability(hypothesis.contradictionScore / 100, 'Hypothesis contradiction score');
  if (hypothesis.causalRelevance !== undefined) assertProbability(hypothesis.causalRelevance / 100, 'Hypothesis causal relevance');
  if (hypothesis.temporalValidity?.validFrom !== undefined && hypothesis.temporalValidity.validUntil !== undefined && hypothesis.temporalValidity.validFrom > hypothesis.temporalValidity.validUntil) throw new ProbabilisticEngineError('Hypothesis temporal validity is invalid.');
}

function validateSet(set: HypothesisSet): void {
  if (!set.hypotheses.length) throw new ProbabilisticEngineError('Hypothesis set is empty.');
  const total = set.hypotheses.reduce((sum, hypothesis) => {
    assertProbability(hypothesis.probability, `Hypothesis probability ${hypothesis.id}`);
    return sum + hypothesis.probability;
  }, 0);
  if (Math.abs(total - 1) > 1e-9) throw new ProbabilisticEngineError('Hypothesis probabilities must sum to 1.');
}

function normalize(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new ProbabilisticEngineError('Hypothesis probabilities must contain positive total mass.');
  return values.map((value) => value / total);
}

function assertProbability(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new ProbabilisticEngineError(`${name} must be a number from 0 to 1.`);
}
