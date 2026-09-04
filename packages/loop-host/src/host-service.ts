// O-01 loop-host service — explicit, leased dispatch to the governed loop.
//
// The host never reasons, plans, authorizes, grants, votes, verifies, or
// executes. Every dispatch re-enters the WHOLE unified loop (all 34 stages,
// governance included), so resume can never skip a gate or inherit a stale
// approval. Outcomes are RECORDED from the loop result, never granted.

import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import {
  UnifiedLoopModule,
  type LoopRunResult,
  type LoopTask,
} from '@jataqi/unified-loop';
import { CheckpointJournal, fingerprintTask } from './checkpoints.js';
import { nextWakeInMs } from './scheduler.js';
import {
  HostLifecycleError,
  LoopHostError,
  LoopHostEvents,
  type DispatchFailureClass,
  type EnqueueWorkInput,
  type HostedWorkItem,
  type HostedWorkStatus,
  type HostLifecycle,
  type LoopCheckpoint,
  type LoopHostAuditEvent,
  type RecoverSummary,
  type TickSummary,
  type WorkSettlement,
} from './types.js';
import { WorkQueue } from './work-queue.js';

/** Injected loop runner. The default resolves the governed UnifiedLoopService. */
export type LoopRunner = (
  actor: CommercialActor,
  task: LoopTask,
  opts: { correlationId: string; now: () => number; signal: AbortSignal },
) => Promise<LoopRunResult>;

export interface LoopHostConfig {
  hostId?: string;
  /** Exclusive-dispatch lease TTL in ms (also bounds one runner call). */
  leaseTtlMs?: number;
  /** Max dispatches per explicit tick. */
  maxBatch?: number;
  /** Delay before a SLEEP_PENDING record becomes eligible again. */
  sleepDelayMs?: number;
  /** When > 0 and started, background wake checks run on this interval. Off by default. */
  autoTickMs?: number;
  now?: () => number;
}

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_MAX_BATCH = 10;
const DEFAULT_SLEEP_DELAY_MS = 60_000;

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePositive(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 3_600_000) {
    throw new LoopHostError(`${field} must be between 1 and 3600000 ms.`);
  }
  return Math.floor(value);
}

function classifyRunnerError(err: unknown): { failureClass: DispatchFailureClass; reason: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout|abort/i.test(message)) return { failureClass: 'TIMEOUT', reason: `Runner timeout: ${message}` };
  if (/objective is required|actor.*required|tenant-bound/i.test(message)) {
    return { failureClass: 'PERMANENT', reason: `Runner rejected input permanently: ${message}` };
  }
  return { failureClass: 'TRANSIENT', reason: `Runner failure: ${message}` };
}

export class LoopHostService {
  private api!: KernelApi;
  private readonly queue = new WorkQueue();
  private readonly journal = new CheckpointJournal();
  private runner: LoopRunner | undefined;
  private readonly hostId: string;
  private readonly leaseTtlMs: number;
  private readonly maxBatch: number;
  private readonly sleepDelayMs: number;
  private readonly autoTickMs: number;
  private readonly clock: () => number;
  private lifecycle: HostLifecycle = 'IDLE';
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = 0;
  private readonly abortControllers = new Set<AbortController>();

  constructor(config: LoopHostConfig = {}) {
    this.hostId = config.hostId ?? `host:${randomUUID()}`;
    this.leaseTtlMs = normalizePositive(config.leaseTtlMs, DEFAULT_LEASE_TTL_MS, 'leaseTtlMs');
    this.maxBatch = config.maxBatch ?? DEFAULT_MAX_BATCH;
    if (!Number.isInteger(this.maxBatch) || this.maxBatch < 1 || this.maxBatch > 100) {
      throw new LoopHostError('maxBatch must be an integer between 1 and 100.');
    }
    this.sleepDelayMs = normalizePositive(config.sleepDelayMs, DEFAULT_SLEEP_DELAY_MS, 'sleepDelayMs');
    this.autoTickMs = config.autoTickMs ?? 0;
    if (!Number.isInteger(this.autoTickMs) || this.autoTickMs < 0 || this.autoTickMs > 3_600_000) {
      throw new LoopHostError('autoTickMs must be an integer between 0 and 3600000.');
    }
    this.clock = config.now ?? (() => Date.now());
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    await this.queue.init(kernel);
    await this.journal.init(kernel);
  }

  /** Override the runner (tests). Production path always uses the unified loop. */
  setRunner(runner: LoopRunner): void {
    this.runner = runner;
  }

  getLifecycle(): HostLifecycle {
    return this.lifecycle;
  }

  getHostId(): string {
    return this.hostId;
  }

  /** Milliseconds until the next parked record is due (operator observability). */
  async nextWakeIn(now?: number): Promise<number | undefined> {
    const at = now ?? this.clock();
    const parked = await this.queue.due(at, 1_000);
    void parked;
    const queued = await this.queue.due(at + 3_600_000, 1_000);
    return nextWakeInMs(queued, at);
  }

  start(): void {
    if (this.lifecycle === 'RUNNING') throw new HostLifecycleError('Loop host is already running.');
    if (this.lifecycle === 'DRAINING') throw new HostLifecycleError('Loop host is draining; stop must complete first.');
    this.lifecycle = 'RUNNING';
    void this.emit(LoopHostEvents.HostStarted, { tenantId: '*', summary: `Loop host ${this.hostId} started (explicit operator start; no work dispatched until tick).` });
    if (this.autoTickMs > 0) {
      this.timer = setInterval(() => {
        void this.tick().catch((err) => {
          this.api.logger.warn(`loop-host auto-tick failed (fail-closed, next tick continues): ${(err as Error).message}`);
        });
      }, this.autoTickMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  /** Drain in-flight dispatches, cancel their signals, then stop. Deterministic and safe. */
  async stop(): Promise<void> {
    if (this.lifecycle === 'STOPPED' || this.lifecycle === 'IDLE') {
      this.lifecycle = 'STOPPED';
      void this.emit(LoopHostEvents.HostStopped, { tenantId: '*', summary: `Loop host ${this.hostId} stopped (was idle).` });
      return;
    }
    if (this.lifecycle === 'DRAINING') throw new HostLifecycleError('Loop host is already draining.');
    this.lifecycle = 'DRAINING';
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const controller of this.abortControllers) controller.abort();
    const deadline = Date.now() + 30_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // In-flight records keep their leases; crash-recovery reclaims them by
    // expiry. The host never fabricates their outcome at shutdown.
    this.lifecycle = 'STOPPED';
    void this.emit(LoopHostEvents.HostStopped, {
      tenantId: '*',
      summary: `Loop host ${this.hostId} stopped (drained; ${this.inFlight} in-flight record(s) left leased for expiry reclaim).`,
    });
  }

  async enqueue(actor: CommercialActor, input: EnqueueWorkInput, now?: number): Promise<HostedWorkItem> {
    const at = now ?? this.clock();
    const item = await this.queue.enqueue(actor, input, at);
    const scheduled = item.availableAt > at;
    void this.emit(scheduled ? LoopHostEvents.WorkScheduled : LoopHostEvents.WorkQueued, {
      workId: item.id,
      tenantId: item.tenantId,
      correlationId: item.correlationId,
      attempt: item.attemptCount,
      status: item.status,
      summary: scheduled
        ? `Work ${item.id} scheduled for ${item.availableAt} (attempt ${item.attemptCount}).`
        : `Work ${item.id} queued (attempt ${item.attemptCount}).`,
    });
    return item;
  }

  async get(actor: CommercialActor, id: string): Promise<HostedWorkItem | undefined> {
    return this.queue.get(actor, id);
  }

  async list(actor: CommercialActor, opts: { status?: HostedWorkStatus; limit?: number } = {}): Promise<HostedWorkItem[]> {
    return this.queue.list(actor, opts);
  }

  async readCheckpoint(actor: CommercialActor, checkpointId: string): Promise<LoopCheckpoint | undefined> {
    const checkpoint = await this.journal.get(checkpointId);
    if (!checkpoint) return undefined;
    if (checkpoint.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) {
      throw new LoopHostError('Cross-tenant checkpoint access is not authorized.');
    }
    return checkpoint;
  }

  /**
   * One explicit scheduler pass: lease and dispatch every due record up to
   * maxBatch. Never runs unless the host is RUNNING; never dispatches without
   * a valid lease; every dispatch re-enters the full governed loop.
   */
  async tick(now?: number): Promise<TickSummary> {
    if (this.lifecycle !== 'RUNNING') throw new HostLifecycleError('Loop host tick requires RUNNING lifecycle (explicit start first).');
    const at = now ?? this.clock();
    const summary: TickSummary = {
      at,
      examined: 0,
      dispatched: 0,
      completed: 0,
      held: 0,
      denied: 0,
      sleeping: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
    };
    const due = await this.queue.due(at, this.maxBatch);
    summary.examined = due.length;
    for (const candidate of due) {
      if (this.lifecycle !== 'RUNNING') {
        summary.skipped += 1;
        continue;
      }
      let token: string;
      let leased: HostedWorkItem;
      try {
        const acquired = await this.queue.acquireLease(candidate.id, this.hostId, this.leaseTtlMs, at);
        leased = acquired.item;
        token = acquired.token;
      } catch {
        summary.skipped += 1;
        continue;
      }
      void this.emit(LoopHostEvents.LeaseAcquired, {
        workId: leased.id,
        tenantId: leased.tenantId,
        correlationId: leased.correlationId,
        attempt: leased.attemptCount + 1,
        status: leased.status,
        summary: `Lease acquired for work ${leased.id} by ${this.hostId}.`,
      });
      await this.dispatchLeased(leased, token, at, summary);
    }
    return summary;
  }

  /**
   * Explicit crash-recovery pass: reclaim only expired leases, validate the
   * latest checkpoint, requeue valid work for full-loop redispatch, quarantine
   * anything corrupt/incompatible. Active leases are never touched.
   */
  async recover(now?: number): Promise<RecoverSummary> {
    const at = now ?? this.clock();
    const summary: RecoverSummary = { at, examined: 0, reclaimed: 0, requeued: 0, quarantined: 0, untouched: 0 };
    const candidates = await this.queue.withExpiredLease(at);
    summary.examined = candidates.length;
    for (const candidate of candidates) {
      const latest = await this.safeLatest(candidate);
      if (latest === 'CORRUPT') {
        await this.queue.quarantine(candidate.id, 'Recovery found an unreadable or incompatible checkpoint (fail-closed).', at);
        summary.quarantined += 1;
        void this.emit(LoopHostEvents.DeadLettered, {
          workId: candidate.id,
          tenantId: candidate.tenantId,
          correlationId: candidate.correlationId,
          attempt: candidate.attemptCount,
          status: 'DLQ',
          reason: 'Corrupt or incompatible checkpoint at recovery; quarantined without dispatch.',
          summary: `Work ${candidate.id} quarantined at recovery (checkpoint unreadable).`,
        });
        continue;
      }
      const reclaimed = await this.queue.reclaimExpired(candidate.id, at);
      summary.reclaimed += 1;
      summary.requeued += 1;
      void this.emit(LoopHostEvents.LeaseReclaimed, {
        workId: reclaimed.id,
        tenantId: reclaimed.tenantId,
        correlationId: reclaimed.correlationId,
        attempt: reclaimed.attemptCount,
        status: reclaimed.status,
        summary: `Expired lease reclaimed for work ${reclaimed.id}; requeued for full-loop redispatch (attempt ${reclaimed.attemptCount + 1}).`,
      });
      void this.emit(LoopHostEvents.Resumed, {
        workId: reclaimed.id,
        tenantId: reclaimed.tenantId,
        correlationId: reclaimed.correlationId,
        attempt: reclaimed.attemptCount,
        status: reclaimed.status,
        summary: `Work ${reclaimed.id} resumed after reclaim; governance will be re-evaluated on redispatch.`,
      });
    }
    return summary;
  }

  /** Explicit operator resume of a HELD or SLEEPING record (full-loop redispatch, nothing inherited). */
  async resume(actor: CommercialActor, id: string, now?: number): Promise<HostedWorkItem> {
    const at = now ?? this.clock();
    const item = await this.queue.resumeWork(actor, id, at);
    void this.emit(LoopHostEvents.Resumed, {
      workId: item.id,
      tenantId: item.tenantId,
      correlationId: item.correlationId,
      attempt: item.attemptCount,
      status: item.status,
      summary: `Work ${item.id} resumed by operator ${actor.id}; next dispatch re-runs the full governed loop.`,
    });
    return item;
  }

  private async safeLatest(item: HostedWorkItem): Promise<LoopCheckpoint | 'CORRUPT' | undefined> {
    try {
      return await this.journal.readLatest(item);
    } catch {
      return 'CORRUPT';
    }
  }

  private resolveRunner(): LoopRunner {
    if (this.runner) return this.runner;
    const svc = this.api.getModule<UnifiedLoopModule>('unified-loop').getService();
    return (actor, task, opts) => svc.runLoop(actor, task, { correlationId: opts.correlationId, now: opts.now, signal: opts.signal });
  }

  private async dispatchLeased(leased: HostedWorkItem, token: string, at: number, summary: TickSummary): Promise<void> {
    const runner = this.resolveRunner();
    const controller = new AbortController();
    this.abortControllers.add(controller);
    this.inFlight += 1;
    try {
      // 1. Substantive pre-dispatch checkpoint (identities, phase, attempt, task fingerprint).
      const preCheckpoint = await this.journal.write(leased, { phase: 'DISPATCHED' }, at);
      const dispatched = await this.queue.markDispatched(leased.id, token, preCheckpoint.id, at);
      summary.dispatched += 1;
      void this.emit(LoopHostEvents.CheckpointWritten, {
        workId: dispatched.id,
        tenantId: dispatched.tenantId,
        correlationId: dispatched.correlationId,
        attempt: dispatched.attemptCount,
        status: dispatched.status,
        summary: `Checkpoint ${preCheckpoint.id} (DISPATCHED, seq ${preCheckpoint.sequence}) written for work ${dispatched.id}.`,
      });
      void this.emit(LoopHostEvents.Dispatched, {
        workId: dispatched.id,
        tenantId: dispatched.tenantId,
        correlationId: dispatched.correlationId,
        attempt: dispatched.attemptCount,
        status: dispatched.status,
        summary: `Work ${dispatched.id} dispatched to the governed unified loop (attempt ${dispatched.attemptCount}).`,
      });

      // 2. Whole-loop redispatch with a host-level time bound. The loop keeps
      // its own per-capability timeouts; this bound only classifies host waits.
      //
      // T-01: a timeout MUST NOT race a retry. When the host-level time
      // bound fires, the runner is signalled to stop AND the host waits for
      // the runner to actually settle (so a retry cannot run concurrently
      // with a still-executing attempt). If the runner does not stop within
      // a bounded grace period, the host leaves the work item in its current
      // state (DISPATCHED) with the lease still held; the work item cannot
      // be redispatched until the lease expires (and even then, recovery
      // performs a full-loop redispatch — never a parallel retry). The
      // work item's leaseToken is the ownership boundary: recordFailure /
      // settleTerminal / markDispatched all require the live token, so even
      // a leaked in-flight runner cannot issue a conflicting state mutation.
      const actor: CommercialActor = {
        id: dispatched.actor.id,
        tenantId: dispatched.actor.tenantId,
        roles: [...dispatched.actor.roles],
      };
      const runnerPromise = runner(actor, copy(dispatched.task), { correlationId: dispatched.correlationId, now: this.clock, signal: controller.signal });
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Host dispatch timed out after ${this.leaseTtlMs} ms.`)), this.leaseTtlMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      let result: LoopRunResult;
      try {
        result = await Promise.race([runnerPromise, timeoutPromise]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = /timed out|timeout/i.test(message);
        if (timedOut) {
          // Signal the runner to stop, then wait for it to actually settle.
          // We MUST wait here so a retry cannot execute concurrently with
          // the still-running attempt.
          controller.abort();
          const settled = await Promise.race([
            runnerPromise.then(() => 'settled' as const, () => 'settled' as const),
            new Promise<'grace-expired'>((resolve) => {
              const graceTimer = setTimeout(() => resolve('grace-expired'), this.leaseTtlMs);
              if (typeof graceTimer.unref === 'function') graceTimer.unref();
            }),
          ]);
          if (settled === 'grace-expired') {
            // The runner did not stop in time. The ownership boundary
            // (leaseToken) prevents ANY concurrent retry from issuing
            // conflicting state mutations: recordFailure/settleTerminal/
            // markDispatched all require the live token. We do not retry
            // the work item; the lease stays held and the work item will
            // be reclaimed at expiry by recovery (which re-dispatches
            // from a clean state). The runner call is left to settle in
            // the background.
            this.api.logger.warn(
              `loop-host dispatch ${leased.id}: runner did not stop within grace period after timeout; lease left held for expiry reclaim (no concurrent retry possible; ownership boundary enforced).`,
            );
            void this.emit(LoopHostEvents.Failed, {
              workId: leased.id,
              tenantId: leased.tenantId,
              correlationId: leased.correlationId,
              attempt: leased.attemptCount,
              status: leased.status,
              reason: `Runner did not honour abort within grace period after timeout; left for recovery.`,
              summary: `Work ${leased.id}: runner did not stop within grace period; lease left held for expiry reclaim (no retry issued; ownership boundary prevents concurrent execution).`,
            });
            return;
          }
          // Settled: now record the timeout as a TIMEOUT failure so a
          // bounded retry can be scheduled by recordFailure. recordFailure
          // requires the live leaseToken, which we still hold.
          await this.handleRunnerFailure(dispatched, token, new Error(`Host dispatch timed out after ${this.leaseTtlMs} ms (runner settled).`), at, summary);
          return;
        }
        await this.handleRunnerFailure(dispatched, token, err, at, summary);
        return;
      }

      // 3. Record the loop-reported outcome. COMPLETED here means "the loop
      // reported completion" — verification was the loop's, never the host's.
      const completedStages = result.trace.filter((entry) => entry.status === 'COMPLETED').map((entry) => entry.stage);
      const postCheckpoint = await this.journal.write(dispatched, {
        phase: 'SETTLED',
        loopId: result.loopId,
        loopOutcome: result.outcome,
        completedStages,
      }, at);
      void this.emit(LoopHostEvents.CheckpointWritten, {
        workId: dispatched.id,
        tenantId: dispatched.tenantId,
        correlationId: dispatched.correlationId,
        attempt: dispatched.attemptCount,
        status: dispatched.status,
        summary: `Checkpoint ${postCheckpoint.id} (SETTLED, seq ${postCheckpoint.sequence}) written for work ${dispatched.id}.`,
      });

      switch (result.outcome) {
        case 'COMPLETED_VERIFIED':
        case 'COMPLETED_DRY_RUN': {
          const settlement: WorkSettlement = { status: 'COMPLETED', loopId: result.loopId, loopOutcome: result.outcome };
          await this.queue.settleTerminal(dispatched.id, token, settlement, postCheckpoint.id, at);
          summary.completed += 1;
          void this.emit(LoopHostEvents.Completed, {
            workId: dispatched.id,
            tenantId: dispatched.tenantId,
            correlationId: dispatched.correlationId,
            attempt: dispatched.attemptCount,
            status: 'COMPLETED',
            summary: `Work ${dispatched.id} completed as reported by the loop (${result.outcome}).`,
          });
          break;
        }
        case 'SLEEP_PENDING': {
          await this.queue.parkSleeping(dispatched.id, token, at + this.sleepDelayMs, result.loopId, at);
          summary.sleeping += 1;
          void this.emit(LoopHostEvents.Sleeping, {
            workId: dispatched.id,
            tenantId: dispatched.tenantId,
            correlationId: dispatched.correlationId,
            attempt: dispatched.attemptCount,
            status: 'SLEEPING',
            summary: `Work ${dispatched.id} sleeping until ${at + this.sleepDelayMs} (loop requested SLEEP).`,
          });
          break;
        }
        case 'HELD_AT_GATE': {
          const settlement: WorkSettlement = { status: 'HELD', loopId: result.loopId, loopOutcome: result.outcome };
          await this.queue.settleTerminal(dispatched.id, token, settlement, postCheckpoint.id, at);
          summary.held += 1;
          void this.emit(LoopHostEvents.Held, {
            workId: dispatched.id,
            tenantId: dispatched.tenantId,
            correlationId: dispatched.correlationId,
            attempt: dispatched.attemptCount,
            status: 'HELD',
            reason: result.failureReason ?? 'Held at human/regulatory or verification gate; explicit operator resume required.',
            summary: `Work ${dispatched.id} held at gate; never auto-retried.`,
          });
          break;
        }
        case 'DENIED': {
          const settlement: WorkSettlement = { status: 'DENIED', loopId: result.loopId, loopOutcome: result.outcome };
          await this.queue.settleTerminal(dispatched.id, token, settlement, postCheckpoint.id, at);
          summary.denied += 1;
          void this.emit(LoopHostEvents.Denied, {
            workId: dispatched.id,
            tenantId: dispatched.tenantId,
            correlationId: dispatched.correlationId,
            attempt: dispatched.attemptCount,
            status: 'DENIED',
            reason: result.failureReason ?? 'Denied by policy, kill-switch, or authority check; terminal.',
            summary: `Work ${dispatched.id} denied; terminal and never retried.`,
          });
          break;
        }
        case 'FAILED_CLOSED':
        default: {
          const failed = await this.queue.recordFailure(dispatched.id, token, 'TRANSIENT', result.failureReason ?? 'Loop reported FAILED_CLOSED.', at);
          if (failed.status === 'DLQ') {
            summary.deadLettered += 1;
            void this.emit(LoopHostEvents.DeadLettered, {
              workId: failed.id,
              tenantId: failed.tenantId,
              correlationId: failed.correlationId,
              attempt: failed.attemptCount,
              status: 'DLQ',
              reason: failed.dlqReason,
              summary: `Work ${failed.id} dead-lettered after bounded retries.`,
            });
          } else {
            summary.retried += 1;
            void this.emit(LoopHostEvents.Retried, {
              workId: failed.id,
              tenantId: failed.tenantId,
              correlationId: failed.correlationId,
              attempt: failed.attemptCount,
              status: failed.status,
              reason: failed.lastError,
              summary: `Work ${failed.id} requeued with backoff (attempt ${failed.attemptCount}/${failed.maxAttempts}).`,
            });
          }
          break;
        }
      }
    } catch (err) {
      // Checkpoint/queue substrate failure: never fabricate an outcome. Leave
      // the lease for expiry reclaim and record the host-level failure event.
      void this.emit(LoopHostEvents.Failed, {
        workId: leased.id,
        tenantId: leased.tenantId,
        correlationId: leased.correlationId,
        attempt: leased.attemptCount,
        status: leased.status,
        reason: err instanceof Error ? err.message : String(err),
        summary: `Host substrate failure for work ${leased.id}; outcome not fabricated, lease left for expiry reclaim.`,
      });
    } finally {
      this.abortControllers.delete(controller);
      this.inFlight -= 1;
    }
  }

  private async handleRunnerFailure(
    dispatched: HostedWorkItem,
    token: string,
    err: unknown,
    at: number,
    summary: TickSummary,
  ): Promise<void> {
    const { failureClass, reason } = classifyRunnerError(err);
    const failed = await this.queue.recordFailure(dispatched.id, token, failureClass, reason, at);
    if (failed.status === 'DLQ') {
      summary.deadLettered += 1;
      void this.emit(LoopHostEvents.DeadLettered, {
        workId: failed.id,
        tenantId: failed.tenantId,
        correlationId: failed.correlationId,
        attempt: failed.attemptCount,
        status: 'DLQ',
        reason: failed.dlqReason,
        summary: `Work ${failed.id} dead-lettered (${failureClass}).`,
      });
    } else {
      summary.retried += 1;
      void this.emit(LoopHostEvents.Retried, {
        workId: failed.id,
        tenantId: failed.tenantId,
        correlationId: failed.correlationId,
        attempt: failed.attemptCount,
        status: failed.status,
        reason: failed.lastError,
        summary: `Work ${failed.id} requeued after ${failureClass} (attempt ${failed.attemptCount}/${failed.maxAttempts}).`,
      });
    }
  }

  private emit(event: string, payload: Omit<LoopHostAuditEvent, 'hostId' | 'at'> & { at?: number }): void {
    const full: LoopHostAuditEvent = { ...payload, hostId: this.hostId, at: payload.at ?? this.clock() };
    void this.api.bus.emit(event, full);
  }

  /** Fingerprint helper exposed for audit/tests (proves resume dispatches the identical task). */
  static taskFingerprint(task: LoopTask): string {
    return fingerprintTask(task);
  }
}
