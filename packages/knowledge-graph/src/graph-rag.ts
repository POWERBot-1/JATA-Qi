// Graph-Retriever: combines vector (semantic) retrieval with graph expansion.
// Strategy:
//   1. Find relevant chunks via vector search.
//   2. Pull entities linked to those chunks (via Chunk-Mentions-Entity edges).
//   3. Traverse outward from those entities to discover related knowledge.
//   4. Interleave vector hits with graph-neighbor chunks, re-score by combined evidence.

import type { KernelApi } from '@jataqi/core-kernel';
import type { RetrievalHit, RetrievalOptions } from '@jataqi/knowledge-service';
import { KnowledgeService } from '@jataqi/knowledge-service';
import type { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeGraphModule } from './graph-module.js';
import type { Entity, Path, Triple } from './types.js';

export interface GraphRAGOptions extends RetrievalOptions {
  /** Max entity traversal depth from a retrieved chunk (default 1). */
  graphDepth?: number;
  /** Weight for graph-based score contribution (0..1); default 0.3. */
  graphWeight?: number;
  /** Predicates to follow during expansion (default: all). */
  expandPredicates?: string[];
  /** Max additional chunks to pull from graph neighbors. */
  graphTopK?: number;
}

export interface GraphRAGHit extends RetrievalHit {
  /** Entities connected to this hit. */
  entities: Entity[];
  /** Graph paths that contributed to this hit. */
  paths?: Path[];
  /** 0..1 combined score across vector and graph evidence. */
  combinedScore: number;
}

export class GraphRAGRetriever {
  constructor(private readonly api: KernelApi) {}

  async retrieve(query: string, opts: GraphRAGOptions = {}): Promise<GraphRAGHit[]> {
    const svc = this.api.getModule<KnowledgeService>('knowledge');
    const graph = this.api.getModule<KnowledgeGraphModule>('knowledge-graph');
    const vecs = this.api.getModule<VectorSearchModule>('vector-search');

    const topK = opts.topK ?? 5;
    const depth = opts.graphDepth ?? 1;
    const gWeight = opts.graphWeight ?? 0.3;
    const graphTopK = opts.graphTopK ?? topK * 2;

    // 1. Vector retrieval.
    const vectorHits = await svc.retrieve(query, { ...opts, topK: topK + graphTopK });

    // 2. Find entities "mentioned" in the retrieved chunks.
    // Convention: triples with predicate 'mentions' link chunkId → entityId.
    const entityScores = new Map<string, number>();
    const hitEntities = new Map<string, Entity[]>(); // keyed by chunkId
    for (const h of vectorHits) {
      const chunkEntityId = `chunk:${h.chunk.id}`;
      const docEntityId = `doc:${h.document.id}`;
      const found = new Map<string, Entity>();

      // Direct chunk->entity edges.
      for (const t of graph.triplesFrom(chunkEntityId, 'mentions')) {
        const e = graph.getEntity(t.object);
        if (e) found.set(e.id, e);
      }
      // Also link document-level entities.
      for (const t of graph.triplesFrom(docEntityId)) {
        const e = graph.getEntity(t.object);
        if (e) found.set(e.id, e);
      }
      // Also support the reverse: entity appears_in chunk/doc.
      for (const t of graph.triplesTo(chunkEntityId, 'appearsIn')) {
        const e = graph.getEntity(t.subject);
        if (e) found.set(e.id, e);
      }
      const ents = [...found.values()];
      hitEntities.set(h.chunk.id, ents);
      for (const e of ents) {
        entityScores.set(e.id, Math.max(entityScores.get(e.id) ?? 0, h.score));
      }
    }

    // 3. Traverse outward from high-scoring entities and collect related entities.
    const extraChunks = new Map<string, { score: number; paths: Path[] }>();
    const graphEntityToHits = new Map<string, Path[]>();
    for (const [eid, baseScore] of entityScores) {
      const paths = graph.traverse(eid, {
        maxDepth: depth,
        followPredicates: opts.expandPredicates,
        limit: 5,
      });
      for (const p of paths) {
        const terminal = p.entities[p.entities.length - 1]!;
        // Find chunks linked to this terminal entity via appearsIn/mentions.
        const docTriples: Triple[] = [
          ...graph.triplesTo(terminal.id, 'mentions'),
          ...graph.triplesFrom(terminal.id, 'appearsIn'),
        ];
        for (const t of docTriples) {
          const chunkId = t.predicate === 'mentions' ? t.subject : t.object;
          // Only consider chunk ids we know about: resolve through knowledge service.
          const chunk = await svc.getChunk(chunkId.startsWith('chunk:') ? chunkId.slice(6) : chunkId);
          if (!chunk) continue;
          const doc = await svc.getDocument(chunk.documentId);
          if (!doc) continue;
          const existing = extraChunks.get(chunk.id);
          const s = baseScore * p.score * (t.confidence ?? 1.0);
          if (!existing || s > existing.score) {
            extraChunks.set(chunk.id, { score: s, paths: [p] });
          } else {
            existing.paths.push(p);
          }
          (graphEntityToHits.get(chunk.id) ?? graphEntityToHits.set(chunk.id, []).get(chunk.id)!).push(p);
        }
      }
    }

    // 4. Merge vector hits with graph-extra chunks, re-score.
    const merged = new Map<string, GraphRAGHit>();
    for (const h of vectorHits) {
      const entities = hitEntities.get(h.chunk.id) ?? [];
      const bonus = extraChunks.get(h.chunk.id)?.score ?? 0;
      const combined = Math.min(1, h.score * (1 - gWeight) + bonus * gWeight);
      merged.set(h.chunk.id, {
        ...h,
        entities,
        paths: extraChunks.get(h.chunk.id)?.paths,
        combinedScore: combined,
        source: 'hybrid',
      });
    }
    for (const [cid, info] of extraChunks) {
      if (merged.has(cid)) continue;
      const chunk = await svc.getChunk(cid.startsWith('chunk:') ? cid.slice(6) : cid);
      if (!chunk) continue;
      const doc = await svc.getDocument(chunk.documentId);
      if (!doc) continue;
      const entities = collectEntitiesForChunk(graph, chunk.id);
      merged.set(cid, {
        chunk,
        document: doc,
        score: info.score,
        entities,
        paths: info.paths,
        combinedScore: info.score * gWeight,
        source: 'graph',
      });
    }

    // 5. Sort by combinedScore and apply topK.
    const all = [...merged.values()].sort((a, b) => b.combinedScore - a.combinedScore);
    return all.slice(0, topK + graphTopK).slice(0, topK + graphTopK);
  }
}

function collectEntitiesForChunk(graph: KnowledgeGraphModule, chunkId: string): Entity[] {
  const found = new Map<string, Entity>();
  const cid = chunkId.startsWith('chunk:') ? chunkId : `chunk:${chunkId}`;
  for (const t of graph.triplesFrom(cid, 'mentions')) {
    const e = graph.getEntity(t.object);
    if (e) found.set(e.id, e);
  }
  for (const t of graph.triplesTo(cid, 'appearsIn')) {
    const e = graph.getEntity(t.subject);
    if (e) found.set(e.id, e);
  }
  return [...found.values()];
}
