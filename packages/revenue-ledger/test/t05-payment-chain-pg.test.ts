// T-05 payment/event composition over REAL PostgreSQL — the production
// durable chain end to end:
//
//   payments.verifyPayment  (payment state + payment.verified + outbox: ONE tx)
//     -> unified outbox -> delivery worker (claim / inbox / fenced ack)
//     -> billing durable handler (invoice PAID + subscription ACTIVE +
//        billing.invoice.paid + outbox: ONE tx)
//     -> unified outbox -> worker
//     -> revenue-ledger durable handler (ledger entry + revenue.recorded: ONE tx)
//
// Proven here on a transactional backend:
//   1. production wiring: with the post-commit wake-up, verifyPayment resolves
//      with the whole downstream chain settled and every outbox record
//      DELIVERED behind a durable inbox row per handler;
//   2. producer composition: a failure injected AFTER the outbox write but
//      BEFORE commit rolls back the payment state, the event and the outbox
//      record together (nothing leaks, the chain does not start);
//   3. subscriber composition: a failure injected inside the billing effect
//      rolls back the invoice mutation together with its event/outbox record;
//      the inbox row is RETRYING; after backoff the redelivery completes the
//      chain exactly once (idempotent effects, no duplicate ledger entry);
//   4. provenance: the ledger entry's tenant equals the invoice's, the
//      payment's and the originating event's tenant, and causation links each
//      hop to the previous event.
//
// PostgreSQL is a hard requirement (no silent skip).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialControlPlaneService,
  type CommercialEvidence,
  type PublishCommercialEventInput,
} from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule, type CommercialEventStreamService } from '@jataqi/commercial-event-stream';
import { BILLING_DURABLE_HANDLER_ID, BillingModule, type BillingService } from '@jataqi/billing';
import { PaymentCreateActionType, PaymentsModule, type PaymentProvider, type PaymentsService } from '@jataqi/payments';
import { REVENUE_LEDGER_DURABLE_HANDLER_ID, RevenueLedgerModule, type RevenueLedgerService } from '../src/index.js';

let pg: { server: EmbeddedPostgres; port: number; user: string; password: string; started: boolean } | undefined;
let dbCounter = 0;

before(async () => {
  const port = 57900 + Math.floor(Math.random() * 900);
  const server = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), `jataqi-t05-chain-pg-${process.pid}`),
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
    pg = { server, port, user: 'postgres', password: 'postgres', started: true };
  } catch (error) {
    console.warn('[t05-chain-pg] PostgreSQL unavailable:', String((error as Error)?.message ?? error));
    pg = { server, port, user: 'postgres', password: 'postgres', started: false };
  }
});

after(async () => {
  if (pg?.started) await pg.server.stop().catch(() => undefined);
  pg = undefined;
});

const admin: CommercialActor = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
const operator: CommercialActor = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
const system: CommercialActor = { id: 't05-chain-system', tenantId: 'system', roles: ['system'] };

function evidence(now: number, id = 'chain-evidence'): CommercialEvidence {
  return {
    id, status: 'MEASURED', source: 'chain-test', observedAt: now, confidence: 95,
    summary: 'Controlled evidence.', provenance: { source: 'chain-test', collectedAt: now, correlationId: 'chain-correlation' },
  };
}

function provider(now: () => number): PaymentProvider {
  return {
    id: 'chain-sandbox-provider', currencies: ['KES'], supportsRefunds: true, environment: 'sandbox',
    async createPayment() { return { reportedSuccess: true, providerStatus: 'SUCCEEDED', providerReference: 'provider-pay-1' }; },
    async verifyPayment(context) {
      return { verified: true, providerStatus: 'SUCCEEDED', providerReference: 'provider-pay-1', observedAmount: context.payment.amount, evidence: [evidence(now(), 'payment-verification')] };
    },
    async refundPayment() { return { reportedSuccess: true, providerStatus: 'REFUNDED', providerReference: 'provider-refund-1' }; },
  };
}

interface Node {
  database: string;
  driver: PostgresDriver;
  storage: StorageModule;
  control: CommercialControlPlaneService;
  stream: CommercialEventStreamService;
  payments: PaymentsService;
  billing: BillingService;
  ledger: RevenueLedgerService;
  now: () => number;
  advance(ms: number): void;
  close(): Promise<void>;
}

async function bootNode(options: { wakeOnPublish: boolean }): Promise<Node> {
  if (!pg?.started) throw new Error('DATABASE INTEGRATION NOT EXECUTED: embedded PostgreSQL failed to start.');
  const database = `t05chain_${process.pid}_${dbCounter++}_${randomUUID().slice(0, 8)}`;
  await pg.server.createDatabase(database);
  let clock = Date.now();
  const now = () => clock;
  const driver = new PostgresDriver({
    connectionString: `postgres://${pg.user}:${pg.password}@127.0.0.1:${pg.port}/${database}`,
    requireExplicitConfig: true,
    max: 8,
  });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new CommercialControlPlaneModule({ now }));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  kernel.register(new CommercialEventStreamModule({ now, workerId: 'chain-worker', wakeOnPublish: options.wakeOnPublish }));
  kernel.register(new BillingModule());
  kernel.register(new RevenueLedgerModule());
  await kernel.boot();
  const control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  const payments = kernel.getModule<PaymentsModule>('payments').getService();
  payments.registerProvider(admin, provider(now));
  await control.createPolicy(admin, {
    version: 'chain-policy', scope: { tenantId: 'acme' }, maximumAutonomyLevel: 3, allowExecution: true,
    allowedActionTypes: [PaymentCreateActionType], maximumRiskScore: 60, minimumComplianceScore: 80, minimumEvidenceStrength: 70,
  });
  return {
    database,
    driver,
    storage: kernel.getModule<StorageModule>('storage'),
    control,
    stream: kernel.getModule<CommercialEventStreamModule>('commercial-event-stream').getService(),
    payments,
    billing: kernel.getModule<BillingModule>('billing').getService(),
    ledger: kernel.getModule<RevenueLedgerModule>('revenue-ledger').getService(),
    now,
    advance: (ms) => { clock += ms; },
    async close() {
      await kernel.shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
      await pg?.server.dropDatabase(database).catch(() => undefined);
    },
  };
}

/** Explicit worker passes until the cascade settles (bounded; production uses the wake-up drain + host cycles). */
async function drain(node: Node, maxPasses = 6) {
  const totals = { examined: 0, delivered: 0, retried: 0, deadLettered: 0, quarantined: 0, fenceRejected: 0, skipped: 0, schemaRejected: 0, released: 0 };
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await node.stream.pump(system, { allTenants: true });
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result[key];
    if (result.examined === 0) break;
  }
  return totals;
}

async function unverifiedInvoicePayment(node: Node) {
  const plan = await node.billing.createPlan(admin, { productId: 'product-1', name: 'Plan', price: { amount: 100, currency: 'KES' }, cycle: 'MONTHLY' });
  const subscription = await node.billing.createSubscription(operator, { productId: 'product-1', planId: plan.id, customerReference: 'customer-hash' });
  const created = await node.billing.createInvoice(operator, { subscriptionId: subscription.id, productId: 'product-1', customerReference: 'customer-hash', lines: [{ description: 'Plan', quantity: 1, unitPrice: { amount: 100, currency: 'KES' }, total: { amount: 100, currency: 'KES' } }] });
  const invoice = await node.billing.createInvoicePayment(operator, created.id, { providerId: 'chain-sandbox-provider', idempotencyKey: `payment:${created.id}` });
  const decision = await node.control.proposeDecision(operator, {
    tenantId: 'acme', productId: 'product-1', objective: 'Perform governed financial operation.', proposedAction: PaymentCreateActionType, actionType: PaymentCreateActionType,
    estimatedCost: { amount: 100, currency: 'KES' }, evidence: [evidence(node.now())], evidenceStrength: 90, riskScore: 20, complianceScore: 95, confidence: 85,
    authorizationLevel: 2, decisionReason: 'Verified billing context bounds financial exposure.', provenance: { source: 'chain-test', collectedAt: node.now(), correlationId: 'chain-correlation' },
  });
  const reported = await node.payments.executePayment(operator, invoice.paymentId!, { decisionId: decision.id, idempotencyKey: `collect:${invoice.id}`, dryRun: false });
  assert.equal(reported.status, 'SUCCEEDED_UNVERIFIED');
  return { subscription, invoice, paymentId: invoice.paymentId! };
}

/**
 * Fault injection at the composition boundary: the control plane's
 * `publishEvent` performs its real composed write (event + outbox inside the
 * caller's scope) and THEN throws for the selected event type, once. Models
 * a failure after the outbox write but before COMMIT.
 */
function injectPostPublishFailure(control: CommercialControlPlaneService, eventType: string): { restore(): void; fired(): number } {
  const original = control.publishEvent.bind(control);
  let fired = 0;
  const patched: CommercialControlPlaneService['publishEvent'] = async (actor, input: PublishCommercialEventInput, options) => {
    const event = await original(actor, input, options);
    if (input.eventType === eventType && fired === 0) {
      fired += 1;
      throw new Error(`injected failure after ${eventType} outbox write`);
    }
    return event;
  };
  (control as unknown as { publishEvent: typeof patched }).publishEvent = patched;
  return {
    restore: () => { delete (control as unknown as { publishEvent?: typeof patched }).publishEvent; },
    fired: () => fired,
  };
}

describe('T-05 payment -> billing -> revenue-ledger durable chain over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg?.started, 'DATABASE INTEGRATION NOT EXECUTED: embedded PostgreSQL failed to start.');
  });

  it('production wiring: verifyPayment resolves with the whole chain settled through the durable outbox (wake-up drain)', async () => {
    const node = await bootNode({ wakeOnPublish: true });
    try {
      assert.equal(node.storage.supportsTransactions(), true);
      const { subscription, invoice, paymentId } = await unverifiedInvoicePayment(node);
      assert.equal((await node.ledger.listEntries(operator)).length, 0);
      const verified = await node.payments.verifyPayment(operator, paymentId);
      assert.equal(verified.status, 'VERIFIED');
      // Downstream effects are settled when verifyPayment resolves (drain after commit).
      assert.equal((await node.billing.getInvoice(operator, invoice.id))?.status, 'PAID');
      assert.equal((await node.billing.getSubscription(operator, subscription.id))?.status, 'ACTIVE');
      const entries = await node.ledger.listEntries(operator);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.entryType, 'REVENUE');
      assert.equal(entries[0]?.tenantId, 'acme');
      assert.deepEqual(await node.ledger.verifyIntegrity(operator), { valid: true, entries: 1 });
      // Every durable-domain record went through the canonical outbox and is DELIVERED.
      const outbox = await node.control.replayUnifiedOutbox(operator, {});
      const byType = new Map(outbox.map((record) => [record.eventType, record]));
      for (const type of ['payment.verified', 'billing.invoice.paid', 'subscription.activated', 'revenue.recorded']) {
        assert.ok(byType.has(type), `outbox must contain ${type}`);
      }
      const durableTypes = new Set(node.stream.handledEventTypes());
      for (const record of outbox) {
        if (durableTypes.has(record.eventType)) assert.equal(record.state, 'DELIVERED', `${record.eventType} must be DELIVERED (got ${record.state})`);
        else assert.equal(record.state, 'PENDING', `${record.eventType} has no durable subscriber and stays PENDING (read-only replay view)`);
      }
      assert.equal((await node.control.verifyUnifiedOutboxIntegrity(operator)).valid, true);
      // One durable inbox row per (event, handler) on the chain.
      const paymentVerified = byType.get('payment.verified')!;
      const invoicePaid = byType.get('billing.invoice.paid')!;
      const billingInbox = await node.stream.getDelivery(operator, paymentVerified.eventId, BILLING_DURABLE_HANDLER_ID);
      const ledgerInbox = await node.stream.getDelivery(operator, invoicePaid.eventId, REVENUE_LEDGER_DURABLE_HANDLER_ID);
      assert.equal(billingInbox?.state, 'DELIVERED');
      assert.equal(billingInbox?.attemptCount, 1);
      assert.equal(ledgerInbox?.state, 'DELIVERED');
      assert.equal(ledgerInbox?.attemptCount, 1);
      // Causation links each hop to the previous durable event; tenant is preserved at every hop.
      const events = await node.control.replayEvents(operator, {});
      const verifiedEvent = events.find((event) => event.eventType === 'payment.verified')!;
      const paidEvent = events.find((event) => event.eventType === 'billing.invoice.paid')!;
      const recordedEvent = events.find((event) => event.eventType === 'revenue.recorded')!;
      assert.equal(paidEvent.causationId, verifiedEvent.id);
      assert.equal(recordedEvent.causationId, paidEvent.id);
      assert.equal(verifiedEvent.tenantId, 'acme');
      assert.equal(paidEvent.tenantId, 'acme');
      assert.equal(recordedEvent.tenantId, 'acme');
      assert.equal(verifiedEvent.actor, operator.id, 'the producer principal is recorded server-side');
      assert.equal(entries[0]?.sourceEventId, paidEvent.id);
      // Idempotency across a second pass: nothing is redelivered or duplicated.
      const again = await node.stream.pump(system, { allTenants: true });
      assert.equal(again.examined, 0);
      assert.equal((await node.ledger.listEntries(operator)).length, 1);
    } finally {
      await node.close();
    }
  });

  it('producer composition: a failure after the outbox write but before commit rolls back payment state + event + outbox together', async () => {
    const node = await bootNode({ wakeOnPublish: false });
    try {
      const { invoice, paymentId } = await unverifiedInvoicePayment(node);
      const fault = injectPostPublishFailure(node.control, 'payment.verified');
      await assert.rejects(node.payments.verifyPayment(operator, paymentId), /injected failure after payment.verified outbox write/);
      assert.equal(fault.fired(), 1);
      fault.restore();
      // Nothing leaked: the payment is still awaiting verification, no event, no outbox record, no downstream effect.
      assert.equal((await node.payments.getPayment(operator, paymentId))?.status, 'SUCCEEDED_UNVERIFIED');
      assert.equal((await node.control.replayEvents(operator, {})).some((event) => event.eventType === 'payment.verified'), false);
      assert.equal((await node.control.replayUnifiedOutbox(operator, {})).some((record) => record.eventType === 'payment.verified'), false);
      assert.equal((await node.stream.pump(system, { allTenants: true })).delivered, 0);
      assert.equal((await node.billing.getInvoice(operator, invoice.id))?.status, 'PAYMENT_PENDING');
      assert.equal((await node.ledger.listEntries(operator)).length, 0);
      assert.equal((await node.control.verifyUnifiedOutboxIntegrity(operator)).valid, true);
      // The action already carries the durable provider verdict (external effect recorded before the
      // composed write): the retry resumes from it — no second provider verification — and the
      // per-tenant publish lock released by the rollback lets the chain complete.
      const retried = await node.payments.verifyPayment(operator, paymentId);
      assert.equal(retried.status, 'VERIFIED');
      assert.equal((await node.control.replayEvents(operator, {})).filter((event) => event.eventType === 'payment.verified').length, 1);
      await drain(node);
      assert.equal((await node.billing.getInvoice(operator, invoice.id))?.status, 'PAID');
      assert.equal((await node.ledger.listEntries(operator)).length, 1);
      assert.deepEqual(await node.ledger.verifyIntegrity(operator), { valid: true, entries: 1 });
    } finally {
      await node.close();
    }
  });

  it('subscriber composition: a failure inside the billing effect rolls back the invoice with its event/outbox; the retry completes the chain once', async () => {
    const node = await bootNode({ wakeOnPublish: false });
    try {
      const { subscription, invoice, paymentId } = await unverifiedInvoicePayment(node);
      await node.payments.verifyPayment(operator, paymentId);
      const fault = injectPostPublishFailure(node.control, 'billing.invoice.paid');
      const first = await node.stream.pump(system, { allTenants: true });
      assert.equal(first.retried, 1, JSON.stringify(first));
      assert.equal(fault.fired(), 1);
      // The billing mutation and its billing.invoice.paid event rolled back together.
      assert.equal((await node.billing.getInvoice(operator, invoice.id))?.status, 'PAYMENT_PENDING');
      assert.equal((await node.billing.getSubscription(operator, subscription.id))?.status, 'PENDING_PAYMENT');
      assert.equal((await node.control.replayEvents(operator, {})).some((event) => event.eventType === 'billing.invoice.paid'), false);
      assert.equal((await node.control.replayUnifiedOutbox(operator, {})).some((record) => record.eventType === 'billing.invoice.paid'), false);
      const verifiedRecord = (await node.control.replayUnifiedOutbox(operator, {})).find((record) => record.eventType === 'payment.verified')!;
      assert.equal(verifiedRecord.state, 'RETRYING');
      assert.equal(verifiedRecord.attemptCount, 1);
      assert.match(verifiedRecord.lastError ?? '', /injected failure after billing.invoice.paid outbox write/);
      const inbox = await node.stream.getDelivery(operator, verifiedRecord.eventId, BILLING_DURABLE_HANDLER_ID);
      assert.equal(inbox?.state, 'RETRYING');
      assert.equal(inbox?.attemptCount, 1);
      assert.equal(inbox?.nextAttemptAt, node.now() + 1_000);
      assert.equal((await node.ledger.listEntries(operator)).length, 0);
      fault.restore();
      // Before the backoff elapses nothing is retried.
      node.advance(999);
      assert.equal((await node.stream.pump(system, { allTenants: true })).examined, 0);
      // After backoff the redelivery completes billing and cascades to the ledger — exactly once.
      node.advance(1);
      const second = await drain(node);
      assert.ok(second.delivered >= 2, JSON.stringify(second));
      assert.equal((await node.billing.getInvoice(operator, invoice.id))?.status, 'PAID');
      assert.equal((await node.billing.getSubscription(operator, subscription.id))?.status, 'ACTIVE');
      const entries = await node.ledger.listEntries(operator);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.amount.amount, 100);
      const finalInbox = await node.stream.getDelivery(operator, verifiedRecord.eventId, BILLING_DURABLE_HANDLER_ID);
      assert.equal(finalInbox?.state, 'DELIVERED');
      assert.equal(finalInbox?.attemptCount, 2);
      assert.equal(finalInbox?.leaseGeneration, 2);
      const outbox = await node.control.replayUnifiedOutbox(operator, {});
      assert.equal(outbox.filter((record) => record.eventType === 'billing.invoice.paid').length, 1, 'no duplicate billing event from the retried effect');
      const durableTypes = new Set(node.stream.handledEventTypes());
      assert.ok(outbox.filter((record) => durableTypes.has(record.eventType)).every((record) => record.state === 'DELIVERED'));
      assert.deepEqual(await node.ledger.verifyIntegrity(operator), { valid: true, entries: 1 });
      // A further pass is a no-op.
      node.advance(60_000);
      assert.equal((await node.stream.pump(system, { allTenants: true })).examined, 0);
      assert.equal((await node.ledger.listEntries(operator)).length, 1);
    } finally {
      await node.close();
    }
  });
});
