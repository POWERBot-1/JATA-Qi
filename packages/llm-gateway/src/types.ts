// JATA Qi LLM Gateway — types. The gateway sits between the agent runtime and
// actual LLM providers, adding routing, fallback, cost/latency tracking, and
// governance integration. It implements the same ILLM interface as EchoLLM
// and OpenAILLM so it's a drop-in replacement.

import type { ChatMessage, ILLM, LLMRequest, LLMResponse } from '@jataqi/agent-runtime';

export type ProviderStatus = 'active' | 'degraded' | 'unavailable';
export type ProviderTier = 'primary' | 'fallback' | 'emergency';

export interface LLMProviderConfig {
  id: string;
  /** Display name (e.g. "OpenAI GPT-4o", "Claude Sonnet"). */
  name: string;
  /** The underlying ILLM implementation. */
  llm: ILLM;
  tier: ProviderTier;
  /** Priority within a tier (lower = tried first). */
  priority: number;
  /** Cost per 1K input tokens (for tracking, not charging). */
  inputCostPer1k?: number;
  /** Cost per 1K output tokens. */
  outputCostPer1k?: number;
  /** Max tokens this provider can handle. */
  maxContextTokens?: number;
  /** Capabilities this provider supports. */
  capabilities?: string[];
}

export interface LLMInvocation {
  id: string;
  providerId: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  fallbackUsed?: boolean;
  fellBackFrom?: string;
  timestamp: number;
}

export interface LLMStats {
  totalInvocations: number;
  successful: number;
  failed: number;
  fallbacksTriggered: number;
  totalTokensUsed: number;
  totalCost: number;
  avgLatencyMs: number;
  byProvider: Record<string, { invocations: number; successRate: number; avgLatencyMs: number; totalCost: number }>;
}

export const LLMEvents = Object.freeze({
  ProviderRegistered: 'llm.provider.registered',
  InvocationCompleted: 'llm.invocation.completed',
  InvocationFailed: 'llm.invocation.failed',
  FallbackTriggered: 'llm.fallback.triggered',
  ProviderDegraded: 'llm.provider.degraded',
} as const);

export type { ChatMessage, ILLM, LLMRequest, LLMResponse };
