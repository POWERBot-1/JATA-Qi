// DNSSEC — RFC 4033/4034/4035 zone signing and verification using real
// cryptography (ECDSA P-256, algorithm 13 / ECDSAP256SHA256, RFC 6605). Produces
// DNSKEY, RRSIG, DS, and a complete NSEC denial chain. Zero deps (node:crypto).

import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { CLASS_IN, Rtype } from './types.js';
import { nameToLabels, normalizeName } from './wire.js';
import type { DnsRecord, RecordData, Zone, ZoneRecord } from './types.js';

export const DNSSEC_ALG = 13; // ECDSAP256SHA256
export const DS_DIGEST_SHA256 = 2;

export interface SigningKey {
  /** DNSKEY flags: 257 (KSK/SEP) or 256 (ZSK). */
  flags: number;
  /** Public key RDATA (base64): for ECDSA P-256 this is x||y (64 bytes). */
  publicKey: string;
  /** Computed key tag. */
  keyTag: number;
  /** Node KeyObject (private) for signing. */
  privateObject: unknown;
  /** Node KeyObject (public) for verification. */
  publicObject: unknown;
}

function b64uToB64(b64u: string): string {
  return b64u.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64u.length / 4) * 4, '=');
}

/** Generate an ECDSA P-256 DNSSEC signing key. */
export function generateSigningKey(flags: number): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pubBytes = Buffer.concat([
    Buffer.from(b64uToB64(jwk.x), 'base64'),
    Buffer.from(b64uToB64(jwk.y), 'base64'),
  ]);
  const publicKeyB64 = pubBytes.toString('base64');
  // Key tag is computed over the full DNSKEY RDATA (flags|protocol|algorithm|key).
  const dnskeyRdata = Buffer.concat([
    Buffer.from([(flags >> 8) & 0xff, flags & 0xff, 3, DNSSEC_ALG]),
    pubBytes,
  ]);
  return {
    flags,
    publicKey: publicKeyB64,
    keyTag: keyTag(dnskeyRdata),
    privateObject: privateKey,
    publicObject: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }),
  };
}

/** Compute the DNSKEY key tag (RFC 4034 Appendix B). */
export function keyTag(dnskeyRdata: Uint8Array): number {
  let ac = 0;
  for (let i = 0; i < dnskeyRdata.length; i++) {
    ac += i % 2 === 0 ? dnskeyRdata[i]! : dnskeyRdata[i]! << 8;
  }
  ac += (ac >> 16) & 0xffff;
  return ac & 0xffff;
}

/** Build a DNSKEY record from a signing key. */
export function dnskeyRecord(origin: string, key: SigningKey, ttl: number): ZoneRecord {
  const data: RecordData = {
    type: 'DNSKEY',
    flags: key.flags,
    protocol: 3,
    algorithm: DNSSEC_ALG,
    publicKey: key.publicKey,
  };
  return { name: normalizeName(origin), type: Rtype.DNSKEY, class: CLASS_IN, ttl, data };
}

/** Compute the DS record (SHA-256 digest) for a zone's KSK, for the parent zone. */
export function computeDs(zoneOrigin: string, dnskey: ZoneRecord): ZoneRecord {
  if (dnskey.data.type !== 'DNSKEY') throw new Error('computeDs: not a DNSKEY record');
  // Digest = SHA-256(canonical owner name || DNSKEY RDATA)
  const owner = canonicalName(dnskey.name);
  const rdata = encodeDnskeyRdata(dnskey.data);
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from(owner), rdata])).digest('hex');
  return {
    name: normalizeName(zoneOrigin),
    type: Rtype.DS,
    class: CLASS_IN,
    ttl: dnskey.ttl,
    data: { type: 'DS', keyTag: keyTag(rdata), algorithm: dnskey.data.algorithm, digestType: DS_DIGEST_SHA256, digest },
  };
}

// ---------------------------------------------------------------------------
// Canonicalization + RDATA encoding (RFC 4034 6.2).
// ---------------------------------------------------------------------------

/** Encode a domain name as wire labels (lowercased, no compression). */
export function canonicalName(name: string): number[] {
  const labels = nameToLabels(name); // already lowercased
  const out: number[] = [];
  for (const label of labels) {
    out.push(label.length);
    for (let i = 0; i < label.length; i++) out.push(label.charCodeAt(i) & 0xff);
  }
  out.push(0);
  return out;
}

/** Canonical RDATA bytes for a record (domain names lowercased, no compression). */
export function canonicalRdata(data: RecordData): Buffer {
  // Mirror wire.encodeRdata but isolated so DNSSEC has no import cycle.
  const out: number[] = [];
  const u16 = (v: number) => out.push((v >> 8) & 0xff, v & 0xff);
  const u32 = (v: number) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const name = (n: string) => { for (const b of canonicalName(n)) out.push(b); };
  switch (data.type) {
    case 'A': for (const o of data.address.split('.')) out.push(Number.parseInt(o, 10) & 0xff); break;
    case 'AAAA': for (const b of parseIpv6Bytes(data.address)) out.push(b); break;
    case 'NS': name(data.nsdname); break;
    case 'CNAME': name(data.cname); break;
    case 'PTR': name(data.ptrdname); break;
    case 'MX': u16(data.preference); name(data.exchange); break;
    case 'TXT': for (const s of data.strings) { const b = Buffer.from(s, 'utf8'); out.push(b.length); for (const x of b) out.push(x); } break;
    case 'SOA': name(data.mname); name(data.rname); u32(data.serial); u32(data.refresh); u32(data.retry); u32(data.expire); u32(data.minimum); break;
    case 'SRV': u16(data.priority); u16(data.weight); u16(data.port); name(data.target); break;
    case 'CAA': { const t = Buffer.from(data.tag, 'latin1'); out.push(data.flags & 0xff, t.length, ...t); out.push(...Buffer.from(data.value, 'latin1')); break; }
    case 'DNSKEY': return encodeDnskeyRdata(data);
    case 'DS': u16(data.keyTag); out.push(data.algorithm & 0xff, data.digestType & 0xff); out.push(...Buffer.from(data.digest, 'hex')); break;
    case 'RRSIG': {
      u16(data.typeCovered); out.push(data.algorithm & 0xff, data.labels & 0xff);
      u32(data.originalTtl); u32(data.expiration); u32(data.inception); u16(data.keyTag);
      for (const b of canonicalName(data.signerName)) out.push(b);
      out.push(...Buffer.from(data.signature, 'base64'));
      break;
    }
    case 'NSEC': for (const b of canonicalName(data.nextDomain)) out.push(b); out.push(...data.typeBitmaps); break;
    case 'OPT': break;
    case 'raw': out.push(...Buffer.from(data.rdata, 'base64')); break;
  }
  return Buffer.from(out);
}

function encodeDnskeyRdata(data: Extract<RecordData, { type: 'DNSKEY' }>): Buffer {
  const out: number[] = [];
  out.push((data.flags >> 8) & 0xff, data.flags & 0xff, data.protocol & 0xff, data.algorithm & 0xff);
  out.push(...Buffer.from(data.publicKey, 'base64'));
  return Buffer.from(out);
}

/** Canonical RR for signing: owner || type || class || origTtl || rdlen || rdata. */
function canonicalRr(owner: string, type: number, ttl: number, rdata: Buffer): Buffer {
  const name = Buffer.from(canonicalName(owner));
  const hdr = Buffer.alloc(8);
  hdr.writeUInt16BE(type, 0);
  hdr.writeUInt16BE(CLASS_IN, 2);
  hdr.writeUInt32BE(ttl >>> 0, 4);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([name, hdr, len, rdata]);
}

/** Number of labels in an owner name for the RRSIG Labels field (RFC 4034 3.1.3). */
export function ownerLabels(name: string): number {
  const labels = nameToLabels(name);
  // Wildcard '*' is not counted.
  if (labels.length > 0 && labels[0] === '*') return labels.length - 1;
  return labels.length;
}

// ---------------------------------------------------------------------------
// RRset signing.
// ---------------------------------------------------------------------------

/** Group zone records into RRsets keyed by `owner|type` (RRSIG/NSEC excluded). */
function groupRrsets(records: ZoneRecord[]): Array<{ owner: string; type: number; ttl: number; rdatas: Buffer[] }> {
  const map = new Map<string, { owner: string; type: number; ttl: number; rdatas: Buffer[] }>();
  for (const r of records) {
    if (r.type === Rtype.RRSIG || r.type === Rtype.NSEC) continue;
    const key = `${r.name}|${r.type}`;
    let g = map.get(key);
    if (!g) { g = { owner: r.name, type: r.type, ttl: r.ttl, rdatas: [] }; map.set(key, g); }
    if (r.ttl < g.ttl) g.ttl = r.ttl;
    g.rdatas.push(canonicalRdata(r.data));
  }
  // Sort each RRset's RDATA canonically (lexicographic on bytes).
  for (const g of map.values()) g.rdatas.sort(Buffer.compare);
  return [...map.values()];
}

/** The RRSIG record-data variant. */
export type RrsigData = Extract<RecordData, { type: 'RRSIG' }>;

/** Sign a single RRset, returning an RRSIG RecordData. */
export function signRrset(
  rrset: { owner: string; type: number; ttl: number; rdatas: Buffer[] },
  signer: SigningKey,
  origin: string,
  inception: number,
  expiration: number,
): RrsigData {
  const labels = ownerLabels(rrset.owner);
  // RRSIG RDATA (minus signature field).
  const sigRdata: number[] = [];
  const u16 = (v: number) => sigRdata.push((v >> 8) & 0xff, v & 0xff);
  const u32 = (v: number) => sigRdata.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  u16(rrset.type);
  sigRdata.push(DNSSEC_ALG);
  sigRdata.push(labels);
  u32(rrset.ttl >>> 0);
  u32(expiration);
  u32(inception);
  u16(signer.keyTag);
  for (const b of canonicalName(origin)) sigRdata.push(b);
  const sigRdataBuf = Buffer.from(sigRdata);
  // Canonical RRset bytes.
  const rrBufs = rrset.rdatas.map((rd) => canonicalRr(rrset.owner, rrset.type, rrset.ttl, rd));
  rrBufs.sort(Buffer.compare);
  const toSign = Buffer.concat([sigRdataBuf, ...rrBufs]);
  const signature = sign('sha256', toSign, { key: signer.privateObject as never, dsaEncoding: 'ieee-p1363' });
  return {
    type: 'RRSIG',
    typeCovered: rrset.type,
    algorithm: DNSSEC_ALG,
    labels,
    originalTtl: rrset.ttl,
    expiration,
    inception,
    keyTag: signer.keyTag,
    signerName: normalizeName(origin),
    signature: signature.toString('base64'),
  };
}

/** Verify an RRSIG over an RRset using a DNSKEY. Returns true if valid. */
export function verifyRrset(
  rrset: { owner: string; type: number; ttl: number; rdatas: Buffer[] },
  rrsig: Extract<RecordData, { type: 'RRSIG' }>,
  signerPublicObject: unknown,
): boolean {
  try {
    const sigRdata: number[] = [];
    const u16 = (v: number) => sigRdata.push((v >> 8) & 0xff, v & 0xff);
    const u32 = (v: number) => sigRdata.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    u16(rrsig.typeCovered);
    sigRdata.push(rrsig.algorithm, rrsig.labels);
    u32(rrsig.originalTtl);
    u32(rrsig.expiration);
    u32(rrsig.inception);
    u16(rrsig.keyTag);
    for (const b of canonicalName(rrsig.signerName)) sigRdata.push(b);
    const rrBufs = rrset.rdatas.map((rd) => canonicalRr(rrset.owner, rrset.type, rrsig.originalTtl, rd));
    rrBufs.sort(Buffer.compare);
    const toVerify = Buffer.concat([Buffer.from(sigRdata), ...rrBufs]);
    return verify('sha256', toVerify, { key: signerPublicObject as never, dsaEncoding: 'ieee-p1363' }, Buffer.from(rrsig.signature, 'base64'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// NSEC chain.
// ---------------------------------------------------------------------------

/** Encode a set of RR types into DNSSEC type bitmaps (RFC 4034 4.1.2). */
export function encodeTypeBitmaps(types: number[]): number[] {
  const set = new Set(types);
  const windows = new Map<number, number[]>(); // window -> array of 0/8 bytes
  for (const t of set) {
    const w = t >> 8;
    const arr = windows.get(w) ?? [];
    const byteIdx = (t & 0xff) >> 3;
    while (arr.length <= byteIdx) arr.push(0);
    arr[byteIdx] = (arr[byteIdx] ?? 0) | (0x80 >> (t & 7));
    windows.set(w, arr);
  }
  const out: number[] = [];
  for (const w of [...windows.keys()].sort((a, b) => a - b)) {
    const arr = windows.get(w)!;
    // Trim trailing zero bytes.
    while (arr.length > 0 && arr[arr.length - 1] === 0) arr.pop();
    out.push(w, arr.length, ...arr);
  }
  return out;
}

/** Build the NSEC denial chain for a zone's existing owner names. */
export function buildNsecChain(zone: Zone, existingRecords: ZoneRecord[]): ZoneRecord[] {
  const origin = normalizeName(zone.origin);
  // Distinct owner names that own data (excluding RRSIG/NSEC from prior signing).
  const names = new Set<string>();
  for (const r of existingRecords) {
    if (r.type === Rtype.RRSIG || r.type === Rtype.NSEC) continue;
    names.add(r.name);
  }
  names.add(origin); // apex always present
  const sorted = [...names].sort(canonicalCompare);
  const nsecRecords: ZoneRecord[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const next = sorted[(i + 1) % sorted.length]!;
    const typesHere = existingRecords
      .filter((r) => r.name === cur && r.type !== Rtype.RRSIG && r.type !== Rtype.NSEC)
      .map((r) => r.type);
    typesHere.push(Rtype.RRSIG, Rtype.NSEC);
    nsecRecords.push({
      name: cur,
      type: Rtype.NSEC,
      class: CLASS_IN,
      ttl: 3600,
      data: { type: 'NSEC', nextDomain: next, typeBitmaps: encodeTypeBitmaps([...new Set(typesHere)]) },
    });
  }
  return nsecRecords;
}

/** Canonical name ordering (RFC 4034 6.1): compare reversed labels, label by label. */
export function canonicalCompare(a: string, b: string): number {
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

export interface SignZoneResult {
  records: ZoneRecord[];
  ksk: SigningKey;
  zsk: SigningKey;
  /** DS for the KSK, to be published in the parent zone. */
  ds: ZoneRecord;
}

/**
 * Fully sign a zone: generate KSK + ZSK, add DNSKEY records, build the NSEC
 * chain, and produce an RRSIG over every RRset (DNSKEY signed by KSK, all
 * others by ZSK). Returns the complete signed record set + the parent DS.
 */
export function signZone(
  zone: Zone,
  existingRecords: ZoneRecord[],
  opts: { ksk?: SigningKey; zsk?: SigningKey; inception?: number; expiration?: number } = {},
): SignZoneResult {
  const origin = normalizeName(zone.origin);
  const now = Math.floor(Date.now() / 1000);
  const inception = opts.inception ?? now - 3600;
  const expiration = opts.expiration ?? now + 30 * 86400;
  const ksk = opts.ksk ?? generateSigningKey(257);
  const zsk = opts.zsk ?? generateSigningKey(256);

  // Base records (excluding any prior DNSSEC records so re-signing is idempotent).
  const base = existingRecords.filter((r) => r.type !== Rtype.DNSKEY && r.type !== Rtype.RRSIG && r.type !== Rtype.NSEC && r.type !== Rtype.DS);
  const dnskeyTtl = 3600;
  const kskRec = dnskeyRecord(origin, ksk, dnskeyTtl);
  const zskRec = dnskeyRecord(origin, zsk, dnskeyTtl);
  const withKeys = [...base, kskRec, zskRec];

  // Build NSEC chain over the in-zone data (incl. DNSKEY owners).
  const nsecRecords = buildNsecChain(zone, withKeys);
  const withNsec = [...withKeys, ...nsecRecords];

  // Sign every RRset.
  const rrsets = groupRrsets(withNsec);
  const rrsigs: ZoneRecord[] = [];
  for (const rrset of rrsets) {
    const signer = rrset.type === Rtype.DNSKEY ? ksk : zsk;
    const sig = signRrset(rrset, signer, origin, inception, expiration);
    rrsigs.push({ name: rrset.owner, type: Rtype.RRSIG, class: CLASS_IN, ttl: rrset.ttl, data: sig });
  }

  const ds = computeDs(origin, kskRec);
  return { records: [...withNsec, ...rrsigs], ksk, zsk, ds };
}

/** Convert a DnsRecord (parsed from wire) into an RRset for verification. */
export function rrsetFromRecords(records: DnsRecord[]): { owner: string; type: number; ttl: number; rdatas: Buffer[] } | undefined {
  if (records.length === 0) return undefined;
  const owner = records[0]!.name;
  const type = records[0]!.type;
  const ttl = records[0]!.ttl;
  return { owner, type, ttl, rdatas: records.map((r) => canonicalRdata(r.data)) };
}

// Minimal IPv6 parser duplicated from wire.ts to avoid a module cycle.
function parseIpv6Bytes(str: string): number[] {
  // Reuse format from wire via a lazy import-free implementation.
  // (Kept simple: handles standard compressed and v4-mapped forms.)
  const out = new Array<number>(16).fill(0);
  let addr = str.trim();
  const v4 = addr.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let v4Bytes: number[] | null = null;
  if (v4) {
    v4Bytes = v4[1]!.split('.').map((n) => Number.parseInt(n, 10));
    addr = addr.slice(0, addr.length - v4[0]!.length); // strip the v4 part incl. leading colon
  }
  const groups: number[] = [];
  let left: string[] = [];
  let right: string[] = [];
  if (addr.includes('::')) {
    const parts = addr.split('::');
    left = parts[0] ? parts[0].split(':') : [];
    right = parts[1] ? parts[1].split(':') : [];
    for (const g of left) groups.push(parseGroup(g));
    const fill = 8 - left.length - right.length - (v4Bytes ? 2 : 0);
    for (let i = 0; i < fill; i++) groups.push(0);
    for (const g of right) groups.push(parseGroup(g));
  } else {
    left = addr ? addr.split(':') : [];
    for (const g of left) groups.push(parseGroup(g));
  }
  if (v4Bytes) groups.push((v4Bytes[0]! << 8) | v4Bytes[1]!, (v4Bytes[2]! << 8) | v4Bytes[3]!);
  for (let i = 0; i < 8; i++) { out[i * 2] = (groups[i]! >> 8) & 0xff; out[i * 2 + 1] = groups[i]! & 0xff; }
  return out;
  function parseGroup(g: string): number {
    if (g === '') return 0;
    return Number.parseInt(g, 16);
  }
}
