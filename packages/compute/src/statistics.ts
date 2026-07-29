// Descriptive statistics over numeric samples.

export interface StatsSummary {
  count: number;
  mean: number;
  median: number;
  variance: number;
  stdev: number;
  min: number;
  max: number;
  sum: number;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const v of xs) s += v;
  return s / xs.length;
}

export function sum(xs: number[]): number {
  let s = 0;
  for (const v of xs) s += v;
  return s;
}

export function min(xs: number[]): number {
  let m = Infinity;
  for (const v of xs) if (v < m) m = v;
  return xs.length ? m : NaN;
}

export function max(xs: number[]): number {
  let m = -Infinity;
  for (const v of xs) if (v > m) m = v;
  return xs.length ? m : NaN;
}

export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const v of xs) s += (v - m) ** 2;
  return s / (xs.length - 1); // sample variance
}

export function stdev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const cur = sorted[base] ?? 0;
  const next = sorted[base + 1] ?? cur;
  return cur + rest * (next - cur);
}

/** Pearson correlation coefficient (-1..1). */
export function correlation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? NaN : num / den;
}

/** Sample covariance. */
export function covariance(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i]! - mx) * (ys[i]! - my);
  return s / (xs.length - 1);
}

export function summarize(xs: number[]): StatsSummary {
  return {
    count: xs.length,
    mean: mean(xs),
    median: median(xs),
    variance: variance(xs),
    stdev: stdev(xs),
    min: min(xs),
    max: max(xs),
    sum: sum(xs),
  };
}
