import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import type { ActionExecutionAdapter } from '@jataqi/autonomous-action-runtime';
import type { CommercialAction, CommercialActor } from '@jataqi/commercial-control-plane';
import {
  InfrastructureProvisionActionType,
  type CreateInfrastructureResourceInput,
  type DriftState,
  type ExecuteInfrastructureResourceInput,
  type InfrastructureAdapter,
  type InfrastructureResource,
  type InfrastructureVerificationResult,
  type RecordObservedStateInput,
  type RegisteredInfrastructureAdapter,
} from './types.js';

const RESOURCES_COLLECTION = 'infrastructure-state.resources';
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

export class InfrastructureRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfrastructureRegistryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Expected-vs-observed infrastructure registry. It makes no provider calls
 * without an injected adapter and no resource reaches ACTIVE without adapter
 * verification evidence.
 */
export class InfrastructureStateRegistry {
  private resources!: ICollection<InfrastructureResource>;
  private runtime!: ActionRuntimeService;
  private readonly adapters = new Map<string, InfrastructureAdapter>();
  private readonly verificationResults = new Map<string, InfrastructureVerificationResult>();

  async init(kernel: KernelApi, runtime: ActionRuntimeService): Promise<void> {
    this.resources = await kernel.getModule<StorageModule>('storage').collection<InfrastructureResource>(RESOURCES_COLLECTION);
    this.runtime = runtime;
  }

  registerAdapter(actor: CommercialActor, adapter: InfrastructureAdapter): RegisteredInfrastructureAdapter {
    assertAdministrator(actor);
    validateAdapter(adapter);
    if (adapter.tenantId && adapter.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new InfrastructureRegistryError('Cross-tenant infrastructure adapter registration is not authorized.');
    if (this.adapters.has(adapter.id)) throw new InfrastructureRegistryError(`Infrastructure adapter "${adapter.id}" is already registered.`);
    const runtimeAdapter: ActionExecutionAdapter = {
      id: `infrastructure:${adapter.id}`,
      targetSystem: targetSystem(adapter.id),
      actionTypes: [InfrastructureProvisionActionType],
      environment: 'sandbox',
      maxAttempts: normalizedAttempts(adapter.maxAttempts),
      defaultTimeoutMs: normalizedTimeout(adapter.defaultTimeoutMs),
      execute: async (context) => {
        const resource = await this.resourceForAction(context.action);
        return adapter.provision({ resource, action: context.action, actor: context.actor, signal: context.signal });
      },
      verify: async (context) => {
        const resource = await this.resourceForAction(context.action);
        const result = await adapter.verify({ resource, action: context.action, actor: context.actor, signal: context.signal });
        this.verificationResults.set(context.action.id, copy(result));
        return result;
      },
      rollback: adapter.rollback ? (context) => adapter.rollback!(context) : undefined,
    };
    this.runtime.registerAdapter(runtimeAdapter);
    this.adapters.set(adapter.id, adapter);
    return metadata(adapter, actor.tenantId);
  }

  async createResource(actor: CommercialActor, input: CreateInfrastructureResourceInput): Promise<InfrastructureResource> {
    assertManager(actor);
    validateResourceInput(input);
    const now = Date.now();
    const resource: InfrastructureResource = {
      id: randomUUID(), tenantId: actor.tenantId, ventureId: input.ventureId, productId: input.productId, resourceType: input.resourceType,
      provider: input.provider, region: input.region, environment: input.environment, owner: input.owner, dependencyIds: [...new Set(input.dependencyIds ?? [])],
      credentialReference: input.credentialReference, expectedState: copy(input.expectedState), status: 'PLANNED', health: 'UNKNOWN', driftState: 'UNKNOWN',
      estimatedCost: input.estimatedCost ? copy(input.estimatedCost) : undefined, validationEvidence: copy(input.validationEvidence), verificationEvidence: [],
      createdAt: now, updatedAt: now,
    };
    await this.resources.put(resource);
    return copy(resource);
  }

  async queueProvision(actor: CommercialActor, resourceId: string, adapterId: string): Promise<InfrastructureResource> {
    assertManager(actor);
    const resource = await this.requireResource(actor, resourceId);
    if (!['PLANNED', 'FAILED', 'BLOCKED', 'RECONCILIATION_REQUIRED'].includes(resource.status)) throw new InfrastructureRegistryError(`Resource ${resource.id} cannot be queued from ${resource.status}.`);
    const adapter = this.adapters.get(adapterId);
    if (!adapter || (adapter.tenantId && !canRead(actor, adapter.tenantId))) throw new InfrastructureRegistryError('Infrastructure adapter not found.');
    if (adapter.provider !== resource.provider || !adapter.resourceTypes.includes(resource.resourceType) || !adapter.environments.includes(resource.environment)) {
      throw new InfrastructureRegistryError('Infrastructure adapter does not support this provider, resource type, or environment.');
    }
    if (resource.environment === 'production' && !adapter.productionEnabled) {
      return this.update(resource, { status: 'BLOCKED', adapterId, failureReason: 'Production adapter is not explicitly enabled.' });
    }
    return this.update(resource, { status: 'QUEUED', adapterId, failureReason: undefined });
  }

  async provision(actor: CommercialActor, resourceId: string, input: ExecuteInfrastructureResourceInput): Promise<InfrastructureResource> {
    assertManager(actor);
    const resource = await this.requireResource(actor, resourceId);
    if (resource.status !== 'QUEUED' || !resource.adapterId) throw new InfrastructureRegistryError('Resource must be queued with an adapter before provisioning.');
    const adapter = this.adapters.get(resource.adapterId);
    if (!adapter) throw new InfrastructureRegistryError('Selected infrastructure adapter is not registered.');
    const action = resource.actionId
      ? await this.runtime.getAction(actor, resource.actionId)
      : await this.runtime.plan(actor, input.decisionId, {
          targetSystem: targetSystem(adapter.id), idempotencyKey: input.idempotencyKey, dryRun: input.dryRun,
          rollbackStrategy: adapter.rollback ? 'adapter-managed rollback' : undefined,
          parameters: { resourceId: resource.id, resourceType: resource.resourceType, provider: resource.provider, environment: resource.environment },
        });
    if (!action) throw new InfrastructureRegistryError('Provisioning action could not be planned.');
    const provisioning = await this.update(resource, { actionId: action.id, status: 'PROVISIONING', updatedAt: Date.now() });
    const result = await this.runtime.execute(actor, action.id, { maxAttempts: normalizedAttempts(adapter.maxAttempts), timeoutMs: adapter.defaultTimeoutMs });
    return this.update(provisioning, {
      status: statusFromAction(result.action.executionStatus),
      actionId: action.id,
      failureReason: result.action.error,
      updatedAt: Date.now(),
    });
  }

  async verifyProvision(actor: CommercialActor, resourceId: string): Promise<InfrastructureResource> {
    assertManager(actor);
    const resource = await this.requireResource(actor, resourceId);
    if (resource.status !== 'VERIFYING' || !resource.actionId) throw new InfrastructureRegistryError('Resource is not awaiting provisioning verification.');
    const action = await this.runtime.verify(actor, resource.actionId);
    const verification = this.verificationResults.get(resource.actionId);
    const active = action.executionStatus === 'COMPLETED' && verification?.health === 'HEALTHY';
    return this.update(resource, {
      status: active ? 'ACTIVE' : 'FAILED',
      health: verification?.health ?? 'FAILED',
      observedState: verification ? copy(verification.observedState) : resource.observedState,
      actualCost: verification?.actualCost ? copy(verification.actualCost) : resource.actualCost,
      verificationEvidence: copy(action.verificationEvidence),
      driftState: active && verification ? compareState(resource.expectedState, verification.observedState) : 'RECONCILIATION_REQUIRED',
      lastVerifiedAt: Date.now(),
      failureReason: active ? undefined : action.error ?? 'Provider verification did not confirm a healthy resource.',
    });
  }

  /** Store an externally observed state and classify it; no automatic remediation occurs. */
  async recordObservedState(actor: CommercialActor, resourceId: string, input: RecordObservedStateInput): Promise<InfrastructureResource> {
    assertManager(actor);
    const resource = await this.requireResource(actor, resourceId);
    if (!input.evidence.length) throw new InfrastructureRegistryError('Observed infrastructure state requires evidence.');
    const driftState = input.health === 'HEALTHY' ? compareState(resource.expectedState, input.observedState) : 'RECONCILIATION_REQUIRED';
    return this.update(resource, {
      observedState: copy(input.observedState), health: input.health, actualCost: input.actualCost ? copy(input.actualCost) : resource.actualCost,
      verificationEvidence: [...resource.verificationEvidence, ...copy(input.evidence)], driftState,
      status: driftState === 'IN_SYNC' && input.health === 'HEALTHY' ? 'ACTIVE' : driftState === 'DRIFT_DETECTED' ? 'RECONCILIATION_REQUIRED' : resource.status,
      lastVerifiedAt: Date.now(),
    });
  }

  async rollback(actor: CommercialActor, resourceId: string): Promise<InfrastructureResource> {
    assertManager(actor);
    const resource = await this.requireResource(actor, resourceId);
    if (!resource.actionId) throw new InfrastructureRegistryError('Resource has no provisioning action to roll back.');
    const rollingBack = await this.update(resource, { status: 'DECOMMISSIONING' });
    const action = await this.runtime.rollback(actor, resource.actionId);
    return this.update(rollingBack, {
      status: action.executionStatus === 'ROLLED_BACK' ? 'RETIRED' : 'DEGRADED',
      health: action.executionStatus === 'ROLLED_BACK' ? 'UNKNOWN' : 'DEGRADED',
      failureReason: action.executionStatus === 'ROLLED_BACK' ? undefined : action.error ?? 'Rollback was not externally confirmed.',
    });
  }

  async getResource(actor: CommercialActor, resourceId: string): Promise<InfrastructureResource | undefined> {
    const resource = await this.resources.get(resourceId);
    return resource && canRead(actor, resource.tenantId) ? copy(resource) : undefined;
  }

  async listResources(actor: CommercialActor): Promise<InfrastructureResource[]> {
    return (await this.resources.all()).filter((resource) => canRead(actor, resource.tenantId)).map(copy);
  }

  private async requireResource(actor: CommercialActor, resourceId: string): Promise<InfrastructureResource> {
    const resource = await this.getResource(actor, resourceId);
    if (!resource) throw new InfrastructureRegistryError('Infrastructure resource not found.');
    return resource;
  }

  private async resourceForAction(action: CommercialAction): Promise<InfrastructureResource> {
    const resourceId = action.parameters.resourceId;
    if (typeof resourceId !== 'string') throw new InfrastructureRegistryError('Action does not identify an infrastructure resource.');
    const resource = await this.resources.get(resourceId);
    if (!resource || resource.tenantId !== action.tenantId) throw new InfrastructureRegistryError('Infrastructure resource does not belong to the action tenant.');
    return resource;
  }

  private async update(resource: InfrastructureResource, patch: Partial<InfrastructureResource>): Promise<InfrastructureResource> {
    const updated: InfrastructureResource = { ...resource, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    await this.resources.put(updated);
    return copy(updated);
  }
}

function targetSystem(adapterId: string): string { return `infrastructure:${adapterId}`; }

function statusFromAction(status: CommercialAction['executionStatus']): InfrastructureResource['status'] {
  if (status === 'VERIFYING') return 'VERIFYING';
  if (status === 'BLOCKED') return 'BLOCKED';
  if (status === 'CANCELLED') return 'RETIRED';
  return 'FAILED';
}

function compareState(expected: Record<string, unknown>, observed: Record<string, unknown>): DriftState {
  return stable(expected) === stable(observed) ? 'IN_SYNC' : 'DRIFT_DETECTED';
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function metadata(adapter: InfrastructureAdapter, fallbackTenantId: string): RegisteredInfrastructureAdapter {
  return { id: adapter.id, tenantId: adapter.tenantId ?? fallbackTenantId, provider: adapter.provider, resourceTypes: [...adapter.resourceTypes], environments: [...adapter.environments], productionEnabled: adapter.productionEnabled ?? false, maxAttempts: normalizedAttempts(adapter.maxAttempts), defaultTimeoutMs: normalizedTimeout(adapter.defaultTimeoutMs), rollbackSupported: typeof adapter.rollback === 'function' };
}

function validateResourceInput(input: CreateInfrastructureResourceInput): void {
  for (const [name, value] of Object.entries({ provider: input.provider, owner: input.owner })) if (!value.trim()) throw new InfrastructureRegistryError(`Infrastructure ${name} is required.`);
  if (!input.validationEvidence.length) throw new InfrastructureRegistryError('Infrastructure resource requires validation evidence.');
}

function validateAdapter(adapter: InfrastructureAdapter): void {
  if (!adapter.id.trim() || !adapter.provider.trim() || !adapter.resourceTypes.length || !adapter.environments.length) throw new InfrastructureRegistryError('Infrastructure adapter id, provider, resource types, and environments are required.');
  normalizedAttempts(adapter.maxAttempts);
  normalizedTimeout(adapter.defaultTimeoutMs);
}

function normalizedAttempts(value: number | undefined): number {
  const attempts = value ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new InfrastructureRegistryError(`Maximum attempts must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  return attempts;
}

function normalizedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600_000) throw new InfrastructureRegistryError('Infrastructure timeout must be between 1ms and 600000ms.');
  return timeout;
}

function assertAdministrator(actor: CommercialActor): void {
  if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new InfrastructureRegistryError('Commercial administrator role is required.');
}

function assertManager(actor: CommercialActor): void {
  if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new InfrastructureRegistryError('Commercial operator role is required.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
