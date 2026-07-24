// JATA Qi Scheduler — types.
//
// The Compute Scheduler (spec Step 3 #7, Step 4 #8) determines where work runs
// and in what order. It models compute targets (CPU/GPU/TPU/edge/cloud/quantum)
// with limited capacity and a priority task queue that honors dependencies.

export type ComputeKind = 'cpu' | 'gpu' | 'tpu' | 'edge' | 'cloud' | 'quantum' | string;

/** A compute target with bounded concurrency. */
export interface ComputeTarget {
  readonly id: string;
  readonly kind: ComputeKind;
  /** Maximum concurrent tasks on this target. */
  readonly capacity: number;
  readonly tags?: string[];
}

/** A unit of schedulable work. */
export interface Task<T = unknown> {
  /** Stable id (auto-generated if omitted). Used as a dependency target. */
  readonly id?: string;
  /** Target to run on (default target if omitted). */
  readonly target?: string;
  /** Higher priority runs first (default 0). */
  readonly priority?: number;
  /** Ids of tasks that must complete before this one starts. */
  readonly dependsOn?: string[];
  readonly run: () => Promise<T>;
}

export interface SchedulerStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  targets: { id: string; kind: ComputeKind; capacity: number; running: number }[];
}

export const SchedulerEvents = Object.freeze({
  TaskSubmitted: 'scheduler.task.submitted',
  TaskStarted: 'scheduler.task.started',
  TaskCompleted: 'scheduler.task.completed',
  TaskFailed: 'scheduler.task.failed',
  TargetRegistered: 'scheduler.target.registered',
} as const);
