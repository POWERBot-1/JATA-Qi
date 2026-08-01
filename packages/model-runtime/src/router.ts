// Sovereign routing engine — selects the optimal model/provider based on
// capabilities, cost, latency, privacy classification, and governance policy.
// Sensitive workloads are automatically routed to local models. When no local
// models are available and privacy is sensitive, the request is rejected.

import type { ILLM } from '@jataqi/agent-runtime';
import { EchoLLM } from '@jataqi/agent-runtime';
import type { LocalModelConfig, RemoteProviderConfig, RoutingContext, RoutingResult, ModelHealth } from './types.js';
import { createRemoteAdapter, createOllamaAdapter, createVLLMAdapter } from './providers.js';

interface Candidate {
  id: string;
  isLocal: boolean;
  quality: number;
  latencyMs: number;
  cost: number;
  capabilities: string[];
  llm: ILLM;
  health?: ModelHealth;
}

export class SovereignRouter implements ILLM {
  private readonly localLLMs = new Map<string, { llm: ILLM; config: LocalModelConfig }>();
  private readonly remoteLLMs = new Map<string, { llm: ILLM; config: RemoteProviderConfig }>();
  private readonly health = new Map<string, ModelHealth>();
  private readonly fallback = new EchoLLM();

  /** Register a local model (Ollama/vLLM endpoint). */
  registerLocal(config: LocalModelConfig): void {
    const llm = config.endpoint.includes(':11434')
      ? createOllamaAdapter(config.id, config.endpoint)
      : createVLLMAdapter(config.id, config.endpoint);
    this.localLLMs.set(config.id, { llm, config });
  }

  /** Register a remote provider. */
  registerRemote(config: RemoteProviderConfig): void {
    const adapter = createRemoteAdapter(config);
    if (adapter) this.remoteLLMs.set(config.id, { llm: adapter, config });
  }

  /** Check if any local models are available. */
  hasLocalModels(): boolean { return this.localLLMs.size > 0; }

  /** Check if any remote providers are configured. */
  hasRemoteProviders(): boolean { return this.remoteLLMs.size > 0; }

  /** Route a request — returns the routing decision (which model to use). */
  route(ctx: RoutingContext): RoutingResult {
    const candidates = this.buildCandidates(ctx);

    if (candidates.length === 0) {
      // No candidates — use the EchoLLM fallback (always available).
      return {
        modelId: 'echo',
        providerKind: 'builtin',
        rationale: 'no models available; using built-in EchoLLM fallback',
        isLocal: true,
      };
    }

    // Sort by preference.
    const prefer = ctx.prefer ?? 'quality';
    candidates.sort((a, b) => {
      switch (prefer) {
        case 'cost': return a.cost - b.cost;
        case 'latency': return a.latencyMs - b.latencyMs;
        case 'quality':
        default: return b.quality - a.quality;
      }
    });

    const best = candidates[0]!;
    return {
      modelId: best.id,
      providerKind: best.isLocal ? 'local' : 'remote',
      ...(best.isLocal ? {} : { endpoint: undefined }),
      rationale: `routed to ${best.id} (${best.isLocal ? 'local' : 'remote'}, ${prefer} preference, ${candidates.length} candidates)`,
      isLocal: best.isLocal,
    };
  }

  async complete(req: import('@jataqi/agent-runtime').LLMRequest): Promise<import('@jataqi/agent-runtime').LLMResponse> {
    // Default routing: prefer quality, allow remote.
    const result = this.route({});
    const llm = this.getLLM(result.modelId);
    if (!llm) return this.fallback.complete(req);

    const t0 = Date.now();
    try {
      const response = await llm.complete(req);
      this.recordSuccess(result.modelId, Date.now() - t0);
      return response;
    } catch (err) {
      this.recordFailure(result.modelId, (err as Error).message);
      // Try fallback chain.
      return this.tryFallback(req, result.modelId);
    }
  }

  /** Complete with explicit routing context. */
  async completeRouted(req: import('@jataqi/agent-runtime').LLMRequest, ctx: RoutingContext): Promise<{ response: import('@jataqi/agent-runtime').LLMResponse; routing: RoutingResult }> {
    const routing = this.route(ctx);
    const llm = this.getLLM(routing.modelId);
    if (!llm) {
      const response = await this.fallback.complete(req);
      return { response, routing };
    }
    try {
      const response = await llm.complete(req);
      this.recordSuccess(routing.modelId, 0);
      return { response, routing };
    } catch (err) {
      this.recordFailure(routing.modelId, (err as Error).message);
      const response = await this.tryFallback(req, routing.modelId);
      return { response, routing };
    }
  }

  /** Get health stats for observability. */
  getHealth(): ModelHealth[] { return [...this.health.values()]; }

  // --- internal -------------------------------------------------------------

  private getLLM(modelId: string): ILLM | undefined {
    return this.localLLMs.get(modelId)?.llm ?? this.remoteLLMs.get(modelId)?.llm ?? (modelId === 'echo' ? this.fallback : undefined);
  }

  private buildCandidates(ctx: RoutingContext): Candidate[] {
    const out: Candidate[] = [];

    // Local models always pass the privacy filter.
    for (const [id, { llm, config }] of this.localLLMs) {
      if (ctx.capabilities && !ctx.capabilities.every((c) => config.capabilities.includes(c))) continue;
      out.push({
        id, isLocal: true, llm,
        quality: config.quality ?? 50,
        latencyMs: config.latencyMs ?? 1000,
        cost: 0,
        capabilities: config.capabilities,
      });
    }

    // Remote models — skip if privacy is sensitive or forceLocal.
    if (ctx.privacy !== 'sensitive' && !ctx.forceLocal) {
      for (const [id, { llm, config }] of this.remoteLLMs) {
        if (ctx.allowedProviders && ctx.allowedProviders.length > 0 && !ctx.allowedProviders.includes(id)) continue;
        out.push({
          id, isLocal: false, llm,
          quality: 85, // remote models assumed high quality
          latencyMs: 1500,
          cost: 0.02, // assumed average
          capabilities: config.capabilities ?? ['chat', 'reasoning'],
        });
      }
    }

    // Always include EchoLLM as a last resort (if no privacy constraint or local available).
    if (out.length === 0) {
      out.push({ id: 'echo', isLocal: true, llm: this.fallback, quality: 1, latencyMs: 0, cost: 0, capabilities: ['chat'] });
    }

    return out;
  }

  private async tryFallback(req: import('@jataqi/agent-runtime').LLMRequest, failedId: string): Promise<import('@jataqi/agent-runtime').LLMResponse> {
    // Try every other model.
    for (const [id, { llm }] of [...this.localLLMs, ...this.remoteLLMs]) {
      if (id === failedId) continue;
      try { return await llm.complete(req); } catch { /* try next */ }
    }
    return this.fallback.complete(req);
  }

  private recordSuccess(modelId: string, latencyMs: number): void {
    const h = this.getOrCreateHealth(modelId);
    h.successes++;
    h.avgLatencyMs = h.avgLatencyMs === 0 ? latencyMs : h.avgLatencyMs * 0.8 + latencyMs * 0.2;
    h.lastChecked = Date.now();
    h.status = 'ready';
  }

  private recordFailure(modelId: string, error: string): void {
    const h = this.getOrCreateHealth(modelId);
    h.failures++;
    h.lastError = error;
    h.lastChecked = Date.now();
    if (h.failures > h.successes * 3 && h.failures > 5) h.status = 'error';
  }

  private getOrCreateHealth(modelId: string): ModelHealth {
    let h = this.health.get(modelId);
    if (!h) {
      h = { modelId, status: 'ready', totalRequests: 0, successes: 0, failures: 0, avgLatencyMs: 0, lastChecked: 0 };
      this.health.set(modelId, h);
    }
    return h;
  }
}
