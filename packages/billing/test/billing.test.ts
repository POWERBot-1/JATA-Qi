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
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import {
  PaymentCreateActionType,
  PaymentsModule,
  PaymentRefundActionType,
  type PaymentProvider,
  type PaymentsService,
} from '@jataqi/payments';
import { BILLING_DURABLE_HANDLER_ID, BillingModule, BillingError, type BillingService } from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let payments: PaymentsService;
let billing: BillingService;
let kernel: ReturnType<typeof createTestKernel>;

function evidence(id = 'billing-evidence'): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 'billing-test', observedAt: now, confidence: 95,
    summary: 'Controlled billing evidence.', provenance: { source: 'billing-test', collectedAt: now, correlationId: 'billing-correlation' },
  };
}

function provider(): PaymentProvider {
  return {
    id: 'billing-sandbox-pay', currencies: ['KES'], supportsRefunds: true, environment: 'sandbox',
    async createPayment() { return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: 'pay-1' }; },
    async verifyPayment(context) {
      const refund = context.operation === 'REFUND_PAYMENT';
      return { verified: true, providerStatus: refund ? 'REFUNDED' : 'SUCCEEDED', providerReference: refund ? 'refund-1' : 'pay-1', observedAmount: refund ? context.payment.refundAmount : context.payment.amount, evidence: [evidence(refund ? 'refund-evidence' : 'paid-evidence')] };
    },
    async refundPayment() { return { reportedSuccess: true, providerStatus: 'REFUNDED', providerReference: 'refund-1' }; },
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  kernel.register(new CommercialEventStreamModule({ now: () => now }));
  kernel.register(new BillingModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  payments = kernel.getModule<PaymentsModule>('payments').getService();
  billing = kernel.getModule<BillingModule>('billing').getService();
  payments.registerProvider(admin, provider());
  await control.createPolicy(admin, {
    version: 'billing-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [PaymentCreateActionType, PaymentRefundActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function setupInvoice() {
  const plan = await billing.createPlan(admin, { productId: 'product-1', name: 'Professional', price: { amount: 100, currency: 'KES' }, cycle: 'MONTHLY' });
  const subscription = await billing.createSubscription(operator, { productId: 'product-1', planId: plan.id, customerReference: 'customer-hash-1' });
  const invoice = await billing.createInvoice(operator, {
    subscriptionId: subscription.id, productId: 'product-1', customerReference: 'customer-hash-1',
    lines: [{ description: 'Professional monthly', quantity: 1, unitPrice: { amount: 100, currency: 'KES' }, total: { amount: 100, currency: 'KES' } }],
  });
  const withPayment = await billing.createInvoicePayment(operator, invoice.id, { providerId: 'billing-sandbox-pay', idempotencyKey: `invoice-payment:${invoice.id}` });
  return { plan, subscription, invoice: withPayment };
}

async function decision(actionType: string, amount = 100) {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', objective: 'Perform a governed invoice payment operation.',
    proposedAction: actionType, actionType, estimatedCost: { amount, currency: 'KES' }, evidence: [evidence()], evidenceStrength: 90,
    riskScore: 20, complianceScore: 95, confidence: 85, authorizationLevel: 2,
    decisionReason: 'Invoice and payment amount are explicitly bounded.', provenance: { source: 'billing-test', collectedAt: now, correlationId: 'billing-correlation' },
  });
}

describe('Billing', () => {
  it('creates plans, pending subscriptions, issued invoices, and provider-neutral payment intents', async () => {
    const { subscription, invoice } = await setupInvoice();
    assert.equal(subscription.status, 'PENDING_PAYMENT');
    assert.equal(invoice.status, 'PAYMENT_PENDING');
    assert.ok(invoice.paymentId);
  });

  it('activates an invoice/subscription only after a payment is independently verified', async () => {
    const { subscription, invoice } = await setupInvoice();
    const collectDecision = await decision(PaymentCreateActionType);
    const reported = await payments.executePayment(operator, invoice.paymentId!, { decisionId: collectDecision.id, idempotencyKey: 'collect-invoice', dryRun: false });
    assert.equal(reported.status, 'SUCCEEDED_UNVERIFIED');
    assert.equal((await billing.getInvoice(operator, invoice.id))?.status, 'PAYMENT_PENDING');
    assert.equal((await billing.getSubscription(operator, subscription.id))?.status, 'PENDING_PAYMENT');

    await payments.verifyPayment(operator, invoice.paymentId!);
    assert.equal((await billing.getInvoice(operator, invoice.id))?.status, 'PAID');
    assert.equal((await billing.getSubscription(operator, subscription.id))?.status, 'ACTIVE');
  });

  it('marks an invoice refunded only after a separately verified refund', async () => {
    const { invoice } = await setupInvoice();
    const collectDecision = await decision(PaymentCreateActionType);
    await payments.executePayment(operator, invoice.paymentId!, { decisionId: collectDecision.id, idempotencyKey: 'collect-refund', dryRun: false });
    await payments.verifyPayment(operator, invoice.paymentId!);
    const refundDecision = await decision(PaymentRefundActionType, 25);
    await payments.requestRefund(operator, invoice.paymentId!, { amount: { amount: 25, currency: 'KES' }, reason: 'Controlled refund.', decisionId: refundDecision.id, idempotencyKey: 'refund-invoice', dryRun: false });
    assert.equal((await billing.getInvoice(operator, invoice.id))?.status, 'PAID');
    await payments.verifyRefund(operator, invoice.paymentId!);
    assert.equal((await billing.getInvoice(operator, invoice.id))?.status, 'REFUNDED');
  });

  it('T-05: verified-payment delivery is durable (outbox record + inbox row) and a redelivery is idempotent', async () => {
    const { subscription, invoice } = await setupInvoice();
    const collectDecision = await decision(PaymentCreateActionType);
    await payments.executePayment(operator, invoice.paymentId!, { decisionId: collectDecision.id, idempotencyKey: 'collect-durable', dryRun: false });
    await payments.verifyPayment(operator, invoice.paymentId!);
    const stream = kernel.getModule<CommercialEventStreamModule>('commercial-event-stream').getService();
    const outbox = await control.replayUnifiedOutbox(operator, {});
    const verified = outbox.find((record) => record.eventType === 'payment.verified');
    assert.ok(verified, 'payment.verified must be recorded in the canonical outbox');
    assert.equal(verified.state, 'DELIVERED');
    const inbox = await stream.getDelivery(operator, verified.eventId, BILLING_DURABLE_HANDLER_ID);
    assert.equal(inbox?.state, 'DELIVERED');
    assert.equal(inbox?.attemptCount, 1);
    const paidBefore = await billing.getInvoice(operator, invoice.id);
    assert.equal(paidBefore?.status, 'PAID');
    // Explicit passes after delivery: nothing to do, nothing changes (idempotent by durable inbox).
    const again = await stream.pump(operator);
    assert.equal(again.examined, 0);
    assert.deepEqual(await billing.getInvoice(operator, invoice.id), paidBefore);
    assert.equal((await billing.getSubscription(operator, subscription.id))?.status, 'ACTIVE');
    assert.equal((await control.replayUnifiedOutbox(operator, {})).filter((record) => record.eventType === 'billing.invoice.paid').length, 1);
  });

  it('T-05/J: a payment.verified event carrying another tenant\'s payment never mutates this tenant\'s invoice (fail-closed tenant match)', async () => {
    const { invoice } = await setupInvoice();
    const collectDecision = await decision(PaymentCreateActionType);
    await payments.executePayment(operator, invoice.paymentId!, { decisionId: collectDecision.id, idempotencyKey: 'collect-foreign', dryRun: false });
    // A forged event from tenant "other" naming acme's payment/invoice: the handler derives the actor from the
    // EVENT tenant, reads the payment under that tenant (not found / not owned) and does nothing.
    await control.publishEvent(other, {
      eventType: 'payment.verified', source: 'forged', entityId: invoice.paymentId!, correlationId: 'forged',
      payload: { paymentId: invoice.paymentId, invoiceId: invoice.id, status: 'VERIFIED' },
      provenance: { source: 'forged', collectedAt: now, correlationId: 'forged' }, idempotencyKey: 'forged-verified',
    });
    const stream = kernel.getModule<CommercialEventStreamModule>('commercial-event-stream').getService();
    await stream.pump(other);
    assert.equal((await billing.getInvoice(operator, invoice.id))?.status, 'PAYMENT_PENDING', 'foreign-tenant event must not pay the invoice');
    const forged = (await control.replayUnifiedOutbox(other, {})).find((record) => record.eventType === 'payment.verified');
    assert.equal(forged?.state, 'DELIVERED', 'the delivery itself completes (handler chose no effect) — no retry storm');
    // The legitimate verification still works afterwards.
    await payments.verifyPayment(operator, invoice.paymentId!);
    assert.equal((await billing.getInvoice(operator, invoice.id))?.status, 'PAID');
  });

  it('rejects invalid invoice arithmetic and isolates tenant billing data', async () => {
    await assert.rejects(() => billing.createInvoice(operator, {
      productId: 'product-1', customerReference: 'customer-hash-1',
      lines: [{ description: 'bad', quantity: 2, unitPrice: { amount: 10, currency: 'KES' }, total: { amount: 10, currency: 'KES' } }],
    }), BillingError);
    const { invoice } = await setupInvoice();
    assert.equal(await billing.getInvoice(other, invoice.id), undefined);
  });
});
