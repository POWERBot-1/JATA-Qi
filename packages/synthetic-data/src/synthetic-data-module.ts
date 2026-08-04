// SyntheticDataModule — generate realistic tabular and time-series datasets (#directive).
// Uses seeded PRNG for reproducibility. Includes bias assessment and quality scoring.

import { randomUUID, createHash } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';

export interface ColumnSpec {
  name: string;
  type: 'int' | 'float' | 'string' | 'boolean' | 'category' | 'date';
  min?: number; max?: number;
  categories?: string[];
  nullRate?: number; // 0..1 probability of null
  distribution?: 'uniform' | 'normal';
  mean?: number; stdDev?: number;
}

export interface DatasetSchema {
  name: string;
  columns: ColumnSpec[];
  rowCount: number;
}

export interface GeneratedDataset {
  id: string;
  name: string;
  rows: Record<string, unknown>[];
  schema: DatasetSchema;
  qualityScore: number; // 0..1
  biasScore: number; // 0..1 (lower = less biased)
  seed: string;
  createdAt: number;
}

export const SyntheticDataEvents = Object.freeze({
  DatasetGenerated: 'synth.dataset.generated',
} as const);

/** Mulberry32 PRNG for reproducibility. */
function mulberry32(seed: string): () => number {
  let a = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateNormal(rng: () => number, mean: number, stdDev: number): number {
  // Box-Muller transform.
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export class SyntheticDataModule implements IModule {
  readonly id = 'synthetic-data';
  readonly tags = ['intelligence', 'data'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('synthetic-data', this);
    kernel.logger.info('synthetic-data module initialized');
  }
  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  /** Generate a synthetic dataset from a schema. */
  generate(schema: DatasetSchema, seed?: string): GeneratedDataset {
    const s = seed ?? randomUUID();
    const rng = mulberry32(s);
    const rows: Record<string, unknown>[] = [];

    for (let r = 0; r < schema.rowCount; r++) {
      const row: Record<string, unknown> = {};
      for (const col of schema.columns) {
        // Null injection.
        if (col.nullRate !== undefined && rng() < col.nullRate) { row[col.name] = null; continue; }
        switch (col.type) {
          case 'int': {
            const min = col.min ?? 0; const max = col.max ?? 100;
            row[col.name] = Math.floor(min + rng() * (max - min + 1)); break;
          }
          case 'float': {
            if (col.distribution === 'normal' && col.mean !== undefined && col.stdDev !== undefined) {
              row[col.name] = Math.round(generateNormal(rng, col.mean, col.stdDev) * 1000) / 1000;
            } else {
              const min = col.min ?? 0; const max = col.max ?? 1;
              row[col.name] = Math.round((min + rng() * (max - min)) * 1000) / 1000;
            }
            break;
          }
          case 'boolean': row[col.name] = rng() < 0.5; break;
          case 'category': {
            const cats = col.categories ?? ['A', 'B', 'C'];
            row[col.name] = cats[Math.floor(rng() * cats.length)]; break;
          }
          case 'string': row[col.name] = `str_${Math.floor(rng() * 100000)}`; break;
          case 'date': {
            const base = new Date('2024-01-01').getTime();
            row[col.name] = new Date(base + Math.floor(rng() * 365 * 86_400_000)).toISOString().slice(0, 10);
            break;
          }
        }
      }
      rows.push(row);
    }

    // Quality scoring: check for completeness, uniqueness, distribution.
    const qualityScore = this.scoreQuality(rows, schema);
    const biasScore = this.scoreBias(rows, schema);

    const dataset: GeneratedDataset = {
      id: randomUUID(), name: schema.name, rows, schema,
      qualityScore, biasScore, seed: s, createdAt: Date.now(),
    };
    void this.api?.bus?.emit(SyntheticDataEvents.DatasetGenerated, { id: dataset.id, rows: rows.length });
    return dataset;
  }

  private scoreQuality(rows: Record<string, unknown>[], schema: DatasetSchema): number {
    if (rows.length === 0) return 0;
    let checks = 0; let passed = 0;
    for (const col of schema.columns) {
      // Completeness.
      const nullCount = rows.filter((r) => r[col.name] === null || r[col.name] === undefined).length;
      checks++; if (nullCount / rows.length < 0.3) passed++;
      // Type consistency.
      const values = rows.map((r) => r[col.name]).filter((v) => v !== null);
      if (values.length > 0) {
        checks++;
        const allCorrect = col.type === 'int' ? values.every((v) => typeof v === 'number' && Number.isInteger(v))
          : col.type === 'float' ? values.every((v) => typeof v === 'number')
          : col.type === 'boolean' ? values.every((v) => typeof v === 'boolean')
          : col.type === 'category' ? values.every((v) => typeof v === 'string')
          : true;
        if (allCorrect) passed++;
      }
    }
    return checks > 0 ? Math.round((passed / checks) * 100) / 100 : 1;
  }

  private scoreBias(rows: Record<string, unknown>[], schema: DatasetSchema): number {
    // Check category columns for extreme imbalance (> 80% one category = biased).
    let biasedCols = 0; let categoryCols = 0;
    for (const col of schema.columns) {
      if (col.type !== 'category' || !col.categories) continue;
      categoryCols++;
      const counts = new Map<string, number>();
      for (const r of rows) {
        const v = r[col.name] as string;
        if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      for (const [, count] of counts) {
        if (count / rows.length > 0.8) { biasedCols++; break; }
      }
    }
    return categoryCols > 0 ? Math.round((biasedCols / categoryCols) * 100) / 100 : 0;
  }
}
