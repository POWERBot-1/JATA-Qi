// UniversalWalletModule — kernel module integrating the WalletEngine with the
// JATA Qi platform. Persists to storage, emits bus events, exposes the backward-
// compatibility adapters, and integrates with governance/audit.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { WalletEngine, DEFAULT_CURRENCIES } from './wallet-engine.js';
import { FinanceAdapter, CommerceCreditsAdapter, GameEconomyAdapter } from './adapters.js';
import type { Currency, EscrowHold, Transaction, TxQuery, UniversalWallet, WalletRole, WalletSummary } from './types.js';

export const WalletEvents = Object.freeze({
  WalletOpened: 'wallet.opened',
  Deposit: 'wallet.deposit',
  Withdrawal: 'wallet.withdrawal',
  Transfer: 'wallet.transfer',
  EscrowHeld: 'wallet.escrow.held',
  EscrowReleased: 'wallet.escrow.released',
  EscrowRefunded: 'wallet.escrow.refunded',
} as const);

export class UniversalWalletModule implements IModule {
  readonly id = 'universal-wallet';
  readonly tags = ['core', 'financial'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly engine: WalletEngine;

  // Backward-compat adapters (lazy-initialized from the engine).
  get finance(): FinanceAdapter { return this._finance ??= new FinanceAdapter(this.engine); }
  get commerceCredits(): CommerceCreditsAdapter { return this._credits ??= new CommerceCreditsAdapter(this.engine); }
  get gameEconomy(): GameEconomyAdapter { return this._game ??= new GameEconomyAdapter(this.engine); }
  private _finance?: FinanceAdapter;
  private _credits?: CommerceCreditsAdapter;
  private _game?: GameEconomyAdapter;

  constructor(currencies?: Currency[]) {
    this.engine = new WalletEngine(currencies);
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('universal-wallet', this);
    kernel.logger.info(`universal-wallet initialized (${this.engine.listCurrencies().length} currencies)`);
  }
  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- passthrough API (delegates to engine) ------------------------------

  openWallet(ownerId: string, role: WalletRole, orgId?: string): UniversalWallet {
    const w = this.engine.openWallet(ownerId, role, orgId);
    void this.api.bus.emit(WalletEvents.WalletOpened, { walletId: w.id, ownerId, role });
    return w;
  }

  getWallet(id: string): UniversalWallet | undefined { return this.engine.getWallet(id); }
  walletOf(ownerId: string, role: WalletRole): UniversalWallet | undefined { return this.engine.walletOf(ownerId, role); }
  listWallets(filter?: { ownerId?: string; role?: WalletRole; orgId?: string }): UniversalWallet[] { return this.engine.listWallets(filter); }
  setWalletStatus(id: string, status: 'active' | 'frozen' | 'closed'): void { this.engine.setWalletStatus(id, status); }

  registerCurrency(c: Currency): void { this.engine.registerCurrency(c); }
  listCurrencies(): Currency[] { return this.engine.listCurrencies(); }

  deposit(walletId: string, currency: string, amount: bigint, description: string, metadata?: Record<string, unknown>): Transaction {
    const tx = this.engine.deposit(walletId, currency, amount, description, metadata);
    void this.api.bus.emit(WalletEvents.Deposit, { ref: tx.ref, walletId, currency, amount: amount.toString() });
    return tx;
  }

  withdraw(walletId: string, currency: string, amount: bigint, description: string, metadata?: Record<string, unknown>): Transaction {
    const tx = this.engine.withdraw(walletId, currency, amount, description, metadata);
    void this.api.bus.emit(WalletEvents.Withdrawal, { ref: tx.ref, walletId, currency, amount: amount.toString() });
    return tx;
  }

  transfer(from: string, to: string, currency: string, amount: bigint, description: string, metadata?: Record<string, unknown>): Transaction {
    const tx = this.engine.transfer(from, to, currency, amount, description, 'transfer', metadata);
    void this.api.bus.emit(WalletEvents.Transfer, { ref: tx.ref, from, to, currency, amount: amount.toString() });
    return tx;
  }

  grant(walletId: string, currency: string, amount: bigint, description: string, metadata?: Record<string, unknown>): Transaction {
    return this.deposit(walletId, currency, amount, description, { ...metadata, source: 'grant' });
  }

  consume(walletId: string, currency: string, amount: bigint, description: string, metadata?: Record<string, unknown>): Transaction {
    return this.engine.consume(walletId, currency, amount, description, metadata);
  }

  holdEscrow(from: string, to: string, currency: string, amount: bigint, reason: string): EscrowHold {
    const hold = this.engine.holdEscrow(from, to, currency, amount, reason);
    void this.api.bus.emit(WalletEvents.EscrowHeld, { holdId: hold.id, from, to, currency });
    return hold;
  }
  releaseEscrow(holdId: string): EscrowHold {
    const hold = this.engine.releaseEscrow(holdId);
    void this.api.bus.emit(WalletEvents.EscrowReleased, { holdId });
    return hold;
  }
  refundEscrow(holdId: string): EscrowHold {
    const hold = this.engine.refundEscrow(holdId);
    void this.api.bus.emit(WalletEvents.EscrowRefunded, { holdId });
    return hold;
  }

  balance(walletId: string, currency: string): bigint { return this.engine.balance(walletId, currency); }
  balances(walletId: string): Map<string, bigint> { return this.engine.balances(walletId); }
  history(query?: TxQuery): Transaction[] { return this.engine.history(query); }
  summary(): WalletSummary { return this.engine.summary(); }
  verifyLedger(): boolean { return this.engine.verifyLedger(); }
  ledgerRoot(): string { return this.engine.ledgerRoot(); }
  get walletCount(): number { return this.engine.walletCount; }
}
