// PersonalizationEngine — maintains per-user preference profiles and derives
// behavior-based adaptations (navigation order, search boosting, shortcut
// suggestions, widget placement, preferred AI model). Explicit user preferences
// always override derived ones. Respects memory/consent policies (the memory
// events it consumes are already governance-gated by the DME).

import type { MemoryEvent } from '@jataqi/memory';
import type { AdaptationResult, PreferenceKey, UserProfile } from './types.js';

export class PersonalizationEngine {
  private profiles = new Map<string, UserProfile>();

  /** Get or create a user profile. */
  profile(userId: string, orgId?: string): UserProfile {
    let p = this.profiles.get(userId);
    if (!p) {
      p = { userId, ...(orgId ? { orgId } : {}), preferences: new Map(), derived: new Map(), updatedAt: Date.now() };
      this.profiles.set(userId, p);
    }
    return p;
  }

  /** Set an explicit user preference (wins over derived). */
  setPreference(userId: string, key: PreferenceKey, value: unknown, orgId?: string): void {
    const p = this.profile(userId, orgId);
    p.preferences.set(key, value);
    p.updatedAt = Date.now();
  }

  /** Get the effective preference: explicit > derived > default. */
  getPreference<T = unknown>(userId: string, key: PreferenceKey, defaultValue?: T): T | undefined {
    const p = this.profiles.get(userId);
    if (!p) return defaultValue;
    return (p.preferences.get(key) ?? p.derived.get(key) ?? defaultValue) as T | undefined;
  }

  /** Derive behavior-based adaptations from the user's memory events. */
  derive(userId: string, events: MemoryEvent[]): AdaptationResult {
    const userEvents = events.filter((e) => e.userId === userId);

    // Navigation order (most-used targets first).
    const navCounts = new Map<string, number>();
    for (const e of userEvents) {
      if (e.category !== 'navigation') continue;
      const target = (e.data?.target as string) ?? e.summary;
      navCounts.set(target, (navCounts.get(target) ?? 0) + 1);
    }
    const navOrder = [...navCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);

    // Search boost terms (most-queried).
    const searchCounts = new Map<string, number>();
    for (const e of userEvents) {
      if (e.category !== 'search') continue;
      for (const token of e.tokens) searchCounts.set(token, (searchCounts.get(token) ?? 0) + 1);
    }
    const searchBoost = [...searchCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);

    // Shortcut suggestions (most frequent actions).
    const actionCounts = new Map<string, number>();
    for (const e of userEvents) {
      if (e.category !== 'command' && e.category !== 'feature_usage') continue;
      const action = (e.data?.action as string) ?? e.summary;
      actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
    }
    const shortcutSuggestions = [...actionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([action, frequency]) => ({ action, frequency }));

    // Widget suggestions (most-used widgets).
    const widgetCounts = new Map<string, number>();
    for (const e of userEvents) {
      if (e.category !== 'widget') continue;
      const widget = (e.data?.widget as string) ?? e.summary;
      widgetCounts.set(widget, (widgetCounts.get(widget) ?? 0) + 1);
    }
    const widgetSuggestions = [...widgetCounts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);

    // Preferred AI model (from accepted AI responses).
    const modelCounts = new Map<string, number>();
    for (const e of userEvents) {
      if (e.category !== 'ai_response' || e.data?.accepted !== true) continue;
      const model = (e.data?.model as string) ?? 'default';
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    }
    const preferredModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    return { userId, navOrder, searchBoost, shortcutSuggestions, widgetSuggestions, ...(preferredModel ? { preferredModel } : {}) };
  }

  /** Apply derived adaptations to a profile (as non-explicit overrides). */
  applyDerived(userId: string, adaptation: AdaptationResult): void {
    const p = this.profile(userId);
    if (adaptation.navOrder.length > 0) p.derived.set('navOrder', adaptation.navOrder);
    if (adaptation.searchBoost.length > 0) p.derived.set('searchBoost', adaptation.searchBoost);
    if (adaptation.preferredModel) p.derived.set('preferredModel', adaptation.preferredModel);
    p.updatedAt = Date.now();
  }

  /** Convenience: derive + apply in one call. */
  adapt(userId: string, events: MemoryEvent[]): AdaptationResult {
    const result = this.derive(userId, events);
    this.applyDerived(userId, result);
    return result;
  }

  listProfiles(): UserProfile[] { return [...this.profiles.values()]; }
  get size(): number { return this.profiles.size; }
}
