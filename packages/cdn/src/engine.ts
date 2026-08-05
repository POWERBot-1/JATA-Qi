// CdnEngine — PRX CDN core: edge nodes, cached zones with origins, asset
// caching with TTLs + origin-shield, purge, and edge analytics. Pure engine.

import { randomUUID } from 'node:crypto';
import type { CachedAsset, CacheLookupResult, CacheOutcome, CdnStats, CdnZone, EdgeNode, PurgeResult } from './types.js';

export interface RegisterEdgeNodeInput {
  name: string;
  region: string;
  country: string;
  capacityRps?: number;
}

export interface CreateZoneInput {
  domain: string;
  origin: string;
  originShield?: boolean;
  tlsEnabled?: boolean;
  defaultTtlSec?: number;
}

export interface StoreAssetInput {
  zoneId: string;
  path: string;
  contentType: string;
  sizeBytes: number;
  ttlSec?: number;
}

const DEFAULT_TTL_SEC = 3600;

export class CdnEngine {
  private nodes = new Map<string, EdgeNode>();
  private zones = new Map<string, CdnZone>();
  private assets = new Map<string, CachedAsset>();

  private hits = 0;
  private misses = 0;
  private purges = 0;

  // ---- edge nodes --------------------------------------------------------

  registerEdgeNode(input: RegisterEdgeNodeInput): EdgeNode {
    if (!input.name || !input.region || !input.country) throw new Error('name, region, and country are required');
    const node: EdgeNode = {
      id: randomUUID(), name: input.name, region: input.region, country: input.country,
      capacityRps: input.capacityRps ?? 10_000, status: 'online', createdAt: Date.now(),
    };
    this.nodes.set(node.id, node);
    return node;
  }

  getEdgeNode(id: string): EdgeNode | undefined { return this.nodes.get(id); }
  listEdgeNodes(status?: EdgeNode['status']): EdgeNode[] {
    const all = [...this.nodes.values()];
    return status ? all.filter((n) => n.status === status) : all;
  }

  setEdgeNodeStatus(id: string, status: EdgeNode['status']): EdgeNode | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    node.status = status;
    return node;
  }

  // ---- zones -------------------------------------------------------------

  createZone(input: CreateZoneInput): CdnZone {
    if (!input.domain || !input.origin) throw new Error('domain and origin are required');
    const zone: CdnZone = {
      id: randomUUID(), domain: input.domain, origin: input.origin,
      originShield: input.originShield ?? true,
      tlsEnabled: input.tlsEnabled ?? true,
      defaultTtlSec: input.defaultTtlSec ?? DEFAULT_TTL_SEC,
      status: 'active', createdAt: Date.now(),
    };
    this.zones.set(zone.id, zone);
    return zone;
  }

  getZone(id: string): CdnZone | undefined { return this.zones.get(id); }

  getZoneByDomain(domain: string): CdnZone | undefined {
    return [...this.zones.values()].find((z) => z.domain === domain && z.status !== 'deleted');
  }

  listZones(status?: CdnZone['status']): CdnZone[] {
    const all = [...this.zones.values()];
    return status ? all.filter((z) => z.status === status) : all;
  }

  setZoneStatus(id: string, status: CdnZone['status']): CdnZone | undefined {
    const zone = this.zones.get(id);
    if (!zone) return undefined;
    zone.status = status;
    return zone;
  }

  // ---- caching -----------------------------------------------------------

  /** Cache key = `zoneId + path` (normalized). */
  private keyOf(zoneId: string, path: string): string {
    return `${zoneId}:${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * Look up a cached asset. Returns:
   *   - 'hit'       fresh asset served from the edge
   *   - 'stale'     expired asset (origin shield keeps it for revalidation)
   *   - 'shield_hit' served from the origin-shield cache
   *   - 'miss'      nothing cached — fetch from origin
   */
  lookup(zoneId: string, path: string): CacheLookupResult {
    const key = this.keyOf(zoneId, path);
    const asset = this.assets.get(key);
    if (!asset) {
      this.misses++;
      return { outcome: 'miss' };
    }
    const now = Date.now();
    if (now <= asset.expiresAt) {
      asset.hits += 1;
      this.hits++;
      return { outcome: 'hit', asset };
    }
    // Expired: origin shield serves a revalidated copy; the asset's expiry is
    // extended lazily on next store. Count as a miss for the edge.
    this.misses++;
    return { outcome: asset.shieldServed ? 'shield_hit' : 'stale', asset };
  }

  /** Store an asset in the cache (TTL defaulted from the zone). */
  storeAsset(input: StoreAssetInput): CachedAsset {
    const zone = this.zones.get(input.zoneId);
    if (!zone) throw new Error(`unknown zone ${input.zoneId}`);
    if (zone.status !== 'active') throw new Error(`zone ${zone.domain} is ${zone.status}`);
    const ttlSec = input.ttlSec ?? zone.defaultTtlSec;
    const now = Date.now();
    const key = this.keyOf(zone.id, input.path);
    const existing = this.assets.get(key);
    const asset: CachedAsset = {
      id: existing?.id ?? randomUUID(),
      zoneId: zone.id,
      path: input.path,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      cachedAt: now,
      expiresAt: now + ttlSec * 1000,
      shieldServed: zone.originShield,
      hits: existing?.hits ?? 0,
    };
    this.assets.set(key, asset);
    return asset;
  }

  getAsset(zoneId: string, path: string): CachedAsset | undefined {
    return this.assets.get(this.keyOf(zoneId, path));
  }

  listAssets(zoneId?: string): CachedAsset[] {
    const all = [...this.assets.values()];
    return zoneId ? all.filter((a) => a.zoneId === zoneId) : all;
  }

  // ---- purge -------------------------------------------------------------

  /** Purge a single path, a prefix, or the whole zone. */
  purge(zoneId: string, opts: { path?: string; prefix?: string; all?: boolean }): PurgeResult {
    let purged = 0;
    for (const [key, asset] of this.assets) {
      if (asset.zoneId !== zoneId) continue;
      if (opts.all || (opts.path && key === this.keyOf(zoneId, opts.path)) || (opts.prefix && asset.path.startsWith(opts.prefix))) {
        this.assets.delete(key);
        purged++;
      }
    }
    this.purges += purged;
    return { purged };
  }

  // ---- analytics ---------------------------------------------------------

  stats(): CdnStats {
    const allAssets = [...this.assets.values()];
    return {
      nodes: this.nodes.size,
      nodesOnline: this.listEdgeNodes('online').length,
      zones: this.zones.size,
      activeZones: this.listZones('active').length,
      cachedAssets: allAssets.length,
      cachedBytes: allAssets.reduce((s, a) => s + a.sizeBytes, 0),
      hits: this.hits,
      misses: this.misses,
      purges: this.purges,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
    };
  }
}
