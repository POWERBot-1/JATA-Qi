// Heightmap + biome generation. Elevation and moisture are sampled from
// fractal noise; biomes are classified Whittaker-style from elevation, moisture
// and a latitude-based temperature. Island shaping falls off near borders.

import { fbm, type Perlin2D } from './noise.js';

export enum Biome {
  DeepOcean = 0,
  Ocean = 1,
  Shallow = 2,
  Beach = 3,
  Desert = 4,
  Savanna = 5,
  Grassland = 6,
  Forest = 7,
  Jungle = 8,
  Taiga = 9,
  Mountain = 10,
  Snow = 11,
}

export const BIOME_NAMES: readonly string[] = [
  'Deep Ocean', 'Ocean', 'Shallow Water', 'Beach', 'Desert', 'Savanna',
  'Grassland', 'Forest', 'Jungle', 'Taiga', 'Mountain', 'Snow',
];

export interface HeightmapOptions {
  width: number;
  height: number;
  scale?: number;       // noise frequency multiplier
  octaves?: number;
  island?: number;      // 0 = none, 1 = strong island falloff
  seed?: number | string;
}

export interface Heightmap {
  width: number;
  height: number;
  elevation: Float32Array; // [0,1]
  moisture: Float32Array;  // [0,1]
  temperature: Float32Array; // [0,1] (1 = hot)
}

/** Generate elevation, moisture and temperature grids. */
export function generateHeightmap(perlin: Perlin2D, opts: HeightmapOptions): Heightmap {
  const { width, height } = opts;
  const scale = opts.scale ?? 1;
  const island = opts.island ?? 0.5;
  const elevation = new Float32Array(width * height);
  const moisture = new Float32Array(width * height);
  const temperature = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x / width) * scale;
      const ny = (y / height) * scale;
      let e = fbm((px: number, py: number) => perlin.noise(px, py), nx, ny, { octaves: opts.octaves ?? 6, frequency: 2 });
      e = (e + 1) * 0.5; // [0,1]
      // Island falloff: distance from center reduces elevation.
      if (island > 0) {
        const dx = (x / width) * 2 - 1;
        const dy = (y / height) * 2 - 1;
        const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
        e = e - Math.pow(d, 2) * island;
        e = Math.max(0, e);
      }
      elevation[y * width + x] = clamp01(e);
      const m = fbm((px: number, py: number) => perlin.noise(px + 100, py + 100), nx, ny, { octaves: 4, frequency: 3 });
      moisture[y * width + x] = clamp01((m + 1) * 0.5);
      // Temperature from latitude (y) modulated by elevation.
      const lat = 1 - Math.abs(y / height - 0.5) * 2; // 1 at equator, 0 at poles
      temperature[y * width + x] = clamp01(lat * 0.8 + (1 - e) * 0.2);
    }
  }
  return { width, height, elevation, moisture, temperature };
}

/** Classify a single cell into a biome. */
export function classifyBiome(elevation: number, moisture: number, temperature: number, seaLevel = 0.3): Biome {
  if (elevation < seaLevel * 0.6) return Biome.DeepOcean;
  if (elevation < seaLevel) return Biome.Ocean;
  if (elevation < seaLevel + 0.03) return Biome.Shallow;
  if (elevation < seaLevel + 0.06) return Biome.Beach;
  if (elevation > 0.85) return Biome.Snow;
  if (elevation > 0.7) return Biome.Mountain;
  if (temperature < 0.3) return Biome.Taiga;
  if (temperature > 0.7 && moisture < 0.3) return Biome.Desert;
  if (temperature > 0.6 && moisture > 0.6) return Biome.Jungle;
  if (temperature > 0.55 && moisture < 0.4) return Biome.Savanna;
  if (moisture > 0.55) return Biome.Forest;
  return Biome.Grassland;
}

/** Build a biome grid from a heightmap. */
export function biomeMap(hm: Heightmap, seaLevel = 0.3): Uint8Array {
  const out = new Uint8Array(hm.width * hm.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = classifyBiome(hm.elevation[i]!, hm.moisture[i]!, hm.temperature[i]!, seaLevel);
  }
  return out;
}

/** Count cells per biome. */
export function biomeHistogram(biomes: Uint8Array): number[] {
  const hist = new Array<number>(BIOME_NAMES.length).fill(0);
  for (let i = 0; i < biomes.length; i++) {
    const b = biomes[i]!;
    hist[b] = (hist[b] ?? 0) + 1;
  }
  return hist;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
