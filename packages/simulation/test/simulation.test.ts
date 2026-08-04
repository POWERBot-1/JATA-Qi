import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  simulate,
  uniform,
  normal,
  constant,
  triangular,
  SimulationModule,
} from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';

describe('distributions + simulator', () => {
  it('is deterministic for a fixed seed', () => {
    const a = simulate({
      name: 'dice',
      inputs: { roll: uniform(1, 7) },
      output: (c) => Math.floor(c.roll),
      trials: 1000,
      seed: 42,
    });
    const b = simulate({
      name: 'dice',
      inputs: { roll: uniform(1, 7) },
      output: (c) => Math.floor(c.roll),
      trials: 1000,
      seed: 42,
    });
    assert.deepEqual(a.samples, b.samples);
  });

  it('estimates the mean of a uniform distribution within tolerance', () => {
    const r = simulate({
      name: 'u01',
      inputs: { x: uniform(0, 1) },
      output: (c) => c.x,
      trials: 20000,
      seed: 1,
    });
    assert.ok(Math.abs(r.stats.mean - 0.5) < 0.02, `mean=${r.stats.mean}`);
    assert.ok(r.stats.min >= 0);
    assert.ok(r.stats.max <= 1);
  });

  it('estimates the mean of a normal distribution', () => {
    const r = simulate({
      name: 'normal',
      inputs: { x: normal(100, 15) },
      output: (c) => c.x,
      trials: 20000,
      seed: 7,
    });
    assert.ok(Math.abs(r.stats.mean - 100) < 1.5, `mean=${r.stats.mean}`);
    assert.ok(Math.abs(r.stats.stdev - 15) < 1.5, `sd=${r.stats.stdev}`);
    // ~95% within 2 SD.
    assert.ok(r.stats.p95 > 100);
  });

  it('reports probability of meeting a target', () => {
    const r = simulate({
      name: 'profit',
      inputs: { revenue: uniform(80, 120), cost: constant(100) },
      output: (c) => c.revenue - c.cost,
      trials: 20000,
      seed: 3,
      targets: [0],
    });
    // P(profit <= 0) should be roughly 0.5 (revenue uniform on [80,120], cost 100).
    assert.ok(r.probabilities && Math.abs(r.probabilities['0']! - 0.5) < 0.05);
  });

  it('always carries the modeled-scenario caveat', () => {
    const r = simulate({
      name: 'tri',
      inputs: { x: triangular(0, 1, 2) },
      output: (c) => c.x,
      trials: 10,
      seed: 1,
    });
    assert.match(r.caveat, /Modeled scenario/i);
  });

  it('produces a coarse histogram', () => {
    const r = simulate({
      name: 'hist',
      inputs: { x: uniform(0, 10) },
      output: (c) => c.x,
      trials: 1000,
      seed: 2,
    });
    assert.ok(r.histogram.length >= 5);
    const total = r.histogram.reduce((n, b) => n + b.count, 0);
    assert.equal(total, 1000);
  });
});

describe('SimulationModule (kernel integration)', () => {
  it('runs a scenario and emits an event', async () => {
    const k = createTestKernel();
    k.register(new SimulationModule());
    await k.boot();
    const mod = k.getModule<SimulationModule>('simulation');
    let fired = false;
    k.bus.on('simulation.completed', () => { fired = true; });
    const r = await mod.run({
      name: 'm',
      inputs: { x: uniform(0, 1) },
      output: (c) => c.x,
      trials: 500,
      seed: 9,
    });
    assert.equal(r.trials, 500);
    assert.equal(fired, true);
    await k.shutdown();
  });
});
