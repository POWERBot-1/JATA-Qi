// KARIS BORDER X (Phase 7) tests: border posts, watchlist screening,
// traveler crossings with clearance decisions, cargo manifests with risk
// flagging, and memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BorderEngine } from '../src/index.js';
import { BorderModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('BorderEngine', () => {
  it('registers posts and toggles status', () => {
    const b = new BorderEngine();
    const post = b.registerPost({ name: 'Busia', crossing: 'ke-ug', location: 'Busia town' });
    assert.equal(post.crossing, 'KE-UG');
    assert.equal(b.listPosts().length, 1);
    b.setPostStatus(post.id, 'restricted');
    assert.equal(b.getPost(post.id)!.status, 'restricted');
    assert.equal(b.listPosts('restricted').length, 1);
    assert.throws(() => b.registerPost({ name: '', crossing: 'KE' }), /required/);
  });

  it('screens travelers against the watchlist and refers matches', () => {
    const b = new BorderEngine();
    const post = b.registerPost({ name: 'Malaba', crossing: 'KE-UG' });
    b.addWatchlist({ name: 'John Doe', documentNo: 'P1234567', category: 'person', reason: 'fraud investigation' });
    b.addWatchlist({ name: 'Truck KDA 100X', documentNo: 'V-99887', category: 'vehicle', reason: 'smuggling suspect' });

    const clean = b.processCrossing({
      postId: post.id, travelerId: 't1', travelerName: 'Alice Smith',
      documentNo: 'P7654321', mode: 'road', direction: 'inbound',
    });
    assert.equal(clean.clearance, 'cleared');

    const match = b.processCrossing({
      postId: post.id, travelerId: 't2', travelerName: 'John Doe',
      documentNo: 'P1234567', mode: 'foot', direction: 'outbound',
    });
    assert.equal(match.clearance, 'referred');
    assert.match(match.reason ?? '', /watchlist match/);

    // Document-only match (name differs).
    const docMatch = b.processCrossing({
      postId: post.id, travelerId: 't3', travelerName: 'J. Doe',
      documentNo: 'P1234567', mode: 'road', direction: 'inbound',
    });
    assert.equal(docMatch.clearance, 'referred');

    // Closed post blocks crossings.
    b.setPostStatus(post.id, 'closed');
    assert.throws(() => b.processCrossing({
      postId: post.id, travelerId: 't4', travelerName: 'X', documentNo: 'P1', mode: 'road', direction: 'inbound',
    }), /closed/);

    // Override a referral after officer review.
    b.setPostStatus(post.id, 'open');
    const cleared = b.overrideClearance(match.id, 'cleared', 'document verified');
    assert.equal(cleared!.clearance, 'cleared');
    assert.equal(b.listCrossings({ clearance: 'referred' }).length, 1); // docMatch still referred
  });

  it('declares manifests and flags risky cargo', () => {
    const b = new BorderEngine();
    const post = b.registerPost({ name: 'Mombasa Port', crossing: 'KE' });
    const normal = b.declareManifest({
      postId: post.id, reference: 'MF-1001', consignor: 'Exporter A', consignee: 'Importer B',
      description: 'Electronics', weightKg: 800,
    });
    assert.equal(normal.flagged, false);
    assert.equal(normal.status, 'declared');

    const flagged = b.declareManifest({
      postId: post.id, reference: 'MF-1002', consignor: 'X', consignee: 'Y',
      description: 'General goods', weightKg: 15_000,
    });
    assert.equal(flagged.flagged, true);
    assert.equal(flagged.status, 'inspected');

    b.updateManifestStatus(flagged.id, 'held');
    assert.equal(b.getManifestByRef('MF-1002')!.status, 'held');
    assert.equal(b.listManifests({ flagged: true }).length, 1);
    assert.equal(b.listManifests({ status: 'held' }).length, 1);
    assert.throws(() => b.declareManifest({
      postId: 'nope', reference: 'MF-1', consignor: 'A', consignee: 'B', description: 'x', weightKg: 1,
    }), /unknown post/);
  });

  it('reports aggregate stats', () => {
    const b = new BorderEngine();
    const post = b.registerPost({ name: 'Post', crossing: 'KE-TZ' });
    b.addWatchlist({ name: 'S', documentNo: 'D1', category: 'person', reason: 'r' });
    b.processCrossing({ postId: post.id, travelerId: '1', travelerName: 'A', documentNo: 'P1', mode: 'road', direction: 'inbound' });
    b.processCrossing({ postId: post.id, travelerId: '2', travelerName: 'S', documentNo: 'D1', mode: 'road', direction: 'outbound' });
    b.declareManifest({ postId: post.id, reference: 'MF-1', consignor: 'A', consignee: 'B', description: 'General goods', weightKg: 20_000 });
    const stats = b.stats();
    assert.equal(stats.posts, 1);
    assert.equal(stats.crossings, 2);
    assert.equal(stats.cleared, 1);
    assert.equal(stats.referred, 1);
    assert.equal(stats.manifests, 1);
    assert.equal(stats.inspected, 1);
    assert.equal(stats.watchlistEntries, 1);
  });
});

describe('BorderModule', () => {
  it('integrates with memory and emits referral events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new BorderModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<BorderModule>('border');
      const referred: string[] = [];
      kernel.bus.on('border.crossing.referred', (p: { id: string }) => { referred.push(p.id); });

      const post = mod.registerPost({ name: 'Busia', crossing: 'KE-UG' });
      mod.addWatchlist({ name: 'Watch Target', documentNo: 'W-001', category: 'person', reason: 'test' });
      const crossing = await mod.processCrossing({
        postId: post.id, travelerId: 'u1', travelerName: 'Watch Target',
        documentNo: 'W-001', mode: 'road', direction: 'inbound',
      });
      assert.equal(referred.length, 1);
      assert.equal(referred[0], crossing.id);
      assert.equal(crossing.clearance, 'referred');

      // Crossing recorded in the DME.
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const recs = memory.query({ category: 'border_crossing' });
      assert.equal(recs.length, 1);
      assert.match(recs[0]!.summary, /referred/);

      // Flagged manifest also recorded.
      await mod.declareManifest({
        postId: post.id, reference: 'MF-X', consignor: 'A', consignee: 'B',
        description: 'General goods', weightKg: 12_000,
      });
      const manifests = memory.query({ category: 'border_manifest' });
      assert.equal(manifests.length, 1);
      assert.match(manifests[0]!.summary, /FLAGGED/);

      assert.equal(mod.stats().referred, 1);
    } finally {
      await kernel.shutdown();
    }
  });
});
