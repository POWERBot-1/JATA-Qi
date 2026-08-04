// @jataqi/ai-learning — JATA Qi AI Learning Platform (CLP Phase 3 + Phase 4
// eval-gated experimentation). Public API.

export { AiLearningModule, AiLearningEvents } from './ai-learning-module.js';
export { PromptRegistry, extractVariables } from './prompt-registry.js';
export { QualityTracker } from './quality.js';
export { DriftDetector } from './drift.js';
export { ExperimentEngine } from './experiment.js';
export type { CreateExperimentInput, ExperimentEvaluation, ExperimentServeResult } from './experiment.js';
export type { DriftConfig } from './drift.js';
export type {
  PromptTemplate, PromptVersion, PromptVersionStatus, ResponseOutcome,
  QualityMetrics, DriftAlert, ModelBenchmark, PromptExperiment,
  ExperimentStatus, ExperimentDecision, ExperimentVariant,
} from './types.js';
