// CLP Phase 4 — eval-gated prompt experimentation tests: champion/challenger
// experiments, traffic-split serving, evidence-based promotion, conservative
// keep/regression decisions, and insufficient-data handling.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { AiLearningModule } from '../src/index.js';
import type { PromptExperiment } from '../src/index.js';

async function setup() {
  const kernel = createTestKernel();
  const mod = new AiLearningModule();
  kernel.register(mod);
  await kernel.boot();
  return { kernel, mod };
}

/** Create a template with an active v1 and an approved challenger v2. */
function seedTemplate(mod: AiLearningModule, name = 'tpl') {
  const t = mod.createPrompt({ name, content: 'Summarize {{topic}}', category: 'research' });
  const v1 = t.versions[0]!;
  mod.approve(t.id, v1.id, 'admin');
  mod.activate(t.id, v1.id);
  const v2 = mod.newVersion(t.id, 'Please summarize {{topic}} in detail', 'candidate');
  mod.approve(t.id, v2.id, 'admin');
  return { template: t, champion: v1, challenger: v2 };
}

/** Record `total` outcomes against a version; exactly `accepted` are accepted. */
function recordOutcomes(mod: AiLearningModule, templateId: string, versionId: string, total: number, accepted: number) {
  for (let i = 0; i < total; i++) {
    const isAccepted = i < accepted;
    mod.recordOutcome({
      promptTemplateId: templateId,
      promptVersionId: versionId,
      model: 'test-model',
      provider: 'test',
      outcome: isAccepted ? 'accepted' : 'rejected',
      rating: isAccepted ? 5 : 1,
      latencyMs: 100,
      ts: Date.now() + i,
    });
  }
}

describe('AiLearningModule — prompt experiments (CLP Phase 4)', () => {
  it('creates a champion/challenger experiment and lists it', async () => {
    const { kernel, mod } = await setup();
    try {
      const { template, champion, challenger } = seedTemplate(mod);
      const ex = mod.createExperiment({ templateId: template.id, challengerVersionId: challenger.id, createdBy: 'admin' });
      assert.equal(ex.championVersionId, champion.id);
      assert.equal(ex.challengerVersionId, challenger.id);
      assert.equal(ex.status, 'running');
      assert.equal(ex.challengerTraffic, 0.5);
      assert.equal(ex.minOutcomes, 10);
      assert.equal(ex.minAcceptanceGain, 0.03);
      assert.equal(mod.listExperiments('running').length, 1);
      assert.equal(mod.getExperiment(ex.id)?.id, ex.id);
    } finally {
      await kernel.shutdown();
    }
  });

  it('rejects a challenger that is not approved yet', async () => {
    const { kernel, mod } = await setup();
    try {
      const t = mod.createPrompt({ name: 't2', content: 'x {{y}}', category: 'research' });
      const v1 = t.versions[0]!;
      mod.approve(t.id, v1.id, 'admin');
      mod.activate(t.id, v1.id);
      const v2 = mod.newVersion(t.id, 'y {{y}}');
      assert.throws(() => mod.createExperiment({ templateId: t.id, challengerVersionId: v2.id, createdBy: 'admin' }), /approved/);
    } finally {
      await kernel.shutdown();
    }
  });

  it('serves traffic split between champion and challenger', async () => {
    const { kernel, mod } = await setup();
    try {
      const { template, challenger } = seedTemplate(mod);
      mod.createExperiment({ templateId: template.id, challengerVersionId: challenger.id, createdBy: 'admin', challengerTraffic: 1 });
      const served = mod.servePrompt(template.id, { topic: 'Q3' });
      assert.equal('variant' in served && served.variant, 'challenger');
      assert.equal('text' in served && served.text, 'Please summarize Q3 in detail');
      // Fallback: once the experiment concludes, the active version renders.
      mod.concludeExperiment(mod.listExperiments('running')[0]!.id);
      const fallback = mod.servePrompt(template.id, { topic: 'Q3' });
      assert.ok(!('variant' in fallback));
      assert.equal(fallback.text, 'Summarize Q3');
    } finally {
      await kernel.shutdown();
    }
  });

  it('promotes the challenger when acceptance improves by the required margin', async () => {
    const { kernel, mod } = await setup();
    try {
      const { template, challenger } = seedTemplate(mod);
      const ex = mod.createExperiment({ templateId: template.id, challengerVersionId: challenger.id, createdBy: 'admin', minOutcomes: 5, minAcceptanceGain: 0.05 });
      recordOutcomes(mod, template.id, ex.championVersionId, 10, 6);
      recordOutcomes(mod, template.id, ex.challengerVersionId, 10, 9);
      const evaluation = mod.evaluateExperiment(ex.id);
      assert.equal(evaluation.decision, 'promote');
      assert.equal(evaluation.promoted, true);
      // The challenger is now the active version.
      assert.equal(mod.getPrompt(template.id)?.activeVersionId, challenger.id);
      const concluded = mod.concludeExperiment(ex.id);
      assert.equal(concluded.status, 'concluded');
      assert.equal(concluded.decision, 'promote');
    } finally {
      await kernel.shutdown();
    }
  });

  it('keeps the champion when the challenger is not measurably better', async () => {
    const { kernel, mod } = await setup();
    try {
      const { template, champion, challenger } = seedTemplate(mod);
      const ex = mod.createExperiment({ templateId: template.id, challengerVersionId: challenger.id, createdBy: 'admin', minOutcomes: 5, minAcceptanceGain: 0.1 });
      recordOutcomes(mod, template.id, ex.championVersionId, 10, 7);
      recordOutcomes(mod, template.id, ex.challengerVersionId, 10, 7); // equal acceptance: no measurable gain
      const evaluation = mod.evaluateExperiment(ex.id);
      assert.equal(evaluation.decision, 'keep');
      assert.equal(evaluation.promoted, false);
      assert.equal(mod.getPrompt(template.id)?.activeVersionId, champion.id);
    } finally {
      await kernel.shutdown();
    }
  });

  it('flags regression when the challenger acceptance drops', async () => {
    const { kernel, mod } = await setup();
    try {
      const { template, champion, challenger } = seedTemplate(mod);
      const ex = mod.createExperiment({ templateId: template.id, challengerVersionId: challenger.id, createdBy: 'admin', minOutcomes: 5, minAcceptanceGain: 0.03 });
      recordOutcomes(mod, template.id, ex.championVersionId, 10, 8);
      recordOutcomes(mod, template.id, ex.challengerVersionId, 10, 4);
      const evaluation = mod.evaluateExperiment(ex.id);
      assert.equal(evaluation.decision, 'regression');
      assert.equal(mod.getPrompt(template.id)?.activeVersionId, champion.id);
    } finally {
      await kernel.shutdown();
    }
  });

  it('returns insufficient-data before the minimum outcome count is reached', async () => {
    const { kernel, mod } = await setup();
    try {
      const { template, champion, challenger } = seedTemplate(mod);
      const ex = mod.createExperiment({ templateId: template.id, challengerVersionId: challenger.id, createdBy: 'admin', minOutcomes: 20 });
      recordOutcomes(mod, template.id, ex.championVersionId, 3, 1);
      recordOutcomes(mod, template.id, ex.challengerVersionId, 3, 1);
      const evaluation = mod.evaluateExperiment(ex.id);
      assert.equal(evaluation.decision, 'insufficient-data');
      assert.equal(mod.getPrompt(template.id)?.activeVersionId, champion.id);
    } finally {
      await kernel.shutdown();
    }
  });

  it('cancels a running experiment without promoting', async () => {
    const { kernel, mod } = await setup();
    try {
      const { template, champion, challenger } = seedTemplate(mod);
      const ex = mod.createExperiment({ templateId: template.id, challengerVersionId: challenger.id, createdBy: 'admin' });
      const cancelled = mod.cancelExperiment(ex.id);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(mod.getPrompt(template.id)?.activeVersionId, champion.id);
    } finally {
      await kernel.shutdown();
    }
  });
});
