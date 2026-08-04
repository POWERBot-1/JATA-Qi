import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mean, median, stdev, correlation, summarize, linearRegression, minimize, bisect,
  statsTool, regressionTool, ComputeModule,
} from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';

describe('statistics', () => {
  it('computes mean, median, stdev', () => {
    assert.equal(mean([1, 2, 3, 4]), 2.5);
    assert.equal(median([1, 3, 3, 6, 7, 8, 9]), 6);
    assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.01);
  });

  it('summarizes a series', () => {
    const s = summarize([10, 20, 30]);
    assert.equal(s.count, 3);
    assert.equal(s.mean, 20);
    assert.equal(s.min, 10);
    assert.equal(s.max, 30);
    assert.equal(s.sum, 60);
  });

  it('computes correlation', () => {
    const r = correlation([1, 2, 3, 4], [2, 4, 6, 8]);
    assert.ok(Math.abs(r - 1) < 1e-9); // perfectly correlated
  });
});

describe('regression', () => {
  it('fits a perfect line', () => {
    const fit = linearRegression([1, 2, 3, 4], [3, 5, 7, 9]); // y = 2x + 1
    assert.ok(Math.abs(fit.slope - 2) < 1e-9);
    assert.ok(Math.abs(fit.intercept - 1) < 1e-9);
    assert.ok(Math.abs(fit.r2 - 1) < 1e-9);
  });

  it('rejects mismatched or too-short arrays', () => {
    assert.throws(() => linearRegression([1, 2], [1]), /equal-length/);
    assert.throws(() => linearRegression([1], [1]), />= 2/);
  });
});

describe('numerical', () => {
  it('minimizes a quadratic near its vertex', () => {
    // f(x) = (x-3)^2, minimum at x=3
    const r = minimize((x) => (x - 3) ** 2, 0, { lr: 0.1, iters: 1000 });
    assert.ok(Math.abs(r.x - 3) < 1e-2, `x=${r.x}`);
    assert.equal(r.converged, true);
  });

  it('finds a root by bisection', () => {
    const root = bisect((x) => x ** 2 - 2, 0, 2);
    assert.ok(Math.abs(root - Math.SQRT2) < 1e-5);
  });

  it('rejects bisection without a sign change', () => {
    assert.throws(() => bisect((x) => x ** 2 + 1, -1, 1), /opposite signs/);
  });
});

describe('agent tools', () => {
  it('stats tool summarizes a series', async () => {
    const tool = statsTool();
    const out = await tool.execute({ values: [1, 2, 3, 4] }, { runId: 't', logger: { info() {}, debug() {}, error() {} }, metadata: {} });
    assert.equal((out as { mean: number }).mean, 2.5);
  });

  it('regression tool fits and reports correlation', async () => {
    const tool = regressionTool();
    const out = await tool.execute({ x: [1, 2, 3], y: [2, 4, 6] }, { runId: 't', logger: { info() {}, debug() {}, error() {} }, metadata: {} });
    const r = out as { slope: number; r2: number; correlation: number };
    assert.ok(Math.abs(r.slope - 2) < 1e-9);
    assert.ok(Math.abs(r.correlation - 1) < 1e-9);
  });
});

describe('ComputeModule (kernel integration)', () => {
  it('registers and exposes the functions', async () => {
    const k = createTestKernel();
    k.register(new ComputeModule());
    await k.boot();
    const mod = k.getModule<ComputeModule>('compute');
    assert.equal(mod.stats.mean([4, 6]), 5);
    assert.doesNotThrow(() => mod.linearRegression([1, 2, 3], [1, 2, 3]));
    await k.shutdown();
  });
});
