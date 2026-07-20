import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HeuristicExtractor } from '../src/index.js';

describe('HeuristicExtractor', () => {
  it('extracts capitalized entities from text', () => {
    const x = new HeuristicExtractor();
    const r = x.extract('Alice and Bob attended a conference.');
    const names = r.entities.map((e) => e.name);
    assert.ok(names.includes('Alice'), `expected Alice in ${names.join(',')}`);
    assert.ok(names.includes('Bob'), `expected Bob in ${names.join(',')}`);
  });

  it('detects verb relations like founded/works_at', () => {
    const x = new HeuristicExtractor();
    const r = x.extract('Steve founded Apple in California. Bob works at Google.');
    const predicates = r.triples.map((t) => t.predicate);
    assert.ok(
      predicates.some((p) => p === 'founded' || p === 'relatedTo'),
      `expected a verb relation, got ${predicates.join(',')}`,
    );
  });

  it('attaches source provenance when provided', () => {
    const x = new HeuristicExtractor();
    const r = x.extract('Alice knows Bob.', { source: { chunkId: 'c1', documentId: 'd1' } });
    assert.ok(r.triples.length > 0);
    assert.ok(r.triples.some((t) => t.source?.chunkId === 'c1'));
  });

  it('classifies organization names by suffix', () => {
    const x = new HeuristicExtractor();
    const r = x.extract('Acme Corp released a new product.');
    const acme = r.entities.find((e) => e.name.includes('Acme'));
    assert.ok(acme, 'expected Acme entity');
  });
});
