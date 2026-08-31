// Unit tests for Universal Capability Benchmark & Continuous Evaluation Engine

import test from 'node:test';
import assert from 'node:assert';
import { UniversalBenchmark, ContinuousEvaluator, HallucinationEngine } from '../src/index.js';

test('UniversalBenchmark runs task suites and calculates accuracy and latency metrics', async () => {
  const benchmark = new UniversalBenchmark();

  benchmark.registerTask({
    taskId: 't-1',
    category: 'reasoning',
    prompt: 'What is 2 + 2?',
    expectedOutputMatcher: (out) => out.includes('4'),
    maxLatencyMs: 1000,
  });

  benchmark.registerTask({
    taskId: 't-2',
    category: 'coding',
    prompt: 'Write a function returning true',
    expectedOutputMatcher: (out) => out.includes('true'),
    maxLatencyMs: 1000,
  });

  const report = await benchmark.runSuite('suite-alpha', async (prompt) => {
    if (prompt.includes('2 + 2')) return 'The answer is 4.';
    return 'function test() { return true; }';
  });

  assert.strictEqual(report.totalTasks, 2);
  assert.strictEqual(report.passedTasks, 2);
  assert.strictEqual(report.accuracyRate, 1.0);
  assert.ok(report.categoryScores['reasoning']);
  assert.strictEqual(report.categoryScores['reasoning']!.score, 1.0);
});

test('ContinuousEvaluator enforces release gates and detects violations', () => {
  const evaluator = new ContinuousEvaluator();

  const report = {
    suiteId: 'suite-beta',
    timestamp: new Date().toISOString(),
    totalTasks: 10,
    passedTasks: 8,
    accuracyRate: 0.80,
    avgLatencyMs: 400,
    categoryScores: {
      reasoning: { passed: 4, total: 5, score: 0.80 },
      mathematics: { passed: 4, total: 5, score: 0.80 },
      coding: { passed: 0, total: 0, score: 1.0 },
      tool_use: { passed: 0, total: 0, score: 1.0 },
      planning: { passed: 0, total: 0, score: 1.0 },
      memory: { passed: 0, total: 0, score: 1.0 },
      reliability: { passed: 0, total: 0, score: 1.0 },
      hallucination_control: { passed: 0, total: 0, score: 1.0 },
    },
  };

  const gatePass = evaluator.evaluateGate(report, {
    minAccuracyRate: 0.75,
    maxAvgLatencyMs: 500,
    maxErrorRate: 0.30,
    requiredCategories: ['reasoning'],
  });
  assert.strictEqual(gatePass.promoted, true);

  const gateFail = evaluator.evaluateGate(report, {
    minAccuracyRate: 0.90,
    maxAvgLatencyMs: 300,
    maxErrorRate: 0.10,
    requiredCategories: ['reasoning'],
  });
  assert.strictEqual(gateFail.promoted, false);
  assert.ok(gateFail.violations.length > 0);
});

test('HallucinationEngine detects unsupported claims and requires uncertainty', () => {
  const engine = new HallucinationEngine();
  const evidence = ['JATA Qi is a modular AI operating system with a plugin kernel.', 'Gitanya Kariuki created JATA Qi in Kenya.'];

  const valid = engine.validateClaim('JATA Qi was created by Gitanya Kariuki.', evidence);
  assert.strictEqual(valid.supported, true);
  assert.ok(valid.confidence > 0.9);

  const hallucinated = engine.validateClaim('JATA Qi runs entirely on quantum processors on Mars.', evidence);
  assert.strictEqual(hallucinated.supported, false);
  assert.ok(hallucinated.message.includes("I DON'T KNOW"));
});
