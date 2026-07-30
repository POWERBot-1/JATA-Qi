// FinanceModule — wallets, immutable ledgers, transactions, reconciliation.
// Every monetary operation creates a Transaction + an append-only LedgerEntry.
// Balances are derived from the ledger, not stored independently of it. All
// operations pass through the governance gate when policy-governance is present.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { FinanceEvents } from './types.js';
import type { LedgerEntry, Transaction, TxType, Wallet } from './types.js';

const COL_WALLETS = 'finance.wallets';
const COL_TX = 'finance.transactions';
const COL_LEDGER = 'finance.ledger';

export class FinanceModule implements IModule {
  readonly id = 'finance';
  readonly tags = ['core', 'finance'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private wallets!: ICollection<Wallet>;
  private txs!: ICollection<Transaction>;
  private ledger!: ICollection<LedgerEntry>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.wallets = await C<Wallet>(COL_WALLETS);
    this.txs = await C<Transaction>(COL_TX);
    this.ledger = await C<LedgerEntry>(COL_LEDGER);
    kernel.container.registerValue('finance', this);
    kernel.logger.info('finance module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- wallets --------------------------------------------------------------

  async createWallet(ownerId: string, currency: string, organizationId?: string): Promise<Wallet> {
    const wallet: Wallet = {
      id: randomUUID(), ownerId, currency, balance: 0, status: 'active', createdAt: Date.now(),
      ...(organizationId ? { organizationId } : {}),
    };
    await this.wallets.put(wallet);
    await this.api.bus.emit(FinanceEvents.WalletCreated, { walletId: wallet.id });
    await this.audit(ownerId, 'wallet_created', { walletId: wallet.id, currency });
    return wallet;
  }

  async getWallet(id: string): Promise<Wallet | undefined> { return this.wallets.get(id); }

  async listWallets(ownerId?: string): Promise<Wallet[]> {
    const all = await this.wallets.all();
    return ownerId ? all.filter((w) => w.ownerId === ownerId) : all;
  }

  /** Recompute balance from the immutable ledger (source of truth). */
  async ledgerBalance(walletId: string): Promise<number> {
    const entries = (await this.ledger.all()).filter((e) => e.walletId === walletId);
    return entries.reduce((sum, e) => sum + e.delta, 0);
  }

  // --- transactions ---------------------------------------------------------

  async credit(walletId: string, amount: number, description?: string, principalId?: string): Promise<Transaction> {
    return this.postTx(walletId, 'credit', amount, description, principalId);
  }

  async debit(walletId: string, amount: number, description?: string, principalId?: string): Promise<Transaction> {
    const balance = await this.ledgerBalance(walletId);
    if (amount > balance) {
      await this.api.bus.emit(FinanceEvents.InsufficientFunds, { walletId, requested: amount, balance });
      throw new Error(`finance: insufficient funds (balance ${balance}, requested ${amount})`);
    }
    return this.postTx(walletId, 'debit', amount, description, principalId);
  }

  async transfer(fromId: string, toId: string, amount: number, description?: string, principalId?: string): Promise<{ out: Transaction; inn: Transaction }> {
    const from = await this.wallets.get(fromId);
    const to = await this.wallets.get(toId);
    if (!from || !to) throw new Error('finance: wallet not found');
    if (from.currency !== to.currency) throw new Error(`finance: currency mismatch (${from.currency} → ${to.currency})`);
    const out = await this.debit(fromId, amount, description ?? 'transfer out', principalId);
    const inn = await this.postTx(toId, 'transfer_in', amount, description ?? 'transfer in', principalId, out.id);
    return { out, inn };
  }

  async reverseTransaction(txId: string, principalId?: string): Promise<Transaction> {
    const original = await this.txs.get(txId);
    if (!original) throw new Error(`finance: transaction "${txId}" not found`);
    if (original.status === 'reversed') throw new Error('finance: transaction already reversed');
    // Mark original as reversed.
    original.status = 'reversed';
    await this.txs.put(original);
    // Post a reversal entry with the opposite delta.
    const reversalType: TxType = 'reversal';
    const reversalDelta = original.type === 'debit' || original.type === 'transfer_out' ? original.amount : -original.amount;
    const tx = await this.postTx(original.walletId, reversalType, original.amount, `reversal of ${txId}`, principalId, txId, reversalDelta);
    await this.api.bus.emit(FinanceEvents.TransactionReversed, { txId: tx.id, original: txId });
    return tx;
  }

  async getTransaction(id: string): Promise<Transaction | undefined> { return this.txs.get(id); }

  async listTransactions(walletId?: string, limit = 100): Promise<Transaction[]> {
    let all = await this.txs.all();
    if (walletId) all = all.filter((t) => t.walletId === walletId);
    return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async getStatement(walletId: string): Promise<{ wallet: Wallet | undefined; balance: number; entries: LedgerEntry[] }> {
    const wallet = await this.wallets.get(walletId);
    const entries = (await this.ledger.all()).filter((e) => e.walletId === walletId).sort((a, b) => a.seq - b.seq);
    return { wallet, balance: await this.ledgerBalance(walletId), entries };
  }

  /** Verify ledger integrity: recomputed balance matches wallet balance. */
  async reconcile(walletId: string): Promise<{ ok: boolean; ledgerBalance: number; walletBalance: number }> {
    const wallet = await this.wallets.get(walletId);
    const ledgerBal = await this.ledgerBalance(walletId);
    const walletBal = wallet?.balance ?? 0;
    return { ok: ledgerBal === walletBal, ledgerBalance: ledgerBal, walletBalance: walletBal };
  }

  // --- internals ------------------------------------------------------------

  private async postTx(
    walletId: string, type: TxType, amount: number, description?: string, principalId?: string,
    relatedTxId?: string, customDelta?: number,
  ): Promise<Transaction> {
    // Governance gate.
    const gov = await this.governanceGate(principalId ?? 'system', `finance.${type}`, amount);
    if (gov && !gov.allowed) throw new Error(`finance: governance ${gov.decision} — ${gov.reason}`);

    const wallet = await this.wallets.get(walletId);
    if (!wallet) throw new Error(`finance: wallet "${walletId}" not found`);

    const now = Date.now();
    const delta = customDelta !== undefined ? customDelta : (type === 'credit' || type === 'transfer_in' ? amount : -amount);
    const balanceAfter = await this.ledgerBalance(walletId) + delta;
    const seq = ((await this.ledger.all()).filter((e) => e.walletId === walletId).length) + 1;

    const entry: LedgerEntry = { id: randomUUID(), seq, transactionId: '', walletId, delta, balanceAfter, currency: wallet.currency, ts: now };
    const tx: Transaction = {
      id: randomUUID(), walletId, type, amount, currency: wallet.currency,
      ...(description ? { description } : {}),
      ...(relatedTxId ? { relatedTxId } : {}),
      status: 'settled', createdAt: now, settledAt: now,
      ...(gov ? { governanceDecision: gov.decision } : {}),
    };
    entry.transactionId = tx.id;
    await this.txs.put(tx);
    await this.ledger.put(entry);

    // Update wallet balance (derived from ledger but cached for quick reads).
    wallet.balance = balanceAfter;
    await this.wallets.put(wallet);

    await this.api.bus.emit(FinanceEvents.TransactionSettled, { txId: tx.id, type, amount, walletId });
    await this.audit(principalId ?? wallet.ownerId, `transaction_${type}`, { txId: tx.id, amount, walletId });
    return tx;
  }

  private async governanceGate(userId: string, action: string, amount: number): Promise<{ allowed: boolean; decision: string; reason: string } | undefined> {
    try {
      const gov = this.api.getModule('policy-governance') as unknown as {
        evaluate: (s: { userId: string }, a: string, c?: Record<string, unknown>) => Promise<{ decision: string; reason: string }>;
      };
      const res = await gov.evaluate({ userId }, action, { amount });
      return { allowed: res.decision === 'ALLOW', decision: res.decision, reason: res.reason };
    } catch { return undefined; }
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec && typeof sec.audit === 'function') await sec.audit({ actor, action: `finance.${action}`, result: 'success', detail });
    } catch { /* optional */ }
  }
}
