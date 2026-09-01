import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialEvidence, CommercialProvenance } from '@jataqi/commercial-control-plane';
import { CommercialIntelligenceModule } from '@jataqi/commercial-intelligence';
import type { CommercialIntelligenceService } from '@jataqi/commercial-intelligence';
import {
  VentureFactoryEvents,
  type CreateVentureInput,
  type TransitionVentureInput,
  type Venture,
  type VentureState,
  type VentureStateTransition,
} from './types.js';

const VENTURES_COLLECTION = 'autonomous-venture-factory.ventures';

export class VentureFactoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VentureFactoryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Evidence-gated venture lifecycle coordinator. It records commercial intent
 * and state, but does not generate source code, create a repository, deploy,
 * publish, charge a customer, or claim a venture has reached production.
 */
export class AutonomousVentureFactoryService {
  private ventures!: ICollection<Venture>;
  private controlPlane!: CommercialControlPlaneService;
  private intelligence!: CommercialIntelligenceService;

  async init(kernel: KernelApi): Promise<void> {
    this.ventures = await kernel.getModule<StorageModule>('storage').collection<Venture>(VENTURES_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    this.intelligence = kernel.getModule<CommercialIntelligenceModule>('commercial-intelligence').getService();
  }

  async createVenture(actor: CommercialActor, input: CreateVentureInput): Promise<Venture> {
    assertManager(actor);
    validateCreate(input);
    if (input.opportunityId) {
      const opportunity = await this.intelligence.getOpportunity(actor, input.opportunityId);
      if (!opportunity) throw new VentureFactoryError('Referenced opportunity is not available for this tenant.');
      if (opportunity.recommendation === 'DO_NOT_PURSUE' || opportunity.recommendation === 'WAIT_FOR_EVIDENCE') {
        throw new VentureFactoryError(`Opportunity recommendation ${opportunity.recommendation} does not permit venture creation.`);
      }
    }
    const productState = await this.controlPlane.initializeProduct(actor, input.productId, undefined);
    if (productState.state === 'IDEA') {
      await this.controlPlane.transitionProduct(actor, input.productId, {
        newState: 'DISCOVERED', trigger: 'venture-created', evidence: input.evidence, reason: `Venture ${input.name} created from recorded commercial evidence.`,
      });
    }
    const now = Date.now();
    const venture: Venture = {
      id: randomUUID(), tenantId: actor.tenantId, name: input.name, productId: input.productId, opportunityId: input.opportunityId,
      state: 'DISCOVERED', blueprint: copy(input.blueprint), evidence: copy(input.evidence), createdAt: now, updatedAt: now, stateHistory: [],
    };
    await this.ventures.put(venture);
    await this.emit(actor, VentureFactoryEvents.Created, venture, { ventureId: venture.id, productId: venture.productId, opportunityId: venture.opportunityId, state: venture.state });
    return copy(venture);
  }

  async transition(actor: CommercialActor, ventureId: string, input: TransitionVentureInput): Promise<Venture> {
    assertManager(actor);
    const venture = await this.requireVenture(actor, ventureId);
    if (!input.reason.trim() || !input.evidence.length) throw new VentureFactoryError('Venture transition reason and evidence are required.');
    if (!isTransitionAllowed(venture.state, input.newState)) throw new VentureFactoryError(`Venture transition is not allowed: ${venture.state} -> ${input.newState}.`);

    const gateFailure = await this.gateFailure(actor, venture, input);
    if (gateFailure) return this.block(actor, venture, gateFailure, input.evidence, input.decisionId, input.readinessReportId);

    const transition: VentureStateTransition = {
      id: randomUUID(), previousState: venture.state, newState: input.newState, reason: input.reason, decisionId: input.decisionId,
      readinessReportId: input.readinessReportId, evidence: copy(input.evidence), actor: actor.id, timestamp: Date.now(),
    };
    const updated: Venture = { ...venture, state: input.newState, evidence: [...venture.evidence, ...copy(input.evidence)], stateHistory: [...venture.stateHistory, transition], updatedAt: transition.timestamp };
    await this.ventures.put(updated);
    await this.emit(actor, VentureFactoryEvents.Transitioned, updated, { ventureId: updated.id, previousState: transition.previousState, newState: transition.newState, decisionId: transition.decisionId, readinessReportId: transition.readinessReportId });
    return copy(updated);
  }

  async getVenture(actor: CommercialActor, ventureId: string): Promise<Venture | undefined> {
    const venture = await this.ventures.get(ventureId);
    return venture && canRead(actor, venture.tenantId) ? copy(venture) : undefined;
  }

  async listVentures(actor: CommercialActor): Promise<Venture[]> {
    return (await this.ventures.all()).filter((venture) => canRead(actor, venture.tenantId)).map(copy);
  }

  private async gateFailure(actor: CommercialActor, venture: Venture, input: TransitionVentureInput): Promise<string | undefined> {
    if (['APPROVED', 'PRODUCTION', 'SCALE'].includes(input.newState)) {
      if (!input.decisionId) return `${input.newState} requires an explicit approved Commercial Control Plane decision.`;
      const decision = await this.controlPlane.getDecision(actor, input.decisionId);
      if (!decision || decision.productId !== venture.productId || decision.approvalState !== 'APPROVED') {
        return `${input.newState} requires an approved decision for this venture product.`;
      }
    }
    if (input.newState === 'PRODUCTION') {
      if (!input.readinessReportId) return 'PRODUCTION requires a GO commercial readiness report.';
      const readiness = await this.intelligence.getReadiness(actor, input.readinessReportId);
      if (!readiness || readiness.productId !== venture.productId || readiness.status !== 'GO') return 'PRODUCTION requires a GO readiness report for this venture product.';
    }
    return undefined;
  }

  private async block(actor: CommercialActor, venture: Venture, reason: string, evidence: readonly CommercialEvidence[], decisionId?: string, readinessReportId?: string): Promise<Venture> {
    if (venture.state === 'BLOCKED') throw new VentureFactoryError(`Venture is already blocked: ${reason}`);
    const transition: VentureStateTransition = {
      id: randomUUID(), previousState: venture.state, newState: 'BLOCKED', reason, decisionId, readinessReportId,
      evidence: copy([...evidence]), actor: actor.id, timestamp: Date.now(),
    };
    const updated: Venture = { ...venture, state: 'BLOCKED', evidence: [...venture.evidence, ...copy(evidence)], stateHistory: [...venture.stateHistory, transition], updatedAt: transition.timestamp };
    await this.ventures.put(updated);
    await this.emit(actor, VentureFactoryEvents.Blocked, updated, { ventureId: updated.id, previousState: transition.previousState, reason, decisionId, readinessReportId });
    return copy(updated);
  }

  private async requireVenture(actor: CommercialActor, ventureId: string): Promise<Venture> {
    const venture = await this.getVenture(actor, ventureId);
    if (!venture) throw new VentureFactoryError('Venture not found.');
    return venture;
  }

  private async emit(actor: CommercialActor, eventType: string, venture: Venture, payload: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'autonomous-venture-factory', collectedAt: now, correlationId: venture.id };
    await this.controlPlane.publishEvent(actor, { eventType, source: 'autonomous-venture-factory', entityId: venture.id, correlationId: venture.id, payload, provenance, privacyClassification: 'INTERNAL', idempotencyKey: `${eventType}:${venture.id}:${venture.stateHistory.length}` });
  }
}

function isTransitionAllowed(from: VentureState, to: VentureState): boolean {
  if (from === to || from === 'RETIRED') return false;
  if (to === 'BLOCKED' || to === 'RETIRED' || to === 'PIVOT') return true;
  const forward: VentureState[] = ['DISCOVERED', 'VALIDATED', 'APPROVED', 'DESIGNED', 'BUILDING', 'TESTING', 'SANDBOX', 'STAGING', 'PRODUCTION', 'GROWTH', 'SCALE'];
  const fromIndex = forward.indexOf(from);
  const toIndex = forward.indexOf(to);
  if (fromIndex >= 0 && toIndex >= 0) return toIndex === fromIndex + 1;
  if (from === 'PIVOT') return to === 'VALIDATED';
  if (from === 'BLOCKED') return to === 'VALIDATED';
  return false;
}

function validateCreate(input: CreateVentureInput): void {
  if (!input.name.trim() || !input.productId.trim() || !input.evidence.length || !input.provenance.source.trim()) throw new VentureFactoryError('Venture name, product id, evidence, and provenance are required.');
  for (const [name, value] of Object.entries(input.blueprint)) {
    if (Array.isArray(value) ? value.length === 0 : !value?.trim()) throw new VentureFactoryError(`Venture blueprint field ${name} is required.`);
  }
}
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new VentureFactoryError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
