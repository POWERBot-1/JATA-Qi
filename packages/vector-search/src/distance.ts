// Distance / similarity primitives. All operate on Float32Array for speed.

import type { Vector, VectorMetric } from './types.js';

export function toFloat32(v: Vector): Float32Array {
  if (v instanceof Float32Array) return v;
  return new Float32Array(v);
}

export function assertDim(expected: number, actual: number, label = 'vector'): void {
  if (actual !== expected) {
    throw new Error(`Dimension mismatch for ${label}: expected ${expected}, got ${actual}`);
  }
}

export function zeroVector(dim: number): Float32Array {
  return new Float32Array(dim);
}

/** Cosine similarity in [-1, 1]. We return similarity (higher = closer). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('cosine: dimension mismatch');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  // Clamp to [-1, 1] to absorb floating point drift.
  return sim > 1 ? 1 : sim < -1 ? -1 : sim;
}

/** Convert cosine similarity to a "distance" in [0, 2] where 0 = identical. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  return 1 - cosineSimilarity(a, b);
}

/** Squared euclidean distance (cheaper than true euclidean; monotonic for ranking). */
export function squaredEuclidean(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('euclidean: dimension mismatch');
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return s;
}

export function euclidean(a: Float32Array, b: Float32Array): number {
  return Math.sqrt(squaredEuclidean(a, b));
}

/** Negative dot product (so smaller = more similar, consistent with other distances). */
export function negDotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('dot: dimension mismatch');
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return -s;
}

export function distance(a: Float32Array, b: Float32Array, metric: VectorMetric): number {
  switch (metric) {
    case 'cosine': return cosineDistance(a, b);
    case 'euclidean': return squaredEuclidean(a, b);
    case 'dot': return negDotProduct(a, b);
  }
}

/** Convert distance to similarity score in [0,1] for search hit scoring. */
export function distanceToScore(d: number, metric: VectorMetric): number {
  switch (metric) {
    case 'cosine': {
      // cosine distance ∈ [0, 2]; map to score ∈ [0, 1] with 1 − d/2
      const s = 1 - d / 2;
      return s < 0 ? 0 : s > 1 ? 1 : s;
    }
    case 'euclidean': {
      // Squared euclidean → score decays via 1/(1+d).
      return 1 / (1 + d);
    }
    case 'dot': {
      // neg-dot distance; higher dot = lower d = higher score.
      return 1 / (1 + Math.exp(d)); // sigmoid
    }
  }
}

/** Normalize a vector in-place to unit length (for cosine search optimizations). */
export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  if (n === 0) return v;
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * inv;
  return v;
}
