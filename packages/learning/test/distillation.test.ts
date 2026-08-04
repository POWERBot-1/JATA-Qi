// CLP Phase 5 — knowledge distillation tests: high-confidence insights and
// deployed recommendations become knowledge documents, graph lesson entities
// + triples, and operational playbooks. Distillation is idempotent and works
// with or without the knowledge/graph modules.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { DigitalMemoryModule } from '@jataqi/memory';
import { ContinuousLearningModule } from '../src/index.js';
import type { LearningInsight, Recommendation } from '../src/index.js';

function makeInsight(overrides: Partial<LearningInsight> = {}): LearningInsight {
  return {
    id: `ins-${Math.random().toString(36).slice(2)}`,
    kind: 'feature-adoption',
    title: 'High adoption of search',
    detail: '"search" accounts for 60% of activity.',
    evidence: { category: 'search', count: 60, share: 0.6 },
    confidence: 0.9,
    orgId: 'org1',
    generatedAt: Date.now(),
    ...overrides,
  };
}

function makeDeployedRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: `rec-${Math.random().toString(36).slice(2)}`,
    title: 'Surface search in the top nav',
    category: 'ui-improvement',
    rationale: 'Users search frequently; make it prominent.',
    actions: ['Add search to top nav', 'Increase search result limit'],
    impact: 'high',
    priority: 85,
    status: 'deployed',
    insightIds: [],
    orgId: 'org1',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('ContinuousLearningModule — knowledge distillation (CLP Phase 5)', () => {
  it('distills insights and deployed recommendations into knowledge + graph + playbooks', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    kernel.register(new DigitalMemoryModule());
    const mod = new ContinuousLearningModule();
    kernel.register(mod);
    await kernel.boot();
    try {
      // Drive insights + recommendations through the real module pipeline.
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      for (let i = 0; i < 20; i++) {
        await memory.record({ category: 'search', summary: `search query ${i}`, userId: 'u1', orgId: 'org1', sessionId: 's1' });
      }
      await mod.analyze('org1');
      // Deploy a recommendation so it is eligible for distillation.
      const recs = mod.getRecommendations({ orgId: 'org1', status: 'proposed' });
      assert.ok(recs.length > 0, 'expected at least one recommendation');
      mod.reviewRecommendation(recs[0]!.id, 'accepted', 'admin');
      mod.deployRecommendation(recs[0]!.id);

      const before = mod.distillStats();
      const run = await mod.distill('org1');
      assert.ok(run.lessons.length >= 1, 'expected distilled lessons');
      assert.ok(run.stats.lessons > before.lessons);

      // Knowledge documents were ingested (markdown, tagged as learning).
      const knowledge = kernel.getModule<KnowledgeService>('knowledge');
      const kstats = await knowledge.stats();
      assert.ok(kstats.documents >= 1);

      // Graph entities of type Lesson with derivation triples.
      const graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
      const lessons = graph.entitiesByType('Lesson');
      assert.ok(lessons.length >= 1);
      const triples = graph.allTriples();
      assert.ok(triples.some((t) => t.predicate === 'derived_from'));

      // Lessons are idempotent: re-distilling adds nothing new.
      const second = await mod.distill('org1');
      assert.equal(second.lessons.length, 0);
      assert.equal(mod.distillStats().lessons, run.stats.lessons);
    } finally {
      await kernel.shutdown();
    }
  });

  it('distills a deployed recommendation into an operational playbook', async () => {
    const kernel = createTestKernel();
    const mod = new ContinuousLearningModule();
    kernel.register(mod);
    await kernel.boot();
    try {
      const rec = makeDeployedRecommendation();
      const insight = makeInsight();
      const run = await mod.distillation.distill({
        insights: [insight],
        recommendations: [rec],
        orgId: 'org1',
      });
      assert.equal(run.playbooks.length, 1);
      const playbook = run.playbooks[0]!;
      assert.equal(playbook.category, 'ui-improvement');
      assert.deepEqual(playbook.steps, ['Add search to top nav', 'Increase search result limit']);
      assert.equal(playbook.lessonIds.length, 1);
      assert.equal(mod.getPlaybooks().length, 1);
      assert.equal(mod.getLessons().length, 2); // insight + recommendation
    } finally {
      await kernel.shutdown();
    }
  });

  it('skips low-confidence insights but keeps high-confidence ones', async () => {
    const kernel = createTestKernel();
    const mod = new ContinuousLearningModule();
    kernel.register(mod);
    await kernel.boot();
    try {
      const weak = makeInsight({ id: 'ins-weak', confidence: 0.2 });
      const strong = makeInsight({ id: 'ins-strong', confidence: 0.9 });
      await mod.distillation.distill({ insights: [weak, strong], recommendations: [], orgId: 'org1' });
      const lessons = mod.getLessons();
      assert.equal(lessons.length, 1);
      assert.equal(lessons[0]!.sourceId, 'ins-strong');
    } finally {
      await kernel.shutdown();
    }
  });
});
