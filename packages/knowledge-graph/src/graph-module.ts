import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { payloadOf, SYSTEM_TENANT } from '@jataqi/core-kernel';
import type { EventEnvelope } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { DEFAULT_TENANT_ID, KNOWLEDGE_EVENT_SOURCE, KnowledgeEvents, KnowledgeService } from '@jataqi/knowledge-service';
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
  /**
   * S-1/B-3 — EXPLICIT migration attribution for durable graph rows that carry
   * no tenant tag.
   *
   * Untagged tenant-sensitive rows are never silently turned into
   * `DEFAULT_TENANT_ID` data. Without this option they are QUARANTINED: not
   * loaded into any tenant store, reported through `quarantineReport()` and a
   * structured WARN, and written back verbatim (still untagged) by `persist()`
   * so quarantine is non-destructive.
   *
   * Setting a real tenant id here is an operator's explicit, auditable
   * attribution decision for a legacy snapshot. The reserved
   * `DEFAULT_TENANT_ID` and blank values are rejected at construction.
   */
  untaggedRowTenant?: string;
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
  /** S-1/B-3: durable rows with no tenant tag. Never loaded into a tenant store. */
  private readonly quarantinedEntities: PersistedEntity[] = [];
  private readonly quarantinedTriples: PersistedTriple[] = [];
  /** S-1/B-3: rows attributed by the explicit `untaggedRowTenant` migration option. */
  private attributedUntaggedRows = 0;

  /** Swap the extractor (e.g. for an LLM-based one). */
  setExtractor(extractor: Extractor): void {
    this.extractor = extractor;
  }

  constructor(cfg: KnowledgeGraphConfig = {}) {
    this.cfg = { autoIndexDocuments: true, ...cfg };
    const attribution = this.cfg.untaggedRowTenant;
    if (attribution !== undefined) {
      if (typeof attribution !== 'string' || attribution.trim().length === 0) {
        throw new Error(
          'KnowledgeGraphModule: untaggedRowTenant must be a non-blank tenant id. Untagged durable rows are ' +
            'quarantined, never attributed to a blank tenant. Failing closed.',
        );
      }
      if (attribution === DEFAULT_TENANT_ID) {
        throw new Error(
          `KnowledgeGraphModule: untaggedRowTenant may not be the reserved DEFAULT_TENANT_ID ("${DEFAULT_TENANT_ID}"). ` +
            'Attributing untagged rows to the shared default bucket is exactly the silent ownership assignment S-1 ' +
            'removes. Failing closed.',
        );
      }
    }
  }

  /**
   * T-08.1 D: tenant fallback guard. When tenantId is missing we warn via
   * observability and, outside explicit test-compat mode, fail closed. Only
   * `JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK=1` or
   * `JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK=1` authorizes the isolated
   * DEFAULT_TENANT_ID store; no NODE_ENV value may authorize it.
   */
  private resolveTenantId(tenantId: string | undefined, op = 'storeFor'): string {
    if (tenantId !== undefined && tenantId !== null && String(tenantId).trim()) return tenantId;
    const allow = process.env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK === '1' || process.env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK === '1';
    const message = `KnowledgeGraphModule: ${op} tenantId missing — falling back to DEFAULT_TENANT_ID="${DEFAULT_TENANT_ID}" (test-only fail-safe)`;
    try {
      this.api?.logger?.warn?.(message, { fallbackTenantId: DEFAULT_TENANT_ID, op } as any);
    } catch {
      console.warn(message);
    }
    if (!allow) throw new Error(`${message}. Provide tenantId or set JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK=1 for test-only compat. Failing closed.`);
    return DEFAULT_TENANT_ID;
  }

  /**
   * S-1: resolve a tenant for a graph read, or refuse (K1 semantics, exported
   * for the graph-RAG retriever so it can fail closed BEFORE any lookup).
   */
  requireTenant(tenantId: string | undefined, op = 'requireTenant'): string {
    return this.resolveTenantId(tenantId, op);
  }

  /** Resolve (creating when needed) the in-memory store for a tenant. */
  storeFor(tenantId?: string): MemoryTripleStore {
    // S-1: a blank/whitespace tenant is AMBIGUOUS, not a distinct tenant. It is
    // routed through the same fail-closed guard as a missing one, so no caller
    // can mint an '' store beside the real per-tenant stores (which would be an
    // unowned bucket able to persist rows with a blank tenant tag).
    const resolved = typeof tenantId === 'string' && tenantId.trim().length > 0
      ? tenantId
      : this.resolveTenantId(tenantId, 'storeFor');
    let store = this.stores.get(resolved);
    if (!store) {
      store = new MemoryTripleStore();
      this.stores.set(resolved, store);
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
    // S-1/B-2: the ambient `graph.store` container value (a live, writable
    // DEFAULT_TENANT_ID store handed to any resolver, bypassing the fail-closed
    // guard) is REMOVED. There is no unscoped store handle any more: a store is
    // only reachable through `storeFor(tenantId)`, which fails closed without an
    // unambiguous tenant, so a tenantless caller cannot obtain a privileged
    // default-tenant handle to write (and persist) another tenant's graph.
    kernel.container.registerValue('graph.module', this);
    await this.loadFromStorage();

    if (this.cfg.autoIndexDocuments) {
      // When documents are ingested into knowledge service, automatically create
      // a Document entity (in the DOCUMENT'S tenant store — never the caller's
      // or a shared store) and link it to its chunks.
      //
      // S-1/V-1: the event is treated as UNTRUSTED input. Independent
      // verification showed that a forged `knowledge.document.ingested` emit
      // carrying another tenant's docId and the attacker's tenantId used the
      // then-unscoped `getDocument()` read to plant the foreign document's
      // title and metadata in the attacker's graph. Three controls now apply,
      // in order, each fail-closed and audited:
      //   1. producer attestation — the envelope must be produced by the
      //      knowledge service (a plain `bus.emit` is bridged as
      //      `legacy-bridge` and is refused);
      //   2. tenant binding — the envelope must carry a non-blank, non-system
      //      tenant and the payload must not contradict it (ambiguity refuses);
      //   3. authoritative corroboration — the document is re-read SCOPED to
      //      that tenant, so a foreign document id resolves to nothing and no
      //      metadata can be disclosed. This is the control that actually
      //      prevents cross-tenant disclosure: an in-process caller holding the
      //      bus can forge `source`, but it cannot make another tenant's
      //      document resolve inside its own tenant.
      kernel.bus.onEnveloped(KnowledgeEvents.DocumentIngested, async (_topic, envelope) => {
        const decision = authorizeDocumentIngestedEvent(envelope);
        if (!decision.ok) {
          kernel.logger.warn(
            `knowledge graph: refused knowledge.document.ingested (${decision.reason}); no entity was created and no document was read`,
            { reason: decision.reason, topic: KnowledgeEvents.DocumentIngested, envelopeId: envelope.id, source: envelope.source } as any,
          );
          return;
        }
        const svc = kernel.getModule<KnowledgeService>('knowledge');
        // Scoped read: undefined unless the attested tenant OWNS the document.
        const doc = await svc.getDocument(decision.docId, { tenantId: decision.tenantId });
        if (!doc || doc.tenantId !== decision.tenantId) {
          kernel.logger.warn(
            'knowledge graph: refused knowledge.document.ingested (document is not owned by the attested tenant); ' +
              'no cross-tenant read or metadata disclosure was performed',
            { reason: 'foreign-or-missing-document', docId: decision.docId, tenantId: decision.tenantId } as any,
          );
          return;
        }
        this.addOrGetEntity({
          id: `doc:${doc.id}`,
          type: 'Document',
          name: doc.title ?? doc.id,
          properties: { docId: doc.id, ...(doc.metadata ?? {}) },
        }, decision.tenantId);
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
    const resolved = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'addEntity');
    const store = this.storeFor(resolved);
    const existing = store.getEntity(input.id);
    const ent = store.upsertEntity(createEntity(input));
    void this.api.bus.emit(existing ? GraphEvents.EntityUpdated : GraphEvents.EntityAdded, { id: ent.id, type: ent.type, tenantId: resolved });
    return ent;
  }

  /** Convenience: add entity only if it doesn't exist. Returns existing or new. */
  addOrGetEntity(input: Omit<Entity, 'createdAt' | 'updatedAt'>, tenantId?: string): Entity {
    const resolved = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'addOrGetEntity');
    const store = this.storeFor(resolved);
    const existing = store.getEntity(input.id);
    if (existing) return existing;
    return this.addEntity(input, resolved);
  }

  getEntity(id: EntityId, tenantId?: string): Entity | undefined {
    // getEntity delegates to storeFor which already warns on missing tenant
    return this.storeFor(tenantId).getEntity(id);
  }

  removeEntity(id: EntityId, tenantId?: string): boolean {
    const resolved = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'removeEntity');
    const store = this.storeFor(resolved);
    const removed = store.removeEntity(id);
    if (removed) {
      void this.api.bus.emit(GraphEvents.EntityRemoved, { id, tenantId: resolved });
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
    const resolved = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'addTriple');
    const store = this.storeFor(resolved);
    const t = store.addTriple(createTriple(input));
    void this.api.bus.emit(GraphEvents.TripleAdded, { id: t.id, subject: t.subject, predicate: t.predicate, object: t.object, tenantId: resolved });
    return t;
  }

  removeTriple(id: TripleId, tenantId?: string): boolean {
    const resolved = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'removeTriple');
    const store = this.storeFor(resolved);
    const removed = store.removeTriple(id);
    if (removed) {
      void this.api.bus.emit(GraphEvents.TripleRemoved, { id, tenantId: resolved });
    }
    return removed;
  }

  traverse(start: EntityId, opts?: TraversalOptions, tenantId?: string): Path[] {
    const resolved = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'traverse');
    const store = this.storeFor(resolved);
    const paths = store.traverse(start, opts);
    void this.api.bus.emit(GraphEvents.Traversed, { start, returned: paths.length, tenantId: resolved });
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
    const tenant = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'embedEntity');
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
    const tenant = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'extractFromText');
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
    const tenant = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'linkMention');
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
    const tenant = tenantId !== undefined ? tenantId : this.resolveTenantId(undefined, 'findEntities');
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
    // S-1/B-3: quarantined (untagged) rows are written back VERBATIM — still
    // untagged — so quarantine never loses data and never canonizes an
    // unauthorized owner. Only rows held in a tenant store are tenant-tagged.
    await this.entitiesCol.replaceAll([...entRows, ...this.quarantinedEntities]);
    await this.triplesCol.replaceAll([...tripRows, ...this.quarantinedTriples]);
  }

  /**
   * S-1/B-3: read-only audit report of durable graph rows that carry no tenant
   * tag. They are quarantined — invisible to every tenant, including the
   * reserved default bucket — until an operator attributes them explicitly
   * through `KnowledgeGraphConfig.untaggedRowTenant`.
   */
  quarantineReport(): {
    entities: number;
    triples: number;
    entityRowIds: string[];
    tripleRowIds: string[];
    attributedToTenant?: string;
    attributedRows: number;
  } {
    return {
      entities: this.quarantinedEntities.length,
      triples: this.quarantinedTriples.length,
      entityRowIds: this.quarantinedEntities.map((r) => r.id).slice(0, 50),
      tripleRowIds: this.quarantinedTriples.map((r) => r.id).slice(0, 50),
      ...(this.cfg.untaggedRowTenant ? { attributedToTenant: this.cfg.untaggedRowTenant } : {}),
      attributedRows: this.attributedUntaggedRows,
    };
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
    const attribution = this.cfg.untaggedRowTenant;
    for (const row of await this.entitiesCol.all()) {
      const tenant = this.resolveRowTenant(row.tenantId, '__kg__.entities', row.id, attribution);
      if (tenant === undefined) {
        this.quarantinedEntities.push(row);
        continue;
      }
      const id = tenantIdFromComposite(row.tenantId, row.id);
      const { tenantId: _t, id: _id, ...rest } = row;
      const entity: Entity = { ...rest, id };
      this.storeFor(tenant).upsertEntity(entity);
    }
    for (const row of await this.triplesCol.all()) {
      const tenant = this.resolveRowTenant(row.tenantId, '__kg__.triples', row.id, attribution);
      if (tenant === undefined) {
        this.quarantinedTriples.push(row);
        continue;
      }
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
    const quarantined = this.quarantinedEntities.length + this.quarantinedTriples.length;
    if (quarantined > 0) {
      // Auditable refusal: untagged tenant-sensitive rows never become
      // authoritative default-tenant data (S-1/B-3).
      this.api?.logger?.warn?.(
        `knowledge graph: quarantined ${quarantined} durable row(s) with no tenant tag — they are invisible to every ` +
          'tenant (including the reserved default bucket) until explicitly attributed via untaggedRowTenant',
        {
          quarantinedEntities: this.quarantinedEntities.length,
          quarantinedTriples: this.quarantinedTriples.length,
          entityRowIds: this.quarantinedEntities.map((r) => r.id).slice(0, 20),
          tripleRowIds: this.quarantinedTriples.map((r) => r.id).slice(0, 20),
        } as any,
      );
    }
    if (this.attributedUntaggedRows > 0) {
      this.api?.logger?.warn?.(
        `knowledge graph: attributed ${this.attributedUntaggedRows} untagged durable row(s) to tenant ` +
          `"${attribution}" because untaggedRowTenant was explicitly configured (migration attribution)`,
        { attributedToTenant: attribution, rows: this.attributedUntaggedRows } as any,
      );
    }
  }

  /**
   * S-1/B-3: tenant for one durable row. A tagged row keeps its tag; an
   * untagged row is attributed ONLY through the explicit operator migration
   * option, otherwise it is quarantined (undefined) instead of silently
   * becoming `DEFAULT_TENANT_ID` data.
   */
  private resolveRowTenant(
    rowTenantId: string | undefined,
    collection: string,
    rowId: string,
    attribution: string | undefined,
  ): string | undefined {
    if (typeof rowTenantId === 'string' && rowTenantId.trim().length > 0) return rowTenantId;
    if (attribution !== undefined) {
      this.attributedUntaggedRows += 1;
      return attribution;
    }
    this.api?.logger?.debug?.(`knowledge graph: untagged row quarantined (${collection} ${rowId})` as any);
    return undefined;
  }
}

/** Strip the composite (tenant, id) prefix from a persisted row id. */
function tenantIdFromComposite(rowTenantId: string | undefined, rowId: string): string {
  if (rowTenantId === undefined) return rowId;
  if (rowId.startsWith(rowTenantId + TENANT_KEY_SEP)) return rowId.slice(rowTenantId.length + 1);
  return rowId;
}

/** Outcome of authorizing an untrusted `knowledge.document.ingested` envelope (S-1/V-1). */
export type DocumentIngestedAuthorization =
  | { ok: true; docId: string; tenantId: string }
  | { ok: false; reason: 'unattested-source' | 'missing-tenant' | 'system-tenant' | 'tenant-mismatch' | 'missing-doc-id' };

/**
 * Authorize an untrusted ingest event BEFORE any privileged lookup.
 *
 * The event payload is attacker-controllable by anything that can reach the
 * bus, so nothing in it is trusted on its own: the producer must be attested in
 * the envelope, the tenant must be bound to the envelope (a payload tenant may
 * only AGREE with it), and the tenant may not be the kernel `system` tenant.
 * The caller must then corroborate ownership with a tenant-scoped document read.
 */
export function authorizeDocumentIngestedEvent(envelope: EventEnvelope): DocumentIngestedAuthorization {
  if (envelope.source !== KNOWLEDGE_EVENT_SOURCE || envelope.provenance?.source !== KNOWLEDGE_EVENT_SOURCE) {
    return { ok: false, reason: 'unattested-source' };
  }
  const envelopeTenant = envelope.tenantId;
  if (typeof envelopeTenant !== 'string' || envelopeTenant.trim().length === 0) {
    return { ok: false, reason: 'missing-tenant' };
  }
  if (envelopeTenant === SYSTEM_TENANT) {
    return { ok: false, reason: 'system-tenant' };
  }
  const payload = payloadOf<{ docId?: unknown; tenantId?: unknown }>(envelope);
  const payloadTenant = payload?.tenantId;
  if (typeof payloadTenant === 'string' && payloadTenant.trim().length > 0 && payloadTenant !== envelopeTenant) {
    // Ambiguous tenant context: the envelope and its payload disagree.
    return { ok: false, reason: 'tenant-mismatch' };
  }
  const docId = payload?.docId;
  if (typeof docId !== 'string' || docId.trim().length === 0) {
    return { ok: false, reason: 'missing-doc-id' };
  }
  return { ok: true, docId, tenantId: envelopeTenant };
}
