// T-06 knowledge-stack tenant isolation over REAL PostgreSQL (Workstream A).
//
// Proves tenant isolation through the ACTUAL knowledge execution path
// (kernel -> knowledge-service -> vector-search -> knowledge-graph -> storage
// on PostgreSQL), never through mocked low-level calls:
//
//   1. Tenant A can ingest and retrieve its own document.
//   2. Tenant B can ingest and retrieve its own document.
//   3. Tenant A cannot retrieve Tenant B's document (fail-closed: every
//      result of a tenant-A retrieval belongs to tenant A).
//   4. Tenant B cannot retrieve Tenant A's document.
//   5. Chunks cannot cross tenant boundaries (getChunk/getDocument with a
//      foreign tenant resolve to nothing).
//   6. Vector search cannot return another tenant's vectors (the vector
//      layer itself enforces the tenant filter, not only callers).
//   7. Knowledge-graph traversal cannot expose another tenant's
//      entities/triples (per-tenant stores).
//   8. Graph persistence/load remains tenant-partitioned (one kernel holds
//      both tenants, persists one snapshot, a fresh kernel restores each
//      tenant's graph into its own partitioned store).
//   9. A single PostgreSQL database can safely contain both tenants.
//  10. The real kernel path carries tenant identity: ingest/retrieve/graph
//      calls are made through the composed kernel services, with the tenant
//      id resolved per call — and, in the second test, through TWO kernels
//      on one database (the real composition boundary).
//
// PostgreSQL is a HARD requirement: when it cannot start the suite FAILS
// loudly instead of skipping.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { redactPgDiagnostics, waitForPgReady, withPgReadiness } from '@jataqi/storage-postgres/test/pg-readiness';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '../src/index.js';

let pg: { server: EmbeddedPostgres; port: number; started: boolean } | undefined;
let dbCounter = 0;
let clusterDir: string;

/** O-3 lifecycle hygiene: remove the pid-named cluster dir on teardown
 * (`persistent: true` embedded-postgres never removes it). Best-effort. */
function removeClusterDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — never fail the suite over teardown.
  }
}

before(async () => {
  const port = 59200 + Math.floor(Math.random() * 700);
  clusterDir = path.join(os.tmpdir(), `jataqi-t06-kg-pg-${process.pid}`);
  const server = new EmbeddedPostgres({
    databaseDir: clusterDir,
    port,
    user: 'postgres',
    password: 'postgres',
    authMethod: 'password',
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ['--no-locale', '--encoding=UTF8'],
    postgresFlags: [],
    onLog: () => {},
    onError: (e) => {
      // G10: postmaster diagnostics are preserved (previously swallowed), redacted.
      console.warn('[t06-kg-pg] embedded postgres stderr:', redactPgDiagnostics(String((e as Error)?.message ?? e)));
    },
  });
  try {
    // G10: bounded readiness protection — see pg-readiness.ts. Bounded
    // transient-only retry; permanent failures still fail the suite (PG is a
    // hard requirement here — no silent skip).
    await withPgReadiness('t06-kg-pg/initialise', () => server.initialise());
    await withPgReadiness('t06-kg-pg/start', () => server.start());
    await waitForPgReady({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres', label: 't06-kg-pg' });
    pg = { server, port, started: true };
  } catch (error) {
    console.warn('[t06-kg-pg] PostgreSQL unavailable:', redactPgDiagnostics(String((error as Error)?.message ?? error)));
    pg = { server, port, started: false };
  }
});

after(async () => {
  if (pg?.started) await pg.server.stop().catch(() => undefined);
  pg = undefined;
  removeClusterDir(clusterDir);
});

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

async function freshDb(): Promise<{ database: string; config: { connectionString: string } }> {
  if (!pg?.started) throw new Error('PostgreSQL unavailable.');
  const database = `jata_test_${process.pid}_${dbCounter++}_${randomUUID().slice(0, 8)}`;
  await pg.server.createDatabase(database);
  return {
    database,
    config: { connectionString: `postgres://postgres:postgres@127.0.0.1:${pg.port}/${database}` },
  };
}

interface Booted {
  kernel: Kernel;
  driver: PostgresDriver;
  knowledge: KnowledgeService;
  graph: KnowledgeGraphModule;
  vectors: VectorSearchModule;
}

async function bootKernel(connectionString: string): Promise<Booted> {
  const driver = new PostgresDriver({ connectionString, requireExplicitConfig: true, max: 6 });
  const kernel = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: true }));
  await kernel.boot();
  const knowledge = kernel.getModule<KnowledgeService>('knowledge');
  const graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
  const vectors = kernel.getModule<VectorSearchModule>('vector-search');
  return { kernel, driver, knowledge, graph, vectors };
}

const settle = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const WORKER = new URL('./t06-knowledge-worker.mjs', import.meta.url).pathname;

/** Fork the knowledge worker and await its exit; rejects with stderr on failure. */
async function runWorker(cs: string, env: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = fork(WORKER, [], {
      env: { ...process.env, JATAQI_TEST_PG_CS: cs, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`knowledge worker ${env.WORKER_MODE}:${env.TENANT} timed out; stderr: ${stderr.slice(0, 800)}`));
    }, 120_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`knowledge worker ${env.WORKER_MODE}:${env.TENANT} exited ${code}; stderr: ${stderr.slice(0, 800)}`));
      else resolve();
    });
  });
}

interface WorkerReport { tenant?: string; docId?: string; chunkIds?: string[]; hits?: Array<{ documentId: string; documentTenant: string }>; ragHits?: Array<{ documentId: string; documentTenant: string; entityIds: string[]; entityNames: string[] }> }
function readReport(file: string): WorkerReport {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkerReport;
}

describe('T-06 knowledge cross-tenant isolation over real PostgreSQL', async () => {
  const requirePg = (): void => {
    if (!pg?.started) assert.fail('DATABASE INTEGRATION NOT EXECUTED — real PostgreSQL required for the knowledge isolation proof.');
  };

  it('one production kernel: ingest/retrieve isolation, vector + graph partition, persistence reload stays partitioned', async () => {
    requirePg();
    const db = await freshDb();
    const booted = await bootKernel(db.config.connectionString);
    const { knowledge: svc, graph, vectors } = booted;
    const TEXT_A = 'Acme rocket telemetry quantum fuel mixture telemetry for the alpha booster program';
    const TEXT_B = 'Globex retail marketing campaign analytics for the summer catalogue launch';
    try {
      // 1 + 2: both tenants ingest and retrieve their OWN documents.
      const docA = await svc.ingestText(TEXT_A, { tenantId: TENANT_A, title: 'acme-doc', metadata: { kind: 'a' } });
      const docB = await svc.ingestText(TEXT_B, { tenantId: TENANT_B, title: 'globex-doc', metadata: { kind: 'b' } });
      await settle(); // let DocumentIngested graph propagation settle

      const hitsA = await svc.retrieve(TEXT_A, { tenantId: TENANT_A, topK: 10 });
      assert.ok(hitsA.length > 0, 'tenant A retrieves its own content');
      assert.ok(hitsA.some((h) => h.document.id === docA.id), 'tenant A retrieval contains its own document');
      assert.ok(hitsA.every((h) => h.document.tenantId === TENANT_A), 'tenant A retrieval never surfaces a foreign document');

      const hitsB = await svc.retrieve(TEXT_B, { tenantId: TENANT_B, topK: 10 });
      assert.ok(hitsB.length > 0, 'tenant B retrieves its own content');
      assert.ok(hitsB.some((h) => h.document.id === docB.id), 'tenant B retrieval contains its own document');
      assert.ok(hitsB.every((h) => h.document.tenantId === TENANT_B), 'tenant B retrieval never surfaces a foreign document');

      // 3 + 4: cross-tenant retrieval fails closed (no foreign doc, no foreign chunk).
      const crossA = await svc.retrieve(TEXT_B, { tenantId: TENANT_A, topK: 10 });
      assert.ok(crossA.every((h) => h.document.tenantId === TENANT_A), 'tenant A cannot retrieve tenant B document');
      assert.ok(!crossA.some((h) => h.document.id === docB.id), 'tenant A results never include tenant B doc id');
      const crossB = await svc.retrieve(TEXT_A, { tenantId: TENANT_B, topK: 10 });
      assert.ok(crossB.every((h) => h.document.tenantId === TENANT_B), 'tenant B cannot retrieve tenant A document');
      assert.ok(!crossB.some((h) => h.document.id === docA.id), 'tenant B results never include tenant A doc id');

      // 5: chunks cannot cross tenant boundaries.
      const chunkA0 = docA.chunkIds[0]!;
      const chunkB0 = docB.chunkIds[0]!;
      assert.ok(await svc.getChunk(chunkA0, { tenantId: TENANT_A }), 'A sees its own chunk');
      assert.equal(await svc.getChunk(chunkA0, { tenantId: TENANT_B }), undefined, 'B cannot read A chunk');
      assert.equal(await svc.getChunk(chunkB0, { tenantId: TENANT_A }), undefined, 'A cannot read B chunk');
      assert.equal(await svc.getDocument(docA.id, { tenantId: TENANT_B }), undefined, 'B cannot read A document by id');
      assert.equal(await svc.getDocument(docB.id, { tenantId: TENANT_A }), undefined, 'A cannot read B document by id');

      // 6: vector search itself cannot return another tenant's vectors.
      const vecA = await vectors.embedAndSearch('knowledge.chunks', TEXT_B, { tenantId: TENANT_A, topK: 10 });
      assert.ok(vecA.every((h) => h.metadata?.tenantId === TENANT_A), 'vector search scoped to A only returns A vectors');
      const vecB = await vectors.embedAndSearch('knowledge.chunks', TEXT_A, { tenantId: TENANT_B, topK: 10 });
      assert.ok(vecB.every((h) => h.metadata?.tenantId === TENANT_B), 'vector search scoped to B only returns B vectors');
      // The single shared index holds BOTH tenants (single PG database, both tenants)…
      // S-1: there is no unscoped vector search any more — the tenantless call is
      // refused, so "the index holds both tenants" is proven by the union of the
      // two tenant-scoped searches plus the refusal itself.
      await assert.rejects(
        () => vectors.embedAndSearch('knowledge.chunks', TEXT_A, { topK: 100 }),
        /Failing closed/,
        'an unscoped vector search must be refused (S-1)',
      );
      const all = [...vecA, ...vecB];
      const seenTenants = new Set(all.map((h) => h.metadata?.tenantId as string));
      assert.ok(seenTenants.has(TENANT_A) && seenTenants.has(TENANT_B), 'single database contains both tenants vectors');

      // 7: graph propagation (DocumentIngested) landed in the RIGHT tenant store…
      assert.ok(graph.getEntity(`doc:${docA.id}`, TENANT_A), 'A doc entity exists in A store (auto-propagated)');
      assert.ok(graph.getEntity(`doc:${docB.id}`, TENANT_B), 'B doc entity exists in B store (auto-propagated)');
      assert.equal(graph.getEntity(`doc:${docA.id}`, TENANT_B), undefined, 'A doc entity invisible in B store');
      assert.equal(graph.getEntity(`doc:${docB.id}`, TENANT_A), undefined, 'B doc entity invisible in A store');

      // …and richer per-tenant graphs stay isolated during traversal.
      graph.addEntity({ id: 'ent:a1', type: 'Concept', name: 'Alpha Engine' }, TENANT_A);
      graph.addEntity({ id: 'ent:a2', type: 'Concept', name: 'Beta Nozzle' }, TENANT_A);
      graph.addTriple({ subject: 'ent:a1', predicate: 'drives', object: 'ent:a2' }, TENANT_A);
      graph.addEntity({ id: 'ent:b1', type: 'Concept', name: 'Summer Catalogue' }, TENANT_B);
      graph.addEntity({ id: 'ent:b2', type: 'Concept', name: 'Loyalty Program' }, TENANT_B);
      graph.addTriple({ subject: 'ent:b1', predicate: 'mentions', object: 'ent:b2' }, TENANT_B);
      const pathsA = graph.traverse('ent:a1', { maxDepth: 2 }, TENANT_A);
      assert.ok(pathsA.some((p) => p.entities.some((e) => e.id === 'ent:a2')), 'A traversal reaches A triples');
      assert.ok(pathsA.every((p) => p.entities.every((e) => graph.getEntity(e.id, TENANT_A))), 'A traversal only ever touches A entities');
      assert.equal(graph.traverse('ent:a1', { maxDepth: 2 }, TENANT_B).length, 0, 'A start entity has no edges in B store');
      assert.equal(graph.traverse('ent:b1', { maxDepth: 2 }, TENANT_A).length, 0, 'B start entity has no edges in A store');
      const entitiesA = graph.allEntities(TENANT_A).map((e) => e.id);
      const entitiesB = graph.allEntities(TENANT_B).map((e) => e.id);
      assert.ok(entitiesA.includes('ent:a1') && !entitiesA.includes('ent:b1'), 'A store holds only A entities');
      assert.ok(entitiesB.includes('ent:b1') && !entitiesB.includes('ent:a1'), 'B store holds only B entities');
      assert.ok(graph.stats(TENANT_A).entities >= 3 && graph.stats(TENANT_B).entities >= 3, 'both tenant graphs populated');

      // 9: the single database holds both tenants' rows (docs/chunks carry tenant).
      const sysColl = await booted.driver.openCollection<{ id: string; tenantId?: string }>('knowledge.chunks');
      const chunkTenants = new Set((await sysColl.all()).map((c) => c.tenantId));
      assert.ok(chunkTenants.has(TENANT_A) && chunkTenants.has(TENANT_B), 'chunk rows for both tenants live in one database');

      // 8: graceful shutdown persists one partitioned snapshot (this kernel owns
      // BOTH tenants — the production deployment shape).
      await booted.kernel.shutdown();
      await booted.driver.close().catch(() => undefined);

      // Restart: a FRESH kernel on the same database restores each tenant's
      // graph into its own store — isolation intact after persistence/load.
      const booted2 = await bootKernel(db.config.connectionString);
      try {
        await settle();
        assert.ok(booted2.graph.getEntity(`doc:${docA.id}`, TENANT_A), 'restart restores A doc entity under A');
        assert.ok(booted2.graph.getEntity(`doc:${docB.id}`, TENANT_B), 'restart restores B doc entity under B');
        assert.equal(booted2.graph.getEntity(`doc:${docA.id}`, TENANT_B), undefined, 'restart: A entity stays out of B store');
        assert.equal(booted2.graph.getEntity(`doc:${docB.id}`, TENANT_A), undefined, 'restart: B entity stays out of A store');
        assert.ok(booted2.graph.getEntity('ent:a1', TENANT_A) && !booted2.graph.getEntity('ent:a1', TENANT_B), 'restart restores A-only subgraph partitioned');
        assert.ok(booted2.graph.getEntity('ent:b1', TENANT_B) && !booted2.graph.getEntity('ent:b1', TENANT_A), 'restart restores B-only subgraph partitioned');
        const rA = await booted2.knowledge.retrieve(TEXT_A, { tenantId: TENANT_A, topK: 10 });
        assert.ok(rA.length > 0 && rA.every((h) => h.document.tenantId === TENANT_A), 'post-restart A retrieval works and is isolated');
        const rB = await booted2.knowledge.retrieve(TEXT_A, { tenantId: TENANT_B, topK: 10 });
        assert.ok(rB.every((h) => h.document.tenantId === TENANT_B), 'post-restart B retrieval still cannot see A');
      } finally {
        await booted2.kernel.shutdown().catch(() => undefined);
        await booted2.driver.close().catch(() => undefined);
        if (pg?.started) await pg.server.dropDatabase(db.database).catch(() => undefined);
      }
    } finally {
      // kernel1 already shut down in the happy path; guard against failure paths.
      await booted.kernel.shutdown().catch(() => undefined);
      await booted.driver.close().catch(() => undefined);
      if (pg?.started) await pg.server.dropDatabase(db.database).catch(() => undefined);
    }
  });

  it('two kernels on ONE database: isolation holds across the composition boundary', async () => {
    requirePg();
    const db = await freshDb();
    // Boot kernel-1 first (empty database), then kernel-2: two independent
    // compositions, two connection pools, one PostgreSQL database.
    const k1 = await bootKernel(db.config.connectionString);
    let k2: Booted | undefined;
    try {
      const docA = await k1.knowledge.ingestText('Acme orbital rendezvous procedure documents', { tenantId: TENANT_A, title: 'a-only' });
      await settle(60);

      k2 = await bootKernel(db.config.connectionString);
      const docB = await k2.knowledge.ingestText('Globex point of sale terminal firmware notes', { tenantId: TENANT_B, title: 'b-only' });
      await settle(120);

      // Each kernel sees its own tenant's knowledge through the real services…
      const aHits = await k1.knowledge.retrieve('Acme orbital rendezvous procedure', { tenantId: TENANT_A, topK: 10 });
      assert.ok(aHits.some((h) => h.document.id === docA.id), 'kernel-1 retrieves its own tenant doc');
      const bHits = await k2.knowledge.retrieve('Globex point of sale terminal', { tenantId: TENANT_B, topK: 10 });
      assert.ok(bHits.some((h) => h.document.id === docB.id), 'kernel-2 retrieves its own tenant doc');

      // …and cannot see the OTHER kernel's tenant, in either direction.
      const aSeesB = await k1.knowledge.retrieve('Globex point of sale terminal firmware', { tenantId: TENANT_A, topK: 10 });
      assert.ok(aSeesB.every((h) => h.document.tenantId === TENANT_A), 'kernel-1 tenant cannot retrieve kernel-2 tenant doc');
      const bSeesA = await k2.knowledge.retrieve('Acme orbital rendezvous procedure', { tenantId: TENANT_B, topK: 10 });
      assert.ok(bSeesA.every((h) => h.document.tenantId === TENANT_B), 'kernel-2 tenant cannot retrieve kernel-1 tenant doc');

      // Document/chunk reads across the composition boundary fail closed.
      assert.equal(await k1.knowledge.getDocument(docB.id, { tenantId: TENANT_A }), undefined);
      assert.equal(await k2.knowledge.getDocument(docA.id, { tenantId: TENANT_B }), undefined);
      assert.equal(await k1.knowledge.getChunk(docB.chunkIds[0]!, { tenantId: TENANT_A }), undefined);
      assert.equal(await k2.knowledge.getChunk(docA.chunkIds[0]!, { tenantId: TENANT_B }), undefined);

      // Graph boundaries across kernels: each kernel only ever resolves the
      // tenant it hosts; the DB-backed row-level reality still holds both.
      assert.ok(k1.graph.getEntity(`doc:${docA.id}`, TENANT_A), 'kernel-1 graph has its own doc entity');
      assert.equal(k1.graph.getEntity(`doc:${docB.id}`, TENANT_A), undefined, 'kernel-1 cannot see kernel-2 doc entity in A store');
      assert.ok(k2.graph.getEntity(`doc:${docB.id}`, TENANT_B), 'kernel-2 graph has its own doc entity');
      assert.equal(k2.graph.getEntity(`doc:${docA.id}`, TENANT_B), undefined, 'kernel-2 cannot see kernel-1 doc entity in B store');
    } finally {
      if (k2) {
        await k2.kernel.shutdown().catch(() => undefined);
        await k2.driver.close().catch(() => undefined);
      }
      await k1.kernel.shutdown().catch(() => undefined);
      await k1.driver.close().catch(() => undefined);
      if (pg?.started) await pg.server.dropDatabase(db.database).catch(() => undefined);
    }
  });

  it('identical content, identical entity/triple ids and Graph RAG stay tenant-isolated across persistence reload', async () => {
    requirePg();
    const db = await freshDb();
    const booted = await bootKernel(db.config.connectionString);
    const { kernel, driver, knowledge: svc, graph, vectors } = booted;
    // IDENTICAL text for both tenants — the strongest possible content
    // collision — and IDENTICAL graph entity/triple ids on purpose. Document
    // ids are kernel-generated UUIDs (the production path never accepts a
    // caller-supplied document id), so identical-content + identical-entity-id
    // is the maximal identical-identity scenario the public path can create.
    const TEXT = 'shared quantum telemetry campaign knowledge baseline document with distinctive vocabulary';
    try {
      const docA = await svc.ingestText(TEXT, { tenantId: TENANT_A, title: 'same-content-a', metadata: { origin: TENANT_A } });
      const docB = await svc.ingestText(TEXT, { tenantId: TENANT_B, title: 'same-content-b', metadata: { origin: TENANT_B } });
      await settle();
      assert.notEqual(docA.id, docB.id, 'identical content still yields distinct documents');

      // Identical entity/triple ids in BOTH tenant stores, with tenant-specific
      // names and one extra in-tenant neighbor so traversal has something to find.
      graph.addEntity({ id: 'shared-entity', type: 'Concept', name: 'Shared-A' }, TENANT_A);
      graph.addEntity({ id: 'shared-target', type: 'Concept', name: 'Target-A' }, TENANT_A);
      graph.addTriple({ subject: 'shared-entity', predicate: 'mentions', object: 'shared-target' }, TENANT_A);
      graph.addEntity({ id: 'neighbor-a', type: 'Concept', name: 'Neighbor-A' }, TENANT_A);
      graph.addTriple({ subject: 'shared-entity', predicate: 'relates', object: 'neighbor-a' }, TENANT_A);
      graph.addEntity({ id: 'shared-entity', type: 'Concept', name: 'Shared-B' }, TENANT_B);
      graph.addEntity({ id: 'shared-target', type: 'Concept', name: 'Target-B' }, TENANT_B);
      graph.addTriple({ subject: 'shared-entity', predicate: 'mentions', object: 'shared-target' }, TENANT_B);
      graph.addEntity({ id: 'neighbor-b', type: 'Concept', name: 'Neighbor-B' }, TENANT_B);
      graph.addTriple({ subject: 'shared-entity', predicate: 'relates', object: 'neighbor-b' }, TENANT_B);
      // Chunk->shared-entity mention edges (needed for Graph RAG expansion),
      // again with identical edge content per tenant.
      const chunkA0 = docA.chunkIds[0]!;
      const chunkB0 = docB.chunkIds[0]!;
      graph.addEntity({ id: `chunk:${chunkA0}`, type: 'Chunk', name: chunkA0 }, TENANT_A);
      graph.addEntity({ id: `chunk:${chunkB0}`, type: 'Chunk', name: chunkB0 }, TENANT_B);
      graph.addTriple({ subject: `chunk:${chunkA0}`, predicate: 'mentions', object: 'shared-entity' }, TENANT_A);
      graph.addTriple({ subject: `chunk:${chunkB0}`, predicate: 'mentions', object: 'shared-entity' }, TENANT_B);

      // Retrieval with identical content: each tenant gets ONLY its own doc.
      const hitsA = await svc.retrieve(TEXT, { tenantId: TENANT_A, topK: 10 });
      assert.ok(hitsA.some((h) => h.document.id === docA.id), 'A retrieves its own doc');
      assert.ok(hitsA.every((h) => h.document.tenantId === TENANT_A), 'A never sees B doc despite identical text');
      const hitsB = await svc.retrieve(TEXT, { tenantId: TENANT_B, topK: 10 });
      assert.ok(hitsB.some((h) => h.document.id === docB.id), 'B retrieves its own doc');
      assert.ok(hitsB.every((h) => h.document.tenantId === TENANT_B), 'B never sees A doc despite identical text');
      // Chunk/document id reads stay fail-closed across tenants.
      assert.equal(await svc.getChunk(chunkA0, { tenantId: TENANT_B }), undefined);
      assert.equal(await svc.getChunk(chunkB0, { tenantId: TENANT_A }), undefined);
      assert.equal(await svc.getDocument(docA.id, { tenantId: TENANT_B }), undefined);

      // Identical entity id resolves to the tenant's own instance only.
      const entA = graph.getEntity('shared-entity', TENANT_A);
      const entB = graph.getEntity('shared-entity', TENANT_B);
      assert.ok(entA && entB, 'both tenants have their own shared-entity instance');
      assert.equal(entA!.name, 'Shared-A');
      assert.equal(entB!.name, 'Shared-B');
      // Traversal from the identical id never crosses into the other store:
      // A's traversal reaches A's own neighbor and never B's, and vice versa.
      const travA = graph.traverse('shared-entity', { maxDepth: 2 }, TENANT_A);
      const travANames = new Set(travA.flatMap((p) => p.entities.map((e) => e.name)));
      assert.ok(travANames.has('Shared-A') && travANames.has('Neighbor-A'), 'A traversal reaches A instances');
      assert.ok(!travANames.has('Neighbor-B') && !travANames.has('Shared-B'), 'A traversal never crosses into B instances of identical ids');
      const travB = graph.traverse('shared-entity', { maxDepth: 2 }, TENANT_B);
      const travBNames = new Set(travB.flatMap((p) => p.entities.map((e) => e.name)));
      assert.ok(travBNames.has('Shared-B') && travBNames.has('Neighbor-B'), 'B traversal reaches B instances');
      assert.ok(!travBNames.has('Neighbor-A') && !travBNames.has('Shared-A'), 'B traversal never crosses into A instances of identical ids');

      // Vector search: with IDENTICAL text in both tenants, a tenant-scoped
      // search must still return only that tenant's vectors; the unscoped view
      // of the same single database holds both.
      const vecA = await vectors.embedAndSearch('knowledge.chunks', TEXT, { tenantId: TENANT_A, topK: 20 });
      assert.ok(vecA.length > 0 && vecA.every((h) => h.metadata?.tenantId === TENANT_A), 'A vectors only, despite identical content');
      const vecB = await vectors.embedAndSearch('knowledge.chunks', TEXT, { tenantId: TENANT_B, topK: 20 });
      assert.ok(vecB.length > 0 && vecB.every((h) => h.metadata?.tenantId === TENANT_B), 'B vectors only, despite identical content');
      // S-1: unscoped vector search is refused; the union of tenant-scoped
      // searches is the only way to observe that both tenants share the index.
      await assert.rejects(
        () => vectors.embedAndSearch('knowledge.chunks', TEXT, { topK: 200 }),
        /Failing closed/,
        'an unscoped vector search must be refused (S-1)',
      );
      const allV = [...vecA, ...vecB];
      const seen = new Set(allV.map((h) => h.metadata?.tenantId as string));
      assert.ok(seen.has(TENANT_A) && seen.has(TENANT_B), 'single shared index holds both tenants');

      // Graph RAG: tenant-scoped graph-augmented retrieval must not cross.
      const ragA = await graph.graphRetrieve(TEXT, { tenantId: TENANT_A, topK: 10, graphDepth: 2 });
      assert.ok(ragA.some((h) => h.document.id === docA.id), 'A Graph RAG finds its own doc');
      assert.ok(ragA.every((h) => h.document.tenantId === TENANT_A), 'A Graph RAG never surfaces B docs');
      for (const h of ragA) {
        assert.ok(h.entities.every((e) => e.id !== 'shared-entity' || e.name === 'Shared-A'), 'A Graph RAG attaches A\'s instance of identical-id entities');
        assert.ok(h.entities.every((e) => e.id !== 'neighbor-b'), 'A Graph RAG never expands into B-only entities');
      }
      const ragB = await graph.graphRetrieve(TEXT, { tenantId: TENANT_B, topK: 10, graphDepth: 2 });
      assert.ok(ragB.some((h) => h.document.id === docB.id), 'B Graph RAG finds its own doc');
      assert.ok(ragB.every((h) => h.document.tenantId === TENANT_B), 'B Graph RAG never surfaces A docs');
      for (const h of ragB) {
        assert.ok(h.entities.every((e) => e.id !== 'shared-entity' || e.name === 'Shared-B'), 'B Graph RAG attaches B\'s instance of identical-id entities');
        assert.ok(h.entities.every((e) => e.id !== 'neighbor-a'), 'B Graph RAG never expands into A-only entities');
      }

      // Graceful shutdown persists the partitioned snapshot (one kernel owns
      // both tenants — the production shape).
      await kernel.shutdown();
      await driver.close().catch(() => undefined);

      // Row-level reality: identical logical ids persist as DISTINCT composite
      // rows (tenant + U+0001 + id), each stamped with its tenant column.
      const sysDriver = new PostgresDriver({ connectionString: db.config.connectionString, requireExplicitConfig: true, max: 4 });
      try {
        const entRows = await sysDriver.openCollection<{ id: string; tenantId?: string; name?: string }>('__kg__.entities');
        const rows = (await entRows.all()).filter((r) => r.id.endsWith('\u0001shared-entity'));
        assert.equal(rows.length, 2, 'two persisted rows for the identical logical entity id');
        assert.deepEqual(new Set(rows.map((r) => r.tenantId)), new Set([TENANT_A, TENANT_B]), 'rows stamped with distinct tenants');
        assert.deepEqual(new Set(rows.map((r) => r.name)), new Set(['Shared-A', 'Shared-B']), 'no cross-tenant clobber of identical ids');
      } finally {
        await sysDriver.close().catch(() => undefined);
      }

      // Fresh kernel reload keeps every identical id partitioned.
      const booted2 = await bootKernel(db.config.connectionString);
      try {
        await settle();
        assert.equal(booted2.graph.getEntity('shared-entity', TENANT_A)?.name, 'Shared-A', 'reload keeps A instance');
        assert.equal(booted2.graph.getEntity('shared-entity', TENANT_B)?.name, 'Shared-B', 'reload keeps B instance');
        assert.equal(booted2.graph.getEntity('neighbor-a', TENANT_B), undefined, 'A-only entity never enters B store on reload');
        assert.equal(booted2.graph.getEntity('neighbor-b', TENANT_A), undefined, 'B-only entity never enters A store on reload');
        assert.ok(booted2.graph.getEntity(`doc:${docA.id}`, TENANT_A) && !booted2.graph.getEntity(`doc:${docA.id}`, TENANT_B), 'auto-indexed A doc entity partitioned after reload');
        const rA = await booted2.knowledge.retrieve(TEXT, { tenantId: TENANT_A, topK: 10 });
        assert.ok(rA.every((h) => h.document.tenantId === TENANT_A), 'post-reload A retrieval isolated');
        const ragA2 = await booted2.graph.graphRetrieve(TEXT, { tenantId: TENANT_A, topK: 10, graphDepth: 2 });
        assert.ok(ragA2.every((h) => h.document.tenantId === TENANT_A && h.entities.every((e) => e.id !== 'shared-entity' || e.name === 'Shared-A')), 'post-reload A Graph RAG isolated');
      } finally {
        await booted2.kernel.shutdown().catch(() => undefined);
        await booted2.driver.close().catch(() => undefined);
      }
    } finally {
      await kernel.shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      if (pg?.started) await pg.server.dropDatabase(db.database).catch(() => undefined);
    }
  });

  it('two independent OS processes (full lifecycles) + two concurrent OS probe processes on one database: no tenant contamination', async () => {
    requirePg();
    const db = await freshDb();
    const TEXT = 'interstellar logistics manifest review protocol across orbital relay stations';
    const dir = os.tmpdir();
    const fileA = path.join(dir, `t06-kg-a-${process.pid}-${randomUUID().slice(0, 8)}.json`);
    const fileB = path.join(dir, `t06-kg-b-${process.pid}-${randomUUID().slice(0, 8)}.json`);
    const filePA = path.join(dir, `t06-kg-pa-${process.pid}-${randomUUID().slice(0, 8)}.json`);
    const filePB = path.join(dir, `t06-kg-pb-${process.pid}-${randomUUID().slice(0, 8)}.json`);
    try {
      // Process 1: full lifecycle for tenant A (ingest + identical graph ids +
      // shutdown persists its snapshot). Process 2 then runs for tenant B and
      // boots against a database that ALREADY contains tenant A's committed
      // rows — the strongest sequential contamination scenario. Both processes
      // add the SAME logical ids ('shared-entity', 'shared-target') on purpose.
      await runWorker(db.config.connectionString, { WORKER_MODE: 'ingest', TENANT: TENANT_A, OUT: fileA, TEXT });
      await runWorker(db.config.connectionString, { WORKER_MODE: 'ingest', TENANT: TENANT_B, OUT: fileB, TEXT });
      const repA = readReport(fileA);
      const repB = readReport(fileB);
      assert.ok(repA.docId && repB.docId && repA.docId !== repB.docId, 'each process produced its own distinct document');

      // Parent kernel boots over the persisted database: both tenants fully
      // present and isolated (docs, chunks, vectors, graph incl. identical ids).
      const booted = await bootKernel(db.config.connectionString);
      try {
        await settle();
        const { knowledge: svc, graph, vectors } = booted;
        const hitsA = await svc.retrieve(TEXT, { tenantId: TENANT_A, topK: 10 });
        assert.ok(hitsA.some((h) => h.document.id === repA.docId), 'A doc persisted and retrievable');
        assert.ok(hitsA.every((h) => h.document.tenantId === TENANT_A), 'no B contamination in A retrieval');
        const hitsB = await svc.retrieve(TEXT, { tenantId: TENANT_B, topK: 10 });
        assert.ok(hitsB.some((h) => h.document.id === repB.docId), 'B doc persisted and retrievable');
        assert.ok(hitsB.every((h) => h.document.tenantId === TENANT_B), 'no A contamination in B retrieval');
        assert.equal(await svc.getDocument(repB.docId!, { tenantId: TENANT_A }), undefined, 'A cannot read B doc by id');
        assert.equal(await svc.getDocument(repA.docId!, { tenantId: TENANT_B }), undefined, 'B cannot read A doc by id');
        assert.equal(await svc.getChunk(repA.chunkIds![0]!, { tenantId: TENANT_B }), undefined, 'B cannot read A chunk');
        assert.equal(await svc.getChunk(repB.chunkIds![0]!, { tenantId: TENANT_A }), undefined, 'A cannot read B chunk');
        // Identical graph ids resolved per tenant after two-process persistence.
        assert.equal(graph.getEntity('shared-entity', TENANT_A)?.name, `Shared-${TENANT_A}`);
        assert.equal(graph.getEntity('shared-entity', TENANT_B)?.name, `Shared-${TENANT_B}`);
        assert.equal(graph.getEntity(`doc:${repA.docId}`, TENANT_B), undefined, 'A doc entity invisible to B store');
        assert.equal(graph.getEntity(`doc:${repB.docId}`, TENANT_A), undefined, 'B doc entity invisible to A store');
        // Vector index (single shared collection) holds both tenants' rows.
        // S-1: an unscoped vector search is refused, so "both tenants persisted
        // in the shared index" is proven by the union of the two tenant-scoped
        // searches plus the refusal itself.
        await assert.rejects(
          () => vectors.embedAndSearch('knowledge.chunks', TEXT, { topK: 200 }),
          /Failing closed/,
          'an unscoped vector search must be refused (S-1)',
        );
        const vecRowsA = await vectors.embedAndSearch('knowledge.chunks', TEXT, { tenantId: TENANT_A, topK: 100 });
        const vecRowsB = await vectors.embedAndSearch('knowledge.chunks', TEXT, { tenantId: TENANT_B, topK: 100 });
        const allV = [...vecRowsA, ...vecRowsB];
        const seen = new Set(allV.map((h) => h.metadata?.tenantId as string));
        assert.ok(seen.has(TENANT_A) && seen.has(TENANT_B), 'both tenants vectors persisted in the shared index');

        // Two OS probe processes run SIMULTANEOUSLY against the same database,
        // each verifying internally that only its own tenant is reachable.
        const pa = runWorker(db.config.connectionString, { WORKER_MODE: 'probe', TENANT: TENANT_A, OUT: filePA, TEXT, EXPECT_OWN_DOC: repA.docId!, EXPECT_FOREIGN_DOC: repB.docId! });
        const pb = runWorker(db.config.connectionString, { WORKER_MODE: 'probe', TENANT: TENANT_B, OUT: filePB, TEXT, EXPECT_OWN_DOC: repB.docId!, EXPECT_FOREIGN_DOC: repA.docId! });
        await Promise.all([pa, pb]);
        const prA = readReport(filePA);
        const prB = readReport(filePB);
        assert.ok(prA.hits!.every((h) => h.documentTenant === TENANT_A), 'probe A saw only A documents');
        assert.ok(prB.hits!.every((h) => h.documentTenant === TENANT_B), 'probe B saw only B documents');
        assert.ok(prA.ragHits!.length > 0 && prB.ragHits!.length > 0, 'both probes exercised Graph RAG');
        // Graph-RAG entity identity stayed per-tenant even for identical ids:
        // probe A must never see the OTHER tenant's instance of 'shared-entity'
        // / 'shared-target' (distinguished by name), while seeing its own.
        const namesA = prA.ragHits!.flatMap((h) => h.entityNames!);
        const namesB = prB.ragHits!.flatMap((h) => h.entityNames!);
        assert.ok(prA.ragHits!.every((h) => h.documentTenant === TENANT_A), 'probe A Graph RAG docs stayed in-tenant');
        assert.ok(prB.ragHits!.every((h) => h.documentTenant === TENANT_B), 'probe B Graph RAG docs stayed in-tenant');
        assert.ok(namesA.includes(`Shared-${TENANT_A}`) && !namesA.includes(`Shared-${TENANT_B}`) && !namesA.includes(`Target-${TENANT_B}`), 'probe A Graph RAG resolved identical ids to A instances only');
        assert.ok(namesB.includes(`Shared-${TENANT_B}`) && !namesB.includes(`Shared-${TENANT_A}`) && !namesB.includes(`Target-${TENANT_A}`), 'probe B Graph RAG resolved identical ids to B instances only');
        assert.equal(graph.getEntity('shared-entity', TENANT_A)?.name, `Shared-${TENANT_A}`, 'parent graph still resolves identical id to A instance');
        assert.equal(graph.getEntity('shared-entity', TENANT_B)?.name, `Shared-${TENANT_B}`, 'parent graph still resolves identical id to B instance');
      } finally {
        await booted.kernel.shutdown().catch(() => undefined);
        await booted.driver.close().catch(() => undefined);
      }
    } finally {
      for (const f of [fileA, fileB, filePA, filePB]) fs.rmSync(f, { force: true });
      if (pg?.started) await pg.server.dropDatabase(db.database).catch(() => undefined);
    }
  });
});
