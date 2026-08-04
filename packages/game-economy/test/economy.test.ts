// Game economy tests — wallets, exact arithmetic, ledger integrity, transfers,
// and marketplace royalty splits.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { WalletStore, Marketplace, EconomyError, GameEconomyModule, EconomyEvents } from '../src/index.js';

describe('WalletStore — balances & exact arithmetic', () => {
  it('credits and debits in bigint minor units', () => {
    const s = new WalletStore();
    s.registerCurrency({ id: 'coins', name: 'Coins', symbol: '¢', kind: 'soft', decimals: 0, purchasable: false });
    const w = s.openWallet('player1', 'player');
    s.credit(w.id, 'coins', 1000n, 'earn', 'daily');
    assert.equal(s.balance(w.id, 'coins'), 1000n);
    s.debit(w.id, 'coins', 250n, 'spend', 'shop');
    assert.equal(s.balance(w.id, 'coins'), 750n);
  });

  it('throws on insufficient funds and aborts the debit', () => {
    const s = new WalletStore();
    s.registerCurrency({ id: 'coins', name: 'Coins', symbol: '¢', kind: 'soft', decimals: 0, purchasable: false });
    const w = s.openWallet('p', 'player');
    s.credit(w.id, 'coins', 100n, 'earn', 'g');
    assert.throws(() => s.debit(w.id, 'coins', 500n, 'spend', 'x'), EconomyError);
    assert.equal(s.balance(w.id, 'coins'), 100n); // unchanged
  });

  it('transfers atomically between two wallets', () => {
    const s = new WalletStore();
    s.registerCurrency({ id: 'coins', name: 'Coins', symbol: '¢', kind: 'soft', decimals: 0, purchasable: false });
    const a = s.openWallet('a', 'player');
    const b = s.openWallet('b', 'player');
    s.credit(a.id, 'coins', 500n, 'earn', 'g');
    const txs = s.transfer(a.id, b.id, 'coins', 200n, 'transfer', 'gift');
    assert.equal(txs.length, 2);
    assert.equal(s.balance(a.id, 'coins'), 300n);
    assert.equal(s.balance(b.id, 'coins'), 200n);
  });

  it('keeps one wallet per owner+kind', () => {
    const s = new WalletStore();
    s.registerCurrency({ id: 'coins', name: 'Coins', symbol: '¢', kind: 'soft', decimals: 0, purchasable: false });
    const w1 = s.openWallet('p', 'player');
    const w2 = s.openWallet('p', 'player');
    assert.equal(w1.id, w2.id);
    const w3 = s.openWallet('p', 'creator');
    assert.notEqual(w1.id, w3.id);
  });
});

describe('WalletStore — ledger integrity', () => {
  it('chains entries and verifies', () => {
    const s = new WalletStore();
    s.registerCurrency({ id: 'coins', name: 'Coins', symbol: '¢', kind: 'soft', decimals: 0, purchasable: false });
    const w = s.openWallet('p', 'player');
    s.credit(w.id, 'coins', 100n, 'earn', 'a');
    s.debit(w.id, 'coins', 30n, 'spend', 'b');
    assert.equal(s.verifyLedger(), true);
    assert.equal(s.history().length, 2);
    assert.equal(s.history(w.id).length, 2);
  });

  it('detects tampering (root changes)', () => {
    const s = new WalletStore();
    s.registerCurrency({ id: 'coins', name: 'Coins', symbol: '¢', kind: 'soft', decimals: 0, purchasable: false });
    const w = s.openWallet('p', 'player');
    s.credit(w.id, 'coins', 100n, 'earn', 'a');
    const root = s.ledgerRoot();
    s.credit(w.id, 'coins', 50n, 'earn', 'b');
    assert.notEqual(s.ledgerRoot(), root);
    assert.equal(s.verifyLedger(), true);
  });
});

describe('Marketplace — royalty splits', () => {
  let s: WalletStore;
  let m: Marketplace;

  before(() => {
    s = new WalletStore();
    s.registerCurrency({ id: 'gems', name: 'Gems', symbol: '◆', kind: 'premium', decimals: 0, purchasable: true });
    m = new Marketplace(s, { marketplaceFeeRate: 0.1, marketplaceOwner: 'nova' });
  });

  it('splits a purchase into fee + royalties + seller net', () => {
    const { asset } = m.list({
      title: 'Hero Pack', type: 'character', sellerOwnerId: 'seller1',
      price: { currency: 'gems', amount: 1000n },
      royalties: [{ ownerId: 'artist', share: 0.2, label: 'art' }],
      license: 'commercial',
    });
    const buyer = s.openWallet('buyer', 'player');
    s.credit(buyer.id, 'gems', 5000n, 'earn', 'topup');

    const result = m.buy(asset.id, 'buyer');
    assert.equal(result.split.marketplaceFee, 100n); // 10% of 1000
    assert.equal(result.split.royalties[0]!.amount, 180n); // 20% of 900
    assert.equal(result.split.sellerNet, 720n); // 900 - 180
    assert.equal(s.balance(buyer.id, 'gems'), 4000n);
    assert.equal(s.balance(s.walletOf('nova', 'marketplace')!.id, 'gems'), 100n);
    assert.equal(s.balance(s.walletOf('artist', 'creator')!.id, 'gems'), 180n);
    assert.equal(s.balance(s.walletOf('seller1', 'creator')!.id, 'gems'), 720n);
    assert.equal(m.hasLicense(asset.id, 'buyer'), true);
  });

  it('rejects royalty shares exceeding 100%', () => {
    assert.throws(() => m.list({
      title: 'X', type: 'map', sellerOwnerId: 's',
      price: { currency: 'gems', amount: 100n },
      royalties: [{ ownerId: 'a', share: 0.6 }, { ownerId: 'b', share: 0.5 }],
    }), EconomyError);
  });

  it('aborts a purchase when the buyer cannot afford it', () => {
    const { asset } = m.list({ title: 'Pricey', type: 'game', sellerOwnerId: 's', price: { currency: 'gems', amount: 99999n } });
    const poor = s.openWallet('poor', 'player');
    s.credit(poor.id, 'gems', 10n, 'earn', 'g');
    assert.throws(() => m.buy(asset.id, 'poor'), EconomyError);
  });

  it('grants free assets without charging', () => {
    const { asset } = m.list({ title: 'Free', type: 'sfx', sellerOwnerId: 's', price: { currency: 'gems', amount: 0n } });
    const r = m.buy(asset.id, 'freeloader');
    assert.equal(r.split.marketplaceFee, 0n);
    assert.equal(m.hasLicense(asset.id, 'freeloader'), true);
  });
});

describe('GameEconomyModule — kernel integration', () => {
  let kernel: Kernel;
  let mod: GameEconomyModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new GameEconomyModule({ marketplace: { marketplaceFeeRate: 0.15, marketplaceOwner: 'nova' } });
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('seeds default currencies and opens wallets', () => {
    assert.ok(mod.currencies().some((c) => c.id === 'coins'));
    const w = mod.openWallet('p1', 'player');
    mod.grant(w.id, 'coins', 500n, 'daily');
    assert.equal(mod.balance(w.id, 'coins'), 500n);
  });

  it('runs a marketplace purchase end-to-end', () => {
    const listing = mod.listAsset({ title: 'Skin', type: 'character', sellerOwnerId: 'seller', price: { currency: 'coins', amount: 200n } });
    const buyer = mod.openWallet('buyer', 'player');
    mod.grant(buyer.id, 'coins', 1000n, 'topup');
    const result = mod.buyAsset(listing.asset.id, 'buyer');
    assert.equal(result.split.marketplaceFee, 30n); // 15%
    assert.equal(mod.verifyLedger(), true);
  });

  it('emits transaction events', async () => {
    const seen: string[] = [];
    kernel.bus.on(EconomyEvents.Transaction, () => { seen.push('tx'); });
    const w = mod.openWallet('event-p', 'player');
    mod.grant(w.id, 'coins', 10n, 'g');
    await new Promise((r) => setImmediate(r));
    assert.ok(seen.length >= 1);
  });
});
