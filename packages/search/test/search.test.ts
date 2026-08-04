// Phase 6 — Universal Search engine tests: federation, ranking (relevance +
// recency + personalization + source weights), facets, suggestions, filtering.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SearchEngine, tokenOverlap } from '../src/index.js';
import type { SearchAdapter, SearchHit, SearchOptions, SearchSuggestion, SearchSourceId } from '../src/index.js';

function hit(partial: Partial<SearchHit> & { source: SearchSourceId; id: string; title: string }): SearchHit {
  return {
    snippet: '', score: 0, relevance: 0.5, metadata: {}, ...partial,
  };
}

/** Deterministic mock adapter: returns fixed hits with fixed relevance. */
function mockAdapter(id: SearchSourceId, hits: SearchHit[]): SearchAdapter {
  return {
    id,
    async search(query: string, _opts: SearchOptions) {
      void query;
      return hits.map((h) => ({ ...h }));
    },
    async suggest(prefix: string, limit: number): Promise<SearchSuggestion[]> {
      return hits
        .filter((h) => h.title.toLowerCase().startsWith(prefix.toLowerCase()))
        .slice(0, limit)
        .map((h) => ({ text: h.title, source: id, score: h.relevance }));
    },
  };
}

describe('SearchEngine (Phase 6)', () => {
  it('federates across adapters and ranks by merged score', async () => {
    const engine = new SearchEngine([
      mockAdapter('knowledge', [
        hit({ source: 'knowledge', id: 'k1', title: 'Acme revenue doc', relevance: 0.9, metadata: { category: 'finance' } }),
      ]),
      mockAdapter('memory', [
        hit({ source: 'memory', id: 'm1', title: 'searched for Acme', relevance: 0.4, ts: Date.now() - 1000 }),
      ]),
      mockAdapter('graph', [
        hit({ source: 'graph', id: 'g1', title: 'Acme Corporation', relevance: 0.7 }),
      ]),
    ]);
    const result = await engine.search('acme');
    assert.equal(result.hits.length, 3);
    // knowledge (0.9 + recency 0) > graph (0.7) > memory (0.4 + recency ~0.1)
    assert.equal(result.hits[0]!.id, 'k1');
    assert.equal(result.hits[2]!.id, 'm1');
    assert.equal(result.facets.source.knowledge, 1);
    assert.equal(result.facets.source.memory, 1);
    assert.equal(result.facets.source.graph, 1);
  });

  it('applies source weights and minScore', async () => {
    const engine = new SearchEngine([
      mockAdapter('tools', [hit({ source: 'tools', id: 't1', title: 'search tool', relevance: 0.3 })]),
      mockAdapter('knowledge', [hit({ source: 'knowledge', id: 'k1', title: 'search doc', relevance: 0.3 })]),
    ]);
    const boosted = await engine.search('search', { boosts: { source: { tools: 2 } }, minScore: 0.5 });
    assert.equal(boosted.hits.length, 1);
    assert.equal(boosted.hits[0]!.id, 't1');
    assert.ok(boosted.hits[0]!.score > 0.5);
  });

  it('applies personalized boost terms for the querying user', async () => {
    const engine = new SearchEngine([
      mockAdapter('memory', [
        hit({ source: 'memory', id: 'm1', title: 'vector search session', relevance: 0.4 }),
        hit({ source: 'memory', id: 'm2', title: 'sales pipeline call', relevance: 0.5 }),
      ]),
    ]);
    const neutral = await engine.search('vector', { minScore: 0 });
    const personal = await engine.search('vector', {
      minScore: 0,
      boosts: { personalization: 0.2, personalizationTerms: ['vector'] },
    });
    assert.equal(neutral.hits[0]!.id, 'm2'); // raw relevance wins without boost
    assert.equal(personal.hits[0]!.id, 'm1'); // learned term pushes it up
    assert.ok(personal.hits[0]!.score > neutral.hits[0]!.score);
  });

  it('limits sources, topK, and builds category facets', async () => {
    const engine = new SearchEngine([
      mockAdapter('knowledge', [
        hit({ source: 'knowledge', id: 'k1', title: 'doc a', relevance: 0.9, metadata: { category: 'finance' } }),
        hit({ source: 'knowledge', id: 'k2', title: 'doc b', relevance: 0.8, metadata: { category: 'ops' } }),
      ]),
      mockAdapter('graph', [hit({ source: 'graph', id: 'g1', title: 'ent', relevance: 0.99 })]),
    ]);
    const result = await engine.search('x', { sources: ['knowledge'], topK: 1 });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.source, 'knowledge');
    const both = await engine.search('x', { topK: 10 });
    assert.equal(both.facets.category.finance, 1);
    assert.equal(both.facets.category.ops, 1);
  });

  it('suggests prefixes across adapters with dedup', async () => {
    const engine = new SearchEngine([
      mockAdapter('knowledge', [hit({ source: 'knowledge', id: 'k1', title: 'Acme Docs', relevance: 0.8 })]),
      mockAdapter('graph', [hit({ source: 'graph', id: 'g1', title: 'Acme Corp', relevance: 0.6 })]),
    ]);
    const suggestions = await engine.suggest('ac');
    assert.equal(suggestions.length, 2);
    assert.deepEqual(suggestions.map((s) => s.text), ['Acme Docs', 'Acme Corp']);
  });

  it('reports stats', async () => {
    const engine = new SearchEngine([mockAdapter('tools', [])]);
    await engine.search('hello');
    const stats = engine.stats();
    assert.equal(stats.adapters, 1);
    assert.equal(stats.searches, 1);
    assert.equal(stats.lastQuery, 'hello');
  });
});

describe('tokenOverlap', () => {
  it('scores shared tokens against the query length', () => {
    assert.equal(tokenOverlap(['acme', 'corp'], 'Acme Corporation'), 0.5);
    assert.equal(tokenOverlap(['acme'], 'nothing here'), 0);
  });
});
