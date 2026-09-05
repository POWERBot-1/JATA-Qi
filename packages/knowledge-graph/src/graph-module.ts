import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { payloadOf } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { KnowledgeEvents, KnowledgeService } from '@jataqi/knowledge-service';
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

interface PersistedEntity extends Entity { id: string; }
interface PersistedTriple extends Triple { id: string; }

export class KnowledgeGraphModule implements IModule {
  readonly id = 'knowledge-graph';
  readonly tags = ['core', 'knowledge', 'graph'] as const;
  readonly dependsOn = ['storage', 'vector-search', 'knowledge'] as const;

  private api!: KernelApi;
  readonly store = new MemoryTripleStore();
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
    kernel.container.registerValue('graph.store', this.store);
    kernel.container.registerValue('graph.module', this);
    await this.loadFromStorage();

    if (this.cfg.autoIndexDocuments) {
      // When documents are ingested into knowledge service, automatically create
      // a Document entity and link it to its chunks.
      // F-01f enveloped cutover: read the ingested-document payload from the
      // envelope (bridge-synthesized while the knowledge producer migrates).
      kernel.bus.onEnveloped(KnowledgeEvents.DocumentIngested, async (_topic, envelope) => {
        const p = payloadOf<{ docId: string }>(envelope);
        const svc = kernel.getModule<KnowledgeService>('knowledge');
        const doc = await svc.getDocument(p.docId);
        if (!doc) return;
        this.addOrGetEntity({
          id: `doc:${doc.id}`,
          type: 'Document',
          name: doc.title ?? doc.id,
          properties: { docId: doc.id, ...(doc.metadata ?? {}) },
        });
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

  // ---- Public API ----

  addEntity(input: Omit<Entity, 'createdAt' | 'updatedAt'> & { createdAt?: number }): Entity {
    const existing = this.store.getEntity(input.id);
    const ent = this.store.upsertEntity(createEntity(input));
    void this.api.bus.emit(existing ? GraphEvents.EntityUpdated : GraphEvents.EntityAdded, { id: ent.id, type: ent.type });
    return ent;
  }

  /** Convenience: add entity only if it doesn't exist. Returns existing or new. */
  addOrGetEntity(input: Omit<Entity, 'createdAt' | 'updatedAt'>): Entity {
    const existing = this.store.getEntity(input.id);
    if (existing) return existing;
    return this.addEntity(input);
  }

  getEntity(id: EntityId): Entity | undefined {
    return this.store.getEntity(id);
  }

  removeEntity(id: EntityId): boolean {
    const removed = this.store.removeEntity(id);
    if (removed) {
      void this.api.bus.emit(GraphEvents.EntityRemoved, { id });
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
  }): Triple {
    const t = this.store.addTriple(createTriple(input));
    void this.api.bus.emit(GraphEvents.TripleAdded, { id: t.id, subject: t.subject, predicate: t.predicate, object: t.object });
    return t;
  }

  removeTriple(id: TripleId): boolean {
    const removed = this.store.removeTriple(id);
    if (removed) {
      void this.api.bus.emit(GraphEvents.TripleRemoved, { id });
    }
    return removed;
  }

  traverse(start: EntityId, opts?: TraversalOptions): Path[] {
    const paths = this.store.traverse(start, opts);
    void this.api.bus.emit(GraphEvents.Traversed, { start, returned: paths.length });
    return paths;
  }

  triplesFrom(subject: EntityId, predicate?: RelationType): Triple[] {
    return this.store.triplesFrom(subject, predicate);
  }
  triplesTo(object: EntityId, predicate?: RelationType): Triple[] {
    return this.store.triplesTo(object, predicate);
  }
  entitiesByType(type: string): Entity[] {
    return this.store.entitiesByType(type);
  }
  allEntities(): Entity[] {
    return this.store.allEntities();
  }
  stats(): GraphStats {
    return this.store.stats();
  }

  /** Embed an entity's name+properties and index it for semantic entity search. */
  async embedEntity(id: EntityId): Promise<void> {
    const e = this.store.getEntity(id);
    if (!e) throw new Error(`KnowledgeGraph: entity "${id}" not found`);
    const text = `${e.name}${e.properties ? ' ' + JSON.stringify(e.properties) : ''}`;
    await this.vectors.embedAndAdd(this.entityIndexName, [
      { id: `entity:${e.id}`, text, metadata: { entityId: e.id, type: e.type } },
    ]);
  }

  /** Extract entities/relations from text and add them to the graph.
   *  Returns the extraction result with ids populated. */
  extractFromText(text: string, source?: { chunkId?: string; documentId?: string }): ExtractionResult {
    const { entities, triples } = this.extractor.extract(text, { source });
    const out: ExtractionResult = { entities: [], triples: [] };
    for (const e of entities) {
      const ent = this.addOrGetEntity({
        id: e.id,
        type: e.type,
        name: e.name,
        properties: e.properties,
      });
      if (e.id !== ent.id) {
        // The addOrGetEntity returned existing; skip adding triple referencing missing.
      }
      out.entities.push(ent);
    }
    for (const t of triples) {
      if (this.store.getEntity(t.subject) && this.store.getEntity(t.object)) {
        const added = this.addTriple({
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          properties: t.properties,
          confidence: t.confidence,
          source: t.source ?? source,
        });
        out.triples.push(added);
      }
    }
    return out;
  }

  /** Graph-augmented retrieval combining vector search with graph traversal. */
  async graphRetrieve(query: string, opts?: GraphRAGOptions): Promise<GraphRAGHit[]> {
    return this.retriever.retrieve(query, opts);
  }

  /** Link a chunk id to an entity via 'mentions' triple. */
  linkMention(chunkId: string, entityId: EntityId, confidence?: number, docId?: string): Triple {
    const chunkEntId = `chunk:${chunkId}`;
    this.addOrGetEntity({ id: chunkEntId, type: 'Chunk', name: chunkId, properties: { chunkId } });
    return this.addTriple({
      subject: chunkEntId,
      predicate: 'mentions',
      object: entityId,
      confidence: confidence ?? 0.9,
      source: docId ? { chunkId, documentId: docId } : { chunkId },
    });
  }

  /** Find entities semantically similar to a query. */
  async findEntities(query: string, opts: { topK?: number; type?: string } = {}): Promise<Array<{ entity: Entity; score: number }>> {
    const hits = await this.vectors.embedAndSearch(this.entityIndexName, query, {
      topK: opts.topK ?? 10,
      filter: opts.type ? (m) => m?.type === opts.type : undefined,
    });
    const out: Array<{ entity: Entity; score: number }> = [];
    for (const h of hits) {
      const eid = h.metadata?.entityId as string | undefined;
      if (!eid) continue;
      const e = this.store.getEntity(eid);
      if (e) out.push({ entity: e, score: h.score });
    }
    return out;
  }

  /** Persist all entities/triples to storage as one snapshot per collection. */
  async persist(): Promise<void> {
    await this.entitiesCol.replaceAll(this.store.allEntities() as PersistedEntity[]);
    await this.triplesCol.replaceAll(this.allTriples() as PersistedTriple[]);
  }

  /** Iterate all triples in the store. */
  allTriples(): Triple[] {
    const out: Triple[] = [];
    for (const e of this.store.allEntities()) {
      for (const t of this.store.triplesFrom(e.id)) out.push(t);
    }
    // Deduplicate by id.
    const seen = new Set<TripleId>();
    return out.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }

  private async loadFromStorage(): Promise<void> {
    for (const e of await this.entitiesCol.all()) this.store.upsertEntity(e);
    for (const t of await this.triplesCol.all()) {
      if (this.store.getEntity(t.subject) && this.store.getEntity(t.object)) {
        this.store.addTriple({
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          properties: t.properties,
          confidence: t.confidence,
          source: t.source,
        });
      }
    }
  }
}
