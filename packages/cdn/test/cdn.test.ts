// PRX CDN tests: edge nodes, zones, caching with TTLs + origin shield,
// purge, and memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CdnEngine } from '../src/index.js';
import { CdnModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('CdnEngine', () => {
  it('registers edge nodes and toggles status', () => {
    const c = new CdnEngine();
    const node = c.registerEdgeNode({ name: 'nbo-1', region: 'east-africa', country: 'KE', capacityRps: 5000 });
    assert.equal(node.status, 'online');
    assert.equal(c.listEdgeNodes().length, 1);
    c.setEdgeNodeStatus(node.id, 'draining');
    assert.equal(c.listEdgeNodes('draining').length, 1);
    assert.throws(() => c.registerEdgeNode({ name: '', region: 'x', country: 'KE' }), /required/);
  });

  it('creates zones and resolves by domain', () => {
    const c = new CdnEngine();
    const zone = c.createZone({ domain: 'assets.example.com', origin: 'https://origin.example.com', originShield: true, tlsEnabled: true, defaultTtlSec: 600 });
    assert.equal(zone.status, 'active');
    assert.equal(c.getZoneByDomain('assets.example.com')!.id, zone.id);
    assert.equal(c.listZones('active').length, 1);
    c.setZoneStatus(zone.id, 'paused');
    assert.equal(c.getZone(zone.id)!.status, 'paused');
    assert.throws(() => c.createZone({ domain: '', origin: 'x' }), /required/);
  });

  it('serves cache hits, misses, and origin-shield staleness', () => {
    const c = new CdnEngine();
    const zone = c.createZone({ domain: 'cdn.example.com', origin: 'https://origin.example.com', originShield: true, defaultTtlSec: 60 });

    // Miss.
    const miss = c.lookup(zone.id, '/img/logo.png');
    assert.equal(miss.outcome, 'miss');

    // Store + hit.
    c.storeAsset({ zoneId: zone.id, path: '/img/logo.png', contentType: 'image/png', sizeBytes: 10_000 });
    const hit = c.lookup(zone.id, '/img/logo.png');
    assert.equal(hit.outcome, 'hit');
    assert.equal(hit.asset!.sizeBytes, 10_000);
    assert.equal(hit.asset!.hits, 1);

    // Second hit increments.
    assert.equal(c.lookup(zone.id, '/img/logo.png').asset!.hits, 2);

    // Expired asset → shield_hit (origin shield holds a revalidatable copy).
    const old = c.getAsset(zone.id, '/img/logo.png')!;
    old.expiresAt = Date.now() - 1000;
    const stale = c.lookup(zone.id, '/img/logo.png');
    assert.equal(stale.outcome, 'shield_hit');
    assert.equal(stale.asset!.id, old.id);

    // Store again revalidates → hit.
    c.storeAsset({ zoneId: zone.id, path: '/img/logo.png', contentType: 'image/png', sizeBytes: 10_000, ttlSec: 60 });
    assert.equal(c.lookup(zone.id, '/img/logo.png').outcome, 'hit');

    // Unknown zone throws on store.
    assert.throws(() => c.storeAsset({ zoneId: 'nope', path: '/x', contentType: 'text/plain', sizeBytes: 1 }), /unknown zone/);
  });

  it('purges by path, prefix, and whole zone', () => {
    const c = new CdnEngine();
    const zone = c.createZone({ domain: 'cdn.example.com', origin: 'https://origin.example.com' });
    c.storeAsset({ zoneId: zone.id, path: '/css/app.css', contentType: 'text/css', sizeBytes: 100 });
    c.storeAsset({ zoneId: zone.id, path: '/css/theme.css', contentType: 'text/css', sizeBytes: 200 });
    c.storeAsset({ zoneId: zone.id, path: '/js/app.js', contentType: 'application/javascript', sizeBytes: 300 });

    assert.equal(c.purge(zone.id, { path: '/css/app.css' }).purged, 1);
    assert.equal(c.getAsset(zone.id, '/css/app.css'), undefined);
    assert.equal(c.purge(zone.id, { prefix: '/css/' }).purged, 1);
    assert.equal(c.listAssets(zone.id).length, 1);
    assert.equal(c.purge(zone.id, { all: true }).purged, 1);
    assert.equal(c.listAssets(zone.id).length, 0);
  });

  it('computes edge analytics with hit rate', () => {
    const c = new CdnEngine();
    const zone = c.createZone({ domain: 'cdn.example.com', origin: 'https://origin.example.com' });
    c.storeAsset({ zoneId: zone.id, path: '/a', contentType: 'text/plain', sizeBytes: 10 });
    c.lookup(zone.id, '/a'); // hit
    c.lookup(zone.id, '/a'); // hit
    c.lookup(zone.id, '/b'); // miss
    const stats = c.stats();
    assert.equal(stats.cachedAssets, 1);
    assert.equal(stats.cachedBytes, 10);
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    assert.ok(Math.abs(stats.hitRate - 2 / 3) < 0.001);
  });
});

describe('CdnModule', () => {
  it('integrates with memory and emits cache events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new CdnModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<CdnModule>('cdn');
      const purged: number[] = [];
      kernel.bus.on('cdn.cache.purged', (p: { purged: number }) => { purged.push(p.purged); });

      const zone = mod.createZone({ domain: 'cdn.example.com', origin: 'https://origin.example.com' });
      const asset = await mod.storeAsset({ zoneId: zone.id, path: '/img/x.png', contentType: 'image/png', sizeBytes: 500 });
      assert.equal(asset.sizeBytes, 500);
      assert.equal(mod.lookup(zone.id, '/img/x.png').outcome, 'hit');

      const result = await mod.purge(zone.id, { all: true });
      assert.equal(result.purged, 1);
      assert.equal(purged.length, 1);
      assert.equal(purged[0], 1);

      // Cache milestones recorded in the DME (order-independent).
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const recs = memory.query({ category: 'cdn_cache' });
      assert.equal(recs.length, 2);
      assert.ok(recs.some((r) => /cached \/img\/x.png/.test(r.summary)));
      assert.ok(recs.some((r) => /purged 1 asset/.test(r.summary)));

      assert.ok(mod.stats().nodes >= 0);
    } finally {
      await kernel.shutdown();
    }
  });
});
