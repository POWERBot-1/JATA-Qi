import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { EvalsModule, exactMatch, contains, tokenOverlap } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('EvalsModule', () => {
  let kernel: Kernel;
  let evals: EvalsModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new EvalsModule());
    await kernel.boot();
    evals = kernel.getModule<EvalsModule>('evals');
  });

  it('creates a suite with cases and metrics', async () => {
    const suite = await evals.createSuite({
      name: 'Agent QA',
      cases: [
        { input: 'What is 2+2?', expected: '4' },
        { input: 'Capital of Kenya?', expected: 'Nairobi' },
      ],
      metrics: [exactMatch, contains],
      passThreshold: 0.5,
    });
    assert.equal(suite.cases.length, 2);
    assert.equal(suite.metrics.length, 2);
    assert.equal(suite.passThreshold, 0.5);
  });

  it('runs a suite against a target and scores results', async () => {
    const suite = await evals.createSuite({
      name: 'Math',
      cases: [
        { input: '2+2', expected: '4' },
        { input: '3+3', expected: '6' },
        { input: 'wrong', expected: 'correct' },
      ],
      metrics: [exactMatch],
      passThreshold: 0.5,
    });
    const run = await evals.run(suite.id, {
      kind: 'custom', id: 'test-target',
      async run(input) {
        if (input === '2+2') return '4';
        if (input === '3+3') return '6';
        return 'wrong answer';
      },
    });
    assert.equal(run.summary.total, 3);
    assert.equal(run.summary.passed, 2); // first two pass, third fails
    assert.equal(run.summary.failed, 1);
    assert.ok(run.summary.passRate > 0.6);
  });

  it('records metric averages per run', async () => {
    const suite = await evals.createSuite({
      name: 'T',
      cases: [{ input: 'hello', expected: 'hello world' }],
      metrics: [contains, tokenOverlap],
    });
    const run = await evals.run(suite.id, { kind: 'custom', id: 't', async run() { return 'hello world'; } });
    assert.equal(run.summary.metricAverages.contains, 1);
    assert.ok(run.summary.metricAverages.token_overlap > 0);
  });

  it('handles target errors gracefully (score 0)', async () => {
    const suite = await evals.createSuite({
      name: 'Err', cases: [{ input: 'x', expected: 'y' }], metrics: [exactMatch],
    });
    const run = await evals.run(suite.id, { kind: 'custom', id: 't', async run() { throw new Error('crash'); } });
    assert.equal(run.results[0]!.error, 'crash');
    assert.equal(run.results[0]!.averageScore, 0);
    assert.equal(run.results[0]!.passed, false);
  });

  it('compares runs and detects regression', async () => {
    const suite = await evals.createSuite({
      name: 'Regression',
      cases: [{ input: 'q', expected: 'good' }],
      metrics: [exactMatch],
    });
    const runA = await evals.run(suite.id, { kind: 'custom', id: 'v1', async run() { return 'good'; } });
    const runB = await evals.run(suite.id, { kind: 'custom', id: 'v2', async run() { return 'bad'; } });
    const cmp = await evals.compareRuns(runA.id, runB.id);
    assert.equal(cmp.regression, true); // v2 is worse
    assert.ok(cmp.deltas.exact_match < 0);
  });

  it('lists runs newest first', async () => {
    const suite = await evals.createSuite({ name: 'L', cases: [{ input: 'x' }], metrics: [] });
    await evals.run(suite.id, { kind: 'custom', id: 'a', async run() { return 'r'; } });
    await evals.run(suite.id, { kind: 'custom', id: 'b', async run() { return 'r'; } });
    const runs = await evals.listRuns(suite.id);
    assert.equal(runs.length, 2);
    assert.ok(runs[0]!.createdAt >= runs[1]!.createdAt);
  });

  it('emits lifecycle events', async () => {
    let started = 0; let completed = 0;
    kernel.bus.on('eval.run.started', () => { started++; });
    kernel.bus.on('eval.run.completed', () => { completed++; });
    const suite = await evals.createSuite({ name: 'E', cases: [{ input: 'x' }], metrics: [] });
    await evals.run(suite.id, { kind: 'custom', id: 't', async run() { return 'r'; } });
    assert.equal(started, 1);
    assert.equal(completed, 1);
  });
});
