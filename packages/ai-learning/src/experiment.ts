// ExperimentEngine (CLP Phase 4) — eval-gated prompt experimentation.
//
// Runs champion/challenger experiments over prompt template versions:
//  1. create()   — a challenger version is paired against the active champion.
//  2. serve()    — online traffic is split between the two variants.
//  3. evaluate() — recorded response outcomes are compared per variant and the
//                  engine decides promote / keep / insufficient-data / regression.
//  4. conclude() — promotion activates the challenger via the prompt registry.
//
// The decision is intentionally conservative: a challenger must beat the
// champion's acceptance rate by `minAcceptanceGain` (default +3 percentage
// points) with at least `minOutcomes` recorded outcomes per variant, and must
// not regress latency by more than 50%. This is "eval-gated learning" — no
// prompt change ships without evidence, closing the CLP Phase 3 → 7 loop.

import { randomUUID } from 'node:crypto';
import { PromptRegistry } from './prompt-registry.js';
import { QualityTracker } from './quality.js';
import type {
  ExperimentDecision, ExperimentStatus, ExperimentVariant, PromptExperiment,
  QualityMetrics,
} from './types.js';

export interface CreateExperimentInput {
  templateId: string;
  /** The challenger version id (must exist and be reviewed/approved). */
  challengerVersionId: string;
  name?: string;
  /** Traffic share for the challenger (0..1, default 0.5). */
  challengerTraffic?: number;
  /** Minimum outcomes per variant before evaluation (default 10). */
  minOutcomes?: number;
  /** Minimum acceptance-rate gain in percentage points (default 0.03). */
  minAcceptanceGain?: number;
  createdBy: string;
}

export interface ExperimentServeResult {
  experimentId: string;
  variant: ExperimentVariant;
  versionId: string;
  text: string;
}

export interface ExperimentEvaluation {
  experiment: PromptExperiment;
  decision: ExperimentDecision;
  reason: string;
  championMetrics: QualityMetrics;
  challengerMetrics: QualityMetrics;
  /** True when the evaluation promoted (activated) the challenger. */
  promoted: boolean;
}

export class ExperimentEngine {
  private experiments = new Map<string, PromptExperiment>();

  constructor(
    private readonly registry: PromptRegistry,
    private readonly quality: QualityTracker,
  ) {}

  /** Create a champion/challenger experiment for a prompt template. */
  create(input: CreateExperimentInput): PromptExperiment {
    const template = this.registry.get(input.templateId);
    if (!template) throw new Error(`template ${input.templateId} not found`);
    const champion = template.activeVersionId;
    if (!champion) throw new Error(`template ${input.templateId} has no active version (champion required)`);
    if (champion === input.challengerVersionId) throw new Error('challenger must differ from the active version');
    const challenger = template.versions.find((v) => v.id === input.challengerVersionId);
    if (!challenger) throw new Error(`challenger version ${input.challengerVersionId} not found`);
    if (challenger.status !== 'reviewed') throw new Error('challenger must be approved (status "reviewed") before experimentation');

    // Only one running experiment per template at a time.
    for (const ex of this.experiments.values()) {
      if (ex.templateId === input.templateId && ex.status === 'running') {
        throw new Error(`template ${input.templateId} already has a running experiment`);
      }
    }

    const experiment: PromptExperiment = {
      id: randomUUID(),
      templateId: input.templateId,
      name: input.name ?? `Experiment ${template.name}`,
      championVersionId: champion,
      challengerVersionId: input.challengerVersionId,
      status: 'running',
      startedAt: Date.now(),
      challengerTraffic: clamp01(input.challengerTraffic ?? 0.5),
      minOutcomes: input.minOutcomes ?? 10,
      minAcceptanceGain: input.minAcceptanceGain ?? 0.03,
      createdBy: input.createdBy,
    };
    this.experiments.set(experiment.id, experiment);
    return experiment;
  }

  get(id: string): PromptExperiment | undefined {
    return this.experiments.get(id);
  }

  list(status?: ExperimentStatus): PromptExperiment[] {
    const all = [...this.experiments.values()];
    return status ? all.filter((e) => e.status === status) : all;
  }

  /** Running experiments for a template (0 or 1). */
  runningFor(templateId: string): PromptExperiment | undefined {
    return [...this.experiments.values()].find((e) => e.templateId === templateId && e.status === 'running');
  }

  /**
   * Serve a rendered prompt through a running experiment: routes the request
   * to the champion or challenger variant by the configured traffic split.
   * Returns undefined when no experiment is running (caller falls back to the
   * active version).
   */
  serve(templateId: string, vars: Record<string, string>): ExperimentServeResult | undefined {
    const experiment = this.runningFor(templateId);
    if (!experiment) return undefined;
    const variant: ExperimentVariant = Math.random() < experiment.challengerTraffic ? 'challenger' : 'champion';
    const versionId = variant === 'challenger' ? experiment.challengerVersionId : experiment.championVersionId;
    const version = this.registry.get(templateId)?.versions.find((v) => v.id === versionId);
    if (!version) return undefined;
    return { experimentId: experiment.id, variant, versionId, text: render(version.content, vars) };
  }

  /**
   * Evaluate a running experiment against recorded outcomes. Safe to call
   * repeatedly; promotion (registry.activate) happens here when the evidence
   * is conclusive, but the experiment stays 'running' until conclude().
   */
  evaluate(id: string): ExperimentEvaluation {
    const experiment = this.requireRunning(id);
    const template = this.registry.get(experiment.templateId);
    if (!template) throw new Error(`template ${experiment.templateId} not found`);

    const championOutcomes = this.quality.list({ promptTemplateId: template.id, promptVersionId: experiment.championVersionId });
    const challengerOutcomes = this.quality.list({ promptTemplateId: template.id, promptVersionId: experiment.challengerVersionId });
    const championMetrics = this.quality.compute(championOutcomes);
    const challengerMetrics = this.quality.compute(challengerOutcomes);

    const reason = (decision: ExperimentDecision, detail: string) =>
      `${detail} (champion n=${championOutcomes.length}, challenger n=${challengerOutcomes.length})`;

    let decision: ExperimentDecision;
    let detail: string;
    if (championOutcomes.length < experiment.minOutcomes || challengerOutcomes.length < experiment.minOutcomes) {
      decision = 'insufficient-data';
      detail = 'not enough recorded outcomes per variant yet';
    } else if (challengerMetrics.acceptanceRate >= championMetrics.acceptanceRate + experiment.minAcceptanceGain) {
      // Latency guard: never promote something measurably slower.
      if (challengerMetrics.avgLatencyMs > championMetrics.avgLatencyMs * 1.5 && championMetrics.avgLatencyMs > 0) {
        decision = 'regression';
        detail = 'acceptance is better but latency regressed >50%';
      } else {
        decision = 'promote';
        detail = `acceptance ${(championMetrics.acceptanceRate * 100).toFixed(1)}% → ${(challengerMetrics.acceptanceRate * 100).toFixed(1)}% (gain ≥ ${(experiment.minAcceptanceGain * 100).toFixed(0)}pp)`;
      }
    } else if (challengerMetrics.acceptanceRate < championMetrics.acceptanceRate - experiment.minAcceptanceGain) {
      decision = 'regression';
      detail = `acceptance dropped from ${(championMetrics.acceptanceRate * 100).toFixed(1)}% to ${(challengerMetrics.acceptanceRate * 100).toFixed(1)}%`;
    } else {
      decision = 'keep';
      detail = 'no significant acceptance difference (within tolerance)';
    }

    experiment.metrics = { champion: championMetrics, challenger: challengerMetrics };
    experiment.reason = reason(decision, detail);

    let promoted = false;
    if (decision === 'promote') {
      // Idempotent: a previous evaluation may already have activated the
      // challenger (conclude() re-evaluates), so only activate once.
      if (this.registry.get(experiment.templateId)?.activeVersionId !== experiment.challengerVersionId) {
        this.registry.activate(experiment.templateId, experiment.challengerVersionId);
      }
      promoted = true;
    }

    return {
      experiment,
      decision,
      reason: experiment.reason,
      championMetrics,
      challengerMetrics,
      promoted,
    };
  }

  /** Conclude a running experiment, finalizing its decision. */
  conclude(id: string): PromptExperiment {
    const experiment = this.requireRunning(id);
    const evaluation = this.evaluate(id);
    experiment.decision = evaluation.decision;
    experiment.status = 'concluded';
    experiment.concludedAt = Date.now();
    return experiment;
  }

  /** Cancel a running experiment without promoting the challenger. */
  cancel(id: string): PromptExperiment {
    const experiment = this.requireRunning(id);
    experiment.status = 'cancelled';
    experiment.concludedAt = Date.now();
    experiment.decision = 'keep';
    experiment.reason = 'cancelled by operator';
    return experiment;
  }

  private requireRunning(id: string): PromptExperiment {
    const experiment = this.experiments.get(id);
    if (!experiment) throw new Error(`experiment ${id} not found`);
    if (experiment.status !== 'running') throw new Error(`experiment ${id} is not running (${experiment.status})`);
    return experiment;
  }
}

/** Render a prompt template string with {{mustache}} variables. */
function render(content: string, vars: Record<string, string>): string {
  let out = content;
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`{{${key}}}`, value);
  return out;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
