// T-01 34-stage contract + mandatory-stage enforcement tests.
//
// What is verified:
//   * LOOP_STAGES is exactly 34 entries.
//   * LOOP_STAGES is in the canonical order mandated by T-01 (AUTHORIZE
//     precedes CAPABILITY_SELECTION, PLAN, VERIFY_PLAN, EXECUTE).
//   * Mandatory-stage audit correctly reports ok for a complete run.
//   * Mandatory-stage audit correctly flags a SKIPPED mandatory stage
//     for a non-gate reason.
//   * Mandatory-stage audit correctly tolerates a SKIPPED mandatory
//     stage when a governance gate held (the gate hold is the reason).
//   * A custom capability set that omits a mandatory stage causes the
//     loop to fail closed (FAILED_CLOSED).
//   * MANDATORY_FOR_ACTION includes AUTHORIZE; verifying that an action
//     loop cannot bypass the AUTHORIZE stage.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALWAYS_MANDATORY,
  LOOP_STAGES,
  MANDATORY_FOR_ACTION,
  UnifiedLoopModule,
  auditMandatoryStages,
  type MandatoryStageAudit,
} from '../src/index.js';
import type { CapabilityInvocationContext, CapabilityResult, GovernedCapability, LoopRunResult } from '../src/index.js';
import { buildHarness, type Harness } from './helpers.js';

const ACTION_TASK = {
  objective: 'Decide whether to run a bounded re-engagement action and execute it only if authorized.',
  observations: ['some observation'],
  proposedAction: {
    actionType: 'campaign.reengage',
    targetSystem: 'sandbox-crm',
    productId: 'product-1',
    ventureId: 'venture-1',
    riskScore: 20,
    complianceScore: 95,
    evidenceStrength: 85,
    authorizationLevel: 2,
    executeForReal: false,
  },
};

describe('T-01 canonical 34-stage contract', () => {
  it('LOOP_STAGES contains exactly 34 entries in the mandated order', () => {
    assert.equal(LOOP_STAGES.length, 34, 'exactly 34 stages');
    // The first three and last three are stable across all W22/W23/O-01/P-01/R-01 milestones.
    assert.equal(LOOP_STAGES[0], 'WAKE');
    assert.equal(LOOP_STAGES[1], 'OBSERVE');
    assert.equal(LOOP_STAGES[LOOP_STAGES.length - 3], 'AUDIT');
    assert.equal(LOOP_STAGES[LOOP_STAGES.length - 2], 'OUTCOME');
    assert.equal(LOOP_STAGES[LOOP_STAGES.length - 1], 'CONTINUE_OR_SLEEP');
    // The T-01 contract hardens AUTHORIZE to run AFTER the
    // human/regulatory gate and BEFORE capability selection.
    const authorizeIdx = LOOP_STAGES.indexOf('AUTHORIZE');
    const capabilitySelectionIdx = LOOP_STAGES.indexOf('CAPABILITY_SELECTION');
    const planIdx = LOOP_STAGES.indexOf('PLAN');
    const verifyPlanIdx = LOOP_STAGES.indexOf('VERIFY_PLAN');
    const humanGateIdx = LOOP_STAGES.indexOf('HUMAN_OR_REGULATORY_GATE');
    assert.ok(authorizeIdx > humanGateIdx, 'AUTHORIZE runs after HUMAN_OR_REGULATORY_GATE');
    assert.ok(authorizeIdx < capabilitySelectionIdx, 'AUTHORIZE runs before CAPABILITY_SELECTION');
    assert.ok(authorizeIdx < planIdx, 'AUTHORIZE runs before PLAN');
    assert.ok(authorizeIdx < verifyPlanIdx, 'AUTHORIZE runs before VERIFY_PLAN');
  });

  it('MANDATORY_FOR_ACTION includes AUDIT and OUTCOME', () => {
    assert.ok(MANDATORY_FOR_ACTION.has('AUDIT'));
    assert.ok(MANDATORY_FOR_ACTION.has('OUTCOME'));
    assert.ok(MANDATORY_FOR_ACTION.has('AUTHORIZE'));
  });

  it('ALWAYS_MANDATORY is the minimum for any loop (reasoning or action)', () => {
    assert.ok(ALWAYS_MANDATORY.has('AUDIT'));
    assert.ok(ALWAYS_MANDATORY.has('OUTCOME'));
    assert.ok(ALWAYS_MANDATORY.has('CONTINUE_OR_SLEEP'));
  });
});

describe('T-01 mandatory-stage audit (auditMandatoryStages)', () => {
  it('reports ok for a fully-completed trace with all mandatory stages', () => {
    const trace = LOOP_STAGES.map((stage) => ({ stage, status: 'COMPLETED' as const }));
    const audit: MandatoryStageAudit = auditMandatoryStages(trace, MANDATORY_FOR_ACTION, new Set(LOOP_STAGES));
    assert.equal(audit.ok, true, 'ok');
    assert.deepEqual([...audit.skippedMandatory], []);
    assert.deepEqual([...audit.missingMandatory], []);
    assert.deepEqual([...audit.notCompleted], []);
  });

  it('flags a SKIPPED mandatory stage for a non-gate reason', () => {
    const trace = LOOP_STAGES.map((stage) => {
      if (stage === 'AUDIT') return { stage, status: 'SKIPPED' as const, reason: 'random skip not related to a gate' };
      return { stage, status: 'COMPLETED' as const };
    });
    const audit = auditMandatoryStages(trace, MANDATORY_FOR_ACTION, new Set(LOOP_STAGES));
    assert.equal(audit.ok, false, 'ok must be false');
    assert.ok(audit.skippedMandatory.includes('AUDIT'));
  });

  it('tolerates a SKIPPED mandatory stage when a governance gate held (latch is documented)', () => {
    const trace = LOOP_STAGES.map((stage) => {
      if (stage === 'AUTHORIZE') return { stage, status: 'BOUNDARY_HELD' as const };
      if (stage === 'CAPABILITY_SELECTION' || stage === 'PLAN' || stage === 'VERIFY_PLAN' || stage === 'EXECUTE' ||
          stage === 'OBSERVE_RESULT' || stage === 'VERIFY_RESULT' || stage === 'RECONCILE') {
        return { stage, status: 'SKIPPED' as const, reason: 'Skipped after governance boundary held: AUTHORIZE: denied' };
      }
      return { stage, status: 'COMPLETED' as const };
    });
    const audit = auditMandatoryStages(trace, MANDATORY_FOR_ACTION, new Set(LOOP_STAGES));
    assert.equal(audit.ok, true, 'audit should tolerate the cascade after a governance gate held');
  });

  it('flags a missing mandatory stage that never ran', () => {
    // Remove AUDIT from the trace; audit must report missing.
    const trace = LOOP_STAGES.filter((s) => s !== 'AUDIT').map((stage) => ({ stage, status: 'COMPLETED' as const }));
    const audit = auditMandatoryStages(trace, MANDATORY_FOR_ACTION, new Set(LOOP_STAGES));
    assert.equal(audit.ok, false);
    assert.ok(audit.missingMandatory.includes('AUDIT'));
  });

  it('flags a mandatory stage that did not reach COMPLETED or BOUNDARY_HELD', () => {
    const trace = LOOP_STAGES.map((stage) => {
      if (stage === 'AUTHORIZE') return { stage, status: 'FAILED' as const };
      return { stage, status: 'COMPLETED' as const };
    });
    const audit = auditMandatoryStages(trace, MANDATORY_FOR_ACTION, new Set(LOOP_STAGES));
    assert.equal(audit.ok, false);
    assert.ok(audit.notCompleted.includes('AUTHORIZE'));
  });
});

describe('T-01 mandatory-stage enforcement at runtime', () => {
  it('a custom capability set that omits a mandatory stage causes the loop to fail closed', async () => {
    const h: Harness = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    // Default capabilities minus AUDIT — must fail closed. The exact
    // failure reason may be either the pre-audit "Required governed
    // capability for AUDIT is not registered" check OR the post-loop
    // "Mandatory-stage invariant violated" check; both are valid
    // fail-closed paths and T-01 only requires the loop not report
    // success.
    const { buildDefaultCapabilities } = await import('../src/index.js');
    const caps = buildDefaultCapabilities().filter((c) => c.stage !== 'AUDIT') as GovernedCapability[];
    const result: LoopRunResult = await svc.runLoop(h.actor, ACTION_TASK, { now: h.now, capabilities: caps });
    assert.equal(result.outcome, 'FAILED_CLOSED', 'missing AUDIT must fail closed');
    const reason = (result.failureReason ?? '').toLowerCase();
    assert.ok(
      reason.includes('mandatory-stage invariant violated') || reason.includes('audit') || reason.includes('not registered'),
      `expected mandatory-stage or audit-related failure, got: ${result.failureReason}`,
    );
  });

  it('a custom capability set that omits OUTCOME causes the loop to fail closed', async () => {
    const h: Harness = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    const { buildDefaultCapabilities } = await import('../src/index.js');
    const caps = buildDefaultCapabilities().filter((c) => c.stage !== 'OUTCOME') as GovernedCapability[];
    const result = await svc.runLoop(h.actor, ACTION_TASK, { now: h.now, capabilities: caps });
    assert.equal(result.outcome, 'FAILED_CLOSED', 'missing OUTCOME must fail closed');
  });

  it('a custom capability set that omits AUTHORIZE causes the loop to fail closed', async () => {
    const h: Harness = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    const { buildDefaultCapabilities } = await import('../src/index.js');
    const caps = buildDefaultCapabilities().filter((c) => c.stage !== 'AUTHORIZE') as GovernedCapability[];
    const result = await svc.runLoop(h.actor, ACTION_TASK, { now: h.now, capabilities: caps });
    assert.equal(result.outcome, 'FAILED_CLOSED', 'missing AUTHORIZE must fail closed');
  });

  it('a custom capability that throws at AUDIT causes the loop to fail closed (no false success)', async () => {
    const h: Harness = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    const { buildDefaultCapabilities } = await import('../src/index.js');
    const caps: GovernedCapability[] = buildDefaultCapabilities().map((c) =>
      c.stage === 'AUDIT' ? ({
        ...c,
        invoke: async (_ctx: CapabilityInvocationContext): Promise<CapabilityResult> => {
          throw new Error('injected AUDIT failure');
        },
      }) : c,
    );
    const result = await svc.runLoop(h.actor, ACTION_TASK, { now: h.now, capabilities: caps });
    assert.equal(result.outcome, 'FAILED_CLOSED');
    assert.ok((result.failureReason ?? '').toLowerCase().includes('audit'));
  });
});
