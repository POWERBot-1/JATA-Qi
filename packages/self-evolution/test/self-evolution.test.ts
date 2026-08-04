import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { SecurityModule } from '@jataqi/security';
import { NotificationsModule } from '@jataqi/notifications';
import { PolicyGovernanceModule } from '@jataqi/policy-governance';
import { SelfEvolutionModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function boot(full = false) {
  const k = createTestKernel();
  k.register(new StorageModule());
  if (full) { k.register(new SecurityModule()); k.register(new NotificationsModule()); k.register(new PolicyGovernanceModule()); }
  k.register(new SelfEvolutionModule());
  return k;
}

describe('SelfEvolutionModule (observation + analysis + proposals + experiments)', () => {
  let kernel: Kernel;
  let evo: SelfEvolutionModule;

  beforeEach(async () => {
    kernel = boot();
    await kernel.boot();
    evo = kernel.getModule<SelfEvolutionModule>('self-evolution');
  });

  // --- 1. Observation Engine ------------------------------------------------

  it('records observations', async () => {
    const obs = await evo.observe({ type: 'latency', source: 'api-gateway', metric: 'p99_ms', value: 850, baseline: 300, severity: 'warning', detail: 'spike on /qil' });
    assert.equal(obs.type, 'latency');
    assert.equal(obs.severity, 'warning');
    assert.ok(obs.id);
  });

  it('lists and filters observations', async () => {
    await evo.observe({ type: 'latency', source: 's1', metric: 'm1', value: 1 });
    await evo.observe({ type: 'failure', source: 's2', metric: 'm2', value: 1, severity: 'critical' });
    assert.equal((await evo.listObservations()).length, 2);
    assert.equal((await evo.listObservations({ type: 'failure' })).length, 1);
    assert.equal((await evo.listObservations({ severity: 'critical' })).length, 1);
  });

  // --- 2. Intelligence Analysis ----------------------------------------------

  it('analyzes observations for bottlenecks, failures and opportunities', async () => {
    await evo.observe({ type: 'latency', source: 'gw', metric: 'p99', value: 1000, baseline: 500 });
    await evo.observe({ type: 'failure', source: 'orch', metric: 'err_rate', value: 0.15, severity: 'critical' });
    await evo.observe({ type: 'cost', source: 'llm', metric: 'cost_per_1k', value: 0.001, baseline: 0.01 });
    const a = await evo.analyze();
    assert.ok(a.bottlenecks.length >= 1);
    assert.ok(a.failures.length >= 1);
    assert.ok(a.opportunities.length >= 1);
  });

  // --- 3. Evolution Planner --------------------------------------------------

  it('creates proposals with evidence and rollback strategy', async () => {
    const obs = await evo.observe({ type: 'latency', source: 's', metric: 'm', value: 800, baseline: 200 });
    const p = await evo.createProposal('agent-1', {
      title: 'Cache /qil responses', kind: 'caching',
      description: 'Add 60s cache', expectedImpact: '50% latency reduction',
      estimatedComplexity: 'low', confidence: 0.85,
      rollbackStrategy: 'Disable cache flag', affectedSystems: ['api-gateway'],
      evidence: [obs.id],
    });
    assert.equal(p.status, 'proposed');
    assert.equal(p.confidence, 0.85);
    assert.ok(p.evidence.includes(obs.id));
  });

  it('caps autonomous cycles to prevent runaway evolution (safety)', async () => {
    evo.setConfidenceThreshold(0.5);
    for (let i = 0; i < 10; i++) {
      await evo.createProposal('a', { title: `P${i}`, kind: 'latency', description: 'd', expectedImpact: '1%', estimatedComplexity: 'low', confidence: 0.9, rollbackStrategy: 'r', affectedSystems: [], evidence: [] });
    }
    // 11th proposal should be blocked.
    await assert.rejects(() => evo.createProposal('a', { title: 'P11', kind: 'latency', description: 'd', expectedImpact: '1%', estimatedComplexity: 'low', confidence: 0.9, rollbackStrategy: 'r', affectedSystems: [], evidence: [] }), /max autonomous cycles/);
  });

  // --- 5. Experiment Engine --------------------------------------------------

  it('runs experiments: approve → experiment → complete with winner', async () => {
    const p = await evo.createProposal('a', { title: 'Test', kind: 'latency', description: 'd', expectedImpact: '10% faster', estimatedComplexity: 'low', confidence: 0.9, rollbackStrategy: 'revert', affectedSystems: ['x'], evidence: [] });
    // Without governance module, evaluateProposal auto-approves.
    const eval_ = await evo.evaluateProposal(p.id);
    assert.equal(eval_.approved, true);

    const exp = await evo.createExperiment('a', p.id, 'ab', { latency: 500 }, { latency: 400 });
    assert.equal(exp.status, 'running');

    const done = await evo.completeExperiment(exp.id, { latency: 500 }, { latency: 400 });
    assert.equal(done.status, 'completed');
    assert.equal(done.result!.winner, 'variant');
    assert.ok(done.result!.improvementPct! > 0);

    const after = await evo.getProposal(p.id);
    assert.equal(after!.status, 'deployed');
  });

  it('marks proposals as rolled_back when experiment shows no improvement', async () => {
    const p = await evo.createProposal('a', { title: 'Bad', kind: 'cost', description: 'd', expectedImpact: 'worse', estimatedComplexity: 'low', confidence: 0.9, rollbackStrategy: 'r', affectedSystems: [], evidence: [] });
    await evo.evaluateProposal(p.id);
    const exp = await evo.createExperiment('a', p.id, 'shadow', { score: 80 }, { score: 70 });
    await evo.completeExperiment(exp.id, { score: 80 }, { score: 70 });
    const after = await evo.getProposal(p.id);
    assert.equal(after!.status, 'rolled_back');
  });

  // --- 7. Autonomous Optimizer -----------------------------------------------

  it('generates optimization proposals from analysis', async () => {
    await evo.observe({ type: 'latency', source: 'gw', metric: 'p99', value: 1000, baseline: 500 });
    await evo.observe({ type: 'failure', source: 'orch', metric: 'err', value: 5, severity: 'critical' });
    const proposals = await evo.generateOptimizations('agent-1');
    assert.ok(proposals.length >= 1);
    assert.ok(proposals.every((p) => p.evidence.length > 0));
  });

  // --- 8. Knowledge / Lessons ------------------------------------------------

  it('records lessons learned on success and failure', async () => {
    await evo.learn('a', 'success', 'Caching reduced p99 by 50%');
    await evo.learn('a', 'failure', 'Retry without backoff caused cascade');
    const all = await evo.listLessons();
    assert.equal(all.length, 2);
    assert.equal((await evo.listLessons('failure')).length, 1);
  });

  // --- 11. Rollback ----------------------------------------------------------

  it('rolls back deployed proposals', async () => {
    const p = await evo.createProposal('a', { title: 'T', kind: 'caching', description: 'd', expectedImpact: 'x', estimatedComplexity: 'low', confidence: 0.9, rollbackStrategy: 'disable', affectedSystems: [], evidence: [] });
    await evo.evaluateProposal(p.id);
    const exp = await evo.createExperiment('a', p.id, 'ab', { s: 100 }, { s: 120 });
    await evo.completeExperiment(exp.id, { s: 100 }, { s: 120 });
    assert.equal((await evo.getProposal(p.id))!.status, 'deployed');
    const rb = await evo.rollback(p.id, 'admin', 'regression in prod');
    assert.equal(rb.status, 'rolled_back');
    // Lesson learned from rollback.
    const lessons = await evo.listLessons('failure');
    assert.ok(lessons.length >= 1);
  });

  // --- 13. Explainability ----------------------------------------------------

  it('produces explainability reports for proposals', async () => {
    const obs = await evo.observe({ type: 'cost', source: 'llm', metric: 'cost', value: 100, baseline: 50 });
    const p = await evo.createProposal('a', { title: 'Reduce LLM cost', kind: 'cost', description: 'Route to cheaper model', expectedImpact: '30% cost reduction', estimatedComplexity: 'medium', confidence: 0.8, rollbackStrategy: 'Revert routing', affectedSystems: ['model-registry'], evidence: [obs.id] });
    const report = await evo.explain(p.id);
    assert.equal(report.confidence, 0.8);
    assert.ok(report.evidence.includes(obs.id));
    assert.match(report.rollbackStrategy, /Revert/);
  });

  // --- 15. Metrics -----------------------------------------------------------

  it('reports evolution stats', async () => {
    await evo.observe({ type: 'latency', source: 's', metric: 'm', value: 1 });
    await evo.createProposal('a', { title: 'P', kind: 'latency', description: 'd', expectedImpact: 'x', estimatedComplexity: 'low', confidence: 0.9, rollbackStrategy: 'r', affectedSystems: [], evidence: [] });
    await evo.learn('a', 'success', 'test');
    const s = await evo.stats();
    assert.equal(s.observations, 1);
    assert.equal(s.proposals, 1);
    assert.ok(s.byProposalStatus.proposed >= 1);
    assert.equal(s.lessonsLearned, 1);
    assert.ok(s.autonomousCycles >= 1);
  });

  it('emits lifecycle events', async () => {
    let obs = 0; let prop = 0; let exp = 0;
    kernel.bus.on('evolution.observation.recorded', () => { obs++; });
    kernel.bus.on('evolution.proposal.created', () => { prop++; });
    kernel.bus.on('evolution.experiment.completed', () => { exp++; });
    await evo.observe({ type: 'latency', source: 's', metric: 'm', value: 1 });
    const p = await evo.createProposal('a', { title: 'P', kind: 'latency', description: 'd', expectedImpact: 'x', estimatedComplexity: 'low', confidence: 0.9, rollbackStrategy: 'r', affectedSystems: [], evidence: [] });
    await evo.evaluateProposal(p.id);
    const e = await evo.createExperiment('a', p.id, 'ab', { s: 1 }, { s: 2 });
    await evo.completeExperiment(e.id, { s: 1 }, { s: 2 });
    assert.equal(obs, 1);
    assert.equal(prop, 1);
    assert.ok(exp >= 1);
  });
});

describe('SelfEvolutionModule — governance integration', () => {
  let kernel: Kernel;
  let evo: SelfEvolutionModule;
  let gov: PolicyGovernanceModule;

  beforeEach(async () => {
    kernel = boot(true);
    await kernel.boot();
    evo = kernel.getModule<SelfEvolutionModule>('self-evolution');
    gov = kernel.getModule<PolicyGovernanceModule>('policy-governance');
  });

  it('blocks deployment when governance denies evolution.deploy', async () => {
    await gov.createPolicy({ name: 'block auto-deploy', category: 'SAFETY', scope: 'GLOBAL', effect: 'DENY', action: 'evolution.deploy' }, 'admin');
    const p = await evo.createProposal('a', { title: 'T', kind: 'caching', description: 'd', expectedImpact: 'x', estimatedComplexity: 'low', confidence: 0.95, rollbackStrategy: 'r', affectedSystems: [], evidence: [] });
    const eval_ = await evo.evaluateProposal(p.id);
    assert.equal(eval_.approved, false);
    assert.match(eval_.decision, /DENY/);
    assert.equal((await evo.getProposal(p.id))!.status, 'rejected');
  });

  it('requires human review when confidence is below threshold', async () => {
    evo.setConfidenceThreshold(0.9);
    const p = await evo.createProposal('a', { title: 'Low conf', kind: 'latency', description: 'd', expectedImpact: 'x', estimatedComplexity: 'low', confidence: 0.5, rollbackStrategy: 'r', affectedSystems: [], evidence: [] });
    const eval_ = await evo.evaluateProposal(p.id);
    assert.equal(eval_.approved, false);
    assert.equal(eval_.decision, 'REQUIRES_HUMAN_REVIEW');
    assert.match(eval_.reason, /confidence 0\.5 below threshold/);
  });

  it('allows manual human override (approve/reject) and resets cycle counter', async () => {
    evo.setConfidenceThreshold(0.99);
    const p = await evo.createProposal('a', { title: 'Manual', kind: 'caching', description: 'd', expectedImpact: 'x', estimatedComplexity: 'low', confidence: 0.3, rollbackStrategy: 'r', affectedSystems: [], evidence: [] });
    // Auto-eval requires human review (low confidence).
    await evo.evaluateProposal(p.id);
    // Human approves manually.
    const approved = await evo.manualDecision(p.id, true, 'admin-1', 'I reviewed the evidence');
    assert.equal(approved.status, 'approved');
    // Cycle counter reset.
    const s = await evo.stats();
    assert.equal(s.autonomousCycles, 0);
    // Now experiment is allowed.
    const exp = await evo.createExperiment('a', p.id, 'ab', { s: 1 }, { s: 2 });
    assert.equal(exp.status, 'running');
  });
});
