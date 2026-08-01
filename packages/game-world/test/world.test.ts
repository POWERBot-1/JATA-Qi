// Procedural generation tests — determinism, noise smoothness, biome logic,
// and full world coherence.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Rng, hashSeed, mulberry32, Perlin2D, ValueNoise2D, fbm,
  generateHeightmap, classifyBiome, biomeMap, biomeHistogram, Biome,
  generateWorld,
} from '../src/index.js';

describe('Rng — determinism', () => {
  it('same seed -> same sequence', () => {
    const a = new Rng('nova-1');
    const b = new Rng('nova-1');
    for (let i = 0; i < 20; i++) assert.equal(a.float(), b.float());
  });

  it('different seeds -> different first value', () => {
    assert.notEqual(new Rng('a').float(), new Rng('b').float());
  });

  it('range/int/chance/pick behave', () => {
    const r = new Rng(42);
    const v = r.range(10, 20);
    assert.ok(v >= 10 && v < 20);
    const i = r.int(1, 5);
    assert.ok(i >= 1 && i <= 5);
    assert.equal(typeof r.chance(), 'boolean');
    assert.ok(['x', 'y', 'z'].includes(r.pick(['x', 'y', 'z'])));
  });

  it('weighted pick respects weights', () => {
    const r = new Rng(7);
    const counts = { a: 0, b: 0, c: 0 } as Record<string, number>;
    for (let i = 0; i < 1000; i++) counts[r.weighted([{ value: 'a', weight: 1 }, { value: 'b', weight: 8 }, { value: 'c', weight: 1 }])]++;
    assert.ok(counts.b > counts.a && counts.b > counts.c);
  });

  it('hashSeed is stable and 32-bit', () => {
    assert.equal(hashSeed('hello'), hashSeed('hello'));
    assert.equal(Number.isInteger(hashSeed('hello')), true);
    assert.ok(hashSeed('hello') >= 0 && hashSeed('hello') <= 0xffffffff);
  });
});

describe('noise', () => {
  it('Perlin is deterministic and bounded in [-1, 1]', () => {
    const n1 = new Perlin2D(123);
    const n2 = new Perlin2D(123);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < 100; i++) {
      const v = n1.noise(i * 0.1, i * 0.13);
      assert.equal(v, n2.noise(i * 0.1, i * 0.13));
      min = Math.min(min, v); max = Math.max(max, v);
    }
    assert.ok(min >= -1.01 && max <= 1.01);
  });

  it('Perlin varies across the plane (not constant)', () => {
    const n = new Perlin2D('s');
    const values = new Set<number>();
    // Sample fractional coordinates (Perlin is 0 at integer lattice points).
    for (let i = 0; i < 20; i++) values.add(Math.round(n.noise(i * 0.17 + 0.5, i * 0.23 + 0.5) * 1000));
    assert.ok(values.size > 1);
  });

  it('value noise in [0, 1] and deterministic', () => {
    const v1 = new ValueNoise2D('seed');
    const v2 = new ValueNoise2D('seed');
    for (let i = 0; i < 50; i++) {
      const v = v1.noise(i * 0.3, i * 0.31);
      assert.equal(v, v2.noise(i * 0.3, i * 0.31));
      assert.ok(v >= 0 && v <= 1);
    }
  });

  it('fbm averages octaves into range', () => {
    const n = new Perlin2D(5);
    const v = fbm((x, y) => n.noise(x, y), 0.5, 0.5, { octaves: 4 });
    assert.ok(v >= -1.01 && v <= 1.01);
  });
});

describe('biomes', () => {
  it('classifies water vs land vs peaks', () => {
    assert.equal(classifyBiome(0.1, 0.5, 0.5), Biome.DeepOcean);
    assert.equal(classifyBiome(0.5, 0.4, 0.7), Biome.Grassland);
    assert.equal(classifyBiome(0.9, 0.3, 0.2), Biome.Snow);
    assert.equal(classifyBiome(0.85, 0.3, 0.2), Biome.Mountain);
  });

  it('biomeMap + histogram cover every cell', () => {
    const hm = generateHeightmap(new Perlin2D(1), { width: 16, height: 16, island: 0.3 });
    const b = biomeMap(hm);
    assert.equal(b.length, 16 * 16);
    const hist = biomeHistogram(b);
    assert.equal(hist.reduce((s, n) => s + n, 0), 16 * 16);
  });
});

describe('generateWorld — coherence', () => {
  it('is fully deterministic for a seed', () => {
    const a = generateWorld({ seed: 'afrofuturist-racing', width: 48, height: 48, settlements: 8 });
    const b = generateWorld({ seed: 'afrofuturist-racing', width: 48, height: 48, settlements: 8 });
    assert.deepEqual([...a.biomes], [...b.biomes]);
    assert.deepEqual(a.settlements.map((s) => s.name), b.settlements.map((s) => s.name));
    assert.deepEqual(a.roads.map((r) => [r.a, r.b]), b.roads.map((r) => [r.a, r.b]));
  });

  it('produces settlements on land with names and populations', () => {
    const w = generateWorld({ seed: 'cities', width: 64, height: 64, settlements: 12 });
    assert.ok(w.settlements.length > 0);
    for (const s of w.settlements) {
      assert.ok(s.name.length > 0);
      assert.ok(s.population > 0);
      assert.ok(['village', 'town', 'city'].includes(s.type));
    }
  });

  it('roads connect settlements into one component', () => {
    const w = generateWorld({ seed: 'roads', width: 64, height: 64, settlements: 10 });
    assert.ok(w.roads.length >= w.settlements.length - 1);
    const reach = new Set<number>([0]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of w.roads) {
        if (reach.has(r.a) && !reach.has(r.b)) { reach.add(r.b); changed = true; }
        if (reach.has(r.b) && !reach.has(r.a)) { reach.add(r.a); changed = true; }
      }
    }
    assert.equal(reach.size, w.settlements.length);
  });

  it('regions summarize the map', () => {
    const w = generateWorld({ seed: 'regions', width: 32, height: 32, regionGrid: 3 });
    assert.equal(w.regions.length, 9);
    assert.ok(w.landRatio >= 0 && w.landRatio <= 1);
  });

  it('different seeds produce different worlds', () => {
    const a = generateWorld({ seed: 'one', width: 32, height: 32 });
    const b = generateWorld({ seed: 'two', width: 32, height: 32 });
    assert.notDeepEqual([...a.biomes], [...b.biomes]);
  });
});
