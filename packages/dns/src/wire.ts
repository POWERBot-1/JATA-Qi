// DNS wire codec — RFC 1035 message encode/decode with name compression, all
// common resource record types, and EDNS0 (OPT). Pure Node, zero deps.

import {
  CLASS_IN,
  DnsOpcode,
  Rcode,
  Rtype,
  type DnsHeader,
  type DnsMessage,
  type DnsQuestion,
  type DnsRecord,
  type EdnsOption,
  type RecordData,
} from './types.js';

export class WireFormatError extends Error {
  constructor(message: string, public rcode: number = Rcode.FORMERR) {
    super(message);
    this.name = 'WireFormatError';
  }
}

// ---------------------------------------------------------------------------
// IPv6 formatting / parsing (no external deps).
// ---------------------------------------------------------------------------

/** Format 16 bytes into canonical compressed IPv6 text (lowercase, longest :: run). */
export function formatIpv6(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new WireFormatError('IPv6 requires 16 bytes');
  // IPv4-mapped (::ffff:0:0) -> render embedded IPv4.
  const mapped = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0
    && bytes[4] === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0
    && bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  // Find longest run of zero groups (length >= 2).
  let bestStart = -1, bestLen = 0;
  let curStart = -1, curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === 0) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen < 2) { bestStart = -1; }
  const out: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    if (i === bestStart) { out.push(''); if (i + bestLen === groups.length) out.push(''); }
    else if (bestStart >= 0 && i > bestStart && i < bestStart + bestLen) continue;
    else out.push(groups[i]!.toString(16));
  }
  let s = out.join(':');
  if (bestStart === 0 && bestLen === groups.length) s = '::'; // all zeros
  return s;
}

/** Parse an IPv6 textual form (incl. :: compression and IPv4-mapped) into 16 bytes. */
export function parseIpv6(str: string): Uint8Array {
  const out = new Uint8Array(16);
  let addr = str.trim();
  // Embedded IPv4?
  const v4 = addr.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let v4Bytes: number[] | null = null;
  if (v4) {
    const v4str = v4[1]!;
    const octs = v4str.split('.').map((n) => {
      const v = Number.parseInt(n, 10);
      if (v < 0 || v > 255) throw new WireFormatError(`bad IPv4 octet ${n}`);
      return v;
    });
    if (octs.length !== 4) throw new WireFormatError('IPv4 needs 4 octets');
    v4Bytes = octs;
    addr = addr.slice(0, addr.length - v4[0]!.length); // strip the v4 part incl. leading colon
  }
  const doubleColon = addr.includes('::');
  const parts = addr.split('::');
  if (doubleColon && parts.length > 2) throw new WireFormatError('multiple :: in IPv6');
  let left: string[] = [];
  let right: string[] = [];
  if (doubleColon) {
    left = parts[0] ? parts[0].split(':') : [];
    right = parts[1] ? parts[1].split(':') : [];
  } else {
    left = addr ? addr.split(':') : [];
    if (left.length !== (v4Bytes ? 6 : 8)) throw new WireFormatError(`IPv6 group count ${left.length}`);
  }
  const groups: number[] = [];
  for (const g of left) groups.push(parseGroup(g));
  if (doubleColon) {
    const fill = 8 - left.length - right.length - (v4Bytes ? 2 : 0);
    for (let i = 0; i < fill; i++) groups.push(0);
  }
  for (const g of right) groups.push(parseGroup(g));
  if (v4Bytes) { groups.push((v4Bytes[0]! << 8) | v4Bytes[1]!, (v4Bytes[2]! << 8) | v4Bytes[3]!); }
  if (groups.length !== 8) throw new WireFormatError(`IPv6 resolves to ${groups.length} groups`);
  for (let i = 0; i < 8; i++) { out[i * 2] = (groups[i]! >> 8) & 0xff; out[i * 2 + 1] = groups[i]! & 0xff; }
  return out;

  function parseGroup(g: string): number {
    if (g === '') throw new WireFormatError('empty IPv6 group');
    const v = Number.parseInt(g, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff || /[^0-9a-fA-F]/.test(g)) throw new WireFormatError(`bad IPv6 group ${g}`);
    return v;
  }
}

// ---------------------------------------------------------------------------
// Name (de)compression.
// ---------------------------------------------------------------------------

/** Normalize a domain name to lowercase with a trailing dot. '' and '.' -> '.'. */
export function normalizeName(name: string): string {
  let n = name.trim().toLowerCase();
  if (n === '' || n === '.') return '.';
  if (!n.endsWith('.')) n += '.';
  return n;
}

export function nameToLabels(name: string): string[] {
  const n = normalizeName(name);
  if (n === '.') return [];
  return n.slice(0, -1).split('.'); // drop trailing dot, split
}

/** Decode a (possibly compressed) domain name starting at offset. */
export function decodeName(buf: Buffer, offset: number): { name: string; read: number } {
  const labels: string[] = [];
  let pos = offset;
  let consumed = 0;
  let jumped = false;
  let safety = 0;
  while (true) {
    if (++safety > 512) throw new WireFormatError('name decompression loop');
    if (pos >= buf.length) throw new WireFormatError('name truncated');
    const len = buf[pos]!;
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new WireFormatError('pointer truncated');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (ptr >= offset && ptr >= pos) {
        // Pointers must point backwards to avoid loops (RFC 1035 4.1.4).
        throw new WireFormatError('forward/invalid name pointer');
      }
      if (!jumped) { consumed += pos - offset + 2; jumped = true; }
      pos = ptr;
      continue;
    } else if ((len & 0xc0) !== 0) {
      throw new WireFormatError('reserved name label length bits');
    }
    if (len === 0) {
      if (!jumped) consumed += pos - offset + 1;
      break;
    }
    if (pos + 1 + len > buf.length) throw new WireFormatError('label truncated');
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('latin1'));
    pos += 1 + len;
  }
  return { name: labels.length ? labels.join('.').toLowerCase() + '.' : '.', read: consumed };
}

/** Append a name to `out`, optionally compressing against `dict`. */
function encodeName(out: number[], dict: Map<string, number>, name: string, compress: boolean): void {
  const labels = nameToLabels(name);
  let i = 0;
  while (i < labels.length) {
    const suffix = labels.slice(i).join('.') + '.';
    if (compress) {
      const off = dict.get(suffix);
      if (off !== undefined && off <= 0x3fff) {
        out.push(0xc0 | (off >> 8), off & 0xff);
        return;
      }
    }
    const label = labels[i]!;
    if (label.length > 63) throw new WireFormatError(`label too long: ${label}`);
    if (compress) dict.set(suffix, out.length);
    out.push(label.length);
    for (let c = 0; c < label.length; c++) out.push(label.charCodeAt(c) & 0xff);
    i++;
  }
  out.push(0);
}

// ---------------------------------------------------------------------------
// RDATA decode/encode per type.
// ---------------------------------------------------------------------------

function pushU16(out: number[], v: number): void { out.push((v >> 8) & 0xff, v & 0xff); }
function pushU32(out: number[], v: number): void { out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }

/** Decode RDATA for a record type. `offset` is the start of RDATA in buf. */
function decodeRdata(buf: Buffer, offset: number, rdlength: number, type: number): RecordData {
  const end = offset + rdlength;
  const raw = () => ({ type: 'raw' as const, rdata: buf.subarray(offset, end).toString('base64') });
  switch (type) {
    case Rtype.A: {
      if (rdlength !== 4) return raw();
      const b = buf.subarray(offset, offset + 4);
      return { type: 'A', address: `${b[0]}.${b[1]}.${b[2]}.${b[3]}` };
    }
    case Rtype.AAAA: {
      if (rdlength !== 16) return raw();
      return { type: 'AAAA', address: formatIpv6(buf.subarray(offset, offset + 16)) };
    }
    case Rtype.NS:
      return { type: 'NS', nsdname: decodeName(buf, offset).name };
    case Rtype.CNAME:
      return { type: 'CNAME', cname: decodeName(buf, offset).name };
    case Rtype.PTR:
      return { type: 'PTR', ptrdname: decodeName(buf, offset).name };
    case Rtype.MX: {
      if (rdlength < 3) return raw();
      const preference = (buf[offset]! << 8) | buf[offset + 1]!;
      const exchange = decodeName(buf, offset + 2).name;
      return { type: 'MX', preference, exchange };
    }
    case Rtype.TXT: {
      const strings: string[] = [];
      let p = offset;
      while (p < end) {
        const l = buf[p]!;
        p++;
        if (p + l > end) return raw();
        strings.push(buf.subarray(p, p + l).toString('utf8'));
        p += l;
      }
      return { type: 'TXT', strings };
    }
    case Rtype.SOA: {
      const mname = decodeName(buf, offset);
      const rname = decodeName(buf, offset + mname.read);
      const fixed = offset + mname.read + rname.read;
      if (fixed + 20 > end) return raw();
      const serial = buf.readUInt32BE(fixed);
      const refresh = buf.readUInt32BE(fixed + 4);
      const retry = buf.readUInt32BE(fixed + 8);
      const expire = buf.readUInt32BE(fixed + 12);
      const minimum = buf.readUInt32BE(fixed + 16);
      return { type: 'SOA', mname: mname.name, rname: rname.name, serial, refresh, retry, expire, minimum };
    }
    case Rtype.SRV: {
      if (rdlength < 7) return raw();
      const priority = (buf[offset]! << 8) | buf[offset + 1]!;
      const weight = (buf[offset + 2]! << 8) | buf[offset + 3]!;
      const port = (buf[offset + 4]! << 8) | buf[offset + 5]!;
      const target = decodeName(buf, offset + 6).name;
      return { type: 'SRV', priority, weight, port, target };
    }
    case Rtype.CAA: {
      if (rdlength < 2) return raw();
      const flags = buf[offset]!;
      const tagLen = buf[offset + 1]!;
      if (offset + 2 + tagLen > end) return raw();
      const tag = buf.subarray(offset + 2, offset + 2 + tagLen).toString('latin1');
      const value = buf.subarray(offset + 2 + tagLen, end).toString('latin1');
      return { type: 'CAA', flags, tag, value };
    }
    case Rtype.DNSKEY: {
      if (rdlength < 4) return raw();
      const flags = (buf[offset]! << 8) | buf[offset + 1]!;
      const protocol = buf[offset + 2]!;
      const algorithm = buf[offset + 3]!;
      const publicKey = buf.subarray(offset + 4, end).toString('base64');
      return { type: 'DNSKEY', flags, protocol, algorithm, publicKey };
    }
    case Rtype.DS: {
      if (rdlength < 4) return raw();
      const keyTag = (buf[offset]! << 8) | buf[offset + 1]!;
      const algorithm = buf[offset + 2]!;
      const digestType = buf[offset + 3]!;
      const digest = buf.subarray(offset + 4, end).toString('hex');
      return { type: 'DS', keyTag, algorithm, digestType, digest };
    }
    case Rtype.RRSIG: {
      if (rdlength < 18) return raw();
      const typeCovered = (buf[offset]! << 8) | buf[offset + 1]!;
      const algorithm = buf[offset + 2]!;
      const labels = buf[offset + 3]!;
      const originalTtl = buf.readUInt32BE(offset + 4);
      const expiration = buf.readUInt32BE(offset + 8);
      const inception = buf.readUInt32BE(offset + 12);
      const keyTag = (buf[offset + 16]! << 8) | buf[offset + 17]!;
      const signerName = decodeName(buf, offset + 18);
      const signature = buf.subarray(offset + 18 + signerName.read, end).toString('base64');
      return { type: 'RRSIG', typeCovered, algorithm, labels, originalTtl, expiration, inception, keyTag, signerName: signerName.name, signature };
    }
    case Rtype.NSEC: {
      const next = decodeName(buf, offset);
      const bitmaps = [...buf.subarray(offset + next.read, end)];
      return { type: 'NSEC', nextDomain: next.name, typeBitmaps: bitmaps };
    }
    case Rtype.OPT: {
      // OPT is handled at the record level (class = UDP size, ttl = ext flags).
      return { type: 'OPT', udpSize: 0, extRcode: 0, version: 0, flags: 0, options: decodeOpts(buf, offset, end) };
    }
    default:
      return raw();
  }
}

function decodeOpts(buf: Buffer, start: number, end: number): EdnsOption[] {
  const opts: EdnsOption[] = [];
  let p = start;
  while (p + 4 <= end) {
    const code = (buf[p]! << 8) | buf[p + 1]!;
    const len = (buf[p + 2]! << 8) | buf[p + 3]!;
    p += 4;
    if (p + len > end) break;
    opts.push({ code, data: buf.subarray(p, p + len).toString('base64') });
    p += len;
  }
  return opts;
}

/** Encode RDATA for a record type into `out` (names NOT compressed for safety). */
function encodeRdata(data: RecordData): number[] {
  const out: number[] = [];
  const noDict = new Map<string, number>();
  switch (data.type) {
    case 'A': {
      const octs = data.address.split('.').map((n) => Number.parseInt(n, 10));
      if (octs.length !== 4 || octs.some((o) => o < 0 || o > 255)) throw new WireFormatError(`bad IPv4 ${data.address}`);
      out.push(...octs);
      break;
    }
    case 'AAAA': {
      const b = parseIpv6(data.address);
      out.push(...b);
      break;
    }
    case 'NS':
      encodeName(out, noDict, data.nsdname, false);
      break;
    case 'CNAME':
      encodeName(out, noDict, data.cname, false);
      break;
    case 'PTR':
      encodeName(out, noDict, data.ptrdname, false);
      break;
    case 'MX':
      pushU16(out, data.preference);
      encodeName(out, noDict, data.exchange, false);
      break;
    case 'TXT':
      for (const s of data.strings) {
        const b = Buffer.from(s, 'utf8');
        if (b.length > 255) throw new WireFormatError('TXT string > 255 bytes');
        out.push(b.length);
        for (let i = 0; i < b.length; i++) out.push(b[i]!);
      }
      break;
    case 'SOA':
      encodeName(out, noDict, data.mname, false);
      encodeName(out, noDict, data.rname, false);
      pushU32(out, data.serial >>> 0);
      pushU32(out, data.refresh >>> 0);
      pushU32(out, data.retry >>> 0);
      pushU32(out, data.expire >>> 0);
      pushU32(out, data.minimum >>> 0);
      break;
    case 'SRV':
      pushU16(out, data.priority);
      pushU16(out, data.weight);
      pushU16(out, data.port);
      encodeName(out, noDict, data.target, false);
      break;
    case 'CAA': {
      const tagB = Buffer.from(data.tag, 'latin1');
      if (tagB.length > 255) throw new WireFormatError('CAA tag too long');
      out.push(data.flags & 0xff);
      out.push(tagB.length);
      out.push(...tagB);
      const valB = Buffer.from(data.value, 'latin1');
      out.push(...valB);
      break;
    }
    case 'DNSKEY': {
      pushU16(out, data.flags);
      out.push(data.protocol & 0xff);
      out.push(data.algorithm & 0xff);
      const key = Buffer.from(data.publicKey, 'base64');
      out.push(...key);
      break;
    }
    case 'DS': {
      pushU16(out, data.keyTag);
      out.push(data.algorithm & 0xff);
      out.push(data.digestType & 0xff);
      const digest = Buffer.from(data.digest, 'hex');
      out.push(...digest);
      break;
    }
    case 'RRSIG': {
      pushU16(out, data.typeCovered);
      out.push(data.algorithm & 0xff);
      out.push(data.labels & 0xff);
      pushU32(out, data.originalTtl >>> 0);
      pushU32(out, data.expiration >>> 0);
      pushU32(out, data.inception >>> 0);
      pushU16(out, data.keyTag);
      encodeName(out, noDict, data.signerName, false);
      const sig = Buffer.from(data.signature, 'base64');
      out.push(...sig);
      break;
    }
    case 'NSEC': {
      encodeName(out, noDict, data.nextDomain, false);
      out.push(...data.typeBitmaps);
      break;
    }
    case 'OPT': {
      for (const opt of data.options) {
        pushU16(out, opt.code);
        const d = Buffer.from(opt.data, 'base64');
        pushU16(out, d.length);
        out.push(...d);
      }
      break;
    }
    case 'raw': {
      const r = Buffer.from(data.rdata, 'base64');
      out.push(...r);
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message decode / encode.
// ---------------------------------------------------------------------------

export function decodeMessage(buf: Buffer): DnsMessage {
  if (buf.length < 12) throw new WireFormatError('message shorter than header');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);
  const arcount = buf.readUInt16BE(10);
  const opcode = (flags >> 11) & 0xf;
  const rcode = flags & 0xf;
  const header: DnsHeader = {
    id,
    flags,
    opcode,
    rcode,
    qr: (flags & 0x8000) !== 0,
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    rd: (flags & 0x0100) !== 0,
    ra: (flags & 0x0080) !== 0,
    z: (flags >> 4) & 0x7,
    qdcount,
    ancount,
    nscount,
    arcount,
  };
  let pos = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qdcount; i++) {
    const n = decodeName(buf, pos);
    pos += n.read;
    if (pos + 4 > buf.length) throw new WireFormatError('question truncated');
    const type = buf.readUInt16BE(pos);
    const qclass = buf.readUInt16BE(pos + 2);
    pos += 4;
    questions.push({ name: n.name, type, class: qclass });
  }
  const readRecords = (count: number): DnsRecord[] => {
    const recs: DnsRecord[] = [];
    for (let i = 0; i < count; i++) {
      const n = decodeName(buf, pos);
      pos += n.read;
      if (pos + 10 > buf.length) throw new WireFormatError('record header truncated');
      const type = buf.readUInt16BE(pos);
      const rclass = buf.readUInt16BE(pos + 2);
      const ttl = buf.readUInt32BE(pos + 4);
      const rdlength = buf.readUInt16BE(pos + 8);
      pos += 10;
      if (pos + rdlength > buf.length) throw new WireFormatError('rdata truncated');
      let data: RecordData;
      if (type === Rtype.OPT) {
        // OPT: class = UDP payload size, TTL = ext-rcode(8) version(8) flags(16)
        data = {
          type: 'OPT',
          udpSize: rclass,
          extRcode: (ttl >>> 24) & 0xff,
          version: (ttl >>> 16) & 0xff,
          flags: ttl & 0xffff,
          options: decodeOpts(buf, pos, pos + rdlength),
        };
      } else {
        data = decodeRdata(buf, pos, rdlength, type);
      }
      pos += rdlength;
      recs.push({ name: n.name, type, class: rclass, ttl, data });
    }
    return recs;
  };
  const answers = readRecords(ancount);
  const authorities = readRecords(nscount);
  const additionals = readRecords(arcount);
  return { header, questions, answers, authorities, additionals, bytes: buf };
}

/** Build the 16-bit header flags field from components. */
export function buildFlags(opts: {
  qr?: boolean; opcode?: number; aa?: boolean; tc?: boolean;
  rd?: boolean; ra?: boolean; z?: number; rcode?: number;
}): number {
  let f = 0;
  if (opts.qr) f |= 0x8000;
  f |= ((opts.opcode ?? 0) & 0xf) << 11;
  if (opts.aa) f |= 0x0400;
  if (opts.tc) f |= 0x0200;
  if (opts.rd) f |= 0x0100;
  if (opts.ra) f |= 0x0080;
  f |= ((opts.z ?? 0) & 0x7) << 4;
  f |= (opts.rcode ?? 0) & 0xf;
  return f;
}

function writeRecord(out: number[], dict: Map<string, number>, r: DnsRecord): void {
  if (r.type === Rtype.OPT) {
    // OPT pseudo-record: name = root, class = UDP size, ttl = ext fields.
    out.push(0); // root name
    pushU16(out, Rtype.OPT);
    pushU16(out, r.data.type === 'OPT' ? r.data.udpSize : 0);
    const ext = r.data.type === 'OPT' ? r.data : { extRcode: 0, version: 0, flags: 0 };
    pushU32(out, ((ext.extRcode & 0xff) << 24) | ((ext.version & 0xff) << 16) | (ext.flags & 0xffff));
    const rdata = r.data.type === 'OPT' ? encodeRdata(r.data) : [];
    pushU16(out, rdata.length);
    out.push(...rdata);
    return;
  }
  encodeName(out, dict, r.name, true);
  pushU16(out, r.type);
  pushU16(out, r.class);
  pushU32(out, r.ttl >>> 0);
  const rdPos = out.length;
  pushU16(out, 0); // placeholder RDLENGTH
  const rdata = encodeRdata(r.data);
  out.push(...rdata);
  // Backpatch RDLENGTH.
  const rdlen = rdata.length;
  out[rdPos] = (rdlen >> 8) & 0xff;
  out[rdPos + 1] = rdlen & 0xff;
}

export function encodeMessage(msg: DnsMessage): Buffer {
  const out: number[] = [];
  const dict = new Map<string, number>();
  const flags = buildFlags({
    qr: msg.header.qr,
    opcode: msg.header.opcode,
    aa: msg.header.aa,
    tc: msg.header.tc,
    rd: msg.header.rd,
    ra: msg.header.ra,
    z: msg.header.z,
    rcode: msg.header.rcode,
  });
  pushU16(out, msg.header.id & 0xffff);
  pushU16(out, flags);
  pushU16(out, msg.questions.length);
  pushU16(out, msg.answers.length);
  pushU16(out, msg.authorities.length);
  pushU16(out, msg.additionals.length);
  for (const q of msg.questions) {
    encodeName(out, dict, q.name, true);
    pushU16(out, q.type);
    pushU16(out, q.class);
  }
  for (const r of msg.answers) writeRecord(out, dict, r);
  for (const r of msg.authorities) writeRecord(out, dict, r);
  for (const r of msg.additionals) writeRecord(out, dict, r);
  return Buffer.from(out);
}

/** Parse a DNS QNAME wire label sequence into a name string (for raw buffers). */
export function parseQname(buf: Buffer, offset: number): { name: string; read: number } {
  return decodeName(buf, offset);
}

export { DnsOpcode, Rcode, Rtype, CLASS_IN };
