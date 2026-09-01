import type { CommercialActor, CommercialProvenance, PrivacyClassification } from '@jataqi/commercial-control-plane';

/** Scientific integrity classification; labels computational substrate, not consciousness. */
export type ComputationalSubstrate = 'CLASSICAL' | 'QUANTUM_INSPIRED' | 'QUANTUM_SIMULATED' | 'HYBRID_QUANTUM_CLASSICAL' | 'QUANTUM_NATIVE';
export type EpistemicStatus = 'OBSERVED' | 'INFERRED' | 'HYPOTHESIZED' | 'SIMULATED' | 'UNKNOWN';
export type ContradictionStatus = 'NONE' | 'POSSIBLE' | 'CONFLICTING';
export type CognitiveGoalStatus = 'ACTIVE' | 'SATISFIED' | 'BLOCKED' | 'RETIRED';

export interface CognitiveState {
  id: string;
  tenantId: string;
  scope: string;
  substrate: ComputationalSubstrate;
  observationIds: string[];
  beliefIds: string[];
  goalIds: string[];
  traceIds: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCognitiveStateInput {
  scope: string;
  substrate?: ComputationalSubstrate;
}

export interface CognitiveObservation {
  id: string;
  tenantId: string;
  stateId: string;
  modality: 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'SENSOR' | 'DOCUMENT' | 'CODE' | 'DATABASE' | 'NETWORK_EVENT' | 'SIMULATION';
  contentSummary: string;
  epistemicStatus: EpistemicStatus;
  confidence: number;
  provenance: CommercialProvenance;
  privacyClassification: PrivacyClassification;
  recordedAt: number;
}

export interface RecordCognitiveObservationInput {
  modality: CognitiveObservation['modality'];
  contentSummary: string;
  epistemicStatus: EpistemicStatus;
  confidence: number;
  provenance: CommercialProvenance;
  privacyClassification?: PrivacyClassification;
}

export interface CognitiveBelief {
  id: string;
  tenantId: string;
  stateId: string;
  proposition: string;
  probability: number;
  confidence: number;
  epistemicStatus: EpistemicStatus;
  evidenceObservationIds: string[];
  assumptions: string[];
  dependencies: string[];
  expectedUtility?: number;
  contradictionStatus: ContradictionStatus;
  temporalValidity?: { validFrom?: number; validUntil?: number };
  createdAt: number;
  updatedAt: number;
}

export interface AddCognitiveBeliefInput {
  proposition: string;
  probability: number;
  confidence: number;
  epistemicStatus: EpistemicStatus;
  evidenceObservationIds?: string[];
  assumptions?: string[];
  dependencies?: string[];
  expectedUtility?: number;
  temporalValidity?: { validFrom?: number; validUntil?: number };
}

export interface UpdateCognitiveBeliefInput {
  probability: number;
  confidence: number;
  epistemicStatus: EpistemicStatus;
  additionalEvidenceObservationIds?: string[];
  assumptions?: string[];
  reason: string;
}

export interface CognitiveGoal {
  id: string;
  tenantId: string;
  stateId: string;
  description: string;
  priority: number;
  status: CognitiveGoalStatus;
  constraints: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AddCognitiveGoalInput {
  description: string;
  priority: number;
  constraints?: string[];
}

/** Safe audit summary only; never stores hidden chain-of-thought. */
export interface CognitiveTrace {
  id: string;
  tenantId: string;
  stateId: string;
  operation: 'OBSERVE' | 'BELIEF_ADDED' | 'BELIEF_UPDATED' | 'GOAL_ADDED' | 'ASSESS';
  substrate: ComputationalSubstrate;
  inputSummary: string;
  observationIds: string[];
  beliefIds: string[];
  assumptions: string[];
  alternatives: string[];
  conclusionSummary: string;
  uncertaintySummary: string;
  confidence: number;
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface CognitiveAssessment {
  state: CognitiveState;
  highConfidenceBeliefs: CognitiveBelief[];
  uncertainBeliefs: CognitiveBelief[];
  contradictoryBeliefs: CognitiveBelief[];
  activeGoals: CognitiveGoal[];
  recommendedInformationNeeds: string[];
  trace: CognitiveTrace;
}

export const CognitiveKernelEvents = Object.freeze({
  StateCreated: 'cognitive.state.created',
  ObservationRecorded: 'cognitive.observation.recorded',
  BeliefAdded: 'cognitive.belief.added',
  BeliefUpdated: 'cognitive.belief.updated',
  GoalAdded: 'cognitive.goal.added',
  Assessed: 'cognitive.assessed',
} as const);

export type { CommercialActor };
