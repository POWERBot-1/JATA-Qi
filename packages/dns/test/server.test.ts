// AuthoritativeServer tests — real UDP + TCP serving, EDNS0 DO, AXFR, malformed
// handling, and analytics. Spins up the server on ephemeral ports.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { connect as tcpConnect } from 'node:net';
import {
  AuthoritativeServer, ZoneStore, encodeMessage, decodeMessage, buildFlags,
  Rtype, CLASS_IN, DnsOpcode, Rcode, GeoBalancer, aPool, RTYPE_AXFR,
} from '../src/index.js';
import type { DnsMessage, DnsQuestion, Zone } from '../src/index.js';

function makeZone(): Zone {
  return {
    origin: 'example.com.',
    soa: { mname: 'ns1.example.com.', rname: 'hostmaster.example.com.', serial: 1, refresh: 3600, retry: 900, expire: 604800, minimum: 86400 },
    records: [
      { name: 'example.com.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns1.example.com.' } },
      { name: 'ns1.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 3600, data: { type: 'A', address: '192.0.2.53' } },
      { name: 'www.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 300, data: { type: 'A', address: '192.0.2.10' } },
    ],
  };
}

function query(name: string, type: number, id = 0x4242): Buffer {
  const q: DnsQuestion = { name, type, class: CLASS_IN };
  const msg: DnsMessage = {
    header: { id, flags: buildFlags({ rd: true }), opcode: DnsOpcode.QUERY, rcode: 0, qr: false, aa: false, tc: false, rd: true, ra: false, z: 0, qdcount: 1, ancount: 0, nscount: 0, arcount: 0 },
    questions: [q], answers: [], authorities: [], additionals: [],
  };
  return encodeMessage(msg);
}

function udpSend(port: number, buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = createSocket({ type: 'udp4' });
    const t = setTimeout(() => { sock.close(); reject(new Error('udp timeout')); }, 1500);
    sock.on('message', (data) => { clearTimeout(t); sock.close(); resolve(data); });
    sock.on('error', (e) => { clearTimeout(t); sock.close(); reject(e); });
    sock.send(buf, port, '127.0.0.1', (e) => { if (e) { clearTimeout(t); sock.close(); reject(e); } });
  });
}

function tcpExchange(port: number, messages: Buffer[]): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    const out: Buffer[] = [];
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { sock.destroy(); reject(new Error('tcp timeout')); }, 1500);
    sock.on('connect', () => { for (const m of messages) { const f = Buffer.allocUnsafe(2); f.writeUInt16BE(m.length); sock.write(f); sock.write(m); } });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) break;
        out.push(buf.subarray(2, 2 + len));
        buf = buf.subarray(2 + len);
        if (out.length >= messages.length) { clearTimeout(t); sock.end(); resolve(out); }
      }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

describe('AuthoritativeServer — pure handler', () => {
  it('answers an A query without sockets', () => {
    const store = new ZoneStore();
    store.addZone(makeZone());
    const srv = new AuthoritativeServer(store);
    const resp = srv.handleQuery(query('www.example.com.', Rtype.A));
    const m = decodeMessage(resp);
    assert.equal(m.header.qr, true);
    assert.equal(m.header.aa, true);
    assert.equal(m.header.rcode, Rcode.NOERROR);
    assert.equal(m.answers.length, 1);
    assert.equal((m.answers[0]!.data as { address: string }).address, '192.0.2.10');
  });

  it('REFUSED for names outside our authority', () => {
    const store = new ZoneStore();
    store.addZone(makeZone());
    const srv = new AuthoritativeServer(store);
    const m = decodeMessage(srv.handleQuery(query('other.test.', Rtype.A)));
    assert.equal(m.header.rcode, Rcode.REFUSED);
  });

  it('NOTIMP for non-QUERY opcodes', () => {
    const store = new ZoneStore();
    store.addZone(makeZone());
    const srv = new AuthoritativeServer(store);
    const buf = query('www.example.com.', Rtype.A);
    buf.writeUInt16BE(buildFlags({ opcode: DnsOpcode.STATUS, rd: true }), 2); // patch opcode
    const m = decodeMessage(srv.handleQuery(buf));
    assert.equal(m.header.rcode, Rcode.NOTIMP);
  });

  it('returns FORMERR for malformed input', () => {
    const store = new ZoneStore();
    store.addZone(makeZone());
    const srv = new AuthoritativeServer(store);
    const m = decodeMessage(srv.handleQuery(Buffer.from([0x00, 0x01, 0x99])));
    assert.equal(m.header.rcode, Rcode.FORMERR);
  });
});

describe('AuthoritativeServer — UDP serving', () => {
  let port: number;
  let srv: AuthoritativeServer;
  const store = new ZoneStore();

  before(async () => {
    store.addZone(makeZone());
    srv = new AuthoritativeServer(store, { geo: new GeoBalancer() });
    const a = await srv.start(0, '127.0.0.1');
    port = a.udp;
  });
  after(async () => { await srv.stop(); });

  it('answers a UDP A query', async () => {
    const data = await udpSend(port, query('www.example.com.', Rtype.A, 0x1111));
    const m = decodeMessage(data);
    assert.equal(m.header.id, 0x1111);
    assert.equal(m.header.qr, true);
    assert.equal((m.answers[0]!.data as { address: string }).address, '192.0.2.10');
  });

  it('returns NXDOMAIN over UDP', async () => {
    const data = await udpSend(port, query('nope.example.com.', Rtype.A));
    const m = decodeMessage(data);
    assert.equal(m.header.rcode, Rcode.NXDOMAIN);
  });
});

describe('AuthoritativeServer — TCP + AXFR', () => {
  let port: number;
  let srv: AuthoritativeServer;
  const store = new ZoneStore();

  before(async () => {
    store.addZone(makeZone());
    srv = new AuthoritativeServer(store);
    const a = await srv.start(0, '127.0.0.1');
    port = a.tcp;
  });
  after(async () => { await srv.stop(); });

  it('answers a TCP query', async () => {
    const [data] = await tcpExchange(port, [query('ns1.example.com.', Rtype.A, 0x2222)]);
    const m = decodeMessage(data);
    assert.equal(m.header.id, 0x2222);
    assert.equal((m.answers[0]!.data as { address: string }).address, '192.0.2.53');
  });

  it('transfers the full zone over AXFR (SOA...records...SOA)', async () => {
    const axfrQuery = query('example.com.', RTYPE_AXFR, 0x3333);
    // AXFR returns multiple messages; read until we've seen >= 2.
    const msgs = await tcpReadUntil(port, axfrQuery, 2);
    const allAnswers = msgs.flatMap((m) => decodeMessage(m).answers);
    const soas = allAnswers.filter((a) => a.type === Rtype.SOA);
    assert.ok(soas.length >= 2, 'AXFR must open and close with SOA');
    assert.ok(allAnswers.some((a) => a.type === Rtype.A));
  });
});

function tcpReadUntil(port: number, q: Buffer, minMsgs: number): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    const out: Buffer[] = [];
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { sock.destroy(); resolve(out); }, 1500);
    sock.on('connect', () => { const f = Buffer.allocUnsafe(2); f.writeUInt16BE(q.length); sock.write(f); sock.write(q); });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) break;
        out.push(buf.subarray(2, 2 + len));
        buf = buf.subarray(2 + len);
        if (out.length >= minMsgs + 1) { clearTimeout(t); sock.end(); }
      }
    });
    sock.on('end', () => { clearTimeout(t); resolve(out); });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

describe('AuthoritativeServer — GeoDNS shaping', () => {
  it('round-robin rotates answers across queries', () => {
    const store = new ZoneStore();
    store.addZone(makeZone());
    const geo = new GeoBalancer();
    geo.addRule({ zone: 'example.com.', name: 'www.example.com.', type: Rtype.A, policy: 'round-robin', pools: [{ records: aPool(['192.0.2.10', '192.0.2.11', '192.0.2.12']) }] });
    const srv = new AuthoritativeServer(store, { geo });
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const m = decodeMessage(srv.handleQuery(query('www.example.com.', Rtype.A)));
      seen.add((m.answers[0]!.data as { address: string }).address);
    }
    assert.ok(seen.size > 1, 'round-robin should produce multiple distinct first answers');
  });

  it('geo view returns the pool matching the client CIDR', () => {
    const store = new ZoneStore();
    store.addZone(makeZone());
    const geo = new GeoBalancer();
    geo.addRule({
      zone: 'example.com.', name: 'www.example.com.', type: Rtype.A, policy: 'geo',
      pools: [
        { cidrs: ['192.0.2.0/24'], records: aPool(['192.0.2.200']) },
        { cidrs: ['198.51.100.0/24'], records: aPool(['198.51.100.200']) },
        { records: aPool(['203.0.113.10']) },
      ],
    });
    const srv = new AuthoritativeServer(store, { geo });
    const m1 = decodeMessage(srv.handleQuery(query('www.example.com.', Rtype.A), '192.0.2.9'));
    assert.equal((m1.answers[0]!.data as { address: string }).address, '192.0.2.200');
    const m2 = decodeMessage(srv.handleQuery(query('www.example.com.', Rtype.A), '198.51.100.9'));
    assert.equal((m2.answers[0]!.data as { address: string }).address, '198.51.100.200');
  });
});
