// Model capability registry and telemetry tracker.

import type { ModelMetadata, TaskProfile } from './types.js';

export class ModelRegistry {
  private readonly models = new Map<string, ModelMetadata>();
  private readonly telemetry = new Map<string, { totalCalls: number; errors: number; totalLatencyMs: number }>();

  register(model: ModelMetadata): void {
    this.models.set(model.id, { ...model });
    if (!this.telemetry.has(model.id)) {
      this.telemetry.set(model.id, { totalCalls: 0, errors: 0, totalLatencyMs: 0 });
    }
  }

  get(id: string): ModelMetadata | undefined {
    return this.models.get(id);
  }

  list(): ModelMetadata[] {
    return Array.from(this.models.values());
  }

  recordExecution(modelId: string, latencyMs: number, success: boolean): void {
    const meta = this.models.get(modelId);
    const tel = this.telemetry.get(modelId);
    if (!meta || !tel) return;

    tel.totalCalls++;
    tel.totalLatencyMs += latencyMs;
    if (!success) {
      tel.errors++;
    } else {
      // update reliability score gradually
      const errorRate = tel.errors / tel.totalCalls;
      meta.reliabilityScore = Number(Math.max(0.0, 1.0 - errorRate).toFixed(3));
    }
    meta.avgLatencyMs = Math.round(tel.totalLatencyMs / tel.totalCalls);
  }

  selectOptimalModel(profile: TaskProfile): string {
    const candidates = this.list().filter((m) => {
      if (!m.enabled) return false;
      if (profile.modality && !m.modalities.includes(profile.modality)) return false;
      if (profile.minContextLength && m.contextWindow < profile.minContextLength) return false;
      if (profile.maxLatencyMs && m.avgLatencyMs > profile.maxLatencyMs) return false;
      if (profile.privacy === 'confidential' && m.tier === 'local') {
        // local required for confidential data
        return true;
      }
      return true;
    });

    if (candidates.length === 0) {
      // fallback to any enabled model
      const anyEnabled = this.list().filter((m) => m.enabled);
      if (anyEnabled.length > 0) return anyEnabled[0]!.id;
      throw new Error('ModelRegistry: no enabled models available');
    }

    // Sort by weighted score: reliability * 0.4 + (1 / (avgLatencyMs + 1)) * 0.3 + (tier weight) * 0.3
    candidates.sort((a, b) => {
      const scoreA = a.reliabilityScore * 0.4 + (1000 / (a.avgLatencyMs + 100)) * 0.3 + (a.tier === 'frontier-proprietary' ? 1.0 : 0.7) * 0.3;
      const scoreB = b.reliabilityScore * 0.4 + (1000 / (b.avgLatencyMs + 100)) * 0.3 + (b.tier === 'frontier-proprietary' ? 1.0 : 0.7) * 0.3;
      return scoreB - scoreA;
    });

    return candidates[0]!.id;
  }
}
