// @jataqi/game-liveops — NOVA Live Game Operations Engine (section 15). Public API.

export { LiveOpsModule, LiveOpsEvents } from './liveops.js';
export type { Season, RemoteConfigEntry, OfferShown, OfferPurchase } from './liveops.js';
export { Analytics, dayKey, weekKey, monthKey } from './analytics.js';
export type { PlayerRecord } from './analytics.js';
export { EventScheduler } from './schedule.js';
export {
  ExperimentManager, FeatureFlagManager, segmentMatches,
} from './experiments.js';
export type { CreateExperimentInput, VariantReport, ExperimentReport, FeatureFlag } from './experiments.js';
export type {
  EventStatus, LiveEvent, TelemetryEvent, FunnelStage, Funnel, Cohort,
  ExperimentStatus, Variant, Experiment, Offer, Segment,
  PlayerProfile, Session, AnalyticsFilter, MetricSummary,
} from './types.js';
