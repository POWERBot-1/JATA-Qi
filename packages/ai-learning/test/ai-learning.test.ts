// AI Learning Platform tests — prompt registry lifecycle, quality tracking,
// drift detection, model benchmarking, and kernel integration.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';
import {
  AiLearningModule, AiLearningEvents, PromptRegistry, QualityTracker, DriftDetector, extractVariables,
} from '../src/index.js';

const now = Date.now();

describe('PromptRegistry — lifecycle', () => {
  it('creates a template with a draft v1 and extracts variables', () => {
    const reg = new PromptRegistry();
    const t = reg.create({ name: 'Summary', category: 'chat', content: 'Summarize: {{text}} in {{language}}' });
    assert.equal(t.versions.length, 1);
    assert.equal(t.versions[0]!.status, 'draft');
    assert.deepEqual(t.versions[0]!.variables, ['language', 'text']);
  });

  it('progresses draft → reviewed → active → deprecated', () => {
    const reg = new PromptRegistry();
    const t = reg.create({ name: 'Code Review', category: 'code', content: 'Review: {{code}}' });
    const v1 = t.versions[0]!;
    reg.approve(t.id, v1.id, 'admin');
    assert.equal(reg.get(t.id)!.versions[0]!.status, 'reviewed');
    reg.activate(t.id, v1.id);
    assert.equal(reg.getActive(t.id)!.id, v1.id);
    // New version deprecates v1 on activation.
    const v2 = reg.newVersion(t.id, 'Improved review: {{code}}', 'better prompt');
    reg.approve(t.id, v2.id, 'admin');
    reg.activate(t.id, v2.id);
    assert.equal(reg.getActive(t.id)!.id, v2.id);
    assert.equal(reg.get(t.id)!.versions[0]!.status, 'deprecated'); // v1 deprecated
  });

  it('renders the active version with variables resolved', () => {
    const reg = new PromptRegistry();
    const t = reg.create({ name: 'Test', category: 'chat', content: 'Hello {{name}}, your score is {{score}}' });
    reg.approve(t.id, t.versions[0]!.id, 'admin');
    reg.activate(t.id, t.versions[0]!.id);
    const rendered = reg.render(t.id, { name: 'Alice', score: '95' });
    assert.equal(rendered, 'Hello Alice, your score is 95');
  });

  it('refuses activation without approval', () => {
    const reg = new PromptRegistry();
    const t = reg.create({ name: 'X', category: 'chat', content: 'x' });
    assert.throws(() => reg.activate(t.id, t.versions[0]!.id));
  });
});

describe('extractVariables', () => {
  it('extracts unique mustache variables', () => {
    assert.deepEqual(extractVariables('Hello {{name}}, {{name}} is {{age}}'), ['age', 'name']);
    assert.deepEqual(extractVariables('no vars here'), []);
  });
});

describe('QualityTracker — metrics + benchmarking', () => {
  it('records outcomes and computes quality metrics', () => {
    const qt = new QualityTracker();
    qt.record({ model: 'gpt-4', provider: 'openai', outcome: 'accepted', rating: 5, latencyMs: 800, costUsd: 0.02, ts: now });
    qt.record({ model: 'gpt-4', provider: 'openai', outcome: 'accepted', rating: 4, latencyMs: 900, costUsd: 0.02, ts: now });
    qt.record({ model: 'gpt-4', provider: 'openai', outcome: 'rejected', rating: 1, latencyMs: 1200, costUsd: 0.03, ts: now });
    const m = qt.modelMetrics('gpt-4');
    assert.equal(m.total, 3);
    assert.equal(m.accepted, 2);
    assert.ok(Math.abs(m.acceptanceRate - 0.667) < 0.01);
    assert.ok(m.avgRating > 3); // (5+4+1)/3
    assert.ok(m.avgLatencyMs > 900);
  });

  it('benchmarks multiple models ranked by acceptance', () => {
    const qt = new QualityTracker();
    for (let i = 0; i < 10; i++) qt.record({ model: 'claude', provider: 'anthropic', outcome: 'accepted', latencyMs: 600, ts: now });
    for (let i = 0; i < 5; i++) qt.record({ model: 'gpt-4', provider: 'openai', outcome: 'accepted', latencyMs: 900, ts: now });
    for (let i = 0; i < 5; i++) qt.record({ model: 'gpt-4', provider: 'openai', outcome: 'rejected', latencyMs: 1000, ts: now });
    const benchmarks = qt.modelBenchmarks();
    assert.equal(benchmarks[0]!.model, 'claude'); // 100% acceptance > 50%
    assert.ok(benchmarks[0]!.metrics.acceptanceRate >= benchmarks[1]!.metrics.acceptanceRate);
  });

  it('computes p50/p95 latency percentiles', () => {
    const qt = new QualityTracker();
    for (let i = 1; i <= 20; i++) qt.record({ model: 'm', provider: 'p', outcome: 'accepted', latencyMs: i * 100, ts: now });
    const b = qt.modelBenchmarks()[0]!;
    assert.ok(b.p50Latency >= 900 && b.p50Latency <= 1100);
    assert.ok(b.p95Latency >= 1800);
  });
});

describe('DriftDetector — quality degradation', () => {
  it('fires a warning when acceptance rate drops', () => {
    const dd = new DriftDetector({ minSamples: 10, windowSize: 5, warningThreshold: 0.15 });
    const outcomes = [];
    // Baseline: high acceptance.
    for (let i = 0; i < 15; i++) outcomes.push({ id: `e${i}`, model: 'm', provider: 'p', outcome: 'accepted' as const, latencyMs: 500, ts: i });
    // Recent: poor acceptance.
    for (let i = 0; i < 5; i++) outcomes.push({ id: `r${i}`, model: 'm', provider: 'p', outcome: 'rejected' as const, latencyMs: 500, ts: 100 + i });
    const alerts = dd.detect('template-1', outcomes);
    assert.ok(alerts.length > 0);
    assert.ok(alerts.some((a) => a.metric === 'acceptanceRate'));
    assert.ok(alerts[0]!.severity === 'warning' || alerts[0]!.severity === 'critical');
  });

  it('fires a critical when acceptance drops drastically', () => {
    const dd = new DriftDetector({ minSamples: 10, windowSize: 5, criticalThreshold: 0.3 });
    const outcomes = [];
    for (let i = 0; i < 15; i++) outcomes.push({ id: `e${i}`, model: 'm', provider: 'p', outcome: 'accepted' as const, latencyMs: 500, ts: i });
    for (let i = 0; i < 5; i++) outcomes.push({ id: `r${i}`, model: 'm', provider: 'p', outcome: 'rejected' as const, latencyMs: 500, ts: 100 + i });
    const alerts = dd.detect('scope', outcomes);
    assert.ok(alerts.some((a) => a.severity === 'critical'));
  });

  it('detects latency spikes', () => {
    const dd = new DriftDetector({ minSamples: 10, windowSize: 5, warningThreshold: 0.2 });
    const outcomes = [];
    for (let i = 0; i < 15; i++) outcomes.push({ id: `e${i}`, model: 'm', provider: 'p', outcome: 'accepted' as const, latencyMs: 200, ts: i });
    for (let i = 0; i < 5; i++) outcomes.push({ id: `r${i}`, model: 'm', provider: 'p', outcome: 'accepted' as const, latencyMs: 2000, ts: 100 + i });
    const alerts = dd.detect('scope', outcomes);
    assert.ok(alerts.some((a) => a.metric === 'avgLatencyMs'));
  });

  it('returns no alerts when quality is stable', () => {
    const dd = new DriftDetector({ minSamples: 10, windowSize: 5 });
    const outcomes = [];
    for (let i = 0; i < 20; i++) outcomes.push({ id: `e${i}`, model: 'm', provider: 'p', outcome: 'accepted' as const, latencyMs: 500, ts: i });
    assert.equal(dd.detect('scope', outcomes).length, 0);
  });
});

describe('AiLearningModule — kernel integration', () => {
  let kernel: ReturnType<typeof createTestKernel>;
  let mod: AiLearningModule;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    mod = new AiLearningModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('creates and activates a prompt through the module', () => {
    let activated = false;
    kernel.bus.on(AiLearningEvents.PromptActivated, () => { activated = true; });
    const t = mod.createPrompt({ name: 'Greet', category: 'chat', content: 'Hi {{name}}' });
    mod.approve(t.id, t.versions[0]!.id, 'admin');
    mod.activate(t.id, t.versions[0]!.id);
    assert.equal(activated, true);
    assert.equal(mod.render(t.id, { name: 'Bob' }), 'Hi Bob');
  });

  it('records outcomes, computes metrics, and benchmarks', () => {
    let recorded = false;
    kernel.bus.on(AiLearningEvents.QualityRecorded, () => { recorded = true; });
    mod.recordOutcome({ model: 'test-model', provider: 'test', outcome: 'accepted', rating: 5, latencyMs: 100, ts: now });
    mod.recordOutcome({ model: 'test-model', provider: 'test', outcome: 'rejected', rating: 1, latencyMs: 200, ts: now });
    const m = mod.modelMetrics('test-model');
    assert.equal(m.total, 2);
    assert.ok(mod.modelBenchmarks().length > 0);
    assert.equal(recorded, true);
  });

  it('detects drift and emits alerts', () => {
    // Seed enough outcomes to trigger drift detection.
    for (let i = 0; i < 20; i++) mod.recordOutcome({ model: 'drift-model', provider: 'p', outcome: 'accepted', latencyMs: 300, ts: i });
    for (let i = 0; i < 10; i++) mod.recordOutcome({ model: 'drift-model', provider: 'p', outcome: 'rejected', latencyMs: 300, ts: 100 + i });
    const alerts = mod.detectDrift();
    assert.ok(alerts.length > 0);
  });
});
