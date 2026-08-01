// DNS wire codec tests — RFC 1035 round-trips for every RR type, name
// compression/decompression, IPv6 (de)serialization, and malformed input.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMessage, encodeMessage, formatIpv6, parseIpv6,
  Rtype, CLASS_IN, buildFlags, DnsOpcode, Rcode, WireFormatError,
} from '../src/index.js';
import type { DnsMessage, DnsRecord } from '../src/index.js';

function mkMsg(overrides: Partial<DnsMessage> = {}): DnsMessage {
  return {
    header: { id: 0x1234, flags: 0, opcode: DnsOpcode.QUERY, rcode: Rcode.NOERROR, qr: false, aa: false, tc: false, rd: true, ra: false, z: 0, qdcount: 1, ancount: 0, nscount: 0, arcount: 0 },
    questions: [{ name: 'www.example.com.', type: Rtype.A, class: CLASS_IN }],
    answers: [],
    authorities: [],
    additionals: [],
    ...overrides,
  };
}

function roundTrip(msg: DnsMessage): DnsMessage {
  return decodeMessage(encodeMessage(msg));
}

describe('wire — header & flags', () => {
  it('round-trips the header and questions', () => {
    const m = roundTrip(mkMsg());
    assert.equal(m.header.id, 0x1234);
    assert.equal(m.header.qr, false);
    assert.equal(m.header.rd, true);
    assert.equal(m.questions[0]!.name, 'www.example.com.');
    assert.equal(m.questions[0]!.type, Rtype.A);
  });

  it('builds and decodes flag bits', () => {
    const flags = buildFlags({ qr: true, opcode: DnsOpcode.QUERY, aa: true, tc: false, rd: true, ra: true, rcode: Rcode.NOERROR });
    assert.equal((flags & 0x8000) !== 0, true); // QR
    assert.equal((flags & 0x0400) !== 0, true); // AA
    assert.equal((flags & 0x0080) !== 0, true); // RA
  });
});

describe('wire — record round-trips', () => {
  it('A record', () => {
    const r: DnsRecord = { name: 'a.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 300, data: { type: 'A', address: '192.0.2.1' } };
    const m = roundTrip(mkMsg({ answers: [r] }));
    assert.equal(m.answers[0]!.data.type, 'A');
    assert.equal((m.answers[0]!.data as { address: string }).address, '192.0.2.1');
    assert.equal(m.answers[0]!.ttl, 300);
  });

  it('AAAA record incl. :: compression', () => {
    const r: DnsRecord = { name: 'a.example.com.', type: Rtype.AAAA, class: CLASS_IN, ttl: 300, data: { type: 'AAAA', address: '2001:db8::1' } };
    const m = roundTrip(mkMsg({ answers: [r] }));
    assert.equal((m.answers[0]!.data as { address: string }).address, '2001:db8::1');
  });

  it('IPv4-mapped IPv6 round-trips', () => {
    const b = parseIpv6('::ffff:192.0.2.1');
    assert.equal(b.length, 16);
    const s = formatIpv6(b);
    assert.equal(s, '::ffff:192.0.2.1');
  });

  it('NS, CNAME, MX, TXT records', () => {
    const recs: DnsRecord[] = [
      { name: 'example.com.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns1.example.com.' } },
      { name: 'alias.example.com.', type: Rtype.CNAME, class: CLASS_IN, ttl: 300, data: { type: 'CNAME', cname: 'target.example.com.' } },
      { name: 'example.com.', type: Rtype.MX, class: CLASS_IN, ttl: 3600, data: { type: 'MX', preference: 10, exchange: 'mail.example.com.' } },
      { name: 'example.com.', type: Rtype.TXT, class: CLASS_IN, ttl: 3600, data: { type: 'TXT', strings: ['v=spf1 -all', 'hello world'] } },
    ];
    const m = roundTrip(mkMsg({ answers: recs }));
    assert.equal((m.answers[0]!.data as { nsdname: string }).nsdname, 'ns1.example.com.');
    assert.equal((m.answers[1]!.data as { cname: string }).cname, 'target.example.com.');
    assert.equal((m.answers[2]!.data as { preference: number }).preference, 10);
    assert.deepEqual((m.answers[3]!.data as { strings: string[] }).strings, ['v=spf1 -all', 'hello world']);
  });

  it('SOA record', () => {
    const r: DnsRecord = { name: 'example.com.', type: Rtype.SOA, class: CLASS_IN, ttl: 3600, data: { type: 'SOA', mname: 'ns1.example.com.', rname: 'hostmaster.example.com.', serial: 2026080101, refresh: 3600, retry: 900, expire: 604800, minimum: 86400 } };
    const m = roundTrip(mkMsg({ authorities: [r] }));
    const soa = m.authorities[0]!.data as Extract<DnsRecord['data'], { type: 'SOA' }>;
    assert.equal(soa.mname, 'ns1.example.com.');
    assert.equal(soa.rname, 'hostmaster.example.com.');
    assert.equal(soa.serial, 2026080101);
    assert.equal(soa.expire, 604800);
  });

  it('SRV and CAA records', () => {
    const recs: DnsRecord[] = [
      { name: '_sip._tcp.example.com.', type: Rtype.SRV, class: CLASS_IN, ttl: 3600, data: { type: 'SRV', priority: 10, weight: 20, port: 5060, target: 'sip.example.com.' } },
      { name: 'example.com.', type: Rtype.CAA, class: CLASS_IN, ttl: 3600, data: { type: 'CAA', flags: 0, tag: 'issue', value: 'letsencrypt.org' } },
    ];
    const m = roundTrip(mkMsg({ answers: recs }));
    const srv = m.answers[0]!.data as Extract<DnsRecord['data'], { type: 'SRV' }>;
    assert.equal(srv.port, 5060);
    assert.equal(srv.target, 'sip.example.com.');
    const caa = m.answers[1]!.data as Extract<DnsRecord['data'], { type: 'CAA' }>;
    assert.equal(caa.tag, 'issue');
    assert.equal(caa.value, 'letsencrypt.org');
  });

  it('DNSKEY, DS, RRSIG records round-trip', () => {
    const recs: DnsRecord[] = [
      { name: 'example.com.', type: Rtype.DNSKEY, class: CLASS_IN, ttl: 3600, data: { type: 'DNSKEY', flags: 257, protocol: 3, algorithm: 13, publicKey: 'AAEC' } },
      { name: 'example.com.', type: Rtype.DS, class: CLASS_IN, ttl: 3600, data: { type: 'DS', keyTag: 12345, algorithm: 13, digestType: 2, digest: 'deadbeef' } },
      { name: 'a.example.com.', type: Rtype.RRSIG, class: CLASS_IN, ttl: 300, data: { type: 'RRSIG', typeCovered: Rtype.A, algorithm: 13, labels: 3, originalTtl: 300, expiration: 2000000000, inception: 1000000000, keyTag: 12345, signerName: 'example.com.', signature: 'QUJD' } },
    ];
    const m = roundTrip(mkMsg({ answers: recs }));
    assert.equal((m.answers[0]!.data as { flags: number }).flags, 257);
    assert.equal((m.answers[1]!.data as { digest: string }).digest, 'deadbeef');
    const rrsig = m.answers[2]!.data as Extract<DnsRecord['data'], { type: 'RRSIG' }>;
    assert.equal(rrsig.typeCovered, Rtype.A);
    assert.equal(rrsig.signature, 'QUJD');
  });

  it('EDNS0 OPT record', () => {
    const opt: DnsRecord = { name: '.', type: Rtype.OPT, class: 1232, ttl: 0, data: { type: 'OPT', udpSize: 1232, extRcode: 0, version: 0, flags: 0x8000, options: [{ code: 10, data: Buffer.from('data').toString('base64') }] } };
    const m = roundTrip(mkMsg({ additionals: [opt] }));
    const o = m.additionals[0]!.data as Extract<DnsRecord['data'], { type: 'OPT' }>;
    assert.equal(o.udpSize, 1232);
    assert.equal((o.flags & 0x8000) !== 0, true); // DO bit
    assert.equal(o.options.length, 1);
    assert.equal(o.options[0]!.code, 10);
  });

  it('unknown record type preserved as raw', () => {
    const r: DnsRecord = { name: 'x.example.com.', type: 999, class: CLASS_IN, ttl: 60, data: { type: 'raw', rdata: Buffer.from([1, 2, 3, 4]).toString('base64') } };
    const m = roundTrip(mkMsg({ answers: [r] }));
    assert.equal(m.answers[0]!.type, 999);
    assert.equal((m.answers[0]!.data as { rdata: string }).rdata, Buffer.from([1, 2, 3, 4]).toString('base64'));
  });
});

describe('wire — name compression', () => {
  it('a question + repeated owner names decode to full names', () => {
    // Multiple records sharing suffixes exercise compression pointers.
    const recs: DnsRecord[] = [
      { name: 'a.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 60, data: { type: 'A', address: '192.0.2.1' } },
      { name: 'b.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 60, data: { type: 'A', address: '192.0.2.2' } },
      { name: 'example.com.', type: Rtype.NS, class: CLASS_IN, ttl: 60, data: { type: 'NS', nsdname: 'a.example.com.' } },
    ];
    const m = roundTrip(mkMsg({ answers: recs }));
    assert.equal(m.answers[0]!.name, 'a.example.com.');
    assert.equal(m.answers[1]!.name, 'b.example.com.');
    assert.equal(m.answers[2]!.name, 'example.com.');
    assert.equal((m.answers[2]!.data as { nsdname: string }).nsdname, 'a.example.com.');
  });

  it('emits and decodes compression pointers for shared suffixes', () => {
    // Question 'www.example.com.' registers the 'example.com.' suffix in the
    // compression dictionary, so the answer owner 'example.com.' is emitted as
    // a pointer (0xC0xx). Round-trip must recover the full name.
    const recs: DnsRecord[] = [
      { name: 'example.com.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns1.example.com.' } },
    ];
    const msg = mkMsg({ answers: recs });
    const buf = encodeMessage(msg);
    assert.ok(buf.includes(0xc0), 'expected a compression pointer in the wire form');
    const m = decodeMessage(buf);
    assert.equal(m.answers[0]!.name, 'example.com.');
    assert.equal((m.answers[0]!.data as { nsdname: string }).nsdname, 'ns1.example.com.');
  });
});

describe('wire — malformed input', () => {
  it('throws on truncated header', () => {
    assert.throws(() => decodeMessage(Buffer.from([1, 2, 3])), WireFormatError);
  });

  it('decodeMessage of a well-formed query does not throw', () => {
    const buf = encodeMessage(mkMsg());
    assert.doesNotThrow(() => decodeMessage(buf));
  });

  it('parses IPv6 all-zeros as ::', () => {
    const z = new Uint8Array(16);
    assert.equal(formatIpv6(z), '::');
  });
});
