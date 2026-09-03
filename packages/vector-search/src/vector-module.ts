import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { FlatIndex } from './flat-index.js';
import { HashEmbeddingModel, OpenAIEmbeddingModel } from './embeddings.js';
import { toFloat32 } from './distance.js';
import {
  IEmbeddingModel,
  IVectorIndex,
  SearchHit,
  SearchOptions,
  Vector,
  VectorEvents,
  VectorMetric,
  VectorRecord,
} from './types.js';

export interface VectorModuleConfig {
  model?: 'hash' | 'openai' | string;
  hashDim?: number;
  openai?: { apiKey?: string; model?: string; endpoint?: string; dim?: number; fetcher?: typeof fetch };
  metric?: VectorMetric;
}

interface PersistedRow {
  id: string;
  dim: number;
  vector: number[];
  metadata?: Record<string, unknown>;
}

export class VectorSearchModule implements IModule {
  readonly id = 'vector-search';
  readonly tags = ['core', 'vector', 'search'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private indexes = new Map<string, IVectorIndex>();
  private model!: IEmbeddingModel;
  private metric!: VectorMetric;
  private cfg!: VectorModuleConfig;

  constructor(cfg: VectorModuleConfig = {}) {
    this.cfg = cfg;
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.metric = this.cfg.metric ?? kernel.config.get('vector.metric', 'cosine');
    const modelId = this.cfg.model ?? kernel.config.get('vector.model', 'hash');
    this.model = this.resolveModel(modelId);
    kernel.container.registerValue('vector.model', this.model);
    kernel.container.registerValue('vector.module', this);
    kernel.logger.info(`vector search initialized (model=${this.model.id}, metric=${this.metric}, dim=${this.model.dim})`);
  }

  async start(_kernel: KernelApi): Promise<void> {
    // Indexes are opened lazily via index(name).
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // Persist every opened index before clearing the in-memory cache. This gives
    // development filesystem users a safe orderly-shutdown path; abrupt process
    // loss is still not a transactional durability guarantee.
    for (const [name, idx] of this.indexes) {
      await this.persist(name);
      await idx.clear();
    }
    this.indexes.clear();
  }

  getModel(): IEmbeddingModel {
    return this.model;
  }

  async index(name: string, opts?: { metric?: VectorMetric; dim?: number }): Promise<IVectorIndex> {
    let idx = this.indexes.get(name);
    if (!idx) {
      const metric = opts?.metric ?? this.metric;
      const dim = opts?.dim ?? this.model.dim;
      idx = new FlatIndex(name, dim, metric);
      this.indexes.set(name, idx);
      await this.api.bus.emit(VectorEvents.IndexCreated, { name, metric, dim });
    }
    return idx;
  }

  async embedAndAdd(
    indexName: string,
    items: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>,
  ): Promise<void> {
    const idx = await this.index(indexName);
    const vectors = await this.model.embedBatch(items.map((i) => i.text));
    const records: VectorRecord[] = vectors.map((v, i) => {
      const it = items[i]!;
      return { id: it.id, vector: toFloat32(v), dim: v.length, metadata: it.metadata };
    });
    await idx.addBatch(records);
    await this.api.bus.emit(VectorEvents.VectorAdded, { index: indexName, count: records.length });
  }

  async embedAndSearch(indexName: string, text: string, opts?: SearchOptions): Promise<SearchHit[]> {
    const idx = await this.index(indexName);
    const q = await this.model.embed(text);
    const hits = await idx.search(q, opts);
    await this.api.bus.emit(VectorEvents.Searched, { index: indexName, topK: opts?.topK ?? 10, returned: hits.length });
    return hits;
  }

  async search(indexName: string, vec: Vector, opts?: SearchOptions): Promise<SearchHit[]> {
    const idx = await this.index(indexName);
    return idx.search(vec, opts);
  }

  /** Persist an index to storage as a collection. */
  async persist(indexName: string): Promise<void> {
    const idx = this.indexes.get(indexName);
    if (!idx) return;
    const storage = this.api.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const col = await storage.collection<PersistedRow>(`__vector__:${indexName}`);
    const entries = idx.entries();
    // One complete snapshot replacement avoids O(n²) collection rewrites. It
    // remains a development snapshot, not a write-ahead log or transaction.
    await col.replaceAll(entries.map((rec) => ({
      id: rec.id,
      dim: rec.dim,
      vector: Array.from(rec.vector),
      metadata: rec.metadata,
    })));
    this.api.logger.debug(`persisted index "${indexName}" (${entries.length} vectors)`);
  }

  /** Load an index from storage. */
  async load(indexName: string): Promise<IVectorIndex> {
    const storage = this.api.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const col = await storage.collection<PersistedRow>(`__vector__:${indexName}`);
    const rows = await col.all();
    if (rows.length === 0) return this.index(indexName);
    const dim = rows[0]!.dim;
    const idx = new FlatIndex(indexName, dim, this.metric);
    this.indexes.set(indexName, idx);
    const recs: VectorRecord[] = rows.map((r) => ({
      id: r.id,
      dim: r.dim,
      vector: new Float32Array(r.vector),
      metadata: r.metadata,
    }));
    await idx.addBatch(recs);
    return idx;
  }

  private resolveModel(id: string): IEmbeddingModel {
    if (id === 'hash') {
      return new HashEmbeddingModel(this.cfg.hashDim ?? this.api.config.getNumber('vector.hashDim', 128));
    }
    if (id === 'openai') {
      return new OpenAIEmbeddingModel(this.cfg.openai);
    }
    throw new Error(`VectorSearchModule: unknown embedding model "${id}"`);
  }
}
