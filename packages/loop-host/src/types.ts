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

import type { CommercialActor, CommercialActorRole } from '@jataqi/commercial-control-plane';
import type { LoopOutcome, LoopTask } from '@jataqi/unified-loop';
import type { AuthenticationMethod } from '@jataqi/authentication';

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
  /**
   * T-02: actor snapshot captured at enqueue from a verified principal
   * (continuity, not re-auth). The actor MUST be derivable from
   * `principal` (same id/tenant, narrowed-or-equal roles); dispatch
   * re-verifies this and never executes a mismatched actor.
   */
  actor: Pick<CommercialActor, 'id' | 'tenantId' | 'roles'>;
  /**
   * T-02: immutable authenticated-principal snapshot embedded at
   * authenticated enqueue. This is the authority evidence dispatch
   * executes under — never a caller-supplied actor. Absent ONLY on
   * pre-T-02 rows, which can never execute (HELD/PRINCIPAL_ABSENT).
   * Carries provenance only; never tokens, secrets, or credentials.
   */
  principal?: AuthenticatedPrincipalSnapshot;
  /**
   * T-02: deterministic authority-hold reason (see AuthorityHoldReason)
   * when the item was HELD by pre-dispatch authority validation rather
   * than by a loop-reported gate outcome. Loop-reported HELD settlements
   * leave this undefined and resume through the normal operator path;
   * authority-held items resume ONLY via fresh authenticated enqueue.
   */
  heldReason?: string;
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

/** R-01 supervision status of the host runtime process. */
export type HostRuntimeStatus = 'CREATED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED';

/**
 * R-01 record of one completed supervision cycle. Observability only: it
 * carries no task content and confers no authority.
 */
export interface HostRuntimeCycle {
  index: number;
  at: number;
  examined: number;
  dispatched: number;
  completed: number;
  sleeping: number;
  /** Set when the cycle's tick threw; the runtime continues fail-closed. */
  error?: string;
  /** T-05: durable delivery pass summary when the runtime was configured with a delivery pump. */
  delivery?: { examined: number; delivered: number; retried: number; deadLettered: number };
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
  /**
   * T-02: authenticated provenance of the authority the event was
   * produced under (method/event id/verified-at/principal id). Present
   * on enqueue/dispatch/settlement events for principal-bound work;
   * absent when no verified snapshot was available. Never secrets.
   */
  principalMethod?: string;
  principalEventId?: string;
  principalVerifiedAt?: number;
  principalId?: string;
  /**
   * T-02: machine-readable authority-hold reason. Set only on Held
   * events produced by the pre-dispatch authority gate; loop-requested
   * holds leave it absent (distinguishing the two is load-bearing for
   * operators: authority holds refuse resume).
   */
  heldReason?: AuthorityHoldReason;
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
  // R-01 supervision lifecycle (process-level, not work-level).
  RuntimeStarted: 'loop-host.runtime.started',
  RuntimeStopped: 'loop-host.runtime.stopped',
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

/** R-01: invalid host-runtime supervision configuration or lifecycle use. */
export class HostRuntimeError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'HostRuntimeError';
  }
}

/**
 * R-01: an unattended host refused to start because the resolved storage
 * driver is development-only and would lose state. Fail-closed, never a
 * silent degrade to memory.
 */
export class NonDurableStorageError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'NonDurableStorageError';
  }
}

// ---------------------------------------------------------------------------
// T-02 authenticated durable authority carry-through.
// ---------------------------------------------------------------------------
//
// T-01 installed the server-side principal boundary
// (`AuthenticatedPrincipal`), but the durable host preserved only a
// caller-supplied actor across the enqueue → persistence → lease/recovery →
// dispatch boundary — identity without authentication provenance. T-02
// closes that gap with the invariant:
//
//   A durable work item must never execute using a caller-self-asserted
//   actor. Execution carries forward a previously authenticated principal
//   snapshot whose provenance, tenant, roles, and freshness are verifiable.
//
// The host remains a valet: it persists, revalidates, and forwards
// authority evidence — it never mints, extends, or widens it.

/** Schema version for T-02 principal snapshots. Bump only with migration logic. */
export const PRINCIPAL_SNAPSHOT_VERSION = 1;

/**
 * T-02 default maximum age of a principal snapshot's `verifiedAt` at
 * enqueue/dispatch (24h). Freshness is `now - verifiedAt <= maxAgeMs`;
 * the exact boundary counts as fresh. Configurable per host via
 * `LoopHostConfig.maxPrincipalAgeMs` within [0, MAX_PRINCIPAL_AGE_MS].
 */
export const DEFAULT_MAX_PRINCIPAL_AGE_MS = 86_400_000;

/** T-02 upper bound for a configured `maxPrincipalAgeMs` (30 days). */
export const MAX_PRINCIPAL_AGE_MS = 2_592_000_000;

/**
 * T-02 clock-skew tolerance (5 minutes). A `verifiedAt` more than this
 * far in the future is unverifiable and fails closed (PRINCIPAL_SKEW);
 * smaller future drift is treated as freshly verified (age 0) rather
 * than as an error, so minor clock disagreement cannot strand work.
 */
export const MAX_PRINCIPAL_CLOCK_SKEW_MS = 300_000;

/**
 * T-02 deterministic authority-hold reasons. Pre-dispatch authority
 * validation HELDs an item with exactly one of these (stored on
 * `heldReason`, surfaced on the Held audit event); nothing else in the
 * host may mint hold reasons.
 */
export type AuthorityHoldReason =
  | 'PRINCIPAL_ABSENT' // pre-T-02 row (or tampered row) with no snapshot
  | 'PRINCIPAL_STALE' // verifiedAt older than the max-age policy
  | 'PRINCIPAL_SKEW' // verifiedAt unverifiably in the future
  | 'PRINCIPAL_MALFORMED' // snapshot shape/timestamp invalid
  | 'PRINCIPAL_VERSION' // snapshot version unsupported
  | 'PRINCIPAL_MISMATCH' // snapshot/item/actor tenant or identity mismatch
  | 'PRINCIPAL_ROLE_ESCALATION' // execution roles exceed the verified set
  | 'PRINCIPAL_TEST_METHOD'; // test authentication under a production-only policy

/** T-02: closed set of authority-hold reasons (operator resume refuses these). */
export const AUTHORITY_HELD_REASONS: ReadonlySet<string> = new Set<string>([
  'PRINCIPAL_ABSENT',
  'PRINCIPAL_STALE',
  'PRINCIPAL_SKEW',
  'PRINCIPAL_MALFORMED',
  'PRINCIPAL_VERSION',
  'PRINCIPAL_MISMATCH',
  'PRINCIPAL_ROLE_ESCALATION',
  'PRINCIPAL_TEST_METHOD',
]);

/**
 * T-02 immutable authenticated-principal snapshot persisted on a work
 * item at authenticated enqueue. Provenance only: ids, tenant, verified
 * roles, method, verification timestamp, and authentication event id.
 * NEVER tokens, passwords, credentials, secrets, or raw auth material —
 * the snapshot builder picks these fixed fields and strips everything
 * else, and the shape is frozen before persistence.
 */
export interface AuthenticatedPrincipalSnapshot {
  /** Must equal PRINCIPAL_SNAPSHOT_VERSION or fail closed. */
  readonly version: typeof PRINCIPAL_SNAPSHOT_VERSION;
  /** Verified principal id (subject). */
  readonly principalId: string;
  /** Server-verified tenant id. */
  readonly tenantId: string;
  /** Server-asserted role set. Execution may only narrow, never widen. */
  readonly roles: readonly CommercialActorRole[];
  /** Authentication method that verified this principal. */
  readonly authenticationMethod: AuthenticationMethod;
  /** Server-side verification timestamp (ms). */
  readonly verifiedAt: number;
  /** Server-side authentication/audit event id. */
  readonly authenticationEventId: string;
}

/**
 * T-02 principal policy for a host. `allowTestMethod` (default true)
 * permits `DETERMINISTIC_TEST` principals; production-shaped
 * compositions set it false so test authentication can never silently
 * become production authority. OIDC/mTLS activation remains out of
 * scope; STATIC_TOKEN counts as non-test (staging-capable).
 */
export interface PrincipalPolicy {
  allowTestMethod?: boolean;
}

/** T-02: any rejection of principal authority (enqueue or dispatch). */
export class PrincipalAuthorityError extends LoopHostError {
  constructor(message: string) {
    super(message);
    this.name = 'PrincipalAuthorityError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
