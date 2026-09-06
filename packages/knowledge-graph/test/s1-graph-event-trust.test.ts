// S-1 (Tenant Boundary Hardening) — V-1 adversarial tests: the knowledge graph
// treats `knowledge.document.ingested` as UNTRUSTED input.
//
// Before S-1 the handler read the document with an UNSCOPED `getDocument(docId)`
// and planted the resulting title/metadata into the caller-named tenant store, so
// a forged emit carrying another tenant's docId disclosed that document's
// metadata across the tenant boundary. Three controls are now proven here, each
// fail-closed and audited:
//   1. producer attestation (envelope.source + provenance.source === 'knowledge');
//   2. tenant binding (non-blank, non-system envelope tenant; payload may only agree);
//   3. authoritative corroboration (tenant-SCOPED document re-read).
// Also covered: replay idempotence, legacy-subscriber compatibility, the
// `authorizeDocumentIngestedEvent` decision table, and the graph-RAG retrieval
// path refusing to run without a tenant BEFORE any vector or graph lookup.
//
// No fallback flag is set anywhere in this suite.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel, Logger, SYSTEM_TENANT, emitPlainEnveloped, wrapPlainEnvelope } from '@jataqi/core-kernel';
import type { EventEnvelope } from '@jataqi/core-kernel';
import { InMemorySink } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule, VectorEvents } from '@jataqi/vector-search';
import {
  DEFAULT_TENANT_ID,
  KnowledgeEvents,
  KnowledgeService,
  KNOWLEDGE_EVENT_SOURCE,
} from '@jataqi/knowledge-service';
import type { Document } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule, authorizeDocumentIngestedEvent } from '../src/index.js';

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const ATTACKER = 'tenant-attacker';
const SECRET_MARKER = 'alpha-only-metadata-value-9f31';
const TEXT_A = 'Alpha Corp archives cobalt narwhal telemetry from a Nairobi data centre.';
const TEXT_B = 'Beta Ltd stores crimson otter ledgers in a Mombasa warehouse.';
const TOPIC = KnowledgeEvents.DocumentIngested;

function bootKernel(): { kernel: Kernel; sink: InMemorySink } {
  const sink = new InMemorySink();
  const kernel = new Kernel({
    logger: new Logger({ level: 'warn', sink: sink.push.bind(sink) }),
    configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } },
  });
  kernel.register(new StorageModule());
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule());
  return { kernel, sink };
}

/** Serialize everything an attacker tenant can see, to prove non-disclosure. */
function visibleTo(graph: KnowledgeGraphModule, tenantId: string): string {
  return JSON.stringify(graph.allEntities(tenantId));
}

describe('S-1 knowledge-graph event trust (V-1) and retrieval tenant binding', () => {
  let kernel: Kernel;
  let sink: InMemorySink;
  let graph: KnowledgeGraphModule;
  let svc: KnowledgeService;
  let docA: Document;
  let docB: Document;

  beforeEach(async () => {
    assert.equal(process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK, undefined);
    assert.equal(process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK, undefined);
    ({ kernel, sink } = bootKernel());
    await kernel.boot();
    graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    svc = kernel.getModule<KnowledgeService>('knowledge');
    docA = await svc.ingestText(TEXT_A, { tenantId: TENANT_A, title: 'Alpha secret ledger', metadata: { clearance: SECRET_MARKER } });
    docB = await svc.ingestText(TEXT_B, { tenantId: TENANT_B, title: 'Beta otter ledger', metadata: { clearance: 'beta-only' } });
    sink.clear();
  });

  afterEach(async () => {
    try { await kernel.shutdown(); } catch { /* ignore */ }
  });

  it('positive control: a legitimate attested ingest indexes the document in its OWN tenant only', () => {
    const entityA = graph.getEntity(`doc:${docA.id}`, TENANT_A);
    assert.ok(entityA, 'A own ingest produced a document entity in A store');
    assert.equal(entityA!.name, 'Alpha secret ledger', 'the entity carries A own title');
    assert.equal(entityA!.properties?.clearance, SECRET_MARKER, 'A own metadata is available to A');
    assert.equal(graph.getEntity(`doc:${docA.id}`, TENANT_B), undefined, 'B cannot see A document entity');
    assert.equal(graph.getEntity(`doc:${docB.id}`, TENANT_A), undefined, 'A cannot see B document entity');
    assert.equal(graph.getEntity(`doc:${docA.id}`, ATTACKER), undefined, 'an unrelated tenant sees nothing');
    assert.equal(visibleTo(graph, ATTACKER).includes(SECRET_MARKER), false, 'no A metadata in the attacker tenant');
    assert.equal(graph.getEntity(`doc:${docA.id}`, DEFAULT_TENANT_ID), undefined, 'the default bucket holds nothing');
    assert.deepEqual(sink.ofLevel('warn').map((e) => e.msg), [], 'a legitimate ingest logs no refusal');
  });

  it('refuses a forged plain emit (unattested source) carrying a foreign docId', async () => {
    await kernel.bus.emit(TOPIC, { docId: docA.id, tenantId: ATTACKER, title: 'planted' });
    assert.equal(graph.getEntity(`doc:${docA.id}`, ATTACKER), undefined, 'no entity was planted for the attacker');
    assert.equal(visibleTo(graph, ATTACKER), '[]', 'the attacker tenant store is still empty');
    assert.equal(visibleTo(graph, ATTACKER).includes('Alpha secret ledger'), false, 'no A title disclosed');
    const warnings = sink.ofLevel('warn').map((e) => e.msg).join('\n');
    assert.match(warnings, /refused knowledge\.document\.ingested \(unattested-source\)/, 'the refusal is audited with its reason');
    assert.match(warnings, /no entity was created and no document was read/, 'the audit states nothing was read');
    assert.equal(graph.getEntity(`doc:${docA.id}`, TENANT_A)?.name, 'Alpha secret ledger', 'A own entity is untouched');
  });

  it('refuses an ATTESTED forgery: attacker source + attacker tenant + foreign docId discloses nothing', async () => {
    // An in-process attacker can forge the producer attestation, so control 3
    // (the tenant-scoped authoritative re-read) is what actually stops the
    // cross-tenant disclosure.
    await emitPlainEnveloped(kernel.bus, TOPIC, { docId: docA.id, tenantId: ATTACKER }, { source: KNOWLEDGE_EVENT_SOURCE, tenantId: ATTACKER });
    await emitPlainEnveloped(kernel.bus, TOPIC, { docId: docB.id }, { source: KNOWLEDGE_EVENT_SOURCE, tenantId: ATTACKER });
    assert.equal(graph.getEntity(`doc:${docA.id}`, ATTACKER), undefined, 'A document was not indexed into the attacker tenant');
    assert.equal(graph.getEntity(`doc:${docB.id}`, ATTACKER), undefined, 'B document was not indexed into the attacker tenant');
    const attackerView = visibleTo(graph, ATTACKER);
    assert.equal(attackerView, '[]', 'the attacker tenant store stayed empty');
    assert.equal(attackerView.includes(SECRET_MARKER), false, 'A metadata not disclosed');
    assert.equal(attackerView.includes('Alpha secret ledger'), false, 'A title not disclosed');
    assert.equal(attackerView.includes('Beta otter ledger'), false, 'B title not disclosed');
    const warnings = sink.ofLevel('warn').map((e) => e.msg).join('\n');
    assert.match(warnings, /document is not owned by the attested tenant/, 'the corroboration refusal is audited');
    assert.match(warnings, /no cross-tenant read or metadata disclosure was performed/, 'the audit states no disclosure happened');
    // Both victim documents remain readable by their owners (nothing was mutated).
    assert.ok(await svc.getDocument(docA.id, { tenantId: TENANT_A }), 'A document intact');
    assert.ok(await svc.getDocument(docB.id, { tenantId: TENANT_B }), 'B document intact');
  });

  it('refuses an envelope whose payload tenant contradicts the envelope tenant (ambiguity is denial)', async () => {
    await emitPlainEnveloped(kernel.bus, TOPIC, { docId: docA.id, tenantId: TENANT_A }, { source: KNOWLEDGE_EVENT_SOURCE, tenantId: ATTACKER });
    assert.equal(graph.getEntity(`doc:${docA.id}`, ATTACKER), undefined, 'mismatched event planted nothing in the attacker tenant');
    assert.equal(visibleTo(graph, ATTACKER), '[]', 'attacker store still empty');
    assert.match(sink.ofLevel('warn').map((e) => e.msg).join('\n'), /refused knowledge\.document\.ingested \(tenant-mismatch\)/);
  });

  it('refuses envelopes with a missing or blank tenant', async () => {
    for (const tenantId of [undefined, '', '   ']) {
      const envelope = { ...wrapPlainEnvelope(TOPIC, { docId: docA.id }, { source: KNOWLEDGE_EVENT_SOURCE }), tenantId } as EventEnvelope;
      await kernel.bus.emitEnveloped(TOPIC, envelope, { legacyPayload: { docId: docA.id } });
      assert.equal(visibleTo(graph, ATTACKER), '[]', `no tenant, no entity (${JSON.stringify(tenantId)})`);
    }
    const warnings = sink.ofLevel('warn').map((e) => e.msg).join('\n');
    assert.match(warnings, /refused knowledge\.document\.ingested \(missing-tenant\)/, 'missing tenant is audited');
    assert.equal(graph.getEntity(`doc:${docA.id}`, DEFAULT_TENANT_ID), undefined, 'a tenantless event never lands in the default bucket');
  });

  it('refuses an envelope bound to the kernel system tenant', async () => {
    const envelope = wrapPlainEnvelope(TOPIC, { docId: docA.id }, { source: KNOWLEDGE_EVENT_SOURCE, tenantId: SYSTEM_TENANT });
    assert.equal(envelope.tenantId, SYSTEM_TENANT);
    await kernel.bus.emitEnveloped(TOPIC, envelope, { legacyPayload: { docId: docA.id } });
    assert.match(sink.ofLevel('warn').map((e) => e.msg).join('\n'), /refused knowledge\.document\.ingested \(system-tenant\)/);
    assert.equal(graph.getEntity(`doc:${docA.id}`, SYSTEM_TENANT), undefined, 'nothing indexed under the system tenant');
    assert.equal(visibleTo(graph, ATTACKER), '[]');
  });

  it('refuses an attested envelope with a missing, blank, or nonexistent docId', async () => {
    await emitPlainEnveloped(kernel.bus, TOPIC, { tenantId: ATTACKER }, { source: KNOWLEDGE_EVENT_SOURCE, tenantId: ATTACKER });
    await emitPlainEnveloped(kernel.bus, TOPIC, { docId: '   ', tenantId: ATTACKER }, { source: KNOWLEDGE_EVENT_SOURCE, tenantId: ATTACKER });
    await emitPlainEnveloped(kernel.bus, TOPIC, { docId: 'doc-does-not-exist', tenantId: ATTACKER }, { source: KNOWLEDGE_EVENT_SOURCE, tenantId: ATTACKER });
    assert.equal(visibleTo(graph, ATTACKER), '[]', 'no entity for missing/blank/unknown docIds');
    const warnings = sink.ofLevel('warn').map((e) => e.msg).join('\n');
    assert.match(warnings, /refused knowledge\.document\.ingested \(missing-doc-id\)/);
    assert.match(warnings, /document is not owned by the attested tenant/);
  });

  it('a replayed legitimate event is idempotent and never crosses tenants', async () => {
    const before = graph.allEntities(TENANT_A).length;
    for (let i = 0; i < 3; i += 1) {
      await emitPlainEnveloped(kernel.bus, TOPIC, { docId: docA.id, tenantId: TENANT_A }, { source: KNOWLEDGE_EVENT_SOURCE, tenantId: TENANT_A });
    }
    const after = graph.allEntities(TENANT_A);
    assert.equal(after.length, before, 'replay created no duplicate or extra entity');
    assert.equal(after.filter((e) => e.id === `doc:${docA.id}`).length, 1, 'exactly one document entity after replay');
    assert.equal(graph.getEntity(`doc:${docA.id}`, TENANT_B), undefined, 'replay did not leak into B');
    assert.equal(graph.getEntity(`doc:${docA.id}`, ATTACKER), undefined, 'replay did not leak into the attacker tenant');
    assert.equal(graph.stats(TENANT_B).entities, graph.allEntities(TENANT_B).length, 'B store unchanged by A replay');
  });

  it('legacy plain subscribers still receive the payload (single emission, no consumer regression)', async () => {
    const seen: unknown[] = [];
    const off = kernel.bus.on(TOPIC, (payload) => { seen.push(payload); });
    await svc.ingestText('A second Alpha note about cobalt narwhals.', { tenantId: TENANT_A, title: 'Alpha second' });
    off();
    assert.ok(seen.length >= 1, 'the legacy listener was invoked');
    const payload = seen[seen.length - 1] as { docId?: string; tenantId?: string };
    assert.equal(typeof payload.docId, 'string', 'legacy payload shape preserved (plain object, not an envelope)');
    assert.equal(payload.tenantId, TENANT_A, 'the legacy payload carries the owning tenant');
    assert.equal((payload as unknown as EventEnvelope).source, undefined, 'legacy subscribers do not see envelope internals');
  });

  describe('authorizeDocumentIngestedEvent decision table (pure function)', () => {
    function env(overrides: Partial<EventEnvelope> = {}, payload: unknown = { docId: 'doc-1' }): EventEnvelope {
      return { ...wrapPlainEnvelope(TOPIC, payload, { source: KNOWLEDGE_EVENT_SOURCE, tenantId: TENANT_A }), ...overrides } as EventEnvelope;
    }

    it('accepts only an attested, tenant-bound, self-consistent envelope', () => {
      assert.deepEqual(authorizeDocumentIngestedEvent(env()), { ok: true, docId: 'doc-1', tenantId: TENANT_A });
      assert.deepEqual(authorizeDocumentIngestedEvent(env({}, { docId: 'doc-2', tenantId: TENANT_A })), { ok: true, docId: 'doc-2', tenantId: TENANT_A });
    });

    it('rejects every forgery and ambiguity shape', () => {
      assert.deepEqual(authorizeDocumentIngestedEvent(env({ source: 'legacy-bridge' })), { ok: false, reason: 'unattested-source' });
      assert.deepEqual(authorizeDocumentIngestedEvent(env({ source: KNOWLEDGE_EVENT_SOURCE, provenance: undefined })), { ok: false, reason: 'unattested-source' });
      assert.deepEqual(authorizeDocumentIngestedEvent(env({ tenantId: '' })), { ok: false, reason: 'missing-tenant' });
      assert.deepEqual(authorizeDocumentIngestedEvent(env({ tenantId: '   ' })), { ok: false, reason: 'missing-tenant' });
      assert.deepEqual(authorizeDocumentIngestedEvent(env({ tenantId: SYSTEM_TENANT })), { ok: false, reason: 'system-tenant' });
      assert.deepEqual(authorizeDocumentIngestedEvent(env({}, { docId: 'doc-1', tenantId: TENANT_B })), { ok: false, reason: 'tenant-mismatch' });
      assert.deepEqual(authorizeDocumentIngestedEvent(env({}, {})), { ok: false, reason: 'missing-doc-id' });
      assert.deepEqual(authorizeDocumentIngestedEvent(env({}, { docId: '  ' })), { ok: false, reason: 'missing-doc-id' });
      assert.deepEqual(authorizeDocumentIngestedEvent(env({}, { docId: 42 })), { ok: false, reason: 'missing-doc-id' });
    });
  });

  describe('graph retrieval is tenant-bound before any lookup (V-1/V-3)', () => {
    it('graphRetrieve refuses a tenantless call before touching the vector index', async () => {
      const searched: string[] = [];
      const off = kernel.bus.on(VectorEvents.Searched, () => { searched.push('searched'); });
      await assert.rejects(() => graph.graphRetrieve('cobalt narwhal telemetry', { topK: 5 }), /Failing closed/);
      await assert.rejects(() => graph.graphRetrieve('cobalt narwhal telemetry', { tenantId: '  ', topK: 5 }), /Failing closed/);
      off();
      assert.deepEqual(searched, [], 'no vector search happened: the refusal precedes retrieval');
    });

    it('graphRetrieve returns only the requesting tenant evidence', async () => {
      const hitsA = await graph.graphRetrieve('crimson otter ledgers Mombasa warehouse', { tenantId: TENANT_A, topK: 10 });
      assert.ok(hitsA.every((h) => h.document.tenantId === TENANT_A), 'A retrieval carries only A documents');
      assert.ok(hitsA.every((h) => h.entities.every((e) => graph.getEntity(e.id, TENANT_A) !== undefined)),
        'every entity attributed to A is genuinely in A store');
      assert.equal(JSON.stringify(hitsA).includes('Beta otter ledger'), false, 'B title not disclosed to A');

      const hitsB = await graph.graphRetrieve('cobalt narwhal telemetry Nairobi', { tenantId: TENANT_B, topK: 10 });
      assert.ok(hitsB.every((h) => h.document.tenantId === TENANT_B), 'B retrieval carries only B documents');
      assert.equal(JSON.stringify(hitsB).includes(SECRET_MARKER), false, 'A metadata not disclosed to B');

      const hitsAttacker = await graph.graphRetrieve('cobalt narwhal telemetry crimson otter ledgers', { tenantId: ATTACKER, topK: 10 });
      assert.deepEqual(hitsAttacker, [], 'a tenant with no data retrieves nothing, not someone else data');

      const own = await graph.graphRetrieve('cobalt narwhal telemetry', { tenantId: TENANT_A, topK: 10 });
      assert.ok(own.length > 0, 'positive control: A retrieves its own evidence');
    });
  });
});
