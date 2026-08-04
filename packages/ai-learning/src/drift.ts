// Drift Detector — detects AI quality degradation over time by comparing a
// recent window of outcomes against the baseline. Fires warnings/criticals when
// acceptance rate drops, ratings fall, or latency spikes beyond thresholds.

import { randomUUID } from 'node:crypto';
import type { DriftAlert, ResponseOutcome } from './types.js';
import { QualityTracker } from './quality.js';

export interface DriftConfig {
  /** Minimum outcomes before drift detection runs. */
  minSamples?: number;
  /** Recent window size (number of outcomes). */
  windowSize?: number;
  /** Acceptance-rate drop that triggers a warning (fraction, e.g. 0.15 = 15%). */
  warningThreshold?: number;
  /** Drop that triggers a critical (fraction). */
  criticalThreshold?: number;
}

const DEFAULTS: Required<DriftConfig> = {
  minSamples: 10,
  windowSize: 20,
  warningThreshold: 0.15,
  criticalThreshold: 0.30,
};

export class DriftDetector {
  private config: Required<DriftConfig>;

  constructor(config: DriftConfig = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  /** Detect drift for a single scope (templateId or model name). */
  detect(scope: string, outcomes: ResponseOutcome[]): DriftAlert[] {
    const alerts: DriftAlert[] = [];
    if (outcomes.length < this.config.minSamples) return alerts;

    const sorted = [...outcomes].sort((a, b) => a.ts - b.ts);
    const window = Math.min(this.config.windowSize, Math.floor(sorted.length / 3));
    if (window < 3) return alerts;
    const recent = sorted.slice(-window);
    const baseline = sorted.slice(0, sorted.length - window);

    const recentMetrics = this.metrics(recent);
    const baselineMetrics = this.metrics(baseline);
    const now = Date.now();

    // Acceptance rate degradation.
    const acceptanceDrop = baselineMetrics.acceptanceRate - recentMetrics.acceptanceRate;
    if (acceptanceDrop >= this.config.criticalThreshold) {
      alerts.push(this.alert(scope, 'acceptanceRate', baselineMetrics.acceptanceRate, recentMetrics.acceptanceRate, 'critical', now));
    } else if (acceptanceDrop >= this.config.warningThreshold) {
      alerts.push(this.alert(scope, 'acceptanceRate', baselineMetrics.acceptanceRate, recentMetrics.acceptanceRate, 'warning', now));
    }

    // Rating degradation.
    if (baselineMetrics.avgRating > 0) {
      const ratingDrop = baselineMetrics.avgRating - recentMetrics.avgRating;
      if (ratingDrop >= this.config.criticalThreshold) {
        alerts.push(this.alert(scope, 'avgRating', baselineMetrics.avgRating, recentMetrics.avgRating, 'critical', now));
      } else if (ratingDrop >= this.config.warningThreshold) {
        alerts.push(this.alert(scope, 'avgRating', baselineMetrics.avgRating, recentMetrics.avgRating, 'warning', now));
      }
    }

    // Latency increase.
    if (baselineMetrics.avgLatencyMs > 0) {
      const latencyIncrease = (recentMetrics.avgLatencyMs - baselineMetrics.avgLatencyMs) / baselineMetrics.avgLatencyMs;
      if (latencyIncrease >= this.config.criticalThreshold) {
        alerts.push(this.alert(scope, 'avgLatencyMs', baselineMetrics.avgLatencyMs, recentMetrics.avgLatencyMs, 'critical', now));
      } else if (latencyIncrease >= this.config.warningThreshold) {
        alerts.push(this.alert(scope, 'avgLatencyMs', baselineMetrics.avgLatencyMs, recentMetrics.avgLatencyMs, 'warning', now));
      }
    }

    return alerts;
  }

  /** Detect drift across all templates and models. */
  detectAll(tracker: QualityTracker): DriftAlert[] {
    const alerts: DriftAlert[] = [];
    // Group outcomes by templateId and by model.
    const byTemplate = new Map<string, ResponseOutcome[]>();
    const byModel = new Map<string, ResponseOutcome[]>();
    for (const o of tracker.list()) {
      if (o.promptTemplateId) {
        const arr = byTemplate.get(o.promptTemplateId) ?? [];
        arr.push(o);
        byTemplate.set(o.promptTemplateId, arr);
      }
      const marr = byModel.get(o.model) ?? [];
      marr.push(o);
      byModel.set(o.model, marr);
    }
    for (const [scope, outcomes] of byTemplate) alerts.push(...this.detect(scope, outcomes));
    for (const [scope, outcomes] of byModel) alerts.push(...this.detect(scope, outcomes));
    return alerts;
  }

  private metrics(outcomes: ResponseOutcome[]): { acceptanceRate: number; avgRating: number; avgLatencyMs: number } {
    if (outcomes.length === 0) return { acceptanceRate: 0, avgRating: 0, avgLatencyMs: 0 };
    return {
      acceptanceRate: outcomes.filter((o) => o.outcome === 'accepted').length / outcomes.length,
      avgRating: outcomes.filter((o) => o.rating !== undefined).reduce((s, o) => s + (o.rating ?? 0), 0) / Math.max(1, outcomes.filter((o) => o.rating !== undefined).length),
      avgLatencyMs: outcomes.reduce((s, o) => s + o.latencyMs, 0) / outcomes.length,
    };
  }

  private alert(scope: string, metric: DriftAlert['metric'], baselineValue: number, recentValue: number, severity: DriftAlert['severity'], ts: number): DriftAlert {
    const change = metric === 'avgLatencyMs' ? recentValue - baselineValue : recentValue - baselineValue;
    return { id: randomUUID(), scope, metric, baselineValue, recentValue, change, severity, detectedAt: ts };
  }
}
