// AiLearningModule — kernel module integrating the Prompt Registry, Quality
// Tracker, and Drift Detector. Records AI interaction outcomes into the Digital
// Memory Engine (governed), publishes bus events, and optionally feeds the
// Self-Evolution framework with drift signals.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { PromptRegistry } from './prompt-registry.js';
import { QualityTracker } from './quality.js';
import { DriftDetector } from './drift.js';
import type { DriftAlert, ModelBenchmark, PromptTemplate, PromptVersion, QualityMetrics, ResponseOutcome } from './types.js';

export const AiLearningEvents = Object.freeze({
  PromptCreated: 'ai-learning.prompt.created',
  PromptActivated: 'ai-learning.prompt.activated',
  QualityRecorded: 'ai-learning.quality.recorded',
  DriftDetected: 'ai-learning.drift.detected',
} as const);

export class AiLearningModule implements IModule {
  readonly id = 'ai-learning';
  readonly tags = ['core', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly registry = new PromptRegistry();
  readonly quality = new QualityTracker();
  readonly drift = new DriftDetector();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('ai-learning', this);
    kernel.logger.info('ai-learning module initialized');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- prompt registry ---------------------------------------------------

  createPrompt(input: { name: string; content: string; category: string; description?: string }): PromptTemplate {
    const t = this.registry.create(input);
    void this.api.bus.emit(AiLearningEvents.PromptCreated, { id: t.id, name: t.name });
    return t;
  }

  newVersion(templateId: string, content: string, notes?: string): PromptVersion {
    return this.registry.newVersion(templateId, content, notes);
  }

  approve(templateId: string, versionId: string, approver: string): PromptVersion {
    return this.registry.approve(templateId, versionId, approver);
  }

  activate(templateId: string, versionId: string): PromptVersion {
    const v = this.registry.activate(templateId, versionId);
    void this.api.bus.emit(AiLearningEvents.PromptActivated, { templateId, versionId });
    return v;
  }

  render(templateId: string, vars: Record<string, string>): string {
    return this.registry.render(templateId, vars);
  }

  getPrompt(id: string): PromptTemplate | undefined { return this.registry.get(id); }
  listPrompts(category?: string): PromptTemplate[] { return this.registry.list(category); }

  // ---- quality tracking --------------------------------------------------

  /** Record an AI response outcome (also feeds the DME if present). */
  recordOutcome(outcome: Omit<ResponseOutcome, 'id'>): ResponseOutcome {
    const full = this.quality.record(outcome);
    void this.api.bus.emit(AiLearningEvents.QualityRecorded, { id: full.id, model: outcome.model, outcome: outcome.outcome });
    // Feed into the Digital Memory Engine for governed long-term storage.
    try {
      const memory = this.api.getModule<DigitalMemoryModule>('memory');
      void memory.record({
        category: 'ai_response', summary: `${outcome.outcome} response from ${outcome.provider}/${outcome.model}`,
        data: { ...outcome, id: full.id }, tags: ['ai', outcome.outcome, outcome.model],
      });
    } catch { /* memory not registered — fine */ }
    return full;
  }

  promptMetrics(templateId: string): QualityMetrics { return this.quality.promptMetrics(templateId); }
  modelMetrics(model: string): QualityMetrics { return this.quality.modelMetrics(model); }
  modelBenchmarks(): ModelBenchmark[] { return this.quality.modelBenchmarks(); }
  bestModel(): ModelBenchmark | undefined { return this.quality.bestModel(); }

  // ---- drift detection ---------------------------------------------------

  /** Detect drift across all tracked prompts and models. */
  detectDrift(): DriftAlert[] {
    const alerts = this.drift.detectAll(this.quality);
    for (const a of alerts) void this.api.bus.emit(AiLearningEvents.DriftDetected, { scope: a.scope, metric: a.metric, severity: a.severity });
    return alerts;
  }
}

export { PromptRegistry, QualityTracker, DriftDetector };
