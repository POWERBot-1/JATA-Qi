// DisasterRecoveryModule — snapshots, restore, verification (#54).
// Takes point-in-time snapshots of storage namespaces and supports restore
// with integrity verification. Records RPO/RTO metadata.

import { randomUUID, createHash } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection, INamespace } from '@jataqi/storage';

export interface Snapshot {
  id: string;
  namespace: string;
  entries: { key: string; value: unknown; hash: string }[];
  entryCount: number;
  contentHash: string;
  createdAt: number;
  createdBy: string;
}

export interface RestoreResult {
  snapshotId: string;
  namespace: string;
  restoredEntries: number;
  verified: boolean;
  durationMs: number;
}

/**
 * Scheduled-backup configuration (PR4 — automated disaster recovery). The
 * scheduler takes point-in-time snapshots of the listed namespaces on a fixed
 * cadence and enforces a retention window so old snapshots are pruned.
 */
export interface BackupScheduleConfig {
  /** Storage namespaces to snapshot on each run. */
  namespaces: string[];
  /** Interval between backup runs, in ms. */
  intervalMs: number;
  /** Snapshots to retain per namespace (older ones are pruned). Default 10. */
  retention?: number;
  /** Actor recorded against each backup (audit + notifications). Default 'system'. */
  createdBy?: string;
  /** Notification recipient for backup completion notices (default createdBy). */
  notifyRecipient?: string;
}

export interface BackupRunResult {
  /** Snapshot ids created this run (one per namespace). */
  snapshotIds: string[];
  /** Number of out-of-retention snapshots pruned this run. */
  pruned: number;
  ranAt: number;
}

export interface BackupScheduleHandle {
  readonly id: string;
  readonly config: BackupScheduleConfig;
  /** True while the scheduler interval is active. */
  readonly running: boolean;
  readonly lastRunAt?: number;
  readonly lastResult?: BackupRunResult;
  /** Run one backup cycle immediately (used by tests / on-demand backups). */
  runNow(): Promise<BackupRunResult>;
  /** Stop the scheduled interval. */
  stop(): void;
}

export const DREvents = Object.freeze({
  SnapshotCreated: 'dr.snapshot.created',
  RestoreCompleted: 'dr.restore.completed',
  RestoreFailed: 'dr.restore.failed',
  BackupRun: 'dr.backup.run',
  BackupScheduled: 'dr.backup.scheduled',
} as const);

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export class DisasterRecoveryModule implements IModule {
  readonly id = 'disaster-recovery';
  readonly tags = ['core', 'resilience'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private snapshots!: ICollection<Snapshot>;
  /** Active backup schedulers, keyed by handle id. */
  private readonly schedulers = new Map<string, BackupScheduleHandle & { timer: NodeJS.Timeout }>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
      namespace: (n: string) => Promise<INamespace>;
    };
    this.snapshots = await storage.collection<Snapshot>('dr.snapshots');
    kernel.container.registerValue('disaster-recovery', this);
    kernel.logger.info('disaster-recovery module initialized');
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {
    // Stop all active backup schedulers so the process can shut down cleanly.
    for (const handle of this.schedulers.values()) {
      handle.stop();
    }
    this.schedulers.clear();
  }

  // --- scheduled backups (PR4 — automated DR) -----------------------------

  /**
   * Run a single backup cycle: snapshot each configured namespace, then prune
   * snapshots beyond the retention window. Emits an event, writes an audit
   * record, and (when the notifications module is present) sends a notice.
   */
  async runBackupCycle(config: BackupScheduleConfig): Promise<BackupRunResult> {
    if (!Array.isArray(config.namespaces) || config.namespaces.length === 0) {
      throw new Error('dr: at least one namespace is required for a backup cycle');
    }
    // NOTE: intervalMs is a scheduler concern; a one-off cycle does not require it.
    const retention = config.retention ?? 10;
    const actor = config.createdBy ?? 'system';
    const snapshotIds: string[] = [];
    let pruned = 0;
    for (const ns of config.namespaces) {
      const snap = await this.createSnapshot(ns, actor);
      snapshotIds.push(snap.id);
      // Enforce retention: keep the newest `retention`, prune the rest.
      const all = await this.listSnapshots(ns);
      const stale = all.slice(retention); // listSnapshots is newest-first
      for (const s of stale) {
        await this.deleteSnapshot(s.id);
        pruned++;
      }
    }
    const result: BackupRunResult = { snapshotIds, pruned, ranAt: Date.now() };
    await this.api.bus.emit(DREvents.BackupRun, result);
    await this.audit(actor, 'backup_run', { namespaces: config.namespaces, created: snapshotIds.length, pruned });
    await this.notifyBackup(config, result);
    return result;
  }

  /**
   * Start an automated backup scheduler. Returns a handle that can run a cycle
   * on demand (`runNow`) and stop the interval (`stop`). Schedulers are stopped
   * automatically when the module shuts down.
   */
  async startScheduler(config: BackupScheduleConfig): Promise<BackupScheduleHandle> {
    if (!config.intervalMs || config.intervalMs <= 0) {
      throw new Error('dr: intervalMs must be a positive number');
    }
    if (!Array.isArray(config.namespaces) || config.namespaces.length === 0) {
      throw new Error('dr: at least one namespace is required for a backup cycle');
    }
    const moduleRef = this;
    const id = randomUUID();
    const state = { lastRunAt: undefined as number | undefined, lastResult: undefined as BackupRunResult | undefined, running: true };
    const cycle = async (): Promise<BackupRunResult> => {
      const res = await moduleRef.runBackupCycle(config);
      state.lastResult = res;
      state.lastRunAt = res.ranAt;
      return res;
    };
    const safeCycle = async (): Promise<void> => {
      try { await cycle(); } catch (err) {
        moduleRef.api.logger.warn(`dr: backup cycle failed: ${(err as Error).message}`);
      }
    };
    const timer = setInterval(() => { void safeCycle(); }, config.intervalMs);
    // Node keeps the process alive for intervals; allow shutdown to proceed.
    timer.unref?.();
    const stop = (): void => {
      state.running = false;
      clearInterval(timer);
      moduleRef.schedulers.delete(id);
    };
    const handle: BackupScheduleHandle & { timer: NodeJS.Timeout } = {
      id,
      config,
      get running(): boolean { return state.running; },
      get lastRunAt(): number | undefined { return state.lastRunAt; },
      get lastResult(): BackupRunResult | undefined { return state.lastResult; },
      runNow: cycle,
      stop,
      timer,
    };
    this.schedulers.set(id, handle);
    await this.api.bus.emit(DREvents.BackupScheduled, { id, config });
    await this.audit(config.createdBy ?? 'system', 'scheduler_started', { id, intervalMs: config.intervalMs, namespaces: config.namespaces });
    return handle;
  }

  /** Active scheduler handles (for introspection / admin). */
  listSchedulers(): Array<{ id: string; running: boolean; lastRunAt?: number }> {
    return [...this.schedulers.values()].map((h) => ({ id: h.id, running: h.running, lastRunAt: h.lastRunAt }));
  }

  private async notifyBackup(config: BackupScheduleConfig, result: BackupRunResult): Promise<void> {
    try {
      const notifications = this.api.getModule('notifications') as unknown as {
        notify: (recipient: string, payload: { type: string; title: string; body?: string; data?: Record<string, unknown> }) => Promise<unknown>;
      } | undefined;
      if (!notifications?.notify) return;
      const recipient = config.notifyRecipient ?? config.createdBy ?? 'system';
      await notifications.notify(recipient, {
        type: 'system',
        title: `Backup complete (${result.snapshotIds.length} snapshot(s))`,
        body: `Pruned ${result.pruned} out-of-retention snapshot(s).`,
        data: { ...result, namespaces: config.namespaces },
      });
    } catch { /* notifications are best-effort */ }
  }

  /** Take a point-in-time snapshot of a storage namespace. */
  async createSnapshot(namespace: string, createdBy: string): Promise<Snapshot> {
    const storage = this.api.getModule('storage') as unknown as {
      namespace: (n: string) => Promise<INamespace>;
    };
    const ns = await storage.namespace(namespace);
    const all = await ns.list({ limit: 100_000 });
    const entries = all.items.map((e) => ({
      key: e.meta?.key ?? (e.value as { id?: string })?.id ?? String(all.items.indexOf(e)),
      value: e.value,
      hash: hashValue(e.value),
    }));
    const contentHash = createHash('sha256').update(entries.map((e) => e.hash).join(':')).digest('hex');
    const snapshot: Snapshot = {
      id: randomUUID(), namespace, entries, entryCount: entries.length,
      contentHash, createdAt: Date.now(), createdBy,
    };
    await this.snapshots.put(snapshot);
    await this.api.bus.emit(DREvents.SnapshotCreated, { id: snapshot.id, namespace, entries: entries.length });
    await this.audit(createdBy, 'snapshot_created', { snapshotId: snapshot.id, namespace });
    return snapshot;
  }

  /** Restore a namespace from a snapshot. Verifies integrity. */
  async restore(snapshotId: string, verifiedBy: string): Promise<RestoreResult> {
    const t0 = Date.now();
    const snapshot = await this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`dr: snapshot "${snapshotId}" not found`);

    const storage = this.api.getModule('storage') as unknown as {
      namespace: (n: string) => Promise<INamespace>;
    };
    const ns = await storage.namespace(snapshot.namespace);

    let restored = 0;
    let verified = true;
    for (const entry of snapshot.entries) {
      // Verify hash before restoring.
      if (hashValue(entry.value) !== entry.hash) { verified = false; continue; }
      await ns.set(entry.key, entry.value);
      restored++;
    }

    const result: RestoreResult = {
      snapshotId, namespace: snapshot.namespace, restoredEntries: restored,
      verified, durationMs: Date.now() - t0,
    };
    if (verified) await this.api.bus.emit(DREvents.RestoreCompleted, result);
    else await this.api.bus.emit(DREvents.RestoreFailed, result);
    await this.audit(verifiedBy, 'restored', { snapshotId, namespace: snapshot.namespace, verified });
    return result;
  }

  async getSnapshot(id: string): Promise<Snapshot | undefined> { return this.snapshots.get(id); }
  async listSnapshots(namespace?: string): Promise<Snapshot[]> {
    const all = await this.snapshots.all();
    const filtered = namespace ? all.filter((s) => s.namespace === namespace) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Delete a snapshot (retention management). */
  async deleteSnapshot(id: string): Promise<boolean> { return this.snapshots.delete(id); }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (r: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec?.audit) await sec.audit({ actor, action: `dr.${action}`, result: 'success', detail });
    } catch {}
  }
}
