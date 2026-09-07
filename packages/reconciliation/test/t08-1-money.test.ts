import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moneyEquals, quantizeMonetaryValue, minorUnitsOf, fromMinorUnits } from '@jataqi/commercial-control-plane';

// T-09: money helpers now require the currency explicitly (no silent 2dp
// default). This T-08.1 regression passes 'KES' (a 2-decimal currency), so
// every expected value below is unchanged from the T-08.1 baseline.
describe('T-08.1 R-MONEY-02 reconciliation canonical moneyEquals', () => {
  it('0.30000000000000004 vs 0.3 are equal via canonical moneyEquals (no float trap)', async () => {
    // classic float trap: 0.1 + 0.2 = 0.30000000000000004 !== 0.3
    const sum = 0.1 + 0.2;
    assert.equal(sum, 0.30000000000000004);
    assert.equal((sum as number) === (0.3 as number), false);
    assert.equal(moneyEquals({ amount: sum, currency: 'KES' }, { amount: 0.3, currency: 'KES' }), true);
    assert.equal(moneyEquals({ amount: 0.30000000000000004, currency: 'KES' }, { amount: 0.3, currency: 'KES' }), true);
    // quantize also normalizes
    const q1 = quantizeMonetaryValue({ amount: sum, currency: 'KES' });
    const q2 = quantizeMonetaryValue({ amount: 0.3, currency: 'KES' });
    assert.equal(q1.amount, 0.3);
    assert.equal(q2.amount, 0.3);
    assert.equal(minorUnitsOf(sum, 'KES'), 30n);
    assert.equal(minorUnitsOf(0.3, 'KES'), 30n);
  });

  it('reconciliation observes exact minor units, not float string', async () => {
    const { createTestKernel } = await import('@jataqi/core-kernel/testing');
    const { StorageModule } = await import('@jataqi/storage');
    const { AutonomousActionRuntimeModule } = await import('@jataqi/autonomous-action-runtime');
    const { CommercialControlPlaneModule } = await import('@jataqi/commercial-control-plane');
    const { CommercialEventStreamModule } = await import('@jataqi/commercial-event-stream');
    const { BillingModule } = await import('@jataqi/billing');
    const { PaymentsModule, PaymentCreateActionType } = await import('@jataqi/payments');
    const { RevenueLedgerModule } = await import('@jataqi/revenue-ledger');
    // R1 (§6): the REAL mandatory authorization boundary — the same module the
    // production composition installs. Not a mock, not a bypass.
    const { AuthorizationBoundaryModule } = await import('@jataqi/authorization-boundary');
    const { ReconciliationModule } = await import('../src/index.js');
    const now = Date.now();
    const admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] as const };
    const operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] as const };
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new CommercialControlPlaneModule({ now: () => now }));
    kernel.register(new AuthorizationBoundaryModule());
    kernel.register(new AutonomousActionRuntimeModule());
    kernel.register(new PaymentsModule());
    kernel.register(new CommercialEventStreamModule({ now: () => now }));
    kernel.register(new BillingModule());
    kernel.register(new RevenueLedgerModule());
    kernel.register(new ReconciliationModule());
    await kernel.boot();
    const control = (kernel.getModule('commercial-control-plane') as any).getService() as any;
    const payments = (kernel.getModule('payments') as any).getService() as any;
    const billing = (kernel.getModule('billing') as any).getService() as any;
    const reconciliation = (kernel.getModule('reconciliation') as any).getService() as any;
    // register provider that produces 0.3 via 0.1+0.2 sum
    payments.registerProvider(admin, {
      id: 'trap-provider', currencies: ['KES'], supportsRefunds: false, environment: 'sandbox',
      async createPayment() { return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: 'trap-ref' }; },
      async verifyPayment(ctx: any) { return { verified: true, providerStatus: 'SUCCEEDED', providerReference: 'trap-ref', observedAmount: ctx.payment.amount, evidence: [{ id: 'e', status: 'MEASURED', source: 'trap', observedAt: now, confidence: 95, summary: 'trap', provenance: { source: 'trap', collectedAt: now, correlationId: 'trap' } }] }; },
    });
    await control.createPolicy(admin, {
      version: 'trap-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
      allowedActionTypes: [PaymentCreateActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
    });
    const plan = await billing.createPlan(admin, { productId: 'product-1', name: 'Trap Plan', price: { amount: 0.3, currency: 'KES' }, cycle: 'MONTHLY' });
    const sub = await billing.createSubscription(operator, { productId: 'product-1', planId: plan.id, customerReference: 'cust-trap' });
    const invoice = await billing.createInvoice(operator, { subscriptionId: sub.id, productId: 'product-1', customerReference: 'cust-trap', lines: [{ description: 'l', quantity: 1, unitPrice: { amount: 0.3, currency: 'KES' }, total: { amount: 0.3, currency: 'KES' } }] });
    const payable = await billing.createInvoicePayment(operator, invoice.id, { providerId: 'trap-provider', idempotencyKey: 'trap-intent' });
    const decision = await control.proposeDecision(operator, {
      tenantId: 'acme', productId: 'product-1', objective: 'trap', proposedAction: 'Collect', actionType: PaymentCreateActionType,
      estimatedCost: { amount: 0.3, currency: 'KES' }, evidence: [{ id: 'e', status: 'MEASURED', source: 'trap', observedAt: now, confidence: 95, summary: 'trap', provenance: { source: 'trap', collectedAt: now, correlationId: 'trap' } }], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85, authorizationLevel: 2, decisionReason: 'trap', provenance: { source: 'trap', collectedAt: now, correlationId: 'trap' },
    });
    await payments.executePayment(operator, payable.paymentId, { decisionId: decision.id, idempotencyKey: 'trap-action', dryRun: false });
    await payments.verifyPayment(operator, payable.paymentId);
    // provider observation reports 0.30000000000000004 which should reconcile as equal to 0.3 via canonical moneyEquals
    reconciliation.registerSource(admin, {
      id: 'trap-source', providerId: 'trap-provider',
      async observe() { return [{ providerReference: 'trap-ref', status: 'SUCCEEDED', amount: { amount: 0.30000000000000004, currency: 'KES' }, observedAt: now, evidence: [{ id: 'e2', status: 'MEASURED', source: 'trap', observedAt: now, confidence: 95, summary: 'obs', provenance: { source: 'trap', collectedAt: now, correlationId: 'trap2' } }] }]; },
    });
    const run = await reconciliation.reconcile(operator, { providerId: 'trap-provider', sourceId: 'trap-source' });
    assert.equal(run.status, 'RECONCILED', `expected RECONCILED despite 0.30000000000000004 vs 0.3 trap, got ${run.status} discrepancies=${JSON.stringify(run.discrepancies)}`);
    await kernel.shutdown();
  });
});
