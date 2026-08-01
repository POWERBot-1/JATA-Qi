// @jataqi/game-world — NOVA Procedural World Generation (section 5). Public API.

export { Rng, mulberry32, hashSeed } from './random.js';
export { Perlin2D, ValueNoise2D, fbm } from './noise.js';
export type { FbmOptions } from './noise.js';
export {
  generateHeightmap, classifyBiome, biomeMap, biomeHistogram, Biome, BIOME_NAMES,
} from './heightmap.js';
export type { Heightmap, HeightmapOptions } from './heightmap.js';
export { generateWorld } from './world.js';
export type { WorldDefinition, WorldGenOptions, Settlement, Road, Region } from './world.js';
