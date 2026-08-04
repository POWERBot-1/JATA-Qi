// JATA Qi Model Registry — types.
//
// Model Intelligence (spec Step 4 #7 "Model Intelligence", Step 7 "Artificial
// Intelligence Layer") selects appropriate AI models based on task requirements,
// cost, latency, accuracy and policy. This package catalogs available models
// with rich metadata and provides a selector.

export type ModelCapability =
  | 'chat'
  | 'completion'
  | 'embedding'
  | 'vision'
  | 'audio'
  | 'reasoning'
  | 'code'
  | 'tool-use'
  | string;

/** Metadata describing a registered model. */
export interface ModelDescriptor {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly capabilities: ModelCapability[];
  /** Max input tokens the model accepts. */
  readonly contextWindow?: number;
  /** USD per 1k input tokens. */
  readonly inputCostPer1k?: number;
  /** USD per 1k output tokens. */
  readonly outputCostPer1k?: number;
  /** Typical round-trip latency in ms. */
  readonly latencyMs?: number;
  /** Heuristic quality score 0..100 (higher = better). */
  readonly quality?: number;
  readonly tags?: string[];
  /** Mark one model as the default for its capabilities. */
  readonly default?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export type SelectionPreference = 'cost' | 'latency' | 'quality';

export interface SelectionRequest {
  /** Capabilities the model MUST have. */
  capabilities?: ModelCapability[];
  /** Which dimension to optimize. Default 'quality'. */
  prefer?: SelectionPreference;
  /** Restrict to these provider ids. */
  providers?: string[];
  /** Only models with contextWindow >= this. */
  minContextWindow?: number;
}

export interface SelectionResult {
  readonly model: ModelDescriptor | undefined;
  readonly candidates: number;
  readonly score?: number;
  readonly rationale: string;
}

export const ModelRegistryEvents = Object.freeze({
  ModelRegistered: 'model.registered',
  ModelUnregistered: 'model.unregistered',
  ModelSelected: 'model.selected',
} as const);
