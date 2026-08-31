// Types for Foundation Model Fabric, Dynamic Model Router, and Ensemble Reasoning Fabric.

export type ModelModality = 'text' | 'image' | 'audio' | 'video' | 'code' | 'reasoning' | 'embedding' | 'rerank';
export type ModelTier = 'frontier-proprietary' | 'frontier-open-weight' | 'specialist' | 'local' | 'fast';
export type PrivacyClassification = 'public' | 'internal' | 'confidential';

export interface ModelMetadata {
  id: string;
  provider: string;
  name: string;
  tier: ModelTier;
  modalities: ModelModality[];
  contextWindow: number;
  costPerPromptTokenUsd: number;
  costPerCompletionTokenUsd: number;
  avgLatencyMs: number;
  reliabilityScore: number; // 0.0 to 1.0
  enabled: boolean;
}

export interface TaskProfile {
  taskType: 'chat' | 'coding' | 'reasoning' | 'embedding' | 'multimodal' | 'science';
  difficulty: number; // 1 to 10
  modality?: ModelModality;
  minContextLength?: number;
  maxLatencyMs?: number;
  maxCostUsd?: number;
  privacy?: PrivacyClassification;
  tenantPolicy?: string;
}

export interface RouterDecision {
  selectedModelId: string;
  fallbackModelIds: string[];
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
  routingReason: string;
}

export interface ModelFabricRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelFabricResponse {
  modelId: string;
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalCostUsd: number };
  latencyMs: number;
}

export interface EnsembleOptions {
  candidateCount?: number;
  verifierModelId?: string;
  consensusThreshold?: number; // 0.0 to 1.0
  temperature?: number;
}

export interface EnsembleResult {
  synthesis: string;
  candidates: Array<{ modelId: string; content: string }>;
  verifierCritique?: string;
  confidenceScore: number;
  consensusAchieved: boolean;
}
