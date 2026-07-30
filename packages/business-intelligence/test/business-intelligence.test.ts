import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BusinessIntelligenceModule } from '../src/index.js';
import type { TimeSeriesPoint } from '../src/index.js';

const bi = new BusinessIntelligenceModule();

describe('BusinessIntelligenceModule', () => {
  it('computes moving averages', () => {
    const ma = bi.movingAverage([1, 2, 3, 4, 5], 3);
    assert.equal(ma.length, 5);
    assert.equal(ma[2]!, 2); // (1+2+3)/3 = 2
    assert.equal(ma[4]!, 4); // (3+4+5)/3 = 4
  });

  it('forecasts with exponential smoothing', () => {
    const data: TimeSeriesPoint[] = [{ t: 1, v: 10 }, { t: 2, v: 20 }, { t: 3, v: 30 }];
    const f = bi.exponentialSmoothing(data, 0.5, 3);
    assert.equal(f.forecast.length, 3);
    assert.ok(f.forecast[0]!.v > 0);
  });

  it('detects linear trends', () => {
    const data: TimeSeriesPoint[] = Array.from({ length: 10 }, (_, i) => ({ t: i, v: 2 * i + 5 }));
    const trend = bi.linearTrend(data);
    assert.equal(trend.direction, 'up');
    assert.ok(Math.abs(trend.slope - 2) < 0.01, `slope=${trend.slope}`);
    assert.equal(trend.r2, 1); // perfect linear fit
  });

  it('forecasts using linear regression', () => {
    const data: TimeSeriesPoint[] = Array.from({ length: 5 }, (_, i) => ({ t: i, v: 10 + i * 3 }));
    const f = bi.linearForecast(data, 2);
    assert.equal(f.forecast.length, 2);
    assert.ok(Math.abs(f.forecast[0]!.v - 25) < 1); // t=5: intercept(10)+slope(3)*5=25
    assert.ok(Math.abs(f.forecast[1]!.v - 28) < 1); // t=6: 10+3*6=28
  });

  it('computes Pearson correlation', () => {
    const r = bi.correlation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    assert.ok(Math.abs(r - 1) < 0.01); // perfectly correlated
    const r2 = bi.correlation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
    assert.ok(Math.abs(r2 - (-1)) < 0.01); // perfectly anti-correlated
  });

  it('computes summary statistics', () => {
    const s = bi.summarize([10, 20, 30, 40, 50]);
    assert.equal(s.count, 5);
    assert.equal(s.mean, 30);
    assert.equal(s.median, 30);
    assert.equal(s.min, 10);
    assert.equal(s.max, 50);
    assert.ok(s.stdev > 0);
  });
});
