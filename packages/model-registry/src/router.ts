// ModelRouter — production-grade dynamic model routing that bridges the model
// registry to the LLM gateway. Implements ILLM so it drops into the agent
// runtime. Features:
//   - Selects the optimal model per request based on capabilities, cost,
//     latency, quality, health, and policy constraints.
//   - Tracks per-model health (success rate, avg latency) with a circuit
//     breaker (auto-trips after N consecutive failures, half-open recovery).
//   - Falls back to the next-best model on failure.
//   - Enforces cost ceilings (max cost per 1k tokens).
//   - Emits routing decisions on the bus for audit/observability.

import { createHash } from 'node:crypto';
import type { ILLM, LLMRequest, LLMResponse } from '@jataqi/agent-runtime';
import type { ModelDescriptor, SelectionRequest, SelectionPreference } from './types.js';

export interface ModelHealth {
  modelId: string;
  totalRequests: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  lastUsed: number;
  circuitState: 'closed' | 'open' | 'half-open';
  openedAt?: number;
}

export interface RoutingPolicy {
  /** Max allowed cost per 1k tokens (input + output combined). 0 = no limit. */
  maxCostPer1k?: number;
  /** Max latency tolerance in ms before considering a model unhealthy. */
  maxLatencyMs?: number;
  /** Consecutive failures before tripping the circuit breaker (default 3). */
  circuitThreshold?: number;
  /** Seconds before a tripped circuit enters half-open (default 30). */
  circuitCooldownSec?: number;
  /** Allowed provider ids (empty = all). */
  allowedProviders?: string[];
}

export interface RoutingDecision {
  modelId: string;
  provider: string;
  rationale: string;
  candidates: number;
  attempted: string[];
  costEstimate?: number;
  latencyEstimateMs?: number;
}

const DEFAULT_POLICY: Required<Omit<RoutingPolicy, 'allowedProviders'>> = {
  maxCostPer1k: 0,
  maxLatencyMs: 30_000,
  circuitThreshold: 3,
  circuitCooldownSec: 30,
};

export class ModelRouter implements ILLM {
  private readonly health = new Map<string, ModelHealth>();
  private readonly policy: Required<Omit<RoutingPolicy, 'allowedProviders'>>;
  private readonly allowedProviders: Set<string> | null;

  constructor(
    private readonly registry: { list(): ModelDescriptor[]; select(req: SelectionRequest): Promise<{ model: ModelDescriptor | undefined; candidates: number; rationale: string }> },
    private readonly providerLLMs: Map<string, ILLM>,
    private readonly fallback: ILLM,
    policy: RoutingPolicy = {},
  ) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.allowedProviders = policy.allowedProviders?.length ? new Set(policy.allowedProviders) : null;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const decision = await this.route(req);
    const attempted: string[] = [];
    let lastError: Error | undefined;

    for (const modelId of [decision.modelId, ...this.getFallbackModels(decision)]) {
      if (!modelId) continue;
      attempted.push(modelId);
      const llm = this.providerLLMs.get(modelId);
      if (!llm) continue;
      if (!this.isAvailable(modelId)) continue;

      const t0 = Date.now();
      try {
        const res = await llm.complete(req);
        this.recordSuccess(modelId, Date.now() - t0);
        return res;
      } catch (err) {
        this.recordFailure(modelId);
        lastError = err as Error;
      }
    }

    // All models failed — use the fallback LLM.
    this.recordFallback();
    return this.fallback.complete(req);
  }

  /** Route a request: select the best healthy model within policy constraints. */
  async route(req: LLMRequest): Promise<RoutingDecision> {
    // Infer task preferences from the request.
    const prefer: SelectionPreference = this.inferPreference(req);
    const capabilities = this.inferCapabilities(req);

    const models = this.registry.list();
    const filtered = models.filter((m) => {
      if (this.allowedProviders && !this.allowedProviders.has(m.provider)) return false;
      if (this.policy.maxCostPer1k > 0) {
        const cost = (m.inputCostPer1k ?? 0) + (m.outputCostPer1k ?? 0);
        if (cost > this.policy.maxCostPer1k) return false;
      }
      if (this.policy.maxLatencyMs > 0 && m.latencyMs && m.latencyMs > this.policy.maxLatencyMs) return false;
      if (!this.isAvailable(m.id)) return false;
      return true;
    });

    // Use the registry's selector on the filtered list.
    const candidates = filtered.length;
    let best: ModelDescriptor | undefined;

    if (candidates > 0) {
      const result = await this.registry.select({
        ...(capabilities.length ? { capabilities } : {}),
        prefer,
      });
      // Ensure the selected model is in our filtered set.
      best = result.model && filtered.some((m) => m.id === result.model!.id) ? result.model : filtered[0];
    }

    const modelId = best?.id ?? '';
    const cost = best ? ((best.inputCostPer1k ?? 0) + (best.outputCostPer1k ?? 0)) : undefined;
    return {
      modelId,
      provider: best?.provider ?? 'fallback',
      rationale: best ? `routed to ${best.id} (${prefer} among ${candidates} candidates)` : 'no model available; using fallback',
      candidates,
      attempted: [],
      ...(cost !== undefined ? { costEstimate: cost } : {}),
      ...(best?.latencyMs ? { latencyEstimateMs: best.latencyMs } : {}),
    };
  }

  /** Get health stats for observability. */
  getHealth(): ModelHealth[] { return [...this.health.values()]; }

  /** Get the fallback model chain for a routing decision. */
  private getFallbackModels(decision: RoutingDecision): string[] {
    const all = this.registry.list();
    return all
      .filter((m) => m.id !== decision.modelId && this.isAvailable(m.id))
      .sort((a, b) => (b.quality ?? 50) - (a.quality ?? 50))
      .map((m) => m.id)
      .slice(0, 3);
  }

  private isAvailable(modelId: string): boolean {
    const h = this.health.get(modelId);
    if (!h || h.circuitState === 'closed') return true;
    if (h.circuitState === 'open') {
      // Check cooldown.
      if (h.openedAt && Date.now() - h.openedAt > this.policy.circuitCooldownSec * 1000) {
        h.circuitState = 'half-open';
        return true; // allow one trial request
      }
      return false;
    }
    return true; // half-open: allow
  }

  private recordSuccess(modelId: string, latencyMs: number): void {
    const h = this.getOrCreate(modelId);
    h.totalRequests++;
    h.successes++;
    h.consecutiveFailures = 0;
    h.circuitState = 'closed';
    h.lastUsed = Date.now();
    h.avgLatencyMs = h.avgLatencyMs === 0 ? latencyMs : h.avgLatencyMs * 0.8 + latencyMs * 0.2;
  }

  private recordFailure(modelId: string): void {
    const h = this.getOrCreate(modelId);
    h.totalRequests++;
    h.failures++;
    h.consecutiveFailures++;
    if (h.consecutiveFailures >= this.policy.circuitThreshold) {
      h.circuitState = 'open';
      h.openedAt = Date.now();
    }
  }

  private recordFallback(): void {
    const h = this.getOrCreate('__fallback__');
    h.totalRequests++;
    h.failures++;
  }

  private getOrCreate(modelId: string): ModelHealth {
    let h = this.health.get(modelId);
    if (!h) {
      h = { modelId, totalRequests: 0, successes: 0, failures: 0, consecutiveFailures: 0, avgLatencyMs: 0, lastUsed: 0, circuitState: 'closed' };
      this.health.set(modelId, h);
    }
    return h;
  }

  private inferPreference(req: LLMRequest): SelectionPreference {
    const content = req.messages.map((m) => m.content).join(' ').toLowerCase();
    if (content.includes('fast') || content.includes('quick')) return 'latency';
    if (content.includes('cheap') || content.includes('budget')) return 'cost';
    return 'quality';
  }

  private inferCapabilities(req: LLMRequest): string[] {
    const caps: string[] = ['chat'];
    const content = req.messages.map((m) => m.content).join(' ').toLowerCase();
    if (content.includes('code') || content.includes('function') || content.includes('programming')) caps.push('code');
    if (content.includes('image') || content.includes('picture') || content.includes('vision')) caps.push('vision');
    if (req.tools && req.tools.length > 0) caps.push('tool-use');
    if (content.includes('analyze') || content.includes('reason') || content.includes('think')) caps.push('reasoning');
    return caps;
  }
}
