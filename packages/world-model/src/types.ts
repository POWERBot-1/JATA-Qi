import type { CommercialActor, CommercialEvidence, CommercialProvenance } from '@jataqi/commercial-control-plane';

export type WorldEpistemicStatus = 'OBSERVED' | 'INFERRED' | 'HYPOTHESIZED' | 'SIMULATED' | 'UNKNOWN';
export type WorldRelationStatus = 'ASSOCIATION' | 'CAUSAL_HYPOTHESIS' | 'CAUSAL_EVIDENCE';

export interface WorldModel {
  id: string;
  tenantId: string;
  name: string;
  cognitiveStateId?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWorldModelInput {
  name: string;
  cognitiveStateId?: string;
  description?: string;
}

export interface WorldEntity {
  id: string;
  tenantId: string;
  modelId: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  epistemicStatus: WorldEpistemicStatus;
  confidence: number;
  provenance: CommercialProvenance;
  temporalValidity?: { validFrom?: number; validUntil?: number };
  createdAt: number;
  updatedAt: number;
}

export interface AddWorldEntityInput {
  type: string;
  name: string;
  properties?: Record<string, unknown>;
  epistemicStatus: WorldEpistemicStatus;
  confidence: number;
  provenance: CommercialProvenance;
  temporalValidity?: { validFrom?: number; validUntil?: number };
}

export interface WorldRelation {
  id: string;
  tenantId: string;
  modelId: string;
  subjectId: string;
  predicate: string;
  objectId: string;
  status: WorldRelationStatus;
  confidence: number;
  causalMethod?: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface AddWorldRelationInput {
  subjectId: string;
  predicate: string;
  objectId: string;
  status: WorldRelationStatus;
  confidence: number;
  causalMethod?: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface WorldEvent {
  id: string;
  tenantId: string;
  modelId: string;
  type: string;
  entityIds: string[];
  timestamp: number;
  epistemicStatus: WorldEpistemicStatus;
  confidence: number;
  payload: Record<string, unknown>;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface RecordWorldEventInput {
  type: string;
  entityIds: string[];
  timestamp?: number;
  epistemicStatus: WorldEpistemicStatus;
  confidence: number;
  payload?: Record<string, unknown>;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface WorldPath {
  entities: WorldEntity[];
  relations: WorldRelation[];
  confidence: number;
}

export const WorldModelEvents = Object.freeze({
  ModelCreated: 'jqb.world_model.created',
  EntityAdded: 'jqb.world_model.entity.added',
  RelationAdded: 'jqb.world_model.relation.added',
  EventRecorded: 'jqb.world_model.event.recorded',
} as const);

export type { CommercialActor };
