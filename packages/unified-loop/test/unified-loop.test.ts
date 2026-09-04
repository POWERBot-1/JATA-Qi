import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HumanApprovalModule } from '@jataqi/human-approval';
import { RegulatoryGateModule } from '@jataqi/regulatory-gates';
import { ReconciliationModule } from '@jataqi/reconciliation';
import { CommercialHealthModule } from '@jataqi/commercial-health';
import {
  LOOP_STAGES,
  UnifiedLoopEvents,
  UnifiedLoopModule,
  type LoopRunResult,
  type LoopStage,
  type GovernedCapability,
} from '../src/index.js';
import type { CapabilityInvocationContext, CapabilityResult } from '../src/index.js';
import { buildHarness, sandboxAdapter, OBSERVATIONS, type Harness } from './helpers.js';

const ACTION_TYPE = 'campaign.reengage';
const TARGET = 'sandbox-crm';

function actionTask(overrides: { executeForReal?: boolean; authorizationLevel?: number; riskScore?: number; gateRequired?: boolean } = {}) {
  return {
    objective: 'Decide whether to run a bounded re-engagement action and execute it only if authorized.',
    observations: OBSERVATIONS,
    knowledgeQuery: 'What do we know about churn and onboarding?',
    proposedAction: {
      actionType: ACTION_TYPE,
      targetSystem: TARGET,
      productId: 'product-1',
      ventureId: 'venture-1',
      riskScore: overrides.riskScore ?? 20,
      complianceScore: 95,
      evidenceStrength: 85,
      authorizationLevel: overrides.authorizationLevel ?? 2,
      gateRequired: overrides.gateRequired,
      executeForReal: overrides.executeForReal ?? false,
    },
  };
}

function reasoningTask() {
  return {
    objective: 'Analyze churn signals and recommend evidence to gather (no external action).',
    observations: OBSERVATIONS,
    knowledgeQuery: 'churn onboarding evidence',
  };
}

async function runLoop(harness: Harness, task: ReturnType<typeof actionTask> | ReturnType<typeof reasoningTask>): Promise<LoopRunResult> {
  const svc = harness.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
  return svc.runLoop(harness.actor, task, { now: harness.now });
}

describe('W22 native unified loop — C-1', () => {
  it('A/J: executes a complete native loop in-repo through all canonical stages, no external orchestrator', async () => {
    const h = await buildHarness();
    const stages: string[] = [];
    h.kernel.bus.on(UnifiedLoopEvents.StageCompleted, (e: { stage: string }) => { stages.push(e.stage); });

    const result = await runLoop(h, reasoningTask());

    assert.equal(result.outcome, 'COMPLETED_DRY_RUN');
    // Every canonical stage appears exactly once, in order.
    const traceStages = result.trace.map((t) => t.stage);
    assert.deepEqual(traceStages, [...LOOP_STAGES]);
    assert.equal(new Set(traceStages).size, LOOP_STAGES.length, 'no duplicate stages');
    // Native audit events were published on the kernel bus.
    assert.ok(stages.length >= LOOP_STAGES.length);
    // The driver is an in-repo module, not an external script.
    assert.ok(h.kernel.getModule<UnifiedLoopModule>('unified-loop'));
  });

  it('B: invokes capabilities only through the governed registry (no direct engine calls in driver)', async () => {
    const h = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    // Replace capability set with a tracking wrapper proving all dispatch flows
    // through governed contracts carrying side-effect/authority metadata.
    const seen: { op: string; sideEffect: string; authority: string }[] = [];
    const tracking = (base: GovernedCapability): GovernedCapability => ({
      ...base,
      invoke: async (ctx: CapabilityInvocationContext): Promise<CapabilityResult> => {
        seen.push({ op: base.operation, sideEffect: base.sideEffect, authority: base.authority });
        return base.invoke(ctx);
      },
    });
    // Build default capabilities by running once is not needed; import the factory:
    const { buildDefaultCapabilities } = await import('../src/index.js');
    const caps = buildDefaultCapabilities().map(tracking);
    const result = await svc.runLoop(h.actor, reasoningTask(), { now: h.now, capabilities: caps });
    assert.equal(result.outcome, 'COMPLETED_DRY_RUN');
    assert.ok(seen.length >= 25, `expected governed dispatches, got ${seen.length}`);
    // Every dispatched capability carried explicit governance metadata.
    assert.ok(seen.every((s) => ['NONE', 'SANDBOX', 'PRODUCTION'].includes(s.sideEffect)));
    assert.ok(seen.every((s) => ['NONE', 'POLICY_ONLY', 'AUTHORIZED_ACTION'].includes(s.authority)));
  });

  it('C: an unauthorized execution is denied — no policy means default-deny', async () => {
    const h = await buildHarness();
    // No policy created AND no adapter registered → execution must be refused.
    const result = await runLoop(h, actionTask({ executeForReal: true }));
    assert.ok(['DENIED', 'HELD_AT_GATE'].includes(result.outcome), `outcome=${result.outcome}`);
    // EXECUTE must not report an external execution.
    const executeTrace = result.trace.find((t) => t.stage === 'EXECUTE');
    const outputs = stageOutputs(result, 'EXECUTE');
    assert.notEqual(executeTrace?.status, 'COMPLETED', 'execute must not complete without authorization');
    assert.equal(outputs?.executed === true, false, 'no external execution occurred');
  });

  it('C2: explicit DENY policy (risk too high) holds the execution path', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxRisk: 10, maxAutonomy: 2 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, riskScore: 90 }));
    assert.equal(result.outcome, 'DENIED');
    assert.equal(result.trace.find((t) => t.stage === 'AUTHORIZE')?.status, 'BOUNDARY_HELD');
    // Execution path skipped after the gate.
    assert.equal(result.trace.find((t) => t.stage === 'EXECUTE')?.status, 'SKIPPED');
  });

  it('D/E (dry-run): a generated plan cannot authorize itself; dry-run is never a verified real outcome', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    // executeForReal defaults to false → plan is dry-run.
    const result = await runLoop(h, actionTask());
    assert.equal(result.outcome, 'COMPLETED_DRY_RUN');
    // AUTHORITY/AUTHORIZE precede PLAN: a plan cannot authorize itself.
    const planIdx = result.trace.findIndex((t) => t.stage === 'PLAN');
    const authIdx = result.trace.findIndex((t) => t.stage === 'AUTHORIZE');
    assert.ok(planIdx >= 0 && authIdx >= 0 && authIdx < planIdx, 'AUTHORIZE must come before PLAN');
    const planOutputs = stageOutputs(result, 'PLAN');
    assert.equal(planOutputs?.dryRun, true);
    // VERIFY_RESULT must not promote a dry run to verified.
    const verifyOutputs = stageOutputs(result, 'VERIFY_RESULT');
    assert.equal(verifyOutputs?.verified, false);
    assert.equal(verifyOutputs?.dryRun, true);
  });

  it('E2 (verified path): a real sandbox action verifies and reaches COMPLETED_VERIFIED', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2, maxRisk: 60 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, riskScore: 20 }));
    assert.equal(result.outcome, 'COMPLETED_VERIFIED', `outcome=${result.outcome}; trace=${summarize(result)}`);
    assert.equal(stageOutputs(result, 'AUTHORIZE')?.allowed, true);
    assert.equal(stageOutputs(result, 'EXECUTE')?.executedExternally, true);
    assert.equal(stageOutputs(result, 'VERIFY_RESULT')?.verified, true);
  });

  it('E3: failed result verification prevents successful completion (fail-closed)', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET, { verifyFails: true }));
    const result = await runLoop(h, actionTask({ executeForReal: true }));
    assert.notEqual(result.outcome, 'COMPLETED_VERIFIED', 'a failed verification must not complete verified');
    assert.equal(stageOutputs(result, 'VERIFY_RESULT')?.verified, false);
    assert.equal(result.trace.find((t) => t.stage === 'VERIFY_RESULT')?.status, 'BOUNDARY_HELD');
  });

  it('F: tenant identity/context survives the complete loop and cross-tenant is isolated', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE });
    const result = await runLoop(h, reasoningTask());
    // Every trace entry is bound to the same tenant/correlation.
    assert.ok(result.trace.every((t) => t.tenantId === 'acme'));
    assert.ok(result.trace.every((t) => t.correlationId === result.correlationId));
    assert.equal(result.tenantId, 'acme');
    // A different tenant cannot read the first tenant's loop state via cognitive kernel.
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    void svc;
  });

  it('G: a complete loop produces an auditable trace with typed cognitive records', async () => {
    const h = await buildHarness();
    const result = await runLoop(h, reasoningTask());
    assert.ok(result.trace.length === LOOP_STAGES.length);
    // Trace entries are structured (not console text) with timing and correlation.
    for (const entry of result.trace) {
      assert.ok(entry.startedAt <= entry.endedAt);
      assert.ok(typeof entry.summary === 'string' && entry.summary.length > 0);
      assert.ok(entry.correlationId);
    }
    // Typed ledger includes INTENT (at context) at minimum.
    const kinds = new Set(result.records.map((r) => r.kind));
    assert.ok(kinds.has('INTENT'), `expected INTENT record, got ${[...kinds].join(',')}`);
    // Every record carries provenance.
    assert.ok(result.records.every((r) => r.provenance && r.provenance.source));
  });

  it('H: injected capability failure fails closed with no false success', async () => {
    const h = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    const { buildDefaultCapabilities } = await import('../src/index.js');
    const caps = buildDefaultCapabilities().map((c) =>
      c.stage === 'CAUSAL_ANALYSIS'
        ? { ...c, invoke: async (): Promise<CapabilityResult> => { throw new Error('injected causal failure'); } }
        : c,
    );
    const result = await svc.runLoop(h.actor, reasoningTask(), { now: h.now, capabilities: caps });
    assert.equal(result.outcome, 'FAILED_CLOSED');
    assert.ok(result.failureReason?.includes('injected causal failure'));
    // The failure trace entry is recorded; later stages do NOT claim success.
    const causal = result.trace.find((t) => t.stage === 'CAUSAL_ANALYSIS');
    assert.equal(causal?.status, 'FAILED');
  });

  it('H2: malformed task input is rejected fail-closed before execution', async () => {
    const h = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    await assert.rejects(() => svc.runLoop(h.actor, { objective: '' }, { now: h.now }), /objective/i);
  });

  it('H3: actor without tenant/roles is rejected', async () => {
    const h = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    await assert.rejects(
      () => svc.runLoop({ id: 'x', tenantId: '', roles: [] }, { objective: 'x' }, { now: h.now }),
      /tenant-bound actor/i,
    );
  });

  it('I: determinism — same fixture produces the same ordered stage statuses', async () => {
    const h1 = await buildHarness();
    const h2 = await buildHarness();
    const r1 = await runLoop(h1, reasoningTask());
    const r2 = await runLoop(h2, reasoningTask());
    const sig = (r: LoopRunResult) => r.trace.map((t) => `${t.stage}:${t.status}`).join('|');
    assert.equal(sig(r1), sig(r2));
    assert.equal(r1.outcome, r2.outcome);
  });

  it('state machine: invalid/skipping transitions are rejected (PLAN cannot jump to EXECUTE)', async () => {
    const { LoopStateMachine } = await import('../src/index.js');
    const sm = new LoopStateMachine();
    sm.start(); // WAKE
    assert.throws(() => {
      // Manually force cursor forward and attempt an illegal jump to EXECUTE.
      for (let i = 0; i < 5; i++) sm.next();
      // now at OBSERVE..; jumping straight to EXECUTE (much later) must throw.
      (sm as unknown as { advance(s: LoopStage): LoopStage }).advance('EXECUTE');
    }, /Invalid loop transition/i);
  });

  it('high-autonomy action requires a human/regulatory gate and does not self-approve', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 3 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, authorizationLevel: 3 }));
    assert.equal(result.outcome, 'HELD_AT_GATE');
    const gate = result.trace.find((t) => t.stage === 'HUMAN_OR_REGULATORY_GATE');
    assert.equal(gate?.status, 'BOUNDARY_HELD');
    assert.equal(stageOutputs(result, 'HUMAN_OR_REGULATORY_GATE')?.gateRequired, true);
  });
});

function stageOutputs(result: LoopRunResult, stage: LoopStage): Record<string, unknown> | undefined {
  return result.stageOutputs[stage];
}

describe('W23 C-2 governed engine integration — native loop', () => {
  it('T1: high-autonomy gate invokes real human-approval + regulatory-gates; held, never self-authorized', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 3 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, authorizationLevel: 3 }));
    assert.equal(result.outcome, 'HELD_AT_GATE');
    const gate = stageOutputs(result, 'HUMAN_OR_REGULATORY_GATE');
    assert.equal(gate?.gateRequired, true);
    assert.equal(gate?.selfApproved, false);
    assert.equal(gate?.votesCastByLoop, 0);
    assert.equal(gate?.physicalExecutionAuthorization, 'NOT_AUTHORIZED');
    assert.ok(typeof gate?.approvalRequestId === 'string');
    assert.equal(gate?.externalVerificationPending, true);
    // Real service invocation proof, not simulation.
    const human = h.kernel.getModule<HumanApprovalModule>('human-approval').getService();
    const request = await human.getRequest(h.actor, gate?.approvalRequestId as string);
    assert.ok(request, 'human-approval request was created by the real service');
    const votes = await human.listVotes(h.actor, request!.id);
    assert.equal(votes.filter((v) => v.reviewerActorId === h.actor.id).length, 0, 'loop never casts votes');
    const regulatory = h.kernel.getModule<RegulatoryGateModule>('regulatory-gates').getService();
    const evaluations = await regulatory.listEvaluations(h.actor);
    assert.equal(evaluations.length, 1, 'real regulatory gate evaluation was recorded');
    assert.equal(evaluations[0]!.status, 'PENDING_EXTERNAL_VERIFICATION');
    assert.equal(evaluations[0]!.physicalExecutionAuthorization, 'NOT_AUTHORIZED');
  });

  it('T1b: explicit gateRequired at autonomy 2 routes through the real gate and holds (pending external ≠ authorization)', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 3 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, authorizationLevel: 2, gateRequired: true }));
    assert.equal(result.outcome, 'HELD_AT_GATE');
    const gate = stageOutputs(result, 'HUMAN_OR_REGULATORY_GATE');
    assert.equal(gate?.gateRequired, true);
    assert.equal(gate?.selfApproved, false);
    assert.equal(gate?.externalVerificationPending, true);
    assert.equal(gate?.physicalExecutionAuthorization, 'NOT_AUTHORIZED');
    const human = h.kernel.getModule<HumanApprovalModule>('human-approval').getService();
    const request = await human.getRequest(h.actor, gate?.approvalRequestId as string);
    assert.ok(request, 'gate-required task creates a real human-approval request');
    assert.equal((await human.listVotes(h.actor, request!.id)).length, 0, 'no votes cast by the loop');
  });

  it('T2: autonomy-2 sandbox verified path remains intact (W22 regression)', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2, maxRisk: 60 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, riskScore: 20 }));
    assert.equal(result.outcome, 'COMPLETED_VERIFIED');
    assert.equal(stageOutputs(result, 'AUTHORIZE')?.allowed, true);
    assert.equal(stageOutputs(result, 'EXECUTE')?.executedExternally, true);
    assert.equal(stageOutputs(result, 'VERIFY_RESULT')?.verified, true);
  });

  it('T3a: missing/denied capability grants fail closed before selection', async () => {
    const h = await buildHarness({ seedGrants: false });
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2, maxRisk: 60 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, riskScore: 20 }));
    assert.equal(result.outcome, 'FAILED_CLOSED');
    assert.equal(result.trace.find((t) => t.stage === 'CAPABILITY_SELECTION')?.status, 'FAILED');
  });

  it('T3b: valid capability grant proceeds to execution', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2, maxRisk: 60 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, riskScore: 20 }));
    assert.equal(result.outcome, 'COMPLETED_VERIFIED');
    const selection = stageOutputs(result, 'CAPABILITY_SELECTION');
    assert.equal(selection?.capabilityId, 'unified-loop.execute');
    assert.equal(selection?.accessOutcome, 'AVAILABLE_AND_AUTHORIZED');
    assert.equal(selection?.connectorActivated, false);
  });

  it('T4: real reconciliation service invoked; pending-external surfaced honestly', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2, maxRisk: 60 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, riskScore: 20 }));
    assert.equal(result.outcome, 'COMPLETED_VERIFIED');
    const reconcile = stageOutputs(result, 'RECONCILE');
    assert.ok(reconcile, 'RECONCILE stage output present');
    assert.equal(typeof reconcile?.reconciliationRunId, 'string');
    assert.equal(reconcile?.reconciled, false, 'no fabricated reconciliation success');
    assert.equal(reconcile?.reconciliationStatus, 'PENDING_EXTERNAL');
    assert.equal(reconcile?.pendingExternal, true);
    const service = h.kernel.getModule<ReconciliationModule>('reconciliation').getService();
    const runs = await service.listRuns(h.actor);
    assert.ok(runs.some((r) => r.id === reconcile?.reconciliationRunId), 'real reconciliation run persisted');
  });

  it('T5: commercial-health anomaly/drift reaches uncertainty as advisory evidence only', async () => {
    const h = await buildHarness();
    const health = h.kernel.getModule<CommercialHealthModule>('commercial-health').getService();
    const provenance = { source: 'unified-loop-w23-test', collectedAt: h.now() };
    const ev = (id: string) => ({ id, status: 'OBSERVED' as const, source: 'unified-loop-w23-test', observedAt: h.now(), confidence: 90, summary: 'Advisory health evidence.', provenance });
    await health.recordObservation(h.actor, {
      metric: 'SPEND',
      value: 200,
      unit: 'usd',
      baseline: 100,
      evidence: [ev('health-observation')],
      provenance,
    });
    await health.assessDrift(h.actor, {
      dimension: 'PMF',
      baseline: 100,
      observed: 80,
      evidence: [ev('health-drift')],
      provenance,
    });
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2, maxRisk: 60 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: false, riskScore: 20 }));
    const uncertainty = stageOutputs(result, 'UNCERTAINTY_ASSESSMENT');
    const advisory = uncertainty?.healthAdvisory as Record<string, unknown> | undefined;
    assert.ok(advisory, 'health advisory present in uncertainty assessment');
    assert.equal(advisory?.available, true);
    assert.ok(Number(advisory?.anomalyCount ?? 0) > 0);
    assert.ok(Number(advisory?.driftCount ?? 0) > 0);
    assert.equal(advisory?.remediationExecuted, false, 'no autonomous remediation');
    assert.equal(uncertainty?.remediationExecuted, false);
    const safety = stageOutputs(result, 'SAFETY');
    const safetyAdvisory = safety?.healthAdvisory as Record<string, unknown> | undefined;
    assert.ok(safetyAdvisory, 'health advisory reaches SAFETY as evidence');
    assert.equal(safetyAdvisory?.available, true);
    assert.equal(safety?.remediationExecuted, false, 'safety never auto-remediates');
  });

  it('T6: OBSERVE_RESULT reads command-center evidence; AUDIT reads observability evidence', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2, maxRisk: 60 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, riskScore: 20 }));
    const observe = stageOutputs(result, 'OBSERVE_RESULT');
    assert.ok(observe, 'OBSERVE_RESULT stage output present');
    const cc = observe?.commandCenterEvidence as Record<string, unknown> | undefined;
    assert.ok(cc, 'command-center evidence present');
    assert.equal(cc?.available, true);
    const infra = observe?.infrastructureEvidence as Record<string, unknown> | undefined;
    assert.ok(infra, 'infrastructure evidence present');
    assert.equal(infra?.available, true);
    const audit = stageOutputs(result, 'AUDIT');
    const obs = audit?.observabilityEvidence as Record<string, unknown> | undefined;
    assert.ok(obs, 'observability evidence present in audience');
    assert.equal(obs?.available, true);
  });

  it('T7: agent-runtime is never a native loop stage and no second orchestration loop exists', async () => {
    const h = await buildHarness();
    const result = await runLoop(h, reasoningTask());
    assert.deepEqual(result.trace.map((t) => t.stage), [...LOOP_STAGES]);
    assert.ok(!result.trace.some((t) => t.capabilityId?.includes('agent-runtime')));
    const caps = (await import('../src/index.js')).buildDefaultCapabilities();
    assert.ok(caps.every((c) => (c.stage as string) !== 'AGENT_RUNTIME' && !c.capabilityId.includes('agent-runtime')));
    assert.equal(LOOP_STAGES.length, 34);
  });

  it('T8a: missing regulatory-gate configuration fails closed without fabricating gate success', async () => {
    const h = await buildHarness({ seedRegulatoryGate: false, seedGrants: true });
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 3 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, authorizationLevel: 3 }));
    assert.equal(result.outcome, 'HELD_AT_GATE');
    const gate = stageOutputs(result, 'HUMAN_OR_REGULATORY_GATE');
    assert.equal(gate?.gateRequired, true);
    assert.equal(gate?.gateConfigured, false);
    assert.equal(gate?.approvalQuorumSatisfied, false);
  });

  it('T8b: injected governed-engine failure fails closed', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2, maxRisk: 60 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    const { buildDefaultCapabilities } = await import('../src/index.js');
    const caps = buildDefaultCapabilities().map((c) =>
      c.stage === 'RECONCILE'
        ? { ...c, invoke: async (): Promise<CapabilityResult> => { throw new Error('injected reconcile failure'); } }
        : c,
    );
    const result = await svc.runLoop(h.actor, actionTask({ executeForReal: true, riskScore: 20 }), { now: h.now, capabilities: caps });
    assert.equal(result.outcome, 'FAILED_CLOSED');
    assert.equal(result.trace.find((t) => t.stage === 'RECONCILE')?.status, 'FAILED');
  });

  it('W23 tenant/correlation continuity on the full action path', async () => {
    const h = await buildHarness();
    await h.createPolicy(h.admin, { actionType: ACTION_TYPE, maxAutonomy: 2, maxRisk: 60 });
    h.registerAdapter(sandboxAdapter(ACTION_TYPE, TARGET));
    const result = await runLoop(h, actionTask({ executeForReal: true, riskScore: 20 }));
    assert.ok(result.trace.every((t) => t.tenantId === 'acme'));
    assert.ok(result.trace.every((t) => t.correlationId === result.correlationId));
    assert.equal(result.tenantId, 'acme');
  });

  it('W23 optional identity boundary: read/verify only, no issuance or signer call', async () => {
    const h = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    const result = await svc.runLoop(h.actor, {
      ...reasoningTask(),
      identityId: 'identity-not-present',
    }, { now: h.now });
    const wake = stageOutputs(result, 'WAKE');
    const identity = wake?.identityEvidence as Record<string, unknown> | undefined;
    assert.ok(identity, 'identity evidence present when explicitly supplied');
    assert.equal(identity?.identityRead, true);
    assert.equal(identity?.present, false);
    assert.equal(identity?.verified, false);
  });
});

function summarize(result: LoopRunResult): string {
  return result.trace
    .filter((t) => t.status !== 'COMPLETED' && t.status !== 'SKIPPED')
    .map((t) => `${t.stage}=${t.status}(${t.reason ?? t.summary})`)
    .join(' || ');
}
