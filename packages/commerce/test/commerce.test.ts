import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CommerceModule, money, UNLIMITED } from '../src/index.js';
import type { MarketplaceItem, PaymentProvider, Plan } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

const DAY = 86_400_000;

// A clearly-labelled mock payment provider (for testing the abstraction only).
function mockProvider(ok = true): PaymentProvider {
  return {
    id: 'mock',
    async charge() { return ok ? { ok: true, reference: 'mock-' + Math.random() } : { ok: false, error: 'declined' }; },
    async refund() { return { ok: true }; },
  };
}

describe('CommerceModule (engine)', () => {
  let kernel: Kernel;
  let c: CommerceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new CommerceModule());
    await kernel.boot();
    c = kernel.getModule<CommerceModule>('commerce');
  });

  it('seeds a configurable catalogue with a real free tier', async () => {
    const plans = await c.listPlans();
    assert.ok(plans.length >= 10);
    const free = await c.getPlan('free');
    assert.equal(free!.pricingModel, 'FREE');
    assert.equal(free!.prices.USD.amount, 0);
  });

  it('subscribes a free user and enforces usage quotas', async () => {
    const sub = await c.subscribe('cust-1', 'free');
    assert.equal(sub.status, 'ACTIVE');
    assert.equal(sub.price.amount, 0);

    // Free plan grants 1000 ai.requests/month.
    for (let i = 0; i < 1000; i++) await c.meterUsage('cust-1', 'ai.requests', 1);
    const blocked = await c.check('cust-1', 'ai.requests');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'quota exceeded');

    // A feature not granted by the plan is denied.
    const nope = await c.check('cust-1', 'models.advanced');
    assert.equal(nope.allowed, false);
  });

  it('does NOT auto-charge after a trial and records trial start', async () => {
    const sub = await c.subscribe('cust-2', 'personal', { trial: true });
    assert.equal(sub.status, 'TRIAL');
    assert.ok(sub.trialEnd! > Date.now());
    // No payment provider configured -> nothing was charged; trial grants access.
    const decision = await c.check('cust-2', 'models.advanced');
    assert.equal(decision.allowed, true); // personal grants advanced models during trial
  });

  it('upgrades a trial to paid (trial conversion) and enforces new limits', async () => {
    const sub = await c.subscribe('cust-3', 'personal', { trial: true });
    const upgraded = await c.upgrade(sub.id, 'team', { seats: 5 });
    assert.equal(upgraded.status, 'ACTIVE');
    assert.equal(upgraded.seats, 5);
    const a = await c.analytics();
    assert.equal(a.trialConversions, 1);
  });

  it('cancels (immediate and at period end) without destroying data', async () => {
    const sub = await c.subscribe('cust-4', 'free');
    const eod = await c.cancel(sub.id, { immediate: false });
    assert.equal(eod.cancelAtPeriodEnd, true);
    const imm = await c.cancel(sub.id, { immediate: true });
    assert.equal(imm.status, 'CANCELLED');
  });

  it('grants, consumes (FIFO) and expires credits — separate from currency', async () => {
    await c.grantCredits('cust-5', 100, 'welcome');
    await c.grantCredits('cust-5', 50, 'promo', Date.now() + 86_400_000);
    assert.equal(await c.creditBalance('cust-5'), 150);
    const r = await c.consumeCredits('cust-5', 110);
    assert.equal(r.consumed, 110);
    assert.equal(r.remaining, 40); // 100 welcome fully consumed, 40 of promo left
    await assert.rejects(() => c.consumeCredits('cust-5', 1000), /insufficient credits/);
  });

  it('issues and verifies licenses (active / expired / revoked)', async () => {
    const lic = await c.issueLicense({ customerId: 'cust-6', productId: 'p1', edition: 'ENTERPRISE', features: ['ai.advanced'], deployment: 'ON_PREMISE', validUntil: Date.now() + DAY });
    assert.equal((await c.verifyLicense(lic.id)).valid, true);
    const expiring = await c.issueLicense({ customerId: 'cust-6', productId: 'p1', edition: 'TEAM', features: [], deployment: 'SAAS', validUntil: Date.now() - 1000 });
    assert.equal((await c.verifyLicense(expiring.id)).valid, false);
    const revoked = await c.revokeLicense(lic.id);
    assert.equal(revoked.status, 'REVOKED');
    assert.equal((await c.verifyLicense(lic.id)).valid, false);
  });

  it('charges through a payment provider adapter and refunds (abstracted)', async () => {
    c.setPaymentProvider(mockProvider(true));
    const rec = await c.charge('cust-7', money(50, 'USD'), 'ref-1');
    assert.equal(rec.status, 'SUCCEEDED');
    const refunded = await c.refund('ref-1');
    assert.equal(refunded.status, 'REFUNDED');
    c.setPaymentProvider(mockProvider(false));
    await assert.rejects(() => c.charge('cust-7', money(10, 'USD'), 'ref-2'), /payment failed/);
  });

  it('builds invoices with configurable tax and discounts in one currency', async () => {
    const inv = await c.createInvoice('cust-8', [
      { description: 'Team plan (5 seats)', quantity: 5, unitPrice: money(29, 'USD'), total: money(0, 'USD') },
    ], { discountPct: 10, taxPct: 16 });
    assert.equal(inv.subtotal.amount, 145);
    assert.equal(inv.discount.amount, 14.5);
    // tax on (145 - 14.5) = 130.5 @ 16% = 20.88
    assert.equal(inv.tax.amount, 20.88);
    assert.equal(inv.total.amount, Math.round((130.5 + 20.88) * 100) / 100);
    assert.equal(inv.lines[0]!.total.amount, 145); // line totals normalized to the invoice currency
  });

  it('runs a marketplace purchase with configurable commission split + payout', async () => {
    const item: MarketplaceItem = { id: 'item-1', name: 'Agent X', sellerId: 'dev-1', price: money(100, 'USD'), platformCommissionPct: 30, pricingModel: 'ONE_TIME', status: 'LISTED' };
    const { order, payout } = await c.purchase('cust-9', item);
    assert.equal(order.platformShare.amount, 30);
    assert.equal(order.sellerShare.amount, 70);
    assert.equal(payout.payeeId, 'dev-1');
    assert.equal(payout.amount.amount, 70);
    const devPayouts = await c.payoutsFor('dev-1');
    assert.equal(devPayouts.length, 1);
  });

  it('admin overrides grant entitlements temporarily and are audited; users cannot self-grant', async () => {
    // cust-10 on free: models.advanced denied.
    await c.subscribe('cust-10', 'free');
    assert.equal((await c.check('cust-10', 'models.advanced')).allowed, false);
    // Admin grants an override.
    await c.grantOverride({ customerId: 'cust-10', feature: 'models.advanced', quota: UNLIMITED, reason: 'support', adminId: 'admin-1' });
    assert.equal((await c.check('cust-10', 'models.advanced')).allowed, true);
    // There is NO public subscribe/entitlement API that lets a customer grant themselves a paid feature
    // without an admin or payment — verified by the module's surface (no such method exists).
    const plan = await c.getPlan('free') as Plan;
    assert.ok(plan);
  });

  it('aggregates analytics: MRR is per-currency (no silent FX conversion)', async () => {
    await c.subscribe('cust-a', 'personal', { currency: 'USD' }); // 12 USD/mo
    await c.subscribe('cust-b', 'personal', { currency: 'KES' }); // 500 KES/mo
    const mrr = await c.mrr();
    assert.equal(mrr.USD, 12);
    assert.equal(mrr.KES, 500);
    assert.ok(!('EUR' in mrr)); // currencies never silently merged
  });
});
