// O-01 loop-host service acceptance (O6–O12, O15–O24, O26–O27).
//
// Dispatch tests run against the REAL governed unified loop (default runner)
// unless a test explicitly injects a fake runner. Nothing here weakens W22/W23
// semantics: every dispatch re-enters the full 34-stage loop.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { HumanApprovalModule } from '@jataqi/human-approval';
import { CapabilityFabricModule } from '@jataqi/capability-fabric';
import {
  LOOP_STAGES,
  UnifiedLoopEvents,
  type LoopOutcome,
  type LoopRunResult,
  type LoopTask,
} from '@jataqi/unified-loop';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import type { AuthenticatedPrincipal } from '@jataqi/authentication';
import {
  InvalidWorkTransitionError,
  LoopHostEvents,
  LoopHostService,
  TenantIsolationError,
  WORK_COLLECTION,
  type HostedWorkItem,
  type LoopRunner,
} from '../src/index.js';
import { testPrincipalFor, buildHarness, gateTask, reasoningTask, sandboxAdapter, type Harness } from './helpers.js';

function fakeRunner(
  outcome: LoopOutcome,
  hooks: { onCall?: (actor: CommercialActor, task: LoopTask, opts: { correlationId: string }) => void; failTimes?: number; error?: Error } = {},
): LoopRunner & { calls: () => number } {
  let calls = 0;
  const runner = (async (actor: CommercialActor, task: LoopTask, opts: { correlationId: string; now: () => number; signal: AbortSignal; principal: AuthenticatedPrincipal }) => {
    calls += 1;
    hooks.onCall?.(actor, task, opts);
    if (hooks.failTimes !== undefined && calls <= hooks.failTimes) throw hooks.error ?? new Error('Fake runner transient failure.');
    const at = opts.now();
    const result: LoopRunResult = {
      loopId: `loop-fake-${calls}`,
      correlationId: opts.correlationId,
      tenantId: actor.tenantId,
      outcome,
      trace: [],
      stageOutputs: {},
      records: [],
      finalStage: 'OUTCOME',
      startedAt: at,
      endedAt: at,
      continuation: 'TERMINATE',
    };
    return result;
  }) as LoopRunner & { calls: () => number };
  runner.calls = () => calls;
  return runner;
}

function collectHostEvents(h: Harness): Array<{ event: string; payload: Record<string, unknown> }> {
  const seen: Array<{ event: string; payload: Record<string, unknown> }> = [];
  for (const name of Object.values(LoopHostEvents)) {
    h.kernel.bus.on(name, (payload: unknown) => {
      seen.push({ event: name, payload: payload as Record<string, unknown> });
    });
  }
  return seen;
}

function spyOn<T extends object>(obj: T, method: keyof T & string): { count: () => number; restore: () => void } {
  const orig = (obj as Record<string, unknown>)[method];
  if (typeof orig !== 'function') throw new Error(`Cannot spy on ${String(method)}: not a function.`);
  let calls = 0;
  (obj as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
    calls += 1;
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
  return { count: () => calls, restore: () => { (obj as Record<string, unknown>)[method] = orig; } };
}

function actionTask(overrides: { executeForReal?: boolean; authorizationLevel?: number; gateRequired?: boolean } = {}) {
  return {
    objective: 'Decide whether to run a bounded re-engagement action and execute it only if authorized.',
    observations: ['Acme churn declined after onboarding improvements.'],
    knowledgeQuery: 'churn onboarding evidence',
    proposedAction: {
      actionType: 'campaign.reengage',
      targetSystem: 'sandbox-crm',
      productId: 'product-1',
      ventureId: 'venture-1',
      riskScore: 20,
      complianceScore: 95,
      evidenceStrength: 85,
      authorizationLevel: overrides.authorizationLevel ?? 2,
      gateRequired: overrides.gateRequired,
      executeForReal: overrides.executeForReal ?? false,
    },
  };
}

describe('O-01 host lifecycle (O23)', () => {
  it('O23: explicit start, safe drain, deterministic stop; no work without start', async () => {
    const h = await buildHarness();
    const svc = h.host();
    assert.equal(svc.getLifecycle(), 'IDLE');
    await assert.rejects(() => svc.tick(), /RUNNING/);
    svc.start();
    assert.equal(svc.getLifecycle(), 'RUNNING');
    assert.throws(() => svc.start(), /already running/);
    await svc.stop();
    assert.equal(svc.getLifecycle(), 'STOPPED');
    await assert.rejects(() => svc.tick(), /RUNNING/);
    await svc.stop(); // idempotent stop
    assert.equal(svc.getLifecycle(), 'STOPPED');
  });
});

describe('O-01 dispatch through the real governed loop (O21, O22)', () => {
  it('O21: 34-stage W22/W23 regression stays green behind the host (COMPLETED_DRY_RUN, 34 stages)', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.start();
    const events: unknown[] = [];
    h.kernel.bus.on(UnifiedLoopEvents.LoopCompleted, (payload: unknown) => { events.push(payload); });
    const item = await svc.enqueue(h.actor,  { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    const summary = await svc.tick();
    assert.equal(summary.dispatched, 1);
    assert.equal(summary.completed, 1);
    const settled = await svc.get(h.actor, item.id);
    assert.equal(settled?.status, 'COMPLETED');
    assert.equal(settled?.loopOutcome, 'COMPLETED_DRY_RUN');
    assert.equal(events.length, 1);
  });

  it('O22: exactly one orchestration runs per dispatch — no second loop exists', async () => {
    const h = await buildHarness();
    assert.equal(LOOP_STAGES.length, 34);
    const svc = h.host();
    svc.start();
    let completed = 0;
    let stages = 0;
    h.kernel.bus.on(UnifiedLoopEvents.LoopCompleted, () => { completed += 1; });
    h.kernel.bus.on(UnifiedLoopEvents.StageCompleted, () => { stages += 1; });
    h.kernel.bus.on(UnifiedLoopEvents.BoundaryHeld, () => { stages += 1; });
    await svc.enqueue(h.actor,  { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
    await svc.tick();
    assert.equal(completed, 1);
    assert.equal(stages, 34);
  });
});

describe('O-01 crash, resume, and continuity (O6, O8, O9, O10)', () => {
  async function crashSetup(): Promise<{ h: Harness; item: HostedWorkItem; runner: LoopRunner & { calls: () => number } }> {
    const h = await buildHarness();
    const svc = h.host();
    const runner = fakeRunner('COMPLETED_DRY_RUN', { failTimes: 1 });
    svc.setRunner(runner);
    svc.start();
    const item = await svc.enqueue(h.actor,  { task: reasoningTask(), correlationId: 'corr-resume-1', baseDelayMs: 0, maxDelayMs: 0 }, await testPrincipalFor(h.actor, h.now()));
    await svc.tick(); // attempt 1 throws mid-dispatch (crash) → requeued
    const failed = await svc.get(h.actor, item.id);
    assert.equal(failed?.status, 'QUEUED');
    assert.equal(failed?.attemptCount, 1);
    // Simulate host death between markDispatched and settle: force the
    // record back to DISPATCHED with an expired lease, keeping its checkpoint.
    const storage = h.kernel.getModule<StorageModule>('storage');
    const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
    const raw = await items.get(item.id);
    assert.ok(raw?.checkpointId);
    await items.put({ ...raw, status: 'DISPATCHED', leaseOwner: 'dead-host', leaseToken: 'dead-token', leaseExpiry: h.now() - 1 });
    return { h, item, runner };
  }

  it('O6/O8: crash-mid-loop resumes via full redispatch and completes — never fabricated', async () => {
    const { h, item, runner } = await crashSetup();
    const svc = h.host();
    const recovered = await svc.recover();
    assert.equal(recovered.reclaimed, 1);
    assert.equal(recovered.requeued, 1);
    const summary = await svc.tick();
    assert.equal(summary.dispatched, 1);
    assert.equal(summary.completed, 1);
    assert.equal(runner.calls(), 2); // proof of real re-execution, not fabrication
    const settled = await svc.get(h.actor, item.id);
    assert.equal(settled?.status, 'COMPLETED');
    assert.equal(settled?.attemptCount, 2);
    assert.equal(settled?.correlationId, 'corr-resume-1');
    assert.equal(settled?.loopOutcome, 'COMPLETED_DRY_RUN');
  });

  it('O9/O10: resume preserves tenant and correlation identity end to end', async () => {
    const { h, item } = await crashSetup();
    const svc = h.host();
    let seenCorrelation: string | undefined;
    let seenTenant: string | undefined;
    const runner = fakeRunner('COMPLETED_DRY_RUN', {
      onCall: (actor, _task, opts) => { seenCorrelation = opts.correlationId; seenTenant = actor.tenantId; },
    });
    svc.setRunner(runner);
    await svc.recover();
    await svc.tick();
    assert.equal(seenCorrelation, 'corr-resume-1');
    assert.equal(seenTenant, 'acme');
    const settled = await svc.get(h.actor, item.id);
    assert.equal(settled?.tenantId, 'acme');
    // Cross-tenant observers learn nothing.
    await assert.rejects(() => svc.get(h.other, item.id), TenantIsolationError);
  });

  it('O8: exhausted attempts dead-letter instead of completing', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.setRunner(fakeRunner('COMPLETED_DRY_RUN', { failTimes: 99 }));
    svc.start();
    await svc.enqueue(h.actor,  { task: reasoningTask(), maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }, await testPrincipalFor(h.actor, h.now()));
    const summary = await svc.tick();
    assert.equal(summary.deadLettered, 1);
    assert.equal(summary.completed, 0);
    const items = await svc.list(h.actor, { status: 'DLQ' });
    assert.equal(items.length, 1);
  });
});

describe('O-01 corrupt checkpoints fail closed (O7)', () => {
  it('O7: tampered checkpoint quarantines to DLQ without dispatch', async () => {
    const h = await buildHarness();
    const svc = h.host();
    const runner = fakeRunner('COMPLETED_DRY_RUN', { failTimes: 1 });
    svc.setRunner(runner);
    svc.start();
    const item = await svc.enqueue(h.actor,  { task: reasoningTask(), baseDelayMs: 0, maxDelayMs: 0 }, await testPrincipalFor(h.actor, h.now()));
    await svc.tick(); // failed attempt leaves a valid DISPATCHED checkpoint behind
    const storage = h.kernel.getModule<StorageModule>('storage');
    const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
    const raw = await items.get(item.id);
    assert.ok(raw?.checkpointId);
    const ckpts = await storage.collection<{ id: string; attempt: number } & Record<string, unknown>>('loop-host.checkpoints');
    const ckpt = await ckpts.get(raw.checkpointId);
    assert.ok(ckpt);
    await ckpts.put({ ...ckpt, attempt: 99 }); // tamper: integrity now invalid
    await items.put({ ...raw, status: 'DISPATCHED', leaseOwner: 'dead-host', leaseToken: 'dead-token', leaseExpiry: h.now() - 1 });
    const callsBefore = runner.calls();
    const recovered = await svc.recover();
    assert.equal(recovered.quarantined, 1);
    assert.equal(runner.calls(), callsBefore); // never dispatched
    const dead = await svc.get(h.actor, item.id);
    assert.equal(dead?.status, 'DLQ');
    assert.ok((dead?.dlqReason ?? '').length > 0);
  });
});

describe('O-01 gates re-evaluated on resume; no stale approval (O11, O12, O18)', () => {
  it('O11/O12: HELD work resumes into a full re-evaluation and holds again without new approval', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.start();
    const item = await svc.enqueue(h.actor,  { task: gateTask() }, await testPrincipalFor(h.actor, h.now()));
    const first = await svc.tick();
    assert.equal(first.held, 1);
    const held = await svc.get(h.actor, item.id);
    assert.equal(held?.status, 'HELD');
    assert.equal(held?.loopOutcome, 'HELD_AT_GATE');
    // No approval exists yet and the host cast no vote.
    const approvals = h.kernel.getModule<HumanApprovalModule>('human-approval').getService();
    const requests = await approvals.listRequests(h.admin);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.status, 'PENDING');
    assert.deepEqual(await approvals.listVotes(h.admin, requests[0]?.id ?? ''), []);
    // Explicit operator resume re-runs the whole loop and holds again.
    await svc.resume(h.actor, item.id);
    const second = await svc.tick();
    assert.equal(second.held, 1);
    const heldAgain = await svc.get(h.actor, item.id);
    assert.equal(heldAgain?.status, 'HELD');
    assert.equal(heldAgain?.attemptCount, 2);
    assert.equal(heldAgain?.correlationId, held?.correlationId);
    assert.deepEqual(await approvals.listVotes(h.admin, requests[0]?.id ?? ''), []);
  });
});

describe('O-01 DENY and kill-switch win (O15)', () => {
  it('O15: an active kill switch turns an otherwise-verifiable action into terminal DENIED', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: 'campaign.reengage' });
    h.registerAdapter(sandboxAdapter('campaign.reengage', 'sandbox-crm'));
    const control = h.kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    await control.setKillSwitch(h.admin, { scopeType: 'TENANT', scope: { tenantId: 'acme' }, active: true, reason: 'O-01 kill-switch-wins test.' });
    const svc = h.host();
    svc.start();
    const item = await svc.enqueue(h.actor,  { task: actionTask({ executeForReal: true }) }, await testPrincipalFor(h.actor, h.now()));
    const summary = await svc.tick();
    assert.equal(summary.denied, 1);
    assert.equal(summary.completed, 0);
    const denied = await svc.get(h.actor, item.id);
    assert.equal(denied?.status, 'DENIED');
    assert.equal(denied?.attemptCount, 1); // never retried: retry must not manufacture authorization
    // A second pass leaves the terminal record untouched.
    const again = await svc.tick();
    assert.equal(again.examined, 0);
  });
});

describe('O-01 scheduler triggers without authorizing (O16)', () => {
  it('O16: future work waits; due work dispatches through the runner (governed path)', async () => {
    const h = await buildHarness();
    const svc = h.host();
    const seen: string[] = [];
    svc.setRunner(fakeRunner('COMPLETED_DRY_RUN', { onCall: (_a, _t, opts) => { seen.push(opts.correlationId); } }));
    svc.start();
    await svc.enqueue(h.actor,  { task: reasoningTask(), correlationId: 'future-1', availableAt: h.now() + 60_000 }, await testPrincipalFor(h.actor, h.now()));
    const early = await svc.tick();
    assert.equal(early.dispatched, 0);
    assert.equal(seen.length, 0);
    h.advance(60_001);
    const due = await svc.tick();
    assert.equal(due.dispatched, 1);
    assert.deepEqual(seen, ['future-1']);
  });

  it('O16: the host surface exposes no authority verbs and depends on nothing authoritative', async () => {
    const h = await buildHarness();
    void h;
    const methods = Object.getOwnPropertyNames(LoopHostService.prototype);
    const forbidden = ['authoriz', 'approv', 'vote', 'grant', 'execut', 'verif', 'remed', 'signer', 'policy'];
    for (const name of methods) {
      for (const fragment of forbidden) {
        assert.ok(!name.toLowerCase().includes(fragment), `Host must not expose "${name}" (contains "${fragment}").`);
      }
    }
    const { LoopHostModule } = await import('../src/index.js');
    const mod = new LoopHostModule();
    assert.deepEqual([...(mod.dependsOn ?? [])], ['storage', 'unified-loop']);
  });
});

describe('O-01 governance negatives — host creates nothing authoritative (O17, O19, O20)', () => {
  it('O17/O19: dispatch performs zero control-plane authorization/decision calls and zero capability grants', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.setRunner(fakeRunner('COMPLETED_DRY_RUN'));
    const control = h.kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    const fabric = h.kernel.getModule<CapabilityFabricModule>('capability-fabric').getService();
    const spies = [
      spyOn(control, 'proposeDecision'),
      spyOn(control, 'authorizeDecision'),
      spyOn(control, 'planAction'),
      spyOn(control, 'verifyAction'),
      spyOn(fabric, 'grantCapability'),
    ];
    const before = await control.replayEvents(h.admin, {});
    try {
      svc.start();
      await svc.enqueue(h.actor,  { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
      await svc.tick();
      for (const spy of spies) assert.equal(spy.count(), 0);
      const after = await control.replayEvents(h.admin, {});
      assert.equal(after.length, before.length); // the host wrote no commercial events at all
    } finally {
      for (const spy of spies) spy.restore();
    }
  });

  it('O20: real-loop dispatch executes zero production adapters (none registered, none invoked)', async () => {
    const h = await buildHarness();
    const svc = h.host();
    const runtime = h.kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
    assert.deepEqual(runtime.listAdapters(), []);
    const spy = spyOn(runtime, 'execute');
    try {
      svc.start();
      await svc.enqueue(h.actor,  { task: reasoningTask() }, await testPrincipalFor(h.actor, h.now()));
      await svc.tick();
      assert.equal(spy.count(), 0);
      assert.deepEqual(runtime.listAdapters(), []);
    } finally {
      spy.restore();
    }
  });
});

describe('O-01 retries, DLQ, and idempotent replay at service level (O13, O14, O26)', () => {
  it('O13/O14: bounded retries then DLQ with lifecycle events', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.setRunner(fakeRunner('COMPLETED_DRY_RUN', { failTimes: 99 }));
    svc.start();
    const seen = collectHostEvents(h);
    const item = await svc.enqueue(h.actor,  { task: reasoningTask(), maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 }, await testPrincipalFor(h.actor, h.now()));
    const first = await svc.tick();
    assert.equal(first.retried, 1);
    const second = await svc.tick();
    assert.equal(second.deadLettered, 1);
    const dead = await svc.get(h.actor, item.id);
    assert.equal(dead?.status, 'DLQ');
    assert.equal(dead?.attemptCount, 2);
    const names = seen.map((entry) => entry.event);
    assert.ok(names.includes(LoopHostEvents.WorkQueued));
    assert.ok(names.includes(LoopHostEvents.Retried));
    assert.ok(names.includes(LoopHostEvents.DeadLettered));
  });

  it('O26: duplicate enqueue is idempotent; terminal DENIED work is never resumed', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.setRunner(fakeRunner('DENIED'));
    svc.start();
    const first = await svc.enqueue(h.actor,  { task: reasoningTask(), idempotencyKey: 'dup-1' }, await testPrincipalFor(h.actor, h.now()));
    const second = await svc.enqueue(h.actor,  { task: reasoningTask(), idempotencyKey: 'dup-1' }, await testPrincipalFor(h.actor, h.now()));
    assert.equal(first.id, second.id);
    await svc.tick();
    const denied = await svc.get(h.actor, first.id);
    assert.equal(denied?.status, 'DENIED');
    await assert.rejects(() => svc.resume(h.actor, first.id), InvalidWorkTransitionError);
  });
});

describe('O-01 multi-tenant isolation across the full lifecycle (O24)', () => {
  it('O24: queue, lease, checkpoint, resume, and dispatch stay tenant-bound', async () => {
    const h = await buildHarness();
    const svc = h.host();
    const dispatchedTenants: string[] = [];
    svc.setRunner(fakeRunner('COMPLETED_DRY_RUN', { onCall: (actor) => { dispatchedTenants.push(actor.tenantId); } }));
    svc.start();
    const acme = await svc.enqueue(h.actor,  { task: reasoningTask(), correlationId: 'corr-acme' }, await testPrincipalFor(h.actor, h.now()));
    const other = await svc.enqueue(h.other,  { task: reasoningTask(), correlationId: 'corr-other' }, await testPrincipalFor(h.other, h.now()));
    // Cross-tenant resume is refused.
    await assert.rejects(() => svc.resume(h.other, acme.id), TenantIsolationError);
    // Cross-tenant checkpoint reads are refused.
    await svc.tick();
    const settled = await svc.get(h.actor, acme.id);
    assert.ok(settled?.checkpointId);
    await assert.rejects(() => svc.readCheckpoint(h.other, settled?.checkpointId ?? ''), /not authorized/);
    assert.deepEqual([...dispatchedTenants].sort(), ['acme', 'other']);
    const acmeAgain = await svc.get(h.actor, acme.id);
    const otherAgain = await svc.get(h.other, other.id);
    assert.equal(acmeAgain?.correlationId, 'corr-acme');
    assert.equal(otherAgain?.correlationId, 'corr-other');
  });
});

describe('O-01 observability without governance bypass (O27)', () => {
  it('O27: host lifecycle is observable, tenant/correlation-bound, and content-free', async () => {
    const h = await buildHarness();
    const svc = h.host();
    svc.setRunner(fakeRunner('COMPLETED_DRY_RUN'));
    const seen = collectHostEvents(h);
    svc.start();
    const item = await svc.enqueue(h.actor,  { task: reasoningTask(), correlationId: 'corr-obs' }, await testPrincipalFor(h.actor, h.now()));
    await svc.tick();
    const names = seen.map((entry) => entry.event);
    for (const required of [LoopHostEvents.WorkQueued, LoopHostEvents.LeaseAcquired, LoopHostEvents.Dispatched, LoopHostEvents.CheckpointWritten, LoopHostEvents.Completed]) {
      assert.ok(names.includes(required), `missing host event ${required}`);
    }
    for (const entry of seen) {
      // Host-lifecycle events are operator-scope ('*'); every work-scoped
      // event must carry its tenant.
      if (entry.event === LoopHostEvents.HostStarted || entry.event === LoopHostEvents.HostStopped) {
        assert.equal(entry.payload.tenantId, '*');
      } else {
        assert.equal(entry.payload.tenantId, 'acme');
        assert.equal(entry.payload.correlationId, 'corr-obs');
      }
      assert.equal(entry.payload.hostId, svc.getHostId());
      assert.ok(!('task' in (entry.payload as object)), 'host events must not carry task content');
      assert.ok(!('objective' in (entry.payload as object)), 'host events must not carry objective text');
    }
    void item;
  });
});
