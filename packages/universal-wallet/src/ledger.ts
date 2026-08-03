// Double-entry ledger — the immutable source of truth. Every financial movement
// produces a paired debit and credit entry (or a single-sided entry for external
// deposits/withdrawals). Entries are SHA-256-chained for tamper-evidence.
// Balances are derived from the ledger, never stored independently.

import { createHash } from 'node:crypto';
import type { LedgerEntry, TxCategory } from './types.js';

const GENESIS = '0'.repeat(64);

export class DoubleEntryLedger {
  private entries: LedgerEntry[] = [];
  private nextId = 1;
  private txCounter = 0;

  get length(): number { return this.entries.length; }

  /**
   * Post a paired transaction (double-entry). Returns the transaction ref and
   * the two entry IDs.
   */
  postPair(opts: {
    fromWalletId: string; toWalletId: string; currency: string; amount: bigint;
    category: TxCategory; description: string; metadata?: Record<string, unknown>;
  }): { ref: string; debitId: number; creditId: number; ts: number } {
    const ref = this.newRef();
    const ts = Date.now();
    const debit = this.append('debit', opts.fromWalletId, opts.currency, opts.amount, opts.toWalletId, ref, opts.category, opts.description, opts.metadata);
    const credit = this.append('credit', opts.toWalletId, opts.currency, opts.amount, opts.fromWalletId, ref, opts.category, opts.description, opts.metadata);
    return { ref, debitId: debit.id, creditId: credit.id, ts };
  }

  /**
   * Post a single-sided entry (external deposit or withdrawal).
   * For deposits: entryType='credit', counterparty='external'.
   * For withdrawals: entryType='debit', counterparty='external'.
   */
  postSingle(opts: {
    walletId: string; currency: string; amount: bigint; entryType: 'debit' | 'credit';
    category: TxCategory; description: string; metadata?: Record<string, unknown>;
  }): { ref: string; entryId: number; ts: number } {
    const ref = this.newRef();
    const ts = Date.now();
    const entry = this.append(opts.entryType, opts.walletId, opts.currency, opts.amount, 'external', ref, opts.category, opts.description, opts.metadata);
    return { ref, entryId: entry.id, ts };
  }

  /** Compute the balance of a wallet for a specific currency from the ledger. */
  balance(walletId: string, currency: string): bigint {
    let bal = 0n;
    for (const e of this.entries) {
      if (e.walletId !== walletId || e.currency !== currency) continue;
      bal += e.entryType === 'credit' ? e.amount : -e.amount;
    }
    return bal;
  }

  /** All balances for a wallet (currency code -> bigint). */
  balances(walletId: string): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const e of this.entries) {
      if (e.walletId !== walletId) continue;
      const cur = out.get(e.currency) ?? 0n;
      out.set(e.currency, cur + (e.entryType === 'credit' ? e.amount : -e.amount));
    }
    return out;
  }

  /** Query entries by filter. */
  query(filter: { walletId?: string; currency?: string; category?: string; fromTs?: number; toTs?: number; limit?: number }): LedgerEntry[] {
    let results = this.entries.filter((e) =>
      (!filter.walletId || e.walletId === filter.walletId) &&
      (!filter.currency || e.currency === filter.currency) &&
      (!filter.category || e.category === filter.category) &&
      (!filter.fromTs || e.ts >= filter.fromTs) &&
      (!filter.toTs || e.ts <= filter.toTs));
    if (filter.limit) results = results.slice(-filter.limit);
    return results;
  }

  /** Verify the integrity of the entire chain. */
  verify(): boolean {
    let prev = GENESIS;
    for (const e of this.entries) {
      if (e.prevHash !== prev) return false;
      if (hashEntry(e) !== e.hash) return false;
      prev = e.hash;
    }
    return true;
  }

  /** Root hash of the chain (or genesis if empty). */
  rootHash(): string {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]!.hash : GENESIS;
  }

  /** All entries (defensive copy). */
  all(): LedgerEntry[] { return [...this.entries]; }

  // ---- internal ----------------------------------------------------------

  private append(
    entryType: 'debit' | 'credit', walletId: string, currency: string, amount: bigint,
    counterpartyWalletId: string, transactionRef: string, category: TxCategory,
    description: string, metadata?: Record<string, unknown>,
  ): LedgerEntry {
    const id = this.nextId++;
    const ts = Date.now();
    const prevHash = this.entries.length > 0 ? this.entries[this.entries.length - 1]!.hash : GENESIS;
    const entry: LedgerEntry = {
      id, ts, entryType, walletId, currency, amount, counterpartyWalletId,
      transactionRef, category, description, prevHash, hash: '',
      ...(metadata ? { metadata } : {}),
    };
    entry.hash = hashEntry(entry);
    this.entries.push(entry);
    return entry;
  }

  private newRef(): string {
    return `tx-${++this.txCounter}-${Date.now().toString(36)}`;
  }
}

/** SHA-256 over the canonical form of an entry (excluding hash). */
export function hashEntry(e: LedgerEntry): string {
  const canonical = JSON.stringify({
    id: e.id, ts: e.ts, type: e.entryType, w: e.walletId, c: e.currency,
    a: e.amount.toString(), cp: e.counterpartyWalletId, ref: e.transactionRef,
    cat: e.category, desc: e.description, prev: e.prevHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export { GENESIS };
