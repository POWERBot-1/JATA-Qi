// Universal Wallet tests — ledger integrity, core operations (deposit/
// withdraw/transfer/grant/consume), escrow lifecycle, backward-compat adapters,
// and full kernel integration.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import {
  WalletEngine, WalletError, DoubleEntryLedger, DEFAULT_CURRENCIES,
  FinanceAdapter, CommerceCreditsAdapter, GameEconomyAdapter,
  UniversalWalletModule, WalletEvents,
} from '../src/index.js';

describe('DoubleEntryLedger — integrity', () => {
  it('posts paired entries and chains them', () => {
    const ledger = new DoubleEntryLedger();
    const a = ledger.postSingle({ walletId: 'w1', currency: 'USD', amount: 1000n, entryType: 'credit', category: 'deposit', description: 'init' });
    const b = ledger.postPair({ fromWalletId: 'w1', toWalletId: 'w2', currency: 'USD', amount: 300n, category: 'transfer', description: 'pay' });
    assert.equal(ledger.length, 3); // 1 single + 2 paired
    assert.equal(ledger.balance('w1', 'USD'), 700n); // 1000 - 300
    assert.equal(ledger.balance('w2', 'USD'), 300n);
    assert.ok(ledger.verify());
  });

  it('detects tampering via root hash', () => {
    const ledger = new DoubleEntryLedger();
    ledger.postSingle({ walletId: 'w1', currency: 'USD', amount: 100n, entryType: 'credit', category: 'deposit', description: 'x' });
    const root = ledger.rootHash();
    ledger.postSingle({ walletId: 'w1', currency: 'USD', amount: 50n, entryType: 'credit', category: 'deposit', description: 'y' });
    assert.notEqual(ledger.rootHash(), root);
    assert.ok(ledger.verify());
  });
});

describe('WalletEngine — core operations', () => {
  let engine: WalletEngine;

  before(() => { engine = new WalletEngine(); });

  it('opens wallets with roles', () => {
    const w = engine.openWallet('user-1', 'player');
    assert.equal(w.ownerId, 'user-1');
    assert.equal(w.role, 'player');
    // Same owner+role returns same wallet.
    assert.equal(engine.openWallet('user-1', 'player').id, w.id);
    // Different role → different wallet.
    const w2 = engine.openWallet('user-1', 'creator');
    assert.notEqual(w.id, w2.id);
  });

  it('deposits and checks balance', () => {
    const w = engine.openWallet('user-2', 'player');
    engine.deposit(w.id, 'USD', 50000n, 'Initial deposit');
    assert.equal(engine.balance(w.id, 'USD'), 50000n);
  });

  it('withdraws (with insufficient-funds protection)', () => {
    const w = engine.openWallet('user-3', 'player');
    engine.deposit(w.id, 'KES', 10000n, 'topup');
    engine.withdraw(w.id, 'KES', 3000n, 'ATM');
    assert.equal(engine.balance(w.id, 'KES'), 7000n);
    assert.throws(() => engine.withdraw(w.id, 'KES', 99999n, 'too much'), WalletError);
  });

  it('transfers between wallets atomically', () => {
    const a = engine.openWallet('user-4', 'player');
    const b = engine.openWallet('user-5', 'player');
    engine.deposit(a.id, 'USD', 1000n, 'seed');
    engine.transfer(a.id, b.id, 'USD', 400n, 'split');
    assert.equal(engine.balance(a.id, 'USD'), 600n);
    assert.equal(engine.balance(b.id, 'USD'), 400n);
  });

  it('grants and consumes (virtual currency)', () => {
    const w = engine.openWallet('user-6', 'player');
    engine.grant(w.id, 'POINTS', 500n, 'daily reward');
    assert.equal(engine.balance(w.id, 'POINTS'), 500n);
    engine.consume(w.id, 'POINTS', 200n, 'redeem');
    assert.equal(engine.balance(w.id, 'POINTS'), 300n);
    assert.throws(() => engine.consume(w.id, 'POINTS', 999n, 'too much'), WalletError);
  });

  it('freezes and blocks operations', () => {
    const w = engine.openWallet('user-7', 'player');
    engine.deposit(w.id, 'USD', 100n, 'init');
    engine.setWalletStatus(w.id, 'frozen');
    assert.throws(() => engine.withdraw(w.id, 'USD', 10n, 'x'), WalletError);
    engine.setWalletStatus(w.id, 'active');
    engine.withdraw(w.id, 'USD', 10n, 'x');
  });

  it('supports multi-currency balances in one wallet', () => {
    const w = engine.openWallet('user-8', 'treasury');
    engine.deposit(w.id, 'USD', 1000n, 'USD funds');
    engine.deposit(w.id, 'KES', 50000n, 'KES funds');
    engine.deposit(w.id, 'KRT', 10_000_000n, 'KRT funds');
    const bals = engine.balances(w.id);
    assert.equal(bals.get('USD'), 1000n);
    assert.equal(bals.get('KES'), 50000n);
    assert.equal(bals.get('KRT'), 10_000_000n);
  });

  it('rejects unregistered currencies', () => {
    const w = engine.openWallet('user-9', 'player');
    assert.throws(() => engine.deposit(w.id, 'UNKNOWN', 100n, 'x'), WalletError);
  });
});

describe('WalletEngine — escrow', () => {
  let engine: WalletEngine;

  before(() => { engine = new WalletEngine(); });

  it('holds, releases, and refunds escrow', () => {
    const buyer = engine.openWallet('buyer-1', 'player');
    const seller = engine.openWallet('seller-1', 'marketplace');
    engine.deposit(buyer.id, 'USD', 10000n, 'funds');
    // Hold escrow.
    const hold = engine.holdEscrow(buyer.id, seller.id, 'USD', 5000n, 'marketplace purchase');
    assert.equal(hold.status, 'held');
    assert.equal(engine.balance(buyer.id, 'USD'), 5000n); // deducted from buyer
    assert.equal(engine.balance(seller.id, 'USD'), 5000n); // held in seller escrow
    // Release → funds stay with seller.
    engine.releaseEscrow(hold.id);
    assert.equal(hold.status, 'released');
    // Refund test.
    const hold2 = engine.holdEscrow(buyer.id, seller.id, 'USD', 2000n, 'disputed');
    engine.refundEscrow(hold2.id);
    assert.equal(hold2.status, 'refunded');
    assert.equal(engine.balance(buyer.id, 'USD'), 5000n); // 5000 + 2000 refunded
  });
});

describe('WalletEngine — history + summary', () => {
  it('returns transaction history grouped by ref', () => {
    const engine = new WalletEngine();
    const a = engine.openWallet('h-1', 'player');
    const b = engine.openWallet('h-2', 'player');
    engine.deposit(a.id, 'USD', 1000n, 'd1');
    engine.transfer(a.id, b.id, 'USD', 300n, 't1');
    engine.consume(a.id, 'USD', 100n, 'c1');
    const history = engine.history({ walletId: a.id });
    assert.ok(history.length >= 3);
    // Summary.
    const s = engine.summary();
    assert.equal(s.totalWallets, 2);
    assert.ok(s.totalTxCount >= 4);
  });
});

describe('Backward-compat adapters', () => {
  it('FinanceAdapter mirrors finance API', async () => {
    const engine = new WalletEngine();
    const fin = new FinanceAdapter(engine);
    const w = await fin.createWallet('owner-1', 'USD');
    await fin.credit(w.id, 100.00, 'deposit');
    assert.equal(await fin.balance(w.id), 100.00);
    await fin.debit(w.id, 30.00, 'spend');
    assert.equal(await fin.balance(w.id), 70.00);
  });

  it('CommerceCreditsAdapter mirrors credits API', async () => {
    const engine = new WalletEngine();
    const credits = new CommerceCreditsAdapter(engine);
    await credits.grantCredits('cust-1', 500, 'bonus');
    assert.equal(await credits.creditBalance('cust-1'), 500);
    const { consumed, remaining } = await credits.consumeCredits('cust-1', 200);
    assert.equal(consumed, 200);
    assert.equal(remaining, 300);
  });

  it('GameEconomyAdapter mirrors game-economy WalletStore', () => {
    const engine = new WalletEngine();
    const game = new GameEconomyAdapter(engine);
    const w = game.openWallet('p1', 'player');
    game.credit(w.id, 'GEMS', 1000n, 'earn', 'reward');
    assert.equal(game.balance(w.id, 'GEMS'), 1000n);
    game.debit(w.id, 'GEMS', 300n, 'spend', 'shop');
    assert.equal(game.balance(w.id, 'GEMS'), 700n);
  });
});

describe('UniversalWalletModule — kernel integration', () => {
  let kernel: Kernel;
  let mod: UniversalWalletModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new UniversalWalletModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('opens wallets, deposits, and emits events', async () => {
    let opened = 0;
    kernel.bus.on(WalletEvents.WalletOpened, () => { opened++; });
    const w = mod.openWallet('k-user', 'player');
    mod.deposit(w.id, 'USD', 10000n, 'kernel deposit');
    await new Promise((r) => setImmediate(r));
    assert.ok(opened >= 1);
    assert.equal(mod.balance(w.id, 'USD'), 10000n);
  });

  it('transfers and emits events', async () => {
    let transfers = 0;
    kernel.bus.on(WalletEvents.Transfer, () => { transfers++; });
    const a = mod.openWallet('k-a', 'player');
    const b = mod.openWallet('k-b', 'player');
    mod.deposit(a.id, 'USD', 5000n, 'seed');
    mod.transfer(a.id, b.id, 'USD', 2000n, 'gift');
    await new Promise((r) => setImmediate(r));
    assert.equal(mod.balance(a.id, 'USD'), 3000n);
    assert.equal(mod.balance(b.id, 'USD'), 2000n);
    assert.ok(transfers >= 1);
  });

  it('verifies ledger integrity', () => {
    assert.ok(mod.verifyLedger());
    assert.ok(mod.ledgerRoot().length === 64);
  });

  it('exposes backward-compat adapters', () => {
    assert.ok(mod.finance);
    assert.ok(mod.commerceCredits);
    assert.ok(mod.gameEconomy);
  });

  it('supports custom currency registration', () => {
    mod.registerCurrency({ code: 'NGN', name: 'Nigerian Naira', symbol: '₦', assetClass: 'fiat', decimals: 2, minUnit: 1n, withdrawable: true });
    const w = mod.openWallet('ngn-user', 'player');
    mod.deposit(w.id, 'NGN', 50000n, 'NGN deposit');
    assert.equal(mod.balance(w.id, 'NGN'), 50000n);
  });

  it('provides a system summary', () => {
    const s = mod.summary();
    assert.ok(s.totalWallets > 0);
    assert.ok(s.totalTxCount > 0);
  });
});
