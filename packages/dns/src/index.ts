// @jataqi/dns — Global DNS platform (Part D). Public API.

export { DnsModule, DnsEvents } from './dns-module.js';
export type { DnsConfig, RdapResult } from './dns-module.js';

// Wire codec
export {
  decodeMessage, encodeMessage, decodeName, buildFlags,
  formatIpv6, parseIpv6, normalizeName, nameToLabels,
  WireFormatError,
} from './wire.js';

// Zones
export { ZoneStore, toZoneRecord } from './zones.js';
export type { ResolveResult } from './zones.js';

// Server
export { AuthoritativeServer, RTYPE_AXFR, RTYPE_IXFR } from './server.js';
export type { ServerAnalytics, AuthoritativeServerOptions } from './server.js';

// Resolver
export { RecursiveResolver, ROOT_HINTS, servfail } from './resolver.js';
export type { ResolverConfig, RootServer } from './resolver.js';

// GeoDNS
export { GeoBalancer, aPool } from './geo.js';
export type { GeoBalancer as Geo, GeoRule, GeoPool, GeoPolicy } from './geo.js';

// DNSSEC
export {
  signZone, signRrset, verifyRrset, generateSigningKey, computeDs, keyTag,
  dnskeyRecord, encodeTypeBitmaps, buildNsecChain, canonicalCompare, canonicalName,
  canonicalRdata, ownerLabels, rrsetFromRecords,
  DNSSEC_ALG, DS_DIGEST_SHA256,
} from './dnssec.js';
export type { SigningKey, SignZoneResult, RrsigData } from './dnssec.js';

// Types
export {
  DnsOpcode, Rcode, Rtype, CLASS_IN, CLASS_ANY,
} from './types.js';
export type {
  DnsHeader, DnsMessage, DnsQuestion, DnsRecord, RecordData, EdnsOption,
  Zone, ZoneRecord, GeoView, DnsQueryStats,
} from './types.js';
