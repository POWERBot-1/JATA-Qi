export { VectorSearchModule } from './vector-module.js';
export type { VectorModuleConfig } from './vector-module.js';
export { FlatIndex } from './flat-index.js';
export { HashEmbeddingModel, OpenAIEmbeddingModel } from './embeddings.js';
export type { RemoteEmbeddingConfig } from './embeddings.js';
export * from './distance.js';
export { VectorEvents } from './types.js';
export type {
  IEmbeddingModel,
  IVectorIndex,
  IndexStats,
  SearchHit,
  SearchOptions,
  Vector,
  VectorMetric,
  VectorRecord,
} from './types.js';

// S-1: tenant-context refusal type for the vector layer (strict: no default-tenant fallback).
export { TenantContextError, TENANT_CONTEXT_REQUIRED, isTenantId } from './tenant-context.js';
