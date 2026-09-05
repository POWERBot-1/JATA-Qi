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
import { PaymentCreateActionType, PaymentsModule, type PaymentProvider, type PaymentsService } from '@jataqi/payments';
import { RevenueLedgerModule } from '@jataqi/revenue-ledger';
import {
  ReconciliationModule,
  type PaymentReconciliationSource,
  type ReconciliationService,
} from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let other: CommercialActor;
let control: CommercialControlPlaneService;
let payments: PaymentsService;
let billing: BillingService;
let reconciliation: ReconciliationService;

function evidence(id = 'reconciliation-evidence'): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 'reconciliation-test', observedAt: now, confidence: 96,
    summary: 'Controlled reconciliation evidence.', provenance: { source: 'reconciliation-test', collectedAt: now, correlationId: 'reconciliation-correlation' },
  };
}

function provider(): PaymentProvider {
  return {
    id: 'reconcile-provider', currencies: ['KES'], supportsRefunds: false, environment: 'sandbox',
    async createPayment() { return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: 'provider-pay-1' }; },
    async verifyPayment(context) { return { verified: true, providerStatus: 'SUCCEEDED', providerReference: 'provider-pay-1', observedAmount: context.payment.amount, evidence: [evidence('payment-verification')] }; },
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
  kernel.register(new ReconciliationModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  payments = kernel.getModule<PaymentsModule>('payments').getService();
  billing = kernel.getModule<BillingModule>('billing').getService();
  reconciliation = kernel.getModule<ReconciliationModule>('reconciliation').getService();
  payments.registerProvider(admin, provider());
  await control.createPolicy(admin, {
    version: 'reconciliation-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [PaymentCreateActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

async function verifiedPayment() {
  const plan = await billing.createPlan(admin, { productId: 'product-1', name: 'Plan', price: { amount: 100, currency: 'KES' }, cycle: 'MONTHLY' });
  const subscription = await billing.createSubscription(operator, { productId: 'product-1', planId: plan.id, customerReference: 'customer-hash' });
  const invoice = await billing.createInvoice(operator, { subscriptionId: subscription.id, productId: 'product-1', customerReference: 'customer-hash', lines: [{ description: 'plan', quantity: 1, unitPrice: { amount: 100, currency: 'KES' }, total: { amount: 100, currency: 'KES' } }] });
  const payable = await billing.createInvoicePayment(operator, invoice.id, { providerId: 'reconcile-provider', idempotencyKey: 'reconcile-intent' });
  const decision = await control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', objective: 'Collect verified invoice payment.', proposedAction: 'Collect payment.', actionType: PaymentCreateActionType,
    estimatedCost: { amount: 100, currency: 'KES' }, evidence: [evidence()], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85, authorizationLevel: 2,
    decisionReason: 'Invoice amount and provider are bounded.', provenance: { source: 'reconciliation-test', collectedAt: now, correlationId: 'reconciliation-correlation' },
  });
  await payments.executePayment(operator, payable.paymentId!, { decisionId: decision.id, idempotencyKey: 'reconcile-action', dryRun: false });
  return payments.verifyPayment(operator, payable.paymentId!);
}

function source(observationAmount = 100): PaymentReconciliationSource {
  return {
    id: `source-${observationAmount}`, providerId: 'reconcile-provider',
    async observe() {
      return [{ providerReference: 'provider-pay-1', status: 'SUCCEEDED', amount: { amount: observationAmount, currency: 'KES' }, observedAt: now, evidence: [evidence(`provider-observation-${observationAmount}`)] }];
    },
  };
}

describe('Reconciliation', () => {
  it('reports PENDING_EXTERNAL when internally reconciled records have no provider observation source', async () => {
    await verifiedPayment();
    const run = await reconciliation.reconcile(operator, { providerId: 'reconcile-provider' });
    assert.equal(run.internalReconciled, true);
    assert.equal(run.externalObserved, false);
    assert.equal(run.status, 'PENDING_EXTERNAL');
  });

  it('reports RECONCILED only when a read-only provider observation matches verified internal state', async () => {
    await verifiedPayment();
    reconciliation.registerSource(admin, source());
    const run = await reconciliation.reconcile(operator, { providerId: 'reconcile-provider', sourceId: 'source-100' });
    assert.equal(run.status, 'RECONCILED');
    assert.equal(run.externalObserved, true);
    assert.equal(run.discrepancies.length, 0);
  });

  it('reports a provider amount mismatch as DISPUTED rather than altering payment or revenue state', async () => {
    const payment = await verifiedPayment();
    reconciliation.registerSource(admin, source(90));
    const run = await reconciliation.reconcile(operator, { providerId: 'reconcile-provider', sourceId: 'source-90' });
    assert.equal(run.status, 'DISPUTED');
    assert.ok(run.discrepancies.some((item) => item.kind === 'AMOUNT_MISMATCH'));
    assert.equal((await payments.getPayment(operator, payment.id))?.status, 'VERIFIED');
  });

  it('keeps reconciliation reports tenant-isolated', async () => {
    const run = await reconciliation.reconcile(operator);
    assert.equal(await reconciliation.getRun(other, run.id), undefined);
    assert.equal((await reconciliation.listRuns(other)).length, 0);
  });
});
