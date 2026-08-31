// Dynamic Model Router implementing TASK → CLASSIFY → ROUTE → EXECUTE → VERIFY → ESCALATE.

import type { TaskProfile, RouterDecision, ModelFabricRequest, ModelFabricResponse } from './types.js';
import type { ModelRegistry } from './registry.js';
import type { ModelFabric } from './fabric.js';

export class DynamicModelRouter {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly fabric: ModelFabric
  ) {}

  classify(prompt: string, profile?: Partial<TaskProfile>): TaskProfile {
    const lower = prompt.toLowerCase();
    let taskType: TaskProfile['taskType'] = 'chat';
    let difficulty = 3;

    if (lower.includes('code') || lower.includes('function') || lower.includes('typescript') || lower.includes('bug')) {
      taskType = 'coding';
      difficulty = 6;
    } else if (lower.includes('proof') || lower.includes('analyze') || lower.includes('theorem') || lower.includes('architecture')) {
      taskType = 'reasoning';
      difficulty = 8;
    } else if (lower.includes('science') || lower.includes('physics') || lower.includes('molecule')) {
      taskType = 'science';
      difficulty = 7;
    }

    return {
      taskType: profile?.taskType ?? taskType,
      difficulty: profile?.difficulty ?? difficulty,
      modality: profile?.modality ?? 'text',
      minContextLength: profile?.minContextLength ?? prompt.length,
      maxLatencyMs: profile?.maxLatencyMs ?? 5000,
      maxCostUsd: profile?.maxCostUsd ?? 0.10,
      privacy: profile?.privacy ?? 'internal',
    };
  }

  route(profile: TaskProfile): RouterDecision {
    const selectedModelId = this.registry.selectOptimalModel(profile);
    const allModels = this.registry.list().map((m) => m.id);
    const fallbackModelIds = allModels.filter((id) => id !== selectedModelId);
    const meta = this.registry.get(selectedModelId);

    return {
      selectedModelId,
      fallbackModelIds,
      estimatedCostUsd: (meta?.costPerPromptTokenUsd ?? 0.00001) * 100,
      estimatedLatencyMs: meta?.avgLatencyMs ?? 500,
      routingReason: `Selected ${selectedModelId} for task type '${profile.taskType}' with difficulty ${profile.difficulty}`,
    };
  }

  async executeWithVerification(
    prompt: string,
    req: Omit<ModelFabricRequest, 'messages'>,
    profileOverride?: Partial<TaskProfile>
  ): Promise<ModelFabricResponse> {
    const profile = this.classify(prompt, profileOverride);
    const decision = this.route(profile);

    const messages = [{ role: 'user' as const, content: prompt }];
    const res = await this.fabric.executeWithFallback(decision.selectedModelId, decision.fallbackModelIds, {
      ...req,
      messages,
    });

    // Verify output quality / hallucination heuristics (VERIFY → ESCALATE)
    const needsEscalation = profile.difficulty >= 7 && (res.content.length < 10 || res.content.toLowerCase().includes('i am not sure'));
    if (needsEscalation && decision.fallbackModelIds.length > 0) {
      // Escalate to next fallback model
      const escalatedId = decision.fallbackModelIds[0]!;
      const escRes = await this.fabric.executeWithFallback(escalatedId, decision.fallbackModelIds.slice(1), {
        ...req,
        messages: [...messages, { role: 'assistant', content: res.content }, { role: 'user', content: 'Please double-check and provide a rigorous, verified response.' }],
      });
      return escRes;
    }

    return res;
  }
}
