// Vector search types: vectors, embeddings, hits, index interface.

import type { EntryMeta } from '@jataqi/storage';

/** A dense embedding vector (Float32Array preferred for performance; number[] accepted). */
export type Vector = Float32Array | number[];

/** A single vector record stored in the index. */
export interface VectorRecord {
  /** Stable external identifier (e.g. chunk id). */
  id: string;
  /** The vector itself. */
  vector: Float32Array;
  /** Dimension count. */
  dim: number;
  /** Arbitrary payload returned with search hits. */
  metadata?: Record<string, unknown>;
}

/** A search result. */
export interface SearchHit {
  id: string;
  /** Similarity score in [0, 1] for cosine (1 = identical). */
  score: number;
  /** Distance in the chosen metric space (lower = closer). */
  distance: number;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  /** Number of results to return (default 10). */
  topK?: number;
  /** If provided, filter candidates before ranking. */
  filter?: (metadata: Record<string, unknown> | undefined) => boolean;
  /** Score threshold in [0,1]; results below this are dropped (cosine only). */
  minScore?: number;
}

export interface IndexStats {
  count: number;
  dim: number;
  metric: VectorMetric;
  memoryBytes: number;
}

export type VectorMetric = 'cosine' | 'euclidean' | 'dot';

/** Pluggable vector index. */
export interface IVectorIndex {
  readonly name: string;
  readonly metric: VectorMetric;
  readonly dim: number;

  add(record: VectorRecord): Promise<void>;
  addBatch(records: VectorRecord[]): Promise<void>;
  remove(id: string): Promise<boolean>;
  search(query: Vector, opts?: SearchOptions): Promise<SearchHit[]>;
  get(id: string): Promise<VectorRecord | undefined>;
  has(id: string): Promise<boolean>;
  count(): Promise<number>;
  stats(): IndexStats;
  clear(): Promise<void>;
  /** Return a snapshot of all records (for persistence/backup). */
  entries(): VectorRecord[];
}

/** Embedding model turns text into dense vectors. */
export interface IEmbeddingModel {
  readonly id: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export const VectorEvents = Object.freeze({
  IndexCreated: 'vector.index.created',
  VectorAdded: 'vector.added',
  VectorRemoved: 'vector.removed',
  Searched: 'vector.searched',
} as const);
