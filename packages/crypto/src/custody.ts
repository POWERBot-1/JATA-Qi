// Custody Engine — manages hot, warm, and cold wallets with role-based
// transaction policies. Hot wallets can transact freely; warm wallets require
// approval; cold wallets cannot initiate outbound transactions.

import { randomUUID } from 'node:crypto';
import type { CustodyType, CustodyWallet } from './types.js';

export class CustodyEngine {
  private wallets = new Map<string, CustodyWallet>();
  /** Pending withdrawal requests from warm wallets. */
  private pendingRequests: Array<{
    id: string; walletId: string; to: string; asset: string; amount: bigint;
    requestedAt: number; status: 'pending' | 'approved' | 'rejected';
  }> = [];

  /** Create a custody wallet. */
  createWallet(address: string, type: CustodyType, owner: string): CustodyWallet {
    const wallet: CustodyWallet = {
      id: randomUUID(), address, type, owner,
      balances: new Map(), canTransact: type !== 'cold',
      createdAt: Date.now(),
    };
    this.wallets.set(wallet.id, wallet);
    return wallet;
  }

  getWallet(id: string): CustodyWallet | undefined { return this.wallets.get(id); }
  getWalletByAddress(address: string): CustodyWallet | undefined {
    return [...this.wallets.values()].find((w) => w.address === address);
  }
  listWallets(filter?: { type?: CustodyType; owner?: string }): CustodyWallet[] {
    return [...this.wallets.values()].filter((w) =>
      (!filter?.type || w.type === filter.type) &&
      (!filter?.owner || w.owner === filter.owner));
  }

  /** Credit a custody wallet. */
  credit(walletId: string, asset: string, amount: bigint): void {
    const w = this.wallets.get(walletId);
    if (!w) throw new Error(`wallet ${walletId} not found`);
    w.balances.set(asset, (w.balances.get(asset) ?? 0n) + amount);
  }

  /** Initiate a withdrawal from a custody wallet. Hot wallets execute immediately;
   *  warm wallets require approval; cold wallets are rejected. */
  withdraw(walletId: string, to: string, asset: string, amount: bigint): { executed: boolean; requestId?: string; message: string } {
    const w = this.wallets.get(walletId);
    if (!w) throw new Error(`wallet ${walletId} not found`);
    const balance = w.balances.get(asset) ?? 0n;
    if (balance < amount) throw new Error(`insufficient balance: ${balance} < ${amount}`);

    if (w.type === 'cold') return { executed: false, message: 'cold wallet cannot initiate transactions' };
    if (w.type === 'hot') {
      w.balances.set(asset, balance - amount);
      return { executed: true, message: 'withdrawal executed from hot wallet' };
    }
    // Warm wallet → create approval request.
    const req = { id: randomUUID(), walletId, to, asset, amount, requestedAt: Date.now(), status: 'pending' as const };
    this.pendingRequests.push(req);
    return { executed: false, requestId: req.id, message: 'withdrawal requires approval (warm wallet)' };
  }

  /** Approve a pending warm-wallet withdrawal. */
  approveWithdrawal(requestId: string): { executed: boolean; message: string } {
    const req = this.pendingRequests.find((r) => r.id === requestId && r.status === 'pending');
    if (!req) throw new Error(`request ${requestId} not found or already processed`);
    const w = this.wallets.get(req.walletId);
    if (!w) throw new Error(`wallet ${req.walletId} not found`);
    const balance = w.balances.get(req.asset) ?? 0n;
    if (balance < req.amount) { req.status = 'rejected'; return { executed: false, message: 'insufficient balance at approval time' }; }
    w.balances.set(req.asset, balance - req.amount);
    req.status = 'approved';
    return { executed: true, message: 'withdrawal approved and executed' };
  }

  /** Reject a pending withdrawal. */
  rejectWithdrawal(requestId: string): void {
    const req = this.pendingRequests.find((r) => r.id === requestId);
    if (!req) throw new Error(`request ${requestId} not found`);
    req.status = 'rejected';
  }

  listPendingRequests(): typeof this.pendingRequests { return this.pendingRequests.filter((r) => r.status === 'pending'); }

  /** Total holdings by asset across all custody wallets. */
  totalHoldings(asset?: string): Map<string, bigint> {
    const totals = new Map<string, bigint>();
    for (const w of this.wallets.values()) {
      for (const [sym, bal] of w.balances) {
        if (asset && sym !== asset) continue;
        totals.set(sym, (totals.get(sym) ?? 0n) + bal);
      }
    }
    return totals;
  }

  get walletCount(): number { return this.wallets.size; }
}
