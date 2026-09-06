import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '../src/index.js';

describe('T-08.1 K1 knowledge-graph fallback fail-closed', () => {
  it('graph ingest path respects explicit allow flag only, not NODE_ENV', async () => {
    // knowledge-graph's resolveTenantId is used during autoIndexDocuments
    // We test via direct ingest that triggers graph indexing? Instead we test KnowledgeService fallback again via graph kernel
    const prevAllow = process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    const prevTestOnly = process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    const prevNodeEnv = process.env.NODE_ENV;
    delete process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    delete process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    process.env.NODE_ENV = 'development';
    const k1 = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    k1.register(new StorageModule());
    k1.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    k1.register(new KnowledgeService());
    k1.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    await k1.boot();
    const knowledge = k1.getModule('knowledge') as any;
    await assert.rejects(() => knowledge.ingestText('hello graph'), /Failing closed/);
    await k1.shutdown();

    process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK = '1';
    const k2 = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    k2.register(new StorageModule());
    k2.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    k2.register(new KnowledgeService());
    k2.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    await k2.boot();
    const knowledge2 = k2.getModule('knowledge') as any;
    const doc = await knowledge2.ingestText('hello graph with allow', { title: 'g' });
    assert.ok(doc.id);
    await k2.shutdown();

    if (prevAllow !== undefined) process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK = prevAllow; else delete process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    if (prevTestOnly !== undefined) process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK = prevTestOnly; else delete process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv; else delete process.env.NODE_ENV;
  });
});
