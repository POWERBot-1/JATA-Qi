// @jataqi/learning — JATA Qi Continuous Learning + Personalization (CLP
// Phase 2/6) + Knowledge Distillation (CLP Phase 5). Public API.

export { ContinuousLearningModule, LearningEvents } from './learning-module.js';
export { LearningEngine } from './learning.js';
export type { AnalysisResult } from './learning.js';
export { PersonalizationEngine } from './personalization.js';
export { DistillationEngine } from './distillation.js';
export type { DistillInput, DistillRun } from './distillation.js';
export type {
  InsightKind, LearningInsight, Recommendation, RecommendationStatus, RecommendationCategory,
  PreferenceKey, UserProfile, AdaptationResult,
  DistilledLesson, DistilledSourceType, Playbook, DistillStats,
} from './types.js';
