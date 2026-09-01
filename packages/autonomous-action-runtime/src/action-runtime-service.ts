import {
  CommercialControlPlaneError,
  CommercialControlPlaneService,
  type CommercialAction,
  type CommercialActor,
  type CommercialEvidence,
} from '@jataqi/commercial-control-plane';
import type {
  ActionExecutionAdapter,
  ActionExecutionContext,
  AdapterVerificationResult,
  RegisteredActionAdapter,
  RuntimeExecutionOptions,
  RuntimeExecutionResult,
  RuntimePlanInput,
} from './types.js';

const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ActionRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionRuntimeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Bounded execution facade over the Commercial Control Plane.
 *
 * The runtime owns adapter invocation only. Policy, approvals, tenant checks,
 * idempotency, state transitions, ledger records, and final verification state
 * remain controlled by CommercialControlPlaneService.
 */
export class ActionRuntimeService {
  private readonly adapters = new Map<string, ActionExecutionAdapter>();

  constructor(private readonly controlPlane: CommercialControlPlaneService) {}

  registerAdapter(adapter: ActionExecutionAdapter): void {
    validateAdapter(adapter);
    if (this.adapters.has(adapter.id)) throw new ActionRuntimeError(`Action adapter "${adapter.id}" is already registered.`);
    this.adapters.set(adapter.id, adapter);
  }

  unregisterAdapter(id: string): boolean {
    return this.adapters.delete(id);
  }

  listAdapters(): RegisteredActionAdapter[] {
    return [...this.adapters.values()]
      .map((adapter) => ({
        id: adapter.id,
        targetSystem: adapter.targetSystem,
        actionTypes: [...adapter.actionTypes],
        environment: adapter.environment,
        maxAttempts: normalizedAttempts(adapter.maxAttempts),
        defaultTimeoutMs: normalizedTimeout(adapter.defaultTimeoutMs),
        rollbackSupported: typeof adapter.rollback === 'function',
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Validate a registered capability before creating a persisted action plan. */
  async plan(actor: CommercialActor, decisionId: string, input: RuntimePlanInput): Promise<CommercialAction> {
    const decision = await this.controlPlane.getDecision(actor, decisionId);
    if (!decision) throw new ActionRuntimeError('Commercial decision not found.');
    const adapter = this.findAdapter(input.targetSystem, decision.actionType);
    if (!adapter) {
      throw new ActionRuntimeError(`No registered adapter supports ${decision.actionType} for target system "${input.targetSystem}".`);
    }
    if (input.rollbackStrategy && !adapter.rollback) {
      throw new ActionRuntimeError(`Adapter "${adapter.id}" does not support the requested rollback strategy.`);
    }
    return this.controlPlane.planAction(actor, decisionId, input);
  }

  /**
   * Execute a previously authorized action. A returned provider response only
   * changes the action to VERIFYING; callers must invoke verify() to reach
   * COMPLETED. Dry-run plans never invoke the registered adapter.
   */
  async execute(actor: CommercialActor, actionId: string, options: RuntimeExecutionOptions = {}): Promise<RuntimeExecutionResult> {
    let action = await this.requireAction(actor, actionId);
    const adapter = this.findAdapter(action.targetSystem, action.actionType);
    if (!adapter) {
      const cancelled = await this.controlPlane.cancelAction(actor, action.id, `No registered adapter supports ${action.actionType} for ${action.targetSystem}.`);
      return { action: cancelled, attempts: cancelled.attemptCount, executedExternally: false };
    }

    const attempts = Math.min(normalizedAttempts(options.maxAttempts), normalizedAttempts(adapter.maxAttempts));
    let last = action;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (last.executionStatus === 'FAILED') {
        last = await this.controlPlane.retryAction(actor, last.id, `Runtime retry ${attempt + 1} of ${attempts}.`);
      }
      if (last.executionStatus !== 'QUEUED' && last.executionStatus !== 'RETRYING') {
        throw new ActionRuntimeError(`Action ${last.id} cannot execute from ${last.executionStatus}.`);
      }

      const running = await this.controlPlane.startAction(actor, last.id);
      if (running.executionStatus === 'BLOCKED') return { action: running, adapterId: adapter.id, attempts: running.attemptCount, executedExternally: false };

      if (running.dryRun) {
        const simulated = await this.controlPlane.reportActionResult(actor, running.id, {
          reportedSuccess: true,
          summary: `Simulation completed by ${adapter.id}; no external operation was invoked.`,
          externalResponse: { mode: 'SIMULATED', adapterId: adapter.id },
          internalState: { dryRun: true },
        });
        return { action: simulated, adapterId: adapter.id, attempts: simulated.attemptCount, executedExternally: false };
      }

      const controller = new AbortController();
      const context: ActionExecutionContext = { action: running, actor, attempt: running.attemptCount, signal: controller.signal };
      try {
        const result = await withTimeout(adapter.execute(context), controller, options.timeoutMs ?? adapter.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, `Execution timed out for action ${running.id}.`);
        last = await this.controlPlane.reportActionResult(actor, running.id, result);
      } catch (error) {
        last = await this.controlPlane.reportActionResult(actor, running.id, {
          reportedSuccess: false,
          summary: errorMessage(error),
          externalResponse: { adapterId: adapter.id, errorType: error instanceof ActionRuntimeError ? 'timeout' : 'execution_error' },
        });
      }
      if (last.executionStatus === 'VERIFYING') {
        return { action: last, adapterId: adapter.id, attempts: last.attemptCount, executedExternally: true };
      }
    }
    return { action: last, adapterId: adapter.id, attempts: last.attemptCount, executedExternally: last.attemptCount > 0 };
  }

  /** Independently verify an action through its declared adapter capability. */
  async verify(actor: CommercialActor, actionId: string, timeoutMs?: number): Promise<CommercialAction> {
    const action = await this.requireAction(actor, actionId);
    if (action.executionStatus !== 'VERIFYING') throw new ActionRuntimeError(`Action ${action.id} is not awaiting verification.`);
    const adapter = this.findAdapter(action.targetSystem, action.actionType);
    if (!adapter) throw new ActionRuntimeError(`No registered adapter can verify action ${action.id}.`);

    const controller = new AbortController();
    const context: ActionExecutionContext = { action, actor, attempt: action.attemptCount, signal: controller.signal };
    let verification: AdapterVerificationResult;
    try {
      verification = await withTimeout(adapter.verify(context), controller, timeoutMs ?? adapter.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, `Verification timed out for action ${action.id}.`);
    } catch (error) {
      verification = {
        verified: false,
        summary: errorMessage(error),
        evidence: [runtimeFailureEvidence(action, errorMessage(error))],
        externalState: { adapterId: adapter.id, verificationError: true },
      };
    }
    return this.controlPlane.verifyAction(actor, action.id, verification);
  }

  /**
   * Request adapter rollback and record only the adapter-confirmed outcome.
   * A failed/unavailable rollback becomes an explicit escalated state.
   */
  async rollback(actor: CommercialActor, actionId: string, timeoutMs?: number): Promise<CommercialAction> {
    const action = await this.requireAction(actor, actionId);
    const adapter = this.findAdapter(action.targetSystem, action.actionType);
    if (!adapter?.rollback) {
      return this.controlPlane.recordRollback(actor, action.id, false, 'No registered adapter rollback capability is available.');
    }
    const controller = new AbortController();
    try {
      const result = await withTimeout(adapter.rollback({ action, actor, signal: controller.signal }), controller, timeoutMs ?? adapter.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, `Rollback timed out for action ${action.id}.`);
      return this.controlPlane.recordRollback(actor, action.id, result.confirmed, result.summary ?? 'Adapter rollback result recorded.');
    } catch (error) {
      return this.controlPlane.recordRollback(actor, action.id, false, errorMessage(error));
    }
  }

  async getAction(actor: CommercialActor, actionId: string): Promise<CommercialAction | undefined> {
    return this.controlPlane.getAction(actor, actionId);
  }

  async getDecision(actor: CommercialActor, decisionId: string) {
    return this.controlPlane.getDecision(actor, decisionId);
  }

  private async requireAction(actor: CommercialActor, actionId: string): Promise<CommercialAction> {
    const action = await this.controlPlane.getAction(actor, actionId);
    if (!action) throw new ActionRuntimeError('Commercial action not found.');
    return action;
  }

  private findAdapter(targetSystem: string, actionType: string): ActionExecutionAdapter | undefined {
    return [...this.adapters.values()]
      .filter((adapter) => adapter.targetSystem === targetSystem && adapter.actionTypes.includes(actionType))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
  }
}

function validateAdapter(adapter: ActionExecutionAdapter): void {
  if (!adapter.id?.trim()) throw new ActionRuntimeError('Action adapter id is required.');
  if (!adapter.targetSystem?.trim()) throw new ActionRuntimeError('Action adapter target system is required.');
  if (!Array.isArray(adapter.actionTypes) || adapter.actionTypes.length === 0 || adapter.actionTypes.some((actionType) => !actionType.trim())) {
    throw new ActionRuntimeError('Action adapter must declare one or more supported action types.');
  }
  if (adapter.environment !== 'sandbox' && adapter.environment !== 'production') throw new ActionRuntimeError('Action adapter environment must be sandbox or production.');
  normalizedAttempts(adapter.maxAttempts);
  normalizedTimeout(adapter.defaultTimeoutMs);
}

function normalizedAttempts(value: number | undefined): number {
  const attempts = value ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new ActionRuntimeError(`Action retry limit must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  return attempts;
}

function normalizedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300_000) throw new ActionRuntimeError('Action timeout must be between 1ms and 300000ms.');
  return timeout;
}

async function withTimeout<T>(promise: Promise<T>, controller: AbortController, timeoutMs: number, message: string): Promise<T> {
  const timeout = normalizedTimeout(timeoutMs);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ActionRuntimeError(message));
    }, timeout);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function runtimeFailureEvidence(action: CommercialAction, summary: string): CommercialEvidence {
  const now = Date.now();
  return {
    id: `runtime-verification-failure:${action.id}:${action.attemptCount}`,
    status: 'OBSERVED',
    source: 'autonomous-action-runtime',
    observedAt: now,
    confidence: 100,
    summary: `Verification execution failure observed: ${summary}`,
    provenance: { source: 'autonomous-action-runtime', collectedAt: now, correlationId: action.correlationId, causationId: action.id },
    privacyClassification: 'INTERNAL',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
