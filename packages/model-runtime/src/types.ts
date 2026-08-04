// Sovereign Model Runtime — type definitions.
// Manages model lifecycle for both local (Ollama, vLLM, llama.cpp) and remote
// (OpenAI, Anthropic, Google, etc.) providers. The runtime makes external
// providers OPTIONAL: when no remote providers are configured, it serves from
// local models or falls back to the built-in EchoLLM.

export type ProviderKind = 'local' | 'remote' | 'builtin';
export type ModelStatus = 'loading' | 'ready' | 'unloading' | 'error' | 'unavailable';

export interface LocalModelConfig {
  /** Model identifier (e.g. 'llama-3.1-8b', 'qwen-2.5-7b'). */
  id: string;
  /** Display name. */
  name: string;
  /** Model family for routing decisions. */
  family: string;
  /** Capabilities this model provides. */
  capabilities: string[];
  /** Local server endpoint (Ollama: http://localhost:11434, vLLM: http://localhost:8000). */
  endpoint: string;
  /** Quantization (e.g. 'Q4_K_M', 'Q8_0', 'fp16'). */
  quantization?: string;
  /** Context window in tokens. */
  contextWindow?: number;
  /** Memory footprint in MB. */
  memoryMb?: number;
  /** Quality score 0-100 for routing. */
  quality?: number;
  /** Typical latency in ms. */
  latencyMs?: number;
}

export interface RemoteProviderConfig {
  /** Provider id (e.g. 'openai', 'anthropic', 'google', 'xai'). */
  id: string;
  /** Display name. */
  name: string;
  /** API key (env-injected; never stored in config files). */
  apiKey: string;
  /** API base URL (override for proxies/Bedrock/Azure). */
  apiBase?: string;
  /** Default model for this provider. */
  defaultModel?: string;
  /** Capabilities. */
  capabilities?: string[];
}

export interface ModelHealth {
  modelId: string;
  status: ModelStatus;
  totalRequests: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  lastChecked: number;
  lastError?: string;
}

export interface GPUDetection {
  available: boolean;
  deviceCount: number;
  devices: string[];
  totalMemoryMb?: number;
  cudaVersion?: string;
}

export interface RoutingContext {
  /** Requested capabilities. */
  capabilities?: string[];
  /** Quality/latency/cost preference. */
  prefer?: 'quality' | 'latency' | 'cost';
  /** Privacy classification — 'sensitive' forces local execution. */
  privacy?: 'public' | 'internal' | 'sensitive';
  /** Max cost per 1k tokens. */
  maxCostPer1k?: number;
  /** Allowed providers (empty = all). */
  allowedProviders?: string[];
  /** Force local execution. */
  forceLocal?: boolean;
}

export interface RoutingResult {
  modelId: string;
  providerKind: ProviderKind;
  endpoint?: string;
  rationale: string;
  isLocal: boolean;
}

export const ModelRuntimeEvents = Object.freeze({
  ModelLoaded: 'model-runtime.model.loaded',
  ModelUnloaded: 'model-runtime.model.unloaded',
  ModelFailed: 'model-runtime.model.failed',
  GPUStatusChanged: 'model-runtime.gpu.changed',
  RoutingDecision: 'model-runtime.routing.decision',
} as const);
