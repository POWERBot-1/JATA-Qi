// T-06 multi-process knowledge worker (real PostgreSQL).
//
// Modes (env WORKER_MODE):
//   ingest — boot a full knowledge kernel for `TENANT`, ingest the shared
//            `TEXT`, add IDENTICAL graph entity/triple ids to the ones every
//            other tenant adds (names differ per tenant), link the new
//            document's first chunk to the shared entity, run tenant-scoped
//            retrieval sanity checks, then SHUT DOWN the kernel so the
//            graph snapshot is persisted (the process's full lifecycle).
//            Writes OUT { tenant, docId, chunkIds }.
//   probe  — boot a full knowledge kernel (loading whatever the database
//            already holds), run tenant-scoped retrieval + graph-RAG against
//            the shared TEXT, and verify isolation internally: every hit must
//            belong to `TENANT`, `EXPECT_OWN_DOC` must be present and
//            `EXPECT_FOREIGN_DOC` must never appear. Writes OUT with the
//            observed hit/entity ids. Exits WITHOUT kernel shutdown (read-only
//            observer: it must not rewrite the persisted graph snapshot).
//
// PostgreSQL is a hard requirement; the parent test boots it.

import { writeFileSync } from 'node:fs';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';

const cs = process.env.JATAQI_TEST_PG_CS;
if (!cs) {
  console.error('JATAQI_TEST_PG_CS is required');
  process.exit(2);
}
const mode = process.env.WORKER_MODE ?? 'ingest';
const tenant = process.env.TENANT;
const outFile = process.env.OUT;
if (!tenant || !outFile) {
  console.error('TENANT and OUT are required');
  process.exit(2);
}
const TEXT = process.env.TEXT ?? 'shared quantum telemetry campaign knowledge baseline document';

async function boot() {
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 6 });
  const kernel = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: true }));
  await kernel.boot();
  const knowledge = kernel.getModule('knowledge');
  const graph = kernel.getModule('knowledge-graph');
  const vectors = kernel.getModule('vector-search');
  return { kernel, driver, knowledge, graph, vectors };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (mode === 'ingest') {
    const { kernel, driver, knowledge: svc, graph, vectors } = await boot();
    const doc = await svc.ingestText(TEXT, { tenantId: tenant, title: `shared-doc-${tenant}`, metadata: { worker: tenant } });
    await settle(250); // let DocumentIngested graph propagation settle inside this kernel
    // IDENTICAL ids across tenants on purpose: entity/triple ids do not encode
    // the tenant; only the per-tenant store / composite persisted key does.
    graph.addEntity({ id: 'shared-entity', type: 'Concept', name: `Shared-${tenant}` }, tenant);
    graph.addEntity({ id: 'shared-target', type: 'Concept', name: `Target-${tenant}` }, tenant);
    graph.addTriple({ subject: 'shared-entity', predicate: 'mentions', object: 'shared-target' }, tenant);
    const chunk0 = doc.chunkIds[0];
    if (chunk0) {
      graph.addEntity({ id: `chunk:${chunk0}`, type: 'Chunk', name: chunk0 }, tenant);
      graph.addTriple({ subject: `chunk:${chunk0}`, predicate: 'mentions', object: 'shared-entity' }, tenant);
    }
    // Tenant-scoped retrieval sanity: own doc visible, nothing foreign.
    const hits = await svc.retrieve(TEXT, { tenantId: tenant, topK: 10 });
    if (!hits.some((h) => h.document.id === doc.id)) throw new Error(`${tenant}: own document missing from its own retrieval`);
    if (!hits.every((h) => h.document.tenantId === tenant)) throw new Error(`${tenant}: retrieval returned a foreign document`);
    const vec = await vectors.embedAndSearch('knowledge.chunks', TEXT, { tenantId: tenant, topK: 10 });
    if (!vec.every((h) => h.metadata?.tenantId === tenant)) throw new Error(`${tenant}: vector search returned a foreign vector`);
    if (outFile) writeFileSync(outFile, JSON.stringify({ tenant, docId: doc.id, chunkIds: doc.chunkIds }));
    // Full lifecycle: shutdown persists this process's graph snapshot.
    await kernel.shutdown().catch(() => undefined);
    await driver.close().catch(() => undefined);
    process.exit(0);
  }

  if (mode === 'probe') {
    const ownDoc = process.env.EXPECT_OWN_DOC;
    const foreignDoc = process.env.EXPECT_FOREIGN_DOC;
    const { knowledge: svc, graph, vectors } = await boot();
    await settle(150);
    const report = { tenant, hits: [], ragHits: [], vecTenants: [] };
    const hits = await svc.retrieve(TEXT, { tenantId: tenant, topK: 10 });
    for (const h of hits) report.hits.push({ documentId: h.document.id, documentTenant: h.document.tenantId });
    const vec = await vectors.embedAndSearch('knowledge.chunks', TEXT, { tenantId: tenant, topK: 20 });
    for (const v of vec) report.vecTenants.push(v.metadata?.tenantId);
    if (!vec.every((v) => v.metadata?.tenantId === tenant)) throw new Error(`${tenant}: vector search returned a foreign vector while probing`);
    if (ownDoc && !hits.some((h) => h.document.id === ownDoc)) throw new Error(`${tenant}: own document ${ownDoc} missing while probing`);
    if (foreignDoc && hits.some((h) => h.document.id === foreignDoc)) throw new Error(`${tenant}: FOREIGN document ${foreignDoc} visible — contamination`);
    if (!hits.every((h) => h.document.tenantId === tenant)) throw new Error(`${tenant}: hit of another tenant while probing`);
    // Graph-RAG probe: every hit and every attached entity must stay in-tenant.
    const ragHits = await graph.graphRetrieve(TEXT, { tenantId: tenant, topK: 10, graphDepth: 1 });
    for (const h of ragHits) {
      report.ragHits.push({
        documentId: h.document.id,
        documentTenant: h.document.tenantId,
        entityIds: h.entities.map((e) => e.id),
        entityNames: h.entities.map((e) => e.name),
      });
      if (h.document.tenantId !== tenant) throw new Error(`${tenant}: graph-RAG hit of another tenant`);
      for (const e of h.entities) {
        const local = graph.getEntity(e.id, tenant);
        if (!local) throw new Error(`${tenant}: graph-RAG attached a foreign entity ${e.id}`);
        if (e.name !== local.name) throw new Error(`${tenant}: graph-RAG entity identity mismatch for ${e.id}`);
      }
    }
    if (outFile) writeFileSync(outFile, JSON.stringify(report));
    process.exit(0); // read-only observer: deliberately no kernel shutdown
  }

  console.error(`unknown WORKER_MODE ${mode}`);
  process.exit(2);
} catch (error) {
  console.error(`worker failed: ${String(error && error.message ? error.message : error)}`);
  process.exit(1);
}
