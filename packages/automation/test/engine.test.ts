// Phase 6 — AutomationEngine unit tests: registry validation, manual runs,
// action sequences + failure semantics, timeouts, concurrency caps, schedule
// ticking, event triggers with filters, chaining depth guard, stats.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationEngine } from '../src/index.js';
import type { ActionRunner, ActionResult, AutomationAction, AutomationExecution, RunContext } from '../src/index.js';

/** Mock runner with scriptable results per action type. */
function makeRunner(behavior?: { perType?: Record<string, () => ActionResult | Promise<ActionResult>>; hang?: boolean }) {
  const calls: Array<{ action: AutomationAction; ctx: RunContext }> = [];
  const runner: ActionRunner = {
    async run(action, ctx) {
      calls.push({ action, ctx });
      if (behavior?.hang) return new Promise(() => { /* never resolves */ });
      const fn = behavior?.perType?.[action.type];
      if (fn) return fn();
      return { action: action.type, status: 'ok', durationMs: 1 };
    },
  };
  return { runner, calls };
}

const action = (type: string, overrides: Partial<AutomationAction> = {}): AutomationAction => ({
  type: type as AutomationAction['type'], params: {}, ...overrides,
});

describe('AutomationEngine', () => {
  it('registers and lists automations with validation', async () => {
    const { runner } = makeRunner();
    const engine = new AutomationEngine(runner);
    const a = engine.register({
      name: 'Nightly digest', createdBy: 'admin',
      trigger: { type: 'schedule', intervalMs: 60_000 },
      actions: [action('memory.record', { params: { summary: 'digest' } })],
    });
    assert.ok(a.id);
    assert.equal(a.enabled, true);
    assert.equal(engine.get(a.id)?.name, 'Nightly digest');
    assert.equal(engine.list({ trigger: 'schedule' }).length, 1);
    assert.throws(() => engine.register({
      name: '', createdBy: 'admin', trigger: { type: 'manual' }, actions: [action('memory.record')],
    }), /name/);
    assert.throws(() => engine.register({
      name: 'x', createdBy: 'admin', trigger: { type: 'schedule', intervalMs: 0 }, actions: [action('memory.record')],
    }), /intervalMs/);
    assert.throws(() => engine.register({
      name: 'x', createdBy: 'admin', trigger: { type: 'event', event: '' }, actions: [action('memory.record')],
    }), /event/);
  });

  it('runs manual automations sequentially and records results', async () => {
    const { runner, calls } = makeRunner({ perType: {
      'memory.record': () => ({ action: 'memory.record', status: 'ok', detail: 'event abc', durationMs: 1 }),
      'notification.send': () => ({ action: 'notification.send', status: 'ok', durationMs: 1 }),
    } });
    const engine = new AutomationEngine(runner);
    const a = engine.register({
      name: 'Notify on event', createdBy: 'admin', trigger: { type: 'manual' },
      actions: [action('memory.record'), action('notification.send')],
    });
    const exec = await engine.run({ automationId: a.id, trigger: 'manual', payload: { severity: 'high' } });
    assert.equal(exec.status, 'succeeded');
    assert.equal(exec.results.length, 2);
    assert.equal(exec.results[0]!.status, 'ok');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.ctx.payload, { severity: 'high' });
    assert.equal(engine.get(a.id)!.runCount, 1);
    assert.equal(engine.get(a.id)!.lastStatus, 'succeeded');
  });

  it('fails fast on action error unless continueOnError is set', async () => {
    const { runner } = makeRunner({ perType: {
      'memory.record': () => ({ action: 'memory.record', status: 'error', detail: 'rejected', durationMs: 1 }),
      'notification.send': () => ({ action: 'notification.send', status: 'ok', durationMs: 1 }),
    } });
    const engine = new AutomationEngine(runner);
    const a = engine.register({
      name: 'fail-fast', createdBy: 'admin', trigger: { type: 'manual' },
      actions: [action('memory.record'), action('notification.send')],
    });
    const exec = await engine.run({ automationId: a.id });
    assert.equal(exec.status, 'failed');
    assert.equal(exec.results.length, 1);
    assert.match(exec.error ?? '', /memory.record failed/);

    const b = engine.register({
      name: 'continue-on-error', createdBy: 'admin', trigger: { type: 'manual' },
      actions: [action('memory.record', { continueOnError: true }), action('notification.send')],
    });
    const exec2 = await engine.run({ automationId: b.id });
    assert.equal(exec2.status, 'succeeded');
    assert.equal(exec2.results.length, 2);
    assert.equal(exec2.results[0]!.status, 'error');
  });

  it('times out slow runs and marks the execution', async () => {
    const { runner } = makeRunner({ hang: true });
    const engine = new AutomationEngine(runner);
    const a = engine.register({
      name: 'slow', createdBy: 'admin', trigger: { type: 'manual' }, timeoutMs: 30,
      actions: [action('memory.record')],
    });
    const exec = await engine.run({ automationId: a.id });
    assert.equal(exec.status, 'timeout');
    assert.match(exec.error ?? '', /timed out/);
  });

  it('skips runs beyond the concurrency cap and when disabled', async () => {
    const { runner } = makeRunner({ hang: true });
    const engine = new AutomationEngine(runner);
    const a = engine.register({
      name: 'serial', createdBy: 'admin', trigger: { type: 'manual' }, maxConcurrency: 1, timeoutMs: 200,
      actions: [action('memory.record')],
    });
    const first = engine.run({ automationId: a.id });
    const second = await engine.run({ automationId: a.id });
    assert.equal(second.status, 'skipped');
    assert.match(second.error ?? '', /concurrency cap/);
    const firstExec = await first;
    assert.equal(firstExec.status, 'timeout');

    engine.setEnabled(a.id, false);
    const disabled = await engine.run({ automationId: a.id });
    assert.equal(disabled.status, 'skipped');
    assert.match(disabled.error ?? '', /disabled/);
  });

  it('ticks schedule triggers deterministically', async () => {
    const { runner, calls } = makeRunner();
    const engine = new AutomationEngine(runner);
    const a = engine.register({
      name: 'hourly', createdBy: 'admin', trigger: { type: 'schedule', intervalMs: 1000 },
      actions: [action('memory.record')],
    });
    const t0 = Date.now();
    const before = await engine.tick(t0);
    assert.equal(before.length, 0);
    const runs = await engine.tick(t0 + 1001);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, 'succeeded');
    assert.equal(runs[0]!.trigger, 'schedule');
    // Not due again until the interval elapses.
    assert.equal((await engine.tick(t0 + 1500)).length, 0);
    assert.equal((await engine.tick(t0 + 2002)).length, 1);
    assert.equal(calls.length, 2);
    assert.equal(engine.get(a.id)!.runCount, 2);
  });

  it('handles event triggers with payload filters', async () => {
    const { runner, calls } = makeRunner();
    const engine = new AutomationEngine(runner);
    const a = engine.register({
      name: 'on-critical', createdBy: 'admin',
      trigger: { type: 'event', event: 'incident.raised', filter: { field: 'severity', value: 'critical' } },
      actions: [action('notification.send')],
    });
    assert.equal(engine.handleEvent('incident.raised', { severity: 'low' }), 0);
    assert.equal(calls.length, 0);
    assert.equal(engine.handleEvent('incident.raised', { severity: 'critical' }), 1);
    assert.equal(engine.handleEvent('other.event', { severity: 'critical' }), 0);
    // Wait for the fire-and-forget run to complete.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1);
    assert.equal(engine.get(a.id)!.runCount, 1);
  });

  it('returns execution history and aggregate stats', async () => {
    const { runner } = makeRunner();
    const engine = new AutomationEngine(runner);
    const a = engine.register({
      name: 'stat-test', createdBy: 'admin', trigger: { type: 'manual' },
      actions: [action('memory.record')],
    });
    await engine.run({ automationId: a.id });
    await engine.run({ automationId: a.id });
    const stats = engine.stats();
    assert.equal(stats.total, 1);
    assert.equal(stats.enabled, 1);
    assert.equal(stats.executions, 2);
    assert.equal(stats.succeeded, 2);
    assert.equal(stats.byTrigger.manual, 1);
    assert.equal(stats.byStatus.succeeded, 2);
    assert.equal(engine.executionsList({ automationId: a.id }).length, 2);
    assert.equal(engine.executionsList({ status: 'succeeded' }).length, 2);
  });

  it('guards chained automation depth', async () => {
    const { runner } = makeRunner();
    const engine = new AutomationEngine(runner);
    assert.equal(AutomationEngine.chainDepthOk(3), true);
    assert.equal(AutomationEngine.chainDepthOk(4), false);
  });
});
