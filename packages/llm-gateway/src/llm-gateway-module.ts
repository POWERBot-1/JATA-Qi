// LLMGatewayModule — the unified LLM access layer. Routes requests to the best
// available provider, handles fallback chains, tracks cost/latency/tokens, and
// integrates with governance, audit, and metrics. Implements ILLM so it's a
// drop-in replacement for EchoLLM/OpenAILLM in the agent runtime.
//
// When no real providers are registered, it transparently falls back to
// EchoLLM (deterministic, for dev/testing). When real providers (OpenAI,
// Anthropic, local) are registered, it routes to them with full tracking.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { EchoLLM } from '@jataqi/agent-runtime';
import type { ILLM, LLMRequest, LLMResponse } from '@jataqi/agent-runtime';
import { LLMEvents } from './types.js';
import type { LLMInvocation, LLMProviderConfig, LLMStats, ProviderStatus, ProviderTier } from './types.js';

const COL_INVOCATIONS = 'llm-gateway.invocations';

export class LLMGatewayModule implements IModule, ILLM {
  readonly id = 'llm-gateway';
  readonly tags = ['core', 'llm'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private providers = new Map<string, LLMProviderConfig>();
  private statuses = new Map<string, ProviderStatus>();
  private readonly invocations: LLMInvocation[] = [];
  private readonly maxHistory: number;
  private readonly fallbackEcho: EchoLLM;

  constructor(opts: { maxHistory?: number } = {}) {
    this.maxHistory = opts.maxHistory ?? 10_000;
    this.fallbackEcho = new EchoLLM();
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('llm-gateway', this);
    kernel.container.registerValue('llm.default', this);
    kernel.logger.info(`llm-gateway initialized (${this.providers.size} provider(s))`);
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> { this.providers.clear(); }

  // --- provider management --------------------------------------------------

  registerProvider(config: LLMProviderConfig): void {
    this.providers.set(config.id, config);
    this.statuses.set(config.id, 'active');
    void this.api?.bus?.emit(LLMEvents.ProviderRegistered, { id: config.id, tier: config.tier });
  }

  unregisterProvider(id: string): boolean {
    this.statuses.delete(id);
    return this.providers.delete(id);
  }

  setStatus(id: string, status: ProviderStatus): void {
    if (!this.providers.has(id)) throw new Error(`llm-gateway: provider "${id}" not found`);
    this.statuses.set(id, status);
    if (status === 'degraded') void this.api?.bus?.emit(LLMEvents.ProviderDegraded, { id });
  }

  listProviders(): { id: string; name: string; tier: ProviderTier; status: ProviderStatus; priority: number }[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id, name: p.name, tier: p.tier, priority: p.priority,
      status: this.statuses.get(p.id) ?? 'active',
    }));
  }

  /** Get the active default provider (highest priority primary, or fallback). */
  getDefaultProvider(): LLMProviderConfig | undefined {
    const active = [...this.providers.values()]
      .filter((p) => (this.statuses.get(p.id) ?? 'active') !== 'unavailable')
      .sort((a, b) => {
        const tierOrder: Record<ProviderTier, number> = { primary: 0, fallback: 1, emergency: 2 };
        if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
        return a.priority - b.priority;
      });
    return active[0];
  }

  // --- ILLM interface (drop-in replacement) ---------------------------------

  /**
   * Complete a chat request. Routes to the best provider, falls back on errors.
   * When no providers are registered, uses EchoLLM (deterministic).
   */
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const provider = this.getDefaultProvider();

    // No real providers → use echo fallback (dev/test mode).
    if (!provider) {
      return this.fallbackEcho.complete(req);
    }

    // Try the primary provider.
    const result = await this.tryProvider(provider, req);
    if (result.success) return result.response!;

    // Fallback chain: try remaining providers in tier order.
    const fallbacks = this.getFallbackChain(provider.id);
    for (const fb of fallbacks) {
      void this.api?.bus?.emit(LLMEvents.FallbackTriggered, { from: provider.id, to: fb.id });
      const fbResult = await this.tryProvider(fb, req, true, provider.id);
      if (fbResult.success) return fbResult.response!;
    }

    // All providers failed → use echo as last resort (keeps the system running).
    this.api.logger.warn('all LLM providers failed; using echo fallback');
    return this.fallbackEcho.complete(req);
  }

  // --- internal routing -----------------------------------------------------

  private async tryProvider(
    provider: LLMProviderConfig,
    req: LLMRequest,
    isFallback = false,
    fellBackFrom?: string,
  ): Promise<{ success: boolean; response?: LLMResponse; error?: string }> {
    const t0 = Date.now();
    const status = this.statuses.get(provider.id) ?? 'active';
    if (status === 'unavailable') return { success: false, error: 'provider unavailable' };

    try {
      const response = await provider.llm.complete(req);
      const latencyMs = Date.now() - t0;
      const promptTokens = response.usage?.promptTokens ?? this.estimateTokens(req);
      const completionTokens = response.usage?.completionTokens ?? this.estimateTokens({ messages: [response.message] } as LLMRequest);

      const invocation: LLMInvocation = {
        id: randomUUID(),
        providerId: provider.id,
        ...(provider.llm as { id?: string }).id ? { model: (provider.llm as { id?: string }).id } : {},
        promptTokens, completionTokens,
        totalTokens: promptTokens + completionTokens,
        inputCost: this.calcCost(promptTokens, provider.inputCostPer1k),
        outputCost: this.calcCost(completionTokens, provider.outputCostPer1k),
        totalCost: 0, latencyMs, success: true,
        ...(isFallback ? { fallbackUsed: true } : {}),
        ...(fellBackFrom ? { fellBackFrom } : {}),
        timestamp: Date.now(),
      };
      invocation.totalCost = invocation.inputCost + invocation.outputCost;

      this.recordInvocation(invocation);
      void this.api?.bus?.emit(LLMEvents.InvocationCompleted, { providerId: provider.id, tokens: invocation.totalTokens, cost: invocation.totalCost });

      return { success: true, response };
    } catch (err) {
      const error = (err as Error).message;
      const latencyMs = Date.now() - t0;
      const invocation: LLMInvocation = {
        id: randomUUID(), providerId: provider.id,
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
        inputCost: 0, outputCost: 0, totalCost: 0,
        latencyMs, success: false, error,
        ...(isFallback ? { fallbackUsed: true } : {}),
        ...(fellBackFrom ? { fellBackFrom } : {}),
        timestamp: Date.now(),
      };
      this.recordInvocation(invocation);
      void this.api?.bus?.emit(LLMEvents.InvocationFailed, { providerId: provider.id, error });

      // Mark as degraded after 3 consecutive failures.
      const recent = this.invocations.slice(-5).filter((i) => i.providerId === provider.id);
      if (recent.length >= 3 && recent.every((i) => !i.success)) {
        this.setStatus(provider.id, 'degraded');
      }

      return { success: false, error };
    }
  }

  private getFallbackChain(excludeId: string): LLMProviderConfig[] {
    return [...this.providers.values()]
      .filter((p) => p.id !== excludeId && (this.statuses.get(p.id) ?? 'active') !== 'unavailable')
      .sort((a, b) => {
        const tierOrder: Record<ProviderTier, number> = { primary: 0, fallback: 1, emergency: 2 };
        return tierOrder[a.tier] - tierOrder[b.tier] || a.priority - b.priority;
      });
  }

  // --- tracking & stats -----------------------------------------------------

  private recordInvocation(invocation: LLMInvocation): void {
    this.invocations.push(invocation);
    if (this.invocations.length > this.maxHistory) {
      this.invocations.splice(0, this.invocations.length - this.maxHistory);
    }
  }

  getStats(): LLMStats {
    const total = this.invocations.length;
    const successful = this.invocations.filter((i) => i.success).length;
    const failed = total - successful;
    const fallbacks = this.invocations.filter((i) => i.fallbackUsed).length;
    const totalTokens = this.invocations.reduce((s, i) => s + i.totalTokens, 0);
    const totalCost = this.invocations.reduce((s, i) => s + i.totalCost, 0);
    const latencies = this.invocations.filter((i) => i.success).map((i) => i.latencyMs);
    const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length) : 0;

    const byProvider: Record<string, { invocations: number; successRate: number; avgLatencyMs: number; totalCost: number }> = {};
    for (const p of this.providers.keys()) {
      const pInvocations = this.invocations.filter((i) => i.providerId === p);
      const pSuccess = pInvocations.filter((i) => i.success);
      const pLatencies = pSuccess.map((i) => i.latencyMs);
      byProvider[p] = {
        invocations: pInvocations.length,
        successRate: pInvocations.length > 0 ? pSuccess.length / pInvocations.length : 0,
        avgLatencyMs: pLatencies.length > 0 ? Math.round(pLatencies.reduce((s, l) => s + l, 0) / pLatencies.length) : 0,
        totalCost: pInvocations.reduce((s, i) => s + i.totalCost, 0),
      };
    }

    return { totalInvocations: total, successful, failed, fallbacksTriggered: fallbacks, totalTokensUsed: totalTokens, totalCost: Math.round(totalCost * 10000) / 10000, avgLatencyMs, byProvider };
  }

  getRecentInvocations(limit = 50): LLMInvocation[] {
    return this.invocations.slice(-limit).reverse();
  }

  // --- helpers --------------------------------------------------------------

  private estimateTokens(req: { messages: { content: string }[] }): number {
    // Rough estimate: ~4 chars per token (English).
    const chars = req.messages.reduce((s, m) => s + m.content.length, 0);
    return Math.ceil(chars / 4);
  }

  private calcCost(tokens: number, per1k?: number): number {
    if (!per1k) return 0;
    return (tokens / 1000) * per1k;
  }
}
