export { KnowledgeGraphModule } from './graph-module.js';
export type { KnowledgeGraphConfig } from './graph-module.js';
export { MemoryTripleStore } from './graph-store.js';
export type { ITripleStore } from './graph-store.js';
export { createEntity, createTriple } from './factories.js';
export type { EntityInput, TripleInput } from './factories.js';
export { HeuristicExtractor } from './extractor.js';
export type { Extractor, ExtractionResult } from './extractor.js';
export { GraphRAGRetriever } from './graph-rag.js';
export type { GraphRAGHit, GraphRAGOptions } from './graph-rag.js';
export { GraphEvents } from './types.js';
export type {
  Entity,
  EntityId,
  GraphStats,
  Path,
  Relation,
  RelationType,
  TraversalOptions,
  TraversalStep,
  Triple,
  TripleId,
} from './types.js';
