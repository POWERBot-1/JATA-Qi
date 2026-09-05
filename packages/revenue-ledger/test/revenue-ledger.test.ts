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
import { BillingModule, type BillingService } from '@jataqi/billing';
import { PaymentCreateActionType, PaymentsModule, PaymentRefundActionType, type PaymentProvider, type PaymentsService } from '@jataqi/payments';
import { RevenueLedgerModule, type RevenueLedgerService } from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let payments: PaymentsService;
let billing: BillingService;
let ledger: RevenueLedgerService;

function evidence(id = 'ledger-evidence'): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 'revenue-ledger-test', observedAt: now, confidence: 95,
    summary: 'Controlled ledger evidence.', provenance: { source: 'revenue-ledger-test', collectedAt: now, correlationId: 'ledger-correlation' },
  };
}

function provider(): PaymentProvider {
  return {
    id: 'ledger-sandbox-provider', currencies: ['KES'], supportsRefunds: true, environment: 'sandbox',
    async createPayment() { return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: 'provider-pay-1' }; },
    async verifyPayment(context) {
      const refund = context.operation === 'REFUND_PAYMENT';
      return { verified: true, providerStatus: refund ? 'REFUNDED' : 'SUCCEEDED', providerReference: refund ? 'provider-refund-1' : 'provider-pay-1', observedAmount: refund ? context.payment.refundAmount : context.payment.amount, evidence: [evidence(refund ? 'refund-verification' : 'payment-verification')] };
    },
    async refundPayment() { return { reportedSuccess: true, providerStatus: 'REFUNDED', providerReference: 'provider-refund-1' }; },
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  other = { id: 'other', tenantId: 'other', roles: ['operator'] };
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  kernel.register(new CommercialEventStreamModule({ now: () => now }));
  kernel.register(new BillingModule());
  kernel.register(new RevenueLedgerModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  payments = kernel.getModule<PaymentsModule>('payments').getService();
  billing = kernel.getModule<BillingModule>('billing').getService();
  ledger = kernel.getModule<RevenueLedgerModule>('revenue-ledger').getService();
  payments.registerProvider(admin, provider());
  await control.createPolicy(admin, {
    version: 'ledger-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [PaymentCreateActionType, PaymentRefundActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function invoicePayment() {
  const plan = await billing.createPlan(admin, { productId: 'product-1', name: 'Plan', price: { amount: 100, currency: 'KES' }, cycle: 'MONTHLY' });
  const subscription = await billing.createSubscription(operator, { productId: 'product-1', planId: plan.id, customerReference: 'customer-hash' });
  const invoice = await billing.createInvoice(operator, { subscriptionId: subscription.id, productId: 'product-1', customerReference: 'customer-hash', lines: [{ description: 'Plan', quantity: 1, unitPrice: { amount: 100, currency: 'KES' }, total: { amount: 100, currency: 'KES' } }] });
  return billing.createInvoicePayment(operator, invoice.id, { providerId: 'ledger-sandbox-provider', idempotencyKey: `payment:${invoice.id}` });
}

async function decision(actionType: string, amount: number) {
  return control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', objective: 'Perform governed financial operation.', proposedAction: actionType, actionType,
    estimatedCost: { amount, currency: 'KES' }, evidence: [evidence()], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85,
    authorizationLevel: 2, decisionReason: 'Verified billing context bounds financial exposure.', provenance: { source: 'revenue-ledger-test', collectedAt: now, correlationId: 'ledger-correlation' },
  });
}

describe('Revenue ledger', () => {
  it('does not recognize provider acceptance as revenue before payment verification', async () => {
    const invoice = await invoicePayment();
    const collect = await decision(PaymentCreateActionType, 100);
    await payments.executePayment(operator, invoice.paymentId!, { decisionId: collect.id, idempotencyKey: 'collect-unverified', dryRun: false });
    assert.equal((await ledger.listEntries(operator)).length, 0);
  });

  it('records a hash-chained revenue entry only after verified payment and paid invoice state', async () => {
    const invoice = await invoicePayment();
    const collect = await decision(PaymentCreateActionType, 100);
    await payments.executePayment(operator, invoice.paymentId!, { decisionId: collect.id, idempotencyKey: 'collect-verified', dryRun: false });
    await payments.verifyPayment(operator, invoice.paymentId!);
    const entries = await ledger.listEntries(operator);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.entryType, 'REVENUE');
    assert.equal(entries[0]?.recognitionStatus, 'RECOGNIZED');
    assert.equal(entries[0]?.amount.amount, 100);
    assert.deepEqual(await ledger.verifyIntegrity(operator), { valid: true, entries: 1 });
    assert.deepEqual(await ledger.summarize(operator), [{ currency: 'KES', recognizedRevenue: 100, reversedRevenue: 0, measuredCosts: 0, estimatedCosts: 0, contribution: 100 }]);
  });

  it('records a separate verified refund reversal rather than mutating recognized revenue', async () => {
    const invoice = await invoicePayment();
    const collect = await decision(PaymentCreateActionType, 100);
    await payments.executePayment(operator, invoice.paymentId!, { decisionId: collect.id, idempotencyKey: 'collect-refund', dryRun: false });
    await payments.verifyPayment(operator, invoice.paymentId!);
    const refund = await decision(PaymentRefundActionType, 40);
    await payments.requestRefund(operator, invoice.paymentId!, { amount: { amount: 40, currency: 'KES' }, reason: 'Controlled refund.', decisionId: refund.id, idempotencyKey: 'refund', dryRun: false });
    await payments.verifyRefund(operator, invoice.paymentId!);
    const entries = await ledger.listEntries(operator);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.entryType, 'REFUND_REVERSAL');
    assert.equal((await ledger.summarize(operator))[0]?.contribution, 60);
  });

  it('separates measured costs from estimates and requires evidence', async () => {
    await ledger.recordCost(operator, { productId: 'product-1', amount: { amount: 10, currency: 'KES' }, category: 'AI', evidence: [evidence('ai-cost')], notes: 'Measured model invoice.' });
    await ledger.recordCost(operator, { productId: 'product-1', amount: { amount: 5, currency: 'KES' }, category: 'MARKETING', evidence: [evidence('marketing-estimate')], measured: false, notes: 'Planned test spend.' });
    const summary = await ledger.summarize(operator);
    assert.equal(summary[0]?.measuredCosts, 10);
    assert.equal(summary[0]?.estimatedCosts, 5);
    await assert.rejects(() => ledger.recordCost(operator, { amount: { amount: 1, currency: 'KES' }, category: 'AI', evidence: [] }), /Cost category, evidence/);
  });

  it('keeps ledger entries tenant-isolated', async () => {
    await ledger.recordCost(operator, { amount: { amount: 1, currency: 'KES' }, category: 'OTHER', evidence: [evidence()] });
    assert.equal((await ledger.listEntries(other)).length, 0);
  });
});
