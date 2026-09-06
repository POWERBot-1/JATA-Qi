import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection, INamespace } from '@jataqi/storage';
import type { VectorSearchModule } from '@jataqi/vector-search';
import { chunkText } from './chunker.js';
import { DEFAULT_TENANT_ID, KnowledgeEvents } from './types.js';
import type {
  Chunk,
  Document,
  IngestOptions,
  RetrievalHit,
  RetrievalOptions,
} from './types.js';

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
   * T-08.1 D: tenant fallback guard — DEFAULT_TENANT_ID is test-only.
   * When `opts.tenantId` is missing we warn via observability and, outside
   * explicit test-compat mode, fail closed. Only an explicit
   * `JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK=1` or
   * `JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK=1` authorizes the fallback;
   * no `NODE_ENV` value (including unset/development/staging) may authorize it.
   */
  private resolveTenantIdForIngest(requested?: string): string {
    if (requested !== undefined && requested !== null && String(requested).trim()) return requested;
    const allow = process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK === '1' || process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK === '1';
    const message = `KnowledgeService: ingestText tenantId missing — falling back to DEFAULT_TENANT_ID="${DEFAULT_TENANT_ID}" (test-only fail-safe)`;
    try {
      this.api?.logger?.warn?.(message, { fallbackTenantId: DEFAULT_TENANT_ID, op: 'ingestText' } as any);
    } catch {
      // logger unavailable during early boot — still surface via console
      console.warn(message);
    }
    if (!allow) throw new Error(`${message}. Provide opts.tenantId or set JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK=1 for test-only compat. Failing closed.`);
    return DEFAULT_TENANT_ID;
  }

  /** Ingest text as a new document, chunk, embed, and index. Returns the Document. */
  async ingestText(text: string, opts: IngestOptions = {}): Promise<Document> {
    if (!text || !text.trim()) throw new Error('ingestText: text is empty');
    const tenantId = this.resolveTenantIdForIngest(opts.tenantId);
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
    await this.api.bus.emit(KnowledgeEvents.DocumentIngested, { docId, tenantId, chunks: storedChunks.length });
    await this.api.bus.emit(KnowledgeEvents.ChunksCreated, { docId, tenantId, chunkIds: doc.chunkIds });
    return doc;
  }

  /**
   * Retrieve a document by id.
   *
   * T-06 tenant scoping: when `opts.tenantId` is given the document is only
   * returned when it belongs to that tenant (cross-tenant and untagged reads
   * fail closed — undefined). Without it this is a system-level read and
   * returns the raw document regardless of tenant.
   */
  async getDocument(id: string, opts: { tenantId?: string } = {}): Promise<Document | undefined> {
    const doc = await this.docs.get<Document>(id);
    if (!doc) return undefined;
    if (opts.tenantId !== undefined && doc.tenantId !== opts.tenantId) return undefined;
    return doc;
  }

  /**
   * Retrieve a chunk by id (same tenant scoping contract as getDocument).
   */
  async getChunk(id: string, opts: { tenantId?: string } = {}): Promise<Chunk | undefined> {
    const chunk = await this.chunks.get(id);
    if (!chunk) return undefined;
    if (opts.tenantId !== undefined && chunk.tenantId !== opts.tenantId) return undefined;
    return chunk;
  }

  /** Delete a document, its chunks, and vectors.
   *  When `opts.tenantId` is given, only that tenant's document is deleted
   *  (a cross-tenant delete request is refused and returns false). */
  async deleteDocument(id: string, opts: { tenantId?: string } = {}): Promise<boolean> {
    const doc = await this.getDocument(id, { tenantId: opts.tenantId });
    if (!doc) return false;
    const index = await this.vectors.index(VEC_INDEX);
    for (const chunkId of doc.chunkIds) {
      await this.chunks.delete(chunkId);
      await index.remove(chunkId);
    }
    await this.vectors.persist(VEC_INDEX);
    await this.docs.delete(id);
    await this.api.bus.emit(KnowledgeEvents.DocumentDeleted, { docId: id, tenantId: doc.tenantId });
    return true;
  }

  /** Semantic retrieval — embeds query and pulls top-K chunks with docs.
   *
   * T-06 tenant scoping: with `opts.tenantId` the vector search filters
   * candidates by tenant BEFORE ranking and every returned chunk/document is
   * re-verified to belong to that tenant (fail-closed: a row that is missing,
   * or carries a different/missing tenant id, is never returned). Without a
   * tenant id the call is unscoped (system-level) and keeps legacy behavior.
   */
  async retrieve(query: string, opts: RetrievalOptions = {}): Promise<RetrievalHit[]> {
    const topK = opts.topK ?? 5;
    const tenantId = opts.tenantId;
    const tenantFilter = tenantId !== undefined ? (m: Record<string, unknown> | undefined) => m?.tenantId === tenantId : undefined;
    const hits = await this.vectors.embedAndSearch(VEC_INDEX, query, {
      topK,
      minScore: opts.minScore,
      filter:
        tenantFilter || opts.filter
          ? (m) => (tenantFilter ? tenantFilter(m) : true) && (opts.filter ? matchesFilter(m, opts.filter!) : true)
          : undefined,
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
      // somehow contained it.
      if (tenantId !== undefined && (chunk.tenantId !== tenantId || doc.tenantId !== tenantId)) continue;
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

    await this.api.bus.emit(KnowledgeEvents.Retrieved, { query, returned: results.length });
    return results;
  }

  /** Count documents and chunks (optionally scoped to one tenant). */
  async stats(opts: { tenantId?: string } = {}): Promise<{ documents: number; chunks: number }> {
    if (opts.tenantId === undefined) {
      return { documents: await this.docs.size(), chunks: await this.chunks.count() };
    }
    const list = await this.docs.list();
    const docs = list.items.filter((e) => (e.value as Document | undefined)?.tenantId === opts.tenantId).length;
    const chunkRows = await this.chunks.query({ where: (c) => c.tenantId === opts.tenantId });
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
