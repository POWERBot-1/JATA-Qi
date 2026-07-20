// Built-in tools wired to knowledge service, knowledge graph, and storage.

import type { Tool, ToolContext } from './tools.js';
import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import type { VectorSearchModule } from '@jataqi/vector-search';

/** knowledge.search — semantic retrieval over documents. */
export function knowledgeSearchTool(getService: () => KnowledgeService): Tool {
  return {
    name: 'knowledge.search',
    description: 'Search the knowledge base semantically. Returns relevant text chunks with document metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language question or keywords.' },
        topK: { type: 'number', description: 'Number of results (default 5).' },
        minScore: { type: 'number', description: 'Minimum similarity score 0..1.' },
      },
      required: ['query'],
    },
    async execute(input: any, ctx: ToolContext) {
      const svc = getService();
      const hits = await svc.retrieve(String(input.query ?? ''), {
        topK: Number(input.topK ?? 5),
        minScore: input.minScore != null ? Number(input.minScore) : undefined,
        expandContext: true,
        contextWindow: 1,
      });
      ctx.logger.info(`knowledge.search returned ${hits.length} hits for "${input.query}"`);
      return hits.map((h) => ({
        chunkId: h.chunk.id,
        documentId: h.document.id,
        title: h.document.title,
        score: h.score,
        source: h.source,
        text: h.chunk.text,
        metadata: h.document.metadata,
      }));
    },
  };
}

/** graph.traverse — walk the knowledge graph from an entity id. */
export function graphTraverseTool(getGraph: () => KnowledgeGraphModule): Tool {
  return {
    name: 'graph.traverse',
    description: 'Traverse the knowledge graph starting from an entity id to discover related entities.',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'Entity id (e.g. ent:alice, doc:<id>).' },
        maxDepth: { type: 'number', description: 'Max hops (default 2).' },
        followPredicates: { type: 'string', description: 'Comma-separated predicates to follow.' },
      },
      required: ['entityId'],
    },
    async execute(input: any, ctx: ToolContext) {
      const g = getGraph();
      const predicates = input.followPredicates
        ? String(input.followPredicates).split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;
      const paths = g.traverse(String(input.entityId), {
        maxDepth: Number(input.maxDepth ?? 2),
        followPredicates: predicates,
      });
      ctx.logger.info(`graph.traverse from ${input.entityId}: ${paths.length} paths`);
      return paths.map((p) => ({
        entities: p.entities.map((e) => ({ id: e.id, name: e.name, type: e.type })),
        predicates: p.triples.map((t) => t.predicate),
        score: p.score,
      }));
    },
  };
}

/** graph.findEntity — semantic entity search. */
export function graphFindEntityTool(getGraph: () => KnowledgeGraphModule): Tool {
  return {
    name: 'graph.findEntity',
    description: 'Find entities in the knowledge graph by semantic similarity to a query string.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Entity description or name.' },
        topK: { type: 'number', description: 'Max results (default 5).' },
        type: { type: 'string', description: 'Optional entity type filter.' },
      },
      required: ['query'],
    },
    async execute(input: any, ctx: ToolContext) {
      const g = getGraph();
      const hits = await g.findEntities(String(input.query), {
        topK: Number(input.topK ?? 5),
        type: input.type != null ? String(input.type) : undefined,
      });
      ctx.logger.info(`graph.findEntity returned ${hits.length} for "${input.query}"`);
      return hits.map((h) => ({ id: h.entity.id, name: h.entity.name, type: h.entity.type, score: h.score }));
    },
  };
}

/** graph.retrieve — hybrid graph-RAG retrieval. */
export function graphRetrieveTool(getGraph: () => KnowledgeGraphModule): Tool {
  return {
    name: 'graph.retrieve',
    description: 'Retrieve knowledge combining vector search with graph expansion (graph-RAG).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'number' },
        graphDepth: { type: 'number' },
      },
      required: ['query'],
    },
    async execute(input: any, ctx: ToolContext) {
      const g = getGraph();
      const hits = await g.graphRetrieve(String(input.query), {
        topK: Number(input.topK ?? 5),
        graphDepth: Number(input.graphDepth ?? 1),
      });
      ctx.logger.info(`graph.retrieve returned ${hits.length} hits`);
      return hits.map((h) => ({
        chunkId: h.chunk.id,
        documentId: h.document.id,
        text: h.chunk.text,
        combinedScore: h.combinedScore,
        entities: h.entities.map((e) => ({ id: e.id, name: e.name, type: e.type })),
      }));
    },
  };
}

/** vector.search — raw vector search over a named index. */
export function vectorSearchTool(getVectors: () => VectorSearchModule): Tool {
  return {
    name: 'vector.search',
    description: 'Run a raw semantic vector search against a named vector index.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'string', description: 'Index name (default knowledge.chunks).' },
        query: { type: 'string' },
        topK: { type: 'number' },
      },
      required: ['query'],
    },
    async execute(input: any) {
      const v = getVectors();
      const idx = String(input.index ?? 'knowledge.chunks');
      return v.embedAndSearch(idx, String(input.query), { topK: Number(input.topK ?? 5) });
    },
  };
}
