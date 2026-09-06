import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { payloadOf } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { DEFAULT_TENANT_ID, KnowledgeEvents, KnowledgeService } from '@jataqi/knowledge-service';
import type { VectorSearchModule } from '@jataqi/vector-search';
import { MemoryTripleStore } from './graph-store.js';
import { createEntity, createTriple } from './factories.js';
import { HeuristicExtractor, type Extractor, type ExtractionResult } from './extractor.js';
import { GraphRAGRetriever } from './graph-rag.js';
import type { GraphRAGHit, GraphRAGOptions } from './graph-rag.js';
import { GraphEvents } from './types.js';
import type {
  Entity,
  EntityId,
  GraphStats,
  Path,
  RelationType,
  Triple,
  TripleId,
  TraversalOptions,
} from './types.js';

export interface KnowledgeGraphConfig {
  /** Auto-create entities for ingested documents/chunks when true. */
  autoIndexDocuments?: boolean;
  /** Name of vector index used for entity embeddings. */
  entityIndex?: string;
}

interface PersistedEntity extends Entity { id: string; tenantId?: string; }
interface PersistedTriple extends Triple { id: string; tenantId?: string; }

/**
 * Separator between tenant id and entity/triple id inside persisted snapshot
 * row ids. The persisted row key must be globally unique (PostgreSQL rows are
 * keyed by id across tenants), while the in-store entity/triple id stays
 * tenant-local. '\u0001' is used because PostgreSQL text/jsonb reject 0x00
 * outright, tenant ids may not contain control characters (validated charset
 * [A-Za-z0-9_-]), and parsing splits on the tenant prefix, so the separator
 * can never be confused with content.
 */
const TENANT_KEY_SEP = '\u0001';

function compositeId(tenantId: string, id: string): string {
  return `${tenantId}${TENANT_KEY_SEP}${id}`;
}

export class KnowledgeGraphModule implements IModule {
  readonly id = 'knowledge-graph';
  readonly tags = ['core', 'knowledge', 'graph'] as const;
  readonly dependsOn = ['storage', 'vector-search', 'knowledge'] as const;

  private api!: KernelApi;
  /** Per-tenant in-memory triple stores. Cross-tenant isolation by construction:
   *  there is no single shared store, so one tenant's graph can never be
   *  reached (or propagated to) from another tenant's operations. */
  private readonly stores = new Map<string, MemoryTripleStore>();
  private cfg!: KnowledgeGraphConfig;
  private entitiesCol!: ICollection<PersistedEntity>;
  private triplesCol!: ICollection<PersistedTriple>;
  private vectors!: VectorSearchModule;
  private entityIndexName = 'knowledge-graph.entities';
  private extractor: Extractor = new HeuristicExtractor();
  private retriever!: GraphRAGRetriever;

  /** Swap the extractor (e.g. for an LLM-based one). */
  setExtractor(extractor: Extractor): void {
    this.extractor = extractor;
  }

  constructor(cfg: KnowledgeGraphConfig = {}) {
    this.cfg = { autoIndexDocuments: true, ...cfg };
  }

  /** Backwards-compatible handle to the DEFAULT tenant's store. */
  get store(): MemoryTripleStore {
    return this.storeFor(DEFAULT_TENANT_ID);
  }

  /** Resolve (creating when needed) the in-memory store for a tenant. */
  storeFor(tenantId?: string): MemoryTripleStore {
    const key = tenantId ?? DEFAULT_TENANT_ID;
    let store = this.stores.get(key);
    if (!store) {
      store = new MemoryTripleStore();
      this.stores.set(key, store);
    }
    return store;
  }

  /** All tenant keys currently holding data in memory. */
  tenantKeys(): string[] {
    return [...this.stores.keys()];
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.entitiesCol = await storage.collection<PersistedEntity>('__kg__.entities');
    this.triplesCol = await storage.collection<PersistedTriple>('__kg__.triples');
    this.vectors = kernel.getModule<VectorSearchModule>('vector-search');
    // Restore the known graph entity index when a development snapshot exists.
    await this.vectors.load(this.entityIndexName);
    kernel.container.registerValue('graph.store', this.storeFor(DEFAULT_TENANT_ID));
    kernel.container.registerValue('graph.module', this);
    await this.loadFromStorage();

    if (this.cfg.autoIndexDocuments) {
      // When documents are ingested into knowledge service, automatically create
      // a Document entity (in the DOCUMENT'S tenant store — never the caller's
      // or a shared store) and link it to its chunks.
      // F-01f enveloped cutover: read the ingested-document payload from the
      // envelope (bridge-synthesized while the knowledge producer migrates).
      kernel.bus.onEnveloped(KnowledgeEvents.DocumentIngested, async (_topic, envelope) => {
        const p = payloadOf<{ docId: string; tenantId?: string }>(envelope);
        const tenantId = p.tenantId ?? DEFAULT_TENANT_ID;
        const svc = kernel.getModule<KnowledgeService>('knowledge');
        const doc = await svc.getDocument(p.docId);
        if (!doc) return;
        this.addOrGetEntity({
          id: `doc:${doc.id}`,
          type: 'Document',
          name: doc.title ?? doc.id,
          properties: { docId: doc.id, ...(doc.metadata ?? {}) },
        }, tenantId);
      });
    }
    kernel.logger.info('knowledge graph initialized');
    this.retriever = new GraphRAGRetriever(kernel);
  }

  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }

  async stop(_kernel: KernelApi): Promise<void> {
    // Graph mutation APIs are synchronous. Persist one coherent snapshot during
    // orderly shutdown instead of racing unawaited full-file writes per entity.
    await this.persist();
  }

  // ---- Public API (every operation is tenant-partitioned) ----

  addEntity(input: Omit<Entity, 'createdAt' | 'updatedAt'> & { createdAt?: number }, tenantId?: string): Entity {
    const store = this.storeFor(tenantId);
    const tenant = tenantId ?? DEFAULT_TENANT_ID;
    const existing = store.getEntity(input.id);
    const ent = store.upsertEntity(createEntity(input));
    void this.api.bus.emit(existing ? GraphEvents.EntityUpdated : GraphEvents.EntityAdded, { id: ent.id, type: ent.type, tenantId: tenant });
    return ent;
  }

  /** Convenience: add entity only if it doesn't exist. Returns existing or new. */
  addOrGetEntity(input: Omit<Entity, 'createdAt' | 'updatedAt'>, tenantId?: string): Entity {
    const store = this.storeFor(tenantId);
    const existing = store.getEntity(input.id);
    if (existing) return existing;
    return this.addEntity(input, tenantId);
  }

  getEntity(id: EntityId, tenantId?: string): Entity | undefined {
    return this.storeFor(tenantId).getEntity(id);
  }

  removeEntity(id: EntityId, tenantId?: string): boolean {
    const store = this.storeFor(tenantId);
    const removed = store.removeEntity(id);
    if (removed) {
      void this.api.bus.emit(GraphEvents.EntityRemoved, { id, tenantId: tenantId ?? DEFAULT_TENANT_ID });
    }
    return removed;
  }

  addTriple(input: {
    subject: EntityId;
    predicate: RelationType;
    object: EntityId;
    properties?: Record<string, unknown>;
    confidence?: number;
    source?: { chunkId?: string; documentId?: string };
  }, tenantId?: string): Triple {
    const store = this.storeFor(tenantId);
    const t = store.addTriple(createTriple(input));
    void this.api.bus.emit(GraphEvents.TripleAdded, { id: t.id, subject: t.subject, predicate: t.predicate, object: t.object, tenantId: tenantId ?? DEFAULT_TENANT_ID });
    return t;
  }

  removeTriple(id: TripleId, tenantId?: string): boolean {
    const store = this.storeFor(tenantId);
    const removed = store.removeTriple(id);
    if (removed) {
      void this.api.bus.emit(GraphEvents.TripleRemoved, { id, tenantId: tenantId ?? DEFAULT_TENANT_ID });
    }
    return removed;
  }

  traverse(start: EntityId, opts?: TraversalOptions, tenantId?: string): Path[] {
    const store = this.storeFor(tenantId);
    const paths = store.traverse(start, opts);
    void this.api.bus.emit(GraphEvents.Traversed, { start, returned: paths.length, tenantId: tenantId ?? DEFAULT_TENANT_ID });
    return paths;
  }

  triplesFrom(subject: EntityId, predicate?: RelationType, tenantId?: string): Triple[] {
    return this.storeFor(tenantId).triplesFrom(subject, predicate);
  }
  triplesTo(object: EntityId, predicate?: RelationType, tenantId?: string): Triple[] {
    return this.storeFor(tenantId).triplesTo(object, predicate);
  }
  entitiesByType(type: string, tenantId?: string): Entity[] {
    return this.storeFor(tenantId).entitiesByType(type);
  }
  allEntities(tenantId?: string): Entity[] {
    return this.storeFor(tenantId).allEntities();
  }
  stats(tenantId?: string): GraphStats {
    return this.storeFor(tenantId).stats();
  }

  /** Embed an entity's name+properties and index it for semantic entity search
   *  (index rows are tenant-partitioned: id and metadata carry the tenant). */
  async embedEntity(id: EntityId, tenantId?: string): Promise<void> {
    const tenant = tenantId ?? DEFAULT_TENANT_ID;
    const e = this.storeFor(tenant).getEntity(id);
    if (!e) throw new Error(`KnowledgeGraph: entity "${id}" not found`);
    const text = `${e.name}${e.properties ? ' ' + JSON.stringify(e.properties) : ''}`;
    await this.vectors.embedAndAdd(this.entityIndexName, [
      { id: compositeId('entity', compositeId(tenant, e.id)), text, metadata: { tenantId: tenant, entityId: e.id, type: e.type } },
    ]);
  }

  /** Extract entities/relations from text and add them to the graph
   *  (into the tenant's store). Returns the extraction result with ids populated. */
  extractFromText(text: string, source?: { chunkId?: string; documentId?: string }, tenantId?: string): ExtractionResult {
    const tenant = tenantId ?? DEFAULT_TENANT_ID;
    const store = this.storeFor(tenant);
    const { entities, triples } = this.extractor.extract(text, { source });
    const out: ExtractionResult = { entities: [], triples: [] };
    for (const e of entities) {
      const ent = this.addOrGetEntity({
        id: e.id,
        type: e.type,
        name: e.name,
        properties: e.properties,
      }, tenant);
      out.entities.push(ent);
    }
    for (const t of triples) {
      if (store.getEntity(t.subject) && store.getEntity(t.object)) {
        const added = this.addTriple({
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          properties: t.properties,
          confidence: t.confidence,
          source: t.source ?? source,
        }, tenant);
        out.triples.push(added);
      }
    }
    return out;
  }

  /** Graph-augmented retrieval combining vector search with graph traversal.
   *  `opts.tenantId` scopes retrieval (and every knowledge/graph lookup) to
   *  one tenant; cross-tenant knowledge is never reachable. */
  async graphRetrieve(query: string, opts?: GraphRAGOptions): Promise<GraphRAGHit[]> {
    return this.retriever.retrieve(query, opts);
  }

  /** Link a chunk id to an entity via 'mentions' triple (tenant-partitioned). */
  linkMention(chunkId: string, entityId: EntityId, confidence?: number, docId?: string, tenantId?: string): Triple {
    const tenant = tenantId ?? DEFAULT_TENANT_ID;
    const chunkEntId = `chunk:${chunkId}`;
    this.addOrGetEntity({ id: chunkEntId, type: 'Chunk', name: chunkId, properties: { chunkId } }, tenant);
    return this.addTriple({
      subject: chunkEntId,
      predicate: 'mentions',
      object: entityId,
      confidence: confidence ?? 0.9,
      source: docId ? { chunkId, documentId: docId } : { chunkId },
    }, tenant);
  }

  /** Find entities semantically similar to a query (scoped to one tenant). */
  async findEntities(query: string, opts: { topK?: number; type?: string } = {}, tenantId?: string): Promise<Array<{ entity: Entity; score: number }>> {
    const tenant = tenantId ?? DEFAULT_TENANT_ID;
    const hits = await this.vectors.embedAndSearch(this.entityIndexName, query, {
      topK: opts.topK ?? 10,
      tenantId: tenant,
      filter: opts.type ? (m) => m?.type === opts.type : undefined,
    });
    const store = this.storeFor(tenant);
    const out: Array<{ entity: Entity; score: number }> = [];
    for (const h of hits) {
      const eid = h.metadata?.entityId as string | undefined;
      if (!eid) continue;
      const e = store.getEntity(eid);
      if (e) out.push({ entity: e, score: h.score });
    }
    return out;
  }

  /** Persist all tenants' entities/triples to storage as one snapshot per
   *  collection. Rows are keyed by composite (tenant, id) so tenants can never
   *  overwrite each other's snapshot rows. */
  async persist(): Promise<void> {
    const entRows: PersistedEntity[] = [];
    const tripRows: PersistedTriple[] = [];
    for (const [tenant, store] of this.stores) {
      for (const e of store.allEntities()) {
        entRows.push({ ...e, id: compositeId(tenant, e.id), tenantId: tenant });
      }
      for (const t of this.allTriples(tenant)) {
        tripRows.push({ ...t, id: compositeId(tenant, t.id), tenantId: tenant });
      }
    }
    await this.entitiesCol.replaceAll(entRows);
    await this.triplesCol.replaceAll(tripRows);
  }

  /** Iterate all triples in the given tenant's store. */
  allTriples(tenantId?: string): Triple[] {
    const store = this.storeFor(tenantId);
    const out: Triple[] = [];
    for (const e of store.allEntities()) {
      for (const t of store.triplesFrom(e.id)) out.push(t);
    }
    // Deduplicate by id.
    const seen = new Set<TripleId>();
    return out.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }

  private async loadFromStorage(): Promise<void> {
    for (const row of await this.entitiesCol.all()) {
      const tenant = row.tenantId ?? DEFAULT_TENANT_ID;
      const id = tenantIdFromComposite(row.tenantId, row.id);
      const { tenantId: _t, id: _id, ...rest } = row;
      const entity: Entity = { ...rest, id };
      this.storeFor(tenant).upsertEntity(entity);
    }
    for (const row of await this.triplesCol.all()) {
      const tenant = row.tenantId ?? DEFAULT_TENANT_ID;
      const store = this.storeFor(tenant);
      if (store.getEntity(row.subject) && store.getEntity(row.object)) {
        store.addTriple({
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          properties: row.properties,
          confidence: row.confidence,
          source: row.source,
        });
      }
    }
  }
}

/** Strip the composite (tenant, id) prefix from a persisted row id. */
function tenantIdFromComposite(rowTenantId: string | undefined, rowId: string): string {
  if (rowTenantId === undefined) return rowId;
  if (rowId.startsWith(rowTenantId + TENANT_KEY_SEP)) return rowId.slice(rowTenantId.length + 1);
  return rowId;
}
