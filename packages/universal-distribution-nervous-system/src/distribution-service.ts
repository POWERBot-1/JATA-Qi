import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import type { CommercialAction, CommercialActor, CommercialControlPlaneService, CommercialProvenance } from '@jataqi/commercial-control-plane';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { ExternalConnectorModule } from '@jataqi/external-connectors';
import type { ExternalConnectorRegistry } from '@jataqi/external-connectors';
import { UniversalVisibilityFabricModule } from '@jataqi/universal-visibility-fabric';
import type { UniversalVisibilityFabricService } from '@jataqi/universal-visibility-fabric';
import {
  DistributionEvents,
  DistributionPublishActionType,
  type CreateDistributionPlanInput,
  type DistributionAlgorithmBoundary,
  type DistributionPlan,
  type ExecuteDistributionInput,
} from './types.js';

const PLANS_COLLECTION = 'udns.distribution-plans';

export class DistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistributionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const algorithmBoundary: DistributionAlgorithmBoundary = {
  controlledByJataQi: ['WHAT', 'WHEN', 'WHERE', 'FORMAT', 'AUDIENCE_SELECTION', 'MESSAGE', 'FREQUENCY', 'EXPERIMENTATION', 'QUALITY', 'PROOF', 'CONVERSION', 'LEARNING'],
  controlledByExternalPlatform: ['RECOMMENDATION', 'RANKING', 'DELIVERY', 'REACH', 'DISCOVERY', 'MODERATION'],
  guaranteedReach: false,
};

/**
 * Connector-aware distribution planning. It cannot guarantee reach or invoke a
 * platform directly; external connector adapters own the final platform call,
 * and publication completes only after adapter verification.
 */
export class UniversalDistributionService {
  private plans!: ICollection<DistributionPlan>;
  private runtime!: ActionRuntimeService;
  private connectors!: ExternalConnectorRegistry;
  private visibility!: UniversalVisibilityFabricService;
  private controlPlane!: CommercialControlPlaneService;

  async init(kernel: KernelApi, runtime: ActionRuntimeService): Promise<void> {
    this.plans = await kernel.getModule<StorageModule>('storage').collection<DistributionPlan>(PLANS_COLLECTION);
    this.runtime = runtime;
    this.connectors = kernel.getModule<ExternalConnectorModule>('external-connectors').getRegistry();
    this.visibility = kernel.getModule<UniversalVisibilityFabricModule>('universal-visibility-fabric').getService();
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  async createPlan(actor: CommercialActor, input: CreateDistributionPlanInput): Promise<DistributionPlan> {
    assertManager(actor);
    validateInput(input);
    const asset = await this.visibility.getAsset(actor, input.assetId);
    if (!asset || asset.productId !== input.productId) throw new DistributionError('Approved creative asset is not available for this product/tenant.');
    const connector = this.connectors.get(actor, input.connectorId);
    if (!connector) throw new DistributionError('Connector registration is not available for this tenant.');
    const now = Date.now();
    const plan: DistributionPlan = {
      id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, campaignId: input.campaignId, assetId: input.assetId,
      connectorId: input.connectorId, channel: input.channel, market: input.market, audienceSegmentId: input.audienceSegmentId,
      scheduledAt: input.scheduledAt, frequencyCap: input.frequencyCap,
      expectedReach: input.expectedReach ? { ...input.expectedReach, simulated: input.expectedReach.simulated ?? true } : undefined,
      algorithmBoundary: copy(algorithmBoundary), state: 'DRAFT', evidence: [], createdAt: now, updatedAt: now,
    };
    await this.plans.put(plan);
    await this.emit(actor, DistributionEvents.PlanCreated, plan, { planId: plan.id, assetId: plan.assetId, connectorId: plan.connectorId, guaranteedReach: false });
    return copy(plan);
  }

  /** Ensure asset approval, connector health, capability, and schedule before queueing. */
  async preparePlan(actor: CommercialActor, planId: string): Promise<DistributionPlan> {
    assertManager(actor);
    const plan = await this.requirePlan(actor, planId);
    if (!['DRAFT', 'BLOCKED', 'FAILED'].includes(plan.state)) throw new DistributionError(`Distribution plan ${plan.id} cannot be prepared from ${plan.state}.`);
    const asset = await this.visibility.getAsset(actor, plan.assetId);
    const connector = this.connectors.get(actor, plan.connectorId);
    const reasons: string[] = [];
    if (!asset || !['APPROVED', 'DISTRIBUTION_READY', 'DISTRIBUTED'].includes(asset.status)) reasons.push('Creative asset is not approved for distribution.');
    if (!connector?.connected || connector.health !== 'HEALTHY') reasons.push('Connector is not active and healthy.');
    if (!connector?.supportedActions.includes(DistributionPublishActionType)) reasons.push('Connector does not declare distribution publishing capability.');
    if (plan.scheduledAt !== undefined && plan.scheduledAt < Date.now()) reasons.push('Scheduled distribution time is in the past.');
    if (reasons.length > 0) {
      const blocked = await this.update(plan, { state: 'BLOCKED', failureReason: reasons.join(' ') });
      await this.emit(actor, DistributionEvents.Failed, blocked, { planId: blocked.id, state: blocked.state, reasons });
      return blocked;
    }
    const ready = await this.update(plan, { state: 'READY', failureReason: undefined });
    await this.emit(actor, DistributionEvents.PlanReady, ready, { planId: ready.id, assetId: ready.assetId, connectorId: ready.connectorId });
    return ready;
  }

  async executePlan(actor: CommercialActor, planId: string, input: ExecuteDistributionInput): Promise<DistributionPlan> {
    assertManager(actor);
    const plan = await this.requirePlan(actor, planId);
    if (plan.state !== 'READY') throw new DistributionError(`Distribution plan ${plan.id} must be READY before execution.`);
    const connector = this.connectors.get(actor, plan.connectorId);
    if (!connector?.connected || connector.health !== 'HEALTHY') throw new DistributionError('Distribution connector is not active and healthy.');
    const action = plan.actionId
      ? await this.runtime.getAction(actor, plan.actionId)
      : await this.runtime.plan(actor, input.decisionId, {
          targetSystem: connector.targetSystem,
          idempotencyKey: input.idempotencyKey,
          dryRun: input.dryRun,
          rollbackStrategy: connector.rollbackSupported ? 'connector-managed withdrawal' : undefined,
          parameters: { distributionPlanId: plan.id, assetId: plan.assetId, channel: plan.channel, connectorId: plan.connectorId, scheduledAt: plan.scheduledAt },
        });
    if (!action) throw new DistributionError('Distribution action could not be planned.');
    const publishing = await this.update(plan, { actionId: action.id, state: 'PUBLISHING' });
    await this.emit(actor, DistributionEvents.Publishing, publishing, { planId: publishing.id, actionId: action.id, dryRun: action.dryRun });
    const execution = await this.runtime.execute(actor, action.id);
    const state = execution.action.dryRun ? 'SIMULATED' : execution.action.executionStatus === 'VERIFYING' ? 'VERIFYING' : mapActionFailure(execution.action);
    const updated = await this.update(publishing, { state, failureReason: execution.action.error });
    if (state === 'FAILED' || state === 'BLOCKED') await this.emit(actor, DistributionEvents.Failed, updated, { planId: updated.id, state, reason: updated.failureReason });
    return updated;
  }

  async verifyPublication(actor: CommercialActor, planId: string): Promise<DistributionPlan> {
    assertManager(actor);
    const plan = await this.requirePlan(actor, planId);
    if (plan.state === 'SIMULATED') throw new DistributionError('A simulated distribution cannot be verified as external publication.');
    if (plan.state !== 'VERIFYING' || !plan.actionId) throw new DistributionError('Distribution plan is not awaiting publication verification.');
    const action = await this.runtime.verify(actor, plan.actionId);
    const externalReference = typeof action.result?.externalResponse?.externalReference === 'string'
      ? action.result.externalResponse.externalReference
      : typeof action.result?.externalResponse?.id === 'string' ? action.result.externalResponse.id : undefined;
    const published = action.executionStatus === 'COMPLETED';
    const updated = await this.update(plan, {
      state: published ? 'PUBLISHED' : mapActionFailure(action),
      externalReference,
      evidence: copy(action.verificationEvidence),
      publishedAt: published ? Date.now() : undefined,
      failureReason: published ? undefined : action.error ?? 'Publication verification failed.',
    });
    await this.emit(actor, published ? DistributionEvents.Published : DistributionEvents.Failed, updated, { planId: updated.id, actionId: action.id, externalReference, verified: published, guaranteedReach: false });
    return updated;
  }

  async getPlan(actor: CommercialActor, planId: string): Promise<DistributionPlan | undefined> {
    const plan = await this.plans.get(planId);
    return plan && canRead(actor, plan.tenantId) ? copy(plan) : undefined;
  }

  async listPlans(actor: CommercialActor): Promise<DistributionPlan[]> {
    return (await this.plans.all()).filter((plan) => canRead(actor, plan.tenantId)).map(copy);
  }

  private async requirePlan(actor: CommercialActor, planId: string): Promise<DistributionPlan> {
    const plan = await this.getPlan(actor, planId);
    if (!plan) throw new DistributionError('Distribution plan not found.');
    return plan;
  }

  private async update(plan: DistributionPlan, patch: Partial<DistributionPlan>): Promise<DistributionPlan> {
    const updated: DistributionPlan = { ...plan, ...patch, updatedAt: Date.now() };
    await this.plans.put(updated);
    return copy(updated);
  }

  private async emit(actor: CommercialActor, eventType: string, plan: DistributionPlan, payload: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'universal-distribution-nervous-system', collectedAt: now, correlationId: plan.id };
    await this.controlPlane.publishEvent(actor, { eventType, source: 'universal-distribution-nervous-system', entityId: plan.id, correlationId: plan.id, payload, provenance, privacyClassification: 'INTERNAL', idempotencyKey: `${eventType}:${plan.id}:${plan.state}` });
  }
}

function mapActionFailure(action: CommercialAction): DistributionPlan['state'] {
  if (action.executionStatus === 'BLOCKED') return 'BLOCKED';
  const detail = action.error?.toLowerCase() ?? '';
  if (detail.includes('rate')) return 'RATE_LIMITED';
  if (detail.includes('credential')) return 'CREDENTIAL_EXPIRED';
  if (detail.includes('authorization')) return 'AUTHORIZATION_FAILED';
  if (detail.includes('policy')) return 'POLICY_BLOCKED';
  return 'FAILED';
}

function validateInput(input: CreateDistributionPlanInput): void {
  for (const [name, value] of Object.entries({ productId: input.productId, assetId: input.assetId, connectorId: input.connectorId, channel: input.channel })) if (!value.trim()) throw new DistributionError(`Distribution ${name} is required.`);
  if (input.frequencyCap !== undefined && (!Number.isFinite(input.frequencyCap) || input.frequencyCap <= 0)) throw new DistributionError('Distribution frequency cap must be positive.');
  if (input.expectedReach && (!Number.isFinite(input.expectedReach.value) || input.expectedReach.value < 0 || !Number.isFinite(input.expectedReach.confidence) || input.expectedReach.confidence < 0 || input.expectedReach.confidence > 100 || !input.expectedReach.method.trim())) throw new DistributionError('Expected reach must be an explicitly uncertain non-negative prediction with method and confidence.');
}
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new DistributionError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
