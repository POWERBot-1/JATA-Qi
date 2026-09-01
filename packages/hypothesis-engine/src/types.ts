import type { CommercialActor, CommercialProvenance } from '@jataqi/commercial-control-plane';
import type { CreateHypothesisSetInput, HypothesisSet, InformationScenario, LikelihoodEvidence } from '@jataqi/probabilistic-engine';

export type HypothesisSessionStatus = 'ACTIVE' | 'EVIDENCE_INSUFFICIENT' | 'CONFLICTING' | 'CONCLUDED' | 'RETIRED';

export interface HypothesisSession {
  id: string;
  tenantId: string;
  cognitiveStateId: string;
  status: HypothesisSessionStatus;
  hypothesisSet: HypothesisSet;
  cognitiveBeliefIds: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface CreateHypothesisSessionInput {
  cognitiveStateId: string;
  hypothesisSet: CreateHypothesisSetInput;
  provenance: CommercialProvenance;
}

export interface ReviseHypothesisSessionInput {
  evidence: LikelihoodEvidence;
  provenance: CommercialProvenance;
}

export interface HypothesisRevision {
  id: string;
  tenantId: string;
  sessionId: string;
  evidence: LikelihoodEvidence;
  entropyBefore: number;
  entropyAfter: number;
  informationGain: number;
  createdAt: number;
  provenance: CommercialProvenance;
}

export interface InformationPlan {
  id: string;
  label: string;
  scenarios: InformationScenario[];
  provenance: CommercialProvenance;
}

export interface RankedInformationPlan extends InformationPlan {
  expectedInformationGain: number;
}

export const HypothesisEngineEvents = Object.freeze({
  SessionCreated: 'jqb.hypothesis.session.created',
  Revised: 'jqb.hypothesis.revised',
  InformationRanked: 'jqb.hypothesis.information.ranked',
} as const);

export type { CommercialActor };
