// Embedding model implementations.
// - HashEmbeddingModel: deterministic seeded projections (no external calls, perfect for tests/dev)
// - OpenAI-compatible model (pluggable HTTP client; defaults to stub when no key provided)

import type { IEmbeddingModel } from './types.js';
import { normalize } from './distance.js';

/**
 * Deterministic "hash-trick" embedding. Given an input string, it produces a stable
 * dim-length float vector by hashing each n-gram into the vector space, then L2-normalizing.
 * NOT semantically meaningful — useful for unit tests and offline development.
 */
export class HashEmbeddingModel implements IEmbeddingModel {
  readonly id: string;
  readonly dim: number;
  private readonly seed: number;

  constructor(dim = 128, seed = 0x9e3779b9) {
    if (dim <= 0) throw new Error('HashEmbeddingModel: dim must be positive');
    this.dim = dim;
    this.id = `hash:${dim}`;
    this.seed = seed >>> 0;
  }

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    this.projectInto(text, v);
    return normalize(v);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  private projectInto(text: string, out: Float32Array): void {
    // Tokenize into char-bigrams so "cat" and "car" overlap substantially.
    const normalized = text.toLowerCase().trim();
    const grams: string[] = [];
    if (normalized.length === 0) {
      grams.push('');
    } else {
      for (let i = 0; i < normalized.length; i++) {
        grams.push(normalized.slice(i, i + 2));
      }
    }
    for (const g of grams) {
      let h = this.seed;
      for (let i = 0; i < g.length; i++) {
        h = Math.imul(h ^ g.charCodeAt(i), 0x85ebca6b);
        h = (h >>> 0) ^ (h >>> 13);
      }
      // Map hash to two dimensions with opposite signs so dimensions decorrelate.
      const idx = h % this.dim;
      const idx2 = (h >>> 8) % this.dim;
      const sign = (h & 1) ? 1 : -1;
      out[idx] = (out[idx] ?? 0) + sign;
      out[idx2] = (out[idx2] ?? 0) - sign * 0.5;
    }
  }
}

/**
 * Configuration for remote embedding providers (OpenAI-compatible endpoints).
 * The client function is injectable so it can be reused with Azure, local proxies, etc.
 */
export interface RemoteEmbeddingConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  dim?: number;
  /** Optional fetch-like implementation (falls back to global fetch). */
  fetcher?: typeof fetch;
}

/**
 * OpenAI-compatible embedding client. Returns raw vectors; caller is responsible
 * for normalization if using cosine metric. Requires a real API key at runtime;
 * if none is provided, throws a clear error on embed().
 */
export class OpenAIEmbeddingModel implements IEmbeddingModel {
  readonly id: string;
  readonly dim: number;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;

  constructor(cfg: RemoteEmbeddingConfig = {}) {
    this.model = cfg.model ?? 'text-embedding-3-small';
    this.endpoint = cfg.endpoint ?? 'https://api.openai.com/v1/embeddings';
    this.apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.dim = cfg.dim ?? 1536;
    this.fetcher = cfg.fetcher ?? globalThis.fetch?.bind(globalThis);
    this.id = `openai:${this.model}`;
  }

  async embed(text: string): Promise<Float32Array> {
    const [r] = await this.embedBatch([text]);
    return r!;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.apiKey) {
      throw new Error('OpenAIEmbeddingModel: apiKey not configured (set OPENAI_API_KEY or pass apiKey)');
    }
    if (!this.fetcher) {
      throw new Error('OpenAIEmbeddingModel: fetch is not available in this environment');
    }
    const res = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAIEmbeddingModel: request failed ${res.status}: ${t}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    if (!json.data || json.data.length !== texts.length) {
      throw new Error('OpenAIEmbeddingModel: unexpected response shape');
    }
    return json.data.map((d) => {
      const arr = new Float32Array(d.embedding.length);
      for (let i = 0; i < d.embedding.length; i++) arr[i] = d.embedding[i]!;
      return normalize(arr);
    });
  }
}
