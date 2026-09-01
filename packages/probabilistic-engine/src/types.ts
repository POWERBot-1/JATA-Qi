export type ProbabilisticSubstrate = 'CLASSICAL' | 'QUANTUM_INSPIRED';

export interface Hypothesis {
  id: string;
  label: string;
  probability: number;
  confidence: number;
  evidence: string[];
  provenance: string[];
  assumptions: string[];
  dependencies: string[];
  expectedUtility?: number;
  contradictionScore: number;
  temporalValidity?: { validFrom?: number; validUntil?: number };
  causalRelevance?: number;
}

export interface CreateHypothesisInput extends Omit<Hypothesis, 'id' | 'probability'> {
  id?: string;
  probability?: number;
}

export interface HypothesisSet {
  id: string;
  substrate: ProbabilisticSubstrate;
  hypotheses: Hypothesis[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateHypothesisSetInput {
  substrate?: ProbabilisticSubstrate;
  hypotheses: CreateHypothesisInput[];
}

/** Likelihood P(evidence | hypothesis), not a statement of factual truth. */
export interface LikelihoodEvidence {
  id: string;
  likelihoodByHypothesis: Record<string, number>;
  source: string;
  assumptions?: string[];
}

export interface BayesianUpdateResult {
  prior: HypothesisSet;
  posterior: HypothesisSet;
  evidenceId: string;
  normalizingConstant: number;
  entropyBefore: number;
  entropyAfter: number;
  informationGain: number;
  method: 'CLASSICAL_BAYESIAN_UPDATE';
}

export interface InformationScenario {
  probability: number;
  likelihoodByHypothesis: Record<string, number>;
}

export const ProbabilisticEngineEvents = Object.freeze({
  HypothesisSetCreated: 'jqb.hypothesis_set.created',
  BeliefUpdated: 'jqb.belief.updated',
} as const);
