// S-1 (Tenant Boundary Hardening) — adversarial tests for the vector layer.
//
// Contract under test: a tenant-bound vector search without an unambiguous
// tenant is REFUSED before any embedding or index work happens, and a
// tenant-scoped search can never return another tenant's vectors or an
// untagged/legacy vector. No default tenant exists at this layer, so no
// test-compat fallback flag is honoured here.
//
// No fallback flag is set anywhere in this suite.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Kernel } from '@jataqi/core-kernel';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule, TenantContextError, TENANT_CONTEXT_REQUIRED, VectorEvents } from '../src/index.js';

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const INDEX = 's1.vectors';

describe('S-1 vector-search tenant boundary (fail-closed, no unscoped search)', () => {
  let kernel: Kernel;
  let vectors: VectorSearchModule;

  beforeEach(async () => {
    assert.equal(process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK, undefined, 'no fallback flag in this suite');
    assert.equal(process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK, undefined, 'no fallback flag in this suite');
    kernel = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    await kernel.boot();
    vectors = kernel.getModule<VectorSearchModule>('vector-search');
    await vectors.embedAndAdd(INDEX, [
      { id: 'a1', text: 'Alpha Corp archives cobalt narwhal telemetry in Nairobi', metadata: { tenantId: TENANT_A } },
      { id: 'b1', text: 'Beta Ltd stores crimson otter ledgers in Mombasa', metadata: { tenantId: TENANT_B } },
      { id: 'untagged', text: 'legacy row with no tenant marker at all', metadata: {} },
    ]);
  });

  afterEach(async () => {
    await kernel.shutdown();
  });

  it('refuses an unscoped embedAndSearch BEFORE any data-plane work', async () => {
    const searched: string[] = [];
    const off = kernel.bus.on(VectorEvents.Searched, () => { searched.push('searched'); });
    let caught: unknown;
    try {
      await vectors.embedAndSearch(INDEX, 'crimson otter ledgers', { topK: 5 });
    } catch (error) {
      caught = error;
    }
    off();
    assert.ok(caught instanceof TenantContextError, `expected TenantContextError, got ${String(caught)}`);
    assert.equal((caught as TenantContextError).code, TENANT_CONTEXT_REQUIRED);
    assert.match((caught as Error).message, /Failing closed/);
    assert.equal((caught as TenantContextError).operation, 'VectorSearchModule.embedAndSearch');
    assert.deepEqual(searched, [], 'no search event: the refusal happens before embedding/searching');
  });

  it('refuses a blank or whitespace-only tenant (ambiguity is denial)', async () => {
    for (const tenantId of ['', '   ', '\t']) {
      await assert.rejects(
        () => vectors.embedAndSearch(INDEX, 'cobalt narwhal', { tenantId, topK: 5 }),
        /Failing closed/,
        `tenant "${tenantId}" must be refused`,
      );
    }
  });

  it('refuses an unscoped raw-vector search too (both module search paths)', async () => {
    const q = await vectors.getModel().embed('cobalt narwhal telemetry');
    await assert.rejects(() => vectors.search(INDEX, q, { topK: 5 }), /Failing closed/);
    await assert.rejects(() => vectors.search(INDEX, q), /Failing closed/);
  });

  it('never returns another tenant\'s vectors, and never returns untagged vectors', async () => {
    const hitsA = await vectors.embedAndSearch(INDEX, 'crimson otter ledgers Mombasa', { tenantId: TENANT_A, topK: 10 });
    assert.ok(hitsA.every((h) => h.metadata?.tenantId === TENANT_A), 'A sees only A-tagged vectors');
    assert.equal(hitsA.some((h) => h.id === 'b1'), false, 'A must not retrieve B vector even with B text as the query');
    assert.equal(hitsA.some((h) => h.id === 'untagged'), false, 'untagged vectors are never returned');

    const hitsB = await vectors.embedAndSearch(INDEX, 'cobalt narwhal telemetry Nairobi', { tenantId: TENANT_B, topK: 10 });
    assert.ok(hitsB.every((h) => h.metadata?.tenantId === TENANT_B), 'B sees only B-tagged vectors');
    assert.equal(hitsB.some((h) => h.id === 'a1'), false, 'B must not retrieve A vector even with A text as the query');

    const ownA = await vectors.embedAndSearch(INDEX, 'cobalt narwhal telemetry', { tenantId: TENANT_A, topK: 10 });
    assert.ok(ownA.some((h) => h.id === 'a1'), 'positive control: A retrieves its own vector');
  });

  it('a caller filter cannot widen the tenant scope', async () => {
    const hits = await vectors.embedAndSearch(INDEX, 'crimson otter ledgers', {
      tenantId: TENANT_A,
      topK: 10,
      // A filter that would accept everything: the tenant gate still applies.
      filter: () => true,
    });
    assert.ok(hits.every((h) => h.metadata?.tenantId === TENANT_A));
    assert.equal(hits.some((h) => h.id === 'b1'), false);
  });

  it('documents the residual: the raw FlatIndex primitive is tenant-agnostic, so every product path must go through the module', async () => {
    // The module boundary is where tenant enforcement lives. `index()` returns
    // the low-level primitive used for writes/removals by tenant-resolved
    // callers; searching it directly bypasses scoping, which is why no product
    // code path may use it for retrieval (verified by the S-1 CLI/service
    // traces). Pinned here so a future change cannot silently rely on it.
    const idx = await vectors.index(INDEX);
    const q = await vectors.getModel().embed('crimson otter ledgers');
    const raw = await idx.search(q, { topK: 10 });
    assert.ok(raw.length >= 2, 'the primitive itself does not scope (documented residual)');
    const scoped = await vectors.embedAndSearch(INDEX, 'crimson otter ledgers', { tenantId: TENANT_A, topK: 10 });
    assert.ok(scoped.length < raw.length, 'the module boundary is what narrows the result to one tenant');
  });
});
