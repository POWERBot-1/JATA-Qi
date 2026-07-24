// Core scheduler: a priority task queue with per-target capacity limits and
// dependency resolution. Single-process, cooperative (no OS threads), suitable
// for bounding concurrency of async workloads.

import { randomUUID } from 'node:crypto';
import type { ComputeTarget, SchedulerStats, Task } from './types.js';

const DEFAULT_TARGET = 'default';

interface Wrapped {
  id: string;
  targetId: string;
  priority: number;
  deps: string[];
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface TargetState {
  id: string;
  kind: string;
  capacity: number;
  running: number;
}

export interface SchedulerOptions {
  /** Concurrency of the implicit default target (default 4). */
  defaultCapacity?: number;
}

export class Scheduler {
  private targets = new Map<string, TargetState>();
  private pending: Wrapped[] = [];
  private completed = new Set<string>();
  private running = 0;
  private completedCount = 0;
  private failedCount = 0;
  private readonly emit?: (event: string, payload: Record<string, unknown>) => void;

  constructor(opts: SchedulerOptions = {}, emit?: (event: string, payload: Record<string, unknown>) => void) {
    this.emit = emit;
    this.targets.set(DEFAULT_TARGET, {
      id: DEFAULT_TARGET,
      kind: 'cpu',
      capacity: opts.defaultCapacity ?? 4,
      running: 0,
    });
  }

  registerTarget(target: ComputeTarget): void {
    if (target.capacity < 1) throw new Error(`scheduler: target "${target.id}" capacity must be >= 1`);
    this.targets.set(target.id, { id: target.id, kind: target.kind, capacity: target.capacity, running: 0 });
    this.emit?.(SchedulerEventsTargetRegistered(), { id: target.id });
  }

  /** Submit a task; resolves with its result once a target runs it. */
  submit<T>(task: Task<T>): Promise<T> {
    const id = task.id ?? randomUUID();
    return new Promise<T>((resolve, reject) => {
      const wrapped: Wrapped = {
        id,
        targetId: task.target ?? DEFAULT_TARGET,
        priority: task.priority ?? 0,
        deps: task.dependsOn ?? [],
        run: task.run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      this.pending.push(wrapped);
      this.emit?.('scheduler.task.submitted', { id, target: wrapped.targetId, priority: wrapped.priority });
      this.pump();
    });
  }

  stats(): SchedulerStats {
    return {
      pending: this.pending.length,
      running: this.running,
      completed: this.completedCount,
      failed: this.failedCount,
      targets: [...this.targets.values()].map((t) => ({ id: t.id, kind: t.kind, capacity: t.capacity, running: t.running })),
    };
  }

  /** Resolves once no tasks are pending or running. */
  async idle(): Promise<void> {
    while (this.pending.length > 0 || this.running > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private pump(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      let bestIdx = -1;
      let bestPriority = -Infinity;
      for (let i = 0; i < this.pending.length; i++) {
        const t = this.pending[i]!;
        if (!this.depsSatisfied(t)) continue;
        if (!this.hasCapacity(t.targetId)) continue;
        if (t.priority > bestPriority) {
          bestPriority = t.priority;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        const t = this.pending.splice(bestIdx, 1)[0]!;
        this.launch(t);
        progressed = true;
      }
    }
  }

  private launch(t: Wrapped): void {
    const target = this.targets.get(t.targetId) ?? this.targets.get(DEFAULT_TARGET)!;
    target.running += 1;
    this.running += 1;
    this.emit?.('scheduler.task.started', { id: t.id, target: target.id });
    t.run()
      .then(
        (value) => this.settle(t, value, undefined),
        (err) => this.settle(t, undefined, err),
      );
  }

  private settle(t: Wrapped, value: unknown, err: unknown): void {
    const target = this.targets.get(t.targetId) ?? this.targets.get(DEFAULT_TARGET)!;
    target.running = Math.max(0, target.running - 1);
    this.running -= 1;
    this.completed.add(t.id);
    if (err === undefined) {
      this.completedCount += 1;
      this.emit?.('scheduler.task.completed', { id: t.id });
      t.resolve(value);
    } else {
      this.failedCount += 1;
      this.emit?.('scheduler.task.failed', { id: t.id });
      t.reject(err);
    }
    this.pump();
  }

  private depsSatisfied(t: Wrapped): boolean {
    return t.deps.every((d) => this.completed.has(d));
  }

  private hasCapacity(targetId: string): boolean {
    const t = this.targets.get(targetId);
    if (!t) return true; // unknown target runs on default; default always exists
    return t.running < t.capacity;
  }
}

// Helper so the class can reference the constant without importing the frozen
// object's exact typing at construction time.
function SchedulerEventsTargetRegistered(): string {
  return 'scheduler.target.registered';
}
