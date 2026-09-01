import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import type { ActionExecutionAdapter } from '@jataqi/autonomous-action-runtime';
import type { CommercialAction, CommercialActor } from '@jataqi/commercial-control-plane';
import {
  CodingAgentActionType,
  type CodingAgentWorker,
  type CodingTaskResult,
  type CreateEngineeringTaskInput,
  type EngineeringTask,
  type ExecuteEngineeringTaskInput,
  type RegisteredCodingAgent,
} from './types.js';

const TASKS_COLLECTION = 'copilot-execution.tasks';
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

export class CodingAgentExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingAgentExecutionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Persistent engineering task graph and controlled coding-worker adapter.
 *
 * Workers receive a bounded task and action context. They do not gain implicit
 * GitHub, deployment, billing, or administrator access. A worker-reported task
 * result stays VERIFYING until its adapter supplies verification evidence.
 */
export class CodingAgentTaskGraph {
  private tasks!: ICollection<EngineeringTask>;
  private runtime!: ActionRuntimeService;
  private readonly workers = new Map<string, CodingAgentWorker>();
  private readonly adapterIds = new Map<string, string>();
  private readonly taskResults = new Map<string, CodingTaskResult>();

  async init(kernel: KernelApi, runtime: ActionRuntimeService): Promise<void> {
    this.tasks = await kernel.getModule<StorageModule>('storage').collection<EngineeringTask>(TASKS_COLLECTION);
    this.runtime = runtime;
  }

  registerWorker(actor: CommercialActor, worker: CodingAgentWorker): RegisteredCodingAgent {
    assertAdministrator(actor);
    validateWorker(worker);
    if (worker.tenantId && worker.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) {
      throw new CodingAgentExecutionError('Only a global administrator may register a worker for another tenant.');
    }
    if (this.workers.has(worker.id)) throw new CodingAgentExecutionError(`Coding worker "${worker.id}" is already registered.`);
    const adapterId = `coding-agent:${worker.id}`;
    const adapter: ActionExecutionAdapter = {
      id: adapterId,
      targetSystem: targetSystem(worker.id),
      actionTypes: [CodingAgentActionType],
      environment: 'sandbox',
      maxAttempts: normalizedAttempts(worker.maxAttempts),
      defaultTimeoutMs: normalizedTimeout(worker.defaultTimeoutMs),
      execute: async (context) => {
        const task = await this.taskForAction(context.action);
        const result = await worker.execute({ task, action: context.action, actor: context.actor, signal: context.signal });
        if (result.taskResult) {
          this.taskResults.set(context.action.id, {
            ...copy(result.taskResult),
            reportedAt: Date.now(),
          });
        }
        return result;
      },
      verify: async (context) => {
        const task = await this.taskForAction(context.action);
        return worker.verify({ task, action: context.action, actor: context.actor, signal: context.signal });
      },
      rollback: worker.rollback ? (context) => worker.rollback!(context) : undefined,
    };
    this.runtime.registerAdapter(adapter);
    this.workers.set(worker.id, worker);
    this.adapterIds.set(worker.id, adapterId);
    return workerMetadata(worker, actor.tenantId);
  }

  async unregisterWorker(actor: CommercialActor, workerId: string): Promise<boolean> {
    assertAdministrator(actor);
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    if (worker.tenantId && worker.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) {
      throw new CodingAgentExecutionError('Cross-tenant worker removal is not authorized.');
    }
    const active = (await this.tasks.all()).some((task) => task.agentAssignment === workerId && ['ASSIGNED', 'RUNNING', 'VERIFYING', 'RETRYING'].includes(task.status));
    if (active) throw new CodingAgentExecutionError('Worker cannot be removed while assigned tasks remain active.');
    const adapterId = this.adapterIds.get(workerId);
    if (adapterId) this.runtime.unregisterAdapter(adapterId);
    this.adapterIds.delete(workerId);
    this.workers.delete(workerId);
    return true;
  }

  listWorkers(actor: CommercialActor): RegisteredCodingAgent[] {
    return [...this.workers.values()]
      .filter((worker) => !worker.tenantId || canRead(actor, worker.tenantId))
      .map((worker) => workerMetadata(worker, actor.tenantId))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async createTask(actor: CommercialActor, input: CreateEngineeringTaskInput): Promise<EngineeringTask> {
    assertManager(actor);
    validateTaskInput(input);
    const dependencies = [...new Set(input.dependencies ?? [])];
    const existing = await this.tasks.all();
    for (const dependency of dependencies) {
      const task = existing.find((candidate) => candidate.id === dependency);
      if (!task || task.tenantId !== actor.tenantId) throw new CodingAgentExecutionError(`Task dependency "${dependency}" is not available in this tenant.`);
    }
    const task: EngineeringTask = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      ventureId: input.ventureId,
      productId: input.productId,
      title: input.title,
      description: input.description,
      taskType: input.taskType,
      dependencies,
      priority: input.priority,
      estimatedComplexity: input.estimatedComplexity,
      requiredCapabilities: [...new Set(input.requiredCapabilities)],
      testRequirements: [...input.testRequirements],
      completionCriteria: [...input.completionCriteria],
      maxAttempts: normalizedAttempts(input.maxAttempts),
      attemptCount: 0,
      status: 'DRAFT',
      verificationEvidence: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    assertAcyclic([...existing.filter((candidate) => candidate.tenantId === actor.tenantId), task]);
    await this.tasks.put(task);
    return copy(task);
  }

  /** Move a task to READY only after all of its dependencies have verified completion. */
  async queueTask(actor: CommercialActor, taskId: string): Promise<EngineeringTask> {
    assertManager(actor);
    const task = await this.requireTask(actor, taskId);
    if (!['DRAFT', 'BLOCKED'].includes(task.status)) throw new CodingAgentExecutionError(`Task ${task.id} cannot be queued from ${task.status}.`);
    const blockers = await this.dependencyBlockers(task);
    if (blockers.length > 0) {
      const blocked: EngineeringTask = { ...task, status: 'BLOCKED', failureReason: `Dependencies are incomplete: ${blockers.join(', ')}.`, updatedAt: Date.now() };
      await this.tasks.put(blocked);
      return copy(blocked);
    }
    const ready: EngineeringTask = { ...task, status: 'READY', failureReason: undefined, updatedAt: Date.now() };
    await this.tasks.put(ready);
    return copy(ready);
  }

  async runnable(actor: CommercialActor): Promise<EngineeringTask[]> {
    const all = await this.tasks.all();
    const tenantTasks = all.filter((task) => canRead(actor, task.tenantId));
    const byId = new Map(tenantTasks.map((task) => [task.id, task]));
    return tenantTasks
      .filter((task) => task.status === 'READY' && task.dependencies.every((dependency) => byId.get(dependency)?.status === 'COMPLETED'))
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
      .map(copy);
  }

  async assignTask(actor: CommercialActor, taskId: string, workerId: string): Promise<EngineeringTask> {
    assertManager(actor);
    const task = await this.requireTask(actor, taskId);
    if (task.status !== 'READY') throw new CodingAgentExecutionError(`Task ${task.id} must be READY before assignment.`);
    const worker = this.workers.get(workerId);
    if (!worker || (worker.tenantId && !canRead(actor, worker.tenantId))) throw new CodingAgentExecutionError('Coding worker not found.');
    const missing = task.requiredCapabilities.filter((capability) => !worker.capabilities.includes(capability));
    if (missing.length > 0) throw new CodingAgentExecutionError(`Worker lacks required capabilities: ${missing.join(', ')}.`);
    const assigned: EngineeringTask = { ...task, agentAssignment: workerId, status: 'ASSIGNED', updatedAt: Date.now() };
    await this.tasks.put(assigned);
    return copy(assigned);
  }

  /** Run a bounded task through the commercial decision/action boundary. */
  async executeTask(actor: CommercialActor, taskId: string, input: ExecuteEngineeringTaskInput): Promise<EngineeringTask> {
    assertManager(actor);
    const task = await this.requireTask(actor, taskId);
    if (task.status !== 'ASSIGNED' && task.status !== 'RETRYING') throw new CodingAgentExecutionError(`Task ${task.id} must be ASSIGNED or RETRYING before execution.`);
    if (!task.agentAssignment) throw new CodingAgentExecutionError('Task has no assigned worker.');
    const worker = this.workers.get(task.agentAssignment);
    if (!worker) throw new CodingAgentExecutionError('Assigned coding worker is not registered.');

    const action = task.actionId
      ? await this.runtime.getAction(actor, task.actionId)
      : await this.runtime.plan(actor, input.decisionId, {
          targetSystem: targetSystem(worker.id),
          idempotencyKey: input.idempotencyKey,
          dryRun: input.dryRun,
          rollbackStrategy: input.rollbackStrategy,
          parameters: { taskId: task.id, taskType: task.taskType, completionCriteria: task.completionCriteria, testRequirements: task.testRequirements },
        });
    if (!action) throw new CodingAgentExecutionError('Task action could not be planned.');
    const running: EngineeringTask = { ...task, actionId: action.id, status: 'RUNNING', attemptCount: action.attemptCount, updatedAt: Date.now() };
    await this.tasks.put(running);

    const result = await this.runtime.execute(actor, action.id, { maxAttempts: task.maxAttempts, timeoutMs: worker.defaultTimeoutMs });
    const taskResult = this.taskResults.get(action.id);
    const state = taskStateFromAction(result.action.executionStatus);
    const updated: EngineeringTask = {
      ...running,
      status: state,
      attemptCount: result.action.attemptCount,
      result: taskResult ?? running.result,
      failureReason: result.action.error,
      updatedAt: Date.now(),
    };
    await this.tasks.put(updated);
    return copy(updated);
  }

  /** Completion requires the action runtime's explicit verification stage. */
  async verifyTask(actor: CommercialActor, taskId: string): Promise<EngineeringTask> {
    assertManager(actor);
    const task = await this.requireTask(actor, taskId);
    if (task.status !== 'VERIFYING' || !task.actionId) throw new CodingAgentExecutionError('Task is not awaiting verification.');
    const action = await this.runtime.verify(actor, task.actionId);
    const status = taskStateFromAction(action.executionStatus);
    const updated: EngineeringTask = {
      ...task,
      status,
      attemptCount: action.attemptCount,
      verificationEvidence: copy(action.verificationEvidence),
      completedAt: status === 'COMPLETED' ? Date.now() : undefined,
      failureReason: action.error,
      updatedAt: Date.now(),
    };
    await this.tasks.put(updated);
    return copy(updated);
  }

  async retryTask(actor: CommercialActor, taskId: string): Promise<EngineeringTask> {
    assertManager(actor);
    const task = await this.requireTask(actor, taskId);
    if (task.status !== 'FAILED' || !task.actionId) throw new CodingAgentExecutionError('Only a failed task with an action can be retried.');
    if (task.attemptCount >= task.maxAttempts) throw new CodingAgentExecutionError('Task retry limit has been reached.');
    const updated: EngineeringTask = { ...task, status: 'RETRYING', failureReason: undefined, updatedAt: Date.now() };
    await this.tasks.put(updated);
    return copy(updated);
  }

  async getTask(actor: CommercialActor, taskId: string): Promise<EngineeringTask | undefined> {
    const task = await this.tasks.get(taskId);
    return task && canRead(actor, task.tenantId) ? copy(task) : undefined;
  }

  async listTasks(actor: CommercialActor): Promise<EngineeringTask[]> {
    return (await this.tasks.all()).filter((task) => canRead(actor, task.tenantId)).map(copy);
  }

  private async requireTask(actor: CommercialActor, taskId: string): Promise<EngineeringTask> {
    const task = await this.getTask(actor, taskId);
    if (!task) throw new CodingAgentExecutionError('Engineering task not found.');
    return task;
  }

  private async taskForAction(action: CommercialAction): Promise<EngineeringTask> {
    const taskId = action.parameters.taskId;
    if (typeof taskId !== 'string') throw new CodingAgentExecutionError('Action does not identify an engineering task.');
    const task = await this.tasks.get(taskId);
    if (!task || task.tenantId !== action.tenantId) throw new CodingAgentExecutionError('Engineering task does not belong to this action tenant.');
    return task;
  }

  private async dependencyBlockers(task: EngineeringTask): Promise<string[]> {
    const blockers: string[] = [];
    for (const dependencyId of task.dependencies) {
      const dependency = await this.tasks.get(dependencyId);
      if (!dependency || dependency.tenantId !== task.tenantId || dependency.status !== 'COMPLETED') blockers.push(dependencyId);
    }
    return blockers;
  }
}

function workerMetadata(worker: CodingAgentWorker, fallbackTenantId: string): RegisteredCodingAgent {
  return {
    id: worker.id,
    tenantId: worker.tenantId ?? fallbackTenantId,
    capabilities: [...worker.capabilities],
    environment: worker.environment,
    maxAttempts: normalizedAttempts(worker.maxAttempts),
    defaultTimeoutMs: normalizedTimeout(worker.defaultTimeoutMs),
    rollbackSupported: typeof worker.rollback === 'function',
  };
}

function targetSystem(workerId: string): string {
  return `coding-agent:${workerId}`;
}

function taskStateFromAction(status: CommercialAction['executionStatus']): EngineeringTask['status'] {
  switch (status) {
    case 'VERIFYING': return 'VERIFYING';
    case 'COMPLETED': return 'COMPLETED';
    case 'RETRYING': return 'RETRYING';
    case 'BLOCKED': return 'BLOCKED';
    case 'ESCALATED': return 'ESCALATED';
    case 'CANCELLED': return 'CANCELLED';
    default: return 'FAILED';
  }
}

function validateTaskInput(input: CreateEngineeringTaskInput): void {
  for (const [name, value] of Object.entries({ title: input.title, description: input.description, taskType: input.taskType })) {
    if (!value.trim()) throw new CodingAgentExecutionError(`Task ${name} is required.`);
  }
  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100) throw new CodingAgentExecutionError('Task priority must be an integer from 0 to 100.');
  if (!Number.isFinite(input.estimatedComplexity) || input.estimatedComplexity <= 0) throw new CodingAgentExecutionError('Task estimated complexity must be positive.');
  if (!input.requiredCapabilities.length) throw new CodingAgentExecutionError('Task must declare required capabilities.');
  if (!input.testRequirements.length || !input.completionCriteria.length) throw new CodingAgentExecutionError('Task must declare test requirements and completion criteria.');
  normalizedAttempts(input.maxAttempts);
}

function validateWorker(worker: CodingAgentWorker): void {
  if (!worker.id.trim()) throw new CodingAgentExecutionError('Coding worker id is required.');
  if (!worker.capabilities.length || worker.capabilities.some((capability) => !capability.trim())) throw new CodingAgentExecutionError('Coding worker must declare capabilities.');
  if (worker.environment !== 'sandbox' && worker.environment !== 'controlled') throw new CodingAgentExecutionError('Coding worker environment must be sandbox or controlled.');
  normalizedAttempts(worker.maxAttempts);
  normalizedTimeout(worker.defaultTimeoutMs);
}

function assertAcyclic(tasks: readonly EngineeringTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new CodingAgentExecutionError(`Engineering task dependency cycle: ${[...path, id].join(' -> ')}.`);
    const task = byId.get(id);
    if (!task) return;
    visiting.add(id);
    for (const dependency of task.dependencies) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id, []);
}

function normalizedAttempts(value: number | undefined): number {
  const attempts = value ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new CodingAgentExecutionError(`Maximum attempts must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  return attempts;
}

function normalizedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300_000) throw new CodingAgentExecutionError('Worker timeout must be between 1ms and 300000ms.');
  return timeout;
}

function assertAdministrator(actor: CommercialActor): void {
  if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new CodingAgentExecutionError('Commercial administrator role is required.');
}

function assertManager(actor: CommercialActor): void {
  if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new CodingAgentExecutionError('Commercial operator role is required.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
