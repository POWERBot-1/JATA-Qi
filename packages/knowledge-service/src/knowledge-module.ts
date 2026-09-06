import { randomUUID } from 'node:crypto';
import { emitPlainEnveloped } from '@jataqi/core-kernel';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection, INamespace } from '@jataqi/storage';
import type { VectorSearchModule } from '@jataqi/vector-search';
import { chunkText } from './chunker.js';
import { KnowledgeEvents } from './types.js';
import { resolveTenantContext } from './tenant-context.js';
import type {
  Chunk,
  Document,
  IngestOptions,
  RetrievalHit,
  RetrievalOptions,
} from './types.js';

/** Attested producer identity recorded on every knowledge event envelope (S-1/V-1). */
export const KNOWLEDGE_EVENT_SOURCE = 'knowledge';

const NS_DOCS = 'knowledge.docs';
const COL_CHUNKS = 'knowledge.chunks';
const VEC_INDEX = 'knowledge.chunks';

export class KnowledgeService implements IModule {
  readonly id = 'knowledge';
  readonly tags = ['core', 'knowledge'] as const;
  readonly dependsOn = ['storage', 'vector-search'] as const;

  private api!: KernelApi;
  private docs!: INamespace;
  private chunks!: ICollection<Chunk>;
  private vectors!: VectorSearchModule;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      namespace: (n: string) => Promise<INamespace>;
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    // eslint-disable-next-line no-restricted-syntax -- T-08.1 D1: knowledge docs use collection-level tenantId (doc.tenantId) with a single system namespace; per-tenant namespace would be a breaking storage migration. Explicitly exempted.
    this.docs = await storage.namespace(NS_DOCS);
    this.chunks = await storage.collection<Chunk>(COL_CHUNKS);
    this.vectors = kernel.getModule<VectorSearchModule>('vector-search');
    // Restore the known knowledge index when a development snapshot exists;
    // load() creates an empty index when no snapshot has been written yet.
    await this.vectors.load(VEC_INDEX);
    kernel.container.registerValue('knowledge.service', this);
    kernel.logger.info('knowledge service initialized');
  }

  async start(_kernel: KernelApi): Promise<void> {
    /* nothing background */
  }

  async stop(_kernel: KernelApi): Promise<void> {
    /* nothing to release */
  }

  /**
   * S-1: the authoritative tenant guard for EVERY tenant-bound knowledge
   * operation — ingest, read, and delete alike.
   *
   * T-08.1 D/K1 semantics are preserved exactly (same warning, same message
   * shape, same two explicit test-compat flags, no NODE_ENV authorization), but
   * the guard is no longer ingest-only: before S-1 the read/delete paths gated
   * on `tenantId !== undefined`, so a tenant-less `retrieve`/`stats`/`getChunk`/
   * `getDocument` returned EVERY tenant's data and a tenant-less
   * `deleteDocument` destroyed a foreign tenant's document.
   *
   * Contract now enforced for all of them:
   *   - non-blank tenant  → exactly that tenant (never widened);
   *   - missing/blank     → REFUSED (`TenantContextError`) with no data-plane work;
   *   - test-compat flags → the isolated reserved DEFAULT_TENANT_ID bucket only,
   *                         which is still ONE tenant, never all tenants.
   */
  private requireTenant(requested: string | undefined, op: string): string {
    return resolveTenantContext(requested, op, { logger: this.api?.logger });
  }

  /** Ingest text as a new document, chunk, embed, and index. Returns the Document. */
  async ingestText(text: string, opts: IngestOptions = {}): Promise<Document> {
    if (!text || !text.trim()) throw new Error('ingestText: text is empty');
    const tenantId = this.requireTenant(opts.tenantId, 'ingestText');
    const docId = randomUUID();
    const now = Date.now();
    const doc: Document = {
      id: docId,
      tenantId,
      contentType: opts.contentType ?? 'text/plain',
      text,
      title: opts.title,
      lang: opts.lang,
      metadata: opts.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      chunkIds: [],
    };
    const protoChunks = chunkText(text, docId, {
      chunkSize: opts.chunkSize,
      chunkOverlap: opts.chunkOverlap,
      strategy: opts.strategy,
    });
    const storedChunks: Chunk[] = [];
    const vecItems: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = [];
    for (const c of protoChunks) {
      const id = `${docId}:${c.index}`;
      const full: Chunk = { ...c, id, tenantId, documentId: docId };
      storedChunks.push(full);
      doc.chunkIds.push(id);
      vecItems.push({
        id,
        text: c.text,
        metadata: {
          tenantId,
          docId,
          chunkIndex: c.index,
          ...(doc.metadata ?? {}),
          ...(c.metadata ?? {}),
        },
      });
    }

    await this.docs.set(docId, doc);
    // Each put refreshes under the collection's shared filesystem mutex, so
    // concurrent same-process ingests merge rather than racing a read/replace
    // snapshot. Graph/vector lifecycle snapshots are batched separately.
    for (const chunk of storedChunks) await this.chunks.put(chunk);
    await this.vectors.embedAndAdd(VEC_INDEX, vecItems);
    // Keep the documented development filesystem flow searchable after a
    // restart. This is a local snapshot, not a cross-resource transaction.
    await this.vectors.persist(VEC_INDEX);

    this.api.logger.debug(`ingested doc ${docId} for tenant ${tenantId} (${storedChunks.length} chunks)`);
    // S-1/V-1: knowledge events are produced as first-class envelopes with the
    // owning tenant bound IN THE ENVELOPE (not only in the payload) and the
    // producing subsystem attested in `source`/`provenance`. Legacy subscribers
    // still receive the byte-identical plain payload via `legacyPayload`, so
    // F-01a compatibility is preserved while consumers can now distinguish an
    // attested producer from an arbitrary in-process emit.
    await emitPlainEnveloped(
      this.api.bus,
      KnowledgeEvents.DocumentIngested,
      { docId, tenantId, chunks: storedChunks.length },
      { source: KNOWLEDGE_EVENT_SOURCE, tenantId, entityId: docId, correlationId: `knowledge:ingest:${docId}` },
    );
    await emitPlainEnveloped(
      this.api.bus,
      KnowledgeEvents.ChunksCreated,
      { docId, tenantId, chunkIds: doc.chunkIds },
      { source: KNOWLEDGE_EVENT_SOURCE, tenantId, entityId: docId, correlationId: `knowledge:ingest:${docId}` },
    );
    return doc;
  }

  /**
   * Retrieve a document by id — tenant-bound (S-1).
   *
   * `opts.tenantId` is REQUIRED. A missing/blank tenant is refused
   * (`TenantContextError`) instead of performing a system-level read: before
   * S-1 this method returned the raw document regardless of tenant, which let a
   * tenantless caller read (and, via `deleteDocument`, destroy) another
   * tenant's data.
   *
   * Denials: a document owned by a different tenant — or an untagged/legacy
   * document — yields `undefined` (fail-closed), never the record.
   */
  async getDocument(id: string, opts: { tenantId?: string } = {}): Promise<Document | undefined> {
    const tenantId = this.requireTenant(opts.tenantId, 'getDocument');
    const doc = await this.docs.get<Document>(id);
    if (!doc) return undefined;
    if (doc.tenantId !== tenantId) return undefined;
    return doc;
  }

  /**
   * Retrieve a chunk by id — tenant-bound (S-1), same contract as
   * `getDocument`: tenant required, cross-tenant and untagged ids denied.
   */
  async getChunk(id: string, opts: { tenantId?: string } = {}): Promise<Chunk | undefined> {
    const tenantId = this.requireTenant(opts.tenantId, 'getChunk');
    const chunk = await this.chunks.get(id);
    if (!chunk) return undefined;
    if (chunk.tenantId !== tenantId) return undefined;
    return chunk;
  }

  /**
   * Delete a document, its chunks, and its vectors — tenant-bound (S-1).
   *
   * This is the highest-severity operation in the service: before S-1 a call
   * with no tenant deleted ANY tenant's document (independent verification
   * proved a foreign document destroyed). The tenant is now resolved first and
   * the deletion only proceeds when the document is owned by that exact tenant;
   * a cross-tenant or untagged id is refused (`false`) and nothing is mutated —
   * no chunk, no vector, no document row, and no `DocumentDeleted` event.
   */
  async deleteDocument(id: string, opts: { tenantId?: string } = {}): Promise<boolean> {
    const tenantId = this.requireTenant(opts.tenantId, 'deleteDocument');
    const doc = await this.getDocument(id, { tenantId });
    if (!doc) return false;
    const index = await this.vectors.index(VEC_INDEX);
    for (const chunkId of doc.chunkIds) {
      await this.chunks.delete(chunkId);
      await index.remove(chunkId);
    }
    await this.vectors.persist(VEC_INDEX);
    await this.docs.delete(id);
    await emitPlainEnveloped(
      this.api.bus,
      KnowledgeEvents.DocumentDeleted,
      { docId: id, tenantId },
      { source: KNOWLEDGE_EVENT_SOURCE, tenantId, entityId: id, correlationId: `knowledge:delete:${id}` },
    );
    return true;
  }

  /** Semantic retrieval — embeds query and pulls top-K chunks with docs.
   *
   * T-06 tenant scoping, made unconditional by S-1: `opts.tenantId` is
   * REQUIRED and is resolved (or refused) BEFORE any embedding, vector search,
   * or storage read happens. Candidates are filtered by tenant BEFORE ranking
   * and every returned chunk/document is re-verified to belong to that tenant
   * (fail-closed: a row that is missing, or carries a different/missing tenant
   * id, is never returned). The legacy "no tenant id ⇒ unscoped system-level
   * retrieval" mode is removed: there is no all-tenant retrieval any more.
   */
  async retrieve(query: string, opts: RetrievalOptions = {}): Promise<RetrievalHit[]> {
    const tenantId = this.requireTenant(opts.tenantId, 'retrieve');
    const topK = opts.topK ?? 5;
    const hits = await this.vectors.embedAndSearch(VEC_INDEX, query, {
      topK,
      minScore: opts.minScore,
      // S-1: the tenant is now enforced IN the vector layer (candidates are
      // restricted before ranking, and untagged vectors are never returned) in
      // addition to the caller-side metadata filter and the chunk/document
      // re-verification below — three independent gates, none of which can be
      // skipped by a tenantless call.
      tenantId,
      filter: opts.filter ? (m) => matchesFilter(m, opts.filter!) : undefined,
    });

    const results: RetrievalHit[] = [];
    const seenDocs = new Set<string>();
    for (const h of hits) {
      const docId = (h.metadata?.docId as string) ?? h.id.split(':')[0]!;
      if (opts.documentIds && !opts.documentIds.includes(docId)) continue;
      const [chunk, doc] = await Promise.all([
        this.chunks.get(h.id),
        this.docs.get<Document>(docId),
      ]);
      if (!chunk || !doc) continue;
      // Fail closed: a tenant-scoped retrieval must never surface another
      // tenant's (or untagged, legacy) knowledge, even if the vector index
      // somehow contained it. Unconditional since S-1: every retrieval has a
      // resolved tenant.
      if (chunk.tenantId !== tenantId || doc.tenantId !== tenantId) continue;
      let finalChunks = [chunk];
      if (opts.expandContext) {
        const window = opts.contextWindow ?? 1;
        const ctx: Chunk[] = [];
        for (let i = -window; i <= window; i++) {
          if (i === 0) continue;
          const neighborId = `${docId}:${chunk.index + i}`;
          const n = await this.chunks.get(neighborId);
          if (n && n.documentId === docId) ctx.push(n);
        }
        finalChunks = [...ctx.filter((c) => c.index < chunk.index), chunk, ...ctx.filter((c) => c.index > chunk.index)];
      }
      for (const c of finalChunks) {
        if (!seenDocs.has(c.id)) {
          results.push({ chunk: c, document: doc, score: c.id === h.id ? h.score : h.score * 0.9, source: 'vector' });
          seenDocs.add(c.id);
        }
      }
    }

    // The retrieval audit event is tenant-attributed: an unattributed audit
    // record cannot be reasoned about per tenant (S-1 auditability).
    await emitPlainEnveloped(
      this.api.bus,
      KnowledgeEvents.Retrieved,
      { query, returned: results.length, tenantId },
      { source: KNOWLEDGE_EVENT_SOURCE, tenantId, correlationId: `knowledge:retrieve:${tenantId}` },
    );
    return results;
  }

  /**
   * Count documents and chunks for ONE tenant (S-1: tenant required).
   *
   * The legacy tenantless mode returned cross-tenant global totals; it is
   * removed. A missing/blank tenant is refused before any storage read.
   */
  async stats(opts: { tenantId?: string } = {}): Promise<{ documents: number; chunks: number }> {
    const tenantId = this.requireTenant(opts.tenantId, 'stats');
    const list = await this.docs.list();
    const docs = list.items.filter((e) => (e.value as Document | undefined)?.tenantId === tenantId).length;
    const chunkRows = await this.chunks.query({ where: (c) => c.tenantId === tenantId });
    return { documents: docs, chunks: chunkRows.length };
  }
}

function matchesFilter(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  if (!metadata) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (metadata[k] !== v) return false;
  }
  return true;
}

/** Generate a new id (exposed for tests/tooling). */
export function newId(): string {
  return randomUUID();
}
