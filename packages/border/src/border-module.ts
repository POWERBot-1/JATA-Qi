// BorderModule — KARIS BORDER X kernel module. Wraps the engine, emits bus
// events, and records crossings into the Digital Memory Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { BorderEngine, type DeclareManifestInput, type ProcessCrossingInput, type RegisterPostInput } from './engine.js';
import type {
  BorderPost, BorderStats, CargoManifest, Clearance, Crossing, CrossingMode,
  ManifestStatus, WatchlistEntry,
} from './types.js';

export const BorderEvents = Object.freeze({
  PostRegistered: 'border.post.registered',
  WatchlistAdded: 'border.watchlist.added',
  CrossingProcessed: 'border.crossing.processed',
  CrossingReferred: 'border.crossing.referred',
  ManifestDeclared: 'border.manifest.declared',
  ManifestFlagged: 'border.manifest.flagged',
} as const);

export class BorderModule implements IModule {
  readonly id = 'border';
  readonly tags = ['core', 'border', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new BorderEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('border', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('border module initialized (KARIS BORDER X)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  registerPost(input: RegisterPostInput): BorderPost {
    const post = this.engine.registerPost(input);
    void this.api.bus.emit(BorderEvents.PostRegistered, { id: post.id, crossing: post.crossing });
    return post;
  }
  listPosts(status?: BorderPost['status']): BorderPost[] { return this.engine.listPosts(status); }
  setPostStatus(id: string, status: BorderPost['status']): BorderPost | undefined {
    return this.engine.setPostStatus(id, status);
  }

  addWatchlist(input: { name: string; documentNo: string; category: WatchlistEntry['category']; reason: string }): WatchlistEntry {
    const entry = this.engine.addWatchlist(input);
    void this.api.bus.emit(BorderEvents.WatchlistAdded, { id: entry.id, category: entry.category });
    return entry;
  }
  listWatchlist(activeOnly?: boolean): WatchlistEntry[] { return this.engine.listWatchlist(activeOnly); }
  setWatchlistActive(id: string, active: boolean): WatchlistEntry | undefined {
    return this.engine.setWatchlistActive(id, active);
  }

  async processCrossing(input: ProcessCrossingInput): Promise<Crossing> {
    const crossing = this.engine.processCrossing(input);
    void this.api.bus.emit(BorderEvents.CrossingProcessed, { id: crossing.id, clearance: crossing.clearance });
    if (crossing.clearance === 'referred') {
      void this.api.bus.emit(BorderEvents.CrossingReferred, { id: crossing.id, travelerId: crossing.travelerId });
    }
    await this.recordMemory('border_crossing', `${crossing.travelerName} ${crossing.direction} at ${crossing.mode} — ${crossing.clearance}`, {
      crossingId: crossing.id, travelerId: crossing.travelerId, documentNo: crossing.documentNo,
      clearance: crossing.clearance, direction: crossing.direction,
    });
    return crossing;
  }
  listCrossings(filter?: { postId?: string; clearance?: Clearance; direction?: Crossing['direction'] }): Crossing[] {
    return this.engine.listCrossings(filter);
  }
  overrideClearance(id: string, clearance: Clearance, reason?: string): Crossing | undefined {
    return this.engine.overrideClearance(id, clearance, reason);
  }

  async declareManifest(input: DeclareManifestInput): Promise<CargoManifest> {
    const manifest = this.engine.declareManifest(input);
    void this.api.bus.emit(BorderEvents.ManifestDeclared, { id: manifest.id, reference: manifest.reference });
    if (manifest.flagged) {
      void this.api.bus.emit(BorderEvents.ManifestFlagged, { id: manifest.id, reason: 'risk heuristic' });
      await this.recordMemory('border_manifest', `manifest ${manifest.reference} FLAGGED for inspection`, {
        manifestId: manifest.id, reference: manifest.reference, weightKg: manifest.weightKg,
      });
    }
    return manifest;
  }
  listManifests(filter?: { postId?: string; status?: ManifestStatus; flagged?: boolean }): CargoManifest[] {
    return this.engine.listManifests(filter);
  }
  updateManifestStatus(id: string, status: ManifestStatus): CargoManifest | undefined {
    return this.engine.updateManifestStatus(id, status);
  }

  stats(): BorderStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['border', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
