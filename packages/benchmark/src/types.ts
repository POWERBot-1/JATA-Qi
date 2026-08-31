// Types for Universal Capability Benchmark and Continuous Evaluation Engine

export type BenchmarkCategory =
  | 'reasoning'
  | 'mathematics'
  | 'coding'
  | 'tool_use'
  | 'planning'
  | 'memory'
  | 'reliability'
  | 'hallucination_control';

export interface BenchmarkTask {
  taskId: string;
  category: BenchmarkCategory;
  prompt: string;
  expectedOutputMatcher: (output: string) => boolean;
  maxLatencyMs: number;
}

export interface TaskResult {
  taskId: string;
  category: BenchmarkCategory;
  success: boolean;
  latencyMs: number;
  output: string;
  error?: string;
}

export interface BenchmarkReport {
  suiteId: string;
  timestamp: string;
  totalTasks: number;
  passedTasks: number;
  accuracyRate: number;
  avgLatencyMs: number;
  categoryScores: Record<BenchmarkCategory, { passed: number; total: number; score: number }>;
}

export interface EvaluationGateConfig {
  minAccuracyRate: number;
  maxAvgLatencyMs: number;
  maxErrorRate: number;
  requiredCategories: BenchmarkCategory[];
}
