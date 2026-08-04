// Backward-compatibility adapters. These wrap the WalletEngine so that callers
// using the legacy finance.Wallet, commerce.credits, or game-economy.WalletStore
// APIs can migrate incrementally without breaking changes. Each adapter exposes
// the same method signatures as the legacy system but routes through the unified
// double-entry ledger.

import { WalletEngine } from './wallet-engine.js';
import type { WalletRole } from './types.js';

/**
 * Finance adapter — mirrors the @jataqi/finance FinanceModule API.
 * Methods: createWallet, credit, debit, transfer, balance, ledgerBalance.
 */
export class FinanceAdapter {
  constructor(private engine: WalletEngine) {}

  async createWallet(ownerId: string, currency: string, orgId?: string): Promise<{ id: string; ownerId: string; currency: string; balance: number; status: string }> {
    const w = this.engine.openWallet(ownerId, orgId ? 'treasury' : 'system', orgId);
    return { id: w.id, ownerId, currency, balance: 0, status: 'active' };
  }

  async credit(walletId: string, amount: number, description?: string, principalId?: string): Promise<{ id: string; walletId: string; amount: number; type: string }> {
    const w = this.engine.getWallet(walletId);
    const currency = w ? [...w.balances.keys()][0] ?? 'USD' : 'USD';
    const tx = this.engine.deposit(walletId, currency, BigInt(Math.round(amount * 100)), description ?? 'credit', { principalId });
    return { id: tx.ref, walletId, amount, type: 'credit' };
  }

  async debit(walletId: string, amount: number, description?: string, principalId?: string): Promise<{ id: string; walletId: string; amount: number; type: string }> {
    const w = this.engine.getWallet(walletId);
    const currency = w ? [...w.balances.keys()][0] ?? 'USD' : 'USD';
    const tx = this.engine.consume(walletId, currency, BigInt(Math.round(amount * 100)), description ?? 'debit', { principalId });
    return { id: tx.ref, walletId, amount, type: 'debit' };
  }

  async balance(walletId: string): Promise<number> {
    const w = this.engine.getWallet(walletId);
    if (!w) return 0;
    const bal = [...w.balances.values()].reduce((s, b) => s + b, 0n);
    return Number(bal) / 100;
  }

  async transfer(from: string, to: string, amount: number, description?: string): Promise<{ id: string }> {
    const w = this.engine.getWallet(from);
    const currency = w ? [...w.balances.keys()][0] ?? 'USD' : 'USD';
    const tx = this.engine.transfer(from, to, currency, BigInt(Math.round(amount * 100)), description ?? 'transfer');
    return { id: tx.ref };
  }
}

/**
 * Commerce credits adapter — mirrors @jataqi/commerce grantCredits/creditBalance/consumeCredits.
 */
export class CommerceCreditsAdapter {
  constructor(private engine: WalletEngine) {}

  async grantCredits(customerId: string, amount: number, source: string, expiresAt?: number): Promise<{ id: string; customerId: string; amount: number; remaining: number }> {
    const w = this.engine.openWallet(customerId, 'player');
    this.engine.grant(w.id, 'POINTS', BigInt(amount), `Credits from ${source}`, { source, ...(expiresAt ? { expiresAt } : {}) });
    const remaining = this.engine.balance(w.id, 'POINTS');
    return { id: randomUUIDSafe(), customerId, amount, remaining: Number(remaining) };
  }

  async creditBalance(customerId: string): Promise<number> {
    const w = this.engine.walletOf(customerId, 'player');
    return w ? Number(this.engine.balance(w.id, 'POINTS')) : 0;
  }

  async consumeCredits(customerId: string, amount: number): Promise<{ consumed: number; remaining: number }> {
    const w = this.engine.walletOf(customerId, 'player');
    if (!w) return { consumed: 0, remaining: 0 };
    const balance = this.engine.balance(w.id, 'POINTS');
    const consumed = Math.min(amount, Number(balance));
    if (consumed > 0) this.engine.consume(w.id, 'POINTS', BigInt(consumed), 'Credit consumption');
    return { consumed, remaining: Number(this.engine.balance(w.id, 'POINTS')) };
  }
}

/**
 * Game economy adapter — mirrors @jataqi/game-economy WalletStore.
 * Uses bigint minor units directly (same precision as the original).
 */
export class GameEconomyAdapter {
  constructor(private engine: WalletEngine) {}

  openWallet(ownerId: string, kind: WalletRole) {
    return this.engine.openWallet(ownerId, kind);
  }

  credit(walletId: string, currency: string, amount: bigint, _kind: string, reference: string) {
    return this.engine.deposit(walletId, currency, amount, reference);
  }

  debit(walletId: string, currency: string, amount: bigint, _kind: string, reference: string) {
    return this.engine.consume(walletId, currency, amount, reference);
  }

  transfer(from: string, to: string, currency: string, amount: bigint, _kind: string, reference: string) {
    return this.engine.transfer(from, to, currency, amount, reference);
  }

  balance(walletId: string, currency: string): bigint {
    return this.engine.balance(walletId, currency);
  }
}

function randomUUIDSafe(): string {
  return `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
