// AutomationEngine — registry + execution engine for SOMA AI (Phase 6).
//
// Responsibilities:
//   - register/unregister/enable/disable automations with trigger validation
//   - run automations with sequential actions, per-action results, per-run
//     timeout (Promise.race), and concurrency caps
//   - tick() for schedule triggers (deterministic, test-friendly)
//   - handleEvent() for bus-event triggers with payload filtering
//   - execution history (bounded) + aggregate stats
//
// The engine is pure — all platform side effects go through the injected
// ActionRunner, so the engine is fully unit-testable.

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TIMEOUT_MS, MAX_CHAIN_DEPTH,
} from './types.js';
import type {
  ActionRunner, ActionResult, Automation, AutomationExecution, AutomationStats,
  CreateAutomationInput, ExecutionStatus, RunContext, TriggerType,
} from './types.js';

const MAX_EXECUTIONS = 500;

export interface RunAutomationInput {
  automationId: string;
  trigger?: TriggerType;
  payload?: Record<string, unknown>;
  /** Chaining depth (guarded at MAX_CHAIN_DEPTH). */
  depth?: number;
}

export class AutomationEngine {
  private automations = new Map<string, Automation>();
  private executions: AutomationExecution[] = [];
  /** schedule trigger → next activation timestamp. */
  private nextRunAt = new Map<string, number>();

  constructor(private readonly runner: ActionRunner) {}

  // ---- registry ----------------------------------------------------------

  register(input: CreateAutomationInput): Automation {
    validateInput(input);
    const now = Date.now();
    const automation: Automation = {
      id: randomUUID(),
      name: input.name.trim(),
      ...(input.description ? { description: input.description } : {}),
      trigger: input.trigger,
      actions: [...input.actions],
      enabled: input.enabled !== false,
      ...(input.tags?.length ? { tags: [...input.tags] } : {}),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };
    this.automations.set(automation.id, automation);
    if (automation.trigger.type === 'schedule') {
      this.nextRunAt.set(automation.id, now + automation.trigger.intervalMs);
    }
    return automation;
  }

  unregister(id: string): boolean {
    this.nextRunAt.delete(id);
    return this.automations.delete(id);
  }

  get(id: string): Automation | undefined {
    return this.automations.get(id);
  }

  list(filter?: { enabled?: boolean; trigger?: TriggerType }): Automation[] {
    const all = [...this.automations.values()];
    return all.filter((a) =>
      (filter?.enabled === undefined || a.enabled === filter.enabled) &&
      (filter?.trigger === undefined || a.trigger.type === filter.trigger));
  }

  setEnabled(id: string, enabled: boolean): Automation | undefined {
    const automation = this.automations.get(id);
    if (!automation) return undefined;
    automation.enabled = enabled;
    automation.updatedAt = Date.now();
    if (enabled && automation.trigger.type === 'schedule' && !this.nextRunAt.has(id)) {
      this.nextRunAt.set(id, Date.now() + automation.trigger.intervalMs);
    }
    if (!enabled) this.nextRunAt.delete(id);
    return automation;
  }

  // ---- execution ---------------------------------------------------------

  /** Run an automation (manual / event / schedule). Returns the execution. */
  async run(input: RunAutomationInput): Promise<AutomationExecution> {
    const automation = this.automations.get(input.automationId);
    const trigger = input.trigger ?? 'manual';
    if (!automation) return skippedExecution('missing', trigger, 'automation not found');
    if (!automation.enabled) return skippedExecution(automation.id, trigger, 'automation is disabled');

    // Concurrency cap.
    const inFlight = this.executions.filter((e) => e.automationId === automation.id && e.status === 'running').length;
    const cap = automation.maxConcurrency ?? 1;
    if (inFlight >= cap) return skippedExecution(automation.id, trigger, `concurrency cap (${cap}) reached`);

    const timeoutMs = automation.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const execution: AutomationExecution = {
      id: randomUUID(),
      automationId: automation.id,
      trigger,
      status: 'running',
      startedAt,
      results: [],
      ...(input.payload ? { payload: input.payload } : {}),
    };
    this.record(execution);

    automation.runCount += 1;
    automation.lastRunAt = startedAt;
    automation.lastStatus = 'running';

    const ctx: RunContext = { ...(input.payload ? { payload: input.payload } : {}), ...(input.depth !== undefined ? { depth: input.depth } : {}) };

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<AutomationExecution>((resolve) => {
      timeoutHandle = setTimeout(() => {
        execution.status = 'timeout';
        execution.finishedAt = Date.now();
        execution.durationMs = execution.finishedAt - startedAt;
        execution.error = `timed out after ${timeoutMs}ms`;
        automation.lastStatus = 'timeout';
        resolve(execution);
      }, timeoutMs);
    });

    const work = (async (): Promise<AutomationExecution> => {
      for (const action of automation.actions) {
        const actionStarted = Date.now();
        try {
          const result = await this.runner.run(action, ctx);
          execution.results.push({ ...result, action: action.name ?? action.type });
          if (result.status === 'error' && action.continueOnError !== true) {
            execution.status = 'failed';
            execution.error = `action ${action.type} failed: ${result.detail ?? 'unknown error'}`;
            break;
          }
        } catch (err) {
          const result: ActionResult = { action: action.name ?? action.type, status: 'error', detail: (err as Error).message, durationMs: Date.now() - actionStarted };
          execution.results.push(result);
          if (action.continueOnError !== true) {
            execution.status = 'failed';
            execution.error = `action ${action.type} threw: ${(err as Error).message}`;
            break;
          }
        }
      }
      if (execution.status === 'running') execution.status = 'succeeded';
      execution.finishedAt = Date.now();
      execution.durationMs = execution.finishedAt - startedAt;
      automation.lastStatus = execution.status;
      return execution;
    })();

    const finished = await Promise.race([work, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return finished;
  }

  /** Activate due schedule automations (deterministic when `now` is passed). */
  async tick(now = Date.now()): Promise<AutomationExecution[]> {
    const due: Automation[] = [];
    for (const [id, at] of this.nextRunAt) {
      const automation = this.automations.get(id);
      if (automation && automation.enabled && at <= now) due.push(automation);
    }
    const runs: AutomationExecution[] = [];
    for (const automation of due) {
      if (automation.trigger.type !== 'schedule') continue;
      this.nextRunAt.set(automation.id, now + automation.trigger.intervalMs);
      const execution = await this.run({ automationId: automation.id, trigger: 'schedule' });
      runs.push(execution);
    }
    return runs;
  }

  /** Activate automations subscribed to a bus event, honoring filters. */
  handleEvent(eventName: string, payload: unknown): number {
    const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    let activated = 0;
    for (const automation of this.automations.values()) {
      if (!automation.enabled || automation.trigger.type !== 'event') continue;
      if (automation.trigger.event !== eventName) continue;
      const f = automation.trigger.filter;
      if (f && String(p[f.field] ?? '') !== String(f.value)) continue;
      // Fire-and-forget (the module owns the promise chain).
      void this.run({ automationId: automation.id, trigger: 'event', payload: p });
      activated += 1;
    }
    return activated;
  }

  executionsList(filter?: { automationId?: string; status?: ExecutionStatus }): AutomationExecution[] {
    const all = [...this.executions].reverse();
    return all.filter((e) =>
      (!filter?.automationId || e.automationId === filter.automationId) &&
      (!filter?.status || e.status === filter.status));
  }

  stats(): AutomationStats {
    const byTrigger: Record<TriggerType, number> = { schedule: 0, event: 0, manual: 0 };
    const byStatus: Record<ExecutionStatus, number> = { pending: 0, running: 0, succeeded: 0, failed: 0, timeout: 0, skipped: 0 };
    for (const a of this.automations.values()) byTrigger[a.trigger.type] += 1;
    for (const e of this.executions) byStatus[e.status] += 1;
    return {
      total: this.automations.size,
      enabled: [...this.automations.values()].filter((a) => a.enabled).length,
      disabled: [...this.automations.values()].filter((a) => !a.enabled).length,
      executions: this.executions.length,
      succeeded: byStatus.succeeded,
      failed: byStatus.failed,
      timedOut: byStatus.timeout,
      skipped: byStatus.skipped,
      byTrigger,
      byStatus,
    };
  }

  /** Guard used by the module for chained automation runs. */
  static chainDepthOk(depth: number): boolean {
    return depth <= MAX_CHAIN_DEPTH;
  }

  // ---- internals ---------------------------------------------------------

  private record(execution: AutomationExecution): void {
    this.executions.push(execution);
    if (this.executions.length > MAX_EXECUTIONS) {
      this.executions.splice(0, this.executions.length - MAX_EXECUTIONS);
    }
  }
}

function skippedExecution(automationId: string, trigger: TriggerType, reason: string): AutomationExecution {
  const now = Date.now();
  return {
    id: randomUUID(),
    automationId,
    trigger,
    status: 'skipped',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    results: [],
    error: reason,
  };
}

function validateInput(input: CreateAutomationInput): void {
  if (!input.name || !input.name.trim()) throw new Error('automation name is required');
  if (!input.actions || input.actions.length === 0) throw new Error('automation requires at least one action');
  for (const a of input.actions) {
    if (!a.type) throw new Error('action type is required');
  }
  const t = input.trigger;
  if (t.type === 'schedule') {
    if (!Number.isFinite(t.intervalMs) || t.intervalMs <= 0) throw new Error('schedule trigger requires intervalMs > 0');
  } else if (t.type === 'event') {
    if (!t.event || !t.event.trim()) throw new Error('event trigger requires an event name');
  }
}
