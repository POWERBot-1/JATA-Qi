// JATA Qi Universal Wallet — types. One unified, double-entry wallet abstraction
// that consolidates finance.Wallet, commerce.credits, and game-economy.WalletStore
// behind a single service. Supports fiat (KES/USD/EUR/GBP), crypto (KRT, stablecoins),
// virtual currencies (reward points, store credit, game currency), coupons, gift cards,
// escrow, treasury, and multi-account/multi-ledger — all with immutable audit trails.

/** Asset class — drives accounting rules and precision. */
export type AssetClass =
  | 'fiat'          // KES, USD, EUR, GBP
  | 'crypto'        // KRT, USDT, USDC, BTC, ETH
  | 'virtual'       // reward points, store credit, game currency
  | 'coupon'        // discount coupons (face value, expiry)
  | 'gift_card'     // prepaid gift cards
  | 'escrow';       // held funds pending resolution

/** A registered currency/asset in the universal wallet system. */
export interface Currency {
  code: string;         // ISO 4217 or custom (KES, USD, KRT, POINTS, etc.)
  name: string;
  symbol: string;
  assetClass: AssetClass;
  decimals: number;     // display precision
  /** Minimum transferrable unit (in minor units). */
  minUnit: bigint;
  /** Whether this currency can be withdrawn to an external system. */
  withdrawable: boolean;
}

/** Wallet role — drives permissions and UI presentation. */
export type WalletRole = 'player' | 'creator' | 'developer' | 'marketplace' | 'treasury' | 'escrow' | 'system';

/** A wallet account holding balances across multiple currencies. */
export interface UniversalWallet {
  id: string;
  ownerId: string;
  role: WalletRole;
  orgId?: string;
  /** Currency code -> balance in minor units (bigint for exact arithmetic). */
  balances: Map<string, bigint>;
  status: 'active' | 'frozen' | 'closed';
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** Double-entry ledger entry. Every credit has a matching debit. */
export interface LedgerEntry {
  id: number;
  ts: number;
  /** 'debit' or 'credit' (from the account's perspective). */
  entryType: 'debit' | 'credit';
  walletId: string;
  currency: string;
  amount: bigint;       // always positive; sign determined by entryType
  /** The counterparty wallet (for transfers) or 'external' (for deposits/withdrawals). */
  counterpartyWalletId: string;
  /** Transaction reference linking debit+credit pairs. */
  transactionRef: string;
  /** Business category for reporting. */
  category: TxCategory;
  description: string;
  /** SHA-256 link to the previous entry (tamper-evident chain). */
  prevHash: string;
  hash: string;
  /** Optional metadata for extensibility. */
  metadata?: Record<string, unknown>;
}

export type TxCategory =
  | 'deposit' | 'withdrawal' | 'transfer' | 'payment' | 'refund'
  | 'reward' | 'fee' | 'adjustment' | 'escrow_hold' | 'escrow_release'
  | 'conversion' | 'interest' | 'penalty' | 'grant' | 'consume';

/** A grouped transaction (debit + credit pair or single-sided entry). */
export interface Transaction {
  ref: string;
  ts: number;
  category: TxCategory;
  currency: string;
  amount: bigint;
  fromWalletId: string;
  toWalletId: string;
  description: string;
  entryIds: number[];
  status: 'settled' | 'pending' | 'failed';
  metadata?: Record<string, unknown>;
}

/** Escrow hold — funds locked pending resolution. */
export interface EscrowHold {
  id: string;
  fromWalletId: string;
  toWalletId: string;
  currency: string;
  amount: bigint;
  status: 'held' | 'released' | 'refunded';
  reason: string;
  createdAt: number;
  resolvedAt?: number;
}

/** Query filter for transaction history. */
export interface TxQuery {
  walletId?: string;
  currency?: string;
  category?: TxCategory;
  fromTs?: number;
  toTs?: number;
  limit?: number;
}

/** Summary metrics for a wallet or the entire system. */
export interface WalletSummary {
  totalWallets: number;
  totalBalanceByCurrency: Record<string, bigint>;
  totalTxCount: number;
  activeEscrows: number;
}
