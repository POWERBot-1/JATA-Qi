import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import {
  CommercialControlPlaneModule,
  createStaticFxProvider,
  minorUnitsOf,
  scaleOf,
  type CommercialActor,
  type CommercialControlPlaneService,
  type CommercialEvidence,
  type MonetaryValue,
} from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import {
  PaymentCreateActionType,
  PaymentsModule,
  WalletError,
  type PaymentProvider,
  type PaymentsService,
  type WalletService,
} from '@jataqi/payments';
import { BillingError, BillingModule, type BillingService } from '@jataqi/billing';
import { RevenueLedgerModule, type RevenueLedgerService } from '@jataqi/revenue-ledger';
import { ReconciliationModule, type ReconciliationService } from '@jataqi/reconciliation';
import { CommercialAnalyticsModule, type CommercialAnalyticsService } from '@jataqi/commercial-analytics';

/**
 * T-09 cross-domain acceptance suite (AC-1, AC-2, AC-3, AC-4, AC-5, AC-6,
 * AC-7, AC-8): per-currency money semantics observed through the REAL
 * commercial composition — billing, payments, revenue ledger, reconciliation,
 * commercial analytics, and the per-currency wallet — not through unit-level
 * helpers alone.
 *
 * This file lives in the commercial-command-center workspace because it is the
 * only workspace whose declared dependency set already spans payments,
 * billing, revenue-ledger, reconciliation, and commercial-analytics, so the
 * topological workspace build guarantees every imported type declaration
 * exists before this suite compiles.
 *
 * Each assertion states the value the documented rule requires (half-up at the
 * currency's own minor-unit scale). A regression to a fixed 2-decimal
 * assumption — in quantization, comparison, product checks, summation, MRR
 * allocation, reconciliation, or wallet isolation — fails these tests.
 */

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let control: CommercialControlPlaneService;
let payments: PaymentsService;
let wallet: WalletService;
let billing: BillingService;
let ledger: RevenueLedgerService;
let reconciliation: ReconciliationService;
let analytics: CommercialAnalyticsService;
let stream: { pump(actor: CommercialActor): Promise<unknown> };
let kernel: ReturnType<typeof createTestKernel>;

const OWNER = 'customer-hash-1';

/** Deterministic injected FX table (no PSP, no network, no env rate source). */
const fx = createStaticFxProvider({ 'USD/JPY': 155.25, 'KES/JPY': 1.1, 'KWD/USD': 3.25 }, 'static:t09-cross-domain');

function evidence(id: string): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 't09-test', observedAt: now, confidence: 95,
    summary: 'Controlled T-09 evidence.', provenance: { source: 't09-test', collectedAt: now, correlationId: `t09-${id}` },
  };
}

function multiCurrencyProvider(observed?: (amount: MonetaryValue) => MonetaryValue): PaymentProvider {
  return {
    id: 't09-sandbox-pay', currencies: ['JPY', 'KWD', 'KES', 'USD'], supportsRefunds: false, environment: 'sandbox',
    async createPayment() { return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: 't09-provider-ref', summary: 'Sandbox acceptance.' }; },
    async verifyPayment(context) {
      return {
        verified: true, providerStatus: 'SUCCEEDED', providerReference: 't09-provider-ref',
        observedAmount: observed ? observed(context.payment.amount) : context.payment.amount,
        evidence: [evidence('t09-verification')], summary: 'Sandbox verification.',
      };
    },
  };
}

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  kernel.register(new CommercialEventStreamModule({ now: () => now }));
  kernel.register(new BillingModule());
  kernel.register(new RevenueLedgerModule());
  kernel.register(new ReconciliationModule());
  kernel.register(new CommercialAnalyticsModule());
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  const paymentsModule = kernel.getModule<PaymentsModule>('payments');
  payments = paymentsModule.getService();
  wallet = paymentsModule.getWalletService();
  billing = kernel.getModule<BillingModule>('billing').getService();
  ledger = kernel.getModule<RevenueLedgerModule>('revenue-ledger').getService();
  reconciliation = kernel.getModule<ReconciliationModule>('reconciliation').getService();
  analytics = kernel.getModule<CommercialAnalyticsModule>('commercial-analytics').getService();
  stream = kernel.getModule<CommercialEventStreamModule>('commercial-event-stream').getService() as unknown as typeof stream;
  payments.registerProvider(admin, multiCurrencyProvider());
  await control.createPolicy(admin, {
    version: 't09-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [PaymentCreateActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
});

/** Plan → subscription → invoice → intent → decision → execute → verify → deliver. */
async function activateSubscription(input: {
  currency: string;
  price: number;
  cycle: 'MONTHLY' | 'ANNUAL';
  quantity?: number;
  lineTotal?: number;
  key: string;
  observed?: (amount: MonetaryValue) => MonetaryValue;
}) {
  const quantity = input.quantity ?? 1;
  const lineTotal = input.lineTotal ?? input.price * quantity;
  // The default provider observes exactly what the intent carries. A test that
  // needs a diverging provider observation registers its own provider id.
  const providerId = input.observed ? `t09-sandbox-pay-${input.key}` : 't09-sandbox-pay';
  if (input.observed) payments.registerProvider(admin, { ...multiCurrencyProvider(input.observed), id: providerId });
  const plan = await billing.createPlan(admin, { productId: `product-${input.key}`, name: `T-09 ${input.currency} ${input.cycle}`, price: { amount: input.price, currency: input.currency }, cycle: input.cycle });
  const subscription = await billing.createSubscription(operator, { productId: `product-${input.key}`, planId: plan.id, customerReference: OWNER });
  const invoice = await billing.createInvoice(operator, {
    subscriptionId: subscription.id, productId: `product-${input.key}`, customerReference: OWNER,
    lines: [{ description: 'T-09 line', quantity, unitPrice: { amount: input.price, currency: input.currency }, total: { amount: lineTotal, currency: input.currency } }],
  });
  const payable = await billing.createInvoicePayment(operator, invoice.id, { providerId, idempotencyKey: `intent-${input.key}` });
  const decision = await control.proposeDecision(operator, {
    tenantId: 'acme', productId: `product-${input.key}`, objective: 'Collect the T-09 invoice.', proposedAction: 'Collect',
    actionType: PaymentCreateActionType, estimatedCost: { amount: invoice.total.amount, currency: invoice.total.currency },
    evidence: [evidence(`decision-${input.key}`)], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85,
    authorizationLevel: 2, decisionReason: 'Amount and currency are explicitly bounded.',
    provenance: { source: 't09-test', collectedAt: now, correlationId: `t09-${input.key}` },
  });
  await payments.executePayment(operator, payable.paymentId!, { decisionId: decision.id, idempotencyKey: `action-${input.key}`, dryRun: false });
  const verified = await payments.verifyPayment(operator, payable.paymentId!);
  await stream.pump(operator);
  return { plan, subscription, invoice: await billing.getInvoice(operator, invoice.id), payment: verified };
}

describe('T-09 AC-7 — billing calculations use the product currency scale', () => {
  it('quantizes plan prices at the currency scale (JPY 0dp, KWD 3dp, KES 2dp)', async () => {
    const jpy = await billing.createPlan(admin, { productId: 'p-jpy', name: 'JPY tie', price: { amount: 100.5, currency: 'JPY' }, cycle: 'MONTHLY' });
    assert.deepEqual(jpy.price, { amount: 101, currency: 'JPY' }, 'a JPY price is whole yen (half-up tie)');
    const kwd = await billing.createPlan(admin, { productId: 'p-kwd', name: 'KWD fils', price: { amount: 1.2345, currency: 'KWD' }, cycle: 'MONTHLY' });
    assert.deepEqual(kwd.price, { amount: 1.235, currency: 'KWD' }, 'a KWD price keeps fils (half-up at 3dp)');
    const kes = await billing.createPlan(admin, { productId: 'p-kes', name: 'KES unchanged', price: { amount: 19.99, currency: 'KES' }, cycle: 'MONTHLY' });
    assert.deepEqual(kes.price, { amount: 19.99, currency: 'KES' }, 'the 2dp default is bit-identical');
    assert.equal(scaleOf(jpy.price.currency), 0);
    assert.equal(minorUnitsOf(kwd.price.amount, kwd.price.currency), 1235n);
  });

  it('applies the exact product rule at 0 decimals and rejects the 2dp-shaped total', async () => {
    // 0.5 x 3 = 1.5 -> half-up at 0dp -> 2 yen is the ONLY correct total.
    const accepted = await billing.createInvoice(operator, {
      productId: 'p-jpy', customerReference: OWNER,
      lines: [{ description: 'JPY tie line', quantity: 3, unitPrice: { amount: 0.5, currency: 'JPY' }, total: { amount: 2, currency: 'JPY' } }],
    });
    assert.deepEqual(accepted.total, { amount: 2, currency: 'JPY' });
    // A 2-decimal implementation would accept 1.50 and reject 2.
    await assert.rejects(() => billing.createInvoice(operator, {
      productId: 'p-jpy', customerReference: OWNER,
      lines: [{ description: 'JPY wrong total', quantity: 3, unitPrice: { amount: 0.5, currency: 'JPY' }, total: { amount: 1, currency: 'JPY' } }],
    }), BillingError);
    await assert.rejects(() => billing.createInvoice(operator, {
      productId: 'p-jpy', customerReference: OWNER,
      lines: [{ description: 'JPY 2dp-shaped total', quantity: 3, unitPrice: { amount: 33, currency: 'JPY' }, total: { amount: 99, currency: 'KES' } }],
    }), /same currency/);
  });

  it('applies the exact product rule at 3 decimals and sums lines in one currency', async () => {
    const invoice = await billing.createInvoice(operator, {
      productId: 'p-kwd', customerReference: OWNER,
      lines: [
        { description: 'KWD line 1', quantity: 3, unitPrice: { amount: 19.999, currency: 'KWD' }, total: { amount: 59.997, currency: 'KWD' } },
        { description: 'KWD line 2', quantity: 3, unitPrice: { amount: 0.001, currency: 'KWD' }, total: { amount: 0.003, currency: 'KWD' } },
      ],
    });
    assert.deepEqual(invoice.total, { amount: 60, currency: 'KWD' }, 'exact minor-unit sum: 59997 + 3 fils = 60.000 KWD');
    assert.equal(minorUnitsOf(invoice.total.amount, invoice.total.currency), 60000n);
    await assert.rejects(() => billing.createInvoice(operator, {
      productId: 'p-kwd', customerReference: OWNER,
      lines: [{ description: 'KWD off by a fils', quantity: 3, unitPrice: { amount: 19.999, currency: 'KWD' }, total: { amount: 59.996, currency: 'KWD' } }],
    }), BillingError);
    await assert.rejects(() => billing.createInvoice(operator, {
      productId: 'p-mixed', customerReference: OWNER,
      lines: [
        { description: 'JPY line', quantity: 1, unitPrice: { amount: 100, currency: 'JPY' }, total: { amount: 100, currency: 'JPY' } },
        { description: 'KWD line', quantity: 1, unitPrice: { amount: 1, currency: 'KWD' }, total: { amount: 1, currency: 'KWD' } },
      ],
    }), /one currency/, 'an invoice can never mix currencies (or their scales)');
  });

  it('quantizes payment intents at the payment currency scale (AC-1 at the payments boundary)', async () => {
    const jpy = await payments.createIntent(operator, {
      productId: 'p-jpy', customerReference: OWNER, purpose: 'T-09 JPY intent', providerId: 't09-sandbox-pay',
      amount: { amount: 100.5, currency: 'JPY' }, idempotencyKey: 'intent-jpy-quantize',
    });
    assert.deepEqual(jpy.amount, { amount: 101, currency: 'JPY' });
    const kwd = await payments.createIntent(operator, {
      productId: 'p-kwd', customerReference: OWNER, purpose: 'T-09 KWD intent', providerId: 't09-sandbox-pay',
      amount: { amount: 1.2345, currency: 'KWD' }, idempotencyKey: 'intent-kwd-quantize',
    });
    assert.deepEqual(kwd.amount, { amount: 1.235, currency: 'KWD' });
    const kes = await payments.createIntent(operator, {
      productId: 'p-kes', customerReference: OWNER, purpose: 'T-09 KES intent', providerId: 't09-sandbox-pay',
      amount: { amount: 0.1 + 0.2, currency: 'KES' }, idempotencyKey: 'intent-kes-trap',
    });
    assert.deepEqual(kes.amount, { amount: 0.3, currency: 'KES' }, 'the T-07 float trap result is unchanged');
  });
});

describe('T-09 AC-1/AC-6 — JPY end-to-end payment, ledger, and reconciliation', () => {
  it('collects a whole-yen invoice and records whole-yen revenue', async () => {
    const { invoice, payment } = await activateSubscription({ currency: 'JPY', price: 33, quantity: 3, lineTotal: 99, cycle: 'MONTHLY', key: 'jpy-e2e' });
    assert.deepEqual(payment.amount, { amount: 99, currency: 'JPY' });
    assert.equal(payment.status, 'VERIFIED');
    assert.equal(invoice?.status, 'PAID');
    assert.deepEqual(invoice?.total, { amount: 99, currency: 'JPY' });
    const entries = await ledger.listEntries(operator);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!.amount, { amount: 99, currency: 'JPY' });
    assert.equal(minorUnitsOf(entries[0]!.amount.amount, entries[0]!.amount.currency), 99n, 'JPY revenue is 99 minor units, not 9900');
    const summary = await ledger.summarize(operator);
    assert.deepEqual(summary, [{ currency: 'JPY', recognizedRevenue: 99, reversedRevenue: 0, measuredCosts: 0, estimatedCosts: 0, contribution: 99 }]);
    const run = await reconciliation.reconcile(operator, {});
    assert.equal(run.status, 'PENDING_EXTERNAL');
    assert.equal(run.internalReconciled, true, 'internal payment/ledger amounts match at the JPY scale');
  });

  it('reconciles a provider observation that is equal only at the 0-decimal scale', async () => {
    // The provider reports 100.4 JPY (a sub-unit artifact of its own system):
    // at 0dp that IS 100 yen, so the run reconciles instead of disputing.
    const { payment } = await activateSubscription({ currency: 'JPY', price: 100, cycle: 'MONTHLY', key: 'jpy-recon-ok', observed: () => ({ amount: 100.4, currency: 'JPY' }) });
    assert.equal(payment.status, 'VERIFIED', 'verification compares minor units at the currency scale');
    reconciliation.registerSource(admin, {
      id: 't09-jpy-source', providerId: 't09-sandbox-pay-jpy-recon-ok',
      async observe() {
        return [{
          providerReference: 't09-provider-ref', status: 'SUCCEEDED', amount: { amount: 100.4, currency: 'JPY' }, observedAt: now,
          evidence: [evidence('t09-observation')],
        }];
      },
    });
    const run = await reconciliation.reconcile(operator, { providerId: 't09-sandbox-pay-jpy-recon-ok', sourceId: 't09-jpy-source' });
    assert.equal(run.status, 'RECONCILED', `expected RECONCILED, got ${run.status}: ${JSON.stringify(run.discrepancies)}`);
    assert.equal(run.discrepancies.length, 0);
  });

  it('disputes a provider observation that differs by one yen and reports the scale trap', async () => {
    await activateSubscription({ currency: 'JPY', price: 100, cycle: 'MONTHLY', key: 'jpy-recon-bad' });
    reconciliation.registerSource(admin, {
      id: 't09-jpy-bad-source', providerId: 't09-sandbox-pay',
      async observe() {
        return [{
          providerReference: 't09-provider-ref', status: 'SUCCEEDED', amount: { amount: 100.5, currency: 'JPY' }, observedAt: now,
          evidence: [evidence('t09-observation-bad')],
        }];
      },
    });
    const run = await reconciliation.reconcile(operator, { providerId: 't09-sandbox-pay', sourceId: 't09-jpy-bad-source' });
    assert.equal(run.status, 'DISPUTED');
    const mismatch = run.discrepancies.find((item) => item.kind === 'AMOUNT_MISMATCH');
    assert.ok(mismatch, 'a one-yen difference at 0dp is a real discrepancy');
    assert.ok(/not representable at 0 decimal place/.test(mismatch!.detail), `expected a scale diagnostic, got: ${mismatch!.detail}`);
    assert.deepEqual(mismatch!.expected, { amount: 100, currency: 'JPY' });
    assert.deepEqual(mismatch!.observed, { amount: 100.5, currency: 'JPY' });
  });

  it('detects a one-fils difference that a 2-decimal comparison would have missed (AC-2/AC-6)', async () => {
    await activateSubscription({ currency: 'KWD', price: 1.234, cycle: 'MONTHLY', key: 'kwd-recon' });
    reconciliation.registerSource(admin, {
      id: 't09-kwd-source', providerId: 't09-sandbox-pay',
      async observe() {
        return [{
          providerReference: 't09-provider-ref', status: 'SUCCEEDED', amount: { amount: 1.235, currency: 'KWD' }, observedAt: now,
          evidence: [evidence('t09-kwd-observation')],
        }];
      },
    });
    const run = await reconciliation.reconcile(operator, { providerId: 't09-sandbox-pay', sourceId: 't09-kwd-source' });
    assert.equal(run.status, 'DISPUTED', '1.234 vs 1.235 KWD differ by one fils (a 2dp comparison would call them equal)');
    const mismatch = run.discrepancies.find((item) => item.kind === 'AMOUNT_MISMATCH');
    assert.ok(mismatch);
    assert.deepEqual(mismatch!.expected, { amount: 1.234, currency: 'KWD' });
    assert.deepEqual(mismatch!.observed, { amount: 1.235, currency: 'KWD' });
  });

  it('keeps the T-07/T-08.1 KES float-trap reconciliation behaviour unchanged (AC-3)', async () => {
    await activateSubscription({ currency: 'KES', price: 0.3, cycle: 'MONTHLY', key: 'kes-trap' });
    reconciliation.registerSource(admin, {
      id: 't09-kes-source', providerId: 't09-sandbox-pay',
      async observe() {
        return [{
          providerReference: 't09-provider-ref', status: 'SUCCEEDED', amount: { amount: 0.1 + 0.2, currency: 'KES' }, observedAt: now,
          evidence: [evidence('t09-kes-observation')],
        }];
      },
    });
    const run = await reconciliation.reconcile(operator, { providerId: 't09-sandbox-pay', sourceId: 't09-kes-source' });
    assert.equal(run.status, 'RECONCILED', '0.30000000000000004 KES still reconciles against 0.3 KES');
  });
});

describe('T-09 AC-8 — per-currency analytics and MRR', () => {
  it('computes MRR/ARR per currency with half-up annual allocation at each scale', async () => {
    await activateSubscription({ currency: 'JPY', price: 100, cycle: 'ANNUAL', key: 'jpy-annual' });
    await activateSubscription({ currency: 'KWD', price: 1, cycle: 'ANNUAL', key: 'kwd-annual' });
    await activateSubscription({ currency: 'KES', price: 12, cycle: 'ANNUAL', key: 'kes-annual' });
    await activateSubscription({ currency: 'JPY', price: 1000, cycle: 'MONTHLY', key: 'jpy-monthly' });

    const snapshot = await analytics.snapshot(admin);
    const byCurrency = new Map(snapshot.currencies.map((entry) => [entry.currency, entry]));
    assert.deepEqual([...byCurrency.keys()].sort(), ['JPY', 'KES', 'KWD'], 'one bucket per currency, never a mixed total');

    const jpy = byCurrency.get('JPY')!;
    // annual 100 JPY -> (100 + 6) / 12 = 8 yen; monthly 1000 JPY -> MRR 1008
    assert.equal(jpy.mrr, 1008, 'JPY MRR is whole yen (8 from the annual plan + 1000 monthly)');
    assert.equal(jpy.arr, 12100, 'JPY ARR = 100 annual + 1000 x 12 monthly');
    assert.equal(jpy.recognizedRevenue, 1100, 'recognized revenue is 100 + 1000 yen, not 110000 minor units');
    assert.equal(minorUnitsOf(jpy.recognizedRevenue, 'JPY'), 1100n);

    const kwd = byCurrency.get('KWD')!;
    // annual 1.000 KWD = 1000 fils -> (1000 + 6) / 12 = 83 fils
    assert.equal(kwd.mrr, 0.083, 'KWD MRR keeps three decimals (a 2dp implementation would report 0.08)');
    assert.equal(kwd.arr, 1);
    assert.equal(kwd.recognizedRevenue, 1);
    assert.equal(minorUnitsOf(kwd.mrr, 'KWD'), 83n);

    const kes = byCurrency.get('KES')!;
    assert.equal(kes.mrr, 1, 'the T-08.1 KES annual MRR result is unchanged');
    assert.equal(kes.arr, 12);
    assert.equal(kes.recognizedRevenue, 12);

    const mrrObservations = snapshot.observations.filter((observation) => observation.metric === 'MRR');
    assert.equal(mrrObservations.length, 3, 'one MRR observation per currency');
    assert.deepEqual(
      mrrObservations.map((observation) => `${observation.currency}:${observation.value}`).sort(),
      ['JPY:1008', 'KES:1', 'KWD:0.083'],
    );
  });

  it('never mixes currencies into one revenue bucket (float-trap amounts included)', async () => {
    await activateSubscription({ currency: 'KES', price: 0.1, quantity: 3, lineTotal: 0.3, cycle: 'MONTHLY', key: 'kes-float' });
    await activateSubscription({ currency: 'JPY', price: 30, cycle: 'MONTHLY', key: 'jpy-small' });
    const snapshot = await analytics.snapshot(admin);
    const kes = snapshot.currencies.find((entry) => entry.currency === 'KES')!;
    const jpy = snapshot.currencies.find((entry) => entry.currency === 'JPY')!;
    // The invoice line is the float trap (0.1 x 3 -> 0.30000000000000004 in
    // IEEE-754); recognized revenue is exactly 0.3 KES.
    assert.equal(kes.recognizedRevenue, 0.3, '0.1 x 3 KES is exactly 0.3 (no 0.30000000000000004 drift)');
    assert.equal(jpy.recognizedRevenue, 30);
    // MRR/ARR come from the PLAN price, in exact minor units of that currency.
    assert.equal(kes.mrr, 0.1);
    assert.equal(jpy.mrr, 30);
    assert.equal(snapshot.currencies.length, 2);
    assert.equal(snapshot.currencies.filter((entry) => entry.recognizedRevenue === 30.3).length, 0, 'no bucket ever holds a cross-currency total');
    assert.equal(kes.arr, 1.2, 'KES ARR = 0.1 x 12 in exact minor units (10 x 12 = 120 cents)');
    assert.equal(jpy.arr, 360, 'JPY ARR = 30 x 12 whole yen');
  });
});

describe('T-09 AC-4/AC-5 — wallet inside the full commercial composition', () => {
  it('holds per-currency balances next to billing/analytics state and refuses cross-currency funding', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1500, currency: 'JPY' }, idempotencyKey: 'wallet-jpy' });
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 2.5, currency: 'KWD' }, idempotencyKey: 'wallet-kwd' });
    await activateSubscription({ currency: 'KES', price: 12, cycle: 'ANNUAL', key: 'kes-with-wallet' });

    const balances = await wallet.listBalances(operator, OWNER);
    assert.deepEqual(balances.map((balance) => `${balance.currency}:${balance.minorUnits}@${balance.scale}dp`), ['JPY:1500@0dp', 'KWD:2500@3dp']);

    await assert.rejects(
      () => wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 2501, currency: 'KWD' }, idempotencyKey: 'wallet-kwd-over' }),
      (error: unknown) => error instanceof WalletError && /Insufficient KWD balance/.test(error.message),
    );
    await assert.rejects(
      () => wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 1, currency: 'USD' }, idempotencyKey: 'wallet-usd-none' }),
      /Insufficient USD balance/,
    );
    assert.deepEqual((await wallet.listBalances(operator, OWNER)).map((balance) => `${balance.currency}:${balance.minorUnits}`), ['JPY:1500', 'KWD:2500']);
  });

  it('converts with the injected FX source at the target scale and keeps both legs auditable', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 2.5, currency: 'KWD' }, idempotencyKey: 'wallet-conv-src' });
    const result = await wallet.convert(operator, {
      ownerReference: OWNER, source: { amount: 2.5, currency: 'KWD' }, targetCurrency: 'USD', fx, idempotencyKey: 'wallet-conv-1', reason: 'T-09 payout',
    });
    // 2.5 KWD x 3.25 = 8.125 USD -> half-up at 2dp -> 8.13
    assert.deepEqual(result.converted, { amount: 8.13, currency: 'USD' });
    assert.equal(result.credit.minorUnits, '813');
    assert.equal(result.debit.minorUnits, '-2500');
    assert.equal(result.debit.conversionId, result.credit.conversionId);
    assert.equal(result.debit.fx?.rounding, 'half-up');
    assert.equal(result.debit.fx?.targetScale, 2);
    assert.deepEqual((await wallet.listBalances(operator, OWNER)).map((balance) => `${balance.currency}:${balance.minorUnits}`), ['KWD:0', 'USD:813']);

    await assert.rejects(
      () => wallet.convert(operator, { ownerReference: OWNER, source: { amount: 1, currency: 'USD' }, targetCurrency: 'KRW', fx, idempotencyKey: 'wallet-conv-norate' }),
      /No injected FX rate for USD->KRW/,
    );
    assert.equal((await wallet.getBalance(operator, OWNER, 'USD'))?.minorUnits, '813', 'a refused conversion moves nothing');
    assert.equal((await wallet.getBalance(operator, OWNER, 'KRW'))?.exists, false);
  });
});
