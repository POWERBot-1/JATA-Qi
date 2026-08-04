// Descriptive statistics over a sample of numbers, with quantile estimation.

import type { Stats } from './types.js';

/** Compute mean, stdev, min, max and common percentiles. */
export function computeStats(samples: number[]): Stats {
  const n = samples.length;
  if (n === 0) {
    return { count: 0, mean: 0, stdev: 0, min: 0, max: 0, p05: 0, p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let sq = 0;
  for (const v of samples) sq += (v - mean) ** 2;
  const stdev = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;

  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: n,
    mean,
    stdev,
    min,
    max,
    p05: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
  };
}

/** Quantile from an already-sorted array (linear interpolation, R-7). */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] ?? sorted[base]!;
  return sorted[base]! + rest * (next - sorted[base]!);
}

/** Build a coarse histogram (default 10 equal-width buckets). */
export function histogram(samples: number[], buckets = 10): { bucket: string; count: number }[] {
  if (samples.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return [{ bucket: `[${min}]`, count: samples.length }];
  const width = (max - min) / buckets;
  const counts = new Array<number>(buckets).fill(0);
  for (const v of samples) {
    let idx = Math.floor((v - min) / width);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    counts[idx]! += 1;
  }
  return counts.map((count, i) => {
    const lo = min + i * width;
    const hi = i === buckets - 1 ? max : lo + width;
    return { bucket: `[${round(lo)}, ${round(hi)})`, count };
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
