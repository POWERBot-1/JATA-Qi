// Pricing + compliance + identity unit tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPrice, renewPrice, restorePrice, applyPromo, termTotal } from '../src/index.js';
import { evaluateCompliance } from '../src/index.js';
import { IdentityStore } from '../src/index.js';

describe('pricing', () => {
  const book = { baseCreate: 10, baseRenew: 10, baseRestore: 60, currency: 'USD' };

  it('compute create price with premium multiplier', () => {
    assert.deepEqual(createPrice(book, 'a.jq', 50), { amount: 500, currency: 'USD' });
    assert.deepEqual(createPrice(book, 'normal.jq', 1), { amount: 10, currency: 'USD' });
  });

  it('termTotal multiplies per-year by years', () => {
    assert.deepEqual(termTotal(createPrice(book, 'x', 1), 3), { amount: 30, currency: 'USD' });
  });

  it('applyPromo discounts and consumes a use', () => {
    const promo = { code: 'SAVE10', discountPct: 0.1, maxUses: 1, uses: 0, validUntil: Date.now() + 10000, active: true };
    const p = createPrice(book, 'x', 1);
    const r = applyPromo(p, promo);
    assert.equal(r.applied, true);
    assert.equal(r.price.amount, 9);
    assert.equal(promo.uses, 1);
    // Second use exhausted.
    const r2 = applyPromo(p, promo);
    assert.equal(r2.applied, false);
  });

  it('restore price is fixed', () => {
    assert.deepEqual(restorePrice(book), { amount: 60, currency: 'USD' });
  });
});

describe('compliance', () => {
  const opts = { requireKyc: true, blockedRegistrants: new Set<string>(['bad@x']), trademarkClaims: new Set<string>(['brand']) };

  it('blocks unavailable names', () => {
    const r = evaluateCompliance({ name: 'x.jq', available: false, reason: 'registered' }, undefined, opts);
    assert.equal(r.ok, false);
  });

  it('requires verified KYC when requireKyc', () => {
    const reg = { id: 'r1', name: 'A', email: 'a@x', kyc: 'pending' as const, kycEvidence: [], createdAt: 0 };
    const r = evaluateCompliance({ name: 'x.jq', available: true }, reg, opts);
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((m) => m.includes('kyc')));
  });

  it('passes when available + verified + not blocked', () => {
    const reg = { id: 'r1', name: 'A', email: 'a@x', kyc: 'verified' as const, kycEvidence: [], createdAt: 0 };
    const r = evaluateCompliance({ name: 'x.jq', available: true }, reg, opts);
    assert.equal(r.ok, true);
  });

  it('flags trademark claims', () => {
    const reg = { id: 'r1', name: 'A', email: 'a@x', kyc: 'verified' as const, kycEvidence: [], createdAt: 0 };
    const r = evaluateCompliance({ name: 'brand.jq', available: true }, reg, opts);
    assert.equal(r.claimsNoticeRequired, true);
  });

  it('blocks sanctioned registrants', () => {
    const reg = { id: 'r1', name: 'A', email: 'bad@x', kyc: 'verified' as const, kycEvidence: [], createdAt: 0 };
    const r = evaluateCompliance({ name: 'x.jq', available: true }, reg, opts);
    assert.equal(r.ok, false);
  });
});

describe('identity (KYC)', () => {
  it('transitions unverified → pending → verified', () => {
    const store = new IdentityStore();
    const r = store.register({ name: 'Jane', email: 'j@x' });
    assert.equal(r.kyc, 'unverified');
    store.submitKyc(r.id, ['passport.pdf']);
    assert.equal(store.get(r.id)!.kyc, 'pending');
    store.decideKyc(r.id, 'verified');
    assert.equal(store.get(r.id)!.kyc, 'verified');
    assert.ok(store.get(r.id)!.verifiedAt);
  });
});
