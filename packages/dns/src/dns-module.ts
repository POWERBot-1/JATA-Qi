// DnsModule — kernel module wrapping the zone store, authoritative server,
// recursive resolver, GeoDNS balancer, and DNSSEC signer. Exposes management
// APIs, RDAP lookup, and analytics. Integrates with the accreditation gate so
// that public-trust claims (operating a delegated authority) are never made
// without verified accreditation.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { CLASS_IN, Rtype } from './types.js';
import { ZoneStore, toZoneRecord } from './zones.js';
import { AuthoritativeServer } from './server.js';
import { RecursiveResolver, ROOT_HINTS, type RootServer } from './resolver.js';
import { GeoBalancer } from './geo.js';
import { signZone, type SignZoneResult, type SigningKey } from './dnssec.js';
import { normalizeName } from './wire.js';
import type { RecordData, Zone, ZoneRecord } from './types.js';

export const DnsEvents = Object.freeze({
  ZoneAdded: 'dns.zone.added',
  ZoneRemoved: 'dns.zone.removed',
  ZoneSigned: 'dns.zone.signed',
  RecordAdded: 'dns.record.added',
  QueryAnswered: 'dns.query.answered',
} as const);

export interface DnsConfig {
  /** Start the authoritative UDP/TCP server on boot (default false). */
  serve?: boolean;
  /** Port to listen on (default 8053 to avoid needing privileges in dev). */
  port?: number;
  host?: string;
  udpSize?: number;
  allowAxfr?: boolean;
  /** Root servers for the recursive resolver (defaults to ROOT_HINTS). */
  rootServers?: RootServer[];
  /** Enable the recursive resolver API. */
  recursive?: boolean;
}

export interface RdapResult {
  ldhName: string;
  unicodeName?: string;
  status: string[];
  events: Array<{ eventAction: string; eventDate: string }>;
  nameservers?: Array<{ ldhName: string }>;
  secureDNS?: { delegationSigned: boolean; zoneSigned: boolean };
  notFound?: boolean;
}

export class DnsModule implements IModule {
  readonly id = 'dns';
  readonly tags = ['core', 'infrastructure'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private cfg: Required<DnsConfig>;
  readonly store = new ZoneStore();
  readonly geo = new GeoBalancer();
  private server?: AuthoritativeServer;
  private resolver?: RecursiveResolver;
  private keys = new Map<string, SignZoneResult>(); // origin -> signing result

  constructor(cfg: DnsConfig = {}) {
    this.cfg = {
      serve: cfg.serve ?? false,
      port: cfg.port ?? 8053,
      host: cfg.host ?? '127.0.0.1',
      udpSize: cfg.udpSize ?? 1232,
      allowAxfr: cfg.allowAxfr ?? true,
      rootServers: cfg.rootServers ?? ROOT_HINTS,
      recursive: cfg.recursive ?? false,
    };
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('dns', this);
    if (this.cfg.recursive) {
      this.resolver = new RecursiveResolver({ rootServers: this.cfg.rootServers });
    }
    kernel.logger.info(`dns module initialized (serve=${this.cfg.serve}, recursive=${this.cfg.recursive})`);
  }

  async start(kernel: KernelApi): Promise<void> {
    if (this.cfg.serve) {
      this.server = new AuthoritativeServer(this.store, { geo: this.geo, udpSize: this.cfg.udpSize, allowAxfr: this.cfg.allowAxfr });
      const { udp, tcp } = await this.server.start(this.cfg.port, this.cfg.host);
      kernel.logger.info(`dns authoritative server listening udp=${udp} tcp=${tcp}`);
    }
  }

  async stop(_kernel: KernelApi): Promise<void> {
    await this.server?.stop();
  }

  /** Authoritative server address (zeros until started). */
  get address(): { udp: number; tcp: number } | undefined {
    return this.server?.address;
  }

  // ---- zone management ----------------------------------------------------

  addZone(zone: Zone): void {
    this.store.addZone(zone);
    void this.api.bus.emit(DnsEvents.ZoneAdded, { origin: zone.origin });
    this.api.logger.info(`dns: zone added ${zone.origin}`);
  }

  removeZone(origin: string): boolean {
    const removed = this.store.removeZone(origin);
    if (removed) void this.api.bus.emit(DnsEvents.ZoneRemoved, { origin });
    return removed;
  }

  listZones(): Zone[] {
    return this.store.listZones();
  }

  getZone(origin: string): Zone | undefined {
    return this.store.getZone(origin);
  }

  /** Add records to a zone and bump the SOA serial. */
  addRecords(origin: string, records: Array<{ name: string; type: number; ttl: number; data: RecordData }>): void {
    const zoneRecs: ZoneRecord[] = records.map((r) => toZoneRecord(r.name, r.type, r.ttl, r.data));
    this.store.appendRecords(origin, zoneRecs);
    this.bumpSerial(origin);
    for (const r of records) void this.api.bus.emit(DnsEvents.RecordAdded, { origin, name: r.name, type: r.type });
  }

  /** Sign a zone (DNSSEC). Returns the DS for the parent and the keys. */
  signZone(origin: string, opts: { inception?: number; expiration?: number } = {}): SignZoneResult {
    const zone = this.store.getZone(origin);
    if (!zone) throw new Error(`dns: zone "${origin}" not found`);
    const result = signZone(zone, zone.records, opts);
    this.store.replaceRecords(origin, result.records);
    zone.dnssec = true;
    this.keys.set(normalizeName(origin), result);
    void this.api.bus.emit(DnsEvents.ZoneSigned, { origin, keyTag: result.ksk.keyTag });
    return result;
  }

  /** DS record for a signed zone (to publish in the parent). */
  getDs(origin: string): ZoneRecord | undefined {
    return this.keys.get(normalizeName(origin))?.ds;
  }

  /** Signing keys for a zone (opaque; for key rollover flows). */
  getSigningKeys(origin: string): SignZoneResult | undefined {
    return this.keys.get(normalizeName(origin));
  }

  // ---- query + resolve ----------------------------------------------------

  /** Resolve a name against the local authoritative store (no network). */
  resolveLocal(qname: string, qtype: number, opts: { dnssec?: boolean; do?: boolean } = {}):
    { rcode: number; answers: ZoneRecord[]; aa: boolean; zone?: string } {
    const zone = this.store.findZone(qname);
    if (!zone) return { rcode: 5 /* REFUSED */, answers: [], aa: false };
    const r = this.store.resolve(zone, qname, qtype, opts);
    return { rcode: r.rcode, answers: r.answers.map((a) => ({ name: a.name, type: a.type, class: a.class, ttl: a.ttl, data: a.data })), aa: r.aa, zone: zone.origin };
  }

  /** Recursive resolve (network). Requires recursive:true. */
  async resolve(qname: string, qtype: number, qclass = CLASS_IN) {
    if (!this.resolver) throw new Error('dns: recursive resolver disabled');
    return this.resolver.resolve(qname, qtype, qclass);
  }

  // ---- RDAP ---------------------------------------------------------------

  /** RDAP-style lookup for a name in our authoritative store. */
  rdapLookup(qname: string): RdapResult {
    const name = normalizeName(qname);
    const zone = this.store.findZone(name);
    if (!zone) return { ldhName: name.replace(/\.$/, ''), status: ['not found'], events: [], notFound: true };
    const atName = this.store.recordsAt(zone, name);
    const ns = atName.filter((r) => r.type === Rtype.NS).map((r) => r.data.type === 'NS' ? r.data.nsdname.replace(/\.$/, '') : '');
    const signed = !!zone.dnssec;
    return {
      ldhName: name.replace(/\.$/, ''),
      status: atName.length > 0 ? ['active'] : (zone.origin === name ? ['active'] : ['not found']),
      events: [
        { eventAction: 'registration', eventDate: new Date(this.store.soaSerial(zone) * 1000).toISOString() },
      ],
      ...(ns.length > 0 ? { nameservers: ns.map((ldhName) => ({ ldhName })) } : {}),
      ...(zone.origin === name ? { secureDNS: { delegationSigned: signed, zoneSigned: signed } } : {}),
    };
  }

  /** Authoritative-server analytics snapshot. */
  analytics() {
    return this.server?.analytics();
  }

  // ---- helpers ------------------------------------------------------------

  private bumpSerial(origin: string): void {
    const zone = this.store.getZone(origin);
    if (!zone) return;
    const soa = this.store.recordsAt(zone, zone.origin).find((r) => r.type === Rtype.SOA);
    if (soa && soa.data.type === 'SOA') {
      soa.data.serial += 1;
      zone.soa.serial = soa.data.serial;
    }
  }
}

export { CLASS_IN, Rtype };
