// Continuous Learning + Personalization tests — insight generation, governed
// recommendations, behavior-derived adaptation, and full module integration.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';
import type { MemoryEvent } from '@jataqi/memory';
import { LearningEngine, PersonalizationEngine, ContinuousLearningModule, LearningEvents } from '../src/index.js';

const DAY = 86_400_000;
const now = Date.now();

// Synthetic events for analysis.
function events(): MemoryEvent[] {
  const out: MemoryEvent[] = [];
  // Feature usage: 'dashboard' is very popular; 'reports' is not.
  for (let i = 0; i < 60; i++) out.push(mkEvent('feature_usage', `dashboard session ${i}`, 'org-1', 'u1'));
  for (let i = 0; i < 2; i++) out.push(mkEvent('feature_usage', `reports view ${i}`, 'org-1', 'u2'));
  // Navigation backtracking in a session.
  out.push(mkNav('settings', 'org-1', 'u3', 's1'));
  out.push(mkNav('dashboard', 'org-1', 'u3', 's1'));
  out.push(mkNav('settings', 'org-1', 'u3', 's1'));
  out.push(mkNav('dashboard', 'org-1', 'u3', 's1'));
  out.push(mkNav('settings', 'org-1', 'u3', 's1'));
  out.push(mkNav('dashboard', 'org-1', 'u3', 's1'));
  // Errors.
  for (let i = 0; i < 8; i++) out.push(mkEvent('error', `DatabaseTimeout on query #${i}`, 'org-1', 'u1', { type: 'DatabaseTimeout' }));
  // Workflow abandonment.
  for (let i = 0; i < 6; i++) out.push(mkEvent('workflow', `wf-${i}`, 'org-1', 'u1', { status: 'abandoned' }));
  for (let i = 0; i < 2; i++) out.push(mkEvent('workflow', `wf-ok-${i}`, 'org-1', 'u1', { status: 'completed' }));
  // Search failures (no follow-up).
  out.push(mkEvent('search', 'find report', 'org-1', 'u4', undefined, 's2'));
  out.push(mkEvent('search', 'find settings', 'org-1', 'u5', undefined, 's3'));
  return out;
}

function mkEvent(cat: string, summary: string, orgId: string, userId: string, data?: Record<string, unknown>, sessionId?: string): MemoryEvent {
  return {
    id: `e-${Math.random()}`, category: cat, ts: now, orgId, userId,
    ...(sessionId ? { sessionId } : {}), summary,
    ...(data ? { data } : {}), sensitivity: 'internal', version: 1, hash: Math.random().toString(),
    tokens: summary.toLowerCase().split(/\W+/).filter((t) => t.length > 2), createdAt: now,
  };
}
function mkNav(target: string, orgId: string, userId: string, sessionId: string): MemoryEvent {
  return mkEvent('navigation', `navigate to ${target}`, orgId, userId, { target }, sessionId);
}

describe('LearningEngine — analysis', () => {
  const e = events();

  it('detects feature adoption (high + low)', () => {
    const eng = new LearningEngine();
    const { insights } = eng.analyze(e, 'org-1');
    const adoption = insights.find((i) => i.kind === 'feature-adoption');
    const decline = insights.find((i) => i.kind === 'feature-decline');
    assert.ok(adoption, 'should detect high adoption');
    assert.ok(decline, 'should detect low adoption');
    assert.equal(adoption!.evidence.category, 'feature_usage');
  });

  it('detects error frequency', () => {
    const eng = new LearningEngine();
    const { insights } = eng.analyze(e, 'org-1');
    const errors = insights.find((i) => i.kind === 'error-frequency');
    assert.ok(errors);
    assert.equal(errors!.evidence.errorType, 'DatabaseTimeout');
  });

  it('detects workflow abandonment', () => {
    const eng = new LearningEngine();
    const { insights } = eng.analyze(e, 'org-1');
    const abandon = insights.find((i) => i.kind === 'workflow-abandonment');
    assert.ok(abandon);
    const ev = abandon!.evidence as { abandoned: number; completed: number };
    assert.ok(ev.abandoned > ev.completed);
  });

  it('detects UI friction (navigation backtracking)', () => {
    const eng = new LearningEngine();
    const { insights } = eng.analyze(e, 'org-1');
    const friction = insights.find((i) => i.kind === 'ui-friction');
    assert.ok(friction);
  });

  it('detects search failures', () => {
    const eng = new LearningEngine();
    const { insights } = eng.analyze(e, 'org-1');
    const searchFail = insights.find((i) => i.kind === 'search-failure');
    assert.ok(searchFail);
  });
});

describe('LearningEngine — recommendations', () => {
  it('maps insights to governed recommendations', () => {
    const eng = new LearningEngine();
    const { insights } = eng.analyze(events(), 'org-1');
    const recs = eng.generateRecommendations(insights);
    assert.ok(recs.length > 0);
    assert.ok(recs.every((r) => r.status === 'proposed'));
    assert.ok(recs.some((r) => r.actions.length > 0));
    // Error insight → performance recommendation.
    assert.ok(recs.some((r) => r.category === 'performance'));
    // Workflow abandonment → workflow-optimization.
    assert.ok(recs.some((r) => r.category === 'workflow-optimization'));
  });
});

describe('PersonalizationEngine — profiles + adaptation', () => {
  it('stores explicit preferences and respects them over derived', () => {
    const pe = new PersonalizationEngine();
    pe.setPreference('u1', 'theme', 'dark');
    assert.equal(pe.getPreference('u1', 'theme'), 'dark');
    // Derived value shouldn't override explicit.
    pe.applyDerived('u1', { userId: 'u1', navOrder: ['settings'], searchBoost: [], shortcutSuggestions: [], widgetSuggestions: [], preferredModel: 'gpt-4' });
    pe.setPreference('u1', 'preferredModel', 'claude');
    assert.equal(pe.getPreference('u1', 'preferredModel'), 'claude'); // explicit wins
  });

  it('derives nav order + shortcuts from behavior', () => {
    const pe = new PersonalizationEngine();
    const evs: MemoryEvent[] = [];
    for (let i = 0; i < 10; i++) evs.push(mkNav('dashboard', 'O', 'u1', 's'));
    for (let i = 0; i < 3; i++) evs.push(mkNav('settings', 'O', 'u1', 's'));
    for (let i = 0; i < 5; i++) evs.push(mkEvent('command', 'save document', 'O', 'u1', { action: 'save' }));
    const adapt = pe.derive('u1', evs);
    assert.equal(adapt.navOrder[0], 'dashboard'); // most-used first
    assert.equal(adapt.navOrder[1], 'settings');
    assert.ok(adapt.shortcutSuggestions.some((s) => s.action.includes('save')));
  });
});

describe('ContinuousLearningModule — integration with memory', () => {
  let kernel: ReturnType<typeof createTestKernel>;
  let mod: ContinuousLearningModule;
  let memory: DigitalMemoryModule;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    memory = new DigitalMemoryModule();
    kernel.register(memory);
    mod = new ContinuousLearningModule();
    kernel.register(mod);
    await kernel.boot();
    // Seed memory with events.
    for (const e of events()) await memory.record({
      category: e.category as never, summary: e.summary, orgId: 'org-1', userId: e.userId,
      ...(e.sessionId ? { sessionId: e.sessionId } : {}), ...(e.data ? { data: e.data } : {}),
    });
  });
  after(async () => { await kernel.shutdown(); });

  it('analyzes memory events and produces insights + recommendations', async () => {
    let proposed = 0;
    kernel.bus.on(LearningEvents.RecommendationProposed, () => { proposed++; });
    const result = await mod.analyze('org-1');
    assert.ok(result.insights.length > 0);
    assert.ok(result.recommendations.length > 0);
    assert.ok(result.summary.totalEvents > 0);
    await new Promise((r) => setImmediate(r));
    assert.ok(proposed > 0);
  });

  it('reviews and deploys a recommendation', () => {
    const rec = mod.getRecommendations({ status: 'proposed' })[0]!;
    mod.reviewRecommendation(rec.id, 'accepted', 'admin');
    assert.equal(mod.getRecommendations({ status: 'accepted' }).length >= 1, true);
    mod.deployRecommendation(rec.id);
    assert.equal(rec.status, 'deployed');
  });

  it('adapts a user from their memory events', async () => {
    // Record some navigation for a user.
    await memory.record({ category: 'navigation', summary: 'navigate to dashboard', orgId: 'org-1', userId: 'u1', sessionId: 's', data: { target: 'dashboard' } });
    const adapt = mod.adapt('u1');
    assert.ok(adapt);
    assert.ok(adapt!.navOrder.includes('dashboard'));
  });

  it('respects explicit preferences', () => {
    mod.setPreference('u1', 'theme', 'light');
    assert.equal(mod.getPreference('u1', 'theme'), 'light');
  });
});
