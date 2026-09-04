// O-01 durable continuous-operation host — type definitions.
//
// The host is a DRIVER/VALET, not a second brain. It owns WHEN eligible work
// may be dispatched (schedules, queues, leases, checkpoints, retries, DLQ)
// and delegates WHAT is thought/decided/authorized/executed to the existing
// governed unified loop, commercial control plane, and action runtime.
//
// Durability honesty: checkpoints and queue records persist through the
// *available* storage abstraction (memory or development-only single-process
// filesystem). That yields crash *detection* plus deterministic
// resume-or-fail-closed semantics — NOT production-grade transactional,
// multi-process, or zero-loss durability. Those remain future P-01 scope.

import type { CommercialActor } from '@jataqi/commercial-control-plane';
import type { LoopOutcome, LoopTask } from '@jataqi/unified-loop';

/** Schema version for O-01 checkpoint records. Bump only with migration logic. */
export const LOOP_HOST_CHECKPOINT_SCHEMA_VERSION = 1;

/** Lifecycle of one unit of hosted work. */
export type HostedWorkStatus =
  | 'QUEUED' // eligible for dispatch once availableAt is reached
  | 'SLEEPING' // parked by SLEEP_PENDING or operator; wakes at availableAt
  | 'LEASED' // a lease holder owns exclusive dispatch rights
  | 'DISPATCHED' // handed to the unified loop; awaiting settlement
  | 'COMPLETED' // loop reported a verified/dry-run completion (recorded, not granted, by the host)
  | 'HELD' // loop reported HELD_AT_GATE; resumes only via explicit operator resume
  | 'DENIED' // loop reported DENIED; terminal, never retried
  | 'DLQ'; // dead-lettered after bounded retries or unrecoverable state

/** Phase captured by a checkpoint record. */
export type CheckpointPhase = 'DISPATCHED' | 'SETTLED';

/** One unit of tenant-scoped hosted work. */
export interface HostedWorkItem {
  id: string;
  tenantId: string;
  correlationId: string;
  /** Idempotency identity: re-enqueue with the same key returns this record. */
  idempotencyKey: string;
  /** The loop task to dispatch. Re-dispatched whole on every attempt/resume. */
  task: LoopTask;
  /** Authenticated actor snapshot captured at enqueue; continuity, not re-auth. */
  actor: Pick<CommercialActor, 'id' | 'tenantId' | 'roles'>;
  status: HostedWorkStatus;
  attemptCount: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  createdAt: number;
  updatedAt: number;
  /** Earliest time the item may be dispatched (schedule / backoff / sleep). */
  availableAt: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiry?: number;
  checkpointId?: string;
  /** Monotonic checkpoint sequence guard (stale writes rejected). */
  checkpointSequence: number;
  lastError?: string;
  dlqReason?: string;
  loopId?: string;
  loopOutcome?: LoopOutcome;
  settledAt?: number;
}

/** Input for explicit operator enqueue. */
export interface EnqueueWorkInput {
  task: LoopTask;
  correlationId?: string;
  idempotencyKey?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Future timestamp for scheduled wake; default is immediately eligible. */
  availableAt?: number;
}

/** A versioned, integrity-checked checkpoint for one work item. */
export interface LoopCheckpoint {
  id: string;
  /** Must equal LOOP_HOST_CHECKPOINT_SCHEMA_VERSION or fail closed. */
  schemaVersion: number;
  workItemId: string;
  tenantId: string;
  correlationId: string;
  phase: CheckpointPhase;
  /** Monotonic per work item; regressions are rejected. */
  sequence: number;
  attempt: number;
  loopId?: string;
  loopOutcome?: LoopOutcome;
  /** Bounded stage identifiers completed by the loop run, when known. Never fabricated. */
  completedStages?: string[];
  /** Canonical fingerprint of the dispatched task (proves resume dispatches the same task). */
  taskFingerprint: string;
  createdAt: number;
  /** SHA-256 over the canonical checkpoint core; verified on every read. */
  integrity: string;
}

/** Terminal settlement reported by the unified loop (recorded, never granted). */
export interface WorkSettlement {
  status: Extract<HostedWorkStatus, 'COMPLETED' | 'HELD' | 'DENIED'>;
  loopId: string;
  loopOutcome: LoopOutcome;
}

/** Failure classification driving bounded retry. */
export type DispatchFailureClass =
  | 'TRANSIENT' // runner threw; retry while attempts remain
  | 'TIMEOUT' // runner timed out / aborted; retry while attempts remain
  | 'PERMANENT' // malformed task/actor; no retry, straight to DLQ
  | 'CHECKPOINT_CORRUPT'; // checkpoint unreadable; no retry, quarantine to DLQ

/** Host lifecycle states. No background work exists outside RUNNING. */
export type HostLifecycle = 'IDLE' | 'RUNNING' | 'DRAINING' | 'STOPPED';

/** Result of one explicit scheduler pass. */
export interface TickSummary {
  at: number;
  examined: number;
  dispatched: number;
  completed: number;
  held: number;
  denied: number;
  sleeping: number;
  retried: number;
  deadLettered: number;
  skipped: number;
}

/** Result of one explicit crash-recovery pass. */
export interface RecoverSummary {
  at: number;
  examined: number;
  reclaimed: number;
  requeued: number;
  quarantined: number;
  untouched: number;
}

/** Privacy-minimized host lifecycle event payload (no task content, no secrets). */
export interface LoopHostAuditEvent {
  workId?: string;
  tenantId: string;
  correlationId?: string;
  hostId: string;
  at: number;
  summary: string;
  attempt?: number;
  status?: HostedWorkStatus;
  reason?: string;
}

export const LoopHostEvents = Object.freeze({
  WorkQueued: 'loop-host.work.queued',
  WorkScheduled: 'loop-host.work.scheduled',
  LeaseAcquired: 'loop-host.lease.acquired',
  LeaseReleased: 'loop-host.lease.released',
  LeaseReclaimed: 'loop-host.lease.reclaimed',
  Dispatched: 'loop-host.work.dispatched',
  CheckpointWritten: 'loop-host.checkpoint.written',
  Resumed: 'loop-host.work.resumed',
  Retried: 'loop-host.work.retried',
  Held: 'loop-host.work.held',
  Denied: 'loop-host.work.denied',
  Failed: 'loop-host.work.failed',
  DeadLettered: 'loop-host.work.dead-lettered',
  Completed: 'loop-host.work.completed',
  Sleeping: 'loop-host.work.sleeping',
  HostStarted: 'loop-host.host.started',
  HostStopped: 'loop-host.host.stopped',
} as const);

export class LoopHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopHostError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TenantIsolationError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

export class StaleLeaseError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'StaleLeaseError';
  }
}

export class LeaseConflictError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseConflictError';
  }
}

export class CheckpointIntegrityError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointIntegrityError';
  }
}

export class IncompatibleCheckpointError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'IncompatibleCheckpointError';
  }
}

export class InvalidWorkTransitionError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkTransitionError';
  }
}

export class HostLifecycleError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'HostLifecycleError';
  }
}
