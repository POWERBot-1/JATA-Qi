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
  PaymentError,
  PaymentsModule,
  PaymentRefundActionType,
  type PaymentProvider,
  type PaymentsService,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let payments: PaymentsService;
let paymentEvents: string[];

function evidence(id = 'payment-evidence'): CommercialEvidence {
  return {
    id,
    status: 'MEASURED',
    source: 'payments-test',
    observedAt: now,
    confidence: 95,
    summary: 'Controlled payment evidence.',
    provenance: { source: 'payments-test', collectedAt: now, correlationId: 'payment-correlation' },
  };
}

function provider(counters: Record<string, number>, mismatch = false): PaymentProvider {
  return {
    id: 'sandbox-pay', currencies: ['KES'], supportsRefunds: true, environment: 'sandbox', maxAttempts: 2, defaultTimeoutMs: 100,
    credentialReference: 'secret://payments/sandbox-pay',
    async createPayment() {
      counters.create = (counters.create ?? 0) + 1;
      return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: 'provider-payment-1', summary: 'Sandbox provider accepted payment.' };
    },
    async verifyPayment(context) {
      counters.verify = (counters.verify ?? 0) + 1;
      const refund = context.operation === 'REFUND_PAYMENT';
      return {
        verified: true,
        providerStatus: refund ? 'REFUNDED' : 'SUCCEEDED', providerReference: 'provider-payment-1',
        observedAmount: mismatch ? { amount: context.payment.amount.amount + 1, currency: context.payment.amount.currency } : refund ? context.payment.refundAmount : context.payment.amount,
        evidence: [evidence(refund ? 'refund-verification' : 'payment-verification')],
        summary: refund ? 'Sandbox refund verified.' : 'Sandbox payment verified.',
      };
    },
    async refundPayment() {
      counters.refund = (counters.refund ?? 0) + 1;
      return { reportedSuccess: true, providerStatus: 'REFUNDED', providerReference: 'provider-refund-1', summary: 'Sandbox refund accepted.' };
    },
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  paymentEvents = [];
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  kernel.bus.on('payment.verified', () => { paymentEvents.push('verified'); });
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  payments = kernel.getModule<PaymentsModule>('payments').getService();
  await control.createPolicy(admin, {
    version: 'payments-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [PaymentCreateActionType, PaymentRefundActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function intent() {
  return payments.createIntent(operator, {
    productId: 'product-1', ventureId: 'venture-1', customerReference: 'customer-hash-1', invoiceId: 'invoice-1', purpose: 'subscription payment',
    amount: { amount: 100, currency: 'KES' }, providerId: 'sandbox-pay', idempotencyKey: 'payment-intent-1',
  });
}

async function financialDecision(actionType: string, amount = 100) {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', ventureId: 'venture-1', objective: 'Perform a bounded payment operation.',
    proposedAction: actionType === PaymentCreateActionType ? 'Create the approved payment.' : 'Refund the approved amount.', actionType,
    estimatedCost: { amount, currency: 'KES' }, evidence: [evidence()], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85,
    authorizationLevel: 2, decisionReason: 'Amount, provider, and evidence are explicitly bounded.',
    provenance: { source: 'payments-test', collectedAt: now, correlationId: 'payment-correlation' },
  });
}

describe('Payments', () => {
  it('does not create an intent without an explicitly registered provider', async () => {
    await assert.rejects(() => intent(), PaymentError);
  });

  it('records a provider response as unverified and recognizes payment only after verification', async () => {
    const counters: Record<string, number> = {};
    payments.registerProvider(admin, provider(counters));
    const created = await intent();
    assert.equal(created.status, 'DRAFT');
    const proposed = await financialDecision(PaymentCreateActionType);
    const reported = await payments.executePayment(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'payment-action-1', dryRun: false });
    assert.equal(reported.status, 'SUCCEEDED_UNVERIFIED');
    assert.equal(paymentEvents.length, 0, 'unverified provider success is not revenue/payout evidence');
    assert.equal(counters.create, 1);

    const verified = await payments.verifyPayment(operator, created.id);
    assert.equal(verified.status, 'VERIFIED');
    assert.equal(verified.providerReference, 'provider-payment-1');
    assert.equal(paymentEvents.length, 1);
    assert.equal(counters.verify, 1);
  });

  it('rejects provider verification with an amount mismatch', async () => {
    payments.registerProvider(admin, provider({}, true));
    const created = await intent();
    const proposed = await financialDecision(PaymentCreateActionType);
    await payments.executePayment(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'mismatch-action', dryRun: false });
    const failed = await payments.verifyPayment(operator, created.id);
    assert.equal(failed.status, 'FAILED');
  });

  it('uses dry-run by default and never treats it as a verified payment', async () => {
    const counters: Record<string, number> = {};
    payments.registerProvider(admin, provider(counters));
    const created = await intent();
    const proposed = await financialDecision(PaymentCreateActionType);
    const simulated = await payments.executePayment(operator, created.id, { decisionId: proposed.id, idempotencyKey: 'payment-dry' });
    assert.equal(simulated.status, 'SIMULATED');
    assert.equal(counters.create ?? 0, 0);
    await assert.rejects(() => payments.verifyPayment(operator, created.id), /simulated payment/);
  });

  it('requires a separately authorized, independently verified refund and isolates tenants', async () => {
    const counters: Record<string, number> = {};
    payments.registerProvider(admin, provider(counters));
    const created = await intent();
    const collect = await financialDecision(PaymentCreateActionType);
    await payments.executePayment(operator, created.id, { decisionId: collect.id, idempotencyKey: 'collect-real', dryRun: false });
    await payments.verifyPayment(operator, created.id);

    const refundDecision = await financialDecision(PaymentRefundActionType, 40);
    const refund = await payments.requestRefund(operator, created.id, {
      amount: { amount: 40, currency: 'KES' }, reason: 'Controlled refund test.', decisionId: refundDecision.id, idempotencyKey: 'refund-1', dryRun: false,
    });
    assert.equal(refund.status, 'REFUND_UNVERIFIED');
    const refunded = await payments.verifyRefund(operator, created.id);
    assert.equal(refunded.status, 'REFUNDED');
    assert.equal(counters.refund, 1);
    assert.equal(await payments.getPayment(other, created.id), undefined);
  });
});
