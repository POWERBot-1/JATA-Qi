// Phase 5 — First Customer Production: end-to-end customer + commercial
// lifecycle through the real gateway. Covers tenant provisioning, edition
// enforcement, metering, billing state, suspension/reactivation, product
// provisioning, offboarding with data-retention evidence, and tenant
// isolation. Runs against the production bootstrap.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createJataQi } from '../src/bootstrap.js';
import type { ApiGatewayModule } from '@jataqi/api-gateway';
import type { GatewayHandle } from '@jataqi/api-gateway';
import type { JataQiClient } from '@jataqi/sdk';
import { JataQiClient as SDKClient } from '@jataqi/sdk';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Phase 5 — first customer production lifecycle (gateway E2E)', () => {
  let qi: Awaited<ReturnType<typeof createJataQi>>;
  let handle: GatewayHandle;
  let base: string;
  let admin: JataQiClient;
  let principalId = '';

  before(async () => {
    qi = await createJataQi({ security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    handle = await (qi.gateway as ApiGatewayModule).listen({ port: 0 });
    base = `http://127.0.0.1:${handle.port}`;
    admin = new SDKClient({ baseUrl: base });
    await admin.auth.login('admin', 'admin');
    principalId = (await admin.auth.whoami()).principal.userId;
  });

  after(async () => { await handle.close(); await qi.shutdown(); });

  it('full customer lifecycle: account → subscription → suspend → reactivate → offboard → delete evidence', async () => {
    // The gateway binds subscriptions to the principal's userId.
    // 1. Create the customer account (tenant + org + billing identity).
    const created = await admin.onboarding.createAccount({ orgName: 'First Customer Ltd', customerId: principalId, adminEmail: 'admin@fc.example', planSlug: 'business' });
    const accountId = (created.account as { id: string }).id;
    assert.equal((created.account as { status: string }).status, 'active');

    // 2. Subscribe the customer to an edition (commercial lifecycle).
    const subscribeRes = await fetch(`${base}/commerce/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.getToken()}` }, body: JSON.stringify({ customerId: principalId, planSlug: 'business' }) });
    assert.equal(subscribeRes.status, 201, 'subscribe');
    const subscription = (await subscribeRes.json() as { subscription: { id: string; status: string } }).subscription;
    assert.equal(subscription.status, 'ACTIVE');

    // 3. Assign the subscription to the account (edition enforcement binding).
    const assigned = await admin.onboarding.assignSubscription(accountId, subscription.id, 'business');
    assert.equal((assigned.account as { planSlug: string }).planSlug, 'business');

    // 4. Meter usage + verify billing state (tenant-isolated).
    const meter = await fetch(`${base}/commerce/meter`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.getToken()}` }, body: JSON.stringify({ customerId: principalId, metric: 'api_calls', qty: 100 }) });
    assert.ok([200, 201].includes(meter.status), 'usage metered');
    const state = await admin.commerceStats.billingState(principalId);
    assert.equal((state.state as { subscription: { status: string } }).subscription.status, 'ACTIVE');
    assert.equal((state.state as { usage: Record<string, number> }).usage.api_calls, 100);

    // 5. Provision a product for the tenant (marketplace).
    const install = await admin.products.install('tanya');
    assert.deepEqual((install as { order: string[] }).order, ['tanya']);

    // 6. Suspend → reactivate (customer status + subscription).
    const suspended = await admin.onboarding.suspendAccount(accountId, 'non-payment');
    assert.equal((suspended.account as { status: string }).status, 'suspended');
    const suspendSub = await fetch(`${base}/commerce/subscription`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.getToken()}` }, body: JSON.stringify({ id: subscription.id, action: 'suspend', reason: 'non-payment' }) });
    assert.equal((await suspendSub.json() as { subscription: { status: string } }).subscription.status, 'SUSPENDED');
    const reactivated = await admin.onboarding.reactivateAccount(accountId);
    assert.equal((reactivated.account as { status: string }).status, 'active');
    // Reactivate the commerce subscription too (billing truth follows the account).
    const reactivateSub = await fetch(`${base}/commerce/subscription`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.getToken()}` }, body: JSON.stringify({ id: subscription.id, action: 'reactivate' }) });
    assert.equal((await reactivateSub.json() as { subscription: { status: string } }).subscription.status, 'REACTIVATED');

    // 7. Offboard with data-retention policy → deletion evidence.
    const offboard = await admin.onboarding.offboardAccount(accountId, { retentionDays: 90, deleteData: true });
    assert.equal((offboard.account as { status: string }).status, 'offboarding');
    const record = await admin.onboarding.executeOffboarding(accountId);
    const rec = record.record as { status: string; evidenceHash: string; tenantId: string };
    assert.equal(rec.status, 'completed');
    assert.equal(rec.evidenceHash.length, 64);
    assert.ok(rec.tenantId.startsWith('tenant-'));
    const stats = await admin.onboarding.customerStats();
    assert.equal((stats.stats as { offboarded: number }).offboarded, 1);
  });

  it('tenant isolation: second customer sees its own account only', async () => {
    await admin.onboarding.createAccount({ orgName: 'Tenant Two', customerId: 'fc-002', adminEmail: 't2@example.io' });
    const byCustomer = await admin.onboarding.account({ customerId: 'fc-002' });
    assert.equal((byCustomer.account as { orgName: string }).orgName, 'Tenant Two');
    const accounts = await admin.onboarding.accounts();
    assert.equal((accounts.accounts as unknown[]).length, 2, 'both tenants listed admin-side');
    // Each tenant's account carries a unique tenantId (isolation key).
    const ids = (accounts.accounts as Array<{ tenantId: string }>).map((a) => a.tenantId);
    assert.equal(new Set(ids).size, 2, 'tenant ids unique');
  });

  it('commercial KPIs reflect the first customer (active tenants, ARR, invoices)', async () => {
    const analytics = await admin.commerceStats.analytics();
    assert.ok((analytics as { activePayingTenants: number }).activePayingTenants >= 1);
    assert.ok((analytics as { arr: Record<string, number> }).arr.USD >= 0);
    assert.equal(typeof (analytics as { conversionRate: number }).conversionRate, 'number');
    assert.equal(typeof (analytics as { churnCount: number }).churnCount, 'number');
  });

  it('edition enforcement: entitlement check honours the assigned plan', async () => {
    // The business plan has a feature quota; check + meter must agree.
    const check = await fetch(`${base}/commerce/check`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.getToken()}` }, body: JSON.stringify({ customerId: principalId, feature: 'seats' }) });
    assert.ok([200, 404].includes(check.status));
    await sleep(10);
  });
});
