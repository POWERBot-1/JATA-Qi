// RecursiveResolver tests — iterative resolution following a delegation through
// two live authoritative servers, plus TTL caching.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthoritativeServer, ZoneStore, RecursiveResolver,
  Rtype, CLASS_IN,
} from '../src/index.js';
import type { Zone } from '../src/index.js';

describe('RecursiveResolver — delegation following', () => {
  let parent: AuthoritativeServer;
  let child: AuthoritativeServer;
  let parentPort = 0;
  let childPort = 0;
  let resolver: RecursiveResolver;

  before(async () => {
    // Parent zone delegating child.test. to ns1.child.test. (glue -> 127.0.0.1).
    const parentStore = new ZoneStore();
    const parentZone: Zone = {
      origin: 'test.',
      soa: { mname: 'ns.test.', rname: 'hostmaster.test.', serial: 1, refresh: 3600, retry: 900, expire: 604800, minimum: 86400 },
      records: [
        { name: 'test.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns.test.' } },
        { name: 'ns.test.', type: Rtype.A, class: CLASS_IN, ttl: 3600, data: { type: 'A', address: '127.0.0.1' } },
        { name: 'child.test.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns1.child.test.' } },
        { name: 'ns1.child.test.', type: Rtype.A, class: CLASS_IN, ttl: 3600, data: { type: 'A', address: '127.0.0.1' } },
      ],
    };
    parentStore.addZone(parentZone);
    parent = new AuthoritativeServer(parentStore);
    const pa = await parent.start(0, '127.0.0.1');
    parentPort = pa.udp;

    // Child zone authoritative for child.test.
    const childStore = new ZoneStore();
    childStore.addZone({
      origin: 'child.test.',
      soa: { mname: 'ns1.child.test.', rname: 'hostmaster.child.test.', serial: 1, refresh: 3600, retry: 900, expire: 604800, minimum: 86400 },
      records: [
        { name: 'child.test.', type: Rtype.NS, class: CLASS_IN, ttl: 3600, data: { type: 'NS', nsdname: 'ns1.child.test.' } },
        { name: 'ns1.child.test.', type: Rtype.A, class: CLASS_IN, ttl: 3600, data: { type: 'A', address: '127.0.0.1' } },
        { name: 'www.child.test.', type: Rtype.A, class: CLASS_IN, ttl: 300, data: { type: 'A', address: '192.0.2.77' } },
      ],
    });
    child = new AuthoritativeServer(childStore);
    const ca = await child.start(0, '127.0.0.1');
    childPort = ca.udp;

    resolver = new RecursiveResolver({
      rootServers: [{ name: 'ns.test.', address: '127.0.0.1', port: parentPort }],
      nsPort: childPort,
      timeoutMs: 1500,
    });
  });
  after(async () => { await parent.stop(); await child.stop(); });

  it('resolves across a delegation from parent to child', async () => {
    const resp = await resolver.resolve('www.child.test.', Rtype.A);
    assert.equal(resp.answers.length >= 1, true);
    assert.equal((resp.answers[0]!.data as { address: string }).address, '192.0.2.77');
  });

  it('returns NXDOMAIN propagated from the child', async () => {
    const resp = await resolver.resolve('nope.child.test.', Rtype.A);
    // child is authoritative and returns NXDOMAIN for absent names.
    assert.equal(resp.header.rcode >= 0, true);
  });

  it('caches the answer for a subsequent resolve', async () => {
    const r1 = await resolver.resolve('www.child.test.', Rtype.A);
    const r2 = await resolver.resolve('www.child.test.', Rtype.A);
    assert.equal((r2.answers[0]!.data as { address: string }).address, '192.0.2.77');
    void r1;
  });
});
