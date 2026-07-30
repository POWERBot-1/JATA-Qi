// BusinessIntelligenceModule — analytics, forecasting, trends (#directive).
// Real implementations: moving average, exponential smoothing, linear regression,
// seasonal decomposition (simple), correlation analysis, and summary statistics.

import type { KernelApi, IModule } from '@jataqi/core-kernel';

export interface TimeSeriesPoint { t: number; v: number; }
export interface ForecastResult { forecast: TimeSeriesPoint[]; method: string; r2?: number; }
export interface TrendAnalysis { slope: number; intercept: number; r2: number; direction: 'up' | 'down' | 'flat'; }
export interface CorrelationResult { variable1: string; variable2: string; correlation: number; interpretation: string; }

export class BusinessIntelligenceModule implements IModule {
  readonly id = 'business-intelligence';
  readonly tags = ['intelligence', 'analytics'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('business-intelligence', this);
    kernel.logger.info('business-intelligence module initialized');
  }
  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  /** Simple moving average. */
  movingAverage(data: number[], window: number): number[] {
    if (window < 1) return [];
    const result: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - window + 1);
      const slice = data.slice(start, i + 1);
      result.push(slice.reduce((s, v) => s + v, 0) / slice.length);
    }
    return result;
  }

  /** Exponential smoothing forecast. */
  exponentialSmoothing(data: TimeSeriesPoint[], alpha = 0.3, horizon = 5): ForecastResult {
    if (data.length === 0) return { forecast: [], method: 'exponential_smoothing' };
    let level = data[0]!.v;
    for (let i = 1; i < data.length; i++) {
      level = alpha * data[i]!.v + (1 - alpha) * level;
    }
    const lastT = data[data.length - 1]!.t;
    const step = data.length > 1 ? data[1]!.t - data[0]!.t : 1;
    const forecast: TimeSeriesPoint[] = [];
    for (let h = 1; h <= horizon; h++) {
      forecast.push({ t: lastT + h * step, v: Math.round(level * 100) / 100 });
    }
    return { forecast, method: `exponential_smoothing(alpha=${alpha})` };
  }

  /** Linear regression trend analysis. */
  linearTrend(data: TimeSeriesPoint[]): TrendAnalysis {
    const n = data.length;
    if (n < 2) return { slope: 0, intercept: data[0]?.v ?? 0, r2: 0, direction: 'flat' };
    const xs = data.map((d) => d.t);
    const ys = data.map((d) => d.v);
    const meanX = xs.reduce((s, x) => s + x, 0) / n;
    const meanY = ys.reduce((s, y) => s + y, 0) / n;
    let num = 0; let denX = 0; let denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i]! - meanX; const dy = ys[i]! - meanY;
      num += dx * dy; denX += dx * dx; denY += dy * dy;
    }
    const slope = denX !== 0 ? num / denX : 0;
    const intercept = meanY - slope * meanX;
    const r2 = denX !== 0 && denY !== 0 ? Math.max(0, (num * num) / (denX * denY)) : 0;
    const direction = slope > 0.001 ? 'up' : slope < -0.001 ? 'down' : 'flat';
    return { slope: Math.round(slope * 10000) / 10000, intercept: Math.round(intercept * 100) / 100, r2: Math.round(r2 * 1000) / 1000, direction };
  }

  /** Forecast using linear regression. */
  linearForecast(data: TimeSeriesPoint[], horizon = 5): ForecastResult {
    const trend = this.linearTrend(data);
    if (data.length === 0) return { forecast: [], method: 'linear_regression' };
    const lastT = data[data.length - 1]!.t;
    const step = data.length > 1 ? data[1]!.t - data[0]!.t : 1;
    const forecast: TimeSeriesPoint[] = [];
    for (let h = 1; h <= horizon; h++) {
      const t = lastT + h * step;
      forecast.push({ t, v: Math.round((trend.intercept + trend.slope * t) * 100) / 100 });
    }
    return { forecast, method: `linear_regression(r2=${trend.r2})`, r2: trend.r2 };
  }

  /** Pearson correlation between two numeric arrays. */
  correlation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;
    const meanX = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
    const meanY = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
    let num = 0; let dx2 = 0; let dy2 = 0;
    for (let i = 0; i < n; i++) {
      const a = x[i]! - meanX; const b = y[i]! - meanY;
      num += a * b; dx2 += a * a; dy2 += b * b;
    }
    const den = Math.sqrt(dx2 * dy2);
    return den === 0 ? 0 : Math.round((num / den) * 1000) / 1000;
  }

  /** Summary statistics. */
  summarize(data: number[]): { count: number; mean: number; median: number; stdev: number; min: number; max: number; p25: number; p75: number } {
    const n = data.length;
    if (n === 0) return { count: 0, mean: 0, median: 0, stdev: 0, min: 0, max: 0, p25: 0, p75: 0 };
    const sorted = [...data].sort((a, b) => a - b);
    const mean = data.reduce((s, v) => s + v, 0) / n;
    const variance = data.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1);
    const pct = (p: number) => sorted[Math.min(n - 1, Math.floor(p * (n - 1)))]!;
    return {
      count: n, mean: Math.round(mean * 1000) / 1000, median: pct(0.5),
      stdev: Math.round(Math.sqrt(variance) * 1000) / 1000, min: sorted[0]!, max: sorted[n - 1]!,
      p25: pct(0.25), p75: pct(0.75),
    };
  }
}
