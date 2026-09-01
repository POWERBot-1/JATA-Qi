import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CognitiveKernelModule } from '@jataqi/cognitive-kernel';
import type { CognitiveKernelService } from '@jataqi/cognitive-kernel';
import type { CommercialActor, CommercialProvenance } from '@jataqi/commercial-control-plane';
import { ProbabilisticEngineModule } from '@jataqi/probabilistic-engine';
import type { ProbabilisticEngine } from '@jataqi/probabilistic-engine';
import {
  HypothesisEngineEvents,
  type CreateHypothesisSessionInput,
  type HypothesisRevision,
  type HypothesisSession,
  type InformationPlan,
  type RankedInformationPlan,
  type ReviseHypothesisSessionInput,
} from './types.js';

const SESSIONS_COLLECTION = 'hypothesis-engine.sessions';
const REVISIONS_COLLECTION = 'hypothesis-engine.revisions';

export class HypothesisEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HypothesisEngineError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Persistent competing-hypothesis coordination. It uses classical Bayesian
 * calculations and mirrors hypotheses into Cognitive Kernel beliefs; it never
 * treats a posterior as proof or executes a resulting action.
 */
export class HypothesisEngineService {
  private sessions!: ICollection<HypothesisSession>;
  private revisions!: ICollection<HypothesisRevision>;
  private cognitive!: CognitiveKernelService;
  private probability!: ProbabilisticEngine;
  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.sessions = await kernel.getModule<StorageModule>('storage').collection<HypothesisSession>(SESSIONS_COLLECTION);
    this.revisions = await kernel.getModule<StorageModule>('storage').collection<HypothesisRevision>(REVISIONS_COLLECTION);
    this.cognitive = kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
    this.probability = kernel.getModule<ProbabilisticEngineModule>('probabilistic-engine').getEngine();
  }

  async createSession(actor: CommercialActor, input: CreateHypothesisSessionInput): Promise<HypothesisSession> {
    assertActor(actor);
    if (!input.provenance.source.trim()) throw new HypothesisEngineError('Hypothesis session provenance is required.');
    const state = await this.cognitive.getState(actor, input.cognitiveStateId);
    if (!state) throw new HypothesisEngineError('Cognitive state not found for this tenant.');
    const hypothesisSet = this.probability.createHypothesisSet(input.hypothesisSet);
    const cognitiveBeliefIds: Record<string, string> = {};
    for (const hypothesis of hypothesisSet.hypotheses) {
      const belief = await this.cognitive.addBelief(actor, state.id, {
        proposition: hypothesis.label,
        probability: hypothesis.probability,
        confidence: hypothesis.confidence,
        epistemicStatus: 'HYPOTHESIZED',
        assumptions: hypothesis.assumptions,
        dependencies: hypothesis.dependencies,
        expectedUtility: hypothesis.expectedUtility,
        temporalValidity: hypothesis.temporalValidity,
      });
      cognitiveBeliefIds[hypothesis.id] = belief.id;
    }
    const now = Date.now();
    const session: HypothesisSession = {
      id: randomUUID(), tenantId: actor.tenantId, cognitiveStateId: state.id, status: sessionStatus(hypothesisSet),
      hypothesisSet, cognitiveBeliefIds, createdAt: now, updatedAt: now,
    };
    await this.sessions.put(session);
    await this.api.bus.emit(HypothesisEngineEvents.SessionCreated, { sessionId: session.id, stateId: session.cognitiveStateId, hypotheses: session.hypothesisSet.hypotheses.length, substrate: session.hypothesisSet.substrate });
    return copy(session);
  }

  async revise(actor: CommercialActor, sessionId: string, input: ReviseHypothesisSessionInput): Promise<{ session: HypothesisSession; revision: HypothesisRevision }> {
    assertActor(actor);
    const session = await this.requireSession(actor, sessionId);
    if (session.status === 'RETIRED') throw new HypothesisEngineError('A retired hypothesis session cannot be revised.');
    let update: ReturnType<ProbabilisticEngine['bayesianUpdate']>;
    try {
      update = this.probability.bayesianUpdate(session.hypothesisSet, input.evidence);
    } catch (error) {
      throw new HypothesisEngineError(`Bayesian revision was rejected: ${errorMessage(error)}`);
    }
    for (const hypothesis of update.posterior.hypotheses) {
      const beliefId = session.cognitiveBeliefIds[hypothesis.id];
      if (!beliefId) throw new HypothesisEngineError(`Cognitive belief bridge is missing for hypothesis ${hypothesis.id}.`);
      await this.cognitive.updateBelief(actor, beliefId, {
        probability: hypothesis.probability,
        confidence: hypothesis.confidence,
        epistemicStatus: 'HYPOTHESIZED',
        assumptions: hypothesis.assumptions,
        reason: `Classical Bayesian update using evidence ${input.evidence.id}; posterior remains a hypothesis.`,
      });
    }
    const revision: HypothesisRevision = {
      id: randomUUID(), tenantId: session.tenantId, sessionId: session.id, evidence: copy(input.evidence), entropyBefore: update.entropyBefore,
      entropyAfter: update.entropyAfter, informationGain: update.informationGain, createdAt: Date.now(), provenance: copy(input.provenance),
    };
    await this.revisions.put(revision);
    const updated: HypothesisSession = { ...session, hypothesisSet: update.posterior, status: sessionStatus(update.posterior), updatedAt: revision.createdAt };
    await this.sessions.put(updated);
    await this.api.bus.emit(HypothesisEngineEvents.Revised, { sessionId: updated.id, revisionId: revision.id, informationGain: revision.informationGain, method: update.method });
    return { session: copy(updated), revision: copy(revision) };
  }

  /** Rank candidate evidence collection plans; ranking does not perform collection. */
  async rankInformationPlans(actor: CommercialActor, sessionId: string, plans: InformationPlan[]): Promise<RankedInformationPlan[]> {
    assertActor(actor);
    const session = await this.requireSession(actor, sessionId);
    const ranked = plans.map((plan) => {
      if (!plan.id.trim() || !plan.label.trim() || !plan.provenance.source.trim()) throw new HypothesisEngineError('Information plans require id, label, and provenance.');
      return { ...copy(plan), expectedInformationGain: this.probability.expectedInformationGain(session.hypothesisSet, plan.scenarios) };
    }).sort((a, b) => b.expectedInformationGain - a.expectedInformationGain || a.id.localeCompare(b.id));
    await this.api.bus.emit(HypothesisEngineEvents.InformationRanked, { sessionId: session.id, planIds: ranked.map((plan) => plan.id) });
    return ranked;
  }

  async getSession(actor: CommercialActor, sessionId: string): Promise<HypothesisSession | undefined> {
    const session = await this.sessions.get(sessionId);
    return session && canRead(actor, session.tenantId) ? copy(session) : undefined;
  }

  async listSessions(actor: CommercialActor): Promise<HypothesisSession[]> {
    return (await this.sessions.all()).filter((session) => canRead(actor, session.tenantId)).map(copy);
  }

  async listRevisions(actor: CommercialActor, sessionId: string): Promise<HypothesisRevision[]> {
    await this.requireSession(actor, sessionId);
    return (await this.revisions.query({ where: (revision) => revision.sessionId === sessionId, orderBy: 'createdAt', order: 'asc' })).map(copy);
  }

  private async requireSession(actor: CommercialActor, sessionId: string): Promise<HypothesisSession> {
    const session = await this.getSession(actor, sessionId);
    if (!session) throw new HypothesisEngineError('Hypothesis session not found.');
    return session;
  }
}

function sessionStatus(set: HypothesisSession['hypothesisSet']): HypothesisSession['status'] {
  if (set.hypotheses.some((hypothesis) => hypothesis.contradictionScore >= 50)) return 'CONFLICTING';
  if (set.hypotheses.every((hypothesis) => hypothesis.confidence < 40)) return 'EVIDENCE_INSUFFICIENT';
  return 'ACTIVE';
}
function assertActor(actor: CommercialActor): void { if (!actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new HypothesisEngineError('A tenant-bound actor is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
