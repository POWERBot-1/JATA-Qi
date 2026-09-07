// Agent loop: orchestrates tool-calling turns with an LLM.
//
// A-01: when the agent is wired with an authorization gate, every tool call
// the model requests is first rendered into a sealed envelope by the gate
// (default deny). The model selects tools and inputs, but it cannot choose
// identities, tenants, capabilities, or credentials: the request is built
// from the verified principal supplied at run time and the tool's declared
// authorization metadata. A denied call comes back to the model as a tool
// error; the protected side effect never runs.

import { randomUUID } from 'node:crypto';
import type { A01AuthorizationEnvelope, A01PrincipalBinding, AuthorizationGate } from '@jataqi/authorization-boundary';
import type { ILLM, ChatMessage, ToolCallRequest } from './llm.js';
import { ToolRegistry, type Tool, type ToolCallResult, type ToolContext, type ToolAuthorizationDeclaration } from './tools.js';

/**
 * Per-run authorization input. `principal` MUST come from a server-verified
 * identity (T-01 `AuthenticatedPrincipal` or a T-02 durable snapshot) — never
 * from caller-supplied metadata or model output.
 */
export interface AgentRunAuthorization {
  readonly principal: A01PrincipalBinding;
  /** Agent identity bound to the run (defaults to the agent name). */
  readonly agentId?: string;
  readonly agentVersion?: string;
  /** Stable run id (defaults to a fresh uuid). */
  readonly runId?: string;
  /** Correlation id for the run (defaults to the run id). */
  readonly correlationId?: string;
  readonly causationId?: string;
  /** Stable key for idempotent replay of side-effecting tool calls. */
  readonly idempotencyKey?: string;
  /** Budget cost units per tool call (default 1). */
  readonly budgetCostUnits?: number;
}

export interface AgentRunOptions {
  /** The user's question or instruction. */
  message: string;
  /** System prompt override. */
  systemPrompt?: string;
  /** Maximum tool-call iterations before the loop is forced to produce a final answer (default 8). */
  maxIterations?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Additional per-run metadata. NOTE (A-01): metadata is UNTRUSTED — it can never set the execution tenant or any authority when the boundary is installed. */
  metadata?: Record<string, unknown>;
  /** A-01: verified principal + run identity for this run (required when the agent has a gate). */
  authorization?: AgentRunAuthorization;
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
  /** A-01: the authoritative authorization boundary for this agent's tool calls. */
  authorizationGate?: AuthorizationGate;
}

export class Agent {
  readonly name: string;
  readonly description: string;
  private readonly systemPrompt: string;
  private readonly llm: ILLM;
  private readonly tools: ToolRegistry;
  private readonly maxIterations: number;
  private readonly gate: AuthorizationGate | undefined;

  constructor(cfg: AgentConfig) {
    this.name = cfg.name ?? 'agent';
    this.description = cfg.description ?? '';
    this.llm = cfg.llm;
    this.maxIterations = cfg.maxIterations ?? 8;
    this.gate = cfg.authorizationGate;
    this.tools = new ToolRegistry({ authorizationGate: cfg.authorizationGate });
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

  /** The installed boundary, if any (diagnostics; never grants anything). */
  getAuthorizationGate(): AuthorizationGate | undefined {
    return this.gate;
  }

  /**
   * Render the sealed envelope for one model-requested tool call. The request
   * is built ONLY from the verified run principal and the tool's declared
   * authorization metadata — never from model output or caller metadata.
   */
  private renderToolEnvelope(
    tool: Tool,
    input: unknown,
    opts: AgentRunOptions,
    runId: string,
  ): A01AuthorizationEnvelope {
    const auth = opts.authorization;
    const runIdFinal = auth?.runId ?? runId;
    const correlationId = auth?.correlationId ?? runIdFinal;
    const agentId = auth?.agentId ?? this.name;
    const decl: ToolAuthorizationDeclaration | undefined = tool.authorization;
    const request = {
      // A missing verified principal is fail-closed: the decision is a DENY
      // (MISSING_PRINCIPAL) — the model's tool call is refused, not executed.
      principal: auth?.principal ?? {
        id: '',
        tenantId: '',
        roles: [],
        authenticationMethod: 'KERNEL_INTERNAL',
        authenticationEventId: '',
      },
      tenantId: auth?.principal?.tenantId ?? '',
      agent: {
        agentId,
        ...(auth?.agentVersion !== undefined ? { agentVersion: auth.agentVersion } : {}),
      },
      run: {
        runId: runIdFinal,
        correlationId,
        ...(auth?.causationId !== undefined ? { causationId: auth.causationId } : {}),
      },
      capability: decl
        ? { capabilityId: decl.capabilityId, capabilityVersion: decl.capabilityVersion }
        : { capabilityId: '', capabilityVersion: '' },
      tool: tool.name,
      operation: decl?.operation ?? '',
      target: {
        system: decl?.targetSystem ?? '',
        ...(decl?.targetFromInput ? { resource: decl.targetFromInput(input) } : {}),
        ...(decl?.audience !== undefined ? { audience: decl.audience } : {}),
      },
      // Fail-closed defaults for undeclared tools: most severe impact, no
      // classification assumptions.
      dataClassification: decl?.dataClassification ?? 'INTERNAL',
      impact: decl?.impact ?? 'EXTERNAL_SIDE_EFFECT',
      ...(auth?.idempotencyKey !== undefined
        ? { idempotencyKey: `${auth.idempotencyKey}::${tool.name}::${runIdFinal}` }
        : {}),
      budgetCostUnits: auth?.budgetCostUnits ?? 1,
      provenance: { source: `agent:${this.name}` },
    };
    return this.gate!.decide(request);
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const runId = randomUUID();
    const maxIters = opts.maxIterations ?? this.maxIterations;
    const logger = makeRunLogger(runId);
    const ctx: ToolContext = {
      runId,
      signal: opts.signal,
      logger,
      // A-01: metadata stays caller-supplied and UNTRUSTED; with a gate
      // installed the execution tenant comes from the sealed envelope.
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
            inputSchema: t.inputSchema,
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
          // A-01: with a gate installed, every model-requested call is first
          // rendered into a sealed envelope (default deny) and the call
          // carries it; the registry enforces it before the tool executes.
          if (this.gate) {
            const tool = this.tools.get(tc.name);
            if (tool) {
              ctx.authorization = { envelope: this.renderToolEnvelope(tool, tc.input, opts, runId) };
            } else {
              ctx.authorization = undefined;
            }
          }
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
