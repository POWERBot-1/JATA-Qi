// Provider factory helpers for common LLM providers. These create ILLM instances
// that can be registered with the LLM gateway. The OpenAI adapter already exists
// in @jataqi/agent-runtime; this file adds an Anthropic-compatible adapter and
// a smarter MockLLM that returns structured responses (better than EchoLLM for
// integration tests that need realistic-looking output).

import type { ILLM, LLMRequest, LLMResponse, ChatMessage } from '@jataqi/agent-runtime';
import { OpenAILLM } from '@jataqi/agent-runtime';
import type { LLMProviderConfig } from './types.js';

/**
 * Safe arithmetic evaluator — the LLM mock provider computes simple
 * `a op b` expressions WITHOUT dynamic code evaluation. Input is validated
 * by the caller's regex (digits + one of + - * /); this parser only handles
 * those tokens, so there is no code-execution surface.
 */
export function safeArithmetic(expr: string): number {
  const m = /^(\d+)\s*([+\-*/])\s*(\d+)$/.exec(expr.trim());
  if (!m) throw new Error('unsupported expression');
  const a = Number(m[1]);
  const b = Number(m[3]);
  switch (m[2]) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': {
      if (b === 0) throw new Error('division by zero');
      return a / b;
    }
    default: throw new Error('unsupported operator');
  }
}

// --- OpenAI provider factory -------------------------------------------------

export function openaiProvider(opts: {
  apiKey?: string; model?: string; endpoint?: string; temperature?: number;
  tier?: 'primary' | 'fallback' | 'emergency'; priority?: number;
}): LLMProviderConfig {
  const model = opts.model ?? 'gpt-4o-mini';
  const costMap: Record<string, { input: number; output: number }> = {
    'gpt-4o': { input: 0.0025, output: 0.01 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
  };
  const cost = costMap[model] ?? { input: 0.001, output: 0.002 };
  const llm = new OpenAILLM({ apiKey: opts.apiKey, model, endpoint: opts.endpoint, temperature: opts.temperature });
  return {
    id: `openai:${model}`, name: `OpenAI ${model}`, llm,
    tier: opts.tier ?? 'primary', priority: opts.priority ?? 1,
    inputCostPer1k: cost.input, outputCostPer1k: cost.output,
    maxContextTokens: 128_000,
    capabilities: ['chat', 'reasoning', 'tool-use', 'code'],
  };
}

// --- Anthropic-compatible provider (OpenAI-compatible endpoint) ---------------

export function anthropicProvider(opts: {
  apiKey?: string; model?: string; endpoint?: string;
  tier?: 'primary' | 'fallback' | 'emergency'; priority?: number;
}): LLMProviderConfig {
  const model = opts.model ?? 'claude-sonnet-4-20250514';
  const llm = new OpenAILLM({
    apiKey: opts.apiKey, model,
    endpoint: opts.endpoint ?? 'https://api.anthropic.com/v1/openai/v1/chat/completions',
  });
  return {
    id: `anthropic:${model}`, name: `Anthropic ${model}`, llm,
    tier: opts.tier ?? 'fallback', priority: opts.priority ?? 2,
    inputCostPer1k: 0.003, outputCostPer1k: 0.015,
    maxContextTokens: 200_000,
    capabilities: ['chat', 'reasoning', 'tool-use', 'code', 'vision'],
  };
}

// --- MockLLM (smart test double) ---------------------------------------------

/**
 * A smarter mock that returns realistic-looking structured responses.
 * Unlike EchoLLM (which just echoes), MockLLM generates a response based on
 * the input — useful for integration tests that need believable output.
 * Deterministic (seeded) so tests are reproducible.
 */
export class MockLLM implements ILLM {
  readonly id: string;
  private seed: number;

  constructor(model = 'mock-1', seed = 42) {
    this.id = `mock:${model}`;
    this.seed = seed;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const content = lastUser?.content ?? '';

    // Simple hash-based pseudo-random for determinism.
    let h = this.seed;
    for (const c of content) h = ((h << 5) - h + c.charCodeAt(0)) | 0;

    let response: string;
    if (/^\d+\s*[+\-*/]\s*\d+$/.test(content.trim())) {
      try { response = `The answer is ${safeArithmetic(content.trim())}.`; } catch { response = `I cannot compute "${content}".`; }
    } else if (content.toLowerCase().includes('hello') || content.toLowerCase().includes('hi')) {
      response = 'Hello! I am a JATA Qi assistant. How can I help you?';
    } else if (content.toLowerCase().includes('what is') || content.toLowerCase().includes('explain')) {
      response = `Based on my analysis, "${content.slice(0, 80)}" relates to several interconnected concepts. ` +
        `The key points are: (1) context matters, (2) systematic analysis reveals patterns, (3) evidence-based reasoning applies.`;
    } else {
      response = `I understand you're asking about: "${content.slice(0, 100)}". ` +
        `Here is my structured response: this topic involves multiple dimensions. ` +
        `I would approach it by examining the available evidence and providing a reasoned conclusion.`;
    }

    // Add a mock token count (~4 chars per token).
    const promptTokens = Math.ceil(req.messages.reduce((s, m) => s + m.content.length, 0) / 4);
    const completionTokens = Math.ceil(response.length / 4);

    return {
      message: { role: 'assistant', content: response },
      usage: { promptTokens, completionTokens },
    };
  }
}

export function mockProvider(opts: {
  model?: string; seed?: number;
  tier?: 'primary' | 'fallback' | 'emergency'; priority?: number;
} = {}): LLMProviderConfig {
  const model = opts.model ?? 'mock-1';
  const llm = new MockLLM(model, opts.seed);
  return {
    id: `mock:${model}`, name: `Mock ${model}`, llm,
    tier: opts.tier ?? 'fallback', priority: opts.priority ?? 99,
    inputCostPer1k: 0, outputCostPer1k: 0,
    capabilities: ['chat'],
  };
}
