// Knowledge service domain types.

/**
 * Tenant used when a knowledge operation does not name one. Knowledge is
 * tenant-owned: every ingest/retrieve call resolves to a tenant id, and
 * cross-tenant retrieval fails closed at the service boundary (and at the
 * storage/vector layer underneath). System-level callers that legitimately
 * span tenants must NOT use this module unscoped for retrieval of tenant
 * knowledge; tenant knowledge access requires an explicit tenant id.
 */
export const DEFAULT_TENANT_ID = 'default';

/** Metadata about an ingested source document. */
export interface Document {
  id: string;
  /** Tenant that owns this document (stamped at ingest; part of the row). */
  tenantId?: string;
  /** Stable URI / source reference (URL, path, user-supplied id). */
  uri?: string;
  title?: string;
  /** MIME-like kind: text/plain, text/markdown, application/pdf, etc. */
  contentType: string;
  /** Raw content for text docs; binary documents store blobs separately. */
  text?: string;
  /** User-supplied metadata, indexed for filtering. */
  metadata?: Record<string, unknown>;
  /** When the document was created/updated (ms epoch). */
  createdAt: number;
  updatedAt: number;
  /** Language code (ISO 639-1) when known. */
  lang?: string;
  /** Chunk ids that make up this document. */
  chunkIds: string[];
}

/** A chunk is an atomic retrievable unit — embedded and searched. */
export interface Chunk {
  id: string;
  /** Tenant that owns this chunk (stamped at ingest; part of the row). */
  tenantId?: string;
  documentId: string;
  /** 0-based ordinal within the document. */
  index: number;
  text: string;
  /** Character offsets within the parent document text. */
  startChar: number;
  endChar: number;
  /** Token-ish estimate (words / whitespace splits for default tokenizer). */
  tokenEstimate: number;
  metadata?: Record<string, unknown>;
}

/** A retrieved chunk with optional relevance score and associated document metadata. */
export interface RetrievalHit {
  chunk: Chunk;
  document: Document;
  /** Vector similarity score [0..1] if from vector search. */
  score: number;
  /** Which retrieval strategy produced this hit (vector, keyword, graph, hybrid). */
  source: 'vector' | 'keyword' | 'graph' | 'hybrid';
}

export interface RetrievalOptions {
  /**
   * Tenant to retrieve within (default: the service default tenant when the
   * caller is tenant-aware — pass the actor's tenant id explicitly for any
   * tenant-scoped flow). When undefined, legacy unscoped behavior is used.
   * Results from other tenants are never returned (fail-closed).
   */
  tenantId?: string;
  /** Number of chunks to retrieve (default 5). */
  topK?: number;
  /** Minimum similarity score (0..1) for vector hits. */
  minScore?: number;
  /** Metadata pre-filter applied before search. */
  filter?: Record<string, unknown>;
  /** If true, include the matched document's adjacent chunks for context. */
  expandContext?: boolean;
  /** How many neighbor chunks to pull on each side when expandContext is true (default 1). */
  contextWindow?: number;
  /** Optionally restrict to specific document ids. */
  documentIds?: string[];
}

export interface IngestOptions {
  /** Tenant that owns the ingested document (defaults to the service default tenant). */
  tenantId?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  /** Split strategy: 'paragraph' (default), 'sentence', 'fixed'. */
  strategy?: 'paragraph' | 'sentence' | 'fixed';
  metadata?: Record<string, unknown>;
  contentType?: string;
  title?: string;
  lang?: string;
}

export const KnowledgeEvents = Object.freeze({
  DocumentIngested: 'knowledge.document.ingested',
  DocumentDeleted: 'knowledge.document.deleted',
  ChunksCreated: 'knowledge.chunks.created',
  Retrieved: 'knowledge.retrieved',
} as const);
