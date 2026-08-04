// SOMA AI Intelligent Automation Engine (Phase 6) — types.
//
// An automation pairs a trigger (schedule / bus event / manual) with an
// ordered list of actions. Executions are recorded with per-action results,
// concurrency caps, and timeouts, so automation is observable and safe.

/** How an automation is activated. */
export type TriggerType = 'schedule' | 'event' | 'manual';

export interface ScheduleTrigger {
  type: 'schedule';
  /** Minimum interval between runs, in milliseconds. */
  intervalMs: number;
}

export interface EventTrigger {
  type: 'event';
  /** Kernel bus event name that activates the automation. */
  event: string;
  /** Optional payload field equality filter, e.g. { field: 'severity', value: 'critical' }. */
  filter?: { field: string; value: string };
}

export interface ManualTrigger {
  type: 'manual';
}

export type Trigger = ScheduleTrigger | EventTrigger | ManualTrigger;

/** Built-in automation action types. */
export type ActionType =
  | 'memory.record'
  | 'notification.send'
  | 'knowledge.ingest'
  | 'agent.run'
  | 'tool.invoke'
  | 'automation.run';

export interface AutomationAction {
  type: ActionType;
  /** Action-specific parameters (see ActionRunner for shapes). */
  params: Record<string, unknown>;
  /** Optional label for logs. */
  name?: string;
  /** When true, execution continues to the next action on failure. */
  continueOnError?: boolean;
}

export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'skipped';

export interface Automation {
  id: string;
  name: string;
  description?: string;
  trigger: Trigger;
  actions: AutomationAction[];
  enabled: boolean;
  tags?: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  lastRunAt?: number;
  lastStatus?: ExecutionStatus;
  /** Max in-flight runs before new activations are skipped (default 1). */
  maxConcurrency?: number;
  /** Per-run timeout in ms (default 30_000). */
  timeoutMs?: number;
}

export interface ActionResult {
  action: string;
  status: 'ok' | 'error';
  detail?: string;
  durationMs: number;
}

export interface AutomationExecution {
  id: string;
  automationId: string;
  trigger: TriggerType;
  status: ExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  results: ActionResult[];
  error?: string;
  payload?: Record<string, unknown>;
}

/** Per-run context passed to the action runner (payload + chain depth). */
export interface RunContext {
  payload?: Record<string, unknown>;
  /** Automation chaining depth (guarded at MAX_CHAIN_DEPTH). */
  depth?: number;
}

/** Executes a single automation action. Implementations wire platform modules. */
export interface ActionRunner {
  run(action: AutomationAction, ctx: RunContext): Promise<ActionResult>;
}

export interface CreateAutomationInput {
  name: string;
  description?: string;
  trigger: Trigger;
  actions: AutomationAction[];
  enabled?: boolean;
  tags?: string[];
  createdBy: string;
  maxConcurrency?: number;
  timeoutMs?: number;
}

export interface AutomationStats {
  total: number;
  enabled: number;
  disabled: number;
  executions: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  skipped: number;
  byTrigger: Record<TriggerType, number>;
  byStatus: Record<ExecutionStatus, number>;
}

/** Maximum depth for automation→automation chaining. */
export const MAX_CHAIN_DEPTH = 3;
/** Default per-run timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;
