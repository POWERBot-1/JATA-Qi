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
