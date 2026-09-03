import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule, MemoryTripleStore, createEntity, createTriple, GraphEvents } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function boot() {
  const k = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
  k.register(new StorageModule());
  k.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  k.register(new KnowledgeService());
  k.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  return k;
}

describe('MemoryTripleStore', () => {
  let store: MemoryTripleStore;
  beforeEach(() => {
    store = new MemoryTripleStore();
    store.upsertEntity(createEntity({ id: 'alice', type: 'Person', name: 'Alice' }));
    store.upsertEntity(createEntity({ id: 'bob', type: 'Person', name: 'Bob' }));
    store.upsertEntity(createEntity({ id: 'acme', type: 'Company', name: 'Acme Corp' }));
    store.upsertEntity(createEntity({ id: 'paris', type: 'City', name: 'Paris' }));
  });

  it('adds and retrieves entities', () => {
    const a = store.getEntity('alice');
    assert.ok(a);
    assert.equal(a!.name, 'Alice');
    assert.equal(a!.type, 'Person');
  });

  it('adds triples with required subject/object existence', () => {
    const t = store.addTriple(createTriple({ subject: 'alice', predicate: 'knows', object: 'bob' }));
    assert.ok(t.id);
    assert.throws(() => store.addTriple(createTriple({ subject: 'alice', predicate: 'x', object: 'ghost' })));
  });

  it('indexes outgoing/incoming triples', () => {
    store.addTriple(createTriple({ subject: 'alice', predicate: 'knows', object: 'bob' }));
    store.addTriple(createTriple({ subject: 'alice', predicate: 'worksAt', object: 'acme' }));
    store.addTriple(createTriple({ subject: 'bob', predicate: 'livesIn', object: 'paris' }));
    assert.equal(store.triplesFrom('alice').length, 2);
    assert.equal(store.triplesTo('paris').length, 1);
    assert.equal(store.triplesFrom('alice', 'knows')[0]!.object, 'bob');
    assert.equal(store.hasTriple('alice', 'knows', 'bob'), true);
    assert.equal(store.hasTriple('alice', 'knows', 'paris'), false);
  });

  it('removes entities and cascades triples', () => {
    store.addTriple(createTriple({ subject: 'alice', predicate: 'knows', object: 'bob' }));
    store.addTriple(createTriple({ subject: 'bob', predicate: 'knows', object: 'alice' }));
    store.removeEntity('alice');
    assert.equal(store.getEntity('alice'), undefined);
    assert.equal(store.triplesFrom('bob').length, 0);
    assert.equal(store.stats().triples, 0);
  });

  it('traverses paths (BFS) up to maxDepth', () => {
    store.upsertEntity(createEntity({ id: 'carol', type: 'Person', name: 'Carol' }));
    store.addTriple(createTriple({ subject: 'alice', predicate: 'knows', object: 'bob' }));
    store.addTriple(createTriple({ subject: 'bob', predicate: 'knows', object: 'carol' }));
    store.addTriple(createTriple({ subject: 'alice', predicate: 'livesIn', object: 'paris' }));
    const paths = store.traverse('alice', { maxDepth: 2, followPredicates: ['knows'] });
    // Depth 1: alice -> bob
    // Depth 2: alice -> bob -> carol
    assert.ok(paths.length >= 2);
    const toCarol = paths.find((p) => p.entities[p.entities.length - 1]!.id === 'carol');
    assert.ok(toCarol);
    assert.equal(toCarol!.entities.length, 3);
  });

  it('respects followPredicates filter', () => {
    store.addTriple(createTriple({ subject: 'alice', predicate: 'knows', object: 'bob' }));
    store.addTriple(createTriple({ subject: 'alice', predicate: 'worksAt', object: 'acme' }));
    const paths = store.traverse('alice', { maxDepth: 1, followPredicates: ['worksAt'] });
    assert.equal(paths.length, 1);
    assert.equal(paths[0]!.entities[1]!.id, 'acme');
  });

  it('returns stats with type/predicate counts', () => {
    store.addTriple(createTriple({ subject: 'alice', predicate: 'knows', object: 'bob' }));
    const s = store.stats();
    assert.equal(s.entities, 4);
    assert.equal(s.triples, 1);
    assert.equal(s.entityTypes['Person'], 2);
    assert.equal(s.predicateTypes['knows'], 1);
  });
});

describe('KnowledgeGraphModule (kernel integration)', () => {
  let kernel: Kernel;
  beforeEach(async () => { kernel = boot(); await kernel.boot(); });

  it('boots, exposes entities/triples API, and publishes events', async () => {
    const mod = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    const events: string[] = [];
    kernel.bus.on(GraphEvents.EntityAdded, () => { events.push('entity'); });
    kernel.bus.on(GraphEvents.TripleAdded, () => { events.push('triple'); });
    const alice = mod.addEntity({ id: 'alice', type: 'Person', name: 'Alice' });
    const bob = mod.addEntity({ id: 'bob', type: 'Person', name: 'Bob' });
    mod.addTriple({ subject: 'alice', predicate: 'knows', object: 'bob' });
    assert.equal(alice.name, 'Alice');
    assert.equal(mod.triplesFrom('alice').length, 1);
    assert.ok(events.includes('entity'));
    assert.ok(events.includes('triple'));
  });

  it('persists and reloads graph state from storage', async () => {
    const mod = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    mod.addEntity({ id: 'x', type: 'Concept', name: 'X' });
    mod.addEntity({ id: 'y', type: 'Concept', name: 'Y' });
    mod.addTriple({ subject: 'x', predicate: 'relatesTo', object: 'y', confidence: 0.8 });
    await mod.persist();
    // Grab the driver BEFORE shutting kernel down (shutdown closes the in-memory driver
    // and wipes data; the point of persist is to write to the storage collections, which
    // in memory only survive if the driver instance is reused without close()).
    const storage = kernel.getModule<StorageModule>('storage');
    const driver = storage.getDriver();

    // New kernel reusing the same driver (simulating a warm restart or another process
    // connecting to the same backing store).
    const k2 = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    k2.register(new StorageModule({ driverInstance: driver }));
    k2.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    k2.register(new KnowledgeService());
    k2.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    await k2.boot();
    const mod2 = k2.getModule<KnowledgeGraphModule>('knowledge-graph');
    assert.ok(mod2.getEntity('x'));
    assert.equal(mod2.triplesFrom('x').length, 1);
    assert.equal(mod2.triplesFrom('x')[0]!.object, 'y');
    await k2.shutdown();
  });

  it('persists graph mutations created during knowledge ingest through orderly filesystem shutdown', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-graph-shutdown-'));
    const first = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    const second = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    try {
      first.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      first.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
      first.register(new KnowledgeService());
      first.register(new KnowledgeGraphModule());
      await first.boot();

      const knowledge = first.getModule<KnowledgeService>('knowledge');
      const graph = first.getModule<KnowledgeGraphModule>('knowledge-graph');
      const document = await knowledge.ingestText('The graph shutdown sentinel links Alice to Bob.');
      graph.addEntity({ id: 'alice', type: 'Person', name: 'Alice' });
      graph.addEntity({ id: 'bob', type: 'Person', name: 'Bob' });
      graph.addTriple({ subject: 'alice', predicate: 'knows', object: 'bob' });
      await graph.embedEntity('alice');
      await first.shutdown();

      const collectionFiles = await fs.readdir(path.join(root, 'collections'));
      assert.equal(collectionFiles.filter((name) => name.includes('.tmp-')).length, 0);

      second.register(new StorageModule({ driver: 'filesystem', fsRoot: root }));
      second.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
      second.register(new KnowledgeService());
      second.register(new KnowledgeGraphModule());
      await second.boot();
      const restored = second.getModule<KnowledgeGraphModule>('knowledge-graph');
      assert.ok(restored.getEntity(`doc:${document.id}`));
      assert.ok(restored.getEntity('alice'));
      assert.equal(restored.triplesFrom('alice').length, 1);
      assert.equal(restored.triplesFrom('alice')[0]!.object, 'bob');
      const entityHits = await restored.findEntities('Alice', { topK: 1 });
      assert.equal(entityHits[0]!.entity.id, 'alice');
    } finally {
      try { await first.shutdown(); } catch { /* cleanup after failed boot/test */ }
      try { await second.shutdown(); } catch { /* cleanup after failed boot/test */ }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('embeds entities and finds them semantically', async () => {
    const mod = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    mod.addEntity({ id: 'cat', type: 'Animal', name: 'Domestic cat, a feline pet' });
    mod.addEntity({ id: 'dog', type: 'Animal', name: 'Domestic dog, a canine companion' });
    mod.addEntity({ id: 'quark', type: 'Particle', name: 'Quark, a subatomic particle' });
    await mod.embedEntity('cat');
    await mod.embedEntity('dog');
    await mod.embedEntity('quark');
    const found = await mod.findEntities('household pets', { topK: 2 });
    assert.ok(found.length >= 1);
    const top = found[0]!.entity;
    assert.ok(top.id === 'cat' || top.id === 'dog', `expected cat/dog top hit, got ${top.id}`);
  });

  it('createEntity generates an id when none supplied', () => {
    const e = createEntity({ type: 'Person', name: 'Test' });
    assert.ok(e.id.startsWith('person_'));
    assert.equal(e.name, 'Test');
  });

  it('createTriple clamps confidence range', () => {
    assert.throws(() => createTriple({ subject: 'a', predicate: 'b', object: 'c', confidence: 2 }));
    assert.doesNotThrow(() => createTriple({ subject: 'a', predicate: 'b', object: 'c', confidence: 0.5 }));
  });
});
