// Quality Tracker — records per-response outcomes and computes aggregated
// quality metrics for prompt versions, models, and providers. Powers prompt
// analytics, model benchmarking, and drift detection.

import { randomUUID } from 'node:crypto';
import type { ModelBenchmark, PromptTemplate, QualityMetrics, ResponseOutcome } from './types.js';

export class QualityTracker {
  private outcomes: ResponseOutcome[] = [];

  /** Record an AI response outcome. */
  record(outcome: Omit<ResponseOutcome, 'id'>): ResponseOutcome {
    const full: ResponseOutcome = { id: randomUUID(), ...outcome };
    this.outcomes.push(full);
    return full;
  }

  /** All recorded outcomes (optionally filtered). */
  list(filter?: { promptTemplateId?: string; promptVersionId?: string; model?: string; provider?: string; orgId?: string; fromTs?: number; toTs?: number }): ResponseOutcome[] {
    return this.outcomes.filter((o) =>
      (!filter?.promptTemplateId || o.promptTemplateId === filter.promptTemplateId) &&
      (!filter?.promptVersionId || o.promptVersionId === filter.promptVersionId) &&
      (!filter?.model || o.model === filter.model) &&
      (!filter?.provider || o.provider === filter.provider) &&
      (!filter?.orgId || o.orgId === filter.orgId) &&
      (!filter?.fromTs || o.ts >= filter.fromTs) &&
      (!filter?.toTs || o.ts <= filter.toTs));
  }

  get size(): number { return this.outcomes.length; }

  /** Compute quality metrics for a set of outcomes. */
  compute(outcomes: ResponseOutcome[]): QualityMetrics {
    if (outcomes.length === 0) return emptyMetrics();
    const total = outcomes.length;
    const accepted = outcomes.filter((o) => o.outcome === 'accepted').length;
    const edited = outcomes.filter((o) => o.outcome === 'edited').length;
    const rejected = outcomes.filter((o) => o.outcome === 'rejected').length;
    const rated = outcomes.filter((o) => o.rating !== undefined);
    const withCost = outcomes.filter((o) => o.costUsd !== undefined);
    const withConf = outcomes.filter((o) => o.confidence !== undefined);
    const withTokensIn = outcomes.filter((o) => o.tokensIn !== undefined);
    const withTokensOut = outcomes.filter((o) => o.tokensOut !== undefined);
    return {
      total, accepted, edited, rejected,
      acceptanceRate: accepted / total,
      avgRating: rated.length > 0 ? rated.reduce((s, o) => s + (o.rating ?? 0), 0) / rated.length : 0,
      avgLatencyMs: outcomes.reduce((s, o) => s + o.latencyMs, 0) / total,
      avgCostUsd: withCost.length > 0 ? withCost.reduce((s, o) => s + (o.costUsd ?? 0), 0) / withCost.length : 0,
      avgConfidence: withConf.length > 0 ? withConf.reduce((s, o) => s + (o.confidence ?? 0), 0) / withConf.length : 0,
      avgTokensIn: withTokensIn.length > 0 ? withTokensIn.reduce((s, o) => s + (o.tokensIn ?? 0), 0) / withTokensIn.length : 0,
      avgTokensOut: withTokensOut.length > 0 ? withTokensOut.reduce((s, o) => s + (o.tokensOut ?? 0), 0) / withTokensOut.length : 0,
    };
  }

  /** Quality metrics for a specific prompt template (all its outcomes). */
  promptMetrics(templateId: string): QualityMetrics {
    return this.compute(this.list({ promptTemplateId: templateId }));
  }

  /** Quality metrics for a specific model. */
  modelMetrics(model: string): QualityMetrics {
    return this.compute(this.list({ model }));
  }

  /** Benchmark all models/providers. */
  modelBenchmarks(): ModelBenchmark[] {
    const byModel = new Map<string, ResponseOutcome[]>();
    for (const o of this.outcomes) {
      const key = `${o.provider}/${o.model}`;
      const arr = byModel.get(key) ?? [];
      arr.push(o);
      byModel.set(key, arr);
    }
    return [...byModel.entries()].map(([key, outcomes]) => {
      const [provider, model] = key.split('/');
      const metrics = this.compute(outcomes);
      const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
      return {
        model: model!, provider: provider!, metrics,
        costPerAccept: metrics.accepted > 0 ? outcomes.filter((o) => o.outcome === 'accepted').reduce((s, o) => s + (o.costUsd ?? 0), 0) / metrics.accepted : 0,
        p50Latency: percentile(latencies, 0.5),
        p95Latency: percentile(latencies, 0.95),
      };
    }).sort((a, b) => b.metrics.acceptanceRate - a.metrics.acceptanceRate);
  }

  /** Suggest the best model for a category based on quality + cost. */
  bestModel(): ModelBenchmark | undefined {
    const benchmarks = this.modelBenchmarks();
    return benchmarks[0];
  }
}

function emptyMetrics(): QualityMetrics {
  return { total: 0, accepted: 0, edited: 0, rejected: 0, acceptanceRate: 0, avgRating: 0, avgLatencyMs: 0, avgCostUsd: 0, avgConfidence: 0, avgTokensIn: 0, avgTokensOut: 0 };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}
