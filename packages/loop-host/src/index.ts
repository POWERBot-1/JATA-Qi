export { LoopHostModule } from './module.js';
export { LoopHostService, type LoopRunner, type LoopHostConfig } from './host-service.js';
export { WorkQueue, WORK_COLLECTION, computeBackoffMs } from './work-queue.js';
export { CheckpointJournal, CHECKPOINT_COLLECTION, canonicalJson, sha256Hex, fingerprintTask } from './checkpoints.js';
export { isDispatchEligible, isReclaimable, nextWakeInMs } from './scheduler.js';
export { LoopHostEvents, LOOP_HOST_CHECKPOINT_SCHEMA_VERSION } from './types.js';
export {
  LoopHostError,
  TenantIsolationError,
  StaleLeaseError,
  LeaseConflictError,
  CheckpointIntegrityError,
  IncompatibleCheckpointError,
  InvalidWorkTransitionError,
  HostLifecycleError,
} from './types.js';
export type {
  HostedWorkItem,
  HostedWorkStatus,
  LoopCheckpoint,
  CheckpointPhase,
  EnqueueWorkInput,
  WorkSettlement,
  DispatchFailureClass,
  HostLifecycle,
  TickSummary,
  RecoverSummary,
  LoopHostAuditEvent,
} from './types.js';
