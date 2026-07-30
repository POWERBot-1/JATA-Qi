import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { SecurityModule } from '@jataqi/security';
import { PolicyGovernanceModule } from '@jataqi/policy-governance';
import { FinanceModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('FinanceModule', () => {
  let kernel: Kernel;
  let fin: FinanceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new SecurityModule());
    kernel.register(new FinanceModule());
    await kernel.boot();
    fin = kernel.getModule<FinanceModule>('finance');
  });

  it('creates wallets', async () => {
    const w = await fin.createWallet('u1', 'KES');
    assert.equal(w.currency, 'KES');
    assert.equal(w.balance, 0);
    assert.equal(w.status, 'active');
  });

  it('credits and the balance is derived from the immutable ledger', async () => {
    const w = await fin.createWallet('u1', 'USD');
    await fin.credit(w.id, 100, 'deposit');
    assert.equal(await fin.ledgerBalance(w.id), 100);
    assert.equal((await fin.getWallet(w.id))!.balance, 100);
    await fin.credit(w.id, 50, 'top-up');
    assert.equal(await fin.ledgerBalance(w.id), 150);
  });

  it('debits and rejects insufficient funds', async () => {
    const w = await fin.createWallet('u1', 'USD');
    await fin.credit(w.id, 100);
    await fin.debit(w.id, 30, 'purchase');
    assert.equal(await fin.ledgerBalance(w.id), 70);
    await assert.rejects(() => fin.debit(w.id, 100, 'too much'), /insufficient funds/);
    assert.equal(await fin.ledgerBalance(w.id), 70); // unchanged
  });

  it('transfers between wallets (same currency)', async () => {
    const a = await fin.createWallet('u1', 'KES');
    const b = await fin.createWallet('u2', 'KES');
    await fin.credit(a.id, 500);
    const { out, inn } = await fin.transfer(a.id, b.id, 200, 'payment');
    assert.equal(out.type, 'debit');
    assert.equal(inn.type, 'transfer_in');
    assert.equal(await fin.ledgerBalance(a.id), 300);
    assert.equal(await fin.ledgerBalance(b.id), 200);
  });

  it('rejects cross-currency transfers', async () => {
    const a = await fin.createWallet('u1', 'USD');
    const b = await fin.createWallet('u2', 'KES');
    await fin.credit(a.id, 100);
    await assert.rejects(() => fin.transfer(a.id, b.id, 50), /currency mismatch/);
  });

  it('reverses a transaction with an opposite ledger entry', async () => {
    const w = await fin.createWallet('u1', 'USD');
    await fin.credit(w.id, 100);
    const debit = await fin.debit(w.id, 30, 'purchase');
    assert.equal(await fin.ledgerBalance(w.id), 70);
    const reversal = await fin.reverseTransaction(debit.id);
    assert.equal(reversal.type, 'reversal');
    // Reversal of a debit credits back: 70 + 30 = 100
    assert.equal(await fin.ledgerBalance(w.id), 100);
  });

  it('reconciles: ledger balance matches wallet balance', async () => {
    const w = await fin.createWallet('u1', 'USD');
    await fin.credit(w.id, 100);
    await fin.debit(w.id, 25);
    const rec = await fin.reconcile(w.id);
    assert.equal(rec.ok, true);
    assert.equal(rec.ledgerBalance, 75);
  });

  it('produces a statement with ordered ledger entries', async () => {
    const w = await fin.createWallet('u1', 'KES');
    await fin.credit(w.id, 1000, 'salary');
    await fin.debit(w.id, 300, 'rent');
    const stmt = await fin.getStatement(w.id);
    assert.equal(stmt.balance, 700);
    assert.equal(stmt.entries.length, 2);
    assert.equal(stmt.entries[0]!.seq, 1);
    assert.equal(stmt.entries[1]!.seq, 2);
    assert.equal(stmt.entries[0]!.delta, 1000);
    assert.equal(stmt.entries[1]!.delta, -300);
  });

  it('emits transaction events', async () => {
    let settled = 0;
    kernel.bus.on('finance.transaction.settled', () => { settled++; });
    const w = await fin.createWallet('u1', 'USD');
    await fin.credit(w.id, 50);
    assert.ok(settled >= 1);
  });
});

describe('FinanceModule — governance integration', () => {
  let kernel: Kernel;
  let fin: FinanceModule;
  let gov: PolicyGovernanceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new SecurityModule());
    kernel.register(new PolicyGovernanceModule());
    kernel.register(new FinanceModule());
    await kernel.boot();
    fin = kernel.getModule<FinanceModule>('finance');
    gov = kernel.getModule<PolicyGovernanceModule>('policy-governance');
    // In a governed system, financial actions (sensitive by default) need explicit allows.
    await gov.createPolicy({ name: 'allow credit', category: 'FINANCE', scope: 'GLOBAL', effect: 'ALLOW', action: 'finance.credit' }, 'admin');
    await gov.createPolicy({ name: 'allow debit', category: 'FINANCE', scope: 'GLOBAL', effect: 'ALLOW', action: 'finance.debit' }, 'admin');
  });

  it('blocks debits when governance denies finance.debit', async () => {
    const w = await fin.createWallet('u1', 'USD');
    await fin.credit(w.id, 1000);
    await gov.createPolicy({ name: 'block debit', category: 'FINANCE', scope: 'GLOBAL', effect: 'DENY', action: 'finance.debit' }, 'admin');
    await assert.rejects(() => fin.debit(w.id, 100, 'blocked'), /governance DENY/);
  });

  it('allows credits when governance permits', async () => {
    const w = await fin.createWallet('u1', 'USD');
    const tx = await fin.credit(w.id, 500, 'allowed');
    assert.ok(tx.governanceDecision); // decision recorded
    assert.equal(tx.governanceDecision, 'ALLOW');
  });

  it('blocks high-value transactions via threshold condition', async () => {
    const w = await fin.createWallet('u1', 'USD');
    await fin.credit(w.id, 100_000);
    await gov.createPolicy({
      name: 'large debit approval', category: 'FINANCE', scope: 'GLOBAL',
      effect: 'REQUIRE_APPROVAL', action: 'finance.debit',
      conditions: { amountGte: 10_000 },
    }, 'admin');
    // Small debit OK.
    await fin.debit(w.id, 500, 'small');
    // Large debit blocked (REQUIRES_APPROVAL → governanceGate denies).
    await assert.rejects(() => fin.debit(w.id, 50_000, 'large'), /governance REQUIRES_APPROVAL/);
  });
});
