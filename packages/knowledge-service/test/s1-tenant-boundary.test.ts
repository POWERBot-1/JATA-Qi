// S-1 (Tenant Boundary Hardening) — B-1 adversarial tests at the authoritative
// knowledge-service boundary.
//
// Contract under test (every tenant-bound data-plane op):
//   tenant supplied          → operation scoped to exactly that tenant;
//   tenant missing/blank     → REFUSED (TenantContextError) with zero data-plane work;
//   cross-tenant identifier  → denied (read: undefined/empty; delete: false, no mutation);
//   untagged durable row     → never attributed to any tenant (incl. DEFAULT_TENANT_ID);
//   T-08.1/K1 test-compat    → the ISOLATED reserved default bucket only, never widened.
//
// The destructive path (`deleteDocument`) is exercised first: before S-1 a
// tenant-less call destroyed a foreign tenant's document.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel, Logger } from '@jataqi/core-kernel';
import { InMemorySink } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import {
  DEFAULT_TENANT_ID,
  KnowledgeEvents,
  KnowledgeService,
  TENANT_CONTEXT_REQUIRED,
  TenantContextError,
} from '../src/index.js';
import type { Chunk, Document } from '../src/index.js';

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const TEXT_A = 'Alpha Corp archives cobalt narwhal telemetry from a Nairobi data centre.';
const TEXT_B = 'Beta Ltd stores crimson otter ledgers in a Mombasa warehouse.';
const LEGACY_TEXT = 'Untagged legacy paragraph about a violet pangolin ledger.';

const OPS = ['ingestText', 'retrieve', 'getDocument', 'getChunk', 'deleteDocument', 'stats'] as const;

function bootKernel(): { kernel: Kernel; sink: InMemorySink } {
  const sink = new InMemorySink();
  const kernel = new Kernel({
    logger: new Logger({ level: 'warn', sink: sink.push.bind(sink) }),
    configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } },
  });
  kernel.register(new StorageModule());
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  return { kernel, sink };
}

describe('S-1 knowledge-service tenant boundary (B-1)', () => {
  let kernel: Kernel;
  let sink: InMemorySink;
  let svc: KnowledgeService;
  let storage: StorageModule;
  let docA: Document;
  let docB: Document;

  beforeEach(async () => {
    // No fallback flag anywhere in this suite: the guard must fail closed.
    assert.equal(process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK, undefined);
    assert.equal(process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK, undefined);
    ({ kernel, sink } = bootKernel());
    await kernel.boot();
    svc = kernel.getModule<KnowledgeService>('knowledge');
    storage = kernel.getModule<StorageModule>('storage');
    docA = await svc.ingestText(TEXT_A, { tenantId: TENANT_A, title: 'Alpha doc', chunkSize: 120 });
    docB = await svc.ingestText(TEXT_B, { tenantId: TENANT_B, title: 'Beta doc', chunkSize: 120 });
    sink.clear();
  });

  afterEach(async () => {
    try { await kernel.shutdown(); } catch { /* ignore */ }
  });

  it('refuses every tenant-bound operation when no tenant context is supplied', async () => {
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ['ingestText', () => svc.ingestText('no tenant ingest', { title: 'x' })],
      ['retrieve', () => svc.retrieve('cobalt narwhal telemetry', { topK: 5 })],
      ['getDocument', () => svc.getDocument(docA.id)],
      ['getChunk', () => svc.getChunk(docA.chunkIds[0]!)],
      ['deleteDocument', () => svc.deleteDocument(docB.id)],
      ['stats', () => svc.stats()],
    ];
    assert.equal(refusals.length, OPS.length, 'every tenant-bound op is covered');
    for (const [op, call] of refusals) {
      let caught: unknown;
      try { await call(); } catch (error) { caught = error; }
      assert.ok(caught instanceof TenantContextError, `${op}: expected TenantContextError, got ${String(caught)}`);
      assert.equal((caught as TenantContextError).code, TENANT_CONTEXT_REQUIRED, `${op}: error code`);
      assert.equal((caught as TenantContextError).operation, `KnowledgeService.${op}`, `${op}: operation label`);
      assert.match((caught as Error).message, /Failing closed/, `${op}: message states fail-closed`);
    }
    // Nothing was mutated or disclosed by any refused call.
    assert.deepEqual(await svc.stats({ tenantId: TENANT_A }), { documents: 1, chunks: docA.chunkIds.length });
    assert.deepEqual(await svc.stats({ tenantId: TENANT_B }), { documents: 1, chunks: docB.chunkIds.length });
    assert.ok(await svc.getDocument(docB.id, { tenantId: TENANT_B }), 'B document survived the refused delete');
  });

  it('refuses blank and whitespace-only tenants (ambiguity is denial, never a default)', async () => {
    for (const tenantId of ['', '   ', '\t\n']) {
      await assert.rejects(() => svc.retrieve('cobalt narwhal', { tenantId }), /Failing closed/, `retrieve ${JSON.stringify(tenantId)}`);
      await assert.rejects(() => svc.getDocument(docA.id, { tenantId }), /Failing closed/, `getDocument ${JSON.stringify(tenantId)}`);
      await assert.rejects(() => svc.getChunk(docA.chunkIds[0]!, { tenantId }), /Failing closed/, `getChunk ${JSON.stringify(tenantId)}`);
      assert.equal(await svc.deleteDocument(docB.id, { tenantId }).then(() => 'resolved', (e: unknown) => {
        assert.ok(e instanceof TenantContextError, 'delete must refuse, not resolve');
        return 'refused';
      }), 'refused', `deleteDocument ${JSON.stringify(tenantId)} must refuse`);
      await assert.rejects(() => svc.stats({ tenantId }), /Failing closed/, `stats ${JSON.stringify(tenantId)}`);
      await assert.rejects(() => svc.ingestText('blank tenant', { tenantId, title: 'x' }), /Failing closed/, `ingest ${JSON.stringify(tenantId)}`);
    }
    assert.ok(await svc.getDocument(docB.id, { tenantId: TENANT_B }), 'B document intact after blank-tenant delete attempts');
  });

  it('denies cross-tenant reads by identifier, including identical-content queries', async () => {
    assert.equal(await svc.getDocument(docB.id, { tenantId: TENANT_A }), undefined, 'A cannot read B document by id');
    assert.equal(await svc.getDocument(docA.id, { tenantId: TENANT_B }), undefined, 'B cannot read A document by id');
    assert.equal(await svc.getChunk(docB.chunkIds[0]!, { tenantId: TENANT_A }), undefined, 'A cannot read B chunk by id');
    assert.equal(await svc.getChunk(docA.chunkIds[0]!, { tenantId: TENANT_B }), undefined, 'B cannot read A chunk by id');

    // A query built from B's own text must still disclose nothing to A.
    const hits = await svc.retrieve('crimson otter ledgers Mombasa warehouse', { tenantId: TENANT_A, topK: 10 });
    assert.ok(hits.every((h) => h.document.tenantId === TENANT_A), 'A retrieval only carries A-owned documents');
    assert.equal(hits.some((h) => h.document.id === docB.id), false, 'B document never surfaced to A');
    assert.equal(hits.some((h) => h.chunk.text.includes('crimson otter')), false, 'B chunk text never surfaced to A');

    const ownA = await svc.retrieve('cobalt narwhal telemetry', { tenantId: TENANT_A, topK: 10 });
    assert.ok(ownA.some((h) => h.document.id === docA.id), 'positive control: A retrieves its own document');
  });

  it('denies a cross-tenant delete and mutates nothing (highest-severity B-1 case)', async () => {
    const deleted: string[] = [];
    const off = kernel.bus.on(KnowledgeEvents.DocumentDeleted, (p) => { deleted.push(String((p as { docId?: string }).docId)); });
    const result = await svc.deleteDocument(docB.id, { tenantId: TENANT_A });
    off();
    assert.equal(result, false, 'A must not be able to delete B document');
    assert.deepEqual(deleted, [], 'no DocumentDeleted event for the denied delete');
    // Victim fully intact: row, chunks, and vectors.
    const stillThere = await svc.getDocument(docB.id, { tenantId: TENANT_B });
    assert.ok(stillThere, 'B document row intact');
    assert.equal(stillThere!.chunkIds.length, docB.chunkIds.length, 'B chunk list intact');
    for (const chunkId of docB.chunkIds) {
      assert.ok(await svc.getChunk(chunkId, { tenantId: TENANT_B }), `B chunk ${chunkId} intact`);
    }
    const bHits = await svc.retrieve('crimson otter ledgers', { tenantId: TENANT_B, topK: 10 });
    assert.ok(bHits.some((h) => h.document.id === docB.id), 'B vectors intact — the denied delete removed nothing');
    // And the reverse direction is equally denied.
    assert.equal(await svc.deleteDocument(docA.id, { tenantId: TENANT_B }), false, 'B must not delete A document');
    assert.ok(await svc.getDocument(docA.id, { tenantId: TENANT_A }), 'A document intact');
  });

  it('still allows an own-tenant delete and leaves the other tenant untouched', async () => {
    const deleted: string[] = [];
    const off = kernel.bus.on(KnowledgeEvents.DocumentDeleted, (p) => { deleted.push(String((p as { docId?: string }).docId)); });
    assert.equal(await svc.deleteDocument(docA.id, { tenantId: TENANT_A }), true, 'owner may delete its own document');
    off();
    assert.deepEqual(deleted, [docA.id], 'exactly one delete event, for the owner tenant document');
    assert.equal(await svc.getDocument(docA.id, { tenantId: TENANT_A }), undefined, 'A document gone');
    assert.deepEqual(await svc.stats({ tenantId: TENANT_A }), { documents: 0, chunks: 0 }, 'A bucket emptied');
    assert.deepEqual(await svc.stats({ tenantId: TENANT_B }), { documents: 1, chunks: docB.chunkIds.length }, 'B untouched');
    const bHits = await svc.retrieve('crimson otter ledgers', { tenantId: TENANT_B, topK: 10 });
    assert.ok(bHits.some((h) => h.document.id === docB.id), 'B retrieval still works after A delete');
  });

  it('never attributes an untagged durable row to any tenant (B-3 at the service boundary)', async () => {
    const docs = await storage.namespace('knowledge.docs');
    const chunks = await storage.collection<Chunk>('knowledge.chunks');
    await docs.set('legacy-untagged-doc', {
      id: 'legacy-untagged-doc',
      title: 'Legacy untagged document',
      content: LEGACY_TEXT,
      chunkIds: ['legacy-untagged-chunk'],
      metadata: { source: 'legacy-migration' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Document);
    await chunks.put({
      id: 'legacy-untagged-chunk',
      documentId: 'legacy-untagged-doc',
      index: 0,
      text: LEGACY_TEXT,
      startChar: 0,
      endChar: LEGACY_TEXT.length,
      tokenEstimate: 12,
    } as Chunk);

    const baselineA = await svc.stats({ tenantId: TENANT_A });
    const baselineB = await svc.stats({ tenantId: TENANT_B });
    for (const tenantId of [TENANT_A, TENANT_B, DEFAULT_TENANT_ID]) {
      assert.equal(await svc.getDocument('legacy-untagged-doc', { tenantId }), undefined, `untagged doc invisible to ${tenantId}`);
      assert.equal(await svc.getChunk('legacy-untagged-chunk', { tenantId }), undefined, `untagged chunk invisible to ${tenantId}`);
      assert.equal(await svc.deleteDocument('legacy-untagged-doc', { tenantId }), false, `untagged doc not deletable as ${tenantId}`);
    }
    assert.deepEqual(await svc.stats({ tenantId: TENANT_A }), baselineA, 'untagged rows never counted for A');
    assert.deepEqual(await svc.stats({ tenantId: TENANT_B }), baselineB, 'untagged rows never counted for B');
    // The untagged row is still on disk (quarantined, not silently adopted) and
    // it never enters a tenant-scoped retrieval result.
    assert.ok(await docs.get('legacy-untagged-doc'), 'untagged row preserved on disk, not rewritten');
    assert.ok(await chunks.get('legacy-untagged-chunk'), 'untagged chunk preserved on disk, not rewritten');
    const hits = await svc.retrieve('violet pangolin ledger', { tenantId: TENANT_A, topK: 10 });
    assert.equal(hits.some((h) => h.chunk.text.includes('pangolin')), false, 'untagged content never retrieved');
    assert.deepEqual(await svc.stats({ tenantId: DEFAULT_TENANT_ID }), { documents: 0, chunks: 0 }, 'default bucket stays empty');
  });

  it('refusals are auditable through the kernel logger', async () => {
    sink.clear();
    await assert.rejects(() => svc.retrieve('cobalt narwhal', {}), /Failing closed/);
    const warnings = sink.ofLevel('warn').map((e) => e.msg).join('\n');
    assert.match(warnings, /tenant/i, 'a tenant refusal is logged as a warning');
  });

  describe('K1 compatibility preserved without widening (T-08.1 flags)', () => {
    const FLAG = 'JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK';

    it('the explicit flag yields the isolated default bucket only — never another tenant data', async () => {
      const previous = process.env[FLAG];
      process.env[FLAG] = '1';
      try {
        // Tenant-less ingest lands in the reserved default bucket…
        const legacy = await svc.ingestText('Legacy violet pangolin note ingested without a tenant.', { title: 'legacy' });
        assert.equal(legacy.tenantId, DEFAULT_TENANT_ID, 'flagged tenant-less ingest is attributed to the isolated default bucket');
        // …tenant-less retrieval sees only that bucket, never A or B.
        const hits = await svc.retrieve('cobalt narwhal telemetry crimson otter ledgers violet pangolin', { topK: 20 });
        assert.ok(hits.length > 0, 'the default bucket is retrievable under the flag');
        assert.ok(hits.every((h) => h.document.tenantId === DEFAULT_TENANT_ID), 'no cross-tenant disclosure under the flag');
        assert.equal(hits.some((h) => h.document.id === docA.id), false);
        assert.equal(hits.some((h) => h.document.id === docB.id), false);
        // …tenant-less stats count only that bucket (the old global totals are gone).
        const s = await svc.stats();
        assert.deepEqual(s, { documents: 1, chunks: legacy.chunkIds.length }, 'stats under the flag are default-bucket-only');
        // …and a tenant-less delete cannot destroy A or B data (the B-1 widening proof).
        assert.equal(await svc.deleteDocument(docA.id), false, 'flagged tenant-less delete cannot touch A');
        assert.equal(await svc.deleteDocument(docB.id), false, 'flagged tenant-less delete cannot touch B');
        assert.ok(await svc.getDocument(docA.id, { tenantId: TENANT_A }), 'A intact');
        assert.ok(await svc.getDocument(docB.id, { tenantId: TENANT_B }), 'B intact');
        // It can delete within its own (default) bucket, which is the documented K1 behaviour.
        assert.equal(await svc.deleteDocument(legacy.id), true, 'default bucket owns its own rows');
      } finally {
        if (previous === undefined) delete process.env[FLAG];
        else process.env[FLAG] = previous;
      }
      assert.equal(process.env[FLAG], undefined, 'flag restored to unset after the test');
    });

    it('without the flag the same tenant-less calls are refused (flag is the only escape hatch)', async () => {
      assert.equal(process.env[FLAG], undefined);
      await assert.rejects(() => svc.ingestText('no flag, no tenant', { title: 'x' }), /Failing closed/);
      await assert.rejects(() => svc.stats(), /Failing closed/);
    });
  });
});
