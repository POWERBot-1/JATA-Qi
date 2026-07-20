// Agent loop: orchestrates tool-calling turns with an LLM.

import { randomUUID } from 'node:crypto';
import type { ILLM, ChatMessage, ToolCallRequest } from './llm.js';
import { ToolRegistry, type Tool, type ToolCallResult, type ToolContext } from './tools.js';

export interface AgentRunOptions {
  /** The user's question or instruction. */
  message: string;
  /** System prompt override. */
  systemPrompt?: string;
  /** Maximum tool-call iterations before the loop is forced to produce a final answer (default 8). */
  maxIterations?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Additional per-run metadata. */
  metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  runId: string;
  answer: string;
  messages: ChatMessage[];
  toolCalls: ToolCallResult[];
  iterations: number;
  finishedReason: 'answer' | 'max_iterations' | 'cancelled' | 'error';
  error?: string;
}

export interface AgentConfig {
  name?: string;
  description?: string;
  systemPrompt?: string;
  tools?: Tool[];
  llm: ILLM;
  maxIterations?: number;
}

export class Agent {
  readonly name: string;
  readonly description: string;
  private readonly systemPrompt: string;
  private readonly llm: ILLM;
  private readonly tools: ToolRegistry;
  private readonly maxIterations: number;

  constructor(cfg: AgentConfig) {
    this.name = cfg.name ?? 'agent';
    this.description = cfg.description ?? '';
    this.llm = cfg.llm;
    this.maxIterations = cfg.maxIterations ?? 8;
    this.tools = new ToolRegistry();
    for (const t of cfg.tools ?? []) this.tools.register(t);
    this.systemPrompt =
      cfg.systemPrompt ??
      `You are a helpful AI assistant running inside JATA Qi. Use tools when they help answer the user's question. When you have enough information, respond with a final answer as plain text (no tool calls).`;
  }

  registerTool(tool: Tool): void {
    this.tools.register(tool);
  }

  getTools(): Tool[] {
    return this.tools.list();
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const runId = randomUUID();
    const maxIters = opts.maxIterations ?? this.maxIterations;
    const logger = makeRunLogger(runId);
    const ctx: ToolContext = {
      runId,
      signal: opts.signal,
      logger,
      metadata: { agent: this.name, ...(opts.metadata ?? {}) },
    };

    const messages: ChatMessage[] = [{ role: 'system', content: opts.systemPrompt ?? this.systemPrompt }];
    messages.push({ role: 'user', content: opts.message });

    const toolCalls: ToolCallResult[] = [];
    let iterations = 0;
    let answer = '';
    let finishedReason: AgentRunResult['finishedReason'] = 'answer';

    try {
      while (iterations < maxIters) {
        if (opts.signal?.aborted) { finishedReason = 'cancelled'; break; }
        iterations++;

        const response = await this.llm.complete({
          messages,
          tools: this.tools.list().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as unknown as Record<string, unknown>,
          })),
          signal: opts.signal,
        });
        messages.push(response.message);

        const tcs = response.message.toolCalls;
        if (!tcs || tcs.length === 0) {
          answer = response.message.content;
          finishedReason = 'answer';
          break;
        }

        // Execute tool calls.
        for (const tc of tcs) {
          const res = await this.tools.call(tc.name, tc.input, ctx);
          toolCalls.push(res);
          messages.push({
            role: 'tool',
            name: tc.name,
            toolCallId: tc.id,
            content: JSON.stringify(res.error ? { error: res.error } : res.output),
          });
        }
      }

      if (iterations >= maxIters && !answer) {
        finishedReason = 'max_iterations';
        answer =
          'Reached maximum tool iterations without a final answer. Here are the last observations:\n\n' +
          toolCalls.slice(-3).map((t) => `[${t.tool}] ${JSON.stringify(t.output)}`).join('\n');
      }
    } catch (err: any) {
      finishedReason = 'error';
      answer = `Error: ${err?.message ?? String(err)}`;
    }

    return { runId, answer, messages, toolCalls, iterations, finishedReason };
  }
}

function makeRunLogger(runId: string): ToolContext['logger'] {
  // For now, log to stderr (picked up by the kernel logger when wired up).
  return {
    info: (m, d) => process.stderr.write(JSON.stringify({ run: runId, level: 'info', msg: m, data: d }) + '\n'),
    debug: (m, d) => process.stderr.write(JSON.stringify({ run: runId, level: 'debug', msg: m, data: d }) + '\n'),
    error: (m, d) => process.stderr.write(JSON.stringify({ run: runId, level: 'error', msg: m, data: d }) + '\n'),
  };
}
