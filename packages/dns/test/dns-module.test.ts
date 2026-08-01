// DnsModule kernel integration tests — zone/sign/RDAP/analytics + lifecycle.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { DnsModule, DnsEvents, Rtype, CLASS_IN } from '../src/index.js';
import type { Zone } from '../src/index.js';

function zone(): Zone {
  return {
    origin: 'example.com.',
    soa: { mname: 'ns1.example.com.', rname: 'hostmaster.example.com.', serial: 100, refresh: 3600, retry: 900, expire: 604800, minimum: 86400 },
    records: [
      { name: 'example.com.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns1.example.com.' } },
      { name: 'ns1.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 3600, data: { type: 'A', address: '192.0.2.53' } },
      { name: 'www.example.com.', type: Rtype.A, class: CLASS_IN, ttl: 300, data: { type: 'A', address: '192.0.2.10' } },
    ],
  };
}

describe('DnsModule', () => {
  let kernel: Kernel;
  let mod: DnsModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new DnsModule({ serve: false, recursive: false });
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('adds a zone and emits an event', async () => {
    let fired = false;
    kernel.bus.on(DnsEvents.ZoneAdded, () => { fired = true; });
    mod.addZone(zone());
    await Promise.resolve();
    assert.ok(fired);
    assert.equal(mod.listZones().length, 1);
  });

  it('adds records and bumps the SOA serial', () => {
    const before = mod.store.soaSerial(mod.getZone('example.com.')!);
    mod.addRecords('example.com.', [{ name: 'api.example.com.', type: Rtype.A, ttl: 300, data: { type: 'A', address: '192.0.2.20' } }]);
    const after = mod.store.soaSerial(mod.getZone('example.com.')!);
    assert.ok(after > before);
  });

  it('resolves locally without a server', () => {
    const r = mod.resolveLocal('www.example.com.', Rtype.A);
    assert.equal(r.rcode, 0);
    assert.equal((r.answers[0]!.data as { address: string }).address, '192.0.2.10');
  });

  it('REFUSED locally for unknown names', () => {
    const r = mod.resolveLocal('unknown.test.', Rtype.A);
    assert.equal(r.rcode, 5);
  });

  it('signs a zone and exposes the parent DS', () => {
    const result = mod.signZone('example.com.');
    assert.ok(result.ds.data.type === 'DS');
    const ds = mod.getDs('example.com.')!;
    assert.ok(ds);
    // The zone now contains DNSKEY/RRSIG/NSEC.
    const z = mod.getZone('example.com.')!;
    const types = new Set(z.records.map((r) => r.type));
    assert.ok(types.has(Rtype.DNSKEY));
    assert.ok(types.has(Rtype.RRSIG));
  });

  it('RDAP lookup returns active status for a known name', () => {
    const r = mod.rdapLookup('www.example.com.');
    assert.equal(r.notFound, undefined);
    assert.ok(r.status.includes('active'));
  });

  it('RDAP reports secureDNS for a signed apex', () => {
    const r = mod.rdapLookup('example.com.');
    assert.ok(r.secureDNS);
    assert.equal(r.secureDNS!.zoneSigned, true);
  });

  it('RDAP notFound for an unknown zone', () => {
    const r = mod.rdapLookup('nothing.test.');
    assert.equal(r.notFound, true);
  });
});

describe('DnsModule — server lifecycle', () => {
  it('starts and stops the authoritative server on boot', async () => {
    const k = createTestKernel();
    const m = new DnsModule({ serve: true, port: 0 });
    k.register(m);
    await k.boot();
    m.addZone(zone());
    assert.ok(m.address && m.address.udp > 0);
    assert.ok(m.address && m.address.tcp > 0);
    await k.shutdown();
    // After shutdown the server reports zeroed (not listening) ports.
    assert.equal(m.address ? m.address.udp : 1, 0);
  });
});
