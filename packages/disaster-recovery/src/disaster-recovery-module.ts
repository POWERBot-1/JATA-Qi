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

export const DREvents = Object.freeze({
  SnapshotCreated: 'dr.snapshot.created',
  RestoreCompleted: 'dr.restore.completed',
  RestoreFailed: 'dr.restore.failed',
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
  async stop(_k: KernelApi): Promise<void> {}

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
