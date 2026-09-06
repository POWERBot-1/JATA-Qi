export { KnowledgeService, newId, KNOWLEDGE_EVENT_SOURCE } from './knowledge-module.js';
export {
  TenantContextError,
  TENANT_CONTEXT_REQUIRED,
  isDefaultTenantFallbackAuthorized,
  isTenantId,
  resolveTenantContext,
} from './tenant-context.js';
export type { ResolveTenantContextOptions, TenantContextLogger } from './tenant-context.js';
export { chunkText } from './chunker.js';
export type { ChunkOptions } from './chunker.js';
export { DEFAULT_TENANT_ID, KnowledgeEvents } from './types.js';
export type {
  Document,
  Chunk,
  RetrievalHit,
  RetrievalOptions,
  IngestOptions,
} from './types.js';
