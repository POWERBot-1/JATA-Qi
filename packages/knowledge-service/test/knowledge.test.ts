import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import type { Kernel } from '@jataqi/core-kernel';
import { chunkText, KnowledgeService, KnowledgeEvents } from '../src/index.js';

function bootKernel() {
  const k = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
  k.register(new StorageModule());
  k.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  k.register(new KnowledgeService());
  return k;
}

describe('chunker', () => {
  it('splits text into multiple chunks when content exceeds chunkSize', () => {
    const text = 'Word. '.repeat(200); // ~1200 chars
    const chunks = chunkText(text, 'doc1', { chunkSize: 200, chunkOverlap: 0 });
    assert.ok(chunks.length >= 4, `expected >=4 chunks, got ${chunks.length}`);
    assert.equal(chunks[0]!.index, 0);
    assert.equal(chunks[0]!.documentId, 'doc1');
    // All offsets must be monotonically increasing and cover the text.
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i]!.startChar >= chunks[i-1]!.startChar);
    }
  });

  it('respects chunkSize by packing paragraphs', () => {
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i} with some text.`);
    const text = paras.join('\n\n');
    const chunks = chunkText(text, 'd', { chunkSize: 80, chunkOverlap: 0 });
    for (const c of chunks) {
      assert.ok(c.text.length <= 80 + 50, `chunk too long: ${c.text.length}`);
    }
    // Ensure monotonic offsets
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i]!.startChar >= chunks[i - 1]!.startChar);
    }
  });

  it('applies overlap between adjacent chunks on text with word boundaries', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(words, 'd', { chunkSize: 100, chunkOverlap: 25 });
    assert.ok(chunks.length >= 2, `expected >=2 chunks, got ${chunks.length}`);
    // Later chunks should begin before previous ends (overlap carry-over).
    let foundOverlap = false;
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i]!.startChar < chunks[i - 1]!.endChar) { foundOverlap = true; break; }
    }
    assert.ok(foundOverlap, 'expected at least one overlapping chunk boundary');
  });

  it('handles sentence splitting', () => {
    const text = 'Hello world. How are you today? I am doing quite fine! Thanks a lot for asking.';
    const chunks = chunkText(text, 'd', { strategy: 'sentence', chunkSize: 20 });
    assert.ok(chunks.length >= 2, `expected >=2 chunks, got ${chunks.length}`);
  });

  it('returns empty array for empty text', () => {
    assert.equal(chunkText('', 'd').length, 0);
    assert.equal(chunkText('   ', 'd').length, 0);
  });

  it('sets token estimates and character offsets accurately', () => {
    const text = 'Hello world.\n\nThis is a test.';
    const chunks = chunkText(text, 'd', { chunkSize: 100, chunkOverlap: 0 });
    assert.ok(chunks.length >= 1);
    for (const c of chunks) {
      assert.ok(c.tokenEstimate >= 1);
      // Offset should point back into the text.
      const slice = text.slice(c.startChar, c.endChar).trim();
      assert.equal(c.text, slice);
    }
  });

  it('rejects invalid options', () => {
    assert.throws(() => chunkText('hi', 'd', { chunkSize: 0 }));
    // Overlap >= size is auto-clamped, not thrown; verify it produces valid output.
    const chunks = chunkText('hello world this is some text', 'd', { chunkSize: 5, chunkOverlap: 10 });
    assert.ok(chunks.length >= 1);
  });
});

describe('KnowledgeService', () => {
  let kernel: Kernel;
  beforeEach(async () => { kernel = bootKernel(); await kernel.boot(); });
  afterEach(async () => {
    try { await kernel.shutdown(); } catch { /* ignore */ }
  });

  it('ingests text, splits into chunks, persists documents and vectors', async () => {
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    const text = [
      'Cats are small carnivorous mammals. They are often kept as beloved house pets throughout the world.',
      'Dogs are domesticated descendants of wolves. They are loyal companions and often work alongside humans.',
      'The mitochondrion is the powerhouse of the cell and produces ATP through cellular respiration.',
      'Photosynthesis converts sunlight into chemical energy in plants using chlorophyll in their leaves.',
    ].join('\n\n');
    const events: any[] = [];
    kernel.bus.on(KnowledgeEvents.DocumentIngested, (p) => { events.push(p); });
    kernel.bus.on(KnowledgeEvents.ChunksCreated, (p) => { events.push(p); });
    const doc = await svc.ingestText(text, { title: 'Science bits', metadata: { source: 'test' }, chunkSize: 120 });
    assert.ok(doc.id);
    assert.equal(doc.title, 'Science bits');
    assert.deepEqual(doc.metadata, { source: 'test' });
    assert.ok(doc.chunkIds.length >= 3, `expected >=3 chunks, got ${doc.chunkIds.length}`);
    assert.ok(events.some((e) => e.chunks === doc.chunkIds.length));

    const stats = await svc.stats();
    assert.equal(stats.documents, 1);
    assert.equal(stats.chunks, doc.chunkIds.length);

    // Each chunk retrievable.
    for (const cid of doc.chunkIds) {
      const c = await svc.getChunk(cid);
      assert.ok(c);
      assert.equal(c!.documentId, doc.id);
    }
    const fetched = await svc.getDocument(doc.id);
    assert.ok(fetched);
    assert.equal(fetched!.id, doc.id);
  });

  it('retrieves semantically relevant chunks via vector search', async () => {
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    await svc.ingestText('Cats are beloved household pets that purr and meow.');
    await svc.ingestText('Dogs are loyal canines often called best friends.');
    await svc.ingestText('Quantum mechanics describes physics at atomic scales.');
    await svc.ingestText('The Eiffel Tower stands in Paris, France.');
    const hits = await svc.retrieve('Which animals make good pets?', { topK: 3 });
    assert.ok(hits.length >= 1);
    // Top result should be about cats or dogs (not Paris or quantum).
    const topText = hits[0]!.chunk.text.toLowerCase();
    assert.ok(
      topText.includes('cat') || topText.includes('dog') || topText.includes('pet'),
      `expected pet-related top hit, got: ${topText}`,
    );
  });

  it('applies metadata filters during retrieval', async () => {
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    await svc.ingestText('Alpha beta gamma', { metadata: { topic: 'greek' } });
    await svc.ingestText('Alpha beta gamma', { metadata: { topic: 'other' } });
    const hits = await svc.retrieve('alpha', { topK: 5, filter: { topic: 'greek' } });
    assert.ok(hits.every((h) => h.document.metadata?.topic === 'greek'));
  });

  it('expands context around the matched chunk', async () => {
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    const paragraphs = [
      'The first paragraph is about astronomy, discussing distant galaxies and nebulae.',
      'The second paragraph is about household pets, specifically cats that purr and meow.',
      'The third paragraph continues with pets: dogs that are loyal and love their owners.',
      'The fourth paragraph shifts to cooking recipes from around the Mediterranean.',
    ];
    const doc = await svc.ingestText(paragraphs.join('\n\n'), { chunkSize: 80 });
    const hits = await svc.retrieve('cats and dogs as pets', { topK: 1, expandContext: true, contextWindow: 1 });
    assert.ok(hits.length >= 1);
    const fromDoc = hits.filter((h) => h.document.id === doc.id);
    assert.ok(fromDoc.length >= 2, `expected context expansion to add neighbor chunks, got ${fromDoc.length}`);
  });

  it('deletes documents, chunks, and vectors', async () => {
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    const doc = await svc.ingestText('Some disposable content.');
    assert.equal((await svc.stats()).documents, 1);
    const deleted = await svc.deleteDocument(doc.id);
    assert.equal(deleted, true);
    assert.equal((await svc.stats()).documents, 0);
    assert.equal((await svc.stats()).chunks, 0);
    assert.equal(await svc.getDocument(doc.id), undefined);
    assert.equal(await svc.deleteDocument(doc.id), false);
  });

  it('rejects empty text ingestion', async () => {
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    await assert.rejects(() => svc.ingestText(''), /empty/);
  });

  it('returns an id generator producing UUIDs', async () => {
    const { newId } = await import('../src/index.js');
    const a = newId();
    const b = newId();
    assert.ok(/^[0-9a-f-]{36}$/.test(a));
    assert.notEqual(a, b);
  });
});
