import type { CommercialActor, CommercialEvidence, CommercialProvenance } from '@jataqi/commercial-control-plane';

export type TemporalEpistemicStatus = 'OBSERVED' | 'INFERRED' | 'HYPOTHESIZED' | 'SIMULATED' | 'UNKNOWN';

export interface Timeline {
  id: string;
  tenantId: string;
  name: string;
  worldModelId?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTimelineInput {
  name: string;
  worldModelId?: string;
  description?: string;
}

export interface TemporalEvent {
  id: string;
  tenantId: string;
  timelineId: string;
  sequence: number;
  type: string;
  occurredAt: number;
  recordedAt: number;
  validFrom?: number;
  validUntil?: number;
  causationEventIds: string[];
  epistemicStatus: TemporalEpistemicStatus;
  confidence: number;
  payload: Record<string, unknown>;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface RecordTemporalEventInput {
  type: string;
  occurredAt: number;
  validFrom?: number;
  validUntil?: number;
  causationEventIds?: string[];
  epistemicStatus: TemporalEpistemicStatus;
  confidence: number;
  payload?: Record<string, unknown>;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

/** A supplied scenario branch, not a forecast or a claim about future reality. */
export interface TemporalScenario {
  id: string;
  tenantId: string;
  timelineId: string;
  name: string;
  horizonStart: number;
  horizonEnd: number;
  probability: number;
  assumptions: string[];
  projectedEvents: Array<Omit<RecordTemporalEventInput, 'causationEventIds'> & { id: string }>;
  simulated: true;
  method: 'EXPLICIT_SCENARIO_TIMELINE';
  createdAt: number;
  provenance: CommercialProvenance;
}

export interface CreateTemporalScenarioInput {
  name: string;
  horizonStart: number;
  horizonEnd: number;
  probability: number;
  assumptions: string[];
  projectedEvents: Array<Omit<RecordTemporalEventInput, 'causationEventIds'>>;
  provenance: CommercialProvenance;
}

export interface TemporalReplayOptions {
  from?: number;
  until?: number;
  limit?: number;
}

export const TemporalEngineEvents = Object.freeze({
  TimelineCreated: 'jqb.timeline.created',
  EventRecorded: 'jqb.timeline.event.recorded',
  ScenarioCreated: 'jqb.timeline.scenario.simulated',
} as const);

export type { CommercialActor };
