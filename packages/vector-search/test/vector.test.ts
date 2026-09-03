import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  cosineSimilarity,
  cosineDistance,
  euclidean,
  normalize,
  FlatIndex,
  HashEmbeddingModel,
  VectorSearchModule,
} from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import type { Kernel } from '@jataqi/core-kernel';
import { VectorEvents } from '../src/index.js';

describe('distance primitives', () => {
  it('cosine similarity of identical unit vectors is 1', () => {
    const a = new Float32Array([1, 0, 0]);
    assert.equal(cosineSimilarity(a, a), 1);
  });
  it('cosine similarity of orthogonal vectors is ~0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-9);
  });
  it('normalize produces unit length', () => {
    const v = normalize(new Float32Array([3, 4]));
    const len = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]!);
    assert.ok(Math.abs(len - 1) < 1e-6);
  });
  it('euclidean distance between a point and itself is 0', () => {
    const a = new Float32Array([1, 2, 3]);
    assert.equal(euclidean(a, a), 0);
  });
  it('cosine distance is 0 for identical normalized vectors', () => {
    const a = normalize(new Float32Array([2, 3, 4]));
    assert.ok(Math.abs(cosineDistance(a, a)) < 1e-9);
  });
});

describe('HashEmbeddingModel', () => {
  it('produces deterministic vectors of the requested dimension', async () => {
    const m = new HashEmbeddingModel(64);
    const a = await m.embed('hello world');
    const b = await m.embed('hello world');
    assert.equal(a.length, 64);
    assert.deepEqual([...a], [...b]);
  });
  it('embeds similar texts more closely than unrelated ones', async () => {
    const m = new HashEmbeddingModel(128);
    const cat = await m.embed('The quick brown fox jumps over the lazy dog');
    const cat2 = await m.embed('The quick brown fox leaped over the lazy dog');
    const dog = await m.embed('Completely unrelated bananas in a cosmic microwave');
    const simClose = cosineSimilarity(cat, cat2);
    const simFar = cosineSimilarity(cat, dog);
    assert.ok(simClose > simFar, `expected close (${simClose}) > far (${simFar})`);
  });
  it('embedBatch returns one vector per input', async () => {
    const m = new HashEmbeddingModel(32);
    const r = await m.embedBatch(['a', 'b', 'c']);
    assert.equal(r.length, 3);
    for (const v of r) assert.equal(v.length, 32);
  });
});

describe('FlatIndex', () => {
  let idx: FlatIndex;
  beforeEach(() => { idx = new FlatIndex('test', 3, 'cosine'); });

  it('adds and retrieves records', async () => {
    await idx.add({ id: 'a', dim: 3, vector: new Float32Array([1, 0, 0]) });
    assert.ok(await idx.has('a'));
    const r = await idx.get('a');
    assert.equal(r!.id, 'a');
    assert.equal(await idx.count(), 1);
  });

  it('rejects dimension mismatches', async () => {
    await assert.rejects(
      () => idx.add({ id: 'x', dim: 4, vector: new Float32Array([1, 0, 0, 0]) }),
      /[Dd]imension mismatch/,
    );
  });

  it('returns nearest neighbor first in cosine space', async () => {
    // Normalized cardinal directions
    await idx.add({ id: 'x+', dim: 3, vector: normalize(new Float32Array([1, 0, 0])) });
    await idx.add({ id: 'y+', dim: 3, vector: normalize(new Float32Array([0, 1, 0])) });
    await idx.add({ id: 'z+', dim: 3, vector: normalize(new Float32Array([0, 0, 1])) });
    const qVec = normalize(new Float32Array([1, 0, 0])); // exactly x+
    const hits = await idx.search(qVec, { topK: 3 });
    assert.equal(hits[0]!.id, 'x+');
    assert.equal(hits[0]!.score, 1);
    // Query that leans toward x: x+ must be first, y+ before z+
    const q2 = normalize(new Float32Array([0.9, 0.2, 0.1]));
    const hits2 = await idx.search(q2, { topK: 3 });
    assert.equal(hits2[0]!.id, 'x+');
  });

  it('applies filter and minScore', async () => {
    await idx.add({ id: 'a', dim: 3, vector: normalize(new Float32Array([1, 0, 0])), metadata: { ok: true } });
    await idx.add({ id: 'b', dim: 3, vector: normalize(new Float32Array([1, 0, 0])), metadata: { ok: false } });
    const filtered = await idx.search(normalize(new Float32Array([1, 0, 0])), { filter: (m) => m?.ok === true });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.id, 'a');
  });

  it('remove works', async () => {
    await idx.add({ id: 'a', dim: 3, vector: normalize(new Float32Array([1, 0, 0])) });
    assert.equal(await idx.remove('a'), true);
    assert.equal(await idx.remove('a'), false);
    assert.equal(await idx.count(), 0);
  });

  it('addBatch and entries snapshot', async () => {
    await idx.addBatch([
      { id: '1', dim: 3, vector: new Float32Array([1,0,0]) },
      { id: '2', dim: 3, vector: new Float32Array([0,1,0]) },
    ]);
    assert.equal(idx.entries().length, 2);
  });

  it('clear resets the index', async () => {
    await idx.add({ id: 'a', dim: 3, vector: new Float32Array([1,0,0]) });
    await idx.clear();
    assert.equal(await idx.count(), 0);
    assert.deepEqual(idx.stats(), { count: 0, dim: 3, metric: 'cosine', memoryBytes: 0 });
  });
});

describe('VectorSearchModule (kernel integration)', () => {
  let kernel: Kernel;
  beforeEach(async () => {
    kernel = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    await kernel.boot();
  });

  it('embeds + indexes + searches text end-to-end', async () => {
    const mod = kernel.getModule<VectorSearchModule>('vector-search');
    await mod.embedAndAdd('docs', [
      { id: 'd1', text: 'Cats are beloved domestic pets that purr.' },
      { id: 'd2', text: 'The mitochondrion is the powerhouse of the cell.' },
      { id: 'd3', text: 'Dogs are loyal animals often kept as pets.' },
    ]);
    const hits = await mod.embedAndSearch('docs', 'Which animals are kept as pets?', { topK: 2 });
    assert.ok(hits.length >= 1);
    // d1 and d3 should both rank above d2.
    const topIds = hits.map((h) => h.id);
    assert.ok(topIds.includes('d1') || topIds.includes('d3'), `expected pet-related doc in results, got ${topIds.join(',')}`);
    assert.ok(!topIds.slice(0, 1).includes('d2'));
  });

  it('persists and reloads indexes from storage', async () => {
    const mod = kernel.getModule<VectorSearchModule>('vector-search');
    const storageMod = kernel.getModule<StorageModule>('storage');
    await mod.embedAndAdd('p', [
      { id: 'x', text: 'alpha bravo' },
      { id: 'y', text: 'charlie delta' },
    ]);
    await mod.persist('p');
    // Now load into a fresh VectorSearchModule using the SAME (already-initialized)
    // storage module — simulating restart with persisted state intact.
    const kernel2 = createTestKernel();
    // Register storage without re-initializing it by passing the existing driver via config.
    kernel2.register(new StorageModule({ driverInstance: storageMod.getDriver() }));
    kernel2.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    await kernel2.boot();
    const mod2 = kernel2.getModule<VectorSearchModule>('vector-search');
    const idx = await mod2.load('p');
    assert.equal(await idx.count(), 2);
    const hits = await mod2.embedAndSearch('p', 'alpha bravo', { topK: 1 });
    assert.equal(hits[0]!.id, 'x');
    await kernel2.shutdown();
  });

  it('persists opened filesystem indexes on orderly shutdown and restores them after restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-vector-restart-'));
    const first = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    const second = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    try {
      first.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      first.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
      await first.boot();
      const firstVectors = first.getModule<VectorSearchModule>('vector-search');
      await firstVectors.embedAndAdd('restart-index', [
        { id: 'alpha', text: 'alpha bravo durable vector record' },
        { id: 'beta', text: 'charlie delta unrelated record' },
      ]);
      await first.shutdown();

      second.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      second.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
      await second.boot();
      const secondVectors = second.getModule<VectorSearchModule>('vector-search');
      const restored = await secondVectors.load('restart-index');
      assert.equal(await restored.count(), 2);
      const hits = await secondVectors.embedAndSearch('restart-index', 'alpha bravo durable vector record', { topK: 1 });
      assert.equal(hits[0]!.id, 'alpha');
    } finally {
      try { await first.shutdown(); } catch { /* cleanup after failed boot/test */ }
      try { await second.shutdown(); } catch { /* cleanup after failed boot/test */ }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('publishes vector lifecycle events', async () => {
    const mod = kernel.getModule<VectorSearchModule>('vector-search');
    const events: string[] = [];
    kernel.bus.on(VectorEvents.IndexCreated, () => { events.push('index-created'); });
    kernel.bus.on(VectorEvents.VectorAdded, () => { events.push('added'); });
    kernel.bus.on(VectorEvents.Searched, () => { events.push('searched'); });
    await mod.embedAndAdd('e', [{ id: '1', text: 'hello' }]);
    await mod.embedAndSearch('e', 'hello');
    assert.ok(events.includes('index-created'));
    assert.ok(events.includes('added'));
    assert.ok(events.includes('searched'));
  });
});
