import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { CommercialControlPlaneModule, type CommercialActor, type CommercialControlPlaneService, type CommercialEvidence } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { BillingModule, type BillingService } from '@jataqi/billing';
import { PaymentCreateActionType, PaymentsModule, type PaymentProvider, type PaymentsService } from '@jataqi/payments';
import { RevenueLedgerModule, type RevenueLedgerService } from '@jataqi/revenue-ledger';
import { CommercialAnalyticsModule, type CommercialAnalyticsService } from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let payments: PaymentsService;
let billing: BillingService;
let ledger: RevenueLedgerService;
let analytics: CommercialAnalyticsService;

function evidence(id = 'analytics-evidence'): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 'analytics-test', observedAt: now, confidence: 95,
    summary: 'Controlled analytics evidence.', provenance: { source: 'analytics-test', collectedAt: now, correlationId: 'analytics-correlation' },
  };
}

function provider(): PaymentProvider {
  return {
    id: 'analytics-provider', currencies: ['KES'], supportsRefunds: false, environment: 'sandbox',
    async createPayment() { return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: 'analytics-payment-1' }; },
    async verifyPayment(context) { return { verified: true, providerStatus: 'SUCCEEDED', providerReference: 'analytics-payment-1', observedAmount: context.payment.amount, evidence: [evidence('analytics-payment-verified')] }; },
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
  kernel.register(new CommercialAnalyticsModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  payments = kernel.getModule<PaymentsModule>('payments').getService();
  billing = kernel.getModule<BillingModule>('billing').getService();
  ledger = kernel.getModule<RevenueLedgerModule>('revenue-ledger').getService();
  analytics = kernel.getModule<CommercialAnalyticsModule>('commercial-analytics').getService();
  payments.registerProvider(admin, provider());
  await control.createPolicy(admin, {
    version: 'analytics-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [PaymentCreateActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function createVerifiedRevenue() {
  await createVerifiedRevenueWith('analytics-intent', 'product-1', 100, [{ description: 'Monthly plan', quantity: 1, unitPrice: { amount: 100, currency: 'KES' }, total: { amount: 100, currency: 'KES' } }]);
}

/** Verified revenue path with explicit float-trap lines and plan price. */
async function createVerifiedRevenueWith(intentKey: string, productKey: string, planPrice: number, lines: Array<{ description: string; quantity: number; unitPrice: { amount: number; currency: string }; total: { amount: number; currency: string } }>): Promise<{ invoiceTotal: { amount: number; currency: string } }> {
  const plan = await billing.createPlan(admin, { productId: productKey, name: `Monthly ${productKey}`, price: { amount: planPrice, currency: 'KES' }, cycle: 'MONTHLY' });
  const subscription = await billing.createSubscription(operator, { productId: productKey, planId: plan.id, customerReference: `customer-hash-${productKey}` });
  const invoice = await billing.createInvoice(operator, { subscriptionId: subscription.id, productId: productKey, customerReference: `customer-hash-${productKey}`, lines });
  const payable = await billing.createInvoicePayment(operator, invoice.id, { providerId: 'analytics-provider', idempotencyKey: intentKey });
  const decision = await control.proposeDecision(operator, {
    tenantId: 'acme', productId: productKey, objective: `Collect ${productKey}.`, proposedAction: 'Collect payment.', actionType: PaymentCreateActionType,
    estimatedCost: { amount: invoice.total.amount, currency: 'KES' }, evidence: [evidence(`${productKey}-evidence`)], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85, authorizationLevel: 2,
    decisionReason: 'Subscription invoice amount is explicitly bounded.', provenance: { source: 'analytics-test', collectedAt: now, correlationId: `analytics-${productKey}` },
  });
  await payments.executePayment(operator, payable.paymentId!, { decisionId: decision.id, idempotencyKey: `${intentKey}-action`, dryRun: false });
  await payments.verifyPayment(operator, payable.paymentId!);
  return { invoiceTotal: invoice.total };
}

describe('Commercial analytics', () => {
  it('calculates funnel, verified revenue, MRR/ARR, costs, CAC, ROAS, and contribution margin transparently', async () => {
    await createVerifiedRevenue();
    for (const [type, count] of [['VISITOR', 100], ['SIGNUP', 10], ['ACTIVATION', 5], ['PAID_CUSTOMER', 1]] as const) {
      await analytics.recordFunnelEvent(operator, { type, count, productId: 'product-1', channel: 'search', evidence: [evidence(`funnel-${type}`)], provenance: { source: 'analytics-test', collectedAt: now, correlationId: 'analytics-correlation' } });
    }
    await ledger.recordCost(operator, { productId: 'product-1', amount: { amount: 10, currency: 'KES' }, category: 'AI', evidence: [evidence('ai-cost')], notes: 'Measured model cost.' });
    await ledger.recordCost(operator, { productId: 'product-1', amount: { amount: 20, currency: 'KES' }, category: 'MARKETING', evidence: [evidence('marketing-cost')], notes: 'Measured campaign spend.' });
    await ledger.recordCost(operator, { productId: 'product-1', amount: { amount: 5, currency: 'KES' }, category: 'INFRASTRUCTURE', evidence: [evidence('infrastructure-estimate')], measured: false, notes: 'Estimated next-period hosting.' });

    const snapshot = await analytics.snapshot(operator);
    assert.equal(snapshot.visitors, 100);
    assert.equal(snapshot.signups, 10);
    assert.equal(snapshot.activations, 5);
    assert.equal(snapshot.paidCustomers, 1);
    const kes = snapshot.currencies.find((currency) => currency.currency === 'KES')!;
    assert.equal(kes.recognizedRevenue, 100);
    assert.equal(kes.mrr, 100);
    assert.equal(kes.arr, 1200);
    assert.equal(kes.measuredCosts.AI, 10);
    assert.equal(kes.measuredCosts.MARKETING, 20);
    assert.equal(kes.estimatedCosts.INFRASTRUCTURE, 5);
    assert.equal(kes.grossProfit, 90);
    assert.equal(kes.contributionMargin, 70);
    assert.equal(kes.cac, 20);
    assert.equal(kes.roas, 5);
    assert.equal(kes.arpu, 100);
    assert.equal(kes.ltv, undefined);
    assert.equal(snapshot.channels[0]?.channel, 'search');
    assert.equal(snapshot.observations.find((item) => item.metric === 'RECOGNIZED_REVENUE')?.evidenceStatus, 'VERIFIED');
  });

  it('T-07 AC-5: float-trap amounts produce exact deterministic ledger and analytics totals (0.1 + 0.2; 19.99 x 3)', async () => {
    // 0.1 + 0.2 float-sums to 0.30000000000000004; 19.99 x 3 float-multiplies
    // to 59.969999999999995. With quantized money math both chains settle and
    // every aggregated total is the exact decimal value.
    const a = await createVerifiedRevenueWith('float-intent-a', 'product-float-a', 0.3, [
      { description: 'A1', quantity: 1, unitPrice: { amount: 0.1, currency: 'KES' }, total: { amount: 0.1, currency: 'KES' } },
      { description: 'A2', quantity: 1, unitPrice: { amount: 0.2, currency: 'KES' }, total: { amount: 0.2, currency: 'KES' } },
    ]);
    assert.equal(a.invoiceTotal.amount, 0.3, 'invoice total is exactly 0.3');
    const b = await createVerifiedRevenueWith('float-intent-b', 'product-float-b', 19.99, [
      { description: 'B1', quantity: 3, unitPrice: { amount: 19.99, currency: 'KES' }, total: { amount: 59.97, currency: 'KES' } },
    ]);
    assert.equal(b.invoiceTotal.amount, 59.97, '19.99 x 3 product line is accepted exactly');

    const summary = await ledger.summarize(operator);
    assert.equal(summary.length, 1);
    assert.equal(summary[0]?.recognizedRevenue, 60.27, 'ledger summary is the exact sum (0.3 + 59.97)');

    const snapshot = await analytics.snapshot(operator);
    const kes = snapshot.currencies.find((currency) => currency.currency === 'KES')!;
    assert.equal(kes.recognizedRevenue, 60.27, 'analytics recognized revenue is exact');
    assert.equal(kes.measuredCosts.PAYMENT, 0);
    const recorded = snapshot.observations.find((item) => item.metric === 'RECOGNIZED_REVENUE')!;
    assert.equal(recorded.value, 60.27);
    assert.equal(recorded.evidenceStatus, 'VERIFIED');
  });

  it('marks ratio metrics unavailable rather than inventing a denominator', async () => {
    const snapshot = await analytics.snapshot(operator);
    assert.equal(snapshot.currencies.length, 0);
    assert.equal(snapshot.observations.find((item) => item.metric === 'CHURN_RATE')?.evidenceStatus, 'UNAVAILABLE');
    assert.equal(snapshot.observations.find((item) => item.metric === 'RETENTION_RATE')?.value, undefined);
  });

  it('requires evidence for funnel events and preserves tenant isolation', async () => {
    await assert.rejects(() => analytics.recordFunnelEvent(operator, {
      type: 'VISITOR', count: 1, evidence: [], provenance: { source: 'test', collectedAt: now },
    }), /require evidence/);
    await analytics.recordFunnelEvent(operator, { type: 'VISITOR', count: 1, evidence: [evidence()], provenance: { source: 'test', collectedAt: now } });
    assert.equal((await analytics.listFunnelEvents(other)).length, 0);
  });
});
