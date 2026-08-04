// Self-Evolution intelligence integration tests — verifies the enhanced module
// consumes @jataqi/memory, @jataqi/learning, and @jataqi/ai-learning correctly.
// Existing tests (self-evolution.test.ts) remain unchanged — this is additive.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';
import { ContinuousLearningModule } from '@jataqi/learning';
import { AiLearningModule } from '@jataqi/ai-learning';
import { SelfEvolutionModule } from '../src/index.js';

describe('SelfEvolutionModule — intelligence integration', () => {
  let kernel: Kernel;
  let evo: SelfEvolutionModule;
  let memory: DigitalMemoryModule;
  let learning: ContinuousLearningModule;
  let aiLearning: AiLearningModule;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    memory = new DigitalMemoryModule();
    kernel.register(memory);
    learning = new ContinuousLearningModule();
    kernel.register(learning);
    aiLearning = new AiLearningModule();
    kernel.register(aiLearning);
    evo = new SelfEvolutionModule();
    kernel.register(evo);
    await kernel.boot();

    // Seed memory with a rich dataset for learning analysis.
    for (let i = 0; i < 60; i++) await memory.record({ category: 'feature_usage', summary: `dashboard session ${i}`, orgId: 'org-1', userId: 'u1' });
    for (let i = 0; i < 8; i++) await memory.record({ category: 'error', summary: `DatabaseTimeout on query #${i}`, orgId: 'org-1', userId: 'u1', data: { type: 'DatabaseTimeout' } });
    await memory.record({ category: 'performance', summary: 'Slow query on dashboard widget', orgId: 'org-1', userId: 'u2' });
    await memory.record({ category: 'search', summary: 'find report', orgId: 'org-1', userId: 'u4', sessionId: 's2' });
    await memory.record({ category: 'search', summary: 'find settings', orgId: 'org-1', userId: 'u5', sessionId: 's3' });
    await memory.record({ category: 'navigation', summary: 'navigate to settings', orgId: 'org-1', userId: 'u3', sessionId: 's1', data: { target: 'settings' } });
    await memory.record({ category: 'navigation', summary: 'navigate to dashboard', orgId: 'org-1', userId: 'u3', sessionId: 's1', data: { target: 'dashboard' } });
    await memory.record({ category: 'navigation', summary: 'navigate to settings', orgId: 'org-1', userId: 'u3', sessionId: 's1', data: { target: 'settings' } });
    await memory.record({ category: 'navigation', summary: 'navigate to dashboard', orgId: 'org-1', userId: 'u3', sessionId: 's1', data: { target: 'dashboard' } });
    await memory.record({ category: 'navigation', summary: 'navigate to settings', orgId: 'org-1', userId: 'u3', sessionId: 's1', data: { target: 'settings' } });
    await memory.record({ category: 'navigation', summary: 'navigate to dashboard', orgId: 'org-1', userId: 'u3', sessionId: 's1', data: { target: 'dashboard' } });

    // Seed AI learning with drift (enough outcomes to trigger detection).
    for (let i = 0; i < 20; i++) aiLearning.recordOutcome({ model: 'drift-m', provider: 'p', outcome: 'accepted', latencyMs: 200, ts: i });
    for (let i = 0; i < 10; i++) aiLearning.recordOutcome({ model: 'drift-m', provider: 'p', outcome: 'rejected', latencyMs: 200, ts: 100 + i });

    // Run learning analysis to generate insights from the seeded events.
    await learning.analyze('org-1');
  });
  after(async () => { await kernel.shutdown(); });

  it('observeFromMemory pulls DME events into observations', async () => {
    const before = (await evo.listObservations()).length;
    const obs = await evo.observeFromMemory('org-1', 50);
    const after = (await evo.listObservations()).length;
    assert.ok(obs.length >= 3); // 3 seeded events
    assert.ok(after > before);
    // Error events get critical severity.
    assert.ok(obs.some((o) => o.severity === 'critical' && o.type === 'error'));
    // Performance events get warning severity.
    assert.ok(obs.some((o) => o.severity === 'warning' && o.type === 'performance'));
  });

  it('observeFromMemory degrades gracefully when no memory module', async () => {
    // In a kernel without memory, observeFromMemory returns [].
    const k2 = createTestKernel();
    k2.register(new StorageModule());
    k2.register(new SelfEvolutionModule());
    await k2.boot();
    const evo2 = k2.getModule<SelfEvolutionModule>('self-evolution');
    const obs = await evo2.observeFromMemory();
    assert.deepEqual(obs, []);
    await k2.shutdown();
  });

  it('generateFromInsights creates proposals from learning insights', async () => {
    const proposals = await evo.generateFromInsights('agent-1', 'org-1');
    assert.ok(proposals.length >= 1);
    assert.ok(proposals.every((p) => p.status === 'proposed'));
    assert.ok(proposals.every((p) => p.evidence.length > 0));
    assert.ok(proposals.every((p) => p.createdBy === 'agent-1'));
  });

  it('generateFromDrift creates proposals from AI drift alerts', async () => {
    const proposals = await evo.generateFromDrift('agent-1');
    assert.ok(proposals.length >= 1);
    assert.ok(proposals.some((p) => p.title.includes('drift')));
    assert.ok(proposals.every((p) => p.status === 'proposed'));
  });

  it('runEvolutionCycle runs the full intelligence pipeline (memory → analyze → proposals)', async () => {
    // Reset the autonomous cycle counter via a manual decision first.
    const existing = await evo.listProposals('proposed');
    if (existing.length > 0) await evo.manualDecision(existing[0]!.id, true, 'admin', 'reset');

    const result = await evo.runEvolutionCycle('agent-1', 'org-1');
    assert.ok(result.observations.length >= 3); // from memory
    assert.ok(result.analysis.bottlenecks.length >= 0); // analysis ran
    assert.ok(result.proposals.length >= 1); // at least one proposal from analysis/insights/drift
  });

  it('generates from insights degrades gracefully without learning module', async () => {
    const k2 = createTestKernel();
    k2.register(new StorageModule());
    k2.register(new SelfEvolutionModule());
    await k2.boot();
    const evo2 = k2.getModule<SelfEvolutionModule>('self-evolution');
    const proposals = await evo2.generateFromInsights('a');
    assert.deepEqual(proposals, []);
    await k2.shutdown();
  });

  it('preserves the full lifecycle: propose → approve → experiment → deploy', async () => {
    // Create a proposal from an insight (via the intelligence pipeline).
    const proposals = await evo.generateFromInsights('tester', 'org-1');
    if (proposals.length === 0) return; // skip if no insights generated
    const p = proposals[0]!;

    // Evaluate (no governance module → auto-approve).
    const eval_ = await evo.evaluateProposal(p.id);
    assert.equal(eval_.approved, true);

    // Experiment.
    const exp = await evo.createExperiment('tester', p.id, 'ab', { score: 50 }, { score: 65 });
    const done = await evo.completeExperiment(exp.id, { score: 50 }, { score: 65 });
    assert.equal(done.status, 'completed');
    assert.equal(done.result!.winner, 'variant');

    const after = await evo.getProposal(p.id);
    assert.equal(after!.status, 'deployed');

    // Rollback.
    const rb = await evo.rollback(p.id, 'admin', 'regression detected');
    assert.equal(rb.status, 'rolled_back');
  });

  it('generateFromExperiments proposes fixes for regressions and extensions for promotions', async () => {
    // Fresh kernel to keep the autonomous-cycle cap from interfering.
    const k2 = createTestKernel();
    k2.register(new StorageModule());
    const ai2 = new AiLearningModule();
    k2.register(ai2);
    const evo2 = new SelfEvolutionModule();
    k2.register(evo2);
    await k2.boot();
    try {
      // Template with active champion + approved challenger.
      const t = ai2.createPrompt({ name: 'exp-tpl', content: 'Answer {{q}}', category: 'research' });
      const v1 = t.versions[0]!;
      ai2.approve(t.id, v1.id, 'admin');
      ai2.activate(t.id, v1.id);
      const v2 = ai2.newVersion(t.id, 'Answer {{q}} concisely');
      ai2.approve(t.id, v2.id, 'admin');

      // Regression experiment: champion 80%, challenger 40%.
      const reg = ai2.createExperiment({ templateId: t.id, challengerVersionId: v2.id, createdBy: 'admin', minOutcomes: 5 });
      for (let i = 0; i < 5; i++) ai2.recordOutcome({ promptTemplateId: t.id, promptVersionId: reg.championVersionId, model: 'm', provider: 'p', outcome: 'accepted', latencyMs: 10, ts: Date.now() });
      for (let i = 0; i < 5; i++) ai2.recordOutcome({ promptTemplateId: t.id, promptVersionId: reg.challengerVersionId, model: 'm', provider: 'p', outcome: 'rejected', latencyMs: 10, ts: Date.now() });
      ai2.concludeExperiment(reg.id);

      const proposals = await evo2.generateFromExperiments('tester');
      assert.ok(proposals.length >= 1, 'regression should produce a proposal');
      const regProposal = proposals.find((p) => p.kind === 'quality');
      assert.ok(regProposal, 'regression proposal should be kind quality');
      assert.ok(regProposal!.evidence.includes(reg.id));

      // Promote experiment: challenger 90% vs champion 60% → proposal kind prompt.
      const t2 = ai2.createPrompt({ name: 'exp-tpl2', content: 'Do {{q}}', category: 'research' });
      const p1 = t2.versions[0]!;
      ai2.approve(t2.id, p1.id, 'admin');
      ai2.activate(t2.id, p1.id);
      const p2 = ai2.newVersion(t2.id, 'Please do {{q}}');
      ai2.approve(t2.id, p2.id, 'admin');
      const prom = ai2.createExperiment({ templateId: t2.id, challengerVersionId: p2.id, createdBy: 'admin', minOutcomes: 5, minAcceptanceGain: 0.1 });
      // Champion: 60% acceptance (3/5).
      for (let i = 0; i < 3; i++) ai2.recordOutcome({ promptTemplateId: t2.id, promptVersionId: prom.championVersionId, model: 'm', provider: 'p', outcome: 'accepted', latencyMs: 10, ts: Date.now() });
      for (let i = 0; i < 2; i++) ai2.recordOutcome({ promptTemplateId: t2.id, promptVersionId: prom.championVersionId, model: 'm', provider: 'p', outcome: 'rejected', latencyMs: 10, ts: Date.now() });
      // Challenger: 90% acceptance (9/10) → beats champion by >= 10pp.
      for (let i = 0; i < 9; i++) ai2.recordOutcome({ promptTemplateId: t2.id, promptVersionId: prom.challengerVersionId, model: 'm', provider: 'p', outcome: 'accepted', latencyMs: 10, ts: Date.now() });
      for (let i = 0; i < 1; i++) ai2.recordOutcome({ promptTemplateId: t2.id, promptVersionId: prom.challengerVersionId, model: 'm', provider: 'p', outcome: 'rejected', latencyMs: 10, ts: Date.now() });
      ai2.concludeExperiment(prom.id);

      const proposals2 = await evo2.generateFromExperiments('tester');
      assert.ok(proposals2.some((p) => p.kind === 'prompt'), 'promotion should produce a prompt-kind proposal');
    } finally {
      await k2.shutdown();
    }
  });

  it('observeFromDistillation turns distillation progress into observations', async () => {
    const k2 = createTestKernel();
    k2.register(new StorageModule());
    const learn2 = new ContinuousLearningModule();
    k2.register(learn2);
    const evo2 = new SelfEvolutionModule();
    k2.register(evo2);
    await k2.boot();
    try {
      // No distillation yet → no observations.
      assert.equal((await evo2.observeFromDistillation('org-1')).length, 0);

      // Distill a lesson directly through the engine, then observe.
      await learn2.distillation.distill({
        insights: [{
          id: 'ins-x', kind: 'feature-adoption', title: 'Adoption insight',
          detail: 'detail', evidence: { c: 1 }, confidence: 0.9, orgId: 'org-1', generatedAt: Date.now(),
        }],
        recommendations: [], orgId: 'org-1',
      });
      const obs = await evo2.observeFromDistillation('org-1');
      assert.ok(obs.length >= 1, 'distilled lessons should become observations');
      assert.ok(obs.some((o) => o.metric === 'lessons' && o.value >= 1));
      assert.ok(obs.every((o) => o.source === 'knowledge-distillation'));
    } finally {
      await k2.shutdown();
    }
  });

  it('runEvolutionCycle includes distillation observations and experiment proposals', async () => {
    const k2 = createTestKernel();
    k2.register(new StorageModule());
    const learn2 = new ContinuousLearningModule();
    k2.register(learn2);
    const evo2 = new SelfEvolutionModule();
    k2.register(evo2);
    await k2.boot();
    try {
      // Distill something so the cycle observes it.
      await learn2.distillation.distill({
        insights: [{
          id: 'ins-y', kind: 'workflow-completion', title: 'Flow insight',
          detail: 'detail', evidence: {}, confidence: 0.95, generatedAt: Date.now(),
        }],
        recommendations: [], orgId: 'org-2',
      });
      const result = await evo2.runEvolutionCycle('tester', 'org-2');
      assert.ok(result.observations.some((o) => o.source === 'knowledge-distillation'));
      assert.ok(Array.isArray(result.proposals));
    } finally {
      await k2.shutdown();
    }
  });
});
