// Phase 6 — SearchModule integration tests: adapters attach to the real
// knowledge/memory/graph/conversations/tools modules, federated queries work
// end-to-end, personalization folds in learning adaptations, and search
// history lands in the Digital Memory Engine.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { DigitalMemoryModule } from '@jataqi/memory';
import { ContinuousLearningModule } from '@jataqi/learning';
import { ConversationsModule } from '@jataqi/conversations';
import { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import { SearchModule } from '../src/index.js';

async function bootFull() {
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  kernel.register(new DigitalMemoryModule());
  kernel.register(new ContinuousLearningModule());
  kernel.register(new ConversationsModule());
  kernel.register(new ToolIntelligenceModule());
  kernel.register(new SearchModule());
  await kernel.boot();
  return kernel;
}

describe('SearchModule (Phase 6)', () => {
  it('registers adapters for all available sources', async () => {
    const kernel = await bootFull();
    try {
      const search = kernel.getModule<SearchModule>('search');
      const sources = search.sources();
      assert.ok(sources.includes('knowledge'));
      assert.ok(sources.includes('memory'));
      assert.ok(sources.includes('graph'));
      assert.ok(sources.includes('conversations'));
      assert.ok(sources.includes('tools'));
    } finally {
      await kernel.shutdown();
    }
  });

  it('federates a query across knowledge + memory + graph', async () => {
    const kernel = await bootFull();
    try {
      const knowledge = kernel.getModule<KnowledgeService>('knowledge');
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
      const search = kernel.getModule<SearchModule>('search');

      await knowledge.ingestText('JATA Qi is a modular AI operating system with a vector search engine.', { title: 'About JATA Qi' });
      await memory.record({ category: 'search', summary: 'user searched for vector search', userId: 'u1', orgId: 'org1' });
      const doc = await knowledge.ingestText('Alice Smith is the CEO of Acme Corporation based in Paris.', { title: 'Acme' });
      for (const cid of doc.chunkIds) {
        const c = await knowledge.getChunk(cid);
        if (c) {
          const r = graph.extractFromText(c.text, { chunkId: cid, documentId: doc.id });
          for (const t of r.triples) graph.linkMention(cid, t.object, 0.7, doc.id);
        }
      }

      // Memory is tenant-scoped: pass orgId so the memory adapter can see it.
      const result = await search.search('vector search', { orgId: 'org1' });
      assert.ok(result.hits.length >= 2, `expected >=2 hits, got ${result.hits.length}`);
      assert.ok(result.hits.some((h) => h.source === 'knowledge'));
      assert.ok(result.hits.some((h) => h.source === 'memory'));
      assert.ok((result.facets.source.knowledge ?? 0) >= 1);
      assert.ok((result.facets.source.memory ?? 0) >= 1);

      // Personalized: u1 has a learned boost for "vector search" terms.
      const personalized = await search.search('vector search', { userId: 'u1', orgId: 'org1', minScore: 0 });
      const memoryHit = personalized.hits.find((h) => h.source === 'memory');
      assert.ok(memoryHit, 'memory hit should survive with personalization');
      assert.ok(memoryHit!.score > 0, 'memory hit should be boosted');

      // Recorded history lands in memory.
      await search.recordSearch('u1', 'vector search', 'org1');
      const history = search.recentSearches('u1', 'org1');
      assert.ok(history.length >= 1);
      assert.ok(history.some((h) => h.query === 'vector search'));
    } finally {
      await kernel.shutdown();
    }
  });

  it('searches conversations for a specific user', async () => {
    const kernel = await bootFull();
    try {
      const conversations = kernel.getModule<ConversationsModule>('conversations');
      const search = kernel.getModule<SearchModule>('search');
      const conv = await conversations.create('u1', { title: 'KRT roadmap discussion' });
      await conversations.addMessage(conv.id, 'user', 'We should launch the KRT token this quarter.');

      const result = await search.search('KRT token', { userId: 'u1' });
      assert.ok(result.hits.some((h) => h.source === 'conversations' && h.id === conv.id));
    } finally {
      await kernel.shutdown();
    }
  });

  it('suggests across sources', async () => {
    const kernel = await bootFull();
    try {
      const search = kernel.getModule<SearchModule>('search');
      await kernel.getModule<KnowledgeService>('knowledge').ingestText('Quantum Intelligence Kernel documentation.', { title: 'Quantum Intelligence Kernel' });
      const suggestions = await search.suggest('quantum');
      assert.ok(suggestions.some((s) => s.text.toLowerCase().includes('quantum')));
    } finally {
      await kernel.shutdown();
    }
  });

  it('reports stats', async () => {
    const kernel = await bootFull();
    try {
      const search = kernel.getModule<SearchModule>('search');
      await search.search('anything');
      const stats = search.stats();
      assert.equal(stats.adapters.length, 5);
      assert.ok(stats.searches >= 1);
      assert.equal(stats.lastQuery, 'anything');
    } finally {
      await kernel.shutdown();
    }
  });
});
