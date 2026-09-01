import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor, CommercialProvenance } from '@jataqi/commercial-control-plane';
import {
  CognitiveKernelEvents,
  type AddCognitiveBeliefInput,
  type AddCognitiveGoalInput,
  type CognitiveAssessment,
  type CognitiveBelief,
  type CognitiveGoal,
  type CognitiveObservation,
  type CognitiveState,
  type CognitiveTrace,
  type CreateCognitiveStateInput,
  type RecordCognitiveObservationInput,
  type UpdateCognitiveBeliefInput,
} from './types.js';

const STATES_COLLECTION = 'cognitive-kernel.states';
const OBSERVATIONS_COLLECTION = 'cognitive-kernel.observations';
const BELIEFS_COLLECTION = 'cognitive-kernel.beliefs';
const GOALS_COLLECTION = 'cognitive-kernel.goals';
const TRACES_COLLECTION = 'cognitive-kernel.traces';
const SUBSTRATES = new Set(['CLASSICAL', 'QUANTUM_INSPIRED', 'QUANTUM_SIMULATED', 'HYBRID_QUANTUM_CLASSICAL', 'QUANTUM_NATIVE']);
const EPISTEMIC_STATUSES = new Set(['OBSERVED', 'INFERRED', 'HYPOTHESIZED', 'SIMULATED', 'UNKNOWN']);
const MODALITIES = new Set(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'SENSOR', 'DOCUMENT', 'CODE', 'DATABASE', 'NETWORK_EVENT', 'SIMULATION']);

export class CognitiveKernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CognitiveKernelError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Classical JQB v0.1 cognitive state manager. It has no claim to consciousness,
 * quantum computation, or autonomous action. Its traces are intentionally safe,
 * auditable summaries of evidence, assumptions, uncertainty, and conclusions.
 */
export class CognitiveKernelService {
  private api!: KernelApi;
  private states!: ICollection<CognitiveState>;
  private observations!: ICollection<CognitiveObservation>;
  private beliefs!: ICollection<CognitiveBelief>;
  private goals!: ICollection<CognitiveGoal>;
  private traces!: ICollection<CognitiveTrace>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.states = await storage.collection<CognitiveState>(STATES_COLLECTION);
    this.observations = await storage.collection<CognitiveObservation>(OBSERVATIONS_COLLECTION);
    this.beliefs = await storage.collection<CognitiveBelief>(BELIEFS_COLLECTION);
    this.goals = await storage.collection<CognitiveGoal>(GOALS_COLLECTION);
    this.traces = await storage.collection<CognitiveTrace>(TRACES_COLLECTION);
  }

  async createState(actor: CommercialActor, input: CreateCognitiveStateInput): Promise<CognitiveState> {
    assertActor(actor);
    if (!input.scope.trim()) throw new CognitiveKernelError('Cognitive state scope is required.');
    if (input.substrate !== undefined && !SUBSTRATES.has(input.substrate)) throw new CognitiveKernelError('Unknown computational substrate classification.');
    const now = Date.now();
    const state: CognitiveState = {
      id: randomUUID(), tenantId: actor.tenantId, scope: input.scope, substrate: input.substrate ?? 'CLASSICAL',
      observationIds: [], beliefIds: [], goalIds: [], traceIds: [], version: 1, createdAt: now, updatedAt: now,
    };
    await this.states.put(state);
    await this.api.bus.emit(CognitiveKernelEvents.StateCreated, { stateId: state.id, tenantId: state.tenantId, substrate: state.substrate });
    return copy(state);
  }

  async recordObservation(actor: CommercialActor, stateId: string, input: RecordCognitiveObservationInput): Promise<CognitiveObservation> {
    assertActor(actor);
    const state = await this.requireState(actor, stateId);
    validateObservation(input);
    const observation: CognitiveObservation = {
      id: randomUUID(), tenantId: state.tenantId, stateId: state.id, modality: input.modality, contentSummary: bounded(input.contentSummary),
      epistemicStatus: input.epistemicStatus, confidence: input.confidence, provenance: copy(input.provenance),
      privacyClassification: input.privacyClassification ?? 'INTERNAL', recordedAt: Date.now(),
    };
    await this.observations.put(observation);
    await this.updateState(state, { observationIds: unique([...state.observationIds, observation.id]) });
    await this.recordTrace(actor, state.id, {
      operation: 'OBSERVE', inputSummary: `Recorded ${observation.modality} observation.`, observationIds: [observation.id], beliefIds: [],
      assumptions: [], alternatives: [], conclusionSummary: `Observation retained as ${observation.epistemicStatus}.`,
      uncertaintySummary: uncertaintySummary(observation.confidence, observation.epistemicStatus), confidence: observation.confidence, provenance: observation.provenance,
    });
    await this.api.bus.emit(CognitiveKernelEvents.ObservationRecorded, { stateId: state.id, observationId: observation.id, epistemicStatus: observation.epistemicStatus });
    return copy(observation);
  }

  async addBelief(actor: CommercialActor, stateId: string, input: AddCognitiveBeliefInput): Promise<CognitiveBelief> {
    assertActor(actor);
    const state = await this.requireState(actor, stateId);
    validateBeliefInput(input);
    const evidenceIds = unique(input.evidenceObservationIds ?? []);
    await this.assertObservationReferences(actor, state, evidenceIds);
    const conflicting = await this.findPotentialConflicts(state, input.proposition, input.probability);
    const contradictionStatus = conflicting.some((belief) => Math.abs(belief.probability - input.probability) >= 0.5)
      ? 'CONFLICTING'
      : conflicting.length > 0 ? 'POSSIBLE' : 'NONE';
    const now = Date.now();
    const belief: CognitiveBelief = {
      id: randomUUID(), tenantId: state.tenantId, stateId: state.id, proposition: input.proposition, probability: input.probability,
      confidence: input.confidence, epistemicStatus: input.epistemicStatus, evidenceObservationIds: evidenceIds,
      assumptions: unique(input.assumptions ?? []), dependencies: unique(input.dependencies ?? []), expectedUtility: input.expectedUtility,
      contradictionStatus, temporalValidity: input.temporalValidity ? copy(input.temporalValidity) : undefined, createdAt: now, updatedAt: now,
    };
    await this.beliefs.put(belief);
    for (const prior of conflicting) {
      const status = Math.abs(prior.probability - belief.probability) >= 0.5 ? 'CONFLICTING' : 'POSSIBLE';
      if (status !== prior.contradictionStatus) await this.beliefs.put({ ...prior, contradictionStatus: status, updatedAt: now });
    }
    await this.updateState(state, { beliefIds: unique([...state.beliefIds, belief.id]) });
    await this.recordTrace(actor, state.id, {
      operation: 'BELIEF_ADDED', inputSummary: `Added belief about ${bounded(input.proposition, 120)}.`, observationIds: evidenceIds, beliefIds: [belief.id],
      assumptions: belief.assumptions, alternatives: conflicting.map((item) => bounded(item.proposition, 120)),
      conclusionSummary: `Belief retained as ${belief.epistemicStatus}; contradiction status is ${belief.contradictionStatus}.`,
      uncertaintySummary: probabilityUncertainty(belief.probability, belief.confidence), confidence: belief.confidence,
      provenance: input.evidenceObservationIds?.length ? (await this.observations.get(input.evidenceObservationIds[0]!))?.provenance ?? systemProvenance(state.id) : systemProvenance(state.id),
    });
    await this.api.bus.emit(CognitiveKernelEvents.BeliefAdded, { stateId: state.id, beliefId: belief.id, contradictionStatus: belief.contradictionStatus });
    return copy(belief);
  }

  async updateBelief(actor: CommercialActor, beliefId: string, input: UpdateCognitiveBeliefInput): Promise<CognitiveBelief> {
    assertActor(actor);
    const belief = await this.requireBelief(actor, beliefId);
    validateBeliefUpdate(input);
    const state = await this.requireState(actor, belief.stateId);
    const additional = unique(input.additionalEvidenceObservationIds ?? []);
    await this.assertObservationReferences(actor, state, additional);
    const updated: CognitiveBelief = {
      ...belief,
      probability: input.probability,
      confidence: input.confidence,
      epistemicStatus: input.epistemicStatus,
      evidenceObservationIds: unique([...belief.evidenceObservationIds, ...additional]),
      assumptions: input.assumptions ? unique(input.assumptions) : belief.assumptions,
      updatedAt: Date.now(),
    };
    await this.beliefs.put(updated);
    await this.recordTrace(actor, state.id, {
      operation: 'BELIEF_UPDATED', inputSummary: `Updated belief ${belief.id}: ${bounded(input.reason, 160)}.`, observationIds: additional, beliefIds: [updated.id],
      assumptions: updated.assumptions, alternatives: [], conclusionSummary: `Belief probability updated from ${belief.probability} to ${updated.probability}.`,
      uncertaintySummary: probabilityUncertainty(updated.probability, updated.confidence), confidence: updated.confidence,
      provenance: additional.length ? (await this.observations.get(additional[0]!))?.provenance ?? systemProvenance(state.id) : systemProvenance(state.id),
    });
    await this.api.bus.emit(CognitiveKernelEvents.BeliefUpdated, { stateId: state.id, beliefId: updated.id });
    return copy(updated);
  }

  async addGoal(actor: CommercialActor, stateId: string, input: AddCognitiveGoalInput): Promise<CognitiveGoal> {
    assertActor(actor);
    const state = await this.requireState(actor, stateId);
    if (!input.description.trim() || !Number.isFinite(input.priority) || input.priority < 0 || input.priority > 100) throw new CognitiveKernelError('Goal description and priority from 0 to 100 are required.');
    const now = Date.now();
    const goal: CognitiveGoal = {
      id: randomUUID(), tenantId: state.tenantId, stateId: state.id, description: input.description, priority: input.priority,
      status: 'ACTIVE', constraints: unique(input.constraints ?? []), createdAt: now, updatedAt: now,
    };
    await this.goals.put(goal);
    await this.updateState(state, { goalIds: unique([...state.goalIds, goal.id]) });
    await this.recordTrace(actor, state.id, {
      operation: 'GOAL_ADDED', inputSummary: `Added goal ${bounded(goal.description, 160)}.`, observationIds: [], beliefIds: [], assumptions: goal.constraints,
      alternatives: [], conclusionSummary: 'Goal is active and requires evidence-bound planning.', uncertaintySummary: 'No execution or plan was generated by the cognitive kernel.',
      confidence: 100, provenance: systemProvenance(state.id),
    });
    await this.api.bus.emit(CognitiveKernelEvents.GoalAdded, { stateId: state.id, goalId: goal.id });
    return copy(goal);
  }

  /** Return a safe assessment; this is not an autonomous action or hidden reasoning trace. */
  async assess(actor: CommercialActor, stateId: string): Promise<CognitiveAssessment> {
    assertActor(actor);
    const state = await this.requireState(actor, stateId);
    const [beliefs, goals] = await Promise.all([
      this.beliefs.query({ where: (belief) => belief.stateId === state.id, orderBy: 'updatedAt', order: 'desc' }),
      this.goals.query({ where: (goal) => goal.stateId === state.id && goal.status === 'ACTIVE', orderBy: 'priority', order: 'desc' }),
    ]);
    const highConfidenceBeliefs = beliefs.filter((belief) => belief.confidence >= 70 && belief.contradictionStatus === 'NONE');
    const uncertainBeliefs = beliefs.filter((belief) => belief.confidence < 70 || belief.epistemicStatus === 'HYPOTHESIZED' || belief.epistemicStatus === 'SIMULATED' || belief.epistemicStatus === 'UNKNOWN' || Math.abs(belief.probability - 0.5) < 0.15);
    const contradictoryBeliefs = beliefs.filter((belief) => belief.contradictionStatus !== 'NONE');
    const needs = [
      ...uncertainBeliefs.map((belief) => `Acquire discriminating evidence for: ${bounded(belief.proposition, 120)}`),
      ...contradictoryBeliefs.map((belief) => `Resolve conflicting evidence for: ${bounded(belief.proposition, 120)}`),
      ...(goals.length === 0 ? ['Define an explicit goal before planning.'] : []),
    ];
    const trace = await this.recordTrace(actor, state.id, {
      operation: 'ASSESS', inputSummary: `Assessed ${beliefs.length} belief(s) and ${goals.length} active goal(s).`, observationIds: [], beliefIds: beliefs.map((belief) => belief.id),
      assumptions: [], alternatives: contradictoryBeliefs.map((belief) => bounded(belief.proposition, 120)),
      conclusionSummary: `Assessment contains ${highConfidenceBeliefs.length} high-confidence, ${uncertainBeliefs.length} uncertain, and ${contradictoryBeliefs.length} contradictory belief(s).`,
      uncertaintySummary: needs.length ? needs.slice(0, 5).join(' ') : 'No high-priority evidence gap was detected by the current deterministic assessment.',
      confidence: assessmentConfidence(beliefs), provenance: systemProvenance(state.id),
    });
    await this.api.bus.emit(CognitiveKernelEvents.Assessed, { stateId: state.id, traceId: trace.id, beliefs: beliefs.length, goals: goals.length });
    const current = await this.requireState(actor, stateId);
    return { state: copy(current), highConfidenceBeliefs: highConfidenceBeliefs.map(copy), uncertainBeliefs: uncertainBeliefs.map(copy), contradictoryBeliefs: contradictoryBeliefs.map(copy), activeGoals: goals.map(copy), recommendedInformationNeeds: needs, trace };
  }

  async getState(actor: CommercialActor, stateId: string): Promise<CognitiveState | undefined> {
    const state = await this.states.get(stateId);
    return state && canRead(actor, state.tenantId) ? copy(state) : undefined;
  }

  async listStates(actor: CommercialActor): Promise<CognitiveState[]> {
    return (await this.states.all()).filter((state) => canRead(actor, state.tenantId)).map(copy);
  }

  async listObservations(actor: CommercialActor, stateId: string): Promise<CognitiveObservation[]> {
    await this.requireState(actor, stateId);
    return (await this.observations.query({ where: (observation) => observation.stateId === stateId, orderBy: 'recordedAt', order: 'asc' })).map(copy);
  }

  async listBeliefs(actor: CommercialActor, stateId: string): Promise<CognitiveBelief[]> {
    await this.requireState(actor, stateId);
    return (await this.beliefs.query({ where: (belief) => belief.stateId === stateId, orderBy: 'updatedAt', order: 'asc' })).map(copy);
  }

  async listTraces(actor: CommercialActor, stateId: string): Promise<CognitiveTrace[]> {
    await this.requireState(actor, stateId);
    return (await this.traces.query({ where: (trace) => trace.stateId === stateId, orderBy: 'createdAt', order: 'asc' })).map(copy);
  }

  private async requireState(actor: CommercialActor, stateId: string): Promise<CognitiveState> {
    const state = await this.states.get(stateId);
    if (!state || !canRead(actor, state.tenantId)) throw new CognitiveKernelError('Cognitive state not found.');
    return state;
  }

  private async requireBelief(actor: CommercialActor, beliefId: string): Promise<CognitiveBelief> {
    const belief = await this.beliefs.get(beliefId);
    if (!belief || !canRead(actor, belief.tenantId)) throw new CognitiveKernelError('Cognitive belief not found.');
    return belief;
  }

  private async updateState(state: CognitiveState, patch: Partial<CognitiveState>): Promise<CognitiveState> {
    const updated: CognitiveState = { ...state, ...patch, version: state.version + 1, updatedAt: Date.now() };
    await this.states.put(updated);
    return updated;
  }

  private async recordTrace(actor: CommercialActor, stateId: string, input: Omit<CognitiveTrace, 'id' | 'tenantId' | 'stateId' | 'substrate' | 'createdAt'>): Promise<CognitiveTrace> {
    const state = await this.requireState(actor, stateId);
    const trace: CognitiveTrace = {
      id: randomUUID(), tenantId: state.tenantId, stateId: state.id, substrate: state.substrate,
      ...copy(input), createdAt: Date.now(),
    };
    await this.traces.put(trace);
    await this.updateState(state, { traceIds: unique([...state.traceIds, trace.id]) });
    return copy(trace);
  }

  private async assertObservationReferences(actor: CommercialActor, state: CognitiveState, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const observation = await this.observations.get(id);
      if (!observation || observation.tenantId !== state.tenantId || observation.stateId !== state.id || !canRead(actor, observation.tenantId)) {
        throw new CognitiveKernelError(`Observation ${id} is not available in this cognitive state.`);
      }
    }
  }

  private async findPotentialConflicts(state: CognitiveState, proposition: string, probability: number): Promise<CognitiveBelief[]> {
    const normalized = normalizeProposition(proposition);
    const beliefs = await this.beliefs.query({ where: (belief) => belief.stateId === state.id && normalizeProposition(belief.proposition) === normalized });
    return beliefs.filter((belief) => Math.abs(belief.probability - probability) >= 0.25);
  }
}

function validateObservation(input: RecordCognitiveObservationInput): void {
  if (!input.contentSummary.trim() || !input.provenance.source.trim() || !Number.isFinite(input.provenance.collectedAt)) throw new CognitiveKernelError('Observation content summary and provenance are required.');
  if (!MODALITIES.has(input.modality) || !EPISTEMIC_STATUSES.has(input.epistemicStatus)) throw new CognitiveKernelError('Observation modality or epistemic status is invalid.');
  assertProbability(input.confidence / 100, 'Observation confidence');
}
function validateBeliefInput(input: AddCognitiveBeliefInput): void {
  if (!input.proposition.trim()) throw new CognitiveKernelError('Belief proposition is required.');
  assertProbability(input.probability, 'Belief probability');
  assertProbability(input.confidence / 100, 'Belief confidence');
  if (!EPISTEMIC_STATUSES.has(input.epistemicStatus)) throw new CognitiveKernelError('Belief epistemic status is invalid.');
  if (input.temporalValidity?.validFrom !== undefined && input.temporalValidity.validUntil !== undefined && input.temporalValidity.validFrom > input.temporalValidity.validUntil) throw new CognitiveKernelError('Belief validity range is invalid.');
}
function validateBeliefUpdate(input: UpdateCognitiveBeliefInput): void {
  validateBeliefInput({ proposition: 'updated belief', probability: input.probability, confidence: input.confidence, epistemicStatus: input.epistemicStatus });
  if (!input.reason.trim()) throw new CognitiveKernelError('Belief update reason is required.');
}
function assertProbability(value: number, name: string): void { if (!Number.isFinite(value) || value < 0 || value > 1) throw new CognitiveKernelError(`${name} must be from 0 to 1.`); }
function normalizeProposition(value: string): string { return value.trim().toLocaleLowerCase().replace(/\s+/g, ' '); }
function unique(values: readonly string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function bounded(value: string, max = 320): string { return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`; }
function uncertaintySummary(confidence: number, status: CognitiveObservation['epistemicStatus']): string { return `${status} observation recorded with confidence ${confidence}; it is not automatically promoted to fact.`; }
function probabilityUncertainty(probability: number, confidence: number): string { return `Probability ${probability}, confidence ${confidence}; uncertainty remains explicit.`; }
function assessmentConfidence(beliefs: readonly CognitiveBelief[]): number { return beliefs.length ? Math.round(beliefs.reduce((sum, belief) => sum + belief.confidence, 0) / beliefs.length) : 0; }
function systemProvenance(stateId: string): CommercialProvenance { return { source: 'cognitive-kernel', collectedAt: Date.now(), correlationId: stateId }; }
function assertActor(actor: CommercialActor): void { if (!actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new CognitiveKernelError('A tenant-bound cognitive actor is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
