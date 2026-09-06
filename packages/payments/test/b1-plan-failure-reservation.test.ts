import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialControlPlaneService,
  type CommercialEvidence,
} from '@jataqi/commercial-control-plane';
import {
  PaymentCreateActionType,
  PaymentsModule,
  PaymentRefundActionType,
  type PaymentProvider,
  type PaymentsService,
} from '../src/index.js';

/**
 * T-07 B-1 regression suite.
 *
 * B-1: `executePayment` and `requestRefund` take a CAS reservation
 * (DRAFT -> PROCESSING, VERIFIED -> REFUND_PROCESSING) BEFORE calling
 * `runtime.plan`. `runtime.plan` REJECTS on a plan-time refusal (control-plane
 * DENY) rather than returning a falsy value, so the pre-fix `if (!action)`
 * rollback guard was unreachable. The rejection escaped past the committed
 * reservation and stranded the payment in PROCESSING / REFUND_PROCESSING —
 * states that NO entry point accepts as a start state, i.e. a permanent
 * deadlock of that payment.
 *
 * Each case below asserts the full required chain:
 *   PLAN-TIME DENY -> RESERVATION ROLLBACK -> RETRYABLE STATE -> ZERO PROVIDER CALLS
 */

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let control: CommercialControlPlaneService;
let payments: PaymentsService;
let counters: Record<string, number>;

function evidence(id = 'b1-evidence'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'b1-test',
    observedAt: now,
    confidence: 95,
    summary: 'Controlled B-1 evidence.',
    provenance: { source: 'b1-test', collectedAt: now, correlationId: 'b1-correlation' },
  };
}

function provider(): PaymentProvider {
  return {
    id: 'sandbox-pay', currencies: ['KES'], supportsRefunds: true, environment: 'sandbox', maxAttempts: 2, defaultTimeoutMs: 100,
    credentialReference: 'secret://payments/sandbox-pay',
    async createPayment() {
      counters.create = (counters.create ?? 0) + 1;
      return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: 'provider-payment-1', summary: 'Accepted.' };
    },
    async verifyPayment(context) {
      counters.verify = (counters.verify ?? 0) + 1;
      const refund = context.operation === 'REFUND_PAYMENT';
      return {
        verified: true,
        providerStatus: refund ? 'REFUNDED' : 'SUCCEEDED', providerReference: 'provider-payment-1',
        observedAmount: refund ? context.payment.refundAmount : context.payment.amount,
        evidence: [evidence(refund ? 'refund-verification' : 'payment-verification')],
        summary: refund ? 'Refund verified.' : 'Payment verified.',
      };
    },
    async refundPayment() {
      counters.refund = (counters.refund ?? 0) + 1;
      return { reportedSuccess: true, providerStatus: 'REFUNDED', providerReference: 'provider-refund-1', summary: 'Refund accepted.' };
    },
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  counters = {};
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  payments = kernel.getModule<PaymentsModule>('payments').getService();
  await control.createPolicy(admin, {
    version: 'b1-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [PaymentCreateActionType, PaymentRefundActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
  payments.registerProvider(admin, provider());
});

async function intent() {
  return payments.createIntent(operator, {
    productId: 'product-1', ventureId: 'venture-1', customerReference: 'customer-hash-1', invoiceId: 'invoice-1', purpose: 'subscription payment',
    amount: { amount: 100, currency: 'KES' }, providerId: 'sandbox-pay', idempotencyKey: 'b1-intent-1',
  });
}

async function financialDecision(actionType: string, amount = 100) {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', ventureId: 'venture-1', objective: 'Perform a bounded payment operation.',
    proposedAction: actionType === PaymentCreateActionType ? 'Create the approved payment.' : 'Refund the approved amount.', actionType,
    estimatedCost: { amount, currency: 'KES' }, evidence: [evidence()], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85,
    authorizationLevel: 2, decisionReason: 'Amount, provider, and evidence are explicitly bounded.',
    provenance: { source: 'b1-test', collectedAt: now, correlationId: 'b1-correlation' },
  });
}

/** Deterministic plan-time DENY: a SPENDING kill switch over the tenant. */
async function setSpendingKillSwitch(active: boolean) {
  await control.setKillSwitch(admin, {
    scopeType: 'SPENDING', scope: { tenantId: 'acme' }, active,
    reason: 'B-1 regression: force a deterministic plan-time DENY.',
  });
}

describe('T-07 B-1: plan-time failure releases the CAS reservation', () => {
  it('collect: a plan-time DENY leaves the payment retryable in DRAFT with zero provider calls', async () => {
    const created = await intent();
    assert.equal(created.status, 'DRAFT');
    const decision = await financialDecision(PaymentCreateActionType);
    await setSpendingKillSwitch(true);

    // PLAN-TIME DENY: rejects, and the original control-plane refusal survives.
    await assert.rejects(
      () => payments.executePayment(operator, created.id, { decisionId: decision.id, idempotencyKey: 'b1-collect', dryRun: false }),
      (error: Error) => {
        assert.match(error.message, /kill switch|authorization outcome is DENY/i, `original refusal must be preserved, got: ${error.message}`);
        return true;
      },
    );

    // ZERO PROVIDER CALLS: the DENY fails closed before any provider contact.
    assert.equal(counters.create ?? 0, 0, 'a denied plan must never reach the provider');

    // RESERVATION ROLLBACK: not stranded in PROCESSING.
    const after = await payments.getPayment(operator, created.id);
    assert.ok(after);
    assert.notEqual(after.status, 'PROCESSING', 'B-1: payment must not be stranded in PROCESSING');
    assert.equal(after.status, 'DRAFT', 'reservation must restore the exact prior state');
    assert.equal(after.createActionId, undefined, 'no action may be bound by a denied plan');

    // RETRYABLE: once the DENY is lifted the same payment proceeds normally.
    await setSpendingKillSwitch(false);
    const retried = await payments.executePayment(operator, created.id, { decisionId: decision.id, idempotencyKey: 'b1-collect', dryRun: false });
    assert.equal(retried.status, 'SUCCEEDED_UNVERIFIED', 'B-1: the payment must not be deadlocked');
    assert.equal(counters.create, 1);
  });

  it('refund: a plan-time DENY leaves the payment retryable in VERIFIED with zero provider calls', async () => {
    const created = await intent();
    const collect = await financialDecision(PaymentCreateActionType);
    await payments.executePayment(operator, created.id, { decisionId: collect.id, idempotencyKey: 'b1-collect-ok', dryRun: false });
    const verified = await payments.verifyPayment(operator, created.id);
    assert.equal(verified.status, 'VERIFIED');

    const refundDecision = await financialDecision(PaymentRefundActionType, 40);
    await setSpendingKillSwitch(true);

    await assert.rejects(
      () => payments.requestRefund(operator, created.id, {
        amount: { amount: 40, currency: 'KES' }, reason: 'B-1 refund test.', decisionId: refundDecision.id, idempotencyKey: 'b1-refund', dryRun: false,
      }),
      (error: Error) => {
        assert.match(error.message, /kill switch|authorization outcome is DENY/i, `original refusal must be preserved, got: ${error.message}`);
        return true;
      },
    );

    assert.equal(counters.refund ?? 0, 0, 'a denied refund plan must never reach the provider');

    const after = await payments.getPayment(operator, created.id);
    assert.ok(after);
    assert.notEqual(after.status, 'REFUND_PROCESSING', 'B-1: refund must not be stranded in REFUND_PROCESSING');
    assert.equal(after.status, 'VERIFIED', 'reservation must restore VERIFIED');
    assert.equal(after.refundAmount, undefined, 'the speculative refundAmount must be rolled back too');
    assert.equal(after.refundActionId, undefined, 'no refund action may be bound by a denied plan');

    await setSpendingKillSwitch(false);
    const retried = await payments.requestRefund(operator, created.id, {
      amount: { amount: 40, currency: 'KES' }, reason: 'B-1 refund retry.', decisionId: refundDecision.id, idempotencyKey: 'b1-refund', dryRun: false,
    });
    assert.equal(retried.status, 'REFUND_UNVERIFIED', 'B-1: the refund must not be deadlocked');
    assert.equal(counters.refund, 1);
  });

  it('collect: a falsy plan result also releases the reservation', async () => {
    const created = await intent();
    const decision = await financialDecision(PaymentCreateActionType);
    // The defensive `!action` branch is unreachable through the real runtime
    // (plan() rejects instead). Force it directly so both failure shapes —
    // thrown DENY and falsy/null result — are covered by regression.
    const runtime = (payments as unknown as { runtime: { plan: unknown } }).runtime;
    const original = runtime.plan;
    runtime.plan = async () => undefined;
    try {
      await assert.rejects(
        () => payments.executePayment(operator, created.id, { decisionId: decision.id, idempotencyKey: 'b1-falsy', dryRun: false }),
        /could not be planned/,
      );
    } finally {
      runtime.plan = original;
    }

    assert.equal(counters.create ?? 0, 0);
    const after = await payments.getPayment(operator, created.id);
    assert.ok(after);
    assert.equal(after.status, 'DRAFT', 'a falsy plan result must not strand the payment');
    assert.equal(after.createActionId, undefined);
  });

  it('refund: a falsy plan result also releases the reservation', async () => {
    const created = await intent();
    const collect = await financialDecision(PaymentCreateActionType);
    await payments.executePayment(operator, created.id, { decisionId: collect.id, idempotencyKey: 'b1-collect-ok2', dryRun: false });
    await payments.verifyPayment(operator, created.id);
    const refundDecision = await financialDecision(PaymentRefundActionType, 40);

    const runtime = (payments as unknown as { runtime: { plan: unknown } }).runtime;
    const original = runtime.plan;
    runtime.plan = async () => undefined;
    try {
      await assert.rejects(
        () => payments.requestRefund(operator, created.id, {
          amount: { amount: 40, currency: 'KES' }, reason: 'B-1 falsy refund.', decisionId: refundDecision.id, idempotencyKey: 'b1-refund-falsy', dryRun: false,
        }),
        /could not be planned/,
      );
    } finally {
      runtime.plan = original;
    }

    assert.equal(counters.refund ?? 0, 0);
    const after = await payments.getPayment(operator, created.id);
    assert.ok(after);
    assert.equal(after.status, 'VERIFIED', 'a falsy plan result must not strand the refund');
    assert.equal(after.refundAmount, undefined);
  });

  it('preserves R-01 fail-closed authorization: a denied plan never binds an action or advances state', async () => {
    const created = await intent();
    const decision = await financialDecision(PaymentCreateActionType);
    await setSpendingKillSwitch(true);

    // Repeated denied attempts must be idempotent in effect: still DRAFT,
    // still no action, still no provider call. The release path must not
    // itself become a way to advance or corrupt state.
    for (const key of ['b1-deny-1', 'b1-deny-2', 'b1-deny-3']) {
      await assert.rejects(() => payments.executePayment(operator, created.id, { decisionId: decision.id, idempotencyKey: key, dryRun: false }));
      const state = await payments.getPayment(operator, created.id);
      assert.equal(state?.status, 'DRAFT');
      assert.equal(state?.createActionId, undefined);
    }
    assert.equal(counters.create ?? 0, 0);
  });
});
