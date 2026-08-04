// @jataqi/automation — SOMA AI Intelligent Automation Engine (Phase 6).
// Public API.

export { AutomationModule, AutomationEvents } from './automation-module.js';
export type { AutomationModuleConfig } from './automation-module.js';
export { AutomationEngine } from './engine.js';
export type { RunAutomationInput } from './engine.js';
export { PlatformActionRunner } from './actions.js';
export type { ActionDeps } from './actions.js';
export type {
  Trigger, TriggerType, ScheduleTrigger, EventTrigger, ManualTrigger,
  ActionType, AutomationAction, Automation, ExecutionStatus, ActionResult,
  AutomationExecution, RunContext, ActionRunner, CreateAutomationInput,
  AutomationStats,
} from './types.js';
export { MAX_CHAIN_DEPTH, DEFAULT_TIMEOUT_MS } from './types.js';
