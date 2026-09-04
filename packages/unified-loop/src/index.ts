export { UnifiedLoopModule } from './module.js';
export { UnifiedLoopService } from './unified-loop-service.js';
export type { RunLoopOptions } from './unified-loop-service.js';
export { CapabilityRegistry } from './capability-registry.js';
export { buildDefaultCapabilities } from './capability-adapters.js';
export {
  LoopStateMachine,
  LOOP_STAGES,
  GOVERNANCE_GATE_STAGES,
  MANDATORY_FOR_ACTION,
  ALWAYS_MANDATORY,
  auditMandatoryStages,
} from './state-machine.js';
export type { MandatoryStageAudit } from './state-machine.js';
export { UnifiedLoopError, InvalidTransitionError, UnifiedLoopEvents } from './types.js';
export type {
  LoopStage,
  StageStatus,
  LoopTask,
  ProposedAction,
  LoopRunResult,
  LoopOutcome,
  StageTraceEntry,
  CognitiveRecord,
  CognitiveRecordKind,
  GovernedCapability,
  CapabilityInvocationContext,
  CapabilityResult,
  SideEffectClass,
  AuthorityRequirement,
  LoopWorkingState,
  LoopAuditEvent,
} from './types.js';
