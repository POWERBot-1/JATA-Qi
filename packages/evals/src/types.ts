// JATA Qi Evals — AI evaluation types (#51). Evaluate agents, tools, LLMs and
// workflows for accuracy, reliability, hallucination, tool-use correctness,
// safety, bias, latency, cost and regression.

export interface EvalCase {
  id: string;
  input: string;
  expected?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export type MetricScorer = (actual: string, expected: string | undefined, c: EvalCase) => number;

export interface EvalMetric {
  name: string;
  description?: string;
  /** Returns a score in [0, 1]. 1 = perfect. */
  score: MetricScorer;
}

export interface EvalSuite {
  id: string;
  name: string;
  description?: string;
  cases: EvalCase[];
  metrics: EvalMetric[];
  passThreshold: number;
  createdAt: number;
}

export interface CaseResult {
  caseId: string;
  passed: boolean;
  scores: Record<string, number>;
  averageScore: number;
  actual: string;
  error?: string;
  durationMs: number;
}

export type EvalTargetKind = 'agent' | 'tool' | 'llm' | 'workflow' | 'custom';

export interface EvalTarget {
  kind: EvalTargetKind;
  id: string;
  /** Called with each case's input; returns the system's response. */
  run: (input: string) => Promise<string>;
}

export interface EvalRun {
  id: string;
  suiteId: string;
  suiteName: string;
  target: { kind: EvalTargetKind; id: string };
  results: CaseResult[];
  summary: EvalSummary;
  createdAt: number;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
  durationMs: number;
  metricAverages: Record<string, number>;
}

export const EvalEvents = Object.freeze({
  RunStarted: 'eval.run.started',
  RunCompleted: 'eval.run.completed',
} as const);
