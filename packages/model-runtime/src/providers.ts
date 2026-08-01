// Universal provider adapters — implements ILLM for each supported provider.
// All use the global fetch (built into Node 18+). Zero external dependencies.
// When a provider's API key is absent, the adapter is not registered.

import type { ILLM, LLMRequest, LLMResponse, ChatMessage } from '@jataqi/agent-runtime';
import type { RemoteProviderConfig } from './types.js';

// === OpenAI ================================================================

export class OpenAIAdapter implements ILLM {
  readonly providerId: string = 'openai';
  constructor(private cfg: RemoteProviderConfig) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const body = JSON.stringify({
      model: this.cfg.defaultModel ?? 'gpt-4o',
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    });
    const res = await this.fetch(`${this.base()}/v1/chat/completions`, body);
    return parseOpenAIResponse(res);
  }
  private base(): string { return this.cfg.apiBase ?? 'https://api.openai.com'; }
  protected async fetch(url: string, body: string): Promise<Record<string, unknown>> {
    const r = await globalThis.fetch(url, { method: 'POST', headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' }, body });
    if (!r.ok) throw new Error(`${this.providerId} error: ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  }
}

// === Anthropic ==============================================================

export class AnthropicAdapter implements ILLM {
  readonly providerId = 'anthropic';
  constructor(private cfg: RemoteProviderConfig) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const systemMsg = req.messages.find((m) => m.role === 'system');
    const msgs = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const body = JSON.stringify({
      model: this.cfg.defaultModel ?? 'claude-sonnet-4-20250514',
      max_tokens: req.maxTokens ?? 4096,
      messages: msgs,
      ...(systemMsg ? { system: systemMsg.content } : {}),
    });
    const base = this.cfg.apiBase ?? 'https://api.anthropic.com';
    const r = await globalThis.fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': this.cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body,
    });
    if (!r.ok) throw new Error(`anthropic error: ${r.status}`);
    const json = await r.json() as { content: { text: string }[]; usage?: { input_tokens: number; output_tokens: number } };
    return {
      message: { role: 'assistant', content: json.content.map((c) => c.text).join('') },
      ...(json.usage ? { usage: { promptTokens: json.usage.input_tokens, completionTokens: json.usage.output_tokens } } : {}),
    };
  }
}

// === Google Gemini ==========================================================

export class GoogleAdapter implements ILLM {
  readonly providerId = 'google';
  constructor(private cfg: RemoteProviderConfig) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = this.cfg.defaultModel ?? 'gemini-1.5-pro';
    const contents = req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const base = this.cfg.apiBase ?? 'https://generativelanguage.googleapis.com';
    const r = await globalThis.fetch(`${base}/v1beta/models/${model}:generateContent?key=${this.cfg.apiKey}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents, ...(req.temperature !== undefined ? { generationConfig: { temperature: req.temperature } } : {}) }),
    });
    if (!r.ok) throw new Error(`google error: ${r.status}`);
    const json = await r.json() as { candidates: { content: { parts: { text: string }[] } }[] };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    return { message: { role: 'assistant', content: text } };
  }
}

// === xAI (Grok) =============================================================

export class XAIAdapter implements ILLM {
  readonly providerId = 'xai';
  constructor(private cfg: RemoteProviderConfig) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const body = JSON.stringify({
      model: this.cfg.defaultModel ?? 'grok-2-latest',
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const base = this.cfg.apiBase ?? 'https://api.x.ai';
    const r = await globalThis.fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' }, body,
    });
    if (!r.ok) throw new Error(`xai error: ${r.status}`);
    const json = await r.json() as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
    return {
      message: { role: 'assistant', content: json.choices[0]?.message?.content ?? '' },
      ...(json.usage ? { usage: { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens } } : {}),
    };
  }
}

// === DeepSeek ==============================================================

export class DeepSeekAdapter extends OpenAIAdapter {
  override readonly providerId = 'deepseek';
  constructor(cfg: RemoteProviderConfig) { super({ ...cfg, apiBase: cfg.apiBase ?? 'https://api.deepseek.com' }); }
}

// === Mistral ================================================================

export class MistralAdapter extends OpenAIAdapter {
  override readonly providerId = 'mistral';
  constructor(cfg: RemoteProviderConfig) { super({ ...cfg, apiBase: cfg.apiBase ?? 'https://api.mistral.ai' }); }
}

// === Ollama (local) =========================================================

export class OllamaAdapter implements ILLM {
  readonly providerId = 'ollama';
  constructor(private model: string, private endpoint = 'http://127.0.0.1:11434') {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const r = await globalThis.fetch(`${this.endpoint}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: req.messages.map((m) => ({ role: m.role, content: m.content })), stream: false }),
    });
    if (!r.ok) throw new Error(`ollama error: ${r.status}`);
    const json = await r.json() as { message: { content: string }; eval_count?: number; prompt_eval_count?: number };
    return {
      message: { role: 'assistant', content: json.message?.content ?? '' },
      ...(json.eval_count ? { usage: { promptTokens: json.prompt_eval_count ?? 0, completionTokens: json.eval_count } } : {}),
    };
  }
}

// === vLLM (local) ===========================================================

export class VLLMAdapter extends OpenAIAdapter {
  override readonly providerId = 'vllm';
  constructor(model: string, endpoint = 'http://127.0.0.1:8000') {
    super({ id: 'vllm', name: 'vLLM', apiKey: 'EMPTY', apiBase: endpoint, defaultModel: model });
  }
}

// === Response parser ========================================================

function parseOpenAIResponse(json: Record<string, unknown>): LLMResponse {
  const choices = json.choices as Array<{ message: { content: string; role: string } }> | undefined;
  const usage = json.usage as { prompt_tokens: number; completion_tokens: number } | undefined;
  return {
    message: { role: 'assistant', content: choices?.[0]?.message?.content ?? '' },
    ...(usage ? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } } : {}),
  };
}

// === Factory ================================================================

export type AdapterKind = 'openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'mistral';

const ADAPTER_MAP: Record<AdapterKind, new (cfg: RemoteProviderConfig) => ILLM> = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  google: GoogleAdapter,
  xai: XAIAdapter,
  deepseek: DeepSeekAdapter,
  mistral: MistralAdapter,
};

/** Create a provider adapter from a config. Returns undefined for unknown providers. */
export function createRemoteAdapter(cfg: RemoteProviderConfig): ILLM | undefined {
  const Ctor = ADAPTER_MAP[cfg.id as AdapterKind];
  if (!Ctor) return undefined;
  return new Ctor(cfg);
}

/** Create a local adapter for Ollama. */
export function createOllamaAdapter(model: string, endpoint?: string): OllamaAdapter {
  return new OllamaAdapter(model, endpoint);
}

/** Create a local adapter for vLLM. */
export function createVLLMAdapter(model: string, endpoint?: string): VLLMAdapter {
  return new VLLMAdapter(model, endpoint);
}
