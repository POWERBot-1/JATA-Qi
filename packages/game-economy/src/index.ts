// @jataqi/game-economy — NOVA Game Economy + Marketplace (§10/§11). Public API.

export { GameEconomyModule, EconomyEvents } from './economy.js';
export type { GameEconomyConfig } from './economy.js';
export { WalletStore, EconomyError } from './wallet.js';
export { Marketplace } from './marketplace.js';
export type { MarketplaceConfig } from './marketplace.js';
export type {
  Currency, CurrencyKind, Wallet, WalletKind, Transaction, TxKind,
  Asset, AssetType, RoyaltyShare, PurchaseResult, ListingResult,
} from './types.js';
