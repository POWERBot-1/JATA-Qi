// T-07 commercial state-transition and money-math integrity hardening over
// REAL PostgreSQL with REAL OS processes (acceptance criteria AC-1..AC-5).
//
//   * AC-1: two concurrent OS-process `verifyPayment` calls on one payment
//     produce exactly one VERIFIED finalization, one `payment.verified`
//     event, and one revenue-ledger entry; both callers observe the final
//     state (expected-status CAS + stable per-(payment, transition) anchor).
//   * AC-2: two concurrent OS-process `requestRefund` calls on one verified
//     payment admit at most one provider refund execution; the loser fails
//     closed before any provider call (CAS reservation).
//   * AC-3: a refund action planned while VERIFIED but executed after the
//     payment is REFUNDED fails closed BEFORE any provider invocation
//     (execution-time precondition).
//   * AC-4: duplicate/replayed finalization events (new event ids, same
//     anchors) never append a second ledger entry and never re-emit
//     (constraint-backed single-effect anchors in billing + revenue-ledger).
//   * AC-5: float-trap fixtures (0.1 + 0.2 lines; 19.99 x 3) produce exact,
//     deterministic totals and ledger summaries — no float artifacts.
//
// PostgreSQL is a HARD requirement (no silent skip).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
// R1 (§6 TEST KERNEL REPAIR): this fixture installs the REAL A-01
// AuthorizationBoundaryModule — the same module the production composition
// installs. It is NOT a mock, a stub, or a bypass. Legitimate kernel-internal
// worker operations establish scoped KERNEL_INTERNAL authority through the
// real boundary; anything out of scope is still denied.
import { AuthorizationBoundaryModule, testCapabilityManifest, testPrincipal } from '@jataqi/authorization-boundary';
import { AutonomousActionRuntimeModule, type ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import { CommercialControlPlaneModule, type CommercialActor, type CommercialControlPlaneService, type CommercialEvidence, type PublishCommercialEventInput } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule, type CommercialEventStreamService } from '@jataqi/commercial-event-stream';
import { BillingModule, type BillingService } from '@jataqi/billing';
import { PaymentCreateActionType, PaymentRefundActionType, PaymentsModule, type PaymentProvider, type PaymentsService } from '@jataqi/payments';
import { RevenueLedgerModule, type RevenueLedgerService } from '../src/index.js';

let pg: { server: EmbeddedPostgres; port: number; started: boolean } | undefined;
let dbCounter = 0;

before(async () => {
  const port = 58500 + Math.floor(Math.random() * 400);
  const server = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), `jataqi-t07-finalize-pg-${process.pid}`),
    port,
    user: 'postgres',
    password: 'postgres',
    authMethod: 'password',
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ['--no-locale', '--encoding=UTF8'],
    postgresFlags: [],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await server.initialise();
    await server.start();
    pg = { server, port, started: true };
  } catch (error) {
    console.warn('[t07-finalize-pg] PostgreSQL unavailable:', String((error as Error)?.message ?? error));
    pg = { server, port, started: false };
  }
});

after(async () => {
  if (pg?.started) await pg.server.stop().catch(() => undefined);
  pg = undefined;
});

const WORKER = new URL('./t07-finalize-worker.mjs', import.meta.url).pathname;

async function freshDb(): Promise<{ database: string; cs: string }> {
  if (!pg?.started) throw new Error('PostgreSQL unavailable.');
  const database = `t07test_${process.pid}_${dbCounter++}_${randomUUID().slice(0, 8)}`;
  await pg.server.createDatabase(database);
  return { database, cs: `postgres://postgres:postgres@127.0.0.1:${pg.port}/${database}` };
}

const admin: CommercialActor = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
const operator: CommercialActor = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
const system: CommercialActor = { id: 't07-system', tenantId: 'system', roles: ['system'] };

function evidence(now: number, id = 't07-evidence'): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 't07-test', observedAt: now, confidence: 95,
    summary: 'Controlled T-07 evidence.', provenance: { source: 't07-test', collectedAt: now, correlationId: 't07-correlation' },
  };
}

interface Node {
  database: string;
  cs: string;
  driver: PostgresDriver;
  control: CommercialControlPlaneService;
  stream: CommercialEventStreamService;
  runtime: ActionRuntimeService;
  payments: PaymentsService;
  billing: BillingService;
  ledger: RevenueLedgerService;
  providerRefundCalls: () => number;
  /** R1: legitimate, narrowly-scoped authorization for direct runtime drives. */
  authorization: { principal: ReturnType<typeof testPrincipal>; capabilityId: string; capabilityVersion: string };
  close(): Promise<void>;
}

async function bootNode(): Promise<Node> {
  const { database, cs } = await freshDb();
  const driver = new PostgresDriver({ connectionString: cs, requireExplicitConfig: true, max: 10 });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new CommercialControlPlaneModule());
  kernel.register(new AuthorizationBoundaryModule());
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  kernel.register(new CommercialEventStreamModule({ workerId: 't07-worker', wakeOnPublish: true }));
  kernel.register(new BillingModule());
  kernel.register(new RevenueLedgerModule());
  await kernel.boot();
  const control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  const payments = kernel.getModule<PaymentsModule>('payments').getService();
  let refundCalls = 0;
  const now = () => Date.now();
  payments.registerProvider(admin, provider('t07-sandbox-provider', () => { refundCalls += 1; }, now));
  await control.createPolicy(admin, {
    version: 't07-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [PaymentCreateActionType, PaymentRefundActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
  return {
    database,
    cs,
    driver,
    control,
    stream: kernel.getModule<CommercialEventStreamModule>('commercial-event-stream').getService(),
    runtime: kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService(),
    payments,
    billing: kernel.getModule<BillingModule>('billing').getService(),
    ledger: kernel.getModule<RevenueLedgerModule>('revenue-ledger').getService(),
    providerRefundCalls: () => refundCalls,
    // R1 (§6): LEGITIMATE authorization for tests that drive the action
    // runtime directly. A narrow REAL manifest bound to the payments adapter
    // identity plus a verified principal — no mock, no bypass. Anything
    // outside this scope is still denied by the real decision point.
    authorization: (() => {
      const gate = kernel.getModule<AuthorizationBoundaryModule>('authorization-boundary').getService();
      gate.manifestsRegistry.register(
        testCapabilityManifest({
          capabilityId: 't07.payments.direct',
          operations: [
            { tool: 'payment:t07-sandbox-provider', operation: PaymentCreateActionType },
            { tool: 'payment:t07-sandbox-provider', operation: PaymentRefundActionType },
          ],
          targets: [{ system: 'payment:t07-sandbox-provider' }],
          tenantScopes: ['acme'],
          maxImpact: 'EXTERNAL_SIDE_EFFECT',
          rateLimit: { windowMs: 60_000, max: 100_000 },
          budgetPerRunCostUnits: 100_000,
        }),
      );
      return {
        principal: testPrincipal({ id: 'user:operator', tenantId: 'acme', roles: ['operator'] }),
        capabilityId: 't07.payments.direct',
        capabilityVersion: '1',
      };
    })(),
    async close() {
      await kernel.shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await pg?.server.dropDatabase(database).catch(() => undefined);
    },
  };
}

function provider(id: string, onRefund: () => void, now: () => number): PaymentProvider {
  return {
    id, currencies: ['KES'], supportsRefunds: true, environment: 'sandbox',
    async createPayment() { return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: `${id}-pay-1` }; },
    async verifyPayment(context) {
      if (context.operation === 'REFUND_PAYMENT') {
        return { verified: true, providerStatus: 'REFUNDED', providerReference: `${id}-refund-1`, observedAmount: context.payment.refundAmount ?? context.payment.amount, evidence: [evidence(now(), `${id}-refund-verify`)] };
      }
      return { verified: true, providerStatus: 'SUCCEEDED', providerReference: `${id}-pay-1`, observedAmount: context.payment.amount, evidence: [evidence(now(), `${id}-verify`)] };
    },
    async refundPayment() { onRefund(); return { reportedSuccess: true, providerStatus: 'REFUNDED', providerReference: `${id}-refund-1` }; },
  };
}

async function drain(node: Node, maxPasses = 8): Promise<void> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await node.stream.pump(system, { allTenants: true });
    if (result.examined === 0) return;
  }
  throw new Error('T-07 drain did not settle within pass budget.');
}

interface PaymentSetup { invoiceId: string; paymentId: string; subscriptionId?: string }

/** ISSUED -> PAYMENT_PENDING invoice + SUCCEEDED_UNVERIFIED payment (amount from `total`). */
async function unverifiedPayment(node: Node, key: string, total: { amount: number; currency: string }, quantity = 1, subscriptionId?: string): Promise<PaymentSetup> {
  const plan = await node.billing.createPlan(admin, { productId: `product-${key}`, name: `Plan ${key}`, price: { amount: total.amount, currency: total.currency }, cycle: 'MONTHLY' });
  const subscription = subscriptionId ?? (await node.billing.createSubscription(operator, { productId: `product-${key}`, planId: plan.id, customerReference: `customer-${key}` })).id;
  const created = await node.billing.createInvoice(operator, {
    subscriptionId: subscription, productId: `product-${key}`, customerReference: `customer-${key}`,
    lines: [{ description: `Line ${key}`, quantity, unitPrice: total, total }],
  });
  const invoice = await node.billing.createInvoicePayment(operator, created.id, { providerId: 't07-sandbox-provider', idempotencyKey: `payment:${key}` });
  const decision = await node.control.proposeDecision(operator, {
    tenantId: 'acme', productId: `product-${key}`, objective: 'Collect governed payment.', proposedAction: 'Collect payment.', actionType: PaymentCreateActionType,
    estimatedCost: total, evidence: [evidence(Date.now(), `${key}-evidence`)], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85, authorizationLevel: 2,
    decisionReason: 'Bounded test amount.', provenance: { source: 't07-test', collectedAt: Date.now(), correlationId: `t07-${key}` },
  });
  const reported = await node.payments.executePayment(operator, invoice.paymentId!, { decisionId: decision.id, idempotencyKey: `collect:${key}`, dryRun: false });
  assert.equal(reported.status, 'SUCCEEDED_UNVERIFIED');
  return { invoiceId: invoice.id, paymentId: invoice.paymentId!, subscriptionId: subscription };
}

async function refundDecision(node: Node, key: string, amount: { amount: number; currency: string }): Promise<string> {
  const decision = await node.control.proposeDecision(operator, {
    tenantId: 'acme', productId: `product-${key}`, objective: 'Execute governed refund.', proposedAction: 'Refund payment.', actionType: PaymentRefundActionType,
    estimatedCost: amount, evidence: [evidence(Date.now(), `${key}-refund-evidence`)], evidenceStrength: 90, riskScore: 25, complianceScore: 95, confidence: 85, authorizationLevel: 2,
    decisionReason: 'Bounded refund amount.', provenance: { source: 't07-test', collectedAt: Date.now(), correlationId: `t07-refund-${key}` },
  });
  return decision.id;
}

function runWorkers(cs: string, mode: 'verify' | 'refund', count: number, tag: string, extra: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const outs = Array.from({ length: count }, (_, w) => path.join(os.tmpdir(), `t07-finalize-${tag}-${process.pid}-${w}-${randomUUID().slice(0, 8)}.json`));
  return Promise.all(outs.map((out, w) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = fork(WORKER, [], {
      env: {
        ...process.env, JATAQI_TEST_PG_CS: cs, WORKER_MODE: mode, WORKER_ID: `${tag}-${w}`, OUT: out, ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`worker ${tag}-${w} timed out; stderr: ${stderr.slice(0, 800)}`)); }, 120_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`worker ${tag}-${w} exited ${code}; stderr: ${stderr.slice(0, 800)}`)); return; }
      try { resolve(JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, unknown>); } catch (error) { reject(new Error(`worker ${tag}-${w} produced no parseable result: ${String(error)}`)); }
    });
  })));
}

async function countEvents(node: Node, eventType: string): Promise<number> {
  return (await node.control.replayEvents(operator, {})).filter((event) => event.eventType === eventType).length;
}

describe('T-07 finalization concurrency + money math integrity over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg?.started, 'DATABASE INTEGRATION NOT EXECUTED: embedded PostgreSQL failed to start.');
  });

  it('AC-1: two concurrent OS-process verifyPayment calls produce exactly one VERIFIED finalization, one event, and one ledger entry', async () => {
    const node = await bootNode();
    try {
      const { invoiceId, paymentId } = await unverifiedPayment(node, 'ac1', { amount: 100, currency: 'KES' });
      const results = await runWorkers(node.cs, 'verify', 2, 'ac1', { PAYMENT_ID: paymentId });
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.status, 'VERIFIED', 'both concurrent callers observe the same final state (I-3/AC-1)');
      }
      await drain(node);
      assert.equal((await node.payments.getPayment(operator, paymentId))?.status, 'VERIFIED');
      assert.equal(await countEvents(node, 'payment.verified'), 1, 'exactly one PaymentVerified event');
      assert.equal((await node.billing.getInvoice(operator, invoiceId))?.status, 'PAID');
      assert.equal((await node.billing.getSubscription(operator, (await node.billing.getInvoice(operator, invoiceId))!.subscriptionId!))?.status, 'ACTIVE');
      const entries = await node.ledger.listEntries(operator);
      assert.equal(entries.length, 1, 'exactly one revenue-ledger entry');
      assert.deepEqual(await node.ledger.verifyIntegrity(operator), { valid: true, entries: 1 });
      assert.equal(await countEvents(node, 'billing.invoice.paid'), 1);
      assert.equal(await countEvents(node, 'revenue.recorded'), 1);
    } finally {
      await node.close();
    }
  });

  it('AC-2: two concurrent OS-process requestRefund calls produce at most one provider refund execution', async () => {
    const node = await bootNode();
    try {
      const { paymentId } = await unverifiedPayment(node, 'ac2', { amount: 100, currency: 'KES' });
      await node.payments.verifyPayment(operator, paymentId);
      await drain(node);
      const decisionId = await refundDecision(node, 'ac2', { amount: 100, currency: 'KES' });
      const results = await runWorkers(node.cs, 'refund', 2, 'ac2', { PAYMENT_ID: paymentId, DECISION_ID: decisionId });
      const winners = results.filter((result) => result.ok === true);
      const losers = results.filter((result) => result.ok === false);
      assert.equal(winners.length, 1, `exactly one refund request wins the CAS reservation: ${JSON.stringify(results)}`);
      assert.equal(losers.length, 1, 'the other refund request fails closed');
      assert.equal(winners[0]?.status, 'REFUND_UNVERIFIED');
      assert.equal(winners[0]?.providerCalls, 1, 'exactly one provider refund call in the winning process');
      assert.equal(losers[0]?.providerCalls, 0, 'the loser never reaches the provider');
      assert.match(String(losers[0]?.error ?? ''), /cannot transition|Only a verified payment/);
      // Complete the refund through the canonical verify path.
      const refunded = await node.payments.verifyRefund(operator, paymentId);
      assert.equal(refunded.status, 'REFUNDED');
      await drain(node);
      assert.equal(await countEvents(node, 'payment.refund.verified'), 1, 'exactly one RefundVerified event');
      assert.equal((await node.billing.getInvoice(operator, (await node.payments.getPayment(operator, paymentId))!.invoiceId!))?.status, 'REFUNDED');
      const entries = await node.ledger.listEntries(operator);
      assert.equal(entries.length, 2, 'one revenue + one reversal');
      assert.deepEqual(await node.ledger.verifyIntegrity(operator), { valid: true, entries: 2 });
    } finally {
      await node.close();
    }
  });

  it('AC-3: a stale refund action (planned while VERIFIED, executed after REFUNDED) fails closed before any provider call', async () => {
    const node = await bootNode();
    try {
      const { paymentId } = await unverifiedPayment(node, 'ac3', { amount: 100, currency: 'KES' });
      await node.payments.verifyPayment(operator, paymentId);
      await drain(node);
      // Plan a refund action while the payment is VERIFIED but do not run it.
      const decisionId = await refundDecision(node, 'ac3', { amount: 100, currency: 'KES' });
      const staleAction = await node.runtime.plan(operator, decisionId, {
        targetSystem: 'payment:t07-sandbox-provider', idempotencyKey: 'stale-refund-action', dryRun: false,
        parameters: { paymentId, operation: 'REFUND_PAYMENT', reason: 'stale' },
        resourceRequirements: [{ resourceType: 'MONEY', amount: 100, unit: 'KES', currency: 'KES' }],
      });
      assert.ok(staleAction, 'stale refund action must plan while VERIFIED');
      // Now refund for real (second action) and complete it.
      const liveDecisionId = await refundDecision(node, 'ac3-live', { amount: 100, currency: 'KES' });
      const queued = await node.payments.requestRefund(operator, paymentId, { decisionId: liveDecisionId, idempotencyKey: 'live-refund-action', dryRun: false, reason: 'Live T-07 refund.' });
      assert.equal(queued.status, 'REFUND_UNVERIFIED');
      assert.equal(node.providerRefundCalls(), 1);
      await node.payments.verifyRefund(operator, paymentId);
      await drain(node);
      assert.equal((await node.payments.getPayment(operator, paymentId))?.status, 'REFUNDED');
      // Execute the STALE action afterwards: the execution-time precondition
      // must refuse it BEFORE any provider invocation.
      const execution = await node.runtime.execute(operator, staleAction.id, { maxAttempts: 3, timeoutMs: 60_000, authorization: node.authorization });
      assert.equal(execution.action.executionStatus, 'FAILED', 'stale action fails closed at execute time');
      assert.match(execution.action.error ?? '', /no longer authorizes provider execution/);
      assert.equal(node.providerRefundCalls(), 1, 'no second provider refund call from the stale action (AC-3/I-2)');
      assert.equal((await node.payments.getPayment(operator, paymentId))?.status, 'REFUNDED', 'payment state unchanged by the stale action');
      const entries = await node.ledger.listEntries(operator);
      assert.equal(entries.length, 2);
      assert.equal(await countEvents(node, 'payment.refund.verified'), 1);
    } finally {
      await node.close();
    }
  });

  it('AC-4: duplicate/replayed finalization events never append a second ledger entry and never re-emit', async () => {
    const node = await bootNode();
    try {
      const { invoiceId, paymentId } = await unverifiedPayment(node, 'ac4', { amount: 100, currency: 'KES' });
      await node.payments.verifyPayment(operator, paymentId);
      await drain(node);
      assert.equal(await countEvents(node, 'billing.invoice.paid'), 1);
      assert.equal((await node.ledger.listEntries(operator)).length, 1);
      const publish = (idempotencyKey: string, eventType: string): Promise<unknown> => {
        const input: PublishCommercialEventInput = {
          eventType, source: 'billing', entityId: invoiceId, correlationId: invoiceId, payload: { invoiceId, paymentId },
          provenance: { source: 't07-test', collectedAt: Date.now(), correlationId: invoiceId }, privacyClassification: 'RESTRICTED', idempotencyKey,
        };
        return node.control.publishEvent(operator, input);
      };
      // Duplicate finalization deliveries with NEW event ids and the SAME
      // (invoice, payment) anchors — the double-finalization replay case.
      await publish('dup-paid-1', 'billing.invoice.paid');
      await publish('dup-paid-2', 'billing.invoice.paid');
      await publish('dup-verified-1', 'payment.verified');
      await drain(node);
      const events = await node.control.replayEvents(operator, {});
      // The duplicates themselves are recorded (they were injected with new
      // event ids), but the billing/ledger EFFECTS must not re-run: no second
      // billing emission (billing emits with a causationId), no second
      // payment.verified for the real payment entity, no second ledger entry.
      assert.equal(events.filter((event) => event.eventType === 'billing.invoice.paid' && event.causationId !== undefined).length, 1, 'billing never re-emits invoice.paid for a duplicate');
      assert.equal(events.filter((event) => event.eventType === 'payment.verified' && event.entityId === paymentId).length, 1);
      assert.equal(events.filter((event) => event.eventType === 'revenue.recorded').length, 1);
      assert.equal((await node.ledger.listEntries(operator)).length, 1, 'no second ledger append under duplicate delivery (I-6)');
      assert.deepEqual(await node.ledger.verifyIntegrity(operator), { valid: true, entries: 1 });
      assert.equal((await node.billing.getInvoice(operator, invoiceId))?.status, 'PAID');
    } finally {
      await node.close();
    }
  });

  it('AC-5: float-trap invoice chains settle with exact deterministic money (0.1 + 0.2 lines; 19.99 x 3)', async () => {
    const node = await bootNode();
    try {
      // Invoice A: two lines whose raw float sum is 0.30000000000000004.
      const plan = await node.billing.createPlan(admin, { productId: 'product-float', name: 'Float plan', price: { amount: 0.3, currency: 'KES' }, cycle: 'MONTHLY' });
      const subscription = await node.billing.createSubscription(operator, { productId: 'product-float', planId: plan.id, customerReference: 'customer-float' });
      const invoiceA = await node.billing.createInvoice(operator, {
        subscriptionId: subscription.id, productId: 'product-float', customerReference: 'customer-float',
        lines: [
          { description: 'A1', quantity: 1, unitPrice: { amount: 0.1, currency: 'KES' }, total: { amount: 0.1, currency: 'KES' } },
          { description: 'A2', quantity: 1, unitPrice: { amount: 0.2, currency: 'KES' }, total: { amount: 0.2, currency: 'KES' } },
        ],
      });
      assert.equal(invoiceA.total.amount, 0.3, '0.1 + 0.2 sums to exactly 0.3 (never 0.30000000000000004)');
      // Invoice B: 19.99 x 3 (raw float product is 59.969999999999995).
      const invoiceB = await node.billing.createInvoice(operator, {
        subscriptionId: subscription.id, productId: 'product-float', customerReference: 'customer-float',
        lines: [{ description: 'B1', quantity: 3, unitPrice: { amount: 19.99, currency: 'KES' }, total: { amount: 59.97, currency: 'KES' } }],
      });
      assert.equal(invoiceB.total.amount, 59.97, '19.99 x 3 product check passes exactly');
      // Drive both invoices through payment + verification; both must settle
      // (moneyEquals between invoice total and payment amount is scale-exact).
      const decision = await node.control.proposeDecision(operator, {
        tenantId: 'acme', productId: 'product-float', objective: 'Collect governed payment.', proposedAction: 'Collect payment.', actionType: PaymentCreateActionType,
        estimatedCost: { amount: 0.3, currency: 'KES' }, evidence: [evidence(Date.now(), 'float-evidence')], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85, authorizationLevel: 2,
        decisionReason: 'Bounded float amount.', provenance: { source: 't07-test', collectedAt: Date.now(), correlationId: 't07-float' },
      });
      for (const invoice of [invoiceA, invoiceB]) {
        const payable = await node.billing.createInvoicePayment(operator, invoice.id, { providerId: 't07-sandbox-provider', idempotencyKey: `payment:float:${invoice.id}` });
        const decisionFor = invoice.id === invoiceA.id
          ? decision
          : await node.control.proposeDecision(operator, {
              tenantId: 'acme', productId: 'product-float', objective: 'Collect governed payment.', proposedAction: 'Collect payment.', actionType: PaymentCreateActionType,
              estimatedCost: { amount: 59.97, currency: 'KES' }, evidence: [evidence(Date.now(), 'float-evidence-b')], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85, authorizationLevel: 2,
              decisionReason: 'Bounded float amount.', provenance: { source: 't07-test', collectedAt: Date.now(), correlationId: 't07-float-b' },
            });
        await node.payments.executePayment(operator, payable.paymentId!, { decisionId: decisionFor.id, idempotencyKey: `collect:float:${invoice.id}`, dryRun: false });
        const verified = await node.payments.verifyPayment(operator, payable.paymentId!);
        assert.equal(verified.status, 'VERIFIED');
      }
      await drain(node);
      assert.equal((await node.billing.getInvoice(operator, invoiceA.id))?.status, 'PAID', '0.1+0.2 invoice is paid (no false mismatch)');
      assert.equal((await node.billing.getInvoice(operator, invoiceB.id))?.status, 'PAID', '19.99x3 invoice is paid (no false mismatch)');
      const entries = await node.ledger.listEntries(operator);
      assert.equal(entries.length, 2);
      const amounts = entries.map((entry) => entry.amount.amount).sort((a, b) => a - b);
      assert.deepEqual(amounts, [0.3, 59.97], 'ledger entries carry exact quantized amounts');
      const summary = await node.ledger.summarize(operator);
      assert.equal(summary.length, 1);
      assert.equal(summary[0]?.currency, 'KES');
      assert.equal(summary[0]?.recognizedRevenue, 60.27, 'ledger summary is the exact deterministic sum (0.3 + 59.97)');
      assert.deepEqual(await node.ledger.verifyIntegrity(operator), { valid: true, entries: 2 });
    } finally {
      await node.close();
    }
  });
});
