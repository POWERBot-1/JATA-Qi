// GeoDNS — view-based responses, weighted load balancing, and failover.
// Pure Node CIDR matching (IPv4 + IPv6) with no deps.

import { Rtype } from './types.js';
import { parseIpv6 } from './wire.js';
import { normalizeName } from './wire.js';
import type { RecordData } from './types.js';

export type GeoPolicy = 'round-robin' | 'geo' | 'failover';

export interface GeoPool {
  /** CIDR prefixes that select this pool (IPv4 or IPv6). Empty = default. */
  cidrs?: string[];
  /** Records served when this pool is selected. */
  records: RecordData[];
  /** Relative weight (for weighted round-robin / failover priority). */
  weight?: number;
}

export interface GeoRule {
  zone: string;
  name: string;
  type: number;
  policy: GeoPolicy;
  pools: GeoPool[];
}

interface AddrParts { bytes: Uint8Array; bits: number }

function parseCidr(cidr: string): AddrParts {
  const slash = cidr.indexOf('/');
  const ip = slash < 0 ? cidr : cidr.slice(0, slash);
  const bits = slash < 0 ? (ip.includes(':') ? 128 : 32) : Number.parseInt(cidr.slice(slash + 1), 10);
  const bytes = ip.includes(':') ? parseIpv6(ip) : ipv4Bytes(ip);
  return { bytes, bits };
}

function ipv4Bytes(ip: string): Uint8Array {
  const octs = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (octs.length !== 4) throw new Error(`bad IPv4 ${ip}`);
  return Uint8Array.from(octs);
}

function ipBytes(ip: string): Uint8Array | undefined {
  try {
    return ip.includes(':') ? parseIpv6(ip) : ipv4Bytes(ip);
  } catch {
    return undefined;
  }
}

function cidrMatch(pool: AddrParts, client: Uint8Array): boolean {
  if (pool.bytes.length !== client.length) return false;
  const fullBytes = pool.bits >> 3;
  const remBits = pool.bits & 7;
  for (let i = 0; i < fullBytes; i++) if (pool.bytes[i] !== client[i]) return false;
  if (remBits > 0) {
    const mask = 0xff << (8 - remBits);
    if ((pool.bytes[fullBytes]! & mask) !== (client[fullBytes]! & mask)) return false;
  }
  return true;
}

export class GeoBalancer {
  private rules = new Map<string, GeoRule>();
  private rrIndex = 0;
  private health = new Map<string, boolean>(); // pool key -> healthy

  addRule(rule: GeoRule): void {
    const key = this.key(rule.zone, rule.name, rule.type);
    this.rules.set(key, { ...rule, zone: normalizeName(rule.zone), name: normalizeName(rule.name) });
  }

  removeRule(zone: string, name: string, type: number): boolean {
    return this.rules.delete(this.key(zone, name, type));
  }

  listRules(): GeoRule[] {
    return [...this.rules.values()];
  }

  /** Mark a pool healthy/unhealthy for failover policy. */
  setHealth(zone: string, name: string, type: number, poolIndex: number, healthy: boolean): void {
    this.health.set(`${this.key(zone, name, type)}#${poolIndex}`, healthy);
  }

  /**
   * Resolve a geo rule for a query. Returns the chosen records, or undefined if
   * no rule applies.
   */
  resolve(zone: string, name: string, type: number, clientIp?: string): RecordData[] | undefined {
    const rule = this.rules.get(this.key(zone, name, type));
    if (!rule) return undefined;
    const client = clientIp ? ipBytes(clientIp) : undefined;
    if (rule.policy === 'geo') {
      // Prefer the first pool whose CIDR matches the client; fall back to default.
      let def: GeoPool | undefined;
      for (const pool of rule.pools) {
        if (!pool.cidrs || pool.cidrs.length === 0) { def = def ?? pool; continue; }
        if (client && pool.cidrs.some((c) => cidrMatch(parseCidr(c), client!))) return [...pool.records];
      }
      return def ? this.rotate(def.records) : undefined;
    }
    if (rule.policy === 'failover') {
      // Use the first healthy pool (pools ordered by priority/weight desc).
      const ordered = [...rule.pools].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
      for (let i = 0; i < ordered.length; i++) {
        if (this.health.get(`${this.key(rule.zone, rule.name, rule.type)}#${i}`) === false) continue;
        return [...ordered[i]!.records];
      }
      return ordered.length > 0 ? [...ordered[0]!.records] : undefined;
    }
    // round-robin: rotate across all records of all matching pools.
    const matched = rule.pools.filter((p) => !client || !p.cidrs?.length || p.cidrs.some((c) => cidrMatch(parseCidr(c), client)));
    const pool = matched[0] ?? rule.pools[0];
    return pool ? this.rotate(pool.records) : undefined;
  }

  private rotate(records: RecordData[]): RecordData[] {
    if (records.length <= 1) return [...records];
    const start = this.rrIndex % records.length;
    this.rrIndex = (this.rrIndex + 1) % records.length;
    return [...records.slice(start), ...records.slice(0, start)];
  }

  private key(zone: string, name: string, type: number): string {
    return `${normalizeName(zone)}|${normalizeName(name)}|${type}`;
  }
}

/** Convenience: build a simple A-record pool. */
export function aPool(addresses: string[]): RecordData[] {
  return addresses.map((address) => ({ type: 'A' as const, address }));
}

export { Rtype };
