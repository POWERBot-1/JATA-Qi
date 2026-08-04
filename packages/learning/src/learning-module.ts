// ContinuousLearningModule — kernel module integrating the LearningEngine and
// PersonalizationEngine with the Digital Memory Engine. Pulls governed memory
// events, derives insights, generates governed recommendations (with a review
// lifecycle), and adapts the user experience. All work is transparent,
// configurable, and audit-logged via the bus.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { LearningEngine } from './learning.js';
import { PersonalizationEngine } from './personalization.js';
import type { AdaptationResult, LearningInsight, PreferenceKey, Recommendation, RecommendationStatus } from './types.js';

export const LearningEvents = Object.freeze({
  InsightsGenerated: 'learning.insights.generated',
  RecommendationProposed: 'learning.recommendation.proposed',
  RecommendationReviewed: 'learning.recommendation.reviewed',
  UserAdapted: 'personalization.user.adapted',
} as const);

export class ContinuousLearningModule implements IModule {
  readonly id = 'learning';
  readonly tags = ['core', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly engine = new LearningEngine();
  readonly personalization = new PersonalizationEngine();
  private insights: LearningInsight[] = [];
  private recommendations: Recommendation[] = [];

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('learning', this);
    kernel.logger.info('continuous-learning module initialized');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  /** Pull events from the memory module, analyze, and generate recommendations. */
  async analyze(orgId?: string): Promise<{ insights: LearningInsight[]; recommendations: Recommendation[]; summary: { totalEvents: number; categories: number; sessions: number; timeSpan: number } }> {
    const memory = this.tryMemory();
    const events = memory ? memory.query({ ...(orgId ? { orgId } : {}), limit: Number.POSITIVE_INFINITY }) : [];
    const result = this.engine.analyze(events, orgId);
    const newRecs = this.engine.generateRecommendations(result.insights);

    this.insights = [...this.insights.filter((i) => i.orgId !== orgId), ...result.insights];
    // Replace proposed recommendations for this org; keep reviewed/deployed ones.
    this.recommendations = [
      ...this.recommendations.filter((r) => r.orgId !== orgId || r.status !== 'proposed'),
      ...newRecs,
    ];

    void this.api.bus.emit(LearningEvents.InsightsGenerated, { count: result.insights.length, orgId });
    for (const r of newRecs) void this.api.bus.emit(LearningEvents.RecommendationProposed, { id: r.id, category: r.category, orgId });
    return { insights: result.insights, recommendations: newRecs, summary: result.summary };
  }

  getRecommendations(filter?: { orgId?: string; status?: RecommendationStatus }): Recommendation[] {
    return this.recommendations.filter((r) =>
      (!filter?.orgId || r.orgId === filter.orgId) &&
      (!filter?.status || r.status === filter.status));
  }

  getInsights(filter?: { orgId?: string }): LearningInsight[] {
    return this.insights.filter((i) => !filter?.orgId || i.orgId === filter.orgId);
  }

  /** Review a recommendation (accept/reject). */
  reviewRecommendation(id: string, decision: 'accepted' | 'rejected', reviewer: string): Recommendation | undefined {
    const rec = this.recommendations.find((r) => r.id === id);
    if (!rec) return undefined;
    rec.status = decision;
    rec.reviewer = reviewer;
    rec.reviewedAt = Date.now();
    void this.api.bus.emit(LearningEvents.RecommendationReviewed, { id, decision, reviewer });
    return rec;
  }

  /** Mark a recommendation as deployed. */
  deployRecommendation(id: string): Recommendation | undefined {
    const rec = this.recommendations.find((r) => r.id === id);
    if (!rec || rec.status !== 'accepted') return undefined;
    rec.status = 'deployed';
    return rec;
  }

  // ---- personalization ---------------------------------------------------

  setPreference(userId: string, key: PreferenceKey, value: unknown, orgId?: string): void {
    this.personalization.setPreference(userId, key, value, orgId);
  }

  getPreference<T = unknown>(userId: string, key: PreferenceKey, defaultValue?: T): T | undefined {
    return this.personalization.getPreference(userId, key, defaultValue);
  }

  /** Derive + apply behavior-based adaptations for a user. */
  adapt(userId: string): AdaptationResult | undefined {
    const memory = this.tryMemory();
    if (!memory) return undefined;
    const events = memory.queryAll({ userId, limit: Number.POSITIVE_INFINITY });
    const result = this.personalization.adapt(userId, events);
    void this.api.bus.emit(LearningEvents.UserAdapted, { userId, navItems: result.navOrder.length, shortcuts: result.shortcutSuggestions.length });
    return result;
  }

  getProfile(userId: string) { return this.personalization.profile(userId); }

  // ---- internals ---------------------------------------------------------

  private tryMemory(): DigitalMemoryModule | undefined {
    try { return this.api.getModule<DigitalMemoryModule>('memory'); } catch { return undefined; }
  }
}

export { LearningEngine, PersonalizationEngine };
