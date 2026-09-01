import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import type { ActionExecutionAdapter } from '@jataqi/autonomous-action-runtime';
import type { CommercialAction, CommercialActor } from '@jataqi/commercial-control-plane';
import {
  DeploymentActionType,
  type CreateDeploymentInput,
  type DeploymentAdapter,
  type DeploymentHealthCheck,
  type DeploymentRecord,
  type DeploymentVerificationResult,
  type ExecuteDeploymentInput,
  type RegisteredDeploymentAdapter,
} from './types.js';

const DEPLOYMENTS_COLLECTION = 'autonomous-deployment.deployments';
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

export class DeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Deployment orchestration over the action runtime. A provider acceptance is
 * not deployment success: a deployment remains VERIFYING until the adapter
 * returns independently observed health evidence and all required checks pass.
 */
export class DeploymentService {
  private deployments!: ICollection<DeploymentRecord>;
  private runtime!: ActionRuntimeService;
  private readonly adapters = new Map<string, DeploymentAdapter>();
  private readonly adapterIds = new Map<string, string>();
  private readonly verificationResults = new Map<string, DeploymentVerificationResult>();

  async init(kernel: KernelApi, runtime: ActionRuntimeService): Promise<void> {
    this.deployments = await kernel.getModule<StorageModule>('storage').collection<DeploymentRecord>(DEPLOYMENTS_COLLECTION);
    this.runtime = runtime;
  }

  registerAdapter(actor: CommercialActor, adapter: DeploymentAdapter): RegisteredDeploymentAdapter {
    assertAdministrator(actor);
    validateAdapter(adapter);
    if (adapter.tenantId && adapter.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new DeploymentError('Cross-tenant deployment adapter registration is not authorized.');
    if (this.adapters.has(adapter.id)) throw new DeploymentError(`Deployment adapter "${adapter.id}" is already registered.`);
    const runtimeAdapter: ActionExecutionAdapter = {
      id: `deployment:${adapter.id}`,
      targetSystem: targetSystem(adapter.id),
      actionTypes: [DeploymentActionType],
      environment: 'sandbox',
      maxAttempts: normalizedAttempts(adapter.maxAttempts),
      defaultTimeoutMs: normalizedTimeout(adapter.defaultTimeoutMs),
      execute: async (context) => {
        const deployment = await this.deploymentForAction(context.action);
        return adapter.deploy({ deployment, action: context.action, actor: context.actor, signal: context.signal });
      },
      verify: async (context) => {
        const deployment = await this.deploymentForAction(context.action);
        const result = await adapter.verify({ deployment, action: context.action, actor: context.actor, signal: context.signal });
        this.verificationResults.set(context.action.id, copy(result));
        const healthPasses = requiredHealthChecksPass(deployment.requiredHealthChecks, result.healthChecks);
        return { ...result, verified: result.verified && healthPasses };
      },
      rollback: adapter.rollback ? (context) => adapter.rollback!(context) : undefined,
    };
    this.runtime.registerAdapter(runtimeAdapter);
    this.adapters.set(adapter.id, adapter);
    this.adapterIds.set(adapter.id, runtimeAdapter.id);
    return adapterMetadata(adapter, actor.tenantId);
  }

  async createDeployment(actor: CommercialActor, input: CreateDeploymentInput): Promise<DeploymentRecord> {
    assertManager(actor);
    validateDeploymentInput(input);
    const now = Date.now();
    const deployment: DeploymentRecord = {
      id: randomUUID(), tenantId: actor.tenantId, ventureId: input.ventureId, productId: input.productId, releaseVersion: input.releaseVersion,
      artifactReference: input.artifactReference, targetSystem: input.targetSystem, environment: input.environment, rollbackTarget: input.rollbackTarget,
      requiredHealthChecks: [...new Set(input.requiredHealthChecks)], validationEvidence: copy(input.validationEvidence), state: 'PLANNED', attemptCount: 0,
      healthChecks: [], verificationEvidence: [], createdAt: now, updatedAt: now,
    };
    await this.deployments.put(deployment);
    return copy(deployment);
  }

  /** Select an adapter only after a deployment record and explicit target/environment check exist. */
  async queueDeployment(actor: CommercialActor, deploymentId: string, adapterId: string): Promise<DeploymentRecord> {
    assertManager(actor);
    const deployment = await this.requireDeployment(actor, deploymentId);
    if (!['PLANNED', 'FAILED', 'BLOCKED'].includes(deployment.state)) throw new DeploymentError(`Deployment ${deployment.id} cannot be queued from ${deployment.state}.`);
    const adapter = this.adapters.get(adapterId);
    if (!adapter || (adapter.tenantId && !canRead(actor, adapter.tenantId))) throw new DeploymentError('Deployment adapter not found.');
    if (adapter.targetSystem !== deployment.targetSystem || !adapter.environments.includes(deployment.environment)) {
      throw new DeploymentError('Deployment adapter does not support this target system/environment.');
    }
    if (isProduction(deployment.environment) && !adapter.productionEnabled) {
      const blocked: DeploymentRecord = { ...deployment, state: 'BLOCKED', failureReason: 'Production adapter is not explicitly enabled.', updatedAt: Date.now() };
      await this.deployments.put(blocked);
      return copy(blocked);
    }
    const queued: DeploymentRecord = { ...deployment, state: 'QUEUED', failureReason: undefined, updatedAt: Date.now() };
    await this.deployments.put(queued);
    return copy(queued);
  }

  async executeDeployment(actor: CommercialActor, deploymentId: string, input: ExecuteDeploymentInput): Promise<DeploymentRecord> {
    assertManager(actor);
    const deployment = await this.requireDeployment(actor, deploymentId);
    if (deployment.state !== 'QUEUED') throw new DeploymentError(`Deployment ${deployment.id} must be QUEUED before execution.`);
    const adapter = this.findAdapter(deployment);
    if (!adapter) throw new DeploymentError('No active deployment adapter supports this deployment.');
    const action = deployment.actionId
      ? await this.runtime.getAction(actor, deployment.actionId)
      : await this.runtime.plan(actor, input.decisionId, {
          targetSystem: targetSystem(adapter.id),
          idempotencyKey: input.idempotencyKey,
          dryRun: input.dryRun,
          rollbackStrategy: adapter.rollback ? 'adapter-managed rollback' : undefined,
          parameters: { deploymentId: deployment.id, releaseVersion: deployment.releaseVersion, environment: deployment.environment },
        });
    if (!action) throw new DeploymentError('Deployment action could not be planned.');

    const running: DeploymentRecord = { ...deployment, actionId: action.id, state: 'DEPLOYING', attemptCount: action.attemptCount, updatedAt: Date.now() };
    await this.deployments.put(running);
    const result = await this.runtime.execute(actor, action.id, { maxAttempts: normalizedAttempts(adapter.maxAttempts), timeoutMs: adapter.defaultTimeoutMs });
    const state = deploymentStateFromAction(result.action.executionStatus);
    const updated: DeploymentRecord = {
      ...running, state, attemptCount: result.action.attemptCount, failureReason: result.action.error,
      deployedAt: result.action.executionStatus === 'VERIFYING' ? Date.now() : undefined, updatedAt: Date.now(),
    };
    await this.deployments.put(updated);
    return copy(updated);
  }

  async verifyDeployment(actor: CommercialActor, deploymentId: string): Promise<DeploymentRecord> {
    assertManager(actor);
    const deployment = await this.requireDeployment(actor, deploymentId);
    if (deployment.state !== 'VERIFYING' || !deployment.actionId) throw new DeploymentError('Deployment is not awaiting verification.');
    const action = await this.runtime.verify(actor, deployment.actionId);
    const verification = this.verificationResults.get(deployment.actionId);
    const state = action.executionStatus === 'COMPLETED' && verification && requiredHealthChecksPass(deployment.requiredHealthChecks, verification.healthChecks)
      ? 'HEALTHY'
      : 'FAILED';
    const updated: DeploymentRecord = {
      ...deployment,
      state,
      healthChecks: verification ? copy(verification.healthChecks) : [],
      verificationEvidence: copy(action.verificationEvidence),
      failureReason: state === 'FAILED' ? action.error ?? 'Deployment verification or required health checks failed.' : undefined,
      verifiedAt: state === 'HEALTHY' ? Date.now() : undefined,
      updatedAt: Date.now(),
    };
    await this.deployments.put(updated);
    return copy(updated);
  }

  /** The adapter owns reversal; this method records only its confirmed result. */
  async rollbackDeployment(actor: CommercialActor, deploymentId: string): Promise<DeploymentRecord> {
    assertManager(actor);
    const deployment = await this.requireDeployment(actor, deploymentId);
    if (!deployment.actionId) throw new DeploymentError('Deployment has no action to roll back.');
    const rolling: DeploymentRecord = { ...deployment, state: 'ROLLING_BACK', updatedAt: Date.now() };
    await this.deployments.put(rolling);
    const action = await this.runtime.rollback(actor, deployment.actionId);
    const state = action.executionStatus === 'ROLLED_BACK' ? 'ROLLED_BACK' : 'DEGRADED';
    const updated: DeploymentRecord = { ...rolling, state, failureReason: state === 'DEGRADED' ? action.error ?? 'Rollback was not confirmed.' : undefined, rolledBackAt: state === 'ROLLED_BACK' ? Date.now() : undefined, updatedAt: Date.now() };
    await this.deployments.put(updated);
    return copy(updated);
  }

  async getDeployment(actor: CommercialActor, deploymentId: string): Promise<DeploymentRecord | undefined> {
    const deployment = await this.deployments.get(deploymentId);
    return deployment && canRead(actor, deployment.tenantId) ? copy(deployment) : undefined;
  }

  async listDeployments(actor: CommercialActor): Promise<DeploymentRecord[]> {
    return (await this.deployments.all()).filter((deployment) => canRead(actor, deployment.tenantId)).map(copy);
  }

  private async requireDeployment(actor: CommercialActor, deploymentId: string): Promise<DeploymentRecord> {
    const deployment = await this.getDeployment(actor, deploymentId);
    if (!deployment) throw new DeploymentError('Deployment not found.');
    return deployment;
  }

  private findAdapter(deployment: DeploymentRecord): DeploymentAdapter | undefined {
    return [...this.adapters.values()]
      .filter((adapter) => adapter.targetSystem === deployment.targetSystem && adapter.environments.includes(deployment.environment))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
  }

  private async deploymentForAction(action: CommercialAction): Promise<DeploymentRecord> {
    const deploymentId = action.parameters.deploymentId;
    if (typeof deploymentId !== 'string') throw new DeploymentError('Action does not identify a deployment.');
    const deployment = await this.deployments.get(deploymentId);
    if (!deployment || deployment.tenantId !== action.tenantId) throw new DeploymentError('Deployment does not belong to the action tenant.');
    return deployment;
  }
}

function requiredHealthChecksPass(required: readonly string[], observed: readonly DeploymentHealthCheck[]): boolean {
  return required.every((name) => observed.some((check) => check.name === name && check.passed));
}

function deploymentStateFromAction(status: CommercialAction['executionStatus']): DeploymentRecord['state'] {
  switch (status) {
    case 'VERIFYING': return 'VERIFYING';
    case 'COMPLETED': return 'HEALTHY';
    case 'BLOCKED': return 'BLOCKED';
    case 'CANCELLED': return 'CANCELLED';
    default: return 'FAILED';
  }
}

function targetSystem(adapterId: string): string {
  return `deployment:${adapterId}`;
}

function isProduction(environment: DeploymentRecord['environment']): boolean {
  return environment === 'controlled_production' || environment === 'production';
}

function adapterMetadata(adapter: DeploymentAdapter, fallbackTenantId: string): RegisteredDeploymentAdapter {
  return {
    id: adapter.id, tenantId: adapter.tenantId ?? fallbackTenantId, targetSystem: adapter.targetSystem, environments: [...adapter.environments],
    maxAttempts: normalizedAttempts(adapter.maxAttempts), defaultTimeoutMs: normalizedTimeout(adapter.defaultTimeoutMs), productionEnabled: adapter.productionEnabled ?? false,
    rollbackSupported: typeof adapter.rollback === 'function',
  };
}

function validateDeploymentInput(input: CreateDeploymentInput): void {
  for (const [name, value] of Object.entries({ productId: input.productId, releaseVersion: input.releaseVersion, artifactReference: input.artifactReference, targetSystem: input.targetSystem })) {
    if (!value.trim()) throw new DeploymentError(`Deployment ${name} is required.`);
  }
  if (!input.requiredHealthChecks.length) throw new DeploymentError('Deployment requires one or more named health checks.');
  if (!input.validationEvidence.length) throw new DeploymentError('Deployment requires pre-deployment validation evidence.');
}

function validateAdapter(adapter: DeploymentAdapter): void {
  if (!adapter.id.trim() || !adapter.targetSystem.trim() || !adapter.environments.length) throw new DeploymentError('Deployment adapter id, target system, and environments are required.');
  normalizedAttempts(adapter.maxAttempts);
  normalizedTimeout(adapter.defaultTimeoutMs);
}

function normalizedAttempts(value: number | undefined): number {
  const attempts = value ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new DeploymentError(`Maximum attempts must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  return attempts;
}

function normalizedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600_000) throw new DeploymentError('Deployment timeout must be between 1ms and 600000ms.');
  return timeout;
}

function assertAdministrator(actor: CommercialActor): void {
  if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new DeploymentError('Commercial administrator role is required.');
}

function assertManager(actor: CommercialActor): void {
  if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new DeploymentError('Commercial operator role is required.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
