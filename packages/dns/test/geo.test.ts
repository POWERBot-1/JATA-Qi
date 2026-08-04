// GeoDNS tests — CIDR matching (IPv4/IPv6), round-robin, weighted failover.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeoBalancer, aPool, Rtype } from '../src/index.js';

describe('GeoBalancer', () => {
  it('round-robin rotates the record order', () => {
    const g = new GeoBalancer();
    g.addRule({ zone: 'z.test.', name: 'a.z.test.', type: Rtype.A, policy: 'round-robin', pools: [{ records: aPool(['1.1.1.1', '2.2.2.2', '3.3.3.3']) }] });
    const firsts = new Set<string>();
    for (let i = 0; i < 6; i++) firsts.add((g.resolve('z.test.', 'a.z.test.', Rtype.A)?.[0] as { address: string }).address);
    assert.ok(firsts.size >= 2);
  });

  it('geo view selects the matching CIDR pool', () => {
    const g = new GeoBalancer();
    g.addRule({
      zone: 'z.test.', name: 'a.z.test.', type: Rtype.A, policy: 'geo',
      pools: [
        { cidrs: ['10.0.0.0/8'], records: aPool(['10.0.0.1']) },
        { cidrs: ['192.168.0.0/16'], records: aPool(['192.168.1.1']) },
        { records: aPool(['203.0.113.1']) },
      ],
    });
    assert.equal((g.resolve('z.test.', 'a.z.test.', Rtype.A, '10.5.5.5')?.[0] as { address: string }).address, '10.0.0.1');
    assert.equal((g.resolve('z.test.', 'a.z.test.', Rtype.A, '192.168.9.9')?.[0] as { address: string }).address, '192.168.1.1');
    assert.equal((g.resolve('z.test.', 'a.z.test.', Rtype.A, '8.8.8.8')?.[0] as { address: string }).address, '203.0.113.1');
  });

  it('failover skips unhealthy pools', () => {
    const g = new GeoBalancer();
    g.addRule({
      zone: 'z.test.', name: 'a.z.test.', type: Rtype.A, policy: 'failover',
      pools: [
        { weight: 10, records: aPool(['1.1.1.1']) },
        { weight: 5, records: aPool(['2.2.2.2']) },
      ],
    });
    // Primary healthy -> serve primary.
    let r = g.resolve('z.test.', 'a.z.test.', Rtype.A);
    assert.equal((r![0] as { address: string }).address, '1.1.1.1');
    // Mark primary unhealthy -> failover to secondary.
    g.setHealth('z.test.', 'a.z.test.', Rtype.A, 0, false);
    r = g.resolve('z.test.', 'a.z.test.', Rtype.A);
    assert.equal((r![0] as { address: string }).address, '2.2.2.2');
  });

  it('matches an IPv6 CIDR', () => {
    const g = new GeoBalancer();
    g.addRule({
      zone: 'z.test.', name: 'a.z.test.', type: Rtype.AAAA, policy: 'geo',
      pools: [{ cidrs: ['2a01:db8::/32'], records: [{ type: 'AAAA', address: '2a01:db8::1' }] }],
    });
    const r = g.resolve('z.test.', 'a.z.test.', Rtype.AAAA, '2a01:db8:1::5');
    assert.ok(r);
    assert.equal((r![0] as { address: string }).address, '2a01:db8::1');
  });

  it('returns undefined when no rule applies', () => {
    const g = new GeoBalancer();
    assert.equal(g.resolve('z.test.', 'a.z.test.', Rtype.A), undefined);
  });
});
