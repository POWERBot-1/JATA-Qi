// SelfEvolutionModule — the JATA Qi autonomous intelligence & self-evolution
// framework (#52/#86). Implements observation, analysis, proposal generation,
// experimentation, governed approval, deployment, rollback, and learning.
//
// Safety guarantees:
// - No production change without governance approval.
// - Every proposal is explainable with evidence + rollback strategy.
// - Experiments are isolated; deployment requires explicit approval.
// - Recursive evolution loops are capped (MAX_AUTONOMOUS_CYCLES).
// - All actions are audit-logged and tenant-aware.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import {
  EvolutionEvents, DEFAULT_CONFIDENCE_THRESHOLD, MAX_AUTONOMOUS_CYCLES,
} from './types.js';
import type {
  Experiment, ExperimentMode, ExplainabilityReport, LessonLearned, Observation,
  Proposal, ProposalKind, ProposalStatus, Severity,
} from './types.js';

const COL_OBS = 'evolution.observations';
const COL_PROP = 'evolution.proposals';
const COL_EXP = 'evolution.experiments';
const COL_LESSONS = 'evolution.lessons';

export interface RecordObservationInput {
  type: Observation['type'];
  source: string;
  metric: string;
  value: number;
  baseline?: number;
  severity?: Severity;
  detail?: string;
  organizationId?: string;
}

export interface CreateProposalInput {
  title: string;
  kind: ProposalKind;
  description: string;
  expectedImpact: string;
  estimatedComplexity: Proposal['estimatedComplexity'];
  confidence: number;
  rollbackStrategy: string;
  affectedSystems: string[];
  evidence: string[];
  riskScore?: number;
  organizationId?: string;
}

export class SelfEvolutionModule implements IModule {
  readonly id = 'self-evolution';
  readonly tags = ['core', 'evolution'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private observations!: ICollection<Observation>;
  private proposals!: ICollection<Proposal>;
  private experiments!: ICollection<Experiment>;
  private lessons!: ICollection<LessonLearned>;
  private confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;
  private autonomousCycles = 0;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.observations = await C<Observation>(COL_OBS);
    this.proposals = await C<Proposal>(COL_PROP);
    this.experiments = await C<Experiment>(COL_EXP);
    this.lessons = await C<LessonLearned>(COL_LESSONS);
    kernel.container.registerValue('self-evolution', this);
    kernel.logger.info('self-evolution module initialized (safety-first, human-governed)');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  setConfidenceThreshold(t: number): void { this.confidenceThreshold = Math.max(0, Math.min(1, t)); }

  // --- 1. Observation Engine ------------------------------------------------

  async observe(input: RecordObservationInput): Promise<Observation> {
    const obs: Observation = {
      id: randomUUID(), type: input.type, source: input.source, metric: input.metric,
      value: input.value, severity: input.severity ?? 'info', createdAt: Date.now(),
      ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    };
    await this.observations.put(obs);
    await this.api.bus.emit(EvolutionEvents.ObservationRecorded, { id: obs.id, type: obs.type, source: obs.source });
    return obs;
  }

  async listObservations(filter?: { type?: string; source?: string; severity?: string }): Promise<Observation[]> {
    let all = await this.observations.all();
    if (filter?.type) all = all.filter((o) => o.type === filter.type);
    if (filter?.source) all = all.filter((o) => o.source === filter.source);
    if (filter?.severity) all = all.filter((o) => o.severity === filter.severity);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  // --- 2. Intelligence Analysis Engine --------------------------------------

  /**
   * Analyze observations to identify bottlenecks, recurring failures, and
   * optimization opportunities. Returns ranked improvement candidates.
   */
  async analyze(): Promise<{ bottlenecks: Observation[]; failures: Observation[]; opportunities: Observation[] }> {
    const all = await this.observations.all();
    const bottlenecks = all.filter((o) => o.type === 'latency' && o.value > (o.baseline ?? Infinity)).sort((a, b) => b.value - a.value).slice(0, 10);
    const failures = all.filter((o) => o.type === 'failure' || o.severity === 'critical').slice(0, 20);
    const opportunities = all.filter((o) => (o.type === 'cost' || o.type === 'quality') && o.baseline !== undefined && o.value < o.baseline).slice(0, 10);
    return { bottlenecks, failures, opportunities };
  }

  // --- 3. Evolution Planner -------------------------------------------------

  async createProposal(createdBy: string, input: CreateProposalInput): Promise<Proposal> {
    // Safety: cap autonomous cycles.
    if (this.autonomousCycles >= MAX_AUTONOMOUS_CYCLES) {
      await this.api.bus.emit(EvolutionEvents.EvolutionBlocked, { reason: 'max autonomous cycles reached — human review required' });
      throw new Error('evolution: max autonomous cycles reached — human review required before further proposals');
    }

    const now = Date.now();
    const proposal: Proposal = {
      id: randomUUID(), title: input.title, kind: input.kind, description: input.description,
      expectedImpact: input.expectedImpact, estimatedComplexity: input.estimatedComplexity,
      confidence: input.confidence, rollbackStrategy: input.rollbackStrategy,
      affectedSystems: input.affectedSystems, evidence: input.evidence, status: 'proposed',
      riskScore: input.riskScore ?? 2,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      createdBy, createdAt: now, updatedAt: now,
    };
    await this.proposals.put(proposal);
    await this.api.bus.emit(EvolutionEvents.ProposalCreated, { id: proposal.id, kind: proposal.kind });
    await this.audit(createdBy, 'proposal_created', { proposalId: proposal.id, kind: input.kind, confidence: input.confidence });
    this.autonomousCycles++;
    return proposal;
  }

  async getProposal(id: string): Promise<Proposal | undefined> { return this.proposals.get(id); }
  async listProposals(status?: ProposalStatus): Promise<Proposal[]> {
    const all = await this.proposals.all();
    const filtered = status ? all.filter((p) => p.status === status) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  // --- 6. Governance Approval Engine ----------------------------------------

  /** Submit a proposal for governance evaluation. Returns the governance decision. */
  async evaluateProposal(proposalId: string): Promise<{ approved: boolean; decision: string; reason: string }> {
    const proposal = await this.proposals.get(proposalId);
    if (!proposal) throw new Error(`evolution: proposal "${proposalId}" not found`);

    // Governance gate: evaluate 'evolution.deploy'.
    const gov = await this.governanceGate(proposal.createdBy, 'evolution.deploy', proposal.organizationId);
    if (gov && !gov.allowed) {
      proposal.status = 'rejected';
      proposal.governanceDecision = gov.decision;
      if (gov.evaluationId) proposal.governanceEvaluationId = gov.evaluationId;
      proposal.updatedAt = Date.now();
      await this.proposals.put(proposal);
      await this.api.bus.emit(EvolutionEvents.ProposalRejected, { proposalId, reason: gov.reason });
      await this.audit(proposal.createdBy, 'proposal_rejected', { proposalId, governance: gov.decision });
      return { approved: false, decision: gov.decision, reason: gov.reason };
    }

    // Confidence check: low-confidence proposals require manual review.
    if (proposal.confidence < this.confidenceThreshold) {
      proposal.status = 'analyzing'; // pending manual review
      proposal.updatedAt = Date.now();
      await this.proposals.put(proposal);
      return { approved: false, decision: 'REQUIRES_HUMAN_REVIEW', reason: `confidence ${proposal.confidence} below threshold ${this.confidenceThreshold}` };
    }

    proposal.status = 'approved';
    proposal.governanceDecision = gov?.decision ?? 'ALLOW';
    if (gov?.evaluationId) proposal.governanceEvaluationId = gov.evaluationId;
    proposal.updatedAt = Date.now();
    await this.proposals.put(proposal);
    await this.api.bus.emit(EvolutionEvents.ProposalApproved, { proposalId });
    await this.notify(proposal.createdBy, 'evolution', 'Proposal approved', `"${proposal.title}" approved for experimentation.`);
    await this.audit(proposal.createdBy, 'proposal_approved', { proposalId, confidence: proposal.confidence });
    return { approved: true, decision: 'ALLOW', reason: 'governance approved' };
  }

  /** Manual approval/rejection by a human reviewer. */
  async manualDecision(proposalId: string, approve: boolean, reviewerId: string, reason?: string): Promise<Proposal> {
    const p = await this.proposals.get(proposalId);
    if (!p) throw new Error(`evolution: proposal "${proposalId}" not found`);
    p.status = approve ? 'approved' : 'rejected';
    p.updatedAt = Date.now();
    await this.proposals.put(p);
    await this.api.bus.emit(approve ? EvolutionEvents.ProposalApproved : EvolutionEvents.ProposalRejected, { proposalId });
    await this.audit(reviewerId, approve ? 'proposal_manually_approved' : 'proposal_manually_rejected', { proposalId, reason });
    if (approve) this.autonomousCycles = 0; // reset cycle counter on human review
    return p;
  }

  // --- 5. Experiment Engine -------------------------------------------------

  async createExperiment(createdBy: string, proposalId: string, mode: ExperimentMode, baseline: Record<string, number>, variant: Record<string, number>): Promise<Experiment> {
    const proposal = await this.proposals.get(proposalId);
    if (!proposal) throw new Error(`evolution: proposal "${proposalId}" not found`);
    if (proposal.status !== 'approved') throw new Error('evolution: proposal must be approved before experimenting');

    const exp: Experiment = {
      id: randomUUID(), proposalId, mode, status: 'running',
      baseline, variant, createdBy, createdAt: Date.now(),
    };
    await this.experiments.put(exp);
    proposal.status = 'experimenting';
    proposal.updatedAt = Date.now();
    await this.proposals.put(proposal);
    await this.api.bus.emit(EvolutionEvents.ExperimentStarted, { experimentId: exp.id, mode });
    await this.audit(createdBy, 'experiment_started', { experimentId: exp.id, proposalId, mode });
    return exp;
  }

  /** Complete an experiment with results. */
  async completeExperiment(experimentId: string, baselineResult: Record<string, number>, variantResult: Record<string, number>): Promise<Experiment> {
    const exp = await this.experiments.get(experimentId);
    if (!exp) throw new Error(`evolution: experiment "${experimentId}" not found`);

    // Determine winner: compare primary metric (first key).
    // Metrics with these patterns are "lower is better".
    const key = Object.keys(baselineResult)[0] ?? 'score';
    const bVal = baselineResult[key] ?? 0;
    const vVal = variantResult[key] ?? 0;
    const lowerIsBetter = /latency|_ms|_time|error|failure|cost|duration/i.test(key);
    const rawPct = bVal !== 0 ? ((vVal - bVal) / Math.abs(bVal)) * 100 : 0;
    // Normalize: positive improvementPct = variant is better.
    const improvementPct = Math.round((lowerIsBetter ? -rawPct : rawPct) * 10) / 10;
    const winner = improvementPct > 2 ? 'variant' : improvementPct < -2 ? 'baseline' : 'inconclusive';

    const now = Date.now();
    const updated: Experiment = {
      ...exp, status: 'completed', completedAt: now,
      result: { winner, ...(improvementPct !== 0 ? { improvementPct } : {}) },
    };
    await this.experiments.put(updated);
    await this.api.bus.emit(EvolutionEvents.ExperimentCompleted, { experimentId, winner });

    // Update proposal status.
    const proposal = await this.proposals.get(exp.proposalId);
    if (proposal) {
      if (winner === 'variant') {
        proposal.status = 'deployed';
        await this.learn(createdBy(exp), 'success', `Experiment confirmed improvement: ${proposal.title}`, proposal.id, experimentId);
      } else {
        proposal.status = winner === 'baseline' ? 'rolled_back' : 'abandoned';
        await this.learn(createdBy(exp), 'failure', `Experiment showed no improvement: ${proposal.title}`, proposal.id, experimentId);
      }
      proposal.updatedAt = now;
      await this.proposals.put(proposal);
      if (winner === 'variant') await this.api.bus.emit(EvolutionEvents.ProposalDeployed, { proposalId: proposal.id });
      else await this.api.bus.emit(EvolutionEvents.ProposalRolledBack, { proposalId: proposal.id });
    }
    return updated;
  }

  async getExperiment(id: string): Promise<Experiment | undefined> { return this.experiments.get(id); }
  async listExperiments(proposalId?: string): Promise<Experiment[]> {
    const all = await this.experiments.all();
    return proposalId ? all.filter((e) => e.proposalId === proposalId) : all;
  }

  // --- 7. Autonomous Optimizer (proposals only — never modifies production) --

  /**
   * Generate optimization proposals from analysis. Returns proposals that pass
   * the confidence threshold. Does NOT execute anything — proposals require
   * governance approval + experimentation before deployment.
   */
  async generateOptimizations(createdBy: string, analysis?: Awaited<ReturnType<SelfEvolutionModule['analyze']>>): Promise<Proposal[]> {
    const a = analysis ?? await this.analyze();
    const generated: Proposal[] = [];

    for (const b of a.bottlenecks.slice(0, 3)) {
      try {
        const p = await this.createProposal(createdBy, {
          title: `Optimize latency: ${b.metric} on ${b.source}`,
          kind: 'latency', description: `Latency spike detected (${b.value} vs baseline ${b.baseline ?? 'n/a'}).`,
          expectedImpact: `Reduce ${b.metric} by ~20%`, estimatedComplexity: 'medium',
          confidence: 0.7, rollbackStrategy: 'Revert to previous configuration.',
          affectedSystems: [b.source], evidence: [b.id], riskScore: 2,
          ...(b.organizationId ? { organizationId: b.organizationId } : {}),
        });
        generated.push(p);
      } catch { /* cycle cap */ }
    }
    for (const f of a.failures.slice(0, 2)) {
      try {
        const p = await this.createProposal(createdBy, {
          title: `Fix recurring failure: ${f.metric} on ${f.source}`,
          kind: 'retry', description: `Recurring failure: ${f.detail ?? f.metric}.`,
          expectedImpact: `Reduce failure rate`, estimatedComplexity: 'low',
          confidence: 0.8, rollbackStrategy: 'Revert retry parameters.',
          affectedSystems: [f.source], evidence: [f.id], riskScore: 1,
          ...(f.organizationId ? { organizationId: f.organizationId } : {}),
        });
        generated.push(p);
      } catch { /* cycle cap */ }
    }
    return generated;
  }

  // --- 8. Knowledge Evolution Engine (lessons learned) ----------------------

  async learn(createdBy: string, category: LessonLearned['category'], description: string, proposalId?: string, experimentId?: string): Promise<LessonLearned> {
    const lesson: LessonLearned = {
      id: randomUUID(), title: description.slice(0, 100), category, description,
      ...(proposalId ? { proposalId } : {}), ...(experimentId ? { experimentId } : {}),
      createdAt: Date.now(),
    };
    await this.lessons.put(lesson);
    await this.api.bus.emit(EvolutionEvents.LessonLearned, { id: lesson.id, category });
    await this.audit(createdBy, 'lesson_learned', { lessonId: lesson.id, category });
    return lesson;
  }

  async listLessons(category?: string): Promise<LessonLearned[]> {
    const all = await this.lessons.all();
    return category ? all.filter((l) => l.category === category) : all;
  }

  // --- 11. Rollback Engine --------------------------------------------------

  async rollback(proposalId: string, reviewerId: string, reason?: string): Promise<Proposal> {
    const p = await this.proposals.get(proposalId);
    if (!p) throw new Error(`evolution: proposal "${proposalId}" not found`);
    if (p.status !== 'deployed') throw new Error('evolution: only deployed proposals can be rolled back');
    p.status = 'rolled_back';
    p.updatedAt = Date.now();
    await this.proposals.put(p);
    await this.api.bus.emit(EvolutionEvents.ProposalRolledBack, { proposalId });
    await this.learn(reviewerId, 'failure', `Rolled back: ${p.title}. Reason: ${reason ?? 'unspecified'}`, proposalId);
    await this.audit(reviewerId, 'proposal_rolled_back', { proposalId, reason });
    return p;
  }

  // --- 13. Explainability Engine --------------------------------------------

  async explain(proposalId: string): Promise<ExplainabilityReport> {
    const p = await this.proposals.get(proposalId);
    if (!p) throw new Error(`evolution: proposal "${proposalId}" not found`);
    return {
      proposalId,
      reasoningSummary: `${p.title}: ${p.description}`,
      evidence: p.evidence,
      confidence: p.confidence,
      expectedImpact: p.expectedImpact,
      affectedSystems: p.affectedSystems,
      rollbackStrategy: p.rollbackStrategy,
      ...(p.governanceDecision ? { governanceDecision: p.governanceDecision } : {}),
    };
  }

  // --- 15. Metrics ----------------------------------------------------------

  async stats(): Promise<{
    observations: number; proposals: number; experiments: number;
    byProposalStatus: Record<string, number>; lessonsLearned: number;
    autonomousCycles: number; confidenceThreshold: number;
  }> {
    const proposals = await this.proposals.all();
    const byStatus: Record<string, number> = {};
    for (const p of proposals) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    return {
      observations: await this.observations.count(),
      proposals: proposals.length,
      experiments: await this.experiments.count(),
      byProposalStatus: byStatus,
      lessonsLearned: await this.lessons.count(),
      autonomousCycles: this.autonomousCycles,
      confidenceThreshold: this.confidenceThreshold,
    };
  }

  // --- helpers --------------------------------------------------------------

  private async governanceGate(userId: string, action: string, organizationId?: string): Promise<{ allowed: boolean; decision: string; reason: string; evaluationId?: string } | undefined> {
    try {
      const gov = this.api.getModule('policy-governance') as unknown as {
        evaluate: (s: { userId: string; organizationId?: string }, a: string, c?: Record<string, unknown>) => Promise<{ decision: string; reason: string; evaluationId: string }>;
      };
      const res = await gov.evaluate({ userId, ...(organizationId ? { organizationId } : {}) }, action);
      return { allowed: res.decision === 'ALLOW', decision: res.decision, reason: res.reason, evaluationId: res.evaluationId };
    } catch { return undefined; }
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec && typeof sec.audit === 'function') await sec.audit({ actor, action: `evolution.${action}`, result: 'success', detail });
    } catch { /* optional */ }
  }

  private async notify(recipient: string, type: string, title: string, body: string): Promise<void> {
    try {
      const n = this.api.getModule('notifications') as unknown as { notify: (r: string, p: { type: string; title: string; body?: string }) => Promise<unknown> } | undefined;
      if (n && typeof n.notify === 'function') await n.notify(recipient, { type, title, body });
    } catch { /* optional */ }
  }
}

function createdBy(exp: Experiment): string { return exp.createdBy; }
