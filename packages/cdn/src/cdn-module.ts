// CdnModule — PRX CDN kernel module. Wraps the engine, emits bus events, and
// records cache milestones into the Digital Memory Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { CdnEngine, type CreateZoneInput, type RegisterEdgeNodeInput, type StoreAssetInput } from './engine.js';
import type { CachedAsset, CacheLookupResult, CdnStats, CdnZone, EdgeNode, PurgeResult } from './types.js';

export const CdnEvents = Object.freeze({
  NodeRegistered: 'cdn.node.registered',
  ZoneCreated: 'cdn.zone.created',
  AssetCached: 'cdn.asset.cached',
  AssetServed: 'cdn.asset.served',
  CachePurged: 'cdn.cache.purged',
} as const);

export class CdnModule implements IModule {
  readonly id = 'cdn';
  readonly tags = ['core', 'cdn', 'infrastructure'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new CdnEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('cdn', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('cdn module initialized (PRX CDN Provider)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  registerEdgeNode(input: RegisterEdgeNodeInput): EdgeNode {
    const node = this.engine.registerEdgeNode(input);
    void this.api.bus.emit(CdnEvents.NodeRegistered, { id: node.id, region: node.region });
    return node;
  }
  listEdgeNodes(status?: EdgeNode['status']): EdgeNode[] { return this.engine.listEdgeNodes(status); }
  setEdgeNodeStatus(id: string, status: EdgeNode['status']): EdgeNode | undefined {
    return this.engine.setEdgeNodeStatus(id, status);
  }

  createZone(input: CreateZoneInput): CdnZone {
    const zone = this.engine.createZone(input);
    void this.api.bus.emit(CdnEvents.ZoneCreated, { id: zone.id, domain: zone.domain });
    return zone;
  }
  getZone(id: string): CdnZone | undefined { return this.engine.getZone(id); }
  getZoneByDomain(domain: string): CdnZone | undefined { return this.engine.getZoneByDomain(domain); }
  listZones(status?: CdnZone['status']): CdnZone[] { return this.engine.listZones(status); }
  setZoneStatus(id: string, status: CdnZone['status']): CdnZone | undefined {
    return this.engine.setZoneStatus(id, status);
  }

  async storeAsset(input: StoreAssetInput): Promise<CachedAsset> {
    const asset = this.engine.storeAsset(input);
    void this.api.bus.emit(CdnEvents.AssetCached, { id: asset.id, zoneId: asset.zoneId, path: asset.path, sizeBytes: asset.sizeBytes });
    await this.recordMemory('cdn_cache', `cached ${asset.path} (${asset.sizeBytes} bytes) on zone ${asset.zoneId}`, {
      assetId: asset.id, zoneId: asset.zoneId, path: asset.path,
    });
    return asset;
  }

  lookup(zoneId: string, path: string): CacheLookupResult {
    const result = this.engine.lookup(zoneId, path);
    if (result.asset) {
      void this.api.bus.emit(CdnEvents.AssetServed, { zoneId, path, outcome: result.outcome });
    }
    return result;
  }

  getAsset(zoneId: string, path: string): CachedAsset | undefined {
    return this.engine.getAsset(zoneId, path);
  }
  listAssets(zoneId?: string): CachedAsset[] { return this.engine.listAssets(zoneId); }

  async purge(zoneId: string, opts: { path?: string; prefix?: string; all?: boolean }): Promise<PurgeResult> {
    const result = this.engine.purge(zoneId, opts);
    if (result.purged > 0) {
      void this.api.bus.emit(CdnEvents.CachePurged, { zoneId, purged: result.purged });
      await this.recordMemory('cdn_cache', `purged ${result.purged} asset(s) on zone ${zoneId}`, {
        zoneId, purged: result.purged, ...(opts.path ? { path: opts.path } : {}),
      });
    }
    return result;
  }

  stats(): CdnStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['cdn', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
