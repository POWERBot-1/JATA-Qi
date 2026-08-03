// @jataqi/learning — JATA Qi Continuous Learning + Personalization (CLP Phase 2/6). Public API.

export { ContinuousLearningModule, LearningEvents } from './learning-module.js';
export { LearningEngine } from './learning.js';
export type { AnalysisResult } from './learning.js';
export { PersonalizationEngine } from './personalization.js';
export type {
  InsightKind, LearningInsight, Recommendation, RecommendationStatus, RecommendationCategory,
  PreferenceKey, UserProfile, AdaptationResult,
} from './types.js';
