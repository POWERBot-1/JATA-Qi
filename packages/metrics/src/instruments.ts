// Metric instruments: counter, gauge, histogram. Each is a self-contained series
// store keyed by label set, designed to be cheap to update from hot paths.

import type { HistogramSnapshot, Labels, MetricDescriptor, MetricSample } from './types.js';
import { DEFAULT_BUCKETS } from './types.js';

/** Stable string key for a label set so identical labels aggregate together. */
export function labelKey(labels: Labels | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${labels[k]}"`).join(',');
}

/**
 * Counter — monotonically increasing value (e.g. request count). `inc` only
 * accepts non-negative deltas.
 */
export class Counter {
  readonly name: string;
  readonly help?: string;
  private values = new Map<string, number>();

  constructor(desc: Pick<MetricDescriptor, 'name' | 'help'>) {
    this.name = desc.name;
    this.help = desc.help;
  }

  inc(delta = 1, labels?: Labels): this {
    if (delta < 0) throw new Error(`Counter "${this.name}": inc delta must be non-negative`);
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
    return this;
  }

  get(labels?: Labels): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  samples(): MetricSample[] {
    return [...this.values.entries()].map(([key, value]) => ({
      name: this.name,
      type: 'counter' as const,
      labels: parseKey(key),
      value,
    }));
  }
}

/** Gauge — arbitrary value that goes up and down (e.g. queue depth). */
export class Gauge {
  readonly name: string;
  readonly help?: string;
  private values = new Map<string, number>();

  constructor(desc: Pick<MetricDescriptor, 'name' | 'help'>) {
    this.name = desc.name;
    this.help = desc.help;
  }

  set(value: number, labels?: Labels): this {
    this.values.set(labelKey(labels), value);
    return this;
  }

  inc(delta = 1, labels?: Labels): this {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
    return this;
  }

  dec(delta = 1, labels?: Labels): this {
    return this.inc(-delta, labels);
  }

  get(labels?: Labels): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  samples(): MetricSample[] {
    return [...this.values.entries()].map(([key, value]) => ({
      name: this.name,
      type: 'gauge' as const,
      labels: parseKey(key),
      value,
    }));
  }
}

/**
 * Histogram — distribution of observations across fixed buckets. Approximates
 * percentiles via bucket interpolation (Prometheus quantile semantics).
 */
export class Histogram {
  readonly name: string;
  readonly help?: string;
  readonly buckets: readonly number[];
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();

  constructor(desc: Pick<MetricDescriptor, 'name' | 'help' | 'buckets'>) {
    this.name = desc.name;
    this.help = desc.help;
    this.buckets = desc.buckets ?? DEFAULT_BUCKETS;
  }

  observe(value: number, labels?: Labels): this {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { counts: new Array(this.buckets.length + 1).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        s.counts[i]! += 1;
      }
    }
    // Last bucket is +Inf.
    s.counts[this.buckets.length]! += 1;
    return this;
  }

  snapshot(labels?: Labels): HistogramSnapshot | undefined {
    const s = this.series.get(labelKey(labels));
    if (!s) return undefined;
    let running = 0;
    const buckets = this.buckets.map((le, i) => {
      // counts are cumulative per-bucket hits; convert to cumulative.
      return { le, count: 0 as number };
    });
    // Recompute cumulative from raw per-bucket hits stored in s.counts.
    // s.counts[i] is the number of observations <= buckets[i]; s.counts[last] is total.
    for (let i = 0; i < this.buckets.length; i++) {
      running = s.counts[i]!;
      buckets[i]!.count = running;
    }
    return { buckets, sum: s.sum, count: s.count };
  }

  /** Approximate a quantile (0..1) via linear interpolation between buckets. */
  quantile(q: number, labels?: Labels): number | undefined {
    const snap = this.snapshot(labels);
    if (!snap || snap.count === 0) return undefined;
    const target = q * snap.count;
    const bounds = [...this.buckets, Number.POSITIVE_INFINITY];
    let prevBound = Number.NEGATIVE_INFINITY;
    let prevCount = 0;
    for (let i = 0; i < snap.buckets.length; i++) {
      const count = snap.buckets[i]!.count;
      if (target <= count) {
        const bucketBound = bounds[i]!;
        if (bucketBound === Number.POSITIVE_INFINITY) return prevBound;
        const bucketCount = count - prevCount;
        if (bucketCount === 0) return bucketBound;
        const fraction = (target - prevCount) / bucketCount;
        return prevBound + fraction * (bucketBound - prevBound);
      }
      prevBound = bounds[i]!;
      prevCount = count;
    }
    return prevBound;
  }

  samples(): MetricSample[] {
    return [...this.series.entries()].map(([key]) => {
      const snap = this.snapshot(parseKey(key))!;
      return { name: this.name, type: 'histogram' as const, labels: parseKey(key), value: snap.count, histogram: snap };
    });
  }
}

/** Parse a labelKey() string back into a Labels object. */
function parseKey(key: string): Labels {
  if (!key) return {};
  const out: Labels = {};
  for (const part of key.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    let v = part.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
