// JATA Qi PRX CDN Provider types.

export interface EdgeNode {
  id: string;
  name: string;
  region: string;
  country: string;
  /** Node capacity in requests/sec. */
  capacityRps: number;
  status: 'online' | 'offline' | 'draining';
  createdAt: number;
}

export interface CdnZone {
  id: string;
  /** Zone domain, e.g. assets.example.com. */
  domain: string;
  /** Origin origin URL (scheme + host). */
  origin: string;
  /** Whether origin shield is enabled. */
  originShield: boolean;
  /** Whether TLS termination is enabled. */
  tlsEnabled: boolean;
  /** Default cache TTL in seconds. */
  defaultTtlSec: number;
  status: 'active' | 'paused' | 'deleted';
  createdAt: number;
}

export interface CachedAsset {
  id: string;
  zoneId: string;
  /** Cache key (URL path). */
  path: string;
  contentType: string;
  /** Size in bytes. */
  sizeBytes: number;
  cachedAt: number;
  /** Expiry timestamp (now + ttl). */
  expiresAt: number;
  /** True when served from origin shield on a miss. */
  shieldServed: boolean;
  /** Hit count. */
  hits: number;
}

export type CacheOutcome = 'hit' | 'miss' | 'stale' | 'shield_hit';

export interface CacheLookupResult {
  outcome: CacheOutcome;
  asset?: CachedAsset;
}

export interface PurgeResult {
  purged: number;
}

export interface CdnStats {
  nodes: number;
  nodesOnline: number;
  zones: number;
  activeZones: number;
  cachedAssets: number;
  cachedBytes: number;
  hits: number;
  misses: number;
  purges: number;
  hitRate: number;
}
