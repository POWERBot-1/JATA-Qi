import type { CommercialActor, CommercialEvidence, CommercialProvenance } from '@jataqi/commercial-control-plane';

export type CausalEdgeStatus = 'CAUSAL_HYPOTHESIS' | 'CAUSAL_EVIDENCE';

export interface CausalVariable {
  id: string;
  label: string;
  unit: string;
  baseline: number;
  bounds?: { min?: number; max?: number };
}

export interface CausalEdge {
  id: string;
  fromVariableId: string;
  toVariableId: string;
  /** Local linear change in target per one-unit change from source baseline. */
  effect: number;
  confidence: number;
  status: CausalEdgeStatus;
  causalMethod: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface CausalModel {
  id: string;
  tenantId: string;
  worldModelId?: string;
  name: string;
  variables: CausalVariable[];
  edges: CausalEdge[];
  assumptions: string[];
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCausalModelInput {
  worldModelId?: string;
  name: string;
  variables: CausalVariable[];
  assumptions: string[];
  provenance: CommercialProvenance;
}

export interface AddCausalEdgeInput {
  fromVariableId: string;
  toVariableId: string;
  effect: number;
  confidence: number;
  status: CausalEdgeStatus;
  causalMethod: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface CounterfactualScenario {
  id: string;
  tenantId: string;
  modelId: string;
  interventions: Record<string, number>;
  predictedValues: Record<string, number>;
  assumptions: string[];
  uncertainty: string[];
  evidence: CommercialEvidence[];
  simulated: true;
  method: 'CLASSICAL_LINEAR_STRUCTURAL_CAUSAL_MODEL';
  createdAt: number;
}

export interface SimulateInterventionInput {
  interventions: Record<string, number>;
  assumptions?: string[];
  evidence: CommercialEvidence[];
}

export const CausalEngineEvents = Object.freeze({
  ModelCreated: 'jqb.causal.model.created',
  EdgeAdded: 'jqb.causal.edge.added',
  ScenarioSimulated: 'jqb.counterfactual.simulated',
} as const);

export type { CommercialActor };
