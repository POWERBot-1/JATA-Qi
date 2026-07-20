// OpenAI-compatible chat-completions LLM. Supports tool/function calling.

import type { ChatMessage, ILLM, LLMRequest, LLMResponse, ToolCallRequest } from '../llm.js';

export interface OpenAILLMConfig {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  temperature?: number;
  fetcher?: typeof fetch;
}

interface ChatCompletionResp {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class OpenAILLM implements ILLM {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly temperature: number;
  private readonly fetcher: typeof fetch;

  constructor(cfg: OpenAILLMConfig = {}) {
    this.model = cfg.model ?? 'gpt-4o-mini';
    this.endpoint = cfg.endpoint ?? 'https://api.openai.com/v1/chat/completions';
    this.temperature = cfg.temperature ?? 0.2;
    this.apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.fetcher = cfg.fetcher ?? globalThis.fetch?.bind(globalThis);
    this.id = `openai:${this.model}`;
    if (!this.fetcher) throw new Error('OpenAILLM: fetch is not available');
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (!this.apiKey) throw new Error('OpenAILLM: apiKey not configured (set OPENAI_API_KEY)');

    const body: Record<string, unknown> = {
      model: this.model,
      temperature: req.temperature ?? this.temperature,
      max_tokens: req.maxTokens ?? 1024,
      messages: req.messages.map(toApiMessage),
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: (t.inputSchema as any)?.properties ?? {},
            required: (t.inputSchema as any)?.required ?? [],
          },
        },
      }));
      body.tool_choice = 'auto';
    }

    const res = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAILLM: ${res.status} ${t}`);
    }
    const json = (await res.json()) as ChatCompletionResp;
    const choice = json.choices[0];
    if (!choice) throw new Error('OpenAILLM: no choices returned');
    const msg = choice.message;
    let toolCalls: ToolCallRequest[] | undefined;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = msg.tool_calls.map((tc) => {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments); } catch { input = { _raw: tc.function.arguments }; }
        return { id: tc.id, name: tc.function.name, input };
      });
    }
    return {
      message: {
        role: 'assistant',
        content: msg.content ?? '',
        toolCalls,
      },
      usage: json.usage
        ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens }
        : undefined,
    };
  }
}

function toApiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content, name: m.name };
  }
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name) out.name = m.name;
  if (m.toolCalls) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.input) },
    }));
  }
  return out;
}
