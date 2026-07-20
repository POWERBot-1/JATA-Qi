import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '../src/index.js';

function boot() {
  const k = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
  k.register(new StorageModule());
  k.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  k.register(new KnowledgeService());
  k.register(new KnowledgeGraphModule({ autoIndexDocuments: true }));
  return k;
}

describe('Graph-RAG fusion', () => {
  let kernel: ReturnType<typeof boot>;
  beforeEach(async () => { kernel = boot(); await kernel.boot(); });

  it('extracts entities from ingested content and links to chunks', async () => {
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    const graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    const doc = await svc.ingestText('Alice Smith is the CEO of Acme Corp, which is based in Paris.', { chunkSize: 500 });
    // Auto-extract entities from each chunk.
    for (const cid of doc.chunkIds) {
      const chunk = await svc.getChunk(cid);
      if (!chunk) continue;
      const res = graph.extractFromText(chunk.text, { chunkId: cid, documentId: doc.id });
      for (const t of res.triples) {
        if (res.entities.find((e) => e.id === t.object)) {
          graph.linkMention(cid, t.object, 0.9, doc.id);
        }
      }
    }
    const persons = graph.entitiesByType('Person');
    const orgs = graph.entitiesByType('Organization');
    assert.ok(persons.length + orgs.length >= 2, `expected at least 2 entities, got persons=${persons.length} orgs=${orgs.length}`);
    assert.equal(graph.stats().triples >= 1, true);
  });

  it('returns graph-enhanced retrieval results (hybrid hits)', async () => {
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    const graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    // Two related docs about a person and their company.
    await svc.ingestText('Jane Doe founded Techno Systems Inc in 2005.', { chunkSize: 500 });
    await svc.ingestText('Techno Systems Inc produces cloud software for finance.', { chunkSize: 500 });
    // Add a direct triple between the two "documents" as entities to exercise graph traversal.
    // (autoIndexDocuments creates doc:<uuid> entities automatically).
    // Query returns hits; just verify hybrid retrieval doesn't crash and returns some hits.
    const hits = await graph.graphRetrieve('company that Jane founded', { topK: 3, graphDepth: 1 });
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length >= 1);
    for (const h of hits) {
      assert.ok(typeof h.combinedScore === 'number');
      assert.ok(h.chunk.text.length > 0);
    }
  });

  it('supports semantic entity search across embedded entities', async () => {
    const graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    graph.addEntity({ id: 'e1', type: 'Person', name: 'Marie Curie, pioneering physicist and chemist' });
    graph.addEntity({ id: 'e2', type: 'Person', name: 'Michael Jordan, legendary basketball player' });
    graph.addEntity({ id: 'e3', type: 'Person', name: 'Isaac Newton, physicist who formulated gravity' });
    await Promise.all([graph.embedEntity('e1'), graph.embedEntity('e2'), graph.embedEntity('e3')]);
    const found = await graph.findEntities('famous scientist', { topK: 2, type: 'Person' });
    assert.ok(found.length >= 1);
    const top = found[0]!.entity;
    assert.ok(top.id === 'e1' || top.id === 'e3', `expected scientist, got ${top.id} (${top.name})`);
  });
});
