// Procedural universe generator — turns a seed into a complete, coherent
// world: heightmap, biomes, regions, named settlements (villages/towns/cities),
// and a road network connecting them. Everything is deterministic for a seed.

import { Rng, hashSeed } from './random.js';
import { Perlin2D } from './noise.js';
import { generateHeightmap, biomeMap, biomeHistogram, classifyBiome, Biome, BIOME_NAMES, type Heightmap } from './heightmap.js';

export interface Settlement {
  id: number;
  name: string;
  type: 'village' | 'town' | 'city';
  x: number;
  y: number;
  population: number;
  biome: Biome;
}

export interface Road { a: number; b: number; length: number; }

export interface Region {
  id: number;
  name: string;
  cellX: number;
  cellY: number;
  dominantBiome: Biome;
  meanElevation: number;
  area: number;
}

export interface WorldDefinition {
  seed: string;
  width: number;
  height: number;
  heightmap: Heightmap;
  biomes: Uint8Array;
  regions: Region[];
  settlements: Settlement[];
  roads: Road[];
  biomeHistogram: number[];
  landRatio: number;
}

export interface WorldGenOptions {
  seed: string;
  width?: number;
  height?: number;
  /** Target number of settlements. */
  settlements?: number;
  /** Coarse region grid (NxN). */
  regionGrid?: number;
  island?: number;
  scale?: number;
}

const NAME_PREFIX = ['Abi', 'Kibo', 'Zai', 'Mor', 'Tan', 'Ser', 'Lum', 'Nyx', 'Oka', 'Pel', 'Tan', 'Vor', 'Xan', 'Yara', 'Zul', 'Bwe', 'Dra', 'Fen'];
const NAME_SUFFIX = ['ra', 'ga', 'na', 'ta', 'ma', 'ya', 'lo', 'vi', 'den', 'ton', 'burg', 'field', 'gard', 'haven', 'wick', 'port'];

/** Generate a complete world from a seed. */
export function generateWorld(opts: WorldGenOptions): WorldDefinition {
  const seed = opts.seed;
  const width = opts.width ?? 128;
  const height = opts.height ?? 128;
  const rng = new Rng(hashSeed(seed));
  const perlin = new Perlin2D(rng.int(0, 0xffffffff));
  const heightmap = generateHeightmap(perlin, { width, height, island: opts.island ?? 0.5, scale: opts.scale ?? 2 });
  const biomes = biomeMap(heightmap);
  const regions = generateRegions(heightmap, biomes, opts.regionGrid ?? 4, rng.fork('regions'));
  const settlements = generateSettlements(heightmap, biomes, opts.settlements ?? 24, rng.fork('settlements'));
  const roads = generateRoads(settlements, rng.fork('roads'));
  return {
    seed, width, height, heightmap, biomes, regions, settlements, roads,
    biomeHistogram: biomeHistogram(biomes),
    landRatio: landRatio(biomes),
  };
}

/** Coarse regions: split the map into a grid, summarize each cell. */
function generateRegions(hm: Heightmap, biomes: Uint8Array, grid: number, rng: Rng): Region[] {
  const regions: Region[] = [];
  const cellW = hm.width / grid;
  const cellH = hm.height / grid;
  let id = 0;
  for (let cy = 0; cy < grid; cy++) {
    for (let cx = 0; cx < grid; cx++) {
      const hist = new Array<number>(BIOME_NAMES.length).fill(0);
      let sumElev = 0;
      let count = 0;
      const x0 = Math.floor(cx * cellW);
      const y0 = Math.floor(cy * cellH);
      const x1 = Math.floor((cx + 1) * cellW);
      const y1 = Math.floor((cy + 1) * cellH);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * hm.width + x;
          const bIdx = biomes[i]!;
          hist[bIdx] = (hist[bIdx] ?? 0) + 1;
          sumElev += hm.elevation[i]!;
          count++;
        }
      }
      let dominant = 0;
      let dominantCount = hist[0] ?? 0;
      for (let b = 1; b < hist.length; b++) {
        const c = hist[b] ?? 0;
        if (c > dominantCount) { dominant = b; dominantCount = c; }
      }
      regions.push({
        id: id++, cellX: cx, cellY: cy,
        name: makeName(rng),
        dominantBiome: dominant as Biome,
        meanElevation: count > 0 ? sumElev / count : 0,
        area: count,
      });
    }
  }
  return regions;
}

/** Place settlements on habitable land, weighted by habitability score. */
function generateSettlements(hm: Heightmap, biomes: Uint8Array, target: number, rng: Rng): Settlement[] {
  const candidates: Array<{ x: number; y: number; score: number; biome: Biome }> = [];
  // Candidate sampling: sample a coarse grid, score habitability.
  const step = Math.max(2, Math.floor(Math.sqrt((hm.width * hm.height) / (target * 16))));
  for (let y = 1; y < hm.height - 1; y += step) {
    for (let x = 1; x < hm.width - 1; x += step) {
      const i = y * hm.width + x;
      const e = hm.elevation[i]!;
      const b = biomes[i]! as Biome;
      if (e < 0.33 || e > 0.78) continue; // water or peaks
      // Habitability: prefer temperate, low-mid elevation, near water bonus.
      let score = 1;
      if (b === Biome.Grassland || b === Biome.Forest || b === Biome.Savanna) score += 2;
      if (b === Biome.Jungle) score += 1;
      // Near-water bonus (adjacency to ocean/shallow).
      if (hasAdjacentWater(biomes, hm.width, hm.height, x, y)) score += 1.5;
      score *= 0.5 + rng.float();
      candidates.push({ x, y, score, biome: b });
    }
  }
  // Pick top candidates by score, but jitter with rng for variety.
  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.slice(0, Math.min(target * 3, candidates.length));
  // Shuffle lightly and take `target`, ensuring minimum spacing.
  const settlements: Settlement[] = [];
  const minDist = Math.max(4, Math.floor(Math.min(hm.width, hm.height) / Math.sqrt(target) / 2));
  for (const c of shuffle(chosen, rng)) {
    if (settlements.length >= target) break;
    if (settlements.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < minDist)) continue;
    const population = populationFor(c.score, rng);
    settlements.push({
      id: settlements.length,
      name: makeName(rng),
      type: population > 50000 ? 'city' : population > 8000 ? 'town' : 'village',
      x: c.x, y: c.y, population, biome: c.biome,
    });
  }
  // Sort by id for stable output.
  return settlements.sort((a, b) => a.id - b.id);
}

/** Greedy nearest-neighbor road network (an approximate MST). */
function generateRoads(settlements: Settlement[], rng: Rng): Road[] {
  if (settlements.length < 2) return [];
  const roads: Road[] = [];
  const connected = new Set<number>([0]);
  const remaining = new Set(settlements.map((_, i) => i).slice(1));
  while (remaining.size > 0) {
    let best: { from: number; to: number; dist: number } | undefined;
    for (const c of connected) {
      for (const r of remaining) {
        const a = settlements[c]!;
        const b = settlements[r]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (!best || d < best.dist) best = { from: c, to: r, dist: d };
      }
    }
    if (!best) break;
    roads.push({ a: best.from, b: best.to, length: best.dist });
    connected.add(best.to);
    remaining.delete(best.to);
  }
  void rng;
  return roads;
}

function hasAdjacentWater(biomes: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx!;
    const ny = y + dy!;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const b = biomes[ny * w + nx]!;
    if (b === Biome.Ocean || b === Biome.DeepOcean || b === Biome.Shallow) return true;
  }
  return false;
}

function populationFor(score: number, rng: Rng): number {
  // Higher habitability score -> larger settlements (log-distributed).
  const base = Math.pow(score, 3) * 200;
  return Math.floor(base * (0.5 + rng.float()));
}

function makeName(rng: Rng): string {
  return rng.pick(NAME_PREFIX) + rng.pick(NAME_SUFFIX);
}

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.float() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function landRatio(biomes: Uint8Array): number {
  let land = 0;
  for (let i = 0; i < biomes.length; i++) {
    const b = biomes[i]!;
    if (b !== Biome.DeepOcean && b !== Biome.Ocean) land++;
  }
  return biomes.length > 0 ? land / biomes.length : 0;
}

export { classifyBiome, BIOME_NAMES, Biome };
export type { Heightmap };
