// Foundation Model Fabric with provider failover and automatic fallback.

import type { ILLM } from '@jataqi/agent-runtime';
import type { ModelFabricRequest, ModelFabricResponse } from './types.js';
import type { ModelRegistry } from './registry.js';

export class ModelFabric {
  private readonly providers = new Map<string, ILLM>();

  constructor(private readonly registry: ModelRegistry) {}

  registerProvider(modelId: string, llm: ILLM): void {
    this.providers.set(modelId, llm);
  }

  async executeWithFallback(
    primaryModelId: string,
    fallbackModelIds: string[],
    req: ModelFabricRequest
  ): Promise<ModelFabricResponse> {
    const chain = [primaryModelId, ...fallbackModelIds];
    let lastError: unknown;

    for (const modelId of chain) {
      const provider = this.providers.get(modelId);
      const meta = this.registry.get(modelId);
      if (!provider || !meta || !meta.enabled) continue;

      const start = Date.now();
      try {
        const res = await provider.complete({
          messages: req.messages,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          signal: req.signal,
        });
        const latencyMs = Date.now() - start;
        this.registry.recordExecution(modelId, latencyMs, true);

        const promptTok = res.usage?.promptTokens ?? 50;
        const compTok = res.usage?.completionTokens ?? 50;
        const totalCostUsd = promptTok * meta.costPerPromptTokenUsd + compTok * meta.costPerCompletionTokenUsd;

        return {
          modelId,
          content: res.message.content,
          usage: { promptTokens: promptTok, completionTokens: compTok, totalCostUsd },
          latencyMs,
        };
      } catch (err) {
        const latencyMs = Date.now() - start;
        this.registry.recordExecution(modelId, latencyMs, false);
        lastError = err;
      }
    }

    throw new Error(`ModelFabric: all models in fallback chain failed. Last error: ${String(lastError)}`);
  }
}
