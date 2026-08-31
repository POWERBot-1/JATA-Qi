// Universal Capability Benchmark Suite runner.

import type { BenchmarkTask, BenchmarkReport, BenchmarkCategory } from './types.js';

export class UniversalBenchmark {
  private readonly tasks: BenchmarkTask[] = [];

  registerTask(task: BenchmarkTask): void {
    this.tasks.push(task);
  }

  async runSuite(
    suiteId: string,
    executor: (prompt: string) => Promise<string>
  ): Promise<BenchmarkReport> {
    const results: Array<{ task: BenchmarkTask; success: boolean; latencyMs: number; output: string }> = [];
    const categoryStats: Record<BenchmarkCategory, { passed: number; total: number }> = {
      reasoning: { passed: 0, total: 0 },
      mathematics: { passed: 0, total: 0 },
      coding: { passed: 0, total: 0 },
      tool_use: { passed: 0, total: 0 },
      planning: { passed: 0, total: 0 },
      memory: { passed: 0, total: 0 },
      reliability: { passed: 0, total: 0 },
      hallucination_control: { passed: 0, total: 0 },
    };

    for (const task of this.tasks) {
      categoryStats[task.category].total++;
      const start = Date.now();
      try {
        const output = await executor(task.prompt);
        const latencyMs = Date.now() - start;
        const success = task.expectedOutputMatcher(output) && latencyMs <= task.maxLatencyMs;
        if (success) {
          categoryStats[task.category].passed++;
        }
        results.push({ task, success, latencyMs, output });
      } catch {
        const latencyMs = Date.now() - start;
        results.push({ task, success: false, latencyMs, output: '' });
      }
    }

    const totalTasks = results.length;
    const passedTasks = results.filter((r) => r.success).length;
    const accuracyRate = totalTasks > 0 ? Number((passedTasks / totalTasks).toFixed(3)) : 0;
    const totalLatency = results.reduce((acc, r) => acc + r.latencyMs, 0);
    const avgLatencyMs = totalTasks > 0 ? Math.round(totalLatency / totalTasks) : 0;

    const categoryScores: Record<BenchmarkCategory, { passed: number; total: number; score: number }> = {} as any;
    for (const cat of Object.keys(categoryStats) as BenchmarkCategory[]) {
      const stats = categoryStats[cat];
      categoryScores[cat] = {
        passed: stats.passed,
        total: stats.total,
        score: stats.total > 0 ? Number((stats.passed / stats.total).toFixed(3)) : 1.0,
      };
    }

    return {
      suiteId,
      timestamp: new Date().toISOString(),
      totalTasks,
      passedTasks,
      accuracyRate,
      avgLatencyMs,
      categoryScores,
    };
  }
}
