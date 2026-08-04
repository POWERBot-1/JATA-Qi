import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticDataModule } from '../src/index.js';
import type { DatasetSchema } from '../src/index.js';

const mod = new SyntheticDataModule();

describe('SyntheticDataModule', () => {
  it('generates a tabular dataset with the correct row count', () => {
    const schema: DatasetSchema = { name: 'test', rowCount: 50, columns: [
      { name: 'id', type: 'int', min: 1, max: 1000 },
      { name: 'score', type: 'float', min: 0, max: 100 },
      { name: 'active', type: 'boolean' },
    ] };
    const ds = mod.generate(schema, 'test-seed');
    assert.equal(ds.rows.length, 50);
    assert.equal(ds.seed, 'test-seed');
    assert.ok(ds.qualityScore > 0.5);
  });

  it('produces reproducible results with the same seed', () => {
    const schema: DatasetSchema = { name: 'repro', rowCount: 10, columns: [{ name: 'v', type: 'int', min: 0, max: 99 }] };
    const a = mod.generate(schema, 'seed-42');
    const b = mod.generate(schema, 'seed-42');
    assert.deepEqual(a.rows, b.rows);
  });

  it('generates different results with different seeds', () => {
    const schema: DatasetSchema = { name: 'diff', rowCount: 10, columns: [{ name: 'v', type: 'int', min: 0, max: 99 }] };
    const a = mod.generate(schema, 'seed-a');
    const b = mod.generate(schema, 'seed-b');
    assert.notDeepEqual(a.rows, b.rows);
  });

  it('supports normal distribution', () => {
    const schema: DatasetSchema = { name: 'normal', rowCount: 100, columns: [
      { name: 'iq', type: 'float', distribution: 'normal', mean: 100, stdDev: 15 },
    ] };
    const ds = mod.generate(schema, 'normal-seed');
    const vals = ds.rows.map((r) => r.iq as number);
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    assert.ok(Math.abs(avg - 100) < 10, `avg=${avg}`); // mean ~100
  });

  it('supports categorical data', () => {
    const schema: DatasetSchema = { name: 'cats', rowCount: 30, columns: [
      { name: 'region', type: 'category', categories: ['NA', 'EU', 'APAC', 'LATAM'] },
    ] };
    const ds = mod.generate(schema, 'cat-seed');
    const regions = ds.rows.map((r) => r.region);
    assert.ok(regions.every((r) => ['NA', 'EU', 'APAC', 'LATAM'].includes(r as string)));
  });

  it('injects nulls at the specified rate', () => {
    const schema: DatasetSchema = { name: 'nulls', rowCount: 100, columns: [
      { name: 'x', type: 'int', min: 0, max: 99, nullRate: 0.3 },
    ] };
    const ds = mod.generate(schema, 'null-seed');
    const nullCount = ds.rows.filter((r) => r.x === null).length;
    assert.ok(nullCount > 10 && nullCount < 60, `nulls=${nullCount}`);
  });

  it('scores quality and bias', () => {
    const schema: DatasetSchema = { name: 'score', rowCount: 100, columns: [
      { name: 'a', type: 'int', min: 0, max: 10 },
      { name: 'cat', type: 'category', categories: ['X', 'Y', 'Z'] },
    ] };
    const ds = mod.generate(schema, 'q-seed');
    assert.ok(ds.qualityScore > 0.5);
    assert.ok(ds.biasScore >= 0 && ds.biasScore <= 1);
  });
});
