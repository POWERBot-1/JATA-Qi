// RecursiveResolver — iterative DNS resolution (RFC 1034 §5.3.3) starting from
// a configurable root-server set, following referrals, with a TTL cache. Sends
// real DNS queries over UDP (node:dgram) with per-query timeouts. Pure Node.

import { createSocket } from 'node:dgram';
import { CLASS_IN, Rcode, Rtype } from './types.js';
import { decodeMessage, encodeMessage, buildFlags } from './wire.js';
import type { DnsMessage, DnsQuestion, DnsRecord, RecordData } from './types.js';

export interface RootServer {
  name: string;
  address: string;
  port?: number;
}

export interface ResolverConfig {
  /** Root (or forwarding) server candidates. */
  rootServers: RootServer[];
  /** Per-query timeout in ms (default 2000). */
  timeoutMs?: number;
  /** Max referral hops before SERVFAIL (default 16). */
  maxHops?: number;
  /** Cache capacity (default 10000 entries). */
  cacheCapacity?: number;
  /** Port used for servers learned from referrals (glue carries no port;
   * production default 53; tests may override). */
  nsPort?: number;
}

interface CacheEntry { expiry: number; message: DnsMessage }

/**
 * Minimal but real iterative resolver. Walks delegations from the configured
 * root servers, caches positive answers by (name,type,class) with TTLs, and
 * falls back to the next candidate on timeout.
 */
export class RecursiveResolver {
  private cfg: Required<ResolverConfig>;
  private cache = new Map<string, CacheEntry>();

  constructor(cfg: ResolverConfig) {
    this.cfg = {
      timeoutMs: 2000,
      maxHops: 16,
      cacheCapacity: 10000,
      nsPort: 53,
      ...cfg,
    };
  }

  /** Clear the cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Cached answer for a question, or undefined. */
  private cached(q: DnsQuestion): DnsMessage | undefined {
    const key = cacheKey(q);
    const e = this.cache.get(key);
    if (!e) return undefined;
    if (e.expiry < Date.now()) { this.cache.delete(key); return undefined; }
    return e.message;
  }

  private putCache(q: DnsQuestion, msg: DnsMessage, ttl: number): void {
    if (ttl <= 0 || this.cfg.cacheCapacity === 0) return;
    if (this.cache.size >= this.cfg.cacheCapacity) {
      // Evict a random expired-or-oldest entry.
      const first = this.cache.keys().next().value;
      if (first) this.cache.delete(first);
    }
    this.cache.set(cacheKey(q), { expiry: Date.now() + ttl * 1000, message: msg });
  }

  /** Resolve a question into a full DNS response message. */
  async resolve(qname: string, qtype: number, qclass = CLASS_IN): Promise<DnsMessage> {
    const question: DnsQuestion = { name: qname.toLowerCase(), type: qtype, class: qclass };
    const hit = this.cached(question);
    if (hit) return hit;
    let candidates = [...this.cfg.rootServers];
    for (let hop = 0; hop < this.cfg.maxHops && candidates.length > 0; hop++) {
      const server = candidates[0]!;
      let resp: DnsMessage;
      try {
        resp = await this.query(server, question);
      } catch {
        candidates = candidates.slice(1);
        // On total candidate exhaustion, try root again (loop guard via maxHops).
        if (candidates.length === 0) candidates = [...this.cfg.rootServers];
        continue;
      }
      if (resp.answers.length > 0) {
        const minTtl = minAnswerTtl(resp);
        this.putCache(question, resp, minTtl);
        return resp;
      }
      if (resp.header.rcode === Rcode.NXDOMAIN) {
        return resp;
      }
      // Follow a referral (authority NS records).
      const next = extractReferral(resp, this.cfg.nsPort);
      if (next.length === 0) {
        // NODATA with no referral: return as-is.
        return resp;
      }
      candidates = next;
    }
    return servfail(question);
  }

  private query(server: RootServer, question: DnsQuestion): Promise<DnsMessage> {
    return new Promise((resolve, reject) => {
      const sock = createSocket({ type: 'udp4' });
      const id = Math.floor(Math.random() * 0xffff);
      const flags = buildFlags({ rd: false }); // iterative: RD=0
      const msg: DnsMessage = {
        header: { id, flags, opcode: 0, rcode: 0, qr: false, aa: false, tc: false, rd: false, ra: false, z: 0, qdcount: 1, ancount: 0, nscount: 0, arcount: 0 },
        questions: [question],
        answers: [],
        authorities: [],
        additionals: [],
      };
      const buf = encodeMessage(msg);
      const timer = setTimeout(() => { sock.close(); reject(new Error('resolver query timeout')); }, this.cfg.timeoutMs);
      sock.on('message', (data) => {
        clearTimeout(timer);
        try {
          const resp = decodeMessage(data);
          sock.close();
          resolve(resp);
        } catch (e) {
          sock.close();
          reject(e);
        }
      });
      sock.on('error', (e) => { clearTimeout(timer); sock.close(); reject(e); });
      sock.send(buf, server.port ?? 53, server.address, (e) => {
        if (e) { clearTimeout(timer); sock.close(); reject(e); }
      });
    });
  }
}

function cacheKey(q: DnsQuestion): string {
  return `${q.name}|${q.type}|${q.class}`;
}

function minAnswerTtl(msg: DnsMessage): number {
  if (msg.answers.length === 0) return 0;
  return Math.min(...msg.answers.map((a) => a.ttl));
}

/** From a referral response, extract the next-hop server addresses (from glue). */
function extractReferral(resp: DnsMessage, nsPort: number): RootServer[] {
  const nsNames: string[] = [];
  for (const rr of resp.authorities) {
    if (rr.type === Rtype.NS && rr.data.type === 'NS') nsNames.push(rr.data.nsdname);
  }
  if (nsNames.length === 0) return [];
  // Prefer glue A/AAAA from additional.
  const glue = new Map<string, string>();
  for (const rr of resp.additionals) {
    if (rr.data.type === 'A') glue.set(rr.name, rr.data.address);
    if (rr.data.type === 'AAAA' && !glue.has(rr.name)) glue.set(rr.name, rr.data.address);
  }
  const out: RootServer[] = [];
  for (const name of nsNames) {
    const addr = glue.get(name);
    if (addr) out.push({ name, address: addr, port: nsPort });
  }
  return out;
}

/** Build a SERVFAIL response for a question. */
export function servfail(question: DnsQuestion): DnsMessage {
  const id = Math.floor(Math.random() * 0xffff);
  const flags = buildFlags({ qr: true, ra: true, rcode: Rcode.SERVFAIL });
  return {
    header: { id, flags, opcode: 0, rcode: Rcode.SERVFAIL, qr: true, aa: false, tc: false, rd: true, ra: true, z: 0, qdcount: 1, ancount: 0, nscount: 0, arcount: 0 },
    questions: [question],
    answers: [],
    authorities: [],
    additionals: [],
  };
}

/** Public root servers (a-curately trimmed root hints set) for production use. */
export const ROOT_HINTS: RootServer[] = [
  { name: 'a.root-servers.net.', address: '198.41.0.4' },
  { name: 'b.root-servers.net.', address: '199.9.14.201' },
  { name: 'c.root-servers.net.', address: '192.33.4.12' },
  { name: 'd.root-servers.net.', address: '199.7.91.13' },
  { name: 'e.root-servers.net.', address: '192.203.230.10' },
  { name: 'f.root-servers.net.', address: '192.5.5.241' },
  { name: 'g.root-servers.net.', address: '192.112.36.4' },
  { name: 'h.root-servers.net.', address: '198.97.190.53' },
  { name: 'i.root-servers.net.', address: '192.36.148.17' },
  { name: 'j.root-servers.net.', address: '192.58.128.30' },
  { name: 'k.root-servers.net.', address: '193.0.14.129' },
  { name: 'l.root-servers.net.', address: '199.7.83.42' },
  { name: 'm.root-servers.net.', address: '202.12.27.33' },
];

export type { RecordData, DnsRecord };
