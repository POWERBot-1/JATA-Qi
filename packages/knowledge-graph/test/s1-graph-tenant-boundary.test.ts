// S-1 (Tenant Boundary Hardening) — B-2 and B-3 adversarial tests for the
// knowledge graph.
//
// B-2: there is no ambient/default-tenant store handle. `graph.store` was
// removed from the DI container and from the module surface; a store is only
// reachable through `storeFor(tenantId)`, which fails closed without an
// unambiguous tenant, and persistence preserves row ownership.
//
// B-3: durable rows with no tenant tag are NEVER silently turned into
// authoritative `DEFAULT_TENANT_ID` data. They are quarantined (invisible to
// every tenant), reported, written back verbatim, and can only be attributed
// through an explicit, validated operator migration option.
//
// No fallback flag is set anywhere in this suite.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Kernel, Logger } from '@jataqi/core-kernel';
import { InMemorySink } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import type { IStorageDriver, StorageModuleConfig } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { DEFAULT_TENANT_ID, KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '../src/index.js';
import type { KnowledgeGraphConfig } from '../src/index.js';

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const LEGACY_TENANT = 'tenant-legacy-migration';
const SEP = '\u0001';

interface PersistedRow { id: string; tenantId?: string; [k: string]: unknown }

/** Read the durable JSONL snapshot rows the filesystem driver wrote for a collection. */
async function readSnapshotRows(root: string, collectionSuffix: string): Promise<PersistedRow[]> {
  const dir = path.join(root, 'collections');
  const file = (await fs.readdir(dir)).find((f) => f.endsWith(`${collectionSuffix}.jsonl`));
  assert.ok(file, `durable snapshot for *${collectionSuffix} exists under ${dir}`);
  const raw = await fs.readFile(path.join(dir, file!), 'utf8');
  return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => (JSON.parse(l) as { doc: PersistedRow }).doc);
}

/** Append a hand-crafted legacy/malformed row to a durable snapshot (simulating a pre-S-1 snapshot). */
async function appendSnapshotRow(root: string, collectionSuffix: string, row: PersistedRow): Promise<void> {
  const dir = path.join(root, 'collections');
  const file = (await fs.readdir(dir)).find((f) => f.endsWith(`${collectionSuffix}.jsonl`));
  assert.ok(file, `durable snapshot for *${collectionSuffix} exists before appending a legacy row`);
  await fs.appendFile(path.join(dir, file!), `${JSON.stringify({ doc: row })}\n`, 'utf8');
}

function bootKernel(opts: { graph?: KnowledgeGraphConfig; driver?: IStorageDriver; storage?: StorageModuleConfig } = {}): { kernel: Kernel; sink: InMemorySink } {
  const sink = new InMemorySink();
  const kernel = new Kernel({
    logger: new Logger({ level: 'warn', sink: sink.push.bind(sink) }),
    configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } },
  });
  kernel.register(new StorageModule(opts.storage ?? (opts.driver ? { driverInstance: opts.driver } : {})));
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule(opts.graph ?? {}));
  return { kernel, sink };
}

describe('S-1 knowledge-graph tenant boundary (B-2 no ambient store, B-3 untagged rows quarantined)', () => {
  let kernel: Kernel;
  let sink: InMemorySink;
  let graph: KnowledgeGraphModule;
  let storage: StorageModule;

  beforeEach(async () => {
    assert.equal(process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK, undefined);
    assert.equal(process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK, undefined);
    ({ kernel, sink } = bootKernel());
    await kernel.boot();
    graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    storage = kernel.getModule<StorageModule>('storage');
  });

  afterEach(async () => {
    try { await kernel.shutdown(); } catch { /* ignore */ }
  });

  describe('B-2 — no default-tenant store handle', () => {
    it('registers no ambient graph.store value and exposes no store getter', () => {
      assert.equal(kernel.container.has('graph.store'), false, 'the privileged default-tenant handle is gone from the container');
      assert.equal('store' in graph, false, 'the module exposes no ambient `store` property');
      assert.equal((graph as unknown as { store?: unknown }).store, undefined, 'no store getter on the instance');
      assert.equal(kernel.container.has('graph.module'), true, 'the tenant-aware module itself is still resolvable');
      assert.equal(kernel.container.resolveSync<KnowledgeGraphModule>('graph.module'), graph);
      assert.equal(graph.tenantKeys().includes(DEFAULT_TENANT_ID), false, 'boot does not create the default-tenant bucket');
      assert.equal(graph.tenantKeys().includes(''), false, 'boot does not create an unowned "" bucket');
    });

    it('refuses to hand out any store handle without an unambiguous tenant', () => {
      for (const tenantId of [undefined, '', '   ', '\t']) {
        assert.throws(() => graph.storeFor(tenantId), /Failing closed/, `storeFor(${JSON.stringify(tenantId)}) must refuse`);
        assert.throws(() => graph.requireTenant(tenantId, 'test'), /Failing closed/, `requireTenant(${JSON.stringify(tenantId)}) must refuse`);
      }
      assert.deepEqual(graph.tenantKeys(), [], 'no store was created by the refused calls');
    });

    it('every tenant-bound graph read and write refuses without a tenant', () => {
      const syncCalls: Array<[string, () => unknown]> = [
        ['getEntity', () => graph.getEntity('doc:1')],
        ['addEntity', () => graph.addEntity({ id: 'x', type: 'Concept', name: 'x' })],
        ['addOrGetEntity', () => graph.addOrGetEntity({ id: 'x', type: 'Concept', name: 'x' })],
        ['removeEntity', () => graph.removeEntity('x')],
        ['allEntities', () => graph.allEntities()],
        ['entitiesByType', () => graph.entitiesByType('Document')],
        ['stats', () => graph.stats()],
        ['allTriples', () => graph.allTriples()],
        ['triplesFrom', () => graph.triplesFrom('x')],
        ['triplesTo', () => graph.triplesTo('x')],
        ['traverse', () => graph.traverse('x')],
        ['addTriple', () => graph.addTriple({ subject: 'a', predicate: 'relates_to', object: 'b' })],
        ['removeTriple', () => graph.removeTriple('t1')],
        ['linkMention', () => graph.linkMention('chunk1', 'ent1')],
      ];
      for (const [op, call] of syncCalls) {
        assert.throws(call, /Failing closed/, `${op} must refuse a tenantless call`);
      }
      const asyncCalls: Array<[string, () => Promise<unknown>]> = [
        ['findEntities', () => graph.findEntities('anything', {}, undefined)],
        ['graphRetrieve', () => graph.graphRetrieve('anything', {})],
        ['embedEntity', () => graph.embedEntity('ent1')],
      ];
      return Promise.all(asyncCalls.map(async ([op, call]) => {
        await assert.rejects(call, /Failing closed/, `${op} must refuse a tenantless call`);
      })).then(() => {
        assert.deepEqual(graph.tenantKeys(), [], 'no tenant store was created by any refused call');
      });
    });

    it('an ambiguous (blank/whitespace) tenant is denied for writes too — it is not a distinct tenant', () => {
      for (const tenantId of ['', '   ', '\t']) {
        assert.throws(() => graph.addOrGetEntity({ id: 'blank-write', type: 'Concept', name: 'x' }, tenantId), /Failing closed/,
          `addOrGetEntity(${JSON.stringify(tenantId)}) must refuse`);
        assert.throws(() => graph.addEntity({ id: 'blank-write', type: 'Concept', name: 'x' }, tenantId), /Failing closed/,
          `addEntity(${JSON.stringify(tenantId)}) must refuse`);
        assert.throws(() => graph.addTriple({ subject: 'a', predicate: 'mentions', object: 'b' }, tenantId), /Failing closed/,
          `addTriple(${JSON.stringify(tenantId)}) must refuse`);
        assert.throws(() => graph.linkMention('chunk-1', 'ent-1', 0.9, 'doc-1', tenantId), /Failing closed/,
          `linkMention(${JSON.stringify(tenantId)}) must refuse`);
        assert.throws(() => graph.getEntity('blank-write', tenantId), /Failing closed/,
          `getEntity(${JSON.stringify(tenantId)}) must refuse rather than read an unowned bucket`);
        assert.throws(() => graph.allEntities(tenantId), /Failing closed/, `allEntities(${JSON.stringify(tenantId)}) must refuse`);
        assert.throws(() => graph.stats(tenantId), /Failing closed/, `stats(${JSON.stringify(tenantId)}) must refuse`);
      }
      assert.equal(graph.tenantKeys().some((k) => k.trim().length === 0), false, 'no unowned blank-tenant bucket was created');
      assert.equal(graph.getEntity('blank-write', TENANT_A), undefined, 'nothing was written into a real tenant either');
    });

    it('a caller holding the module cannot write into another tenant store, and ownership survives persistence', async () => {
      const storeA = graph.storeFor(TENANT_A);
      storeA.upsertEntity({ id: 'secret-a', type: 'Concept', name: 'Alpha secret', createdAt: 1, updatedAt: 1 });
      graph.addOrGetEntity({ id: 'secret-b', type: 'Concept', name: 'Beta secret' }, TENANT_B);

      assert.equal(graph.getEntity('secret-a', TENANT_B), undefined, 'B cannot read A entity');
      assert.equal(graph.getEntity('secret-b', TENANT_A), undefined, 'A cannot read B entity');
      assert.ok(graph.allEntities(TENANT_A).every((e) => e.id !== 'secret-b'), 'A enumeration excludes B entity');
      assert.ok(graph.allEntities(TENANT_B).every((e) => e.id !== 'secret-a'), 'B enumeration excludes A entity');

      // A tenantless attacker cannot obtain a writable handle at all.
      assert.throws(() => graph.storeFor(), /Failing closed/);
      assert.throws(() => graph.addOrGetEntity({ id: 'planted', type: 'Concept', name: 'planted' }), /Failing closed/,
        'a tenantless write is refused rather than landing in a default store');
      assert.equal(graph.getEntity('planted', DEFAULT_TENANT_ID), undefined, 'nothing was planted in the default bucket');
      assert.equal(graph.getEntity('planted', TENANT_A), undefined, 'nothing was planted in A');

      await graph.persist();
      const rows = await (await storage.collection<PersistedRow>('__kg__.entities')).all();
      assert.ok(rows.length >= 2, 'rows were persisted');
      for (const row of rows) {
        assert.ok(typeof row.tenantId === 'string' && row.tenantId.trim().length > 0, `row ${row.id} carries a non-blank tenant tag`);
        assert.ok(row.id.startsWith(`${row.tenantId}${SEP}`), `row id ${row.id} keeps its tenant prefix (no cross-tenant overwrite)`);
        assert.notEqual(row.tenantId, DEFAULT_TENANT_ID, 'no row was silently attributed to the default tenant');
      }
      const tags = new Set(rows.map((r) => r.tenantId));
      assert.ok(tags.has(TENANT_A) && tags.has(TENANT_B), 'both tenants own rows');
    });

    it('identical entity ids stay per-tenant (no shared-id collision across stores)', () => {
      graph.addOrGetEntity({ id: 'shared', type: 'Concept', name: `Shared-${TENANT_A}` }, TENANT_A);
      graph.addOrGetEntity({ id: 'shared', type: 'Concept', name: `Shared-${TENANT_B}` }, TENANT_B);
      assert.equal(graph.getEntity('shared', TENANT_A)?.name, `Shared-${TENANT_A}`);
      assert.equal(graph.getEntity('shared', TENANT_B)?.name, `Shared-${TENANT_B}`);
      assert.equal(graph.getEntity('shared', DEFAULT_TENANT_ID), undefined, 'the default bucket holds neither');
      assert.equal(graph.stats(TENANT_A).entities, 1, 'A counts only its own entity');
      assert.equal(graph.stats(TENANT_B).entities, 1, 'B counts only its own entity');
    });
  });

  describe('B-3 — untagged durable rows are quarantined, never default-tenant data', () => {
    it('quarantines untagged/blank-tagged durable rows, reports them, and preserves them verbatim on persist', async () => {
      // Genuine durable state: a filesystem-driver snapshot written by one
      // kernel, hand-modified to carry legacy rows with no usable tenant tag,
      // then loaded by a SECOND kernel (the "restart" that must not silently
      // adopt them into the reserved default bucket).
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-s1-b3-'));
      const storageOpts: StorageModuleConfig = { driver: 'filesystem', fsRoot: root };
      try {
        // Phase 1: two tenants own tagged rows; the snapshot is persisted and closed.
        const first = bootKernel({ storage: storageOpts });
        await first.kernel.boot();
        const graph1 = first.kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
        graph1.addOrGetEntity({ id: 'owned-a', type: 'Concept', name: 'Alpha owned' }, TENANT_A);
        graph1.addOrGetEntity({ id: 'owned-b', type: 'Concept', name: 'Beta owned' }, TENANT_B);
        graph1.addOrGetEntity({ id: 'owned-a2', type: 'Concept', name: 'Alpha second' }, TENANT_A);
        graph1.addTriple({ subject: 'owned-a', predicate: 'mentions', object: 'owned-a2' }, TENANT_A);
        await graph1.persist();
        await first.kernel.shutdown();

        // Phase 2 input: legacy rows from a pre-S-1 snapshot — one with no
        // tenant tag at all, one with a blank tag, and an untagged triple.
        await appendSnapshotRow(root, 'entities', { id: 'legacy-untagged-entity', type: 'Concept', name: 'Legacy untagged secret' });
        await appendSnapshotRow(root, 'entities', { id: 'blank-tenant-entity', type: 'Concept', name: 'Blank tenant secret', tenantId: '   ' });
        await appendSnapshotRow(root, 'triples', { id: 'legacy-untagged-triple', subject: 'legacy-untagged-entity', predicate: 'mentions', object: 'owned-a' });

        // Phase 3: a fresh kernel loads the same durable snapshot.
        const second = bootKernel({ storage: storageOpts });
        kernel = second.kernel;
        sink = second.sink;
        await kernel.boot();
        graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
        storage = kernel.getModule<StorageModule>('storage');

        for (const tenantId of [TENANT_A, TENANT_B, LEGACY_TENANT]) {
          assert.equal(graph.getEntity('legacy-untagged-entity', tenantId), undefined, `untagged entity invisible to ${tenantId}`);
          assert.equal(graph.getEntity('blank-tenant-entity', tenantId), undefined, `blank-tagged entity invisible to ${tenantId}`);
          assert.ok(graph.allEntities(tenantId).every((e) => e.id !== 'legacy-untagged-entity'), `untagged entity not enumerated for ${tenantId}`);
        }
        // The reserved default bucket must not adopt them either (and reading it
        // is itself refused without the K1 flag — no implicit default tenant).
        assert.throws(() => graph.getEntity('legacy-untagged-entity'), /Failing closed/, 'a tenantless read of the legacy row is refused');
        assert.equal(graph.getEntity('legacy-untagged-entity', DEFAULT_TENANT_ID), undefined, 'the default bucket does not adopt untagged rows');
        assert.equal(graph.stats(DEFAULT_TENANT_ID).entities, 0, 'the default bucket stays empty');

        // Tagged rows load normally: quarantine is surgical, not a wipe.
        assert.equal(graph.getEntity('owned-a', TENANT_A)?.name, 'Alpha owned', 'A row still loads');
        assert.equal(graph.getEntity('owned-b', TENANT_B)?.name, 'Beta owned', 'B row still loads');
        assert.equal(graph.allTriples(TENANT_A).length, 1, 'A tagged triple still loads');
        assert.equal(graph.allTriples(TENANT_B).length, 0, 'B has no triples');

        const report = graph.quarantineReport();
        assert.equal(report.entities, 2, 'both untagged and blank-tagged entity rows are quarantined');
        assert.equal(report.triples, 1, 'the untagged triple row is quarantined');
        assert.deepEqual(report.entityRowIds.sort(), ['blank-tenant-entity', 'legacy-untagged-entity']);
        assert.deepEqual(report.tripleRowIds, ['legacy-untagged-triple']);
        assert.equal(report.attributedToTenant, undefined, 'no attribution was configured');
        assert.equal(report.attributedRows, 0, 'no row was attributed');
        assert.match(sink.ofLevel('warn').map((e) => e.msg).join('\n'), /quarantined/, 'quarantine is auditable through a WARN log');

        // Non-destructive: persisting rewrites tagged rows and re-emits the
        // quarantined ones VERBATIM (still untagged), never canonizing an owner.
        await graph.persist();
        const entityRows = await readSnapshotRows(root, 'entities');
        const legacy = entityRows.find((r) => r.id === 'legacy-untagged-entity');
        const blank = entityRows.find((r) => r.id === 'blank-tenant-entity');
        assert.ok(legacy, 'the quarantined row was not deleted by persist');
        assert.equal(legacy!.tenantId, undefined, 'the quarantined row is still untagged after persist');
        assert.equal(legacy!.name, 'Legacy untagged secret', 'quarantined row content is unchanged');
        assert.ok(blank, 'the blank-tagged row was not deleted by persist');
        assert.equal(String(blank!.tenantId).trim(), '', 'the blank tag was not rewritten to a real tenant');
        const tagged = entityRows.filter((r) => typeof r.tenantId === 'string' && r.tenantId.trim().length > 0);
        assert.equal(tagged.length, 3, 'exactly the three legitimately tagged entity rows remain tagged');
        assert.ok(tagged.every((r) => r.tenantId === TENANT_A || r.tenantId === TENANT_B), 'no row was attributed to the default tenant');
        const tripleRows = await readSnapshotRows(root, 'triples');
        assert.equal(tripleRows.find((r) => r.id === 'legacy-untagged-triple')?.tenantId, undefined, 'quarantined triple still untagged');
        assert.ok(tripleRows.some((r) => r.tenantId === TENANT_A), 'the tagged triple survives');
        await kernel.shutdown();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('rejects an attribution option that would recreate the silent default bucket', () => {
      assert.throws(() => new KnowledgeGraphModule({ untaggedRowTenant: DEFAULT_TENANT_ID }), /reserved DEFAULT_TENANT_ID/,
        'attributing untagged rows to the shared default bucket is refused at construction');
      assert.throws(() => new KnowledgeGraphModule({ untaggedRowTenant: '' }), /non-blank tenant id/);
      assert.throws(() => new KnowledgeGraphModule({ untaggedRowTenant: '   ' }), /non-blank tenant id/);
      assert.throws(() => new KnowledgeGraphModule({ untaggedRowTenant: 42 as unknown as string }), /non-blank tenant id/);
    });

    it('attributes untagged rows only through an explicit, audited migration option', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-s1-b3-attr-'));
      const storageOpts: StorageModuleConfig = { driver: 'filesystem', fsRoot: root };
      try {
        const first = bootKernel({ storage: storageOpts });
        await first.kernel.boot();
        const graph1 = first.kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
        graph1.addOrGetEntity({ id: 'owned-a', type: 'Concept', name: 'Alpha owned' }, TENANT_A);
        await graph1.persist();
        await first.kernel.shutdown();
        await appendSnapshotRow(root, 'entities', { id: 'legacy-untagged-entity', type: 'Concept', name: 'Legacy untagged secret' });

        const second = bootKernel({ storage: storageOpts, graph: { untaggedRowTenant: LEGACY_TENANT } });
        kernel = second.kernel;
        sink = second.sink;
        await kernel.boot();
        graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');

        assert.equal(graph.getEntity('legacy-untagged-entity', LEGACY_TENANT)?.name, 'Legacy untagged secret',
          'the operator-attributed tenant can read the legacy row');
        assert.equal(graph.getEntity('legacy-untagged-entity', DEFAULT_TENANT_ID), undefined, 'the default bucket still gets nothing');
        assert.equal(graph.getEntity('legacy-untagged-entity', TENANT_A), undefined, 'no other tenant inherits the legacy row');
        assert.equal(graph.getEntity('legacy-untagged-entity', TENANT_B), undefined, 'no other tenant inherits the legacy row');
        assert.equal(graph.getEntity('owned-a', TENANT_A)?.name, 'Alpha owned', 'tagged rows are unaffected by the attribution option');
        assert.equal(graph.getEntity('owned-a', LEGACY_TENANT), undefined, 'attribution does not leak tagged rows into the migration tenant');

        const report = graph.quarantineReport();
        assert.equal(report.entities, 0, 'nothing stays quarantined once explicitly attributed');
        assert.equal(report.attributedToTenant, LEGACY_TENANT, 'the attribution decision is reported');
        assert.equal(report.attributedRows, 1, 'exactly one row was attributed');
        assert.match(sink.ofLevel('warn').map((e) => e.msg).join('\n'), /attributed 1 untagged durable row/, 'the attribution is auditable');

        // The attribution is durable and honest: the row is rewritten with the
        // attributed tenant tag, and no other tenant tag appears.
        await graph.persist();
        const rows = await readSnapshotRows(root, 'entities');
        const legacy = rows.find((r) => r.id.includes('legacy-untagged-entity'));
        assert.equal(legacy?.tenantId, LEGACY_TENANT, 'the attributed row now carries the explicit migration tenant');
        assert.ok(rows.every((r) => r.tenantId === LEGACY_TENANT || r.tenantId === TENANT_A), 'only the two legitimate tenants appear');
        assert.equal(rows.some((r) => r.tenantId === DEFAULT_TENANT_ID), false, 'the default tenant never appears');
        await kernel.shutdown();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});
