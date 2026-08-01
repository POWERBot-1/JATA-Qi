// JATA Qi DNS — type definitions.
//
// Part D of the Autonomous Internet Infrastructure Platform. Pure-Node
// authoritative + recursive DNS: RFC 1035 wire codec, zones, DNSSEC
// (RFC 4033/4034/4035), zone transfers (AXFR), GeoDNS views, RDAP. Zero
// external runtime dependencies (node:dgram, node:net, node:crypto only).

/** DNS opcodes (RFC 1035 + extensions). */
export enum DnsOpcode {
  QUERY = 0,
  IQUERY = 1,
  STATUS = 2,
  NOTIFY = 4,
  UPDATE = 5,
}

/** DNS response codes. */
export enum Rcode {
  NOERROR = 0,
  FORMERR = 1,
  SERVFAIL = 2,
  NXDOMAIN = 3,
  NOTIMP = 4,
  REFUSED = 5,
  YXDOMAIN = 6,
  YXRRSET = 7,
  NXRRSET = 8,
  NOTAUTH = 9,
  NOTZONE = 10,
  BADVERS = 16, // EDNS bad version
}

/** Record types. */
export enum Rtype {
  A = 1,
  NS = 2,
  CNAME = 5,
  SOA = 6,
  PTR = 12,
  MX = 15,
  TXT = 16,
  AAAA = 28,
  SRV = 33,
  OPT = 41, // EDNS0
  DS = 43,
  RRSIG = 46,
  NSEC = 47,
  DNSKEY = 48,
  NSEC3 = 50,
  CAA = 257,
  ANY = 255,
}

export const CLASS_IN = 1;
export const CLASS_ANY = 255;

/** Structured RDATA for each known record type. */
export type RecordData =
  | { type: 'A'; address: string }
  | { type: 'AAAA'; address: string }
  | { type: 'NS'; nsdname: string }
  | { type: 'CNAME'; cname: string }
  | { type: 'PTR'; ptrdname: string }
  | { type: 'MX'; preference: number; exchange: string }
  | { type: 'TXT'; strings: string[] }
  | { type: 'SOA'; mname: string; rname: string; serial: number; refresh: number; retry: number; expire: number; minimum: number }
  | { type: 'SRV'; priority: number; weight: number; port: number; target: string }
  | { type: 'CAA'; flags: number; tag: string; value: string }
  | { type: 'DNSKEY'; flags: number; protocol: number; algorithm: number; publicKey: string } // publicKey base64
  | { type: 'DS'; keyTag: number; algorithm: number; digestType: number; digest: string } // digest hex
  | { type: 'RRSIG'; typeCovered: number; algorithm: number; labels: number; originalTtl: number; expiration: number; inception: number; keyTag: number; signerName: string; signature: string } // signature base64
  | { type: 'NSEC'; nextDomain: string; typeBitmaps: number[] }
  | { type: 'OPT'; udpSize: number; extRcode: number; version: number; flags: number; options: EdnsOption[] }
  | { type: 'raw'; rdata: string }; // base64 for unknown types

export interface EdnsOption {
  code: number;
  data: string; // base64
}

/** A parsed resource record. */
export interface DnsRecord {
  name: string;
  type: number;
  class: number;
  ttl: number;
  data: RecordData;
}

/** A parsed question. */
export interface DnsQuestion {
  name: string;
  type: number;
  class: number;
}

/** The DNS message header. */
export interface DnsHeader {
  id: number;
  flags: number;
  opcode: number;
  rcode: number;
  qr: boolean;
  aa: boolean;
  tc: boolean;
  rd: boolean;
  ra: boolean;
  z: number;
  qdcount: number;
  ancount: number;
  nscount: number;
  arcount: number;
}

/** A parsed DNS message. */
export interface DnsMessage {
  header: DnsHeader;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
  /** The raw bytes (set by decodeMessage). */
  bytes?: Buffer;
}

/** Canonical zone record, used by the zone store. */
export interface ZoneRecord {
  /** Owner name, lowercased, fully-qualified (trailing dot). */
  name: string;
  type: Rtype | number;
  class: number;
  ttl: number;
  data: RecordData;
  /** Optional comment / provenance. */
  comment?: string;
}

/** A DNS zone. */
export interface Zone {
  /** Origin, lowercased, fully-qualified with trailing dot. */
  origin: string;
  /** SOA record. */
  soa: { mname: string; rname: string; serial: number; refresh: number; retry: number; expire: number; minimum: number };
  /** All records (including SOA at origin and NS at origin). */
  records: ZoneRecord[];
  /** Whether the zone is DNSSEC-signed. */
  dnssec?: boolean;
}

/** A GeoDNS view rule: route by client subnet prefix to a record set. */
export interface GeoView {
  /** CIDR prefix e.g. '192.0.2.0/24' or '2a01::/32'. */
  cidr: string;
  /** Record data to serve when the client matches. */
  data: RecordData;
}

/** Analytics counter key. */
export interface DnsQueryStats {
  zone?: string;
  qtype: number;
  rcode: number;
  count: number;
}
