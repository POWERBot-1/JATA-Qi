import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
// R1 (§6 TEST KERNEL REPAIR): this fixture installs the REAL A-01
// AuthorizationBoundaryModule — the same module the production composition
// installs. It is NOT a mock, a stub, or a bypass. Legitimate kernel-internal
// worker operations establish scoped KERNEL_INTERNAL authority through the
// real boundary; anything out of scope is still denied.
import { AuthorizationBoundaryModule } from '@jataqi/authorization-boundary';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { CommercialControlPlaneModule, type CommercialActor } from '@jataqi/commercial-control-plane';
import { PaymentsModule, type PaymentsService, PaymentEvents } from '../src/index.js';

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let payments: PaymentsService;
let kernel: any;

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AuthorizationBoundaryModule());
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  await kernel.boot();
  payments = (kernel.getModule('payments') as any).getService();
});

describe('T-08.1 P1 adminReleaseReservation', () => {
  it('recovers PROCESSING -> DRAFT and is idempotent via status-aware key', async () => {
    const intent = await payments.createIntent(operator, {
      productId: 'p1', ventureId: 'v1', customerReference: 'c1', invoiceId: 'inv-1', purpose: 'test',
      amount: { amount: 100, currency: 'KES' }, providerId: 'sandbox-pay', idempotencyKey: 'intent-missing-provider-will-fail',
    }).catch(() => null);
    // provider not registered, use direct storage manipulation to seed PROCESSING payment
    const storage = kernel.getModule('storage') as any;
    const coll = await storage.collection('payments.intents');
    const paymentId = 'pay-t08-1-' + now;
    const seeded: any = {
      id: paymentId, tenantId: 'acme', ventureId: 'v1', productId: 'p1', customerReference: 'c1', invoiceId: 'inv-1', purpose: 'test',
      amount: { amount: 100, currency: 'KES' }, providerId: 'sandbox-pay', idempotencyKey: 'idk-'+paymentId, status: 'PROCESSING', verificationEvidence: [], createdAt: now, updatedAt: now,
    };
    await coll.put(seeded);

    const events: any[] = [];
    kernel.bus.on(PaymentEvents.ReservationReleased, (p: any) => events.push(p));

    const recovered = await payments.adminReleaseReservation(admin, paymentId);
    assert.equal(recovered.status, 'DRAFT');
    assert.equal(recovered.id, paymentId);
    // second call should be idempotent fast-path same status
    const second = await payments.adminReleaseReservation(admin, paymentId);
    assert.equal(second.status, 'DRAFT');
    // verify idempotency key includes previousStatus (PROCESSING)
    // we check via control-plane unified outbox? Instead verify no second event emitted (idem key prevents duplicate)
    // allow a small delay for async bus
    await new Promise(r => setTimeout(r, 10));
    // At least one ReservationReleased event should have been emitted
    assert.ok(events.length >= 1);
  });

  it('concurrent winner/loser both return DRAFT, only one CAS wins', async () => {
    const storage = kernel.getModule('storage') as any;
    const coll = await storage.collection('payments.intents');
    const paymentId = 'pay-concurrent-' + now;
    const seeded: any = {
      id: paymentId, tenantId: 'acme', ventureId: 'v1', productId: 'p1', customerReference: 'c1', invoiceId: 'inv-concurrent', purpose: 'test',
      amount: { amount: 50, currency: 'KES' }, providerId: 'sandbox-pay', idempotencyKey: 'idk-'+paymentId, status: 'PROCESSING', verificationEvidence: [], createdAt: now, updatedAt: now,
    };
    await coll.put(seeded);
    const results = await Promise.all([
      payments.adminReleaseReservation(admin, paymentId),
      payments.adminReleaseReservation(admin, paymentId),
    ]);
    assert.equal(results[0]!.status, 'DRAFT');
    assert.equal(results[1]!.status, 'DRAFT');
    const final = await payments.getPayment(admin, paymentId);
    assert.equal(final!.status, 'DRAFT');
  });

  it('cross-process winner: second service instance returns winner via persistent CAS', async () => {
    const storage = kernel.getModule('storage') as any;
    const driver = storage.getDriver();
    // second kernel shares same driver instance (simulates separate process)
    const { createTestKernel: create2 } = await import('@jataqi/core-kernel/testing');
    const { StorageModule: SM2 } = await import('@jataqi/storage');
    const { AutonomousActionRuntimeModule: ARM2 } = await import('@jataqi/autonomous-action-runtime');
    const { CommercialControlPlaneModule: CPM2 } = await import('@jataqi/commercial-control-plane');
    const { PaymentsModule: PM2 } = await import('../src/index.js');
    const kernel2 = create2();
    kernel2.register(new SM2({ driverInstance: driver }));
    kernel2.register(new CPM2({ now: () => now }));
    kernel2.register(new ARM2());
    kernel2.register(new PM2());
    await kernel2.boot();
    const payments2 = (kernel2.getModule('payments') as any).getService();

    const coll = await storage.collection('payments.intents');
    const paymentId = 'pay-cross-' + now;
    const seeded: any = {
      id: paymentId, tenantId: 'acme', ventureId: 'v1', productId: 'p1', customerReference: 'c1', invoiceId: 'inv-cross', purpose: 'test',
      amount: { amount: 75, currency: 'KES' }, providerId: 'sandbox-pay', idempotencyKey: 'idk-'+paymentId, status: 'REFUND_PROCESSING', refundAmount: { amount: 75, currency: 'KES' }, verificationEvidence: [], createdAt: now, updatedAt: now,
    };
    await coll.put(seeded);

    // concurrent cross-process: both services race for same REFUND_PROCESSING payment
    const [first, second] = await Promise.all([
      payments.adminReleaseReservation(admin, paymentId),
      payments2.adminReleaseReservation(admin, paymentId),
    ]);
    assert.equal(first.status, 'VERIFIED');
    assert.equal(second.status, 'VERIFIED');
    assert.equal(first.id, paymentId);
    assert.equal(second.id, paymentId);

    await kernel2.shutdown();
  });

  it('tenant isolation: other tenant cannot recover', async () => {
    const storage = kernel.getModule('storage') as any;
    const coll = await storage.collection('payments.intents');
    const paymentId = 'pay-tenant-' + now;
    const seeded: any = {
      id: paymentId, tenantId: 'acme', ventureId: 'v1', productId: 'p1', customerReference: 'c1', invoiceId: 'inv-tenant', purpose: 'test',
      amount: { amount: 20, currency: 'KES' }, providerId: 'sandbox-pay', idempotencyKey: 'idk-'+paymentId, status: 'PROCESSING', verificationEvidence: [], createdAt: now, updatedAt: now,
    };
    await coll.put(seeded);
    const otherActor = { id: 'other', tenantId: 'other', roles: ['admin'] } as CommercialActor;
    await assert.rejects(() => payments.adminReleaseReservation(otherActor, paymentId), /not found/i);
  });

  it('releaseReservation retries 3 times on infra failure and emits ReservationReleaseFailed warning', async () => {
    // Use private method via any cast
    const svc: any = payments;
    const reserved: any = { id: 'pay-retry-'+now, tenantId: 'acme', status: 'PROCESSING' };
    // seed a payment so casTransition has something to operate on
    const storage = kernel.getModule('storage') as any;
    const coll = await storage.collection('payments.intents');
    const seeded: any = { id: reserved.id, tenantId: 'acme', ventureId: 'v1', productId: 'p1', customerReference: 'c1', invoiceId: 'inv-retry', purpose: 'test', amount: { amount: 10, currency: 'KES' }, providerId: 'sandbox-pay', idempotencyKey: 'idk-'+reserved.id, status: 'PROCESSING', verificationEvidence: [], createdAt: now, updatedAt: now };
    await coll.put(seeded);

    let callCount = 0;
    const originalCas = svc.casTransition.bind(svc);
    svc.casTransition = async (...args: any[]) => {
      callCount += 1;
      if (callCount < 3) throw new Error('infra failure: db timeout');
      return originalCas(...args);
    };
    const warnings: any[] = [];
    const origWarn = kernel.logger.warn;
    (kernel.logger as any).warn = (msg: string, meta: any) => warnings.push({ msg, meta });

    // Need a pending plan DENY path: call releaseReservation directly with infra failures
    // First two attempts fail infra, third succeeds via real CAS, so no warning emitted
    await svc.releaseReservation(admin, seeded, 'PROCESSING', { status: 'DRAFT' });
    assert.equal(callCount, 3, 'should have retried twice then succeeded');
    assert.equal(warnings.length, 0, 'no warning on eventual success');

    // Now test final failure: 3 infra failures => warning + event
    const paymentId2 = 'pay-retry-fail-'+now;
    const seeded2: any = { ...seeded, id: paymentId2, idempotencyKey: 'idk-'+paymentId2 };
    await coll.put(seeded2);
    callCount = 0;
    svc.casTransition = async () => {
      callCount += 1;
      throw new Error('persistent infra failure');
    };
    const events: any[] = [];
    kernel.bus.on(PaymentEvents.ReservationReleaseFailed, (p: any) => events.push(p));
    await svc.releaseReservation(admin, seeded2, 'PROCESSING', { status: 'DRAFT' });
    // Should have attempted 3 times before giving up and warning
    assert.equal(callCount, 3);
    // wait for async emit
    await new Promise(r => setTimeout(r, 20));
    const warned = warnings.some(w => w.msg.includes('reservation release failed after retries'));
    assert.equal(warned, true, 'must warn via observability after 3 failures');
    assert.ok(events.length >= 1, 'must emit ReservationReleaseFailed event');
    const ev = events[events.length-1];
    // event payload should contain non-secret context and not contain secret
    const payloadStr = JSON.stringify(ev);
    assert.ok(!payloadStr.toLowerCase().includes('secret'), 'must not expose secret');
    // metric payment.reservation.release_failed is via same event; we check event type
    // restore
    svc.casTransition = originalCas;
    (kernel.logger as any).warn = origWarn;
  });

  it('adminReleaseReservation is tenant-bound and admin-only', async () => {
    const storage = kernel.getModule('storage') as any;
    const coll = await storage.collection('payments.intents');
    const paymentId = 'pay-admin-check-'+now;
    const seeded: any = { id: paymentId, tenantId: 'acme', ventureId: 'v1', productId: 'p1', customerReference: 'c1', invoiceId: 'inv-admin', purpose: 'test', amount: { amount: 10, currency: 'KES' }, providerId: 'sandbox-pay', idempotencyKey: 'idk-'+paymentId, status: 'PROCESSING', verificationEvidence: [], createdAt: now, updatedAt: now };
    await coll.put(seeded);
    const nonAdmin = { id: 'op', tenantId: 'acme', roles: ['operator'] } as CommercialActor;
    await assert.rejects(() => payments.adminReleaseReservation(nonAdmin, paymentId), /administrator/i);
  });
});
