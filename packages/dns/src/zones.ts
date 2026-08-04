// Zone store + authoritative resolver. Implements RFC 1034 zone semantics:
// apex SOA/NS, delegation (referrals with glue), CNAME chasing, wildcard
// synthesis, NODATA vs NXDOMAIN, and DNSSEC-aware record selection (RRSIG/NSEC
// read from a signed zone).

import { CLASS_IN, Rcode, Rtype } from './types.js';
import { normalizeName } from './wire.js';
import type { DnsRecord, RecordData, Zone, ZoneRecord } from './types.js';

export interface ResolveResult {
  rcode: number;
  answers: DnsRecord[];
  authority: DnsRecord[];
  additional: DnsRecord[];
  aa: boolean;
  /** Set when a referral was produced (qname below a delegation point). */
  referral?: boolean;
}

function rr(rec: ZoneRecord): DnsRecord {
  return { name: rec.name, type: rec.type, class: rec.class, ttl: rec.ttl, data: rec.data };
}

/** Convert a DnsRecord-style object into a ZoneRecord for storage. */
export function toZoneRecord(name: string, type: number, ttl: number, data: RecordData, comment?: string): ZoneRecord {
  return { name: normalizeName(name), type, class: CLASS_IN, ttl, data, comment };
}

export class ZoneStore {
  private zones = new Map<string, Zone>();

  /** Add (or replace) a zone. Origin is normalized. */
  addZone(zone: Zone): void {
    const origin = normalizeName(zone.origin);
    const records: ZoneRecord[] = zone.records.map((r) => ({ ...r, name: normalizeName(r.name), class: r.class ?? CLASS_IN }));
    // Ensure apex SOA present.
    const hasSoa = records.some((r) => r.name === origin && r.type === Rtype.SOA);
    if (!hasSoa) {
      records.unshift({
        name: origin,
        type: Rtype.SOA,
        class: CLASS_IN,
        ttl: 3600,
        data: { type: 'SOA', ...zone.soa },
        comment: 'apex SOA',
      });
    }
    this.zones.set(origin, { ...zone, origin, records });
  }

  removeZone(origin: string): boolean {
    return this.zones.delete(normalizeName(origin));
  }

  listZones(): Zone[] {
    return [...this.zones.values()];
  }

  getZone(origin: string): Zone | undefined {
    return this.zones.get(normalizeName(origin));
  }

  /** Append records to an existing zone (used by the management API + signing). */
  appendRecords(origin: string, records: ZoneRecord[]): void {
    const z = this.zones.get(normalizeName(origin));
    if (!z) throw new Error(`zone "${origin}" not found`);
    for (const r of records) z.records.push({ ...r, name: normalizeName(r.name), class: r.class ?? CLASS_IN });
  }

  /** Replace all records (e.g. re-signing). */
  replaceRecords(origin: string, records: ZoneRecord[]): void {
    const z = this.zones.get(normalizeName(origin));
    if (!z) throw new Error(`zone "${origin}" not found`);
    z.records = records.map((r) => ({ ...r, name: normalizeName(r.name), class: r.class ?? CLASS_IN }));
  }

  /** Find the most-specific zone authoritative for `name` (longest origin suffix). */
  findZone(name: string): Zone | undefined {
    const n = normalizeName(name);
    let best: Zone | undefined;
    let bestLen = -1;
    for (const z of this.zones.values()) {
      const o = z.origin;
      if (n === o || n.endsWith('.' + o)) {
        if (o.length > bestLen) { best = z; bestLen = o.length; }
      }
    }
    return best;
  }

  /** All records in a zone matching owner name (exact, no wildcard). */
  recordsAt(zone: Zone, name: string): ZoneRecord[] {
    const n = normalizeName(name);
    return zone.records.filter((r) => r.name === n);
  }

  /** Records at a name filtered by type (RRSIG special-cased: returns by covered type). */
  recordsByType(zone: Zone, name: string, type: number): ZoneRecord[] {
    return this.recordsAt(zone, name).filter((r) => {
      if (type === Rtype.ANY) return true;
      if (r.type === Rtype.RRSIG && r.data.type === 'RRSIG') return r.data.typeCovered === type;
      return r.type === type;
    });
  }

  /**
   * Resolve a query against a zone. Implements CNAME chasing, wildcard
   * synthesis, delegation referrals, and NODATA/NXDOMAIN. When `dnssec` is
   * true and the zone is signed, RRSIG and covering NSEC records are attached.
   */
  resolve(zone: Zone, qname: string, qtype: number, opts: { dnssec?: boolean; do?: boolean } = {}): ResolveResult {
    const name = normalizeName(qname);
    const wantDnssec = !!(opts.dnssec && zone.dnssec && opts.do);
    const origin = zone.origin;
    const empty: ResolveResult = { rcode: Rcode.NOERROR, answers: [], authority: [], additional: [], aa: true };

    // META queries (DNSKEY at apex, etc.) handled by recordsAt.
    // 1. Delegation check: is qname at/below a zone cut (NS) that is NOT the apex?
    const delegation = this.findDelegation(zone, name);
    if (delegation && !this.recordsAt(zone, name).some((r) => r.type !== Rtype.NS && r.type !== Rtype.DS && r.type !== Rtype.RRSIG)) {
      // qname is within a delegated subtree and has no in-zone data of its own
      // (only NS/DS/their RRSIG) -> referral.
      const nsRecs = this.recordsAt(zone, delegation).filter((r) => r.type === Rtype.NS);
      const authority = nsRecs.map(rr);
      const additional: DnsRecord[] = [];
      for (const ns of nsRecs) {
        if (ns.data.type === 'NS') {
          const glue = [...this.recordsByType(zone, ns.data.nsdname, Rtype.A), ...this.recordsByType(zone, ns.data.nsdname, Rtype.AAAA)];
          additional.push(...glue.map(rr));
        }
      }
      return { rcode: Rcode.NOERROR, answers: [], authority, additional, aa: false, referral: true };
    }

    // 2. Exact records at name.
    const atName = this.recordsAt(zone, name).filter((r) => r.type !== Rtype.RRSIG && r.type !== Rtype.NSEC);
    const exactType = this.recordsByType(zone, name, qtype).filter((r) => r.type !== Rtype.RRSIG && r.type !== Rtype.NSEC);

    if (exactType.length > 0) {
      const answers = exactType.map(rr);
      const out: ResolveResult = { ...empty, answers };
      this.attachSigs(out, zone, name, qtype, wantDnssec);
      return out;
    }

    // 3. CNAME at the name (chase within zone).
    const cnameRec = atName.find((r) => r.type === Rtype.CNAME);
    if (cnameRec && qtype !== Rtype.CNAME && qtype !== Rtype.ANY) {
      const cname = cnameRec.data.type === 'CNAME' ? cnameRec.data.cname : '';
      const out: ResolveResult = { ...empty, answers: [rr(cnameRec)] };
      if (wantDnssec) this.attachSigs(out, zone, name, Rtype.CNAME, true);
      // Chase the canonical name within the same zone (one hop for simplicity;
      // the resolver/client continues beyond the zone if needed).
      const targetZone = this.findZone(cname) ?? zone;
      if (targetZone === zone) {
        const chased = this.resolve(zone, cname, qtype, opts);
        out.answers.push(...chased.answers);
        // NXDOMAIN propagates through CNAME per RFC 6604.
        if (chased.rcode === Rcode.NXDOMAIN) return { ...out, rcode: Rcode.NXDOMAIN, authority: chased.authority };
      }
      return out;
    }

    // 4. Wildcard synthesis (if no exact non-empty data and name != origin).
    if (atName.length === 0 && name !== origin) {
      const wild = this.matchWildcard(zone, name, qtype);
      if (wild.length > 0) {
        const synthesized: DnsRecord[] = wild.map((r) => ({ ...rr(r), name }));
        const out: ResolveResult = { ...empty, answers: synthesized };
        if (wantDnssec) this.attachWildcardSigs(out, zone, name, qtype, true);
        return out;
      }
    }

    // 5. NODATA (name exists, type doesn't) vs NXDOMAIN (name doesn't exist).
    if (atName.length > 0) {
      const out: ResolveResult = { ...empty, rcode: Rcode.NOERROR, authority: this.soaRecord(zone) };
      if (wantDnssec) this.attachNodataNsec(out, zone, name, qtype);
      return out;
    }

    // Name does not exist.
    const out: ResolveResult = { ...empty, rcode: Rcode.NXDOMAIN, authority: this.soaRecord(zone) };
    if (wantDnssec) this.attachNxdomainNsec(out, zone, name);
    return out;
  }

  private findDelegation(zone: Zone, name: string): string | undefined {
    // Walk up the name from qname toward apex; if any ancestor (excluding apex)
    // has NS records, that's the delegation point.
    const origin = zone.origin;
    let n = name;
    while (n !== origin && n !== '.') {
      const parentDot = n.indexOf('.');
      if (parentDot < 0) break;
      n = n.slice(parentDot + 1);
      if (n === origin || n === '.') break;
      if (this.recordsAt(zone, n).some((r) => r.type === Rtype.NS)) return n;
    }
    return undefined;
  }

  private matchWildcard(zone: Zone, name: string, qtype: number): ZoneRecord[] {
    // Replace the leftmost label with '*'.
    const firstDot = name.indexOf('.');
    if (firstDot < 0) return [];
    const parent = name.slice(firstDot + 1);
    const wildName = '*.' + parent;
    return this.recordsByType(zone, wildName, qtype).filter((r) => r.type !== Rtype.RRSIG && r.type !== Rtype.NSEC);
  }

  private soaRecord(zone: Zone): DnsRecord[] {
    const soa = this.recordsAt(zone, zone.origin).filter((r) => r.type === Rtype.SOA).map(rr);
    return soa;
  }

  private attachSigs(out: ResolveResult, zone: Zone, name: string, type: number, dnssec: boolean): void {
    if (!dnssec) return;
    const sigs = this.recordsAt(zone, name).filter((r) => r.type === Rtype.RRSIG && r.data.type === 'RRSIG' && r.data.typeCovered === type).map(rr);
    out.answers.push(...sigs);
  }

  private attachWildcardSigs(out: ResolveResult, zone: Zone, name: string, type: number, dnssec: boolean): void {
    if (!dnssec) return;
    const firstDot = name.indexOf('.');
    if (firstDot < 0) return;
    const parent = name.slice(firstDot + 1);
    const wildName = '*.' + parent;
    const sigs = this.recordsAt(zone, wildName).filter((r) => r.type === Rtype.RRSIG && r.data.type === 'RRSIG' && r.data.typeCovered === type).map((r) => ({ ...rr(r), name }));
    out.answers.push(...sigs);
  }

  private attachNodataNsec(out: ResolveResult, zone: Zone, name: string, qtype: number): void {
    const nsec = this.recordsAt(zone, name).filter((r) => r.type === Rtype.NSEC).map(rr);
    out.authority.push(...nsec);
    const sigs = this.recordsAt(zone, name).filter((r) => r.type === Rtype.RRSIG && r.data.type === 'RRSIG' && r.data.typeCovered === Rtype.NSEC).map(rr);
    out.authority.push(...sigs);
    void qtype;
  }

  private attachNxdomainNsec(out: ResolveResult, zone: Zone, name: string): void {
    // Find the NSEC that covers `name` (prev < name < next) within the zone's
    // NSEC chain. Also include the closest encloser NSEC.
    const nsecs = zone.records.filter((r) => r.type === Rtype.NSEC && r.data.type === 'NSEC');
    const covering = nsecs.find((r) => {
      const next = r.data.type === 'NSEC' ? r.data.nextDomain : r.name;
      return this.nameBetween(r.name, name, next, zone.origin);
    });
    if (covering) {
      out.authority.push(rr(covering));
      const sig = this.recordsAt(zone, covering.name).find((r) => r.type === Rtype.RRSIG && r.data.type === 'RRSIG' && r.data.typeCovered === Rtype.NSEC);
      if (sig) out.authority.push(rr(sig));
    }
  }

  /** Is `name` strictly between `lo` and `hi` in canonical name order, wrapping at origin? */
  private nameBetween(lo: string, name: string, hi: string, origin: string): boolean {
    const loName = lo === origin ? '\u0000' : lo; // origin sorts first
    return this.cmp(loName, name) < 0 && this.cmp(name, hi) < 0;
  }

  /** Canonical DNS name ordering (RFC 4034 6.1): compare reversed labels. */
  private cmp(a: string, b: string): number {
    const la = a.replace(/\.$/, '').split('.').reverse();
    const lb = b.replace(/\.$/, '').split('.').reverse();
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      const x = la[i] ?? '';
      const y = lb[i] ?? '';
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  }

  /** SOA serial of a zone (for SOA queries + serial bumps on edit). */
  soaSerial(zone: Zone): number {
    const soa = this.recordsAt(zone, zone.origin).find((r) => r.type === Rtype.SOA);
    return soa && soa.data.type === 'SOA' ? soa.data.serial : zone.soa.serial;
  }
}
