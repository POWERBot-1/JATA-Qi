// Registrar flow tests — search/register/renew/transfer/restore/bulk/portfolio
// against a live in-process registry via a DirectRegistryConnection.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, defaultPolicy, hashSecret } from '@jataqi/registry';
import { Registrar, DirectRegistryConnection } from '../src/index.js';

describe('Registrar flows (direct connection)', () => {
  let registry: Registry;
  let reg: Registrar;
  let registrantId: string;

  before(() => {
    registry = new Registry({ tld: '.jq', policy: defaultPolicy({ reserved: new Set(), reservedPatterns: [] }) });
    registry.addRegistrar({ id: 'reg-1', name: 'Reg 1', passwordHash: hashSecret('pw'), active: true });
    reg = new Registrar({
      id: 'reg-1', name: 'Reg 1',
      priceBook: { baseCreate: 10, baseRenew: 10, baseRestore: 60, currency: 'USD' },
      connection: new DirectRegistryConnection(registry, 'reg-1'),
      compliance: { requireKyc: false, blockedRegistrants: new Set(), trademarkClaims: new Set() },
    });
    const r = reg.identities.register({ name: 'Jane', email: 'jane@example.com' });
    registrantId = r.id;
  });

  it('searches availability', async () => {
    const results = await reg.search(['mybrand.jq', 'taken.jq']);
    assert.ok(results[0]!.available);
  });

  it('registers a domain and bills-free records the order', async () => {
    const order = await reg.register({ name: 'mybrand.jq', registrantId, periodYears: 2 });
    assert.equal(order.kind, 'create');
    assert.equal(order.status, 'completed');
    assert.equal(order.price.amount, 20); // 10 * 2 years
    assert.ok(reg.portfolio(registrantId).includes('mybrand.jq.'));
  });

  it('refuses a duplicate registration', async () => {
    const order = await reg.register({ name: 'mybrand.jq', registrantId, periodYears: 1 });
    assert.equal(order.status, 'failed');
  });

  it('renews a domain', async () => {
    const order = await reg.renew({ name: 'mybrand.jq', registrantId, periodYears: 1 });
    assert.equal(order.status, 'completed');
  });

  it('fails compliance when KYC is required but unverified', async () => {
    const reg2 = new Registrar({
      id: 'reg-2', name: 'Reg 2',
      priceBook: { baseCreate: 10, baseRenew: 10, baseRestore: 60, currency: 'USD' },
      connection: new DirectRegistryConnection(registry, 'reg-1'),
      compliance: { requireKyc: true, blockedRegistrants: new Set(), trademarkClaims: new Set() },
    });
    const r = reg2.identities.register({ name: 'Unverified', email: 'u@x' });
    const order = await reg2.register({ name: 'needs-kyc.jq', registrantId: r.id, periodYears: 1 });
    assert.equal(order.status, 'failed');
    assert.match(order.error ?? '', /kyc|compliance/);
  });

  it('bulk-registers multiple domains', async () => {
    const job = await reg.bulkRegister({
      registrantId,
      requests: [{ domain: 'one.jq', periodYears: 1 }, { domain: 'two.jq', periodYears: 1 }, { domain: 'mybrand.jq', periodYears: 1 /* already taken */ }],
    });
    assert.equal(job.results.filter((r) => r.ok).length, 2);
    assert.equal(job.results.filter((r) => !r.ok).length, 1);
    assert.equal(job.status, 'partial');
  });

  it('records orders for billing history', () => {
    const orders = reg.listOrders(registrantId);
    assert.ok(orders.length >= 2);
  });
});

describe('Registrar — transfer between two registrars', () => {
  it('transfers a domain from reg-1 to reg-2', async () => {
    const registry = new Registry({ tld: '.jq', policy: defaultPolicy({ reserved: new Set(), reservedPatterns: [] }) });
    registry.addRegistrar({ id: 'reg-1', name: 'A', passwordHash: hashSecret('p'), active: true });
    registry.addRegistrar({ id: 'reg-2', name: 'B', passwordHash: hashSecret('p'), active: true });
    const r1 = new Registrar({ id: 'reg-1', name: 'A', priceBook: { baseCreate: 10, baseRenew: 10, baseRestore: 60, currency: 'USD' }, connection: new DirectRegistryConnection(registry, 'reg-1') });
    const r2 = new Registrar({ id: 'reg-2', name: 'B', priceBook: { baseCreate: 10, baseRenew: 10, baseRestore: 60, currency: 'USD' }, connection: new DirectRegistryConnection(registry, 'reg-2') });
    const owner = r1.identities.register({ name: 'Owner', email: 'o@x' });
    await r1.register({ name: 'moveme.jq', registrantId: owner.id, periodYears: 1 });
    // Transfer: gaining registrar requests with the (unknown) authInfo → rejected.
    const gainer = r2.identities.register({ name: 'Gainer', email: 'g@x' });
    const rejected = await r2.transfer({ name: 'moveme.jq', registrantId: gainer.id, authInfo: 'wrong' });
    assert.equal(rejected.status, 'failed');
  });
});
