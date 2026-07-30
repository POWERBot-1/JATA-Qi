// OrchestratorModule — executes compiled QiL plans.
//
// Execution model (see Step 3 "Kernel Decision Flow" and Step 6 MAIF):
//   1. Receive objective (a compiled plan).
//   2. Walk steps in dependency order, sharing accumulated context.
//   3. RETRIEVE pulls knowledge; REASON/ANALYZE/PLAN/SYNTHESIZE/VERIFY/OPTIMIZE
//      invoke an agent with the objective + retrieved context; REPORT assembles a
//      structured response; AUDIT records to the ledger; STOP halts the run.
//   4. Emit per-step and overall events; write an audit record when security is
//      available.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { AgentRuntimeModule } from '@jataqi/agent-runtime';
import type { KnowledgeService, RetrievalHit } from '@jataqi/knowledge-service';
import type { ExecutionPlan, PlanStep } from '@jataqi/qil';
import { compileSource } from '@jataqi/qil';
import type { INamespace } from '@jataqi/storage';
import { OrchestratorEvents } from './types.js';
import type { ExecutionResult, ExecuteOptions, StepResult } from './types.js';

/** Map each workflow step kind to the governance action evaluated before it runs. */
const GOV_ACTION_FOR_STEP: Record<string, string> = {
  retrieve: 'knowledge.retrieve',
  reason: 'agent.run', analyze: 'agent.run', plan: 'agent.run',
  synthesize: 'agent.run', verify: 'agent.run', optimize: 'agent.run',
  report: 'workflow.report', audit: 'workflow.audit',
  execute: 'workflow.execute', deploy: 'deploy.application',
  observe: 'workflow.observe', learn: 'workflow.learn', simulate: 'workflow.simulate',
  stop: 'workflow.stop',
};

export class OrchestratorModule implements IModule {
  readonly id = 'orchestrator';
  readonly tags = ['core', 'orchestration'] as const;
  readonly dependsOn = ['agent-runtime', 'knowledge', 'qil'] as const;

  private api!: KernelApi;
  /** Durable store of execution results (when the storage module is present). */
  private runs?: INamespace;
  /** Monotonic run counter for deterministic ordering. */
  private runSeq = 0;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('orchestrator', this);
    try {
      const storage = kernel.getModule('storage') as unknown as { namespace: (n: string) => Promise<INamespace> };
      this.runs = await storage.namespace('orchestrator.runs');
    } catch {
      /* storage module not registered — runs stay ephemeral */
    }
    kernel.logger.info('orchestrator module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  /** Execute a compiled QiL plan. */
  async execute(plan: ExecutionPlan, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const metrics = this.tryMetrics();
    const topK = opts.topK ?? 4;
    const results: StepResult[] = [];
    const retrieved: string[] = [];
    const reasoning: string[] = [];
    let status: ExecutionResult['status'] = 'completed';
    let finalReport = '';

    this.assertAcyclic(plan);
    await this.api.bus.emit(OrchestratorEvents.ExecutionStarted, { planId: plan.id, mission: plan.mission });

    for (const step of plan.steps) {
      await this.api.bus.emit(OrchestratorEvents.StepStarted, { planId: plan.id, stepId: step.id, kind: step.kind });

      // If a prior STOP/error halted the run, record the remaining steps as skipped.
      if (status === 'stopped' || status === 'failed') {
        const skipped: StepResult = { stepId: step.id, kind: step.kind, keyword: step.keyword, status: 'skipped', durationMs: 0 };
        results.push(skipped);
        await this.api.bus.emit(OrchestratorEvents.StepCompleted, { planId: plan.id, stepId: step.id, status: 'skipped' });
        continue;
      }

      const t0 = Date.now();
      const result: StepResult = { stepId: step.id, kind: step.kind, keyword: step.keyword, status: 'success', durationMs: 0 };
      try {
        // MANDATORY pre-execution governance gate (enforced when policy-governance
        // is registered; skipped gracefully when absent).
        const gate = await this.governanceGate(opts, step);
        if (gate && !gate.allowed) {
          result.status = 'error';
          result.error = `governance ${gate.decision}: ${gate.reason}`;
          result.governance = { decision: gate.decision, ...(gate.evaluationId ? { evaluationId: gate.evaluationId } : {}), reason: gate.reason };
          result.durationMs = Date.now() - t0;
          results.push(result);
          await this.api.bus.emit(OrchestratorEvents.StepCompleted, { planId: plan.id, stepId: step.id, status: 'error' });
          continue;
        } else if (gate) {
          result.governance = { decision: gate.decision, ...(gate.evaluationId ? { evaluationId: gate.evaluationId } : {}) };
        }
        switch (step.kind) {
          case 'retrieve': {
            const query = step.argument ?? step.label ?? '';
            const hits = query ? await this.retrieve(query, topK) : [];
            for (const h of hits) retrieved.push(h);
            result.output = { query, hits: hits.length };
            break;
          }
          case 'reason':
          case 'analyze':
          case 'plan':
          case 'synthesize':
          case 'verify':
          case 'optimize': {
            const answer = await this.reason(step, { retrieved, reasoning, mission: plan.mission, agent: step.agent ?? opts.agent });
            reasoning.push(answer);
            result.output = answer;
            break;
          }
          case 'report': {
            finalReport = this.composeReport(plan, retrieved, reasoning, step.argument);
            result.output = finalReport;
            break;
          }
          case 'audit': {
            const ok = await this.recordAudit(step, opts.principal);
            result.output = { recorded: ok };
            break;
          }
          case 'stop': {
            status = 'stopped';
            result.status = 'success';
            result.output = { halted: true };
            break;
          }
          default: {
            // observe / learn / simulate / execute / deploy — record as a no-op step.
            result.output = { note: `step "${step.keyword}" acknowledged`, argument: step.argument };
            break;
          }
        }
      } catch (err) {
        status = 'failed';
        result.status = 'error';
        result.error = (err as Error)?.message ?? String(err);
      }
      result.durationMs = Date.now() - t0;
      results.push(result);
      await this.api.bus.emit(OrchestratorEvents.StepCompleted, { planId: plan.id, stepId: step.id, status: result.status });
    }

    if (!finalReport) {
      finalReport = this.composeReport(plan, retrieved, reasoning, undefined);
    }

    const finishedAt = Date.now();
    const execResult: ExecutionResult = {
      id: randomUUID(),
      seq: ++this.runSeq,
      ...(plan.id !== undefined ? { planId: plan.id } : {}),
      ...(plan.mission !== undefined ? { mission: plan.mission } : {}),
      goals: plan.goals,
      status,
      steps: results,
      finalReport,
      retrieved,
      startedAt,
      finishedAt,
    };

    // Attribute the run to an audit record when the security module is present.
    const sec = this.trySecurity();
    if (sec) {
      const rec = await sec.audit({
        actor: opts.principal?.userId ?? 'anonymous',
        action: 'orchestrator.run',
        resource: plan.id,
        result: status === 'completed' ? 'success' : 'failure',
        detail: { mission: plan.mission, steps: results.length, goalCount: plan.goals.length },
      });
      execResult.auditRecordId = rec.id;
    }

    await this.api.bus.emit(OrchestratorEvents.ExecutionCompleted, { execId: execResult.id, status });
    if (metrics) {
      metrics.workflowRuns.inc(1, { status });
      metrics.workflowDuration.observe(finishedAt - startedAt);
    }
    // Persist the run for later history/replay when durable storage is available.
    if (this.runs) {
      try {
        await this.runs.set(execResult.id, execResult);
      } catch (err) {
        this.api.logger.warn('failed to persist workflow run', { error: (err as Error).message });
      }
    }
    return execResult;
  }

  /** Look up a previously executed run by id (when durable storage is present). */
  async getRun(id: string): Promise<ExecutionResult | undefined> {
    if (!this.runs) return undefined;
    return this.runs.get<ExecutionResult>(id);
  }

  /** Recent runs, newest first (when durable storage is present). */
  async listRuns(limit = 50): Promise<ExecutionResult[]> {
    if (!this.runs) return [];
    const res = await this.runs.list<ExecutionResult>({ limit: 10_000 });
    const items = res.items.map((e) => e.value);
    items.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
    return items.slice(0, limit);
  }

  /** Compile QiL source then execute it. */
  async runSource(source: string, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
    const r = compileSource(source);
    if (!r.ok || !r.plan) {
      const first = r.diagnostics.find((d) => d.severity === 'error');
      throw new Error(first?.message ?? 'QiL compilation failed');
    }
    return this.execute(r.plan, opts);
  }

  /**
   * Natural-language shortcut (matches the Step 92 example "Analyze my business"
   * -> Research -> Analysis -> Response). Builds a trivial plan from free text.
   */
  async runObjective(objective: string, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
    const safe = objective.replace(/"/g, '\\"');
    const source = `MISSION "${safe}"\nRETRIEVE "${safe}"\nREASON "${safe}"\nREPORT`;
    return this.runSource(source, opts);
  }

  // --- internals -----------------------------------------------------------

  private async retrieve(query: string, topK: number): Promise<string[]> {
    const knowledge = this.api.getModule<KnowledgeService>('knowledge');
    const hits = await knowledge.retrieve(query, { topK });
    return hits.map((h) => h.chunk.text);
  }

  private async reason(
    step: PlanStep,
    ctx: { retrieved: string[]; reasoning: string[]; mission?: string; agent?: string },
  ): Promise<string> {
    const agents = this.api.getModule<AgentRuntimeModule>('agent-runtime');
    const parts: string[] = [];
    if (ctx.mission) parts.push(`Mission: ${ctx.mission}`);
    parts.push(step.argument ? `Directive (${step.keyword}): ${step.argument}` : `Directive: perform ${step.keyword}.`);
    if (ctx.retrieved.length) {
      const snippets = ctx.retrieved.slice(0, 4).map((t, i) => `[${i + 1}] ${t.slice(0, 500)}`).join('\n');
      parts.push(`Relevant knowledge:\n${snippets}`);
    }
    if (ctx.reasoning.length) {
      parts.push(`Prior reasoning:\n${ctx.reasoning.slice(-2).join('\n')}`);
    }
    const res = await agents.run(parts.join('\n\n'), { agent: ctx.agent });
    return res.answer;
  }

  private composeReport(plan: ExecutionPlan, retrieved: string[], reasoning: string[], directive?: string): string {
    const lines: string[] = [];
    if (directive) lines.push(directive);
    if (plan.mission) lines.push(`Mission: ${plan.mission}`);
    if (plan.goals.length) lines.push(`Goals: ${plan.goals.join('; ')}`);
    if (reasoning.length) lines.push(`Analysis:\n${reasoning[reasoning.length - 1]}`);
    if (retrieved.length && !reasoning.length) {
      lines.push(`Findings:\n${retrieved.slice(0, 3).map((t) => `- ${t.slice(0, 300)}`).join('\n')}`);
    }
    if (lines.length === 0) lines.push('No output produced.');
    return lines.join('\n\n');
  }

  private async recordAudit(step: PlanStep, principal?: ExecuteOptions['principal']): Promise<boolean> {
    const sec = this.trySecurity();
    if (!sec) return false;
    await sec.audit({
      actor: principal?.userId ?? 'anonymous',
      action: `workflow.${step.keyword.toLowerCase()}`,
      resource: step.label,
      result: 'success',
      detail: { argument: step.argument },
    });
    return true;
  }

  /**
   * Mandatory governance gate. Maps each step to a governance action and
   * evaluates it via policy-governance when that module is registered. Returns
   * undefined when governance is absent (gate skipped), or a decision object.
   */
  private async governanceGate(opts: ExecuteOptions, step: PlanStep): Promise<{ allowed: boolean; decision: string; reason: string; evaluationId?: string } | undefined> {
    let gov: { evaluate: (s: { userId: string; roles?: string[] }, a: string, c?: Record<string, unknown>) => Promise<{ decision: string; reason: string; evaluationId: string }> };
    try {
      gov = this.api.getModule('policy-governance') as unknown as typeof gov;
    } catch {
      return undefined; // governance not registered → no gate
    }
    const action = GOV_ACTION_FOR_STEP[step.kind] ?? 'workflow.step';
    const subject = { userId: opts.principal?.userId ?? 'anonymous', roles: opts.principal?.roles };
    try {
      const res = await gov.evaluate(subject, action);
      return { allowed: res.decision === 'ALLOW', decision: res.decision, reason: res.reason, evaluationId: res.evaluationId };
    } catch (err) {
      // Fail-open only on unexpected governance errors (audit still records).
      return { allowed: true, decision: 'ALLOW', reason: `governance eval error: ${(err as Error).message}` };
    }
  }

  /** Resolve the security module if it is registered (optional dependency). */
  private trySecurity(): { audit: (rec: Record<string, unknown>) => Promise<{ id: string }> } | undefined {
    try {
      const mod = this.api.getModule('security') as unknown as {
        audit: (rec: Record<string, unknown>) => Promise<{ id: string }>;
      };
      return mod;
    } catch {
      return undefined;
    }
  }

  /** Resolve the metrics module if it is registered (optional dependency). */
  private tryMetrics(): { workflowRuns: { inc: (n: number, labels?: Record<string, string>) => void }; workflowDuration: { observe: (v: number) => void } } | undefined {
    try {
      return this.api.getModule('metrics') as unknown as {
        workflowRuns: { inc: (n: number, labels?: Record<string, string>) => void };
        workflowDuration: { observe: (v: number) => void };
      };
    } catch {
      return undefined;
    }
  }

  /** Throw if the plan's dependency graph contains a cycle. */
  private assertAcyclic(plan: ExecutionPlan): void {
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited,1=visiting,2=done
    const visit = (id: string, path: string[]): void => {
      const st = state.get(id) ?? 0;
      if (st === 2) return;
      if (st === 1) throw new Error(`orchestrator: cyclic dependency detected (${[...path, id].join(' -> ')})`);
      state.set(id, 1);
      const step = byId.get(id);
      if (step) for (const dep of step.dependsOn) visit(dep, [...path, id]);
      state.set(id, 2);
    };
    for (const s of plan.steps) visit(s.id, []);
  }
}
