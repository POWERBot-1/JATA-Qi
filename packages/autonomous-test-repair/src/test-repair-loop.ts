import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import type { ActionExecutionAdapter } from '@jataqi/autonomous-action-runtime';
import type { CommercialAction, CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import {
  TestRepairActionType,
  type CreateRepairProposalInput,
  type CreateTestRepairRunInput,
  type RegisteredTestRepairWorker,
  type RepairDiagnostic,
  type RepairProposal,
  type StartTestRepairRunInput,
  type TestRepairResult,
  type TestRepairRun,
  type TestRepairWorker,
} from './types.js';

const RUNS_COLLECTION = 'autonomous-test-repair.runs';
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

export class TestRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestRepairError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Governed build/test/repair coordinator. It captures verified runner evidence
 * and produces repair proposals, but intentionally has no API to apply a patch,
 * change a branch, merge code, or override security results.
 */
export class TestRepairLoop {
  private runs!: ICollection<TestRepairRun>;
  private runtime!: ActionRuntimeService;
  private readonly workers = new Map<string, TestRepairWorker>();
  private readonly adapterIds = new Map<string, string>();
  private readonly results = new Map<string, TestRepairResult>();

  async init(kernel: KernelApi, runtime: ActionRuntimeService): Promise<void> {
    this.runs = await kernel.getModule<StorageModule>('storage').collection<TestRepairRun>(RUNS_COLLECTION);
    this.runtime = runtime;
  }

  registerWorker(actor: CommercialActor, worker: TestRepairWorker): RegisteredTestRepairWorker {
    assertAdministrator(actor);
    validateWorker(worker);
    if (worker.tenantId && worker.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new TestRepairError('Cross-tenant test worker registration is not authorized.');
    if (this.workers.has(worker.id)) throw new TestRepairError(`Test/repair worker "${worker.id}" is already registered.`);

    const adapter: ActionExecutionAdapter = {
      id: `test-repair:${worker.id}`,
      targetSystem: targetSystem(worker.id),
      actionTypes: [TestRepairActionType],
      environment: 'sandbox',
      maxAttempts: normalizedAttempts(worker.maxAttempts),
      defaultTimeoutMs: normalizedTimeout(worker.defaultTimeoutMs),
      execute: async (context) => {
        const run = await this.runForAction(context.action);
        const output = await worker.execute({ run, action: context.action, actor: context.actor, signal: context.signal });
        if (output.testRepairResult) {
          const result: TestRepairResult = { ...copy(output.testRepairResult), completedAt: Date.now() };
          this.results.set(context.action.id, result);
          const allPassed = checksPass(result);
          return {
            ...output,
            reportedSuccess: output.reportedSuccess && allPassed,
            summary: output.summary ?? result.summary,
          };
        }
        return output;
      },
      verify: async (context) => {
        const run = await this.runForAction(context.action);
        return worker.verify({ run, action: context.action, actor: context.actor, signal: context.signal });
      },
      rollback: worker.rollback ? (context) => worker.rollback!(context) : undefined,
    };
    this.runtime.registerAdapter(adapter);
    this.workers.set(worker.id, worker);
    this.adapterIds.set(worker.id, adapter.id);
    return workerMetadata(worker, actor.tenantId);
  }

  async createRun(actor: CommercialActor, input: CreateTestRepairRunInput): Promise<TestRepairRun> {
    assertManager(actor);
    validateRunInput(input);
    const now = Date.now();
    const run: TestRepairRun = {
      id: randomUUID(), tenantId: actor.tenantId, ventureId: input.ventureId, productId: input.productId, taskId: input.taskId,
      request: { ...copy(input.request), requiredChecks: [...input.request.requiredChecks] }, maxAttempts: normalizedAttempts(input.maxAttempts),
      attemptCount: 0, state: 'DRAFT', diagnostics: [], proposals: [], verificationEvidence: [], createdAt: now, updatedAt: now,
    };
    await this.runs.put(run);
    return copy(run);
  }

  async assignWorker(actor: CommercialActor, runId: string, workerId: string): Promise<TestRepairRun> {
    assertManager(actor);
    const run = await this.requireRun(actor, runId);
    if (!['DRAFT', 'FAILED', 'ESCALATED'].includes(run.state)) throw new TestRepairError(`Run ${run.id} cannot be assigned from ${run.state}.`);
    const worker = this.workers.get(workerId);
    if (!worker || (worker.tenantId && !canRead(actor, worker.tenantId))) throw new TestRepairError('Test/repair worker not found.');
    if (!worker.profiles.includes(run.request.profile)) throw new TestRepairError(`Worker does not support profile "${run.request.profile}".`);
    const updated: TestRepairRun = { ...run, workerId, state: 'QUEUED', failureReason: undefined, updatedAt: Date.now() };
    await this.runs.put(updated);
    return copy(updated);
  }

  /** Run through the action runtime; raw commands are never accepted here. */
  async executeRun(actor: CommercialActor, runId: string, input: StartTestRepairRunInput): Promise<TestRepairRun> {
    assertManager(actor);
    const run = await this.requireRun(actor, runId);
    if (!['QUEUED', 'PATCH_TESTING', 'REGRESSION_CHECKING'].includes(run.state)) throw new TestRepairError(`Run ${run.id} is not queued for execution.`);
    if (!run.workerId) throw new TestRepairError('Run has no assigned test/repair worker.');
    const worker = this.workers.get(run.workerId);
    if (!worker) throw new TestRepairError('Assigned test/repair worker is not registered.');
    const action = run.actionId
      ? await this.runtime.getAction(actor, run.actionId)
      : await this.runtime.plan(actor, input.decisionId, {
          targetSystem: targetSystem(worker.id),
          idempotencyKey: input.idempotencyKey,
          dryRun: input.dryRun,
          parameters: { runId: run.id, profile: run.request.profile, target: run.request.target, requiredChecks: run.request.requiredChecks },
        });
    if (!action) throw new TestRepairError('Test/repair action could not be planned.');

    const running: TestRepairRun = { ...run, actionId: action.id, state: 'TESTING', attemptCount: action.attemptCount, updatedAt: Date.now() };
    await this.runs.put(running);
    const execution = await this.runtime.execute(actor, action.id, { maxAttempts: run.maxAttempts, timeoutMs: run.request.timeoutMs ?? worker.defaultTimeoutMs });
    const result = this.results.get(action.id);
    const state = runStateFromAction(execution.action.executionStatus, result);
    const updated: TestRepairRun = {
      ...running,
      state,
      attemptCount: execution.action.attemptCount,
      result: result ?? running.result,
      failureReason: execution.action.error,
      diagnostics: state === 'FAILED' && result ? [...running.diagnostics, diagnosticFromResult(result)] : running.diagnostics,
      updatedAt: Date.now(),
    };
    await this.runs.put(updated);
    return copy(updated);
  }

  /** Complete only after runner verification evidence passes through the action runtime. */
  async verifyRun(actor: CommercialActor, runId: string): Promise<TestRepairRun> {
    assertManager(actor);
    const run = await this.requireRun(actor, runId);
    if (run.state !== 'VERIFYING' || !run.actionId) throw new TestRepairError('Run is not awaiting verification.');
    const action = await this.runtime.verify(actor, run.actionId);
    const state = action.executionStatus === 'COMPLETED' ? 'VERIFIED' : 'FAILED';
    const updated: TestRepairRun = {
      ...run,
      state,
      attemptCount: action.attemptCount,
      verificationEvidence: copy(action.verificationEvidence),
      failureReason: action.error,
      completedAt: state === 'VERIFIED' ? Date.now() : undefined,
      diagnostics: state === 'FAILED' ? [...run.diagnostics, runtimeFailureDiagnostic(action)] : run.diagnostics,
      updatedAt: Date.now(),
    };
    await this.runs.put(updated);
    return copy(updated);
  }

  /** Failure diagnosis is persistent evidence, not an invisible retry reason. */
  async addDiagnostic(actor: CommercialActor, runId: string, input: Omit<RepairDiagnostic, 'id' | 'createdAt'>): Promise<TestRepairRun> {
    assertManager(actor);
    const run = await this.requireRun(actor, runId);
    if (!['FAILED', 'DIAGNOSING', 'ESCALATED'].includes(run.state)) throw new TestRepairError('Diagnostics may only be added after a failure or escalation.');
    if (!input.summary.trim() || !input.evidence.length) throw new TestRepairError('A diagnostic requires a summary and supporting evidence.');
    const diagnostic: RepairDiagnostic = { ...copy(input), id: randomUUID(), createdAt: Date.now() };
    const updated: TestRepairRun = { ...run, state: 'DIAGNOSING', diagnostics: [...run.diagnostics, diagnostic], updatedAt: Date.now() };
    await this.runs.put(updated);
    return copy(updated);
  }

  /** Records a patch proposal, but never applies it. An approval/review flow owns that later step. */
  async proposeRepair(actor: CommercialActor, runId: string, input: CreateRepairProposalInput): Promise<TestRepairRun> {
    assertManager(actor);
    const run = await this.requireRun(actor, runId);
    if (!['FAILED', 'DIAGNOSING', 'ESCALATED'].includes(run.state)) throw new TestRepairError('A repair proposal requires a failed or diagnosed run.');
    if (!input.patchReference.trim() || !input.summary.trim() || !input.testPlan.length || !input.evidence.length) throw new TestRepairError('Repair proposals require a patch reference, summary, test plan, and evidence.');
    const proposal: RepairProposal = {
      id: randomUUID(), runId: run.id, patchReference: input.patchReference, summary: input.summary, risk: input.risk,
      testPlan: [...input.testPlan], requiresApproval: input.requiresApproval ?? true, createdBy: actor.id, createdAt: Date.now(),
    };
    const updated: TestRepairRun = { ...run, state: 'PATCH_PROPOSED', proposals: [...run.proposals, proposal], updatedAt: Date.now() };
    await this.runs.put(updated);
    return copy(updated);
  }

  /** Explicitly schedule validation of an externally reviewed patch reference. */
  async queuePatchValidation(actor: CommercialActor, runId: string): Promise<TestRepairRun> {
    assertManager(actor);
    const run = await this.requireRun(actor, runId);
    const latest = run.proposals.at(-1);
    if (!latest) throw new TestRepairError('No repair proposal exists.');
    if (latest.requiresApproval) throw new TestRepairError('Repair proposal requires external approval before patch validation.');
    const updated: TestRepairRun = { ...run, state: 'PATCH_TESTING', actionId: undefined, updatedAt: Date.now() };
    await this.runs.put(updated);
    return copy(updated);
  }

  async getRun(actor: CommercialActor, runId: string): Promise<TestRepairRun | undefined> {
    const run = await this.runs.get(runId);
    return run && canRead(actor, run.tenantId) ? copy(run) : undefined;
  }

  async listRuns(actor: CommercialActor): Promise<TestRepairRun[]> {
    return (await this.runs.all()).filter((run) => canRead(actor, run.tenantId)).map(copy);
  }

  private async requireRun(actor: CommercialActor, runId: string): Promise<TestRepairRun> {
    const run = await this.getRun(actor, runId);
    if (!run) throw new TestRepairError('Test/repair run not found.');
    return run;
  }

  private async runForAction(action: CommercialAction): Promise<TestRepairRun> {
    const runId = action.parameters.runId;
    if (typeof runId !== 'string') throw new TestRepairError('Action does not identify a test/repair run.');
    const run = await this.runs.get(runId);
    if (!run || run.tenantId !== action.tenantId) throw new TestRepairError('Test/repair run does not belong to the action tenant.');
    return run;
  }
}

function checksPass(result: TestRepairResult): boolean {
  return [...result.build, ...result.tests, ...result.security, ...result.regression].every((check) => check.passed);
}

function diagnosticFromResult(result: TestRepairResult): RepairDiagnostic {
  const failed = [...result.build, ...result.tests, ...result.security, ...result.regression].filter((check) => !check.passed);
  const now = Date.now();
  return {
    id: randomUUID(),
    category: failed.some((check) => result.security.includes(check)) ? 'SECURITY' : failed.some((check) => result.regression.includes(check)) ? 'REGRESSION' : failed.some((check) => result.build.includes(check)) ? 'BUILD' : 'TEST',
    summary: failed.map((check) => `${check.name}: ${check.detail ?? 'failed'}`).join('; ') || result.summary,
    evidence: [{
      id: `test-repair-result:${now}`,
      status: 'OBSERVED',
      source: 'autonomous-test-repair',
      observedAt: now,
      confidence: 100,
      summary: 'Runner reported failed checks.',
      provenance: { source: 'autonomous-test-repair', collectedAt: now },
      privacyClassification: 'INTERNAL',
    }],
    createdAt: now,
  };
}

function runtimeFailureDiagnostic(action: CommercialAction): RepairDiagnostic {
  const now = Date.now();
  return {
    id: randomUUID(), category: 'UNKNOWN', summary: action.error ?? 'Action verification failed.', createdAt: now,
    evidence: [{ id: `test-repair-verification:${action.id}`, status: 'OBSERVED', source: 'autonomous-test-repair', observedAt: now, confidence: 100, summary: action.error ?? 'Action verification failed.', provenance: { source: 'autonomous-test-repair', collectedAt: now, causationId: action.id }, privacyClassification: 'INTERNAL' }],
  };
}

function runStateFromAction(status: CommercialAction['executionStatus'], result: TestRepairResult | undefined): TestRepairRun['state'] {
  if (status === 'VERIFYING') return 'VERIFYING';
  if (status === 'COMPLETED') return 'VERIFIED';
  if (status === 'BLOCKED') return 'ESCALATED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'FAILED' && result && !checksPass(result)) return 'FAILED';
  return 'FAILED';
}

function targetSystem(workerId: string): string {
  return `test-repair:${workerId}`;
}

function workerMetadata(worker: TestRepairWorker, fallbackTenantId: string): RegisteredTestRepairWorker {
  return { id: worker.id, tenantId: worker.tenantId ?? fallbackTenantId, profiles: [...worker.profiles], environment: worker.environment, maxAttempts: normalizedAttempts(worker.maxAttempts), defaultTimeoutMs: normalizedTimeout(worker.defaultTimeoutMs) };
}

function validateRunInput(input: CreateTestRepairRunInput): void {
  if (!input.request.profile.trim() || !input.request.target.trim()) throw new TestRepairError('Test execution profile and target are required.');
  if (!input.request.requiredChecks.length) throw new TestRepairError('At least one required test check must be declared.');
  if (input.request.timeoutMs !== undefined) normalizedTimeout(input.request.timeoutMs);
  normalizedAttempts(input.maxAttempts);
}

function validateWorker(worker: TestRepairWorker): void {
  if (!worker.id.trim() || !worker.profiles.length || worker.profiles.some((profile) => !profile.trim())) throw new TestRepairError('Worker id and supported profiles are required.');
  if (worker.environment !== 'sandbox' && worker.environment !== 'controlled') throw new TestRepairError('Test/repair worker environment must be sandbox or controlled.');
  normalizedAttempts(worker.maxAttempts);
  normalizedTimeout(worker.defaultTimeoutMs);
}

function normalizedAttempts(value: number | undefined): number {
  const attempts = value ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new TestRepairError(`Maximum attempts must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  return attempts;
}

function normalizedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600_000) throw new TestRepairError('Test/repair timeout must be between 1ms and 600000ms.');
  return timeout;
}

function assertAdministrator(actor: CommercialActor): void {
  if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new TestRepairError('Commercial administrator role is required.');
}

function assertManager(actor: CommercialActor): void {
  if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new TestRepairError('Commercial operator role is required.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
