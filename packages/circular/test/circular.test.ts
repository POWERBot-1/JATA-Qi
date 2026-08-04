// KARIS LOOP (Phase 7) tests: material streams, collection lifecycle with
// recycling/diversion/landfill outcomes, product take-back with composition,
// circularity scoring, CO2e savings, and memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircularEngine } from '../src/index.js';
import { CircularModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('CircularEngine', () => {
  it('registers material streams and toggles activity', () => {
    const c = new CircularEngine();
    const plastic = c.registerStream({ name: 'PET Bottles', type: 'plastic', co2ePerKg: 1.5 });
    c.registerStream({ name: 'Glass', type: 'glass', co2ePerKg: 0.8 });
    assert.equal(c.listStreams().length, 2);
    assert.equal(c.listStreams(true).length, 2);
    c.setStreamActive(plastic.id, false);
    assert.equal(c.listStreams(true).length, 1);
    assert.throws(() => c.registerStream({ name: '' }), /required/);
  });

  it('records collections and walks the processing lifecycle', () => {
    const c = new CircularEngine();
    const stream = c.registerStream({ name: 'Metal', type: 'metal' });
    const col = c.recordCollection({ streamId: stream.id, weightKg: 500, source: 'Eldoret depot' });
    assert.equal(col.status, 'collected');
    assert.equal(c.listCollections(stream.id).length, 1);
    c.updateCollectionStatus(col.id, 'processed');
    c.updateCollectionStatus(col.id, 'recycled');
    assert.equal(c.getCollection(col.id)!.status, 'recycled');
    assert.equal(c.listCollections(stream.id, 'recycled').length, 1);
    assert.throws(() => c.recordCollection({ streamId: 'nope', weightKg: 1, source: 'x' }), /unknown stream/);
    assert.throws(() => c.recordCollection({ streamId: stream.id, weightKg: 0, source: 'x' }), /positive/);
  });

  it('registers take-back items with validated composition', () => {
    const c = new CircularEngine();
    const item = c.registerTakeBack({
      productId: 'phone-x', productName: 'Phone X',
      composition: { 'plastic': 0.4, 'metal': 0.5, 'e_waste': 0.1 },
      returnedBy: 'consumer-1',
    });
    assert.equal(item.status, 'returned');
    c.updateTakeBackStatus(item.id, 'refurbished');
    assert.equal(c.listTakeBack('refurbished').length, 1);
    assert.throws(() => c.registerTakeBack({
      productId: 'bad', productName: 'Bad', composition: { 'plastic': 0.7 }, returnedBy: 'x',
    }), /sum to 1/);
  });

  it('computes circularity scores and CO2e savings', () => {
    const c = new CircularEngine();
    const plastic = c.registerStream({ name: 'PET', type: 'plastic', co2ePerKg: 1.5 });
    const metal = c.registerStream({ name: 'ALU', type: 'metal', co2ePerKg: 3.0 });
    const col1 = c.recordCollection({ streamId: plastic.id, weightKg: 100, source: 'A' });
    const col2 = c.recordCollection({ streamId: metal.id, weightKg: 200, source: 'B' });
    c.updateCollectionStatus(col1.id, 'recycled');
    c.updateCollectionStatus(col2.id, 'landfill');

    const stats = c.stats();
    assert.equal(stats.collectedKg, 300);
    assert.equal(stats.recycledKg, 100);
    assert.equal(stats.landfillKg, 200);
    assert.equal(stats.totalCo2eSavedKg, 150); // 100kg × 1.5
    assert.ok(Math.abs(stats.circularRate - 1 / 3) < 0.001);

    // Product circularity: 2 of 3 items in the loop.
    const a = c.registerTakeBack({ productId: 'p1', productName: 'P1', composition: {}, returnedBy: 'u' });
    const b = c.registerTakeBack({ productId: 'p1', productName: 'P1', composition: {}, returnedBy: 'u' });
    const d = c.registerTakeBack({ productId: 'p1', productName: 'P1', composition: {}, returnedBy: 'u' });
    c.updateTakeBackStatus(a.id, 'recycled');
    c.updateTakeBackStatus(b.id, 'refurbished');
    c.updateTakeBackStatus(d.id, 'disposed');
    const score = c.scoreCircularity('product', 'p1');
    assert.equal(score.score, 67);
    assert.ok(Math.abs(score.circularRate - 2 / 3) < 0.001);
    assert.equal(score.landfillRate, 1 / 3);
  });
});

describe('CircularModule', () => {
  it('integrates with memory and emits collection events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new CircularModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<CircularModule>('circular');
      const recorded: string[] = [];
      kernel.bus.on('circular.collection.recorded', (p: { id: string }) => { recorded.push(p.id); });

      const stream = mod.registerStream({ name: 'Glass', type: 'glass' });
      const col = await mod.recordCollection({ streamId: stream.id, weightKg: 250, source: 'Nairobi' });
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0], col.id);

      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const recs = memory.query({ category: 'circular_collection' });
      assert.equal(recs.length, 1);
      assert.match(recs[0]!.summary, /250kg from Nairobi/);

      assert.equal(mod.stats().collections, 1);
      assert.equal(mod.stats().collectedKg, 250);
    } finally {
      await kernel.shutdown();
    }
  });
});
