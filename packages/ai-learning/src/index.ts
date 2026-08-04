// @jataqi/ai-learning — JATA Qi AI Learning Platform (CLP Phase 3). Public API.

export { AiLearningModule, AiLearningEvents } from './ai-learning-module.js';
export { PromptRegistry, extractVariables } from './prompt-registry.js';
export { QualityTracker } from './quality.js';
export { DriftDetector } from './drift.js';
export type { DriftConfig } from './drift.js';
export type {
  PromptTemplate, PromptVersion, PromptVersionStatus, ResponseOutcome,
  QualityMetrics, DriftAlert, ModelBenchmark,
} from './types.js';
