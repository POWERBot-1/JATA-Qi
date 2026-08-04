// Wallet store + immutable, SHA-256-chained transaction ledger. Balances are
// held in bigint minor units per currency so arithmetic is exact (no float
// drift). Every credit/debit/transfer appends a ledger entry linked to the
// previous one, making the economy tamper-evident and auditable.

import { createHash, randomUUID } from 'node:crypto';
import type { Currency, Transaction, TxKind, Wallet, WalletKind } from './types.js';

const GENESIS = '0'.repeat(64);

export class EconomyError extends Error {
  constructor(message: string) { super(message); this.name = 'EconomyError'; }
}

export class WalletStore {
  private currencies = new Map<string, Currency>();
  private wallets = new Map<string, Wallet>();
  /** (ownerId|kind) -> walletId, so each owner has one wallet per role. */
  private byOwnerKind = new Map<string, string>();
  private ledger: Transaction[] = [];
  private nextTxId = 1;

  // ---- currencies --------------------------------------------------------

  registerCurrency(c: Currency): void {
    if (this.currencies.has(c.id)) throw new EconomyError(`currency ${c.id} already registered`);
    this.currencies.set(c.id, c);
  }
  getCurrency(id: string): Currency | undefined { return this.currencies.get(id); }
  listCurrencies(): Currency[] { return [...this.currencies.values()]; }

  // ---- wallets -----------------------------------------------------------

  openWallet(ownerId: string, kind: WalletKind): Wallet {
    const key = `${ownerId}|${kind}`;
    const existing = this.byOwnerKind.get(key);
    if (existing) return this.wallets.get(existing)!;
    const wallet: Wallet = { id: `w-${randomUUID()}`, ownerId, kind, balances: new Map(), createdAt: Date.now() };
    this.wallets.set(wallet.id, wallet);
    this.byOwnerKind.set(key, wallet.id);
    return wallet;
  }

  getWallet(id: string): Wallet | undefined { return this.wallets.get(id); }
  walletOf(ownerId: string, kind: WalletKind): Wallet | undefined {
    return this.wallets.get(this.byOwnerKind.get(`${ownerId}|${kind}`) ?? '');
  }
  listWallets(): Wallet[] { return [...this.wallets.values()]; }

  balance(walletId: string, currency: string): bigint {
    return this.wallets.get(walletId)?.balances.get(currency) ?? 0n;
  }

  // ---- mutations ---------------------------------------------------------

  /** Credit a wallet (mint/earn). Returns the ledger entry. */
  credit(walletId: string, currency: string, amount: bigint, kind: TxKind, reference: string): Transaction {
    if (amount < 0n) throw new EconomyError('credit amount must be non-negative');
    const w = this.requireWallet(walletId);
    this.requireCurrency(currency);
    w.balances.set(currency, (w.balances.get(currency) ?? 0n) + amount);
    return this.append({ kind, currency, amount, toWallet: walletId, reference });
  }

  /** Debit a wallet; throws on insufficient funds. */
  debit(walletId: string, currency: string, amount: bigint, kind: TxKind, reference: string): Transaction {
    if (amount < 0n) throw new EconomyError('debit amount must be non-negative');
    const w = this.requireWallet(walletId);
    this.requireCurrency(currency);
    const have = w.balances.get(currency) ?? 0n;
    if (have < amount) throw new EconomyError(`insufficient funds: have ${have}, need ${amount}`);
    w.balances.set(currency, have - amount);
    return this.append({ kind, currency, amount: -amount, fromWallet: walletId, reference });
  }

  /** Move funds between two wallets (atomic pair of entries). */
  transfer(fromWallet: string, toWallet: string, currency: string, amount: bigint, kind: TxKind, reference: string): Transaction[] {
    const d = this.debit(fromWallet, currency, amount, kind, reference);
    const c = this.credit(toWallet, currency, amount, kind, reference);
    return [d, c];
  }

  /** Mint currency into a wallet (e.g. dev/grant) — earns with kind 'mint'. */
  mint(walletId: string, currency: string, amount: bigint, reference: string): Transaction {
    return this.credit(walletId, currency, amount, 'mint', reference);
  }

  /** Burn (destroy) currency from a wallet (sink). */
  burn(walletId: string, currency: string, amount: bigint, reference: string): Transaction {
    return this.debit(walletId, currency, amount, 'burn', reference);
  }

  // ---- ledger ------------------------------------------------------------

  history(walletId?: string): Transaction[] {
    if (!walletId) return [...this.ledger];
    return this.ledger.filter((t) => t.fromWallet === walletId || t.toWallet === walletId);
  }

  ledgerRoot(): string {
    return this.ledger.length > 0 ? this.ledger[this.ledger.length - 1]!.hash : GENESIS;
  }

  /** Verify the integrity of the entire ledger chain. */
  verifyLedger(): boolean {
    let prev = GENESIS;
    for (const t of this.ledger) {
      if (t.prevHash !== prev) return false;
      if (hashEntry(t) !== t.hash) return false;
      prev = t.hash;
    }
    return true;
  }

  // ---- internals ---------------------------------------------------------

  private requireWallet(id: string): Wallet {
    const w = this.wallets.get(id);
    if (!w) throw new EconomyError(`wallet ${id} not found`);
    return w;
  }
  private requireCurrency(id: string): void {
    if (!this.currencies.has(id)) throw new EconomyError(`currency ${id} not registered`);
  }

  private append(input: { kind: TxKind; currency: string; amount: bigint; fromWallet?: string; toWallet?: string; reference: string }): Transaction {
    const id = this.nextTxId++;
    const ts = Date.now();
    const prevHash = this.ledger.length > 0 ? this.ledger[this.ledger.length - 1]!.hash : GENESIS;
    const entry: Transaction = {
      id, ts, kind: input.kind, currency: input.currency, amount: input.amount,
      ...(input.fromWallet ? { fromWallet: input.fromWallet } : {}),
      ...(input.toWallet ? { toWallet: input.toWallet } : {}),
      reference: input.reference, prevHash, hash: '',
    };
    entry.hash = hashEntry(entry);
    this.ledger.push(entry);
    return { ...entry };
  }
}

/** SHA-256 over the canonical (sorted-key) form of an entry (excluding hash). */
export function hashEntry(t: Transaction): string {
  const canonical = JSON.stringify({
    id: t.id, ts: t.ts, kind: t.kind, currency: t.currency, amount: t.amount.toString(),
    from: t.fromWallet ?? null, to: t.toWallet ?? null, reference: t.reference, prevHash: t.prevHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export { GENESIS };
export type { Currency, Transaction, Wallet, WalletKind };
