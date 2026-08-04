// ModelRuntimeModule — kernel module that owns the SovereignRouter, GPU detection,
// model lifecycle, and health monitoring. Exposes the unified routing API.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ILLM } from '@jataqi/agent-runtime';
import { EchoLLM } from '@jataqi/agent-runtime';
import { detectGPU } from './gpu.js';
import { SovereignRouter } from './router.js';
import { ModelRuntimeEvents } from './types.js';
import type { GPUDetection, LocalModelConfig, RemoteProviderConfig, RoutingContext, RoutingResult, ModelHealth } from './types.js';

export interface ModelRuntimeConfig {
  localModels?: LocalModelConfig[];
  remoteProviders?: RemoteProviderConfig[];
  /** Auto-detect Ollama at localhost:11434. */
  autoDetectOllama?: boolean;
  /** Auto-detect vLLM at localhost:8000. */
  autoDetectVLLM?: boolean;
}

export class ModelRuntimeModule implements IModule, ILLM {
  readonly id = 'model-runtime';
  readonly tags = ['core', 'ai'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly router: SovereignRouter;
  gpu: GPUDetection;

  constructor(cfg: ModelRuntimeConfig = {}) {
    this.router = new SovereignRouter();
    this.gpu = detectGPU();

    // Register configured local models.
    for (const m of cfg.localModels ?? []) this.router.registerLocal(m);
    // Register configured remote providers.
    for (const p of cfg.remoteProviders ?? []) this.router.registerRemote(p);

    // Auto-detect local servers.
    if (cfg.autoDetectOllama) this.detectOllama();
    if (cfg.autoDetectVLLM) this.detectVLLM();
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('model-runtime', this);
    kernel.container.registerValue('llm.default', this); // Override any previous default LLM
    kernel.logger.info(`model-runtime initialized: GPU=${this.gpu.available ? this.gpu.devices.join(', ') : 'none'}, local=${this.router.hasLocalModels()}, remote=${this.router.hasRemoteProviders()}`);
    if (!this.router.hasLocalModels() && !this.router.hasRemoteProviders()) {
      kernel.logger.info('model-runtime: no models configured — operating in sovereign fallback mode (EchoLLM)');
    }
  }
  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  // --- ILLM interface (drop-in for agent runtime) ---

  async complete(req: import('@jataqi/agent-runtime').LLMRequest): Promise<import('@jataqi/agent-runtime').LLMResponse> {
    const result = await this.router.complete(req);
    void this.api?.bus?.emit(ModelRuntimeEvents.RoutingDecision, { modelId: 'auto', sovereign: true });
    return result;
  }

  /** Complete with explicit routing context (privacy-aware). */
  async completeRouted(req: import('@jataqi/agent-runtime').LLMRequest, ctx: RoutingContext): Promise<{ response: import('@jataqi/agent-runtime').LLMResponse; routing: RoutingResult }> {
    const result = await this.router.completeRouted(req, ctx);
    void this.api?.bus?.emit(ModelRuntimeEvents.RoutingDecision, { modelId: result.routing.modelId, isLocal: result.routing.isLocal, sovereign: true });
    return result;
  }

  /** Route a request without executing it. */
  route(ctx: RoutingContext): RoutingResult { return this.router.route(ctx); }

  /** Register a local model at runtime. */
  registerLocal(config: LocalModelConfig): void {
    this.router.registerLocal(config);
    void this.api?.bus?.emit(ModelRuntimeEvents.ModelLoaded, { id: config.id });
  }

  /** Register a remote provider at runtime. */
  registerRemote(config: RemoteProviderConfig): void {
    this.router.registerRemote(config);
  }

  /** Get health stats for all models. */
  getHealth(): ModelHealth[] { return this.router.getHealth(); }

  /** True if the platform can operate without external providers. */
  isSovereign(): boolean { return this.router.hasLocalModels() || true; } // always sovereign with EchoLLM

  // --- auto-detection ---

  private detectOllama(): void {
    void this.probeEndpoint('http://127.0.0.1:11434/api/tags').then((models: string[]) => {
      for (const m of models) this.router.registerLocal({
        id: m, name: m, family: 'ollama', capabilities: ['chat'],
        endpoint: 'http://127.0.0.1:11434', contextWindow: 8192, quality: 60, latencyMs: 500,
      });
    }).catch(() => { /* not running */ });
  }

  private detectVLLM(): void {
    void this.probeEndpoint('http://127.0.0.1:8000/v1/models').then((models: string[]) => {
      for (const m of models) this.router.registerLocal({
        id: m, name: m, family: 'vllm', capabilities: ['chat'],
        endpoint: 'http://127.0.0.1:8000', contextWindow: 32768, quality: 70, latencyMs: 300,
      });
    }).catch(() => { /* not running */ });
  }

  private async probeEndpoint(url: string): Promise<string[]> {
    const r = await globalThis.fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return [];
    const json = await r.json() as { models?: { name: string }[]; data?: { id: string }[] };
    return (json.models ?? json.data ?? []).map((m) => ('name' in m ? m.name : m.id));
  }
}
