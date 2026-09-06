import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '../src/index.js';

describe('T-08.1 K1 knowledge fallback fail-closed', () => {
  it('throws when tenantId missing and no explicit allow flag (production semantics)', async () => {
    const prevAllow = process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    const prevTestOnly = process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    const prevNodeEnv = process.env.NODE_ENV;
    delete process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    delete process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    process.env.NODE_ENV = 'production';
    const kernel = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    await kernel.boot();
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    // capture warn
    let warned = false;
    const origWarn = kernel.logger.warn as any;
    (kernel.logger as any).warn = (msg: string, meta: any) => {
      if (String(msg).includes('falling back')) warned = true;
      return origWarn?.call(kernel.logger, msg, meta);
    };
    await assert.rejects(() => svc.ingestText('hello world'), /Provide opts\.tenantId.*Failing closed/);
    assert.equal(warned, true, 'must warn via observability even when failing closed');
    await kernel.shutdown();
    if (prevAllow !== undefined) process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK = prevAllow; else delete process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    if (prevTestOnly !== undefined) process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK = prevTestOnly; else delete process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv; else delete process.env.NODE_ENV;
  });

  it('allows fallback only with explicit JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK=1 even when NODE_ENV !== production', async () => {
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
    await k1.boot();
    const svc1 = k1.getModule<KnowledgeService>('knowledge');
    await assert.rejects(() => svc1.ingestText('hello'), /Failing closed/);
    await k1.shutdown();

    process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK = '1';
    const k2 = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    k2.register(new StorageModule());
    k2.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    k2.register(new KnowledgeService());
    await k2.boot();
    const svc2 = k2.getModule<KnowledgeService>('knowledge');
    const doc = await svc2.ingestText('hello with explicit allow', { title: 'explicit' });
    assert.ok(doc.tenantId === 'default-tenant' || doc.tenantId);
    await k2.shutdown();

    if (prevAllow !== undefined) process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK = prevAllow; else delete process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    if (prevTestOnly !== undefined) process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK = prevTestOnly; else delete process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv; else delete process.env.NODE_ENV;
  });

  it('NODE_ENV=test without explicit flag does not authorize fallback', async () => {
    const prevAllow = process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    const prevTestOnly = process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    const prevNodeEnv = process.env.NODE_ENV;
    delete process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    delete process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    process.env.NODE_ENV = 'test';
    const kernel = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    await kernel.boot();
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    await assert.rejects(() => svc.ingestText('hello'), /Failing closed/);
    await kernel.shutdown();
    if (prevAllow !== undefined) process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK = prevAllow; else delete process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK;
    if (prevTestOnly !== undefined) process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK = prevTestOnly; else delete process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK;
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv; else delete process.env.NODE_ENV;
  });
});
