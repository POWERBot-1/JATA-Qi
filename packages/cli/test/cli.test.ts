import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJataQi } from '../src/bootstrap.js';
import { AgentRuntimeModule } from '@jataqi/agent-runtime';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';

describe('createJataQi bootstrap', () => {
  it('boots the full stack and exposes all modules', async () => {
    const qi = await createJataQi();
    assert.equal(qi.kernel.isBooted(), true);
    assert.ok(qi.kernel.getModule<AgentRuntimeModule>('agent-runtime'));
    assert.ok(qi.kernel.getModule<KnowledgeService>('knowledge'));
    assert.ok(qi.kernel.getModule<KnowledgeGraphModule>('knowledge-graph'));
    await qi.shutdown();
    assert.equal(qi.kernel.isBooted(), false);
  });

  it('runs a simple question against the default agent', async () => {
    const qi = await createJataQi();
    const agents = qi.kernel.getModule<AgentRuntimeModule>('agent-runtime');
    const res = await agents.run('hello world');
    assert.ok(res.answer.includes('hello world'));
    assert.equal(res.finishedReason, 'answer');
    await qi.shutdown();
  });

  it('ingests text, extracts entities, and retrieves', async () => {
    const qi = await createJataQi();
    const ks = qi.kernel.getModule<KnowledgeService>('knowledge');
    const g = qi.kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    const doc = await ks.ingestText('Alice founded Acme Corp. Bob works at Acme Corp.', { chunkSize: 500 });
    for (const cid of doc.chunkIds) {
      const c = await ks.getChunk(cid);
      if (c) {
        const r = g.extractFromText(c.text, { chunkId: cid, documentId: doc.id });
        for (const t of r.triples) g.linkMention(cid, t.object, 0.7, doc.id);
      }
    }
    const stats = g.stats();
    assert.ok(stats.entities >= 2, `expected entities, got ${stats.entities}`);
    assert.ok(stats.triples >= 1, `expected triples, got ${stats.triples}`);
    await qi.shutdown();
  });
});
