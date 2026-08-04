// WalletEngine — the core universal wallet service. Manages wallet accounts,
// currencies, the double-entry ledger, escrow holds, and provides the unified
// API that replaces the three legacy wallet systems. All operations are
// atomic (debit-before-credit) and produce immutable audit entries.

import { randomUUID } from 'node:crypto';
import { DoubleEntryLedger } from './ledger.js';
import type { Currency, EscrowHold, Transaction, TxCategory, TxQuery, UniversalWallet, WalletRole, WalletSummary } from './types.js';

export class WalletError extends Error {
  constructor(message: string) { super(message); this.name = 'WalletError'; }
}

/** Default supported currencies. */
export const DEFAULT_CURRENCIES: Currency[] = [
  { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', assetClass: 'fiat', decimals: 2, minUnit: 1n, withdrawable: true },
  { code: 'USD', name: 'US Dollar', symbol: '$', assetClass: 'fiat', decimals: 2, minUnit: 1n, withdrawable: true },
  { code: 'EUR', name: 'Euro', symbol: '€', assetClass: 'fiat', decimals: 2, minUnit: 1n, withdrawable: true },
  { code: 'GBP', name: 'British Pound', symbol: '£', assetClass: 'fiat', decimals: 2, minUnit: 1n, withdrawable: true },
  { code: 'KRT', name: 'KART Token', symbol: 'KRT', assetClass: 'crypto', decimals: 8, minUnit: 1n, withdrawable: true },
  { code: 'USDT', name: 'Tether', symbol: 'USDT', assetClass: 'crypto', decimals: 6, minUnit: 1n, withdrawable: true },
  { code: 'USDC', name: 'USD Coin', symbol: 'USDC', assetClass: 'crypto', decimals: 6, minUnit: 1n, withdrawable: true },
  { code: 'POINTS', name: 'Reward Points', symbol: '★', assetClass: 'virtual', decimals: 0, minUnit: 1n, withdrawable: false },
  { code: 'CREDIT', name: 'Store Credit', symbol: 'SC', assetClass: 'virtual', decimals: 2, minUnit: 1n, withdrawable: false },
  { code: 'GEMS', name: 'Game Gems', symbol: '◆', assetClass: 'virtual', decimals: 0, minUnit: 1n, withdrawable: false },
  { code: 'COINS', name: 'Game Coins', symbol: '¢', assetClass: 'virtual', decimals: 0, minUnit: 1n, withdrawable: false },
];

export class WalletEngine {
  readonly ledger = new DoubleEntryLedger();
  private wallets = new Map<string, UniversalWallet>();
  private byOwnerRole = new Map<string, string>(); // ownerId|role -> walletId
  private currencies = new Map<string, Currency>();
  private escrows = new Map<string, EscrowHold>();

  constructor(currencies: Currency[] = DEFAULT_CURRENCIES) {
    for (const c of currencies) this.registerCurrency(c);
  }

  // ---- currency management ------------------------------------------------

  registerCurrency(c: Currency): void { this.currencies.set(c.code, c); }
  getCurrency(code: string): Currency | undefined { return this.currencies.get(code); }
  listCurrencies(): Currency[] { return [...this.currencies.values()]; }

  // ---- wallet management --------------------------------------------------

  /** Open (or return existing) wallet for an owner + role. */
  openWallet(ownerId: string, role: WalletRole, orgId?: string): UniversalWallet {
    const key = `${ownerId}|${role}`;
    const existing = this.byOwnerRole.get(key);
    if (existing) return this.wallets.get(existing)!;
    const wallet: UniversalWallet = {
      id: randomUUID(), ownerId, role,
      ...(orgId ? { orgId } : {}),
      balances: new Map(), status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.wallets.set(wallet.id, wallet);
    this.byOwnerRole.set(key, wallet.id);
    return wallet;
  }

  getWallet(id: string): UniversalWallet | undefined { return this.wallets.get(id); }
  walletOf(ownerId: string, role: WalletRole): UniversalWallet | undefined {
    return this.wallets.get(this.byOwnerRole.get(`${ownerId}|${role}`) ?? '');
  }
  listWallets(filter?: { ownerId?: string; role?: WalletRole; orgId?: string }): UniversalWallet[] {
    return [...this.wallets.values()].filter((w) =>
      (!filter?.ownerId || w.ownerId === filter.ownerId) &&
      (!filter?.role || w.role === filter.role) &&
      (!filter?.orgId || w.orgId === filter.orgId));
  }

  /** Freeze or unfreeze a wallet (blocks all operations while frozen). */
  setWalletStatus(id: string, status: 'active' | 'frozen' | 'closed'): void {
    const w = this.wallets.get(id);
    if (!w) throw new WalletError(`wallet ${id} not found`);
    w.status = status;
    w.updatedAt = Date.now();
  }

  // ---- core operations ----------------------------------------------------

  /** Deposit funds from an external source. */
  deposit(walletId: string, currency: string, amount: bigint, description: string, metadata?: Record<string, unknown>): Transaction {
    this.check(walletId, currency, amount);
    const { ref, entryId, ts } = this.ledger.postSingle({
      walletId, currency, amount, entryType: 'credit', category: 'deposit', description, metadata,
    });
    this.syncBalance(walletId, currency);
    return this.toTransaction(ref, ts, 'deposit', currency, amount, 'external', walletId, description, [entryId], 'settled', metadata);
  }

  /** Withdraw funds to an external destination. */
  withdraw(walletId: string, currency: string, amount: bigint, description: string, metadata?: Record<string, unknown>): Transaction {
    this.check(walletId, currency, amount);
    const balance = this.ledger.balance(walletId, currency);
    if (balance < amount) throw new WalletError(`insufficient funds: ${balance} < ${amount} ${currency}`);
    const cur = this.currencies.get(currency);
    if (cur && !cur.withdrawable) throw new WalletError(`${currency} is not withdrawable`);
    const { ref, entryId, ts } = this.ledger.postSingle({
      walletId, currency, amount, entryType: 'debit', category: 'withdrawal', description, metadata,
    });
    this.syncBalance(walletId, currency);
    return this.toTransaction(ref, ts, 'withdrawal', currency, amount, walletId, 'external', description, [entryId], 'settled', metadata);
  }

  /** Transfer funds between two wallets (atomic double-entry). */
  transfer(fromWalletId: string, toWalletId: string, currency: string, amount: bigint, description: string, category: TxCategory = 'transfer', metadata?: Record<string, unknown>): Transaction {
    this.check(fromWalletId, currency, amount);
    this.check(toWalletId, currency, 0n); // 0 = just verify wallet exists
    if (fromWalletId === toWalletId) throw new WalletError('cannot transfer to the same wallet');
    const balance = this.ledger.balance(fromWalletId, currency);
    if (balance < amount) throw new WalletError(`insufficient funds: ${balance} < ${amount} ${currency}`);
    const { ref, debitId, creditId, ts } = this.ledger.postPair({
      fromWalletId, toWalletId, currency, amount, category, description, metadata,
    });
    this.syncBalance(fromWalletId, currency);
    this.syncBalance(toWalletId, currency);
    return this.toTransaction(ref, ts, category, currency, amount, fromWalletId, toWalletId, description, [debitId, creditId], 'settled', metadata);
  }

  /** Grant funds (system credit — e.g. rewards, refunds). */
  grant(walletId: string, currency: string, amount: bigint, description: string, metadata?: Record<string, unknown>): Transaction {
    return this.deposit(walletId, currency, amount, description, { ...metadata, source: 'grant' });
  }

  /** Consume/deduct funds (system debit — e.g. spend, fee). */
  consume(walletId: string, currency: string, amount: bigint, description: string, metadata?: Record<string, unknown>): Transaction {
    this.check(walletId, currency, amount);
    const balance = this.ledger.balance(walletId, currency);
    if (balance < amount) throw new WalletError(`insufficient funds: ${balance} < ${amount} ${currency}`);
    const { ref, entryId, ts } = this.ledger.postSingle({
      walletId, currency, amount, entryType: 'debit', category: 'consume', description, metadata,
    });
    this.syncBalance(walletId, currency);
    return this.toTransaction(ref, ts, 'consume', currency, amount, walletId, 'system', description, [entryId], 'settled', metadata);
  }

  // ---- escrow -------------------------------------------------------------

  /** Hold funds in escrow (transfers to an escrow wallet until released). */
  holdEscrow(fromWalletId: string, toWalletId: string, currency: string, amount: bigint, reason: string): EscrowHold {
    this.transfer(fromWalletId, toWalletId, currency, amount, `Escrow: ${reason}`, 'escrow_hold');
    const hold: EscrowHold = {
      id: randomUUID(), fromWalletId, toWalletId, currency, amount,
      status: 'held', reason, createdAt: Date.now(),
    };
    this.escrows.set(hold.id, hold);
    return hold;
  }

  /** Release escrow (funds stay in the destination wallet). */
  releaseEscrow(holdId: string): EscrowHold {
    const h = this.escrows.get(holdId);
    if (!h || h.status !== 'held') throw new WalletError(`escrow ${holdId} not held`);
    h.status = 'released';
    h.resolvedAt = Date.now();
    return h;
  }

  /** Refund escrow (funds return to the source wallet). */
  refundEscrow(holdId: string): EscrowHold {
    const h = this.escrows.get(holdId);
    if (!h || h.status !== 'held') throw new WalletError(`escrow ${holdId} not held`);
    this.transfer(h.toWalletId, h.fromWalletId, h.currency, h.amount, `Escrow refund: ${h.reason}`, 'escrow_release');
    h.status = 'refunded';
    h.resolvedAt = Date.now();
    return h;
  }

  listEscrows(status?: 'held' | 'released' | 'refunded'): EscrowHold[] {
    const all = [...this.escrows.values()];
    return status ? all.filter((e) => e.status === status) : all;
  }

  // ---- queries ------------------------------------------------------------

  balance(walletId: string, currency: string): bigint { return this.ledger.balance(walletId, currency); }
  balances(walletId: string): Map<string, bigint> { return this.ledger.balances(walletId); }

  history(query: TxQuery = {}): Transaction[] {
    const entries = this.ledger.query(query);
    // Group entries by transactionRef to reconstruct Transaction objects.
    const byRef = new Map<string, LedgerEntryPseudo[]>();
    for (const e of entries) {
      const arr = byRef.get(e.transactionRef) ?? [];
      arr.push(e);
      byRef.set(e.transactionRef, arr);
    }
    return [...byRef.entries()].map(([ref, entries]) => {
      const first = entries[0]!;
      const debit = entries.find((e) => e.entryType === 'debit');
      const credit = entries.find((e) => e.entryType === 'credit');
      return this.toTransaction(
        ref, first.ts, first.category, first.currency, first.amount,
        debit?.walletId ?? 'external', credit?.walletId ?? 'external',
        first.description, entries.map((e) => e.id), 'settled', first.metadata,
      );
    }).sort((a, b) => b.ts - a.ts);
  }

  summary(): WalletSummary {
    const totalBalanceByCurrency: Record<string, bigint> = {};
    for (const w of this.wallets.values()) {
      for (const [cur, bal] of w.balances) {
        totalBalanceByCurrency[cur] = (totalBalanceByCurrency[cur] ?? 0n) + bal;
      }
    }
    return {
      totalWallets: this.wallets.size,
      totalBalanceByCurrency,
      totalTxCount: this.ledger.length,
      activeEscrows: this.listEscrows('held').length,
    };
  }

  verifyLedger(): boolean { return this.ledger.verify(); }
  ledgerRoot(): string { return this.ledger.rootHash(); }
  get walletCount(): number { return this.wallets.size; }

  // ---- internal -----------------------------------------------------------

  private check(walletId: string, currency: string, amount: bigint): void {
    const w = this.wallets.get(walletId);
    if (!w) throw new WalletError(`wallet ${walletId} not found`);
    if (w.status === 'frozen') throw new WalletError(`wallet ${walletId} is frozen`);
    if (w.status === 'closed') throw new WalletError(`wallet ${walletId} is closed`);
    if (!this.currencies.has(currency)) throw new WalletError(`currency ${currency} not registered`);
    if (amount < 0n) throw new WalletError('amount must be non-negative');
  }

  private syncBalance(walletId: string, currency: string): void {
    const w = this.wallets.get(walletId);
    if (w) {
      w.balances.set(currency, this.ledger.balance(walletId, currency));
      w.updatedAt = Date.now();
    }
  }

  private toTransaction(
    ref: string, ts: number, category: TxCategory, currency: string, amount: bigint,
    fromWalletId: string, toWalletId: string, description: string, entryIds: number[],
    status: 'settled' | 'pending' | 'failed', metadata?: Record<string, unknown>,
  ): Transaction {
    return {
      ref, ts, category, currency, amount, fromWalletId, toWalletId, description,
      entryIds, status, ...(metadata ? { metadata } : {}),
    };
  }
}

// Minimal alias for the query result type (avoids a full import cycle).
type LedgerEntryPseudo = {
  id: number; ts: number; entryType: string; walletId: string; currency: string;
  amount: bigint; transactionRef: string; category: TxCategory; description: string;
  metadata?: Record<string, unknown>;
};
