// Deterministic pseudo-random number generation for procedural worlds. A fixed
// seed always produces the same world, which is essential for shared/persistent
// worlds, replays, and incremental generation. Pure Node (no Math.random).

/** Hash an arbitrary string into a 32-bit unsigned integer seed. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Extra avalanche step.
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32 — a fast, good-quality 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic RNG with ergonomic helpers. */
export class Rng {
  private next: () => number;
  readonly seed: number;

  constructor(seed: number | string) {
    this.seed = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  /** Float in [0, 1). */
  float(): number { return this.next(); }
  /** Float in [min, max). */
  range(min: number, max: number): number { return min + (max - min) * this.next(); }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number { return Math.floor(this.range(min, max + 1)); }
  /** Boolean true with probability `p` (default 0.5). */
  chance(p = 0.5): boolean { return this.next() < p; }
  /** Pick a random element. */
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]!; }
  /** Weighted pick: entries with their weight. */
  weighted<T>(entries: Array<{ value: T; weight: number }>): T {
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let r = this.next() * total;
    for (const e of entries) { r -= e.weight; if (r <= 0) return e.value; }
    return entries[entries.length - 1]!.value;
  }
  /** Fork a new independent RNG deterministically derived from this one. */
  fork(label: string): Rng { return new Rng(this.seed ^ hashSeed(label)); }
}
