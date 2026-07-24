// JATA Qi Metrics — types.
// Observability primitives (spec Step 15 "Observability": logs, metrics, traces,
// audit records, health). A metric is identified by name and an optional set of
// label key/value pairs.

export type MetricType = 'counter' | 'gauge' | 'histogram';

export type Labels = Record<string, string>;

export interface MetricDescriptor {
  readonly name: string;
  readonly type: MetricType;
  readonly help?: string;
  /** Fixed label keys this metric is expected to carry. */
  readonly labelNames?: readonly string[];
  /** Bucket upper bounds for histograms (must be ascending). */
  readonly buckets?: readonly number[];
}

/** Snapshot of a single histogram series. */
export interface HistogramSnapshot {
  buckets: { le: number; count: number }[];
  sum: number;
  count: number;
}

/** A point-in-time value of any metric series. */
export interface MetricSample {
  name: string;
  type: MetricType;
  labels: Labels;
  value: number;
  /** Present only for histograms. */
  histogram?: HistogramSnapshot;
}

export const MetricsEvents = Object.freeze({
  MetricRegistered: 'metrics.metric.registered',
} as const);

/** Default histogram buckets (Prometheus-style, seconds-ish latency buckets). */
export const DEFAULT_BUCKETS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const);
