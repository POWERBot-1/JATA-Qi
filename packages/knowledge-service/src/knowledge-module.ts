import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection, INamespace } from '@jataqi/storage';
import type { VectorSearchModule } from '@jataqi/vector-search';
import { chunkText } from './chunker.js';
import { KnowledgeEvents } from './types.js';
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
    this.docs = await storage.namespace(NS_DOCS);
    this.chunks = await storage.collection<Chunk>(COL_CHUNKS);
    this.vectors = kernel.getModule<VectorSearchModule>('vector-search');
    // Ensure the vector index exists (with model dim).
    await this.vectors.index(VEC_INDEX);
    kernel.container.registerValue('knowledge.service', this);
    kernel.logger.info('knowledge service initialized');
  }

  async start(_kernel: KernelApi): Promise<void> {
    /* nothing background */
  }

  async stop(_kernel: KernelApi): Promise<void> {
    /* nothing to release */
  }

  /** Ingest text as a new document, chunk, embed, and index. Returns the Document. */
  async ingestText(text: string, opts: IngestOptions = {}): Promise<Document> {
    if (!text || !text.trim()) throw new Error('ingestText: text is empty');
    const docId = randomUUID();
    const now = Date.now();
    const doc: Document = {
      id: docId,
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
      const full: Chunk = { ...c, id, documentId: docId };
      storedChunks.push(full);
      doc.chunkIds.push(id);
      vecItems.push({
        id,
        text: c.text,
        metadata: {
          docId,
          chunkIndex: c.index,
          ...(doc.metadata ?? {}),
          ...(c.metadata ?? {}),
        },
      });
    }

    await this.docs.set(docId, doc);
    for (const ch of storedChunks) await this.chunks.put(ch);
    await this.vectors.embedAndAdd(VEC_INDEX, vecItems);

    this.api.logger.debug(`ingested doc ${docId} (${storedChunks.length} chunks)`);
    await this.api.bus.emit(KnowledgeEvents.DocumentIngested, { docId, chunks: storedChunks.length });
    await this.api.bus.emit(KnowledgeEvents.ChunksCreated, { docId, chunkIds: doc.chunkIds });
    return doc;
  }

  /** Retrieve a document by id. */
  async getDocument(id: string): Promise<Document | undefined> {
    return this.docs.get<Document>(id);
  }

  /** Retrieve a chunk by id. */
  async getChunk(id: string): Promise<Chunk | undefined> {
    return this.chunks.get(id);
  }

  /** Delete a document, its chunks, and vectors. */
  async deleteDocument(id: string): Promise<boolean> {
    const doc = await this.docs.get<Document>(id);
    if (!doc) return false;
    for (const cid of doc.chunkIds) {
      await this.chunks.delete(cid);
      // FlatIndex doesn't expose remove on the IVectorIndex via module? add remove support.
      const idx = await this.vectors.index(VEC_INDEX);
      await idx.remove(cid);
    }
    await this.docs.delete(id);
    await this.api.bus.emit(KnowledgeEvents.DocumentDeleted, { docId: id });
    return true;
  }

  /** Semantic retrieval — embeds query and pulls top-K chunks with docs. */
  async retrieve(query: string, opts: RetrievalOptions = {}): Promise<RetrievalHit[]> {
    const topK = opts.topK ?? 5;
    const hits = await this.vectors.embedAndSearch(VEC_INDEX, query, {
      topK,
      minScore: opts.minScore,
      filter: opts.filter ? (m) => matchesFilter(m, opts.filter!) : undefined,
    });

    const results: RetrievalHit[] = [];
    const seenDocs = new Set<string>();
    for (const h of hits) {
      const docId = (h.metadata?.docId as string) ?? h.id.split(':')[0]!;
      if (opts.documentIds && !opts.documentIds.includes(docId)) continue;
      const [chunk, doc] = await Promise.all([this.chunks.get(h.id), this.docs.get<Document>(docId)]);
      if (!chunk || !doc) continue;
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

  /** Count documents and chunks. */
  async stats(): Promise<{ documents: number; chunks: number }> {
    return { documents: await this.docs.size(), chunks: await this.chunks.count() };
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
