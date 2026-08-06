// ResilienceEngineeringModule tests — Global Resilience Engineering.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient } from '@jataqi/sdk';
import {
  ResilienceEngineeringModule, ResilienceEngine, ResilienceEvents,
  DEFAULT_RECOVERY_STEPS, DEFAULT_TOPOLOGY,
} from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

describe('ResilienceEngine (multi-region topology + failover)', () => {
  it('seeds a geographically distributed topology with roles', () => {
    const e = new ResilienceEngine();
    const regions = e.regionsList();
    assert.equal(regions.length, DEFAULT_TOPOLOGY.length);
    assert.equal(regions[0]!.role, 'primary');
    assert.equal(regions[0]!.name, 'nbo-1');
    assert.equal(regions[1]!.role, 'standby');
    assert.equal(regions[1]!.name, 'lon-1');
    assert.equal(regions[2]!.role, 'readonly');
    assert.deepEqual(e.regionHealth(), { 'nbo-1': 'healthy', 'lon-1': 'healthy', 'syd-1': 'healthy' });
  });

  it('scores health from probes and marks regions down after the threshold', () => {
    const e = new ResilienceEngine();
    e.recordProbe('api', 'nbo-1', true, 12);
    e.recordProbe('api', 'nbo-1', false, 200);
    e.recordProbe('api', 'nbo-1', false, 300);
    assert.equal(e.regionHealth()['nbo-1'], 'degraded');
    e.recordProbe('api', 'nbo-1', false, 400);
    assert.equal(e.regionHealth()['nbo-1'], 'down');
    // Recovery resets failures.
    e.recordProbe('api', 'nbo-1', true, 10);
    assert.equal(e.regionHealth()['nbo-1'], 'healthy');
    assert.equal(e.probesList({ ok: false }).length, 3);
  });

  it('automates failover to the best standby when the primary is down', () => {
    const e = new ResilienceEngine();
    // Take the primary down.
    for (let i = 0; i < 3; i++) e.recordProbe('api', 'nbo-1', false);
    const run = e.evaluateFailover('api');
    assert.ok(run, 'failover triggered');
    assert.equal(run!.fromRegion, 'nbo-1');
    assert.equal(run!.toRegion, 'lon-1', 'best standby promoted');
    assert.equal(run!.status, 'promoted');
    assert.equal(run!.requiresApproval, false, 'automated within authorized boundaries');
    const regions = e.regionsList();
    assert.equal(regions.find((r) => r.name === 'lon-1')!.role, 'primary');
    assert.equal(regions.find((r) => r.name === 'nbo-1')!.role, 'standby');
    // Anti-flapping: immediate re-evaluation does nothing (cooldown).
    assert.equal(e.evaluateFailover('api'), undefined);
  });

  it('manual failback requires an approver and swaps roles back', () => {
    const e = new ResilienceEngine();
    for (let i = 0; i < 3; i++) e.recordProbe('api', 'nbo-1', false);
    e.evaluateFailover('api');
    const back = e.failback('api', 'platform-lead');
    assert.ok(back);
    assert.equal(back!.requiresApproval, true);
    assert.equal(back!.approvedBy, 'platform-lead');
    const regions = e.regionsList();
    assert.equal(regions.find((r) => r.name === 'nbo-1')!.role, 'primary');
    assert.equal(e.failoverHistory().length, 2);
  });
});

describe('ResilienceEngine (DR orchestration + RPO/RTO)', () => {
  it('creates plans with ordered recovery steps', () => {
    const e = new ResilienceEngine();
    const plan = e.createPlan({ workload: 'payments', rpoMs: 15 * 60_000, rtoMs: 30 * 60_000, createdBy: 'sre' });
    assert.equal(plan.steps.length, DEFAULT_RECOVERY_STEPS.length);
    assert.equal(plan.steps[0]!.name, 'Restore from snapshot');
    assert.equal(plan.steps[plan.steps.length - 1]!.name, 'Resume operations');
  });

  it('executes a plan within RTO and reports compliance', () => {
    const e = new ResilienceEngine();
    const plan = e.createPlan({ workload: 'payments', rpoMs: 15 * 60_000, rtoMs: 60_000, createdBy: 'sre' });
    const execution = e.executePlan(plan.id, { snapshotAgeMs: 5 * 60_000 });
    assert.equal(execution.status, 'completed');
    assert.equal(execution.rtoMet, true);
    assert.equal(execution.steps.length, DEFAULT_RECOVERY_STEPS.length);
    const c = e.drCompliance();
    assert.equal(c.compliant, 1);
    assert.equal(c.rtoMet, 1);
    assert.equal(c.rpoMet, 1);
  });

  it('flags RTO violations and injected step failures', () => {
    const e = new ResilienceEngine();
    const tight = e.createPlan({ workload: 'edge', rpoMs: 60_000, rtoMs: 1000, createdBy: 'sre' });
    const violated = e.executePlan(tight.id, { elapsedMs: 2000 });
    assert.equal(violated.status, 'violated');
    assert.equal(violated.rtoMet, false);
    // Injected step failure.
    const plan = e.createPlan({ workload: 'core', rpoMs: 60_000, rtoMs: 60_000, createdBy: 'sre' });
    const failed = e.executePlan(plan.id, { failStep: 'Verify configuration' });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /Verify configuration/);
    // RPO violation via snapshot age.
    const rpoPlan = e.createPlan({ workload: 'ledger', rpoMs: 10 * 60_000, rtoMs: 60_000, createdBy: 'sre' });
    const rpoViolated = e.executePlan(rpoPlan.id, { snapshotAgeMs: 30 * 60_000 });
    assert.equal(rpoViolated.status, 'violated');
  });
});

describe('ResilienceEngine (fault injection + resilience tests + availability)', () => {
  it('injects and ends faults with intensity bounds', () => {
    const e = new ResilienceEngine();
    const fault = e.injectFault({ workload: 'api', kind: 'region_loss', target: 'nbo-1', intensity: 1, durationMs: 60_000 });
    assert.equal(fault.active, true);
    assert.throws(() => e.injectFault({ workload: 'api', kind: 'region_loss', target: 'x', intensity: 2, durationMs: 1000 }), /0\.\.1/);
    assert.equal(e.activeFaults().length, 1);
    e.endFault(fault.id);
    assert.equal(e.activeFaults().length, 0);
    assert.equal(e.faultsList().length, 1);
  });

  it('runs a resilience test: fault + recovery within RTO = survived', () => {
    const e = new ResilienceEngine();
    const plan = e.createPlan({ workload: 'api', rpoMs: 60_000, rtoMs: 60_000, createdBy: 'sre' });
    const result = e.runResilienceTest({
      workload: 'api', kind: 'dependency_failure', target: 'payments-db', intensity: 0.8,
      durationMs: 30_000, planId: plan.id, snapshotAgeMs: 20_000,
    });
    assert.equal(result.survived, true);
    assert.equal(result.execution.status, 'completed');
    assert.equal(result.fault.active, false, 'fault auto-ended after the test');
    // A failing plan → not survived.
    const plan2 = e.createPlan({ workload: 'api2', rpoMs: 60_000, rtoMs: 60_000, createdBy: 'sre' });
    const failed = e.runResilienceTest({
      workload: 'api2', kind: 'data_corruption', target: 'storage', intensity: 1,
      durationMs: 30_000, planId: plan2.id, failStep: 'Validate integrity',
    });
    assert.equal(failed.survived, false);
  });

  it('tracks availability windows and error budgets against SLOs', () => {
    const e = new ResilienceEngine();
    const good = e.recordAvailability({ workload: 'api', windowMs: 30 * 86_400_000, uptime: 0.9999, slo: 0.995 });
    assert.equal(good.uptimeLabel, '99.990%');
    assert.ok(good.errorBudget > 0.5, 'healthy budget');
    const bad = e.recordAvailability({ workload: 'api', windowMs: 30 * 86_400_000, uptime: 0.99, slo: 0.995 });
    assert.equal(bad.errorBudget, 0, 'budget exhausted');
    const summary = e.availabilitySummary();
    const api = summary.find((s) => s.workload === 'api')!;
    assert.equal(api.healthy, false);
    assert.equal(api.uptimeLabel, '99.000%');
    assert.equal(e.stats().availabilityRecords, 2);
  });

  it('aggregates resilience stats', () => {
    const e = new ResilienceEngine();
    assert.equal(e.stats().regions, 3);
    assert.equal(e.stats().primary, 'nbo-1');
    assert.equal(e.stats().standbys, 1);
    assert.equal(e.stats().recoveryPlans, 0);
  });
});

describe('ResilienceEngineeringModule (kernel wiring)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new ResilienceEngineeringModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('emits resilience events and exposes the full surface', async () => {
    const mod = kernel.getModule<ResilienceEngineeringModule>('resilience-engineering');
    const events: string[] = [];
    kernel.bus.on(ResilienceEvents.FailoverCompleted, () => { events.push(ResilienceEvents.FailoverCompleted); });
    kernel.bus.on(ResilienceEvents.FaultInjected, () => { events.push(ResilienceEvents.FaultInjected); });
    kernel.bus.on(ResilienceEvents.SloViolation, () => { events.push(ResilienceEvents.SloViolation); });
    // Take the primary down and fail over.
    for (let i = 0; i < 3; i++) mod.recordProbe('api', 'nbo-1', false);
    const run = mod.evaluateFailover('api');
    assert.ok(run);
    mod.injectFault({ workload: 'api', kind: 'traffic_spike', target: 'edge', intensity: 0.5, durationMs: 10_000 });
    mod.recordAvailability({ workload: 'api', windowMs: 86_400_000, uptime: 0.9, slo: 0.995 });
    assert.ok(events.includes(ResilienceEvents.FailoverCompleted));
    assert.ok(events.includes(ResilienceEvents.FaultInjected));
    assert.ok(events.includes(ResilienceEvents.SloViolation));
    assert.equal(mod.stats().failovers, 1);
    assert.equal(mod.activeFaults().length, 1);
  });
});

describe('Resilience gateway integration (vs real server)', () => {
  let qi: Awaited<ReturnType<CreateJataQi>>;
  let admin: JataQiClient;
  let port: number;
  let closeHandle: () => Promise<void>;

  before(async () => {
    const bootstrapPath = new URL('../../../cli/dist/src/bootstrap.js', import.meta.url).href;
    const mod = await import(bootstrapPath) as unknown as { createJataQi: CreateJataQi };
    qi = await mod.createJataQi({ security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    const handle = await qi.gateway!.listen({ port: 0 });
    port = handle.port;
    closeHandle = handle.close;
    admin = new JataQiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await admin.auth.login('admin', 'admin');
  });

  after(async () => {
    if (closeHandle) await closeHandle();
    if (qi) await qi.shutdown();
  });

  it('exposes topology, health, and stats', async () => {
    const regions = await admin.resilience.regions();
    assert.equal((regions.regions as unknown[]).length, 3);
    const health = await admin.resilience.health();
    assert.ok((health as { regions: Record<string, string> }).regions['nbo-1']);
    const stats = await admin.resilience.stats();
    assert.equal((stats.stats as { regions: number }).regions, 3);
  });

  it('automates failover end-to-end via probes', async () => {
    for (let i = 0; i < 3; i++) {
      await admin.resilience.probe('api', 'nbo-1', false);
    }
    const run = await admin.resilience.failover('api');
    assert.equal((run.run as { status: string }).status, 'promoted');
    assert.equal((run.run as { toRegion: string }).toRegion, 'lon-1');
    // Failback requires approval.
    const back = await admin.resilience.failback('api', 'platform-lead');
    assert.equal((back.run as { requiresApproval: boolean }).requiresApproval, true);
  });

  it('creates plans, executes DR within RTO, and runs a resilience test', async () => {
    const plan = await admin.resilience.createPlan('payments', 15 * 60_000, 60_000, 'sre');
    const planId = (plan.plan as { id: string }).id;
    const exec = await admin.resilience.executePlan(planId, { snapshotAgeMs: 5 * 60_000 });
    assert.equal((exec.execution as { status: string }).status, 'completed');
    const test = await admin.resilience.runTest({
      workload: 'api', kind: 'dependency_failure', target: 'db', intensity: 0.7,
      durationMs: 30_000, planId,
    });
    assert.equal((test as { survived: boolean }).survived, true);
  });

  it('records availability and checks compliance', async () => {
    await admin.resilience.recordAvailability('api', 86_400_000, 0.9995, 0.995);
    const summary = await admin.resilience.availability();
    const api = (summary.availability as Array<{ workload: string; healthy: boolean }>).find((a) => a.workload === 'api')!;
    assert.equal(api.healthy, true);
    const compliance = await admin.resilience.compliance();
    assert.ok(compliance.compliance);
  });
});

describe('DR snapshot provider (RPO wiring)', () => {
  it('measures RPO exposure from the attached DR provider when no age is given', () => {
    const mod = new ResilienceEngineeringModule();
    const kernel = createTestKernel();
    // (module can be used standalone; attach a fake provider)
    mod.attachDrProvider({ latestSnapshotAgeMs: (ns) => (ns === 'ledger' ? 30 * 60_000 : undefined) });
    assert.equal(mod.drProviderAttached(), true);
    const plan = mod.createPlan({ workload: 'ledger', rpoMs: 10 * 60_000, rtoMs: 60_000, createdBy: 'sre' });
    // 30m snapshot age > 10m RPO → violated without any explicit age.
    const execution = mod.executePlan(plan.id);
    assert.equal(execution.status, 'violated', 'RPO breached via DR provider age');
    assert.equal(execution.dataLossMs, 30 * 60_000);
    // Explicit snapshot age overrides the provider.
    const ok = mod.executePlan(plan.id, { snapshotAgeMs: 5 * 60_000 });
    assert.equal(ok.status, 'completed');
  });

  it('leaves executions unchanged without a provider (backward compatible)', () => {
    const mod = new ResilienceEngineeringModule();
    assert.equal(mod.drProviderAttached(), false);
    const plan = mod.createPlan({ workload: 'api', rpoMs: 60_000, rtoMs: 60_000, createdBy: 'sre' });
    const execution = mod.executePlan(plan.id);
    assert.equal(execution.status, 'completed');
    assert.equal(execution.dataLossMs, undefined);
  });
});
