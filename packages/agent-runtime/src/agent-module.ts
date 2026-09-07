import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { AUTHORIZATION_GATE_TOKEN, type AuthorizationGate } from '@jataqi/authorization-boundary';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { VectorSearchModule } from '@jataqi/vector-search';
import { Agent, AgentConfig, AgentRunOptions, AgentRunResult } from './agent.js';
import { EchoLLM, ILLM, ScriptedLLM } from './llm.js';
import type { Tool } from './tools.js';
import {
  graphFindEntityTool,
  graphRetrieveTool,
  graphTraverseTool,
  knowledgeSearchTool,
  vectorSearchTool,
} from './builtins.js';

export interface AgentModuleConfig {
  /** Default LLM for new agents; falls back to EchoLLM if not set. */
  llm?: ILLM;
  /** Default system prompt. */
  systemPrompt?: string;
  /** Extra tools to auto-register with every agent. */
  extraTools?: Tool[];
}

export class AgentRuntimeModule implements IModule {
  readonly id = 'agent-runtime';
  readonly tags = ['core', 'agent'] as const;
  readonly dependsOn = ['storage', 'vector-search', 'knowledge', 'knowledge-graph'] as const;

  private api!: KernelApi;
  private agents = new Map<string, Agent>();
  private defaultLLM!: ILLM;
  private cfg!: AgentModuleConfig;

  constructor(cfg: AgentModuleConfig = {}) {
    this.cfg = cfg;
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.defaultLLM = this.cfg.llm ?? new EchoLLM();
    // A-01: the installed boundary is resolved LAZILY (per agent, at first
    // run, post-boot) — module init order vs authorization-boundary is not
    // guaranteed, so an init-time container read would silently produce
    // ungated agents for one registration order and gated agents for another.
    kernel.container.registerValue('agent.runtime', this);
    kernel.container.registerValue('llm.default', this.defaultLLM);

    // Create a default 'main' agent with all built-in tools + any extras.
    const main = this.createAgent('main', {
      llm: this.defaultLLM,
      systemPrompt: this.cfg.systemPrompt,
      tools: this.defaultTools(),
    });
    kernel.logger.info(`agent runtime initialized (default agent: ${main.name})`);
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { this.agents.clear(); }

  /** Create a named agent and register it under the module. */
  createAgent(name: string, cfg?: Partial<AgentConfig>): Agent {
    if (this.agents.has(name)) throw new Error(`AgentRuntime: agent "${name}" already exists`);
    const tools = [...(cfg?.tools ?? this.defaultTools()), ...(this.cfg.extraTools ?? [])];
    const agent = new Agent({
      name,
      description: cfg?.description ?? `Agent ${name}`,
      llm: cfg?.llm ?? this.defaultLLM,
      systemPrompt: cfg?.systemPrompt ?? this.cfg.systemPrompt,
      maxIterations: cfg?.maxIterations,
      tools,
      // An explicit gate (tests / direct wiring) wins; otherwise the agent
      // resolves the composition's installed boundary lazily at first run.
      authorizationGate: cfg?.authorizationGate,
      resolveAuthorizationGate: cfg?.authorizationGate
        ? undefined
        : () =>
            this.api.container.has(AUTHORIZATION_GATE_TOKEN)
              ? this.api.container.resolveSync<AuthorizationGate>(AUTHORIZATION_GATE_TOKEN)
              : undefined,
    });
    this.agents.set(name, agent);
    return agent;
  }

  getAgent(name = 'main'): Agent {
    const a = this.agents.get(name);
    if (!a) throw new Error(`AgentRuntime: agent "${name}" not found`);
    return a;
  }

  /** Convenience: run a message against the default agent. */
  async run(message: string, opts?: Partial<AgentRunOptions> & { agent?: string }): Promise<AgentRunResult> {
    const agent = this.getAgent(opts?.agent ?? 'main');
    return agent.run({ message, ...opts });
  }

  /** Replace the default LLM (e.g. wire up an OpenAI-backed model at boot). */
  setDefaultLLM(llm: ILLM): void {
    this.defaultLLM = llm;
  }

  /** Expose LLM constructors for convenience. */
  static EchoLLM = EchoLLM;
  static ScriptedLLM = ScriptedLLM;

  private defaultTools(): Tool[] {
    return [
      knowledgeSearchTool(() => this.api.getModule<KnowledgeService>('knowledge')),
      graphTraverseTool(() => this.api.getModule<KnowledgeGraphModule>('knowledge-graph')),
      graphFindEntityTool(() => this.api.getModule<KnowledgeGraphModule>('knowledge-graph')),
      graphRetrieveTool(() => this.api.getModule<KnowledgeGraphModule>('knowledge-graph')),
      vectorSearchTool(() => this.api.getModule<VectorSearchModule>('vector-search')),
    ];
  }
}
