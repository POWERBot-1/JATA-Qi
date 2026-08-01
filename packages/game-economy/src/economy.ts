// GameEconomyModule — kernel module wrapping the wallet store, currencies, and
// marketplace. Seeds sensible default currencies at boot and emits economy
// events on transactions and purchases for analytics/audit.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { WalletStore, EconomyError } from './wallet.js';
import { Marketplace, type MarketplaceConfig } from './marketplace.js';
import type { Currency, WalletKind } from './types.js';

export const EconomyEvents = Object.freeze({
  Transaction: 'economy.tx',
  Purchase: 'economy.purchase',
  WalletOpened: 'economy.wallet.opened',
} as const);

export interface GameEconomyConfig {
  /** Marketplace configuration; omit to disable the marketplace. */
  marketplace?: MarketplaceConfig;
  /** Extra currencies to register at boot. */
  currencies?: Currency[];
}

const DEFAULT_CURRENCIES: Currency[] = [
  { id: 'coins', name: 'Coins', symbol: '¢', kind: 'soft', decimals: 0, purchasable: false },
  { id: 'gems', name: 'Gems', symbol: '◆', kind: 'premium', decimals: 0, purchasable: true },
  { id: 'usd', name: 'US Dollars', symbol: '$', kind: 'hard', decimals: 2, purchasable: true },
];

export class GameEconomyModule implements IModule {
  readonly id = 'game-economy';
  readonly tags = ['core', 'game'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly store = new WalletStore();
  marketplace?: Marketplace;

  constructor(private cfg: GameEconomyConfig = {}) {}

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('game-economy', this);
    for (const c of [...DEFAULT_CURRENCIES, ...(this.cfg.currencies ?? [])]) this.store.registerCurrency(c);
    if (this.cfg.marketplace) this.marketplace = new Marketplace(this.store, this.cfg.marketplace);
    kernel.logger.info(`game-economy initialized: ${this.store.listCurrencies().length} currencies, marketplace=${!!this.marketplace}`);
  }

  async start(_kernel: KernelApi): Promise<void> {
    // Subscribe wallet-store mutations to the bus by wrapping key calls below.
  }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless aside from in-memory ledger */ }

  // ---- currency + wallet passthroughs -----------------------------------

  currencies(): Currency[] { return this.store.listCurrencies(); }

  openWallet(ownerId: string, kind: WalletKind) {
    const w = this.store.openWallet(ownerId, kind);
    void this.api.bus.emit(EconomyEvents.WalletOpened, { wallet: w.id, owner: ownerId, kind });
    return w;
  }

  balance(walletId: string, currency: string): bigint { return this.store.balance(walletId, currency); }

  grant(walletId: string, currency: string, amount: bigint, reference: string) {
    const tx = this.store.credit(walletId, currency, amount, 'earn', reference);
    void this.api.bus.emit(EconomyEvents.Transaction, { id: tx.id, kind: tx.kind, currency, amount: amount.toString() });
    return tx;
  }

  charge(walletId: string, currency: string, amount: bigint, reference: string) {
    const tx = this.store.debit(walletId, currency, amount, 'spend', reference);
    void this.api.bus.emit(EconomyEvents.Transaction, { id: tx.id, kind: tx.kind, currency, amount: amount.toString() });
    return tx;
  }

  transfer(from: string, to: string, currency: string, amount: bigint, reference: string) {
    const txs = this.store.transfer(from, to, currency, amount, 'transfer', reference);
    for (const t of txs) void this.api.bus.emit(EconomyEvents.Transaction, { id: t.id, kind: t.kind, currency });
    return txs;
  }

  history(walletId?: string) { return this.store.history(walletId); }
  verifyLedger(): boolean { return this.store.verifyLedger(); }
  ledgerRoot(): string { return this.store.ledgerRoot(); }

  // ---- marketplace passthroughs -----------------------------------------

  listAsset(input: Parameters<Marketplace['list']>[0]) {
    if (!this.marketplace) throw new EconomyError('marketplace not configured');
    return this.marketplace.list(input);
  }

  buyAsset(assetId: string, buyerOwnerId: string) {
    if (!this.marketplace) throw new EconomyError('marketplace not configured');
    const result = this.marketplace.buy(assetId, buyerOwnerId);
    void this.api.bus.emit(EconomyEvents.Purchase, { asset: assetId, buyer: buyerOwnerId, sale: result.saleId });
    return result;
  }
}

export { WalletStore, Marketplace, EconomyError };
export type { MarketplaceConfig };
