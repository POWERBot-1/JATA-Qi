// R-01 host runtime supervisor — the mechanism that makes the already-built
// O-01 host and P-01 durable substrate actually reachable as a running process.
//
// This file adds NO orchestration, NO cognition, NO policy, NO authority and NO
// new stage. It only decides *when* to call the existing, unchanged
// LoopHostService entry points (`recover`, `start`, `tick`, `stop`) and how to
// keep the owning Node process alive between those calls. Every dispatch still
// re-enters the whole 34-stage governed unified loop through LoopHostService;
// the runtime never touches a work item, a lease, a checkpoint, or the loop.
//
// Durability honesty: the runtime can REFUSE to run against a non-durable
// storage driver, but it neither provisions nor backs up a database. Production
// disaster recovery (backup/restore/PITR/replication/failover) is explicitly out
// of scope and remains undelivered.

import type { KernelApi } from '@jataqi/core-kernel';
import { emitPlainEnveloped } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { LoopHostService } from './host-service.js';
import {
  HostRuntimeError,
  LoopHostEvents,
  NonDurableStorageError,
  type HostRuntimeCycle,
  type HostRuntimeStatus,
  type RecoverSummary,
  type TickSummary,
} from './types.js';

/** Storage driver ids that are NOT authoritative production persistence. */
const NON_DURABLE_DRIVER_IDS: ReadonlySet<string> = new Set(['memory', 'filesystem']);

const DEFAULT_MIN_IDLE_MS = 250;
const DEFAULT_MAX_IDLE_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

export interface HostRuntimeConfig {
  /**
   * Refuse to start when the resolved storage driver is not authoritative
   * (memory/filesystem). Default true: a supervised, unattended process must
   * never silently run on state it will lose. Set false only for local dev.
   */
  requireDurableStorage?: boolean;
  /** Lower bound on the pause between cycles (backpressure floor). */
  minIdleMs?: number;
  /** Upper bound on the pause between cycles when nothing is due. */
  maxIdleMs?: number;
  /** Run an explicit crash-recovery pass before the first tick. Default true. */
  recoverOnBoot?: boolean;
  /** Max ms to wait for in-flight dispatches to drain on shutdown. */
  shutdownGraceMs?: number;
  /**
   * Stop automatically after this many completed cycles. Undefined = run until
   * a signal or an explicit `shutdown()`. Used by tests and bounded operator runs.
   */
  maxCycles?: number;
  /** Install SIGTERM/SIGINT handlers. Default true; tests pass false. */
  installSignalHandlers?: boolean;
  now?: () => number;
  /** Injected sleep (tests). Must resolve after roughly `ms`. */
  sleep?: (ms: number) => Promise<void>;
}

function normalizeMs(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000) {
    throw new HostRuntimeError(`${field} must be between 0 and 3600000 ms.`);
  }
  return Math.floor(value);
}

/**
 * Assert the resolved storage driver is authoritative production persistence.
 * Fails closed: an unattended host must never degrade to state it will lose.
 */
export function assertDurableStorage(driverId: string): void {
  if (NON_DURABLE_DRIVER_IDS.has(driverId)) {
    throw new NonDurableStorageError(
      `Storage driver "${driverId}" is development-only and is not authoritative production persistence. ` +
        'An unattended host refuses to start on state it would lose. Compose a durable driver ' +
        '(e.g. @jataqi/storage-postgres via STORAGE_DRIVER=postgres + JATAQI_PG_CONNECTION_STRING), ' +
        'or set requireDurableStorage=false for local development only. Failing closed.',
    );
  }
}

/** True when the driver id denotes authoritative production persistence. */
export function isDurableDriver(driverId: string): boolean {
  return !NON_DURABLE_DRIVER_IDS.has(driverId);
}

/**
 * Supervises one LoopHostService inside one process.
 *
 * Lifecycle: assert durability -> recover() -> host.start() -> repeat
 * { tick(); sleep(next-due-aware) } -> on signal: host.stop() -> release.
 *
 * The keep-alive handle is deliberately NOT unref'd: that is precisely the
 * defect that made O-01's auto-tick unable to hold a process open.
 */
export class HostRuntime {
  private readonly host: LoopHostService;
  private readonly cfg: Required<Pick<HostRuntimeConfig, 'requireDurableStorage' | 'minIdleMs' | 'maxIdleMs' | 'recoverOnBoot' | 'shutdownGraceMs' | 'installSignalHandlers'>> & HostRuntimeConfig;
  private readonly clock: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  private status: HostRuntimeStatus = 'CREATED';
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private stopRequested = false;
  private runPromise: Promise<void> | undefined;
  private cycles: HostRuntimeCycle[] = [];
  private bootRecovery: RecoverSummary | undefined;
  private signalDisposers: Array<() => void> = [];
  private wakeResolver: (() => void) | undefined;

  constructor(host: LoopHostService, config: HostRuntimeConfig = {}) {
    this.host = host;
    const minIdleMs = normalizeMs(config.minIdleMs, DEFAULT_MIN_IDLE_MS, 'minIdleMs');
    const maxIdleMs = normalizeMs(config.maxIdleMs, DEFAULT_MAX_IDLE_MS, 'maxIdleMs');
    if (maxIdleMs < minIdleMs) throw new HostRuntimeError('maxIdleMs must be >= minIdleMs.');
    if (config.maxCycles !== undefined && (!Number.isInteger(config.maxCycles) || config.maxCycles < 1)) {
      throw new HostRuntimeError('maxCycles must be a positive integer when supplied.');
    }
    this.cfg = {
      ...config,
      requireDurableStorage: config.requireDurableStorage ?? true,
      minIdleMs,
      maxIdleMs,
      recoverOnBoot: config.recoverOnBoot ?? true,
      shutdownGraceMs: normalizeMs(config.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS, 'shutdownGraceMs'),
      installSignalHandlers: config.installSignalHandlers ?? true,
    };
    this.clock = config.now ?? (() => Date.now());
    this.sleepFn = config.sleep ?? ((ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') timer.unref();
    }));
  }

  getStatus(): HostRuntimeStatus {
    return this.status;
  }

  /** Cycle records for operator observability and acceptance evidence. */
  getCycles(): readonly HostRuntimeCycle[] {
    return this.cycles.map((cycle) => ({ ...cycle }));
  }

  getBootRecovery(): RecoverSummary | undefined {
    return this.bootRecovery ? { ...this.bootRecovery } : undefined;
  }

  /**
   * Verify preconditions and boot the supervised host. Returns a promise that
   * resolves when the supervision loop has fully stopped.
   *
   * Fails closed BEFORE starting the host if durability is required and the
   * resolved driver is development-only.
   */
  async run(kernel: KernelApi): Promise<void> {
    if (this.status !== 'CREATED') throw new HostRuntimeError(`Host runtime cannot run from status ${this.status}.`);
    const driverId = kernel.getModule<StorageModule>('storage').getDriver().id;
    if (this.cfg.requireDurableStorage) assertDurableStorage(driverId);

    this.status = 'STARTING';
    kernel.logger.info(
      `host runtime starting (hostId=${this.host.getHostId()}, storageDriver=${driverId}, ` +
        `durable=${isDurableDriver(driverId) ? 'yes' : 'NO (development-only)'}, ` +
        `idle=${this.cfg.minIdleMs}-${this.cfg.maxIdleMs}ms, recoverOnBoot=${this.cfg.recoverOnBoot})`,
    );

    // Boot-time crash recovery BEFORE the first dispatch. Reclaims only expired
    // leases; corrupt checkpoints are quarantined fail-closed by the host.
    if (this.cfg.recoverOnBoot) {
      this.bootRecovery = await this.host.recover(this.clock());
      kernel.logger.info(
        `host runtime boot recovery: examined=${this.bootRecovery.examined} reclaimed=${this.bootRecovery.reclaimed} ` +
          `requeued=${this.bootRecovery.requeued} quarantined=${this.bootRecovery.quarantined}`,
      );
    }

    this.host.start();
    if (this.cfg.installSignalHandlers) this.installSignals(kernel);
    // Hold the event loop open. NOT unref'd — this is the keep-alive.
    this.keepAlive = setInterval(() => undefined, 1_000);
    this.status = 'RUNNING';
    void emitPlainEnveloped(kernel.bus, LoopHostEvents.RuntimeStarted, {
      hostId: this.host.getHostId(),
      at: this.clock(),
      tenantId: '*',
      summary: `Host runtime supervising ${this.host.getHostId()} on storage driver "${driverId}".`,
    }, { source: 'loop-host', tenantId: '*' });

    this.runPromise = this.loop(kernel);
    return this.runPromise;
  }

  private async loop(kernel: KernelApi): Promise<void> {
    try {
      while (!this.stopRequested) {
        const at = this.clock();
        let tick: TickSummary | undefined;
        let error: string | undefined;
        try {
          tick = await this.host.tick(at);
        } catch (err) {
          // A cycle failure never fabricates an outcome and never kills the
          // runtime: work keeps its lease for expiry reclaim and we continue.
          error = err instanceof Error ? err.message : String(err);
          kernel.logger.warn(`host runtime cycle failed (fail-closed; work left for expiry reclaim): ${error}`);
        }
        this.cycles.push({
          index: this.cycles.length,
          at,
          examined: tick?.examined ?? 0,
          dispatched: tick?.dispatched ?? 0,
          completed: tick?.completed ?? 0,
          sleeping: tick?.sleeping ?? 0,
          error,
        });

        if (this.cfg.maxCycles !== undefined && this.cycles.length >= this.cfg.maxCycles) break;
        if (this.stopRequested) break;

        await this.idle();
      }
    } finally {
      await this.finish(kernel);
    }
  }

  /** Sleep until the next parked item is due, clamped to the configured bounds. */
  private async idle(): Promise<void> {
    let wait = this.cfg.maxIdleMs;
    try {
      const nextIn = await this.host.nextWakeIn(this.clock());
      if (nextIn !== undefined) wait = Math.min(this.cfg.maxIdleMs, Math.max(this.cfg.minIdleMs, nextIn));
      else wait = Math.max(this.cfg.minIdleMs, this.cfg.maxIdleMs);
    } catch {
      wait = this.cfg.minIdleMs;
    }
    // Interruptible sleep so a shutdown signal does not wait out a long idle.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.wakeResolver = undefined;
        resolve();
      };
      this.wakeResolver = done;
      void this.sleepFn(wait).then(done);
    });
  }

  private async finish(kernel: KernelApi): Promise<void> {
    if (this.status === 'STOPPED') return;
    this.status = 'STOPPING';
    for (const dispose of this.signalDisposers) dispose();
    this.signalDisposers = [];
    try {
      // Drains in-flight dispatches and aborts their signals. In-flight records
      // keep their leases for expiry reclaim; no outcome is ever fabricated.
      await this.host.stop();
    } catch (err) {
      kernel.logger.warn(`host runtime shutdown: host stop reported ${(err as Error).message}`);
    }
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = undefined;
    }
    this.status = 'STOPPED';
    kernel.logger.info(`host runtime stopped after ${this.cycles.length} cycle(s); no outcomes fabricated.`);
    void emitPlainEnveloped(kernel.bus, LoopHostEvents.RuntimeStopped, {
      hostId: this.host.getHostId(),
      at: this.clock(),
      tenantId: '*',
      summary: `Host runtime stopped after ${this.cycles.length} cycle(s).`,
    }, { source: 'loop-host', tenantId: '*' });
  }

  /** Request a graceful stop; resolves once the supervision loop has drained. */
  async shutdown(): Promise<void> {
    this.stopRequested = true;
    if (this.wakeResolver) this.wakeResolver();
    if (this.runPromise) await this.runPromise;
  }

  private installSignals(kernel: KernelApi): void {
    const handler = (signal: string) => {
      kernel.logger.info(`host runtime received ${signal}; draining gracefully (no outcome will be fabricated).`);
      void this.shutdown();
    };
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const bound = () => handler(signal);
      process.on(signal, bound);
      this.signalDisposers.push(() => process.off(signal, bound));
    }
  }
}
