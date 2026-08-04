// Asset marketplace (§11). Listings are priced in any registered currency; on
// purchase the proceeds are split atomically into a marketplace fee, per-share
// creator royalties, and the seller's net — all recorded as ledger entries.
// License grants (personal/commercial/exclusive) are tracked per buyer.

import { randomUUID } from 'node:crypto';
import { WalletStore, EconomyError } from './wallet.js';
import type { Asset, AssetType, ListingResult, PurchaseResult, RoyaltyShare } from './types.js';

export interface MarketplaceConfig {
  /** Fraction of each sale kept by the marketplace (0..1). */
  marketplaceFeeRate: number;
  /** Optional flat listing fee charged to the seller (minor units + currency). */
  listingFee?: { currency: string; amount: bigint };
  /** Owner id that accrues marketplace fees. */
  marketplaceOwner: string;
}

export class Marketplace {
  private assets = new Map<string, Asset>();
  /** assetId -> set of ownerIds granted a license. */
  private licenses = new Map<string, Set<string>>();
  private sales: Array<{ id: string; assetId: string; buyer: string; ts: number }> = [];

  constructor(private wallets: WalletStore, private cfg: MarketplaceConfig) {
    if (cfg.marketplaceFeeRate < 0 || cfg.marketplaceFeeRate > 1) throw new EconomyError('fee rate must be in [0,1]');
    // Ensure the marketplace wallet exists.
    wallets.openWallet(cfg.marketplaceOwner, 'marketplace');
  }

  /** List an asset for sale; validates royalty shares sum to <= 1. */
  list(input: {
    title: string; type: AssetType; sellerOwnerId: string;
    price: { currency: string; amount: bigint };
    royalties?: RoyaltyShare[]; license?: Asset['license'];
  }): ListingResult {
    const totalShare = (input.royalties ?? []).reduce((s, r) => s + r.share, 0);
    if (totalShare > 1 + 1e-9) throw new EconomyError('royalty shares exceed 100%');
    if (input.price.amount < 0n) throw new EconomyError('price must be non-negative');
    const sellerWallet = this.wallets.openWallet(input.sellerOwnerId, 'creator');
    const asset: Asset = {
      id: `asset-${randomUUID()}`, title: input.title, type: input.type,
      sellerOwnerId: input.sellerOwnerId, price: input.price,
      royalties: input.royalties ?? [], license: input.license ?? 'personal',
      active: true, createdAt: Date.now(),
    };
    this.assets.set(asset.id, asset);
    let listingFeeTx: number | undefined;
    if (this.cfg.listingFee && this.cfg.listingFee.amount > 0n) {
      const tx = this.wallets.debit(sellerWallet.id, this.cfg.listingFee.currency, this.cfg.listingFee.amount, 'spend', `listing:${asset.id}`);
      listingFeeTx = tx.id;
    }
    return { asset, ...(listingFeeTx !== undefined ? { listingFeeTx } : {}) };
  }

  getAsset(id: string): Asset | undefined { return this.assets.get(id); }
  listAssets(type?: AssetType): Asset[] {
    const all = [...this.assets.values()].filter((a) => a.active);
    return type ? all.filter((a) => a.type === type) : all;
  }
  delist(id: string): boolean {
    const a = this.assets.get(id);
    if (!a) return false;
    a.active = false;
    return true;
  }

  /** Buy an asset: debit buyer, split proceeds to marketplace + creators + seller. */
  buy(assetId: string, buyerOwnerId: string): PurchaseResult {
    const asset = this.assets.get(assetId);
    if (!asset || !asset.active) throw new EconomyError(`asset ${assetId} not available`);
    const { currency, amount } = asset.price;
    if (amount === 0n) {
      // Free grant — just record the license.
      this.grantLicense(assetId, buyerOwnerId);
      return { saleId: `sale-${randomUUID()}`, asset, buyerWallet: '', split: { marketplaceFee: 0n, royalties: [], sellerNet: 0n }, transactionIds: [] };
    }
    const buyerWallet = this.wallets.openWallet(buyerOwnerId, 'player');
    // Debit buyer (throws on insufficient funds → sale aborts atomically).
    const debitTx = this.wallets.debit(buyerWallet.id, currency, amount, 'purchase', `buy:${assetId}`);

    const fee = scale(amount, this.cfg.marketplaceFeeRate);
    const remainder = amount - fee;
    const txIds: number[] = [debitTx.id];

    // Marketplace fee.
    if (fee > 0n) {
      const mw = this.wallets.openWallet(this.cfg.marketplaceOwner, 'marketplace');
      const t = this.wallets.credit(mw.id, currency, fee, 'royalty', `fee:${assetId}`);
      txIds.push(t.id);
    }

    // Royalties to creators (off the post-fee remainder).
    const royalties: Array<{ ownerId: string; amount: bigint }> = [];
    let royaltiesPaid = 0n;
    for (const r of asset.royalties) {
      const cut = scale(remainder, r.share);
      if (cut <= 0n) continue;
      const cw = this.wallets.openWallet(r.ownerId, 'creator');
      const t = this.wallets.credit(cw.id, currency, cut, 'royalty', `royalty:${assetId}:${r.ownerId}`);
      royalties.push({ ownerId: r.ownerId, amount: cut });
      txIds.push(t.id);
      royaltiesPaid += cut;
    }

    // Seller net (remainder minus royalties).
    const sellerNet = remainder - royaltiesPaid;
    if (sellerNet > 0n) {
      const sw = this.wallets.openWallet(asset.sellerOwnerId, 'creator');
      const t = this.wallets.credit(sw.id, currency, sellerNet, 'earn', `sale:${assetId}`);
      txIds.push(t.id);
    }

    this.grantLicense(assetId, buyerOwnerId);
    const saleId = `sale-${randomUUID()}`;
    this.sales.push({ id: saleId, assetId, buyer: buyerOwnerId, ts: Date.now() });
    return { saleId, asset, buyerWallet: buyerWallet.id, split: { marketplaceFee: fee, royalties, sellerNet }, transactionIds: txIds };
  }

  private grantLicense(assetId: string, owner: string): void {
    let set = this.licenses.get(assetId);
    if (!set) { set = new Set(); this.licenses.set(assetId, set); }
    set.add(owner);
  }
  hasLicense(assetId: string, owner: string): boolean { return this.licenses.get(assetId)?.has(owner) ?? false; }
  licensees(assetId: string): string[] { return [...(this.licenses.get(assetId) ?? [])]; }
  salesCount(): number { return this.sales.length; }
}

/** Scale a bigint minor-units amount by a fraction, rounding down. */
function scale(amount: bigint, fraction: number): bigint {
  if (fraction <= 0) return 0n;
  // amount * fraction, rounded to nearest minor unit.
  const scaled = Number(amount) * fraction;
  return BigInt(Math.round(scaled));
}
