// Pluggable language model interface + a deterministic EchoLLM for tests/dev.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  /** If the assistant requested a tool call, this is set. */
  toolCalls?: ToolCallRequest[];
}

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMRequest {
  messages: ChatMessage[];
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMResponse {
  message: ChatMessage;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ILLM {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/**
 * EchoLLM — a deterministic test double that always echoes the last user message
 * back as the assistant response (no tool calls).
 */
export class EchoLLM implements ILLM {
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    return {
      message: {
        role: 'assistant',
        content: `Echo: ${lastUser?.content ?? ''}`,
      },
    };
  }
}

/**
 * ToolCallingStubLLM — follows a scripted sequence of responses. Useful for
 * deterministic tests of the agent loop: provide an ordered list of responses
 * (each is either an assistant text or a set of tool calls), and the LLM plays
 * them back in order.
 */
export class ScriptedLLM implements ILLM {
  private idx = 0;
  constructor(private readonly script: Array<{ text?: string; toolCalls?: ToolCallRequest[] }>) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const step = this.script[this.idx];
    this.idx = Math.min(this.idx + 1, this.script.length - 1);
    if (!step) return { message: { role: 'assistant', content: '' } };
    return {
      message: {
        role: 'assistant',
        content: step.text ?? '',
        toolCalls: step.toolCalls,
      },
    };
  }
}
