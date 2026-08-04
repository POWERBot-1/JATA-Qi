// Zone store + authoritative resolution tests (RFC 1034 semantics).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ZoneStore, toZoneRecord, Rtype, Rcode, CLASS_IN } from '../src/index.js';
import type { Zone } from '../src/index.js';

function exampleZone(): Zone {
  return {
    origin: 'example.com.',
    soa: { mname: 'ns1.example.com.', rname: 'hostmaster.example.com.', serial: 1, refresh: 3600, retry: 900, expire: 604800, minimum: 86400 },
    records: [
      { name: 'example.com.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns1.example.com.' } },
      { name: 'ns1.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 3600, data: { type: 'A', address: '192.0.2.53' } },
      { name: 'www.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 300, data: { type: 'A', address: '192.0.2.10' } },
      { name: 'alias.example.com.', type: Rtype.CNAME, class: CLASS_IN, ttl: 300, data: { type: 'CNAME', cname: 'www.example.com.' } },
      { name: '*.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 60, data: { type: 'A', address: '192.0.2.99' } },
      { name: 'mail.example.com.', type: Rtype.MX, class: CLASS_IN, ttl: 3600, data: { type: 'MX', preference: 10, exchange: 'mail.example.com.' } },
      // delegation
      { name: 'sub.example.com.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns1.sub.example.com.' } },
      { name: 'ns1.sub.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 3600, data: { type: 'A', address: '192.0.2.100' } },
    ],
  };
}

describe('ZoneStore — add/find', () => {
  it('adds a zone and inserts apex SOA if missing', () => {
    const store = new ZoneStore();
    store.addZone(exampleZone());
    const z = store.getZone('example.com.')!;
    assert.ok(z);
    const soa = z.records.find((r) => r.type === Rtype.SOA);
    assert.ok(soa, 'apex SOA auto-inserted');
  });

  it('finds the most-specific zone by suffix', () => {
    const store = new ZoneStore();
    store.addZone(exampleZone());
    store.addZone({ origin: 'sub.example.com.', soa: { mname: 'ns.sub.example.com.', rname: 'h.sub.example.com.', serial: 1, refresh: 1, retry: 1, expire: 1, minimum: 1 }, records: [] });
    assert.equal(store.findZone('deep.sub.example.com.')?.origin, 'sub.example.com.');
    assert.equal(store.findZone('www.example.com.')?.origin, 'example.com.');
    assert.equal(store.findZone('other.test.'), undefined);
  });
});

describe('ZoneStore — resolution semantics', () => {
  let store: ZoneStore;
  function fresh(): ZoneStore { const s = new ZoneStore(); s.addZone(exampleZone()); return s; }

  it('answers an exact A record (AA)', () => {
    store = fresh();
    const r = store.resolve(store.getZone('example.com.')!, 'www.example.com.', Rtype.A);
    assert.equal(r.rcode, Rcode.NOERROR);
    assert.equal(r.aa, true);
    assert.equal(r.answers.length, 1);
    assert.equal((r.answers[0]!.data as { address: string }).address, '192.0.2.10');
  });

  it('chases a CNAME to the target', () => {
    store = fresh();
    const r = store.resolve(store.getZone('example.com.')!, 'alias.example.com.', Rtype.A);
    assert.equal(r.rcode, Rcode.NOERROR);
    // CNAME + the resolved A
    assert.ok(r.answers.some((a) => a.type === Rtype.CNAME));
    assert.ok(r.answers.some((a) => a.type === Rtype.A && (a.data as { address: string }).address === '192.0.2.10'));
  });

  it('synthesizes a wildcard for an unknown name', () => {
    store = fresh();
    const r = store.resolve(store.getZone('example.com.')!, 'random.example.com.', Rtype.A);
    assert.equal(r.rcode, Rcode.NOERROR);
    assert.equal(r.answers.length, 1);
    assert.equal((r.answers[0]!.data as { address: string }).address, '192.0.2.99');
  });

  it('returns NODATA (NOERROR, no answers) when name exists but type does not', () => {
    store = fresh();
    const r = store.resolve(store.getZone('example.com.')!, 'www.example.com.', Rtype.MX);
    assert.equal(r.rcode, Rcode.NOERROR);
    assert.equal(r.answers.length, 0);
    // SOA in authority.
    assert.ok(r.authority.some((a) => a.type === Rtype.SOA));
  });

  it('returns NXDOMAIN with SOA in authority for a non-existent name', () => {
    store = fresh();
    const r = store.resolve(store.getZone('example.com.')!, 'nope.nope.example.com.', Rtype.A);
    assert.equal(r.rcode, Rcode.NXDOMAIN);
    assert.ok(r.authority.some((a) => a.type === Rtype.SOA));
  });

  it('returns a referral (AA=false) below a delegation point with glue', () => {
    store = fresh();
    const r = store.resolve(store.getZone('example.com.')!, 'host.sub.example.com.', Rtype.A);
    assert.equal(r.rcode, Rcode.NOERROR);
    assert.equal(r.referral, true);
    assert.equal(r.aa, false);
    assert.ok(r.authority.some((a) => a.type === Rtype.NS));
    assert.ok(r.additional.some((a) => a.type === Rtype.A));
  });

  it('resolves MX records', () => {
    store = fresh();
    const r = store.resolve(store.getZone('example.com.')!, 'mail.example.com.', Rtype.MX);
    assert.equal(r.rcode, Rcode.NOERROR);
    assert.equal((r.answers[0]!.data as { preference: number }).preference, 10);
  });

  it('returns SOA for apex SOA queries', () => {
    store = fresh();
    const r = store.resolve(store.getZone('example.com.')!, 'example.com.', Rtype.SOA);
    assert.equal(r.rcode, Rcode.NOERROR);
    assert.ok(r.answers.some((a) => a.type === Rtype.SOA));
  });
});

describe('ZoneStore — toZoneRecord helper', () => {
  it('normalizes names to lowercase FQDN', () => {
    const r = toZoneRecord('WWW.Example.COM', Rtype.A, 60, { type: 'A', address: '1.2.3.4' });
    assert.equal(r.name, 'www.example.com.');
    assert.equal(r.class, CLASS_IN);
  });
});
