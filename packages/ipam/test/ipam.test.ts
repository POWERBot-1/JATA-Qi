// PRX RIR Member — IPAM tests: CIDR math (IPv4/IPv6), allocations with
// overlap checks, splitting, address enumeration, ASN holdings, anycast
// announcements, utilization analytics, and memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IpamEngine, parseCidr, formatIpv4, formatIpv6 } from '../src/index.js';
import { IpamModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('CIDR math', () => {
  it('parses IPv4 CIDRs with network masking', () => {
    const c = parseCidr('196.201.0.0/16');
    assert.equal(c.family, 'ipv4');
    assert.equal(c.prefixLen, 16);
    assert.equal(c.total, 65536n);
    assert.equal(formatIpv4(c.network), '196.201.0.0');
    // Non-network address gets masked.
    assert.equal(formatIpv4(parseCidr('10.1.2.3/24').network), '10.1.2.0');
    assert.throws(() => parseCidr('1.2.3.4/33'), /prefix/);
    assert.throws(() => parseCidr('999.1.1.1/24'), /invalid/);
  });

  it('parses IPv6 CIDRs with :: compression and masks', () => {
    const c = parseCidr('2c0f:f248::/32');
    assert.equal(c.family, 'ipv6');
    assert.equal(c.prefixLen, 32);
    assert.equal(c.total, 1n << 96n);
    assert.equal(formatIpv6(c.network), '2c0f:f248::');
    // Full-form address.
    assert.equal(formatIpv6(parseCidr('2001:db8:0:0:0:0:0:1/128').network), '2001:db8::1');
    assert.throws(() => parseCidr('2c0f:f248::/129'), /prefix/);
  });

  it('formats IPv4/IPv6 addresses', () => {
    assert.equal(formatIpv4(0x0a000001n), '10.0.0.1');
    assert.equal(formatIpv6(0x20010db8000000000000000000000001n), '2001:db8::1');
  });
});

describe('IpamEngine', () => {
  it('allocates blocks with RIR + overlap enforcement', () => {
    const e = new IpamEngine();
    const v4 = e.allocateBlock({ cidr: '196.201.0.0/16', rir: 'AFRINIC', purpose: 'anycast' });
    assert.equal(v4.family, 'ipv4');
    assert.equal(v4.status, 'allocated');
    e.allocateBlock({ cidr: '2c0f:f248::/32', rir: 'AFRINIC' });
    assert.equal(e.listBlocks().length, 2);
    assert.equal(e.listBlocks({ family: 'ipv4' }).length, 1);
    assert.equal(e.listBlocks({ rir: 'AFRINIC' }).length, 2);
    // Overlap rejected.
    assert.throws(() => e.allocateBlock({ cidr: '196.201.128.0/17', rir: 'AFRINIC' }), /overlaps/);
    // Non-overlapping /17 elsewhere is fine.
    e.allocateBlock({ cidr: '197.0.0.0/17', rir: 'AFRINIC' });
    assert.throws(() => e.allocateBlock({ cidr: '1.2.3.0/24', rir: 'UNKNOWN' as never }), /unknown RIR/);
    // Parent validation.
    assert.throws(() => e.allocateBlock({ cidr: '198.0.0.0/16', rir: 'AFRINIC', parentId: 'nope' }), /parent/);
  });

  it('splits blocks into sub-blocks and enumerates addresses', () => {
    const e = new IpamEngine();
    const block = e.allocateBlock({ cidr: '196.201.0.0/16', rir: 'AFRINIC' });
    const subs = e.splitBlock(block.id, 24);
    assert.equal(subs.length, 256);
    assert.equal(subs[0]!.cidr, '196.201.0.0/24');
    assert.equal(subs[255]!.cidr, '196.201.255.0/24');
    assert.equal(subs[0]!.parentId, block.id);
    assert.equal(e.getBlock(block.id)!.status, 'assigned');
    assert.throws(() => e.splitBlock(block.id, 8), /must be longer/);

    // Enumerate a small block.
    const small = e.allocateBlock({ cidr: '10.0.0.0/30', rir: 'ARIN' });
    const addrs = e.addressesInBlock(small.id);
    assert.deepEqual(addrs, ['10.0.0.0', '10.0.0.1', '10.0.0.2', '10.0.0.3']);
    // IPv6 enumeration is bounded.
    const v6 = e.allocateBlock({ cidr: '2c0f:f248::/32', rir: 'AFRINIC' });
    assert.equal(e.addressesInBlock(v6.id, 5).length, 5);
  });

  it('registers addresses into blocks and assigns them', () => {
    const e = new IpamEngine();
    const block = e.allocateBlock({ cidr: '10.1.0.0/24', rir: 'RIPE' });
    const entry = e.registerAddress({ blockId: block.id, address: '10.1.0.10', assignedTo: 'web-1' });
    assert.equal(entry.assignedTo, 'web-1');
    assert.equal(e.listAddresses(block.id).length, 1);
    // Addresses can only be registered in allocated/assigned blocks.
    e.setBlockStatus(block.id, 'available');
    assert.throws(() => e.registerAddress({ blockId: block.id, address: '10.1.0.11' }), /is available/);
  });

  it('holds ASNs and creates anycast announcements', () => {
    const e = new IpamEngine();
    const asn = e.holdAsn({ asn: 327780, rir: 'AFRINIC', announcementType: 'anycast' });
    assert.equal(asn.status, 'active');
    assert.equal(e.listAsns('active').length, 1);
    assert.throws(() => e.holdAsn({ asn: 327780, rir: 'AFRINIC' }), /already held/);
    assert.throws(() => e.holdAsn({ asn: 0, rir: 'AFRINIC' }), /out of range/);

    const block = e.allocateBlock({ cidr: '196.201.0.0/16', rir: 'AFRINIC', purpose: 'anycast' });
    const announcement = e.announce({ blockId: block.id, asnId: asn.id });
    assert.equal(announcement.asnId, asn.id);
    assert.equal(e.listAnnouncements().length, 1);
    // Returning the ASN blocks announcements.
    e.setAsnStatus(asn.id, 'returned');
    assert.throws(() => e.announce({ blockId: block.id, asnId: asn.id }), /is returned/);
  });

  it('computes utilization analytics', () => {
    const e = new IpamEngine();
    const big = e.allocateBlock({ cidr: '196.201.0.0/16', rir: 'AFRINIC' }); // 65536 addresses, allocated
    const small = e.allocateBlock({ cidr: '10.0.0.0/24', rir: 'ARIN' });     // 256, allocated
    e.splitBlock(small.id, 26); // 256 → assigned (counted in total but not allocated)
    const stats = e.stats();
    assert.equal(stats.blocks, 6); // 2 originals + 4 /26 children
    assert.equal(stats.totalAddresses, 65536n + 256n);
    assert.equal(stats.allocatedAddresses, 65536n + 256n);
    assert.equal(stats.asns, 0);
    assert.ok(stats.utilizationPct >= 0);
  });
});

describe('IpamModule', () => {
  it('integrates with memory and emits allocation events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new IpamModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<IpamModule>('ipam');
      const allocated: string[] = [];
      kernel.bus.on('ipam.block.allocated', (p: { id: string }) => { allocated.push(p.id); });

      const block = await mod.allocateBlock({ cidr: '196.201.0.0/16', rir: 'AFRINIC', purpose: 'anycast' });
      assert.equal(allocated.length, 1);
      assert.equal(allocated[0], block.id);

      const asn = mod.holdAsn({ asn: 327780, rir: 'AFRINIC', announcementType: 'anycast' });
      const announcement = mod.announce({ blockId: block.id, asnId: asn.id });
      assert.ok(announcement.since > 0);

      // Milestones recorded in the DME (order-independent).
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const blocks = memory.query({ category: 'ipam_block' });
      assert.equal(blocks.length, 1);
      assert.match(blocks[0]!.summary, /allocated 196\.201\.0\.0\/16 \(AFRINIC\)/);
      const announcements = memory.query({ category: 'ipam_announcement' });
      assert.equal(announcements.length, 1);

      assert.ok(mod.stats().blocks >= 1);
    } finally {
      await kernel.shutdown();
    }
  });
});
