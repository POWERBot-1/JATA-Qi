// @jataqi/universal-wallet — JATA Qi Universal Wallet (Phase 2 consolidation).
// Public API.

export { UniversalWalletModule, WalletEvents } from './wallet-module.js';
export { WalletEngine, WalletError, DEFAULT_CURRENCIES } from './wallet-engine.js';
export { DoubleEntryLedger, hashEntry } from './ledger.js';
export { FinanceAdapter, CommerceCreditsAdapter, GameEconomyAdapter } from './adapters.js';
export type {
  AssetClass, Currency, WalletRole, UniversalWallet, LedgerEntry, TxCategory,
  Transaction, EscrowHold, TxQuery, WalletSummary,
} from './types.js';
