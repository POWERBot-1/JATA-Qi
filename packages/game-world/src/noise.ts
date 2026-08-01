// Noise functions for procedural generation — 2D Perlin (gradient) noise with a
// seeded permutation table, value noise, and fractal Brownian motion (fBm) for
// natural-looking multi-octave terrain.

import { Rng } from './random.js';

const FADE = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Gradient contribution for 2D Perlin (Ken Perlin's improved, 8-gradient form). */
function grad2(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

/** A seeded 2D Perlin noise function returning values in [-1, 1]. */
export class Perlin2D {
  private perm: Uint8Array;
  readonly seed: number;

  constructor(seed: number | string) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates shuffle with the seeded RNG.
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.float() * (i + 1));
      const tmp = p[i]!; p[i] = p[j]!; p[j] = tmp;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
    this.seed = rng.seed;
  }

  /** Noise at (x, y) in [-1, 1]. */
  noise(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = FADE(xf);
    const v = FADE(yf);
    const p = this.perm;
    const aa = p[p[X]! + Y]!;
    const ab = p[p[X]! + Y + 1]!;
    const ba = p[p[X + 1]! + Y]!;
    const bb = p[p[X + 1]! + Y + 1]!;
    const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
    const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v); // ~[-1, 1]
  }
}

/** Smoothed value noise in [0, 1] — a cheaper alternative to gradient noise. */
export class ValueNoise2D {
  private grid: Float32Array;
  private readonly size: number;
  readonly seed: number;

  constructor(seed: number | string, size = 256) {
    const rng = new Rng(seed);
    this.size = size;
    this.grid = new Float32Array(size * size);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = rng.float();
    this.seed = rng.seed;
  }

  noise(x: number, y: number): number {
    const s = this.size;
    const X = ((Math.floor(x) % s) + s) % s;
    const Y = ((Math.floor(y) % s) + s) % s;
    const X1 = (X + 1) % s;
    const Y1 = (Y + 1) % s;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = FADE(xf);
    const v = FADE(yf);
    const g = this.grid;
    const aa = g[Y * s + X]!;
    const ba = g[Y * s + X1]!;
    const ab = g[Y1 * s + X]!;
    const bb = g[Y1 * s + X1]!;
    return lerp(lerp(aa, ba, u), lerp(ab, bb, u), v);
  }
}

export interface FbmOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  frequency?: number;
  amplitude?: number;
}

/** Fractal Brownian motion: sum of octaves of a noise function. Returns ~[-1, 1]. */
export function fbm(noiseFn: (x: number, y: number) => number, x: number, y: number, opts: FbmOptions = {}): number {
  const octaves = opts.octaves ?? 5;
  const lacunarity = opts.lacunarity ?? 2.0;
  const gain = opts.gain ?? 0.5;
  let frequency = opts.frequency ?? 1.0;
  let amplitude = opts.amplitude ?? 1.0;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * noiseFn(x * frequency, y * frequency);
    norm += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

export { Rng };
