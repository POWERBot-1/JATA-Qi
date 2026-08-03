// DigitalMemoryModule — kernel module wrapping the DigitalMemoryEngine. Persists
// memory to storage, publishes memory events on the bus, and can optionally
// collect platform signals from the bus into memory (governed by org policy).
// Integrates with the Platform Kernel (bus, container), Storage (persistence),
// and respects the engine's per-org policy/consent/retention gating.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { DigitalMemoryEngine } from './engine.js';
import type { MemoryCategory, MemoryEvent, MemoryQuery, MemoryStats, OrgMemoryPolicy, RecordInput, RecordResult } from './types.js';

export const MemoryEvents = Object.freeze({
  Recorded: 'memory.recorded',
  Expired: 'memory.expired',
  Purged: 'memory.purged',
} as const);

const COL_MEMORY = 'memory.events';

/** Map a platform bus event type to a memory category (for collection). */
export interface BusCollectionMapping { eventType: string; category: MemoryCategory; summarize: (payload: unknown) => { summary: string; data?: Record<string, unknown>; tags?: string[] } }

export class DigitalMemoryModule implements IModule {
  readonly id = 'memory';
  readonly tags = ['core', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly engine = new DigitalMemoryEngine();
  private store?: ICollection<MemoryEvent>;
  private unsubs: Array<() => void> = [];
  private loaded = false;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('memory', this);
    // Persist when a storage module is available.
    try {
      const storage = kernel.getModule<StorageModule>('storage');
      this.store = await storage.collection<MemoryEvent>(COL_MEMORY);
      for (const e of await this.store.all()) this.engine.hydrate(e);
      this.loaded = true;
      kernel.logger.info(`memory engine initialized (${this.engine.size} events)`);
    } catch {
      kernel.logger.info('memory engine initialized (in-memory; no storage)');
    }
  }

  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { for (const u of this.unsubs) u(); this.unsubs = []; }

  /** Record a platform signal (persists + emits). */
  async record(input: RecordInput): Promise<RecordResult> {
    const result = this.engine.record(input);
    if (result.recorded && result.event) {
      if (this.store) void this.store.put(result.event);
      void this.api.bus.emit(MemoryEvents.Recorded, { id: result.event.id, category: input.category, orgId: input.orgId });
    }
    return result;
  }

  get(id: string): MemoryEvent | undefined { return this.engine.get(id); }
  query(filter: MemoryQuery = {}): MemoryEvent[] { return this.engine.query(filter); }
  /** Cross-org query for internal platform services (learning/adaptation). */
  queryAll(filter: MemoryQuery = {}): MemoryEvent[] { return this.engine.queryAll(filter); }
  stats(orgId?: string): MemoryStats { return this.engine.stats(orgId); }

  setPolicy(policy: OrgMemoryPolicy): void { this.engine.setPolicy(policy); }

  /** Run retention sweep; persists deletions + emits an expiry event. */
  async sweep(now = Date.now()): Promise<number> {
    const before = this.engine.size;
    const removed = this.engine.sweep(now);
    if (removed > 0 && this.store) {
      // Re-sync persisted store to the surviving set.
      const survivors = new Set(this.query({ limit: Number.POSITIVE_INFINITY }).map((e) => e.id));
      for (const e of await this.store.all()) if (!survivors.has(e.id)) void this.store.delete(e.id);
    }
    if (removed > 0) void this.api.bus.emit(MemoryEvents.Expired, { removed });
    void before;
    return removed;
  }

  /** Right-to-delete a subject's memory (GDPR-style erasure). */
  async deleteForSubject(opts: { userId?: string; orgId?: string }): Promise<number> {
    const removed = this.engine.deleteForSubject(opts);
    if (removed > 0 && this.store) {
      const survivors = new Set(this.query({ limit: Number.POSITIVE_INFINITY }).map((e) => e.id));
      for (const e of await this.store.all()) if (!survivors.has(e.id)) void this.store.delete(e.id);
    }
    if (removed > 0) void this.api.bus.emit(MemoryEvents.Purged, { ...opts, removed });
    return removed;
  }

  exportFor(filter: { userId?: string; orgId?: string }): MemoryEvent[] { return this.engine.exportFor(filter); }

  /**
   * Opt-in: subscribe to selected platform bus events and record them as
   * memory. Each mapping converts a bus payload into a governed MemoryEvent.
   * Collection is still subject to per-org policy/consent in the engine.
   */
  collectFromBus(mappings: BusCollectionMapping[]): void {
    for (const m of mappings) {
      const handler = (payload: unknown): void => {
        const { summary, data, tags } = m.summarize(payload);
        const input: RecordInput = { category: m.category, summary, ...(data ? { data } : {}), ...(tags ? { tags } : {}), correlationId: randomUUID() };
        void this.record(input);
      };
      this.api.bus.on(m.eventType, handler);
      this.unsubs.push(() => this.api.bus.off(m.eventType, handler));
    }
  }
}

export { DigitalMemoryEngine };
export type { MemoryCategory, MemoryEvent, MemoryQuery, MemoryStats, OrgMemoryPolicy, RecordInput, RecordResult };
