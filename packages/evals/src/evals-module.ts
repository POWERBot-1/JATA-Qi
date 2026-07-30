// EvalsModule — create evaluation suites, run them against any target (agent,
// tool, LLM, workflow), score with built-in or custom metrics, and track
// results over time for regression detection.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { EvalEvents } from './types.js';
import type { CaseResult, EvalMetric, EvalRun, EvalSuite, EvalSummary, EvalTarget } from './types.js';

const COL_SUITES = 'evals.suites';
const COL_RUNS = 'evals.runs';

export class EvalsModule implements IModule {
  readonly id = 'evals';
  readonly tags = ['core', 'developer'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private suites!: ICollection<EvalSuite>;
  private runs!: ICollection<EvalRun & { id: string }>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.suites = await storage.collection<EvalSuite>(COL_SUITES);
    this.runs = await storage.collection<EvalRun & { id: string }>(COL_RUNS);
    kernel.container.registerValue('evals', this);
    kernel.logger.info('evals module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- suites ---------------------------------------------------------------

  async createSuite(input: { name: string; description?: string; cases: Omit<EvalSuite['cases'][0], 'id'>[]; metrics?: EvalMetric[]; passThreshold?: number }): Promise<EvalSuite> {
    const suite: EvalSuite = {
      id: randomUUID(),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      cases: input.cases.map((c) => ({ ...c, id: randomUUID() })),
      metrics: input.metrics ?? [],
      passThreshold: input.passThreshold ?? 0.8,
      createdAt: Date.now(),
    };
    await this.suites.put(suite);
    return suite;
  }

  async getSuite(id: string): Promise<EvalSuite | undefined> { return this.suites.get(id); }
  async listSuites(): Promise<EvalSuite[]> { return this.suites.all(); }

  // --- run ------------------------------------------------------------------

  async run(suiteId: string, target: EvalTarget): Promise<EvalRun> {
    const suite = await this.suites.get(suiteId);
    if (!suite) throw new Error(`evals: suite "${suiteId}" not found`);

    await this.api.bus.emit(EvalEvents.RunStarted, { suiteId, target: target.id });
    const t0 = Date.now();
    const results: CaseResult[] = [];

    for (const c of suite.cases) {
      const ct0 = Date.now();
      let actual = '';
      let error: string | undefined;
      try { actual = await target.run(c.input); } catch (err) { error = (err as Error).message; }

      const scores: Record<string, number> = {};
      let total = 0;
      for (const m of suite.metrics) {
        const s = error ? 0 : m.score(actual, c.expected, c);
        scores[m.name] = s;
        total += s;
      }
      const avg = suite.metrics.length > 0 ? total / suite.metrics.length : (error ? 0 : 1);
      results.push({
        caseId: c.id,
        passed: avg >= suite.passThreshold,
        scores,
        averageScore: Math.round(avg * 1000) / 1000,
        actual: error ? '' : actual,
        ...(error ? { error } : {}),
        durationMs: Date.now() - ct0,
      });
    }

    const durationMs = Date.now() - t0;
    const passed = results.filter((r) => r.passed).length;
    const metricAverages: Record<string, number> = {};
    for (const m of suite.metrics) {
      const vals = results.map((r) => r.scores[m.name] ?? 0);
      metricAverages[m.name] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
    }
    const summary: EvalSummary = {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length > 0 ? Math.round((passed / results.length) * 1000) / 1000 : 0,
      avgScore: Math.round((results.reduce((a, r) => a + r.averageScore, 0) / Math.max(1, results.length)) * 1000) / 1000,
      durationMs,
      metricAverages,
    };
    const run: EvalRun = {
      id: randomUUID(),
      suiteId,
      suiteName: suite.name,
      target: { kind: target.kind, id: target.id },
      results,
      summary,
      createdAt: Date.now(),
    };
    await this.runs.put(run);
    await this.api.bus.emit(EvalEvents.RunCompleted, { runId: run.id, passRate: summary.passRate });
    return run;
  }

  async getRun(id: string): Promise<EvalRun | undefined> { return this.runs.get(id); }
  async listRuns(suiteId?: string): Promise<EvalRun[]> {
    const all = await this.runs.all();
    const filtered = suiteId ? all.filter((r) => r.suiteId === suiteId) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Compare two runs for regression detection. Returns metric deltas. */
  async compareRuns(runAId: string, runBId: string): Promise<{ a: EvalSummary; b: EvalSummary; deltas: Record<string, number>; regression: boolean }> {
    const a = await this.runs.get(runAId);
    const b = await this.runs.get(runBId);
    if (!a || !b) throw new Error('evals: run not found');
    const deltas: Record<string, number> = {};
    let regression = false;
    for (const [metric, val] of Object.entries(b.summary.metricAverages)) {
      const oldVal = a.summary.metricAverages[metric] ?? 0;
      const delta = Math.round((val - oldVal) * 1000) / 1000;
      deltas[metric] = delta;
      if (delta < -0.05) regression = true;
    }
    deltas.passRate = Math.round((b.summary.passRate - a.summary.passRate) * 1000) / 1000;
    if (deltas.passRate < -0.05) regression = true;
    return { a: a.summary, b: b.summary, deltas, regression };
  }
}
