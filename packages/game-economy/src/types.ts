// NOVA Game Economy — types (section 10). Virtual currencies, the four wallet
// kinds (player / creator / developer / marketplace), an immutable transaction
// ledger, and a royalty-paying asset marketplace (section 11).

/** Currency class. */
export type CurrencyKind = 'soft' | 'premium' | 'hard';

export interface Currency {
  id: string;
  name: string;
  symbol: string;
  kind: CurrencyKind;
  /** Decimal places for display/rounding. */
  decimals: number;
  /** Soft currencies cannot be purchased with hard currency. */
  purchasable: boolean;
}

/** The four wallet roles per §10. */
export type WalletKind = 'player' | 'creator' | 'developer' | 'marketplace';

export interface Wallet {
  id: string;
  ownerId: string;
  kind: WalletKind;
  /** currencyId -> integer minor units (to avoid float drift). */
  balances: Map<string, bigint>;
  createdAt: number;
}

export type TxKind = 'earn' | 'spend' | 'transfer' | 'royalty' | 'purchase' | 'refund' | 'mint' | 'burn';

/** An immutable ledger entry. */
export interface Transaction {
  id: number;
  ts: number;
  kind: TxKind;
  currency: string;
  /** Minor units (can be negative for the debit side). */
  amount: bigint;
  fromWallet?: string;
  toWallet?: string;
  reference: string;
  /** SHA-256 link to the previous entry (tamper-evident chain). */
  prevHash: string;
  /** Hash of this entry's canonical form. */
  hash: string;
}

export type AssetType = 'character' | 'map' | 'weapon' | 'vehicle' | 'animation' | 'music' | 'sfx' | 'code' | 'game' | 'bundle';

export interface Asset {
  id: string;
  title: string;
  type: AssetType;
  sellerOwnerId: string;
  price: { currency: string; amount: bigint }; // minor units
  /** Royalty recipients and their share (0..1), summing to <= 1. */
  royalties: RoyaltyShare[];
  /** License granted on purchase. */
  license: 'personal' | 'commercial' | 'exclusive';
  active: boolean;
  createdAt: number;
}

export interface RoyaltyShare { ownerId: string; share: number; label?: string }

export interface PurchaseResult {
  saleId: string;
  asset: Asset;
  buyerWallet: string;
  /** Breakdown of the purchase amount. */
  split: { marketplaceFee: bigint; royalties: Array<{ ownerId: string; amount: bigint }>; sellerNet: bigint };
  transactionIds: number[];
}

/** Marketplace listing result. */
export interface ListingResult { asset: Asset; listingFeeTx?: number }
