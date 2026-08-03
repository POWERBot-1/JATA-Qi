// LearningEngine — analyzes the Digital Memory event stream to derive actionable
// insights (feature adoption, user journeys, workflow completion/abandonment,
// UI friction, error frequency, search failures, automation opportunities) and
// generates governed improvement recommendations. This is the "brain" that
// turns raw platform signals into product intelligence. It does NOT duplicate
// analytics (it consumes the memory/analytics output); it adds the insight +
// recommendation layer on top.

import { randomUUID } from 'node:crypto';
import type { MemoryEvent } from '@jataqi/memory';
import type {
  InsightKind, LearningInsight, Recommendation, RecommendationCategory, RecommendationStatus,
} from './types.js';

export interface AnalysisResult {
  insights: LearningInsight[];
  summary: { totalEvents: number; categories: number; sessions: number; timeSpan: number };
}

export class LearningEngine {
  private minConfidence: number;

  constructor(opts: { minConfidence?: number } = {}) {
    this.minConfidence = opts.minConfidence ?? 0.3;
  }

  /** Run all analyses over a memory event set; returns insights + a summary. */
  analyze(events: MemoryEvent[], orgId?: string): AnalysisResult {
    const scoped = orgId !== undefined ? events.filter((e) => e.orgId === orgId) : events;
    const insights: LearningInsight[] = [];
    const now = Date.now();

    insights.push(...this.featureAdoption(scoped, orgId, now));
    insights.push(...this.userJourneys(scoped, orgId, now));
    insights.push(...this.workflowCompletion(scoped, orgId, now));
    insights.push(...this.errorFrequency(scoped, orgId, now));
    insights.push(...this.searchFailures(scoped, orgId, now));
    insights.push(...this.frictionDetection(scoped, orgId, now));
    insights.push(...this.automationOpportunities(scoped, orgId, now));

    const filtered = insights.filter((i) => i.confidence >= this.minConfidence);
    const ts = scoped.length > 0 ? Math.max(...scoped.map((e) => e.ts)) - Math.min(...scoped.map((e) => e.ts)) : 0;
    return {
      insights: filtered,
      summary: {
        totalEvents: scoped.length,
        categories: new Set(scoped.map((e) => e.category)).size,
        sessions: new Set(scoped.map((e) => e.sessionId).filter(Boolean)).size,
        timeSpan: ts,
      },
    };
  }

  /** Generate governed recommendations from a set of insights. */
  generateRecommendations(insights: LearningInsight[]): Recommendation[] {
    return insights.flatMap((insight) => this.insightToRecommendations(insight));
  }

  // ---- individual analyses -----------------------------------------------

  private featureAdoption(events: MemoryEvent[], orgId: string | undefined, now: number): LearningInsight[] {
    const counts = this.countBy(events, (e) => e.category);
    const total = events.length || 1;
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const out: LearningInsight[] = [];
    if (sorted.length === 0) return out;

    const top = sorted[0]!;
    out.push({
      id: randomUUID(), kind: 'feature-adoption', orgId, generatedAt: now,
      title: `High adoption: "${top[0]}"`,
      detail: `"${top[0]}" accounts for ${((top[1] / total) * 100).toFixed(1)}% of all recorded activity (${top[1]} events).`,
      evidence: { category: top[0], count: top[1], share: top[1] / total },
      confidence: Math.min(1, top[1] / 50),
    });

    if (sorted.length > 3) {
      const bottom = sorted[sorted.length - 1]!;
      out.push({
        id: randomUUID(), kind: 'feature-decline', orgId, generatedAt: now,
        title: `Low adoption: "${bottom[0]}"`,
        detail: `"${bottom[0]}" has only ${bottom[1]} events — consider improving discoverability or documentation.`,
        evidence: { category: bottom[0], count: bottom[1], share: bottom[1] / total },
        confidence: bottom[1] < 5 ? 0.8 : 0.4,
      });
    }
    return out;
  }

  private userJourneys(events: MemoryEvent[], orgId: string | undefined, now: number): LearningInsight[] {
    const sessions = this.groupBySession(events);
    const pathCounts = new Map<string, number>();
    for (const [, sessEvents] of sessions) {
      const nav = sessEvents.filter((e) => e.category === 'navigation').map((e) => e.data?.target as string ?? e.summary);
      if (nav.length >= 2) {
        const path = nav.slice(0, 5).join(' → ');
        pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
      }
    }
    const top = [...pathCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] < 2) return [];
    return [{
      id: randomUUID(), kind: 'user-journey', orgId, generatedAt: now,
      title: 'Common navigation path detected',
      detail: `Most frequent journey: "${top[0]}" (observed ${top[1]} times). Consider promoting these screens.`,
      evidence: { path: top[0], count: top[1] },
      confidence: Math.min(1, top[1] / 10),
    }];
  }

  private workflowCompletion(events: MemoryEvent[], orgId: string | undefined, now: number): LearningInsight[] {
    const wfEvents = events.filter((e) => e.category === 'workflow');
    if (wfEvents.length === 0) return [];
    const completed = wfEvents.filter((e) => e.data?.status === 'completed' || e.tags?.includes('completed')).length;
    const abandoned = wfEvents.filter((e) => e.data?.status === 'abandoned' || e.tags?.includes('abandoned')).length;
    const rate = wfEvents.length > 0 ? completed / wfEvents.length : 0;
    const out: LearningInsight[] = [];
    if (abandoned > completed && abandoned >= 3) {
      out.push({
        id: randomUUID(), kind: 'workflow-abandonment', orgId, generatedAt: now,
        title: 'High workflow abandonment',
        detail: `${abandoned} workflows abandoned vs ${completed} completed (${(rate * 100).toFixed(0)}% completion). Review friction points.`,
        evidence: { completed, abandoned, rate },
        confidence: Math.min(1, abandoned / 10),
      });
    } else if (completed >= 5) {
      out.push({
        id: randomUUID(), kind: 'workflow-completion', orgId, generatedAt: now,
        title: 'Healthy workflow completion',
        detail: `${(rate * 100).toFixed(0)}% workflow completion rate (${completed}/${wfEvents.length}).`,
        evidence: { completed, abandoned, rate },
        confidence: 0.5,
      });
    }
    return out;
  }

  private errorFrequency(events: MemoryEvent[], orgId: string | undefined, now: number): LearningInsight[] {
    const errors = events.filter((e) => e.category === 'error' || e.category === 'exception');
    if (errors.length < 3) return [];
    const byType = this.countBy(errors, (e) => (e.data?.type as string ?? e.summary.slice(0, 40)));
    const top = [...byType.entries()].sort((a, b) => b[1] - a[1])[0]!;
    return [{
      id: randomUUID(), kind: 'error-frequency', orgId, generatedAt: now,
      title: `Recurring error: "${top[0]!}"`,
      detail: `"${top[0]!}" occurred ${top[1]} times — investigate and fix.`,
      evidence: { errorType: top[0], count: top[1], totalErrors: errors.length },
      confidence: Math.min(1, top[1]! / 10),
    }];
  }

  private searchFailures(events: MemoryEvent[], orgId: string | undefined, now: number): LearningInsight[] {
    const searches = events.filter((e) => e.category === 'search');
    if (searches.length < 2) return [];
    // A "failed" search has no subsequent feature_usage in the same session.
    const sessions = this.groupBySession(events);
    let failed = 0;
    for (const [, sessEvents] of sessions) {
      const searchIdx = sessEvents.findIndex((e) => e.category === 'search');
      if (searchIdx < 0) continue;
      const after = sessEvents.slice(searchIdx + 1);
      const hasFollowUp = after.some((e) => e.category === 'feature_usage' || e.category === 'navigation');
      if (!hasFollowUp) failed++;
    }
    if (failed < 2) return [];
    return [{
      id: randomUUID(), kind: 'search-failure', orgId, generatedAt: now,
      title: 'Search results not leading to action',
      detail: `${failed} searches did not result in any follow-up navigation or feature use — improve search relevance.`,
      evidence: { failedSearches: failed, totalSearches: searches.length, failureRate: failed / searches.length },
      confidence: Math.min(1, failed / 5),
    }];
  }

  private frictionDetection(events: MemoryEvent[], orgId: string | undefined, now: number): LearningInsight[] {
    const sessions = this.groupBySession(events);
    let frictionCount = 0;
    for (const [, sessEvents] of sessions) {
      if (sessEvents.length < 3) continue;
      // Backtracking: same navigation target appearing multiple times.
      const navs = sessEvents.filter((e) => e.category === 'navigation').map((e) => e.data?.target as string ?? e.summary);
      const unique = new Set(navs).size;
      if (navs.length > unique * 2 && navs.length >= 4) frictionCount++;
    }
    if (frictionCount < 1) return [];
    return [{
      id: randomUUID(), kind: 'ui-friction', orgId, generatedAt: now,
      title: 'Navigation backtracking detected',
      detail: `${frictionCount} sessions show repeated backtracking — users may be confused. Streamline the flow.`,
      evidence: { frictionSessions: frictionCount, totalSessions: sessions.size },
      confidence: Math.min(1, frictionCount / 3),
    }];
  }

  private automationOpportunities(events: MemoryEvent[], orgId: string | undefined, now: number): LearningInsight[] {
    const sessions = this.groupBySession(events);
    const seqCounts = new Map<string, number>();
    for (const [, sessEvents] of sessions) {
      const seq = sessEvents.slice(0, 6).map((e) => `${e.category}:${e.data?.target ?? e.summary.slice(0, 20)}`).join('|');
      if (seq.length > 10) seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1);
    }
    const repeated = [...seqCounts.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
    if (repeated.length === 0) return [];
    return [{
      id: randomUUID(), kind: 'automation-opportunity', orgId, generatedAt: now,
      title: 'Repetitive workflow detected — automate it',
      detail: `An action sequence was repeated ${repeated[0]![1]} times across sessions. Consider creating a workflow template or shortcut.`,
      evidence: { sequence: repeated[0]![0], repetitions: repeated[0]![1] },
      confidence: Math.min(1, repeated[0]![1] / 8),
    }];
  }

  // ---- insight → recommendation mapping ----------------------------------

  private insightToRecommendations(insight: LearningInsight): Recommendation[] {
    const base = { id: randomUUID(), insightIds: [insight.id], orgId: insight.orgId, status: 'proposed' as RecommendationStatus, createdAt: Date.now() };
    const priority = Math.round(insight.confidence * 100);

    switch (insight.kind) {
      case 'feature-adoption':
        return [{ ...base, title: `Promote "${insight.evidence.category}"`, category: 'feature-suggestion', rationale: insight.detail, actions: ['Add to primary navigation', 'Create a shortcut', 'Surface in onboarding'], impact: 'high', priority }];
      case 'feature-decline':
        return [{ ...base, title: `Improve discoverability of "${insight.evidence.category}"`, category: 'documentation', rationale: insight.detail, actions: ['Add a tooltip tour', 'Link from related features', 'Write a help article'], impact: 'medium', priority }];
      case 'workflow-abandonment':
        return [{ ...base, title: 'Reduce workflow friction', category: 'workflow-optimization', rationale: insight.detail, actions: ['Audit the abandonment step', 'Simplify the form', 'Add progress indicators'], impact: 'high', priority }];
      case 'ui-friction':
        return [{ ...base, title: 'Streamline navigation flow', category: 'ui-improvement', rationale: insight.detail, actions: ['Reduce navigation depth', 'Add breadcrumbs', 'Surface recently-used items'], impact: 'medium', priority }];
      case 'error-frequency':
        return [{ ...base, title: `Fix recurring error`, category: 'performance', rationale: insight.detail, actions: ['Reproduce the error', 'Add error handling', 'Monitor fix'], impact: 'high', priority }];
      case 'search-failure':
        return [{ ...base, title: 'Improve search relevance', category: 'ui-improvement', rationale: insight.detail, actions: ['Index more content', 'Add search suggestions', 'Track zero-result queries'], impact: 'medium', priority }];
      case 'automation-opportunity':
        return [{ ...base, title: 'Create an automation template', category: 'automation', rationale: insight.detail, actions: ['Design a workflow template', 'Add a smart shortcut', 'Schedule it'], impact: 'high', priority }];
      default:
        return [];
    }
  }

  // ---- helpers -----------------------------------------------------------

  private countBy<T>(arr: T[], keyFn: (item: T) => string): Map<string, number> {
    const m = new Map<string, number>();
    for (const item of arr) { const k = keyFn(item); m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }

  private groupBySession(events: MemoryEvent[]): Map<string, MemoryEvent[]> {
    const m = new Map<string, MemoryEvent[]>();
    for (const e of events) {
      const sid = e.sessionId ?? '_global';
      const arr = m.get(sid) ?? [];
      arr.push(e);
      m.set(sid, arr);
    }
    // Sort each session by ts.
    for (const [, arr] of m) arr.sort((a, b) => a.ts - b.ts);
    return m;
  }
}
