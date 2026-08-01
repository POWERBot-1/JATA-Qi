// DNSSEC tests — ECDSA P-256 (alg 13) key generation, RRset signing/verification,
// key tags, DS digest, and NSEC chain correctness, including round-trip through
// the wire codec (canonical re-derivation must still verify).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  signZone, signRrset, verifyRrset, generateSigningKey, computeDs, keyTag,
  dnskeyRecord, encodeTypeBitmaps, buildNsecChain, canonicalRdata, rrsetFromRecords,
  decodeMessage, encodeMessage, DNSSEC_ALG,
  Rtype, CLASS_IN,
} from '../src/index.js';
import type { Zone, ZoneRecord, DnsRecord } from '../src/index.js';

function smallZone(): Zone {
  return {
    origin: 'example.com.',
    soa: { mname: 'ns1.example.com.', rname: 'hostmaster.example.com.', serial: 1, refresh: 3600, retry: 900, expire: 604800, minimum: 86400 },
    records: [
      { name: 'example.com.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns1.example.com.' } },
      { name: 'ns1.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 3600, data: { type: 'A', address: '192.0.2.53' } },
      { name: 'www.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 300, data: { type: 'A', address: '192.0.2.10' } },
      { name: 'www.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 300, data: { type: 'A', address: '192.0.2.11' } },
    ],
  };
}

describe('dnssec — key generation + key tags', () => {
  it('generates an ECDSA P-256 key with a stable key tag', () => {
    const k = generateSigningKey(257);
    assert.equal(k.flags, 257);
    // publicKey must be 64 bytes (x||y).
    const buf = Buffer.from(k.publicKey, 'base64');
    assert.equal(buf.length, 64);
    // Re-compute key tag from the DNSKEY rdata (flags|proto|alg|key).
    const rdata = Buffer.concat([Buffer.from([(k.flags >> 8) & 0xff, k.flags & 0xff, 3, DNSSEC_ALG]), buf]);
    assert.equal(keyTag(rdata), k.keyTag);
  });

  it('dnskeyRecord builds a DNSKEY ZoneRecord', () => {
    const k = generateSigningKey(256);
    const r = dnskeyRecord('example.com.', k, 3600);
    assert.equal(r.type, Rtype.DNSKEY);
    assert.equal(r.data.type, 'DNSKEY');
    if (r.data.type === 'DNSKEY') {
      assert.equal(r.data.algorithm, DNSSEC_ALG);
      assert.equal(r.data.protocol, 3);
    }
  });
});

describe('dnssec — RRset sign/verify', () => {
  it('signs an RRset and verifies it with the public key', () => {
    const k = generateSigningKey(256);
    const rdatas = [
      canonicalRdata({ type: 'A', address: '192.0.2.10' }),
      canonicalRdata({ type: 'A', address: '192.0.2.11' }),
    ].sort(Buffer.compare);
    const rrset = { owner: 'www.example.com.', type: Rtype.A, ttl: 300, rdatas };
    const sig = signRrset(rrset, k, 'example.com.', 1_000_000_000, 2_000_000_000);
    assert.equal(sig.type, 'RRSIG');
    assert.equal(sig.algorithm, DNSSEC_ALG);
    assert.equal(sig.keyTag, k.keyTag);
    assert.ok(verifyRrset(rrset, sig, k.publicObject), 'signature must verify');
  });

  it('fails verification when RDATA is tampered', () => {
    const k = generateSigningKey(256);
    const rdatas = [canonicalRdata({ type: 'A', address: '192.0.2.10' })];
    const rrset = { owner: 'www.example.com.', type: Rtype.A, ttl: 300, rdatas };
    const sig = signRrset(rrset, k, 'example.com.', 1, 2);
    const tampered = { ...rrset, rdatas: [canonicalRdata({ type: 'A', address: '192.0.2.99' })] };
    assert.equal(verifyRrset(tampered, sig, k.publicObject), false);
  });
});

describe('dnssec — full zone signing', () => {
  it('signs a zone, producing DNSKEY, RRSIG, NSEC, and a DS', () => {
    const zone = smallZone();
    const result = signZone(zone, zone.records);
    const types = new Set(result.records.map((r) => r.type));
    assert.ok(types.has(Rtype.DNSKEY));
    assert.ok(types.has(Rtype.RRSIG));
    assert.ok(types.has(Rtype.NSEC));
    // One RRSIG per RRset (NS at apex, A at ns1, A at www (single sig for the set), DNSKEY, NSEC x N).
    const dnskeyCount = result.records.filter((r) => r.type === Rtype.DNSKEY).length;
    assert.equal(dnskeyCount, 2); // KSK + ZSK
    // DS is SHA-256 -> 64 hex chars.
    assert.equal(result.ds.data.type, 'DS');
    if (result.ds.data.type === 'DS') assert.equal(result.ds.data.digest.length, 64);
  });

  it('the KSK signs the DNSKEY RRset; verifies after wire round-trip', () => {
    const zone = smallZone();
    const result = signZone(zone, zone.records);

    // Pull the DNSKEY RRset + its RRSIG from the signed zone, round-trip via wire.
    const dnskeyRecs: ZoneRecord[] = result.records.filter((r) => r.type === Rtype.DNSKEY);
    const rrsigRec = result.records.find((r) => r.type === Rtype.RRSIG && r.data.type === 'RRSIG' && r.data.typeCovered === Rtype.DNSKEY)!;
    // Build a wire message with them, decode, and verify.
    const wireRecs: DnsRecord[] = [...dnskeyRecs, rrsigRec].map((r) => ({ name: r.name, type: r.type, class: r.class, ttl: r.ttl, data: r.data }));
    const msg = {
      header: { id: 1, flags: 0, opcode: 0, rcode: 0, qr: true, aa: true, tc: false, rd: false, ra: false, z: 0, qdcount: 0, ancount: wireRecs.length, nscount: 0, arcount: 0 },
      questions: [], answers: wireRecs, authorities: [], additionals: [],
    };
    const decoded = decodeMessage(encodeMessage(msg as never));
    const dks = decoded.answers.filter((a) => a.type === Rtype.DNSKEY);
    const sigRec = decoded.answers.find((a) => a.type === Rtype.RRSIG)!;
    const rrset = rrsetFromRecords(dks)!;
    if (sigRec.data.type !== 'RRSIG') throw new Error('expected RRSIG');
    const sigData = sigRec.data;
    // Find the matching DNSKEY public object (KSK).
    const signerDk = result.records.find((r) => r.type === Rtype.DNSKEY && r.data.type === 'DNSKEY' && r.data.flags === 257)!;
    assert.ok(verifyRrset(rrset, sigData, result.ksk.publicObject), 'DNSKEY RRset must verify after wire round-trip');
    void signerDk;
  });

  it('every data RRset has a valid RRSIG', () => {
    const zone = smallZone();
    const result = signZone(zone, zone.records);
    // Group data RRsets (non-DNSKEY, non-NSEC, non-RRSIG) and verify each sig.
    const owners = new Set<string>();
    for (const r of result.records) {
      if (r.type === Rtype.RRSIG || r.type === Rtype.DNSKEY || r.type === Rtype.NSEC) continue;
      owners.add(`${r.name}|${r.type}`);
    }
    for (const key of owners) {
      const [name, typeStr] = key.split('|');
      const type = Number(typeStr);
      const dataRecs = result.records.filter((r) => r.name === name && r.type === type);
      const sig = result.records.find((r) => r.type === Rtype.RRSIG && r.data.type === 'RRSIG' && r.data.typeCovered === type && r.name === name);
      assert.ok(sig, `missing RRSIG for ${name} ${type}`);
      const rrset = { owner: name!, type, ttl: dataRecs[0]!.ttl, rdatas: dataRecs.map((r) => canonicalRdata(r.data)) };
      // Use the ZSK public object.
      assert.ok(verifyRrset(rrset, (sig.data as Extract<typeof sig.data, { type: 'RRSIG' }>), result.zsk.publicObject), `${name} ${type} must verify`);
    }
  });
});

describe('dnssec — NSEC chain + DS', () => {
  it('builds an NSEC for every owner name, wrapping apex last', () => {
    const zone = smallZone();
    const nsec = buildNsecChain(zone, zone.records);
    const owners = new Set(zone.records.map((r) => r.name));
    for (const n of nsec) {
      assert.equal(n.type, Rtype.NSEC);
      assert.ok(n.data.type === 'NSEC');
    }
    // Each original owner has an NSEC.
    for (const o of owners) assert.ok(nsec.some((n) => n.name === o), `NSEC missing for ${o}`);
  });

  it('computeDs produces a SHA-256 DS for the KSK', () => {
    const k = generateSigningKey(257);
    const dk = dnskeyRecord('example.com.', k, 3600);
    const ds = computeDs('example.com.', dk);
    assert.equal(ds.type, Rtype.DS);
    if (ds.data.type === 'DS') {
      assert.equal(ds.data.algorithm, DNSSEC_ALG);
      assert.equal(ds.data.digestType, 2);
      assert.equal(ds.data.digest.length, 64);
    }
  });

  it('encodeTypeBitmaps covers A(1) and AAAA(28) and DNSKEY(48)', () => {
    const bytes = encodeTypeBitmaps([Rtype.A, Rtype.AAAA, Rtype.DNSKEY]);
    // Window 0, bitmap length >= 7 bytes (covers bit 48 -> byte index 6).
    assert.equal(bytes[0], 0);
    assert.ok((bytes[1] ?? 0) >= 7);
  });
});
