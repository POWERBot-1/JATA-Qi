import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import { WorldModelModule } from '@jataqi/world-model';
import type { WorldModelService } from '@jataqi/world-model';
import {
  TemporalEngineEvents,
  type CreateTemporalScenarioInput,
  type CreateTimelineInput,
  type RecordTemporalEventInput,
  type TemporalEvent,
  type TemporalReplayOptions,
  type TemporalScenario,
  type Timeline,
} from './types.js';

const TIMELINES_COLLECTION = 'temporal-engine.timelines';
const EVENTS_COLLECTION = 'temporal-engine.events';
const SCENARIOS_COLLECTION = 'temporal-engine.scenarios';

export class TemporalEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemporalEngineError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Durable temporal ordering and scenario representation. Scenarios are kept
 * separate from observed timelines and are always labelled simulated.
 */
export class TemporalEngineService {
  private api!: KernelApi;
  private timelines!: ICollection<Timeline>;
  private events!: ICollection<TemporalEvent>;
  private scenarios!: ICollection<TemporalScenario>;
  private world!: WorldModelService;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.timelines = await storage.collection<Timeline>(TIMELINES_COLLECTION);
    this.events = await storage.collection<TemporalEvent>(EVENTS_COLLECTION);
    this.scenarios = await storage.collection<TemporalScenario>(SCENARIOS_COLLECTION);
    this.world = kernel.getModule<WorldModelModule>('world-model').getService();
  }

  async createTimeline(actor: CommercialActor, input: CreateTimelineInput): Promise<Timeline> {
    assertActor(actor);
    if (!input.name.trim()) throw new TemporalEngineError('Timeline name is required.');
    if (input.worldModelId && !await this.world.getModel(actor, input.worldModelId)) throw new TemporalEngineError('Referenced world model is not available for this tenant.');
    const now = Date.now();
    const timeline: Timeline = { id: randomUUID(), tenantId: actor.tenantId, name: input.name, worldModelId: input.worldModelId, description: input.description, createdAt: now, updatedAt: now };
    await this.timelines.put(timeline);
    await this.api.bus.emit(TemporalEngineEvents.TimelineCreated, { timelineId: timeline.id, tenantId: timeline.tenantId });
    return copy(timeline);
  }

  async recordEvent(actor: CommercialActor, timelineId: string, input: RecordTemporalEventInput): Promise<TemporalEvent> {
    assertActor(actor);
    const timeline = await this.requireTimeline(actor, timelineId);
    validateEvent(input);
    const causationEventIds = [...new Set(input.causationEventIds ?? [])];
    for (const causationId of causationEventIds) {
      const cause = await this.events.get(causationId);
      if (!cause || cause.tenantId !== timeline.tenantId || cause.timelineId !== timeline.id) throw new TemporalEngineError(`Causation event ${causationId} is not available on this timeline.`);
      if (cause.occurredAt > input.occurredAt) throw new TemporalEngineError(`Causation event ${causationId} occurs after the proposed event.`);
    }
    const latest = (await this.events.query({ where: (event) => event.timelineId === timeline.id, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
    const event: TemporalEvent = {
      id: randomUUID(), tenantId: timeline.tenantId, timelineId: timeline.id, sequence: (latest?.sequence ?? 0) + 1,
      type: input.type, occurredAt: input.occurredAt, recordedAt: Date.now(), validFrom: input.validFrom, validUntil: input.validUntil,
      causationEventIds, epistemicStatus: input.epistemicStatus, confidence: input.confidence, payload: copy(input.payload ?? {}), evidence: copy(input.evidence), provenance: copy(input.provenance),
    };
    await this.events.put(event);
    await this.timelines.put({ ...timeline, updatedAt: event.recordedAt });
    await this.api.bus.emit(TemporalEngineEvents.EventRecorded, { timelineId: timeline.id, eventId: event.id, sequence: event.sequence, epistemicStatus: event.epistemicStatus });
    return copy(event);
  }

  /** Replay observed/inferred timeline records ordered by actual occurrence time then ingestion sequence. */
  async replay(actor: CommercialActor, timelineId: string, options: TemporalReplayOptions = {}): Promise<TemporalEvent[]> {
    await this.requireTimeline(actor, timelineId);
    if (options.from !== undefined && options.until !== undefined && options.from > options.until) throw new TemporalEngineError('Temporal replay range is invalid.');
    const events = await this.events.query({
      where: (event) => event.timelineId === timelineId &&
        (options.from === undefined || event.occurredAt >= options.from) &&
        (options.until === undefined || event.occurredAt <= options.until),
      limit: options.limit,
    });
    return events.sort((a, b) => a.occurredAt - b.occurredAt || a.sequence - b.sequence).map(copy);
  }

  /** Store an explicit future branch separately; it cannot change timeline facts. */
  async createScenario(actor: CommercialActor, timelineId: string, input: CreateTemporalScenarioInput): Promise<TemporalScenario> {
    assertActor(actor);
    const timeline = await this.requireTimeline(actor, timelineId);
    if (!input.name.trim() || !input.assumptions.length || !input.projectedEvents.length || !input.provenance.source.trim()) throw new TemporalEngineError('Scenario name, assumptions, projected events, and provenance are required.');
    if (!Number.isFinite(input.horizonStart) || !Number.isFinite(input.horizonEnd) || input.horizonStart > input.horizonEnd || !Number.isFinite(input.probability) || input.probability < 0 || input.probability > 1) throw new TemporalEngineError('Scenario horizon and probability are invalid.');
    const projectedEvents = input.projectedEvents.map((event) => {
      validateEvent(event);
      if (event.occurredAt < input.horizonStart || event.occurredAt > input.horizonEnd) throw new TemporalEngineError('Projected event is outside the scenario horizon.');
      return { ...copy(event), id: randomUUID(), epistemicStatus: 'SIMULATED' as const };
    });
    const scenario: TemporalScenario = {
      id: randomUUID(), tenantId: timeline.tenantId, timelineId: timeline.id, name: input.name, horizonStart: input.horizonStart, horizonEnd: input.horizonEnd,
      probability: input.probability, assumptions: unique(input.assumptions), projectedEvents, simulated: true, method: 'EXPLICIT_SCENARIO_TIMELINE', createdAt: Date.now(), provenance: copy(input.provenance),
    };
    await this.scenarios.put(scenario);
    await this.api.bus.emit(TemporalEngineEvents.ScenarioCreated, { timelineId: timeline.id, scenarioId: scenario.id, simulated: true });
    return copy(scenario);
  }

  async getTimeline(actor: CommercialActor, timelineId: string): Promise<Timeline | undefined> {
    const timeline = await this.timelines.get(timelineId);
    return timeline && canRead(actor, timeline.tenantId) ? copy(timeline) : undefined;
  }

  async listScenarios(actor: CommercialActor, timelineId: string): Promise<TemporalScenario[]> {
    await this.requireTimeline(actor, timelineId);
    return (await this.scenarios.query({ where: (scenario) => scenario.timelineId === timelineId, orderBy: 'createdAt', order: 'asc' })).map(copy);
  }

  private async requireTimeline(actor: CommercialActor, timelineId: string): Promise<Timeline> {
    const timeline = await this.getTimeline(actor, timelineId);
    if (!timeline) throw new TemporalEngineError('Timeline not found.');
    return timeline;
  }
}

function validateEvent(input: RecordTemporalEventInput): void {
  if (!input.type.trim() || !Number.isFinite(input.occurredAt) || !input.evidence.length || !input.provenance.source.trim()) throw new TemporalEngineError('Temporal event type, occurrence time, evidence, and provenance are required.');
  if (input.validFrom !== undefined && input.validUntil !== undefined && input.validFrom > input.validUntil) throw new TemporalEngineError('Temporal validity range is invalid.');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100) throw new TemporalEngineError('Temporal event confidence must be from 0 to 100.');
  if (!['OBSERVED', 'INFERRED', 'HYPOTHESIZED', 'SIMULATED', 'UNKNOWN'].includes(input.epistemicStatus)) throw new TemporalEngineError('Temporal event epistemic status is invalid.');
}
function unique(values: readonly string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function assertActor(actor: CommercialActor): void { if (!actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new TemporalEngineError('A tenant-bound actor is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
