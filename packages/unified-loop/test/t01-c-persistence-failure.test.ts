// T-01-C persistence-failure negative test for UPDATE_STATE.
//
// What is verified:
//   * When the UPDATE_STATE capability throws (e.g. the storage
//     backend is unavailable), the loop does NOT report success.
//     The outcome must be FAILED_CLOSED (or HELD/DENIED) and never
//     COMPLETED_VERIFIED.
//   * The same invariant holds for the AUDIT stage: when AUDIT
//     throws, the loop must not falsely report success.
//   * The injected error message is preserved in the failureReason
//     (no silent swallowing).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UnifiedLoopModule,
  buildDefaultCapabilities,
  type CapabilityInvocationContext,
  type CapabilityResult,
  type GovernedCapability,
  type LoopRunResult,
} from '../src/index.js';
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

describe('T-01-C persistence-failure negative test', () => {
  it('UPDATE_STATE failure must NOT be silently swallowed; loop must not report COMPLETED_VERIFIED', async () => {
    const h: Harness = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    const caps: GovernedCapability[] = buildDefaultCapabilities().map((c) =>
      c.stage === 'UPDATE_STATE' ? ({
        ...c,
        invoke: async (_ctx: CapabilityInvocationContext): Promise<CapabilityResult> => {
          throw new Error('injected UPDATE_STATE failure: storage down');
        },
      }) : c,
    );
    const result: LoopRunResult = await svc.runLoop(h.actor, ACTION_TASK, { now: h.now, capabilities: caps });
    assert.notEqual(result.outcome, 'COMPLETED_VERIFIED', `UPDATE_STATE failure must not yield COMPLETED_VERIFIED; got ${result.outcome}`);
    assert.ok(['FAILED_CLOSED', 'HELD', 'DENIED'].includes(result.outcome), `outcome must be FAILED_CLOSED/HELD/DENIED, got ${result.outcome}`);
    assert.ok((result.failureReason ?? '').toLowerCase().includes('update_state') || (result.failureReason ?? '').toLowerCase().includes('update-state'),
      `failureReason must mention UPDATE_STATE; got "${result.failureReason}"`);
  });

  it('AUDIT failure must NOT be silently swallowed; loop must not report COMPLETED_VERIFIED', async () => {
    const h: Harness = await buildHarness();
    const svc = h.kernel.getModule<UnifiedLoopModule>('unified-loop').getService();
    const caps: GovernedCapability[] = buildDefaultCapabilities().map((c) =>
      c.stage === 'AUDIT' ? ({
        ...c,
        invoke: async (_ctx: CapabilityInvocationContext): Promise<CapabilityResult> => {
          throw new Error('injected AUDIT failure');
        },
      }) : c,
    );
    const result = await svc.runLoop(h.actor, ACTION_TASK, { now: h.now, capabilities: caps });
    assert.notEqual(result.outcome, 'COMPLETED_VERIFIED', `AUDIT failure must not yield COMPLETED_VERIFIED; got ${result.outcome}`);
    assert.equal(result.outcome, 'FAILED_CLOSED', `AUDIT failure must be FAILED_CLOSED; got ${result.outcome}`);
  });
});
