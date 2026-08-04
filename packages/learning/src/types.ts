// JATA Qi Continuous Learning + Personalization — types. The learning engine
// analyzes the Digital Memory stream to derive insights and generate governed
// improvement recommendations; the personalization engine maintains per-user
// preference profiles and behavior-derived adaptations. Both COMPOSE the
// existing memory/analytics modules — they do not duplicate them.

import type { MemoryEvent } from '@jataqi/memory';

// ---- learning insights ---------------------------------------------------

export type InsightKind =
  | 'feature-adoption' | 'feature-decline' | 'user-journey' | 'workflow-completion'
  | 'workflow-abandonment' | 'ui-friction' | 'error-frequency' | 'performance-bottleneck'
  | 'search-failure' | 'config-trend' | 'automation-opportunity';

export interface LearningInsight {
  id: string;
  kind: InsightKind;
  title: string;
  detail: string;
  /** Supporting evidence (counts, paths, rates). */
  evidence: Record<string, unknown>;
  /** 0..1 confidence in the insight. */
  confidence: number;
  orgId?: string;
  generatedAt: number;
}

// ---- recommendations -----------------------------------------------------

export type RecommendationStatus = 'proposed' | 'reviewing' | 'accepted' | 'rejected' | 'deployed';
export type RecommendationCategory =
  | 'ui-improvement' | 'workflow-optimization' | 'feature-suggestion'
  | 'documentation' | 'automation' | 'performance' | 'security' | 'configuration';

export interface Recommendation {
  id: string;
  title: string;
  category: RecommendationCategory;
  rationale: string;
  /** Actionable steps to implement the recommendation. */
  actions: string[];
  /** Expected impact (qualitative). */
  impact: 'low' | 'medium' | 'high';
  priority: number; // 0..100
  status: RecommendationStatus;
  insightIds: string[];
  orgId?: string;
  reviewer?: string;
  reviewedAt?: number;
  createdAt: number;
}

// ---- personalization -----------------------------------------------------

export type PreferenceKey =
  | 'theme' | 'language' | 'dashboardLayout' | 'favoriteModules' | 'preferredModel'
  | 'notificationPrefs' | 'accessibility' | 'keyboardShortcuts' | 'workingHours'
  | 'timezone' | 'frequentlyContacted' | 'navOrder' | 'searchBoost' | 'aiSettings';

export interface UserProfile {
  userId: string;
  orgId?: string;
  /** Explicit preferences set by the user. */
  preferences: Map<PreferenceKey, unknown>;
  /** Behavior-derived effective settings (from adaptation). */
  derived: Map<PreferenceKey, unknown>;
  updatedAt: number;
}

export interface AdaptationResult {
  userId: string;
  /** Recommended navigation order (most-used first). */
  navOrder: string[];
  /** Search terms to boost (from frequent queries). */
  searchBoost: string[];
  /** Suggested keyboard shortcuts based on frequent actions. */
  shortcutSuggestions: Array<{ action: string; frequency: number }>;
  /** Suggested dashboard widgets based on usage. */
  widgetSuggestions: string[];
  /** Preferred AI model (from accepted AI responses). */
  preferredModel?: string;
}

// ---- knowledge distillation (CLP Phase 5) --------------------------------

/** What produced a distilled lesson. */
export type DistilledSourceType = 'insight' | 'recommendation';

/**
 * A durable lesson distilled from the learning stream: high-confidence
 * insights and deployed recommendations, persisted into the knowledge layer
 * (knowledge service document + knowledge graph entity) so that what JATA Qi
 * learns becomes part of its permanent knowledge base (CLP Phase 5).
 */
export interface DistilledLesson {
  id: string;
  sourceType: DistilledSourceType;
  sourceId: string;
  title: string;
  body: string;
  /** Insight kind or recommendation category. */
  category: string;
  confidence: number;
  orgId?: string;
  /** Knowledge-graph entity id (ent:lesson:<id>) when the graph is present. */
  entityId?: string;
  /** Knowledge-service document id when the service is present. */
  documentId?: string;
  distilledAt: number;
}

/** An operational playbook assembled from deployed recommendations. */
export interface Playbook {
  id: string;
  name: string;
  category: string;
  summary: string;
  /** Ordered actionable steps. */
  steps: string[];
  lessonIds: string[];
  orgId?: string;
  status: 'active' | 'superseded';
  createdAt: number;
}

/** Cumulative distillation counters. */
export interface DistillStats {
  lessons: number;
  playbooks: number;
  documentsIngested: number;
  graphEntities: number;
  graphTriples: number;
  lastDistilledAt?: number;
}
