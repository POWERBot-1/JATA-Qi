// Flat/brute-force vector index. Exact-result baseline; fast enough to ~100k vectors
// in pure JS, and serves as the correctness oracle for approximate indexes.

import {
  IVectorIndex,
  IndexStats,
  SearchHit,
  SearchOptions,
  Vector,
  VectorMetric,
  VectorRecord,
} from './types.js';
import {
  assertDim,
  distance,
  distanceToScore,
  normalize,
  toFloat32,
} from './distance.js';

interface Stored {
  id: string;
  vector: Float32Array;
  metadata?: Record<string, unknown>;
}

export class FlatIndex implements IVectorIndex {
  readonly name: string;
  readonly metric: VectorMetric;
  readonly dim: number;

  private store = new Map<string, Stored>();
  /** Array view kept in sync for fast iteration. */
  private list: Stored[] = [];
  private dirty = false;

  constructor(name: string, dim: number, metric: VectorMetric = 'cosine') {
    if (dim <= 0) throw new Error(`FlatIndex: dim must be positive, got ${dim}`);
    this.name = name;
    this.dim = dim;
    this.metric = metric;
  }

  async add(record: VectorRecord): Promise<void> {
    assertDim(this.dim, record.dim, `record "${record.id}"`);
    const v = this.normalizeForMetric(toFloat32(record.vector));
    const s: Stored = { id: record.id, vector: v, metadata: record.metadata };
    if (!this.store.has(record.id)) {
      this.list.push(s);
    } else {
      // Update in place: replace in list via object swap to keep identity simple.
      const idx = this.list.findIndex((x) => x.id === record.id);
      if (idx >= 0) this.list[idx] = s;
    }
    this.store.set(record.id, s);
    this.dirty = true;
  }

  async addBatch(records: VectorRecord[]): Promise<void> {
    for (const r of records) await this.add(r);
  }

  async remove(id: string): Promise<boolean> {
    if (!this.store.has(id)) return false;
    this.store.delete(id);
    const idx = this.list.findIndex((x) => x.id === id);
    if (idx >= 0) this.list.splice(idx, 1);
    this.dirty = true;
    return true;
  }

  async get(id: string): Promise<VectorRecord | undefined> {
    const s = this.store.get(id);
    if (!s) return undefined;
    return { id: s.id, vector: s.vector, dim: this.dim, metadata: s.metadata };
  }

  async has(id: string): Promise<boolean> {
    return this.store.has(id);
  }

  async count(): Promise<number> {
    return this.store.size;
  }

  stats(): IndexStats {
    const bytes = this.dim * 4 * this.store.size; // rough; ignores overhead
    return {
      count: this.store.size,
      dim: this.dim,
      metric: this.metric,
      memoryBytes: bytes,
    };
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.list = [];
    this.dirty = true;
  }

  /** Iterate all stored records (copy). Used for persistence. */
  entries(): VectorRecord[] {
    return this.list.map((s) => ({ id: s.id, vector: s.vector, dim: this.dim, metadata: s.metadata }));
  }

  async search(query: Vector, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const q = toFloat32(query);
    assertDim(this.dim, q.length, 'query');
    const qv = this.normalizeForMetric(new Float32Array(q));
    const topK = opts.topK ?? 10;
    const filter = opts.filter;
    const minScore = opts.minScore;

    // Use a bounded min-heap (size = topK) to avoid O(n log n) full sort.
    const heap = new HitHeap(topK);

    for (let i = 0; i < this.list.length; i++) {
      const s = this.list[i]!;
      if (filter && !filter(s.metadata)) continue;
      const d = distance(qv, s.vector, this.metric);
      const score = distanceToScore(d, this.metric);
      if (minScore !== undefined && score < minScore) continue;
      heap.push({ id: s.id, score, distance: d, metadata: s.metadata });
    }

    const hits = heap.toArray();
    // Highest score first.
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  private normalizeForMetric(v: Float32Array): Float32Array {
    if (this.metric === 'cosine') return normalize(v);
    return v;
  }
}

/** Bounded min-heap keyed by score — retains only the top-K highest scores. */
class HitHeap {
  private heap: SearchHit[] = [];
  constructor(private readonly k: number) {}

  push(h: SearchHit): void {
    if (this.heap.length < this.k) {
      this.heap.push(h);
      this.bubbleUp(this.heap.length - 1);
    } else if (this.k > 0 && h.score > this.heap[0]!.score) {
      this.heap[0] = h;
      this.bubbleDown(0);
    }
  }

  toArray(): SearchHit[] {
    return [...this.heap];
  }

  private bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const parentHit = this.heap[parent];
      const iHit = this.heap[i];
      if (!parentHit || !iHit) break;
      if (parentHit.score <= iHit.score) break;
      this.heap[parent] = iHit;
      this.heap[i] = parentHit;
      i = parent;
    }
  }

  private bubbleDown(i: number) {
    const n = this.heap.length;
    while (true) {
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      let smallest = i;
      const cur = this.heap[smallest];
      const lHit = l < n ? this.heap[l] : undefined;
      const rHit = r < n ? this.heap[r] : undefined;
      if (cur && lHit && lHit.score < cur.score) smallest = l;
      const curSmallest = this.heap[smallest];
      if (curSmallest && rHit && rHit.score < curSmallest.score) smallest = r;
      if (smallest === i) break;
      const a = this.heap[i]!;
      const b = this.heap[smallest]!;
      this.heap[i] = b;
      this.heap[smallest] = a;
      i = smallest;
    }
  }
}
