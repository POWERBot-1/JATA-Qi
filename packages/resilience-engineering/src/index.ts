// @jataqi/resilience-engineering — Global Resilience Engineering. Public API.

export { ResilienceEngineeringModule, ResilienceEvents, DEFAULT_RECOVERY_STEPS, DEFAULT_TOPOLOGY } from './resilience-engineering-module.js';
export type { DrSnapshotProvider } from './resilience-engineering-module.js';
export { ResilienceEngine } from './engine.js';
export type {
  RegionRole, RegionHealth, RegionTopology,
  FailoverStatus, FailoverRun,
  RecoveryPlanStep, RecoveryPlan, DrExecution,
  FaultKind, FaultInjection,
  AvailabilityRecord, ProbeResult,
} from './types.js';
