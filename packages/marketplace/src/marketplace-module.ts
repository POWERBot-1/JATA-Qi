// MarketplaceModule — MAZA kernel module. Wraps the engine, emits bus
// events, records listing/review milestones into the Digital Memory Engine,
// and composes @jataqi/commerce for purchases when present (additive —
// the engine works without it).

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import type { CommerceModule } from '@jataqi/commerce';
import { MarketplaceEngine, type CreateListingInput, type ListListingsFilter, type RegisterStorefrontInput } from './engine.js';
import type { Listing, ListingStatus, MarketplaceStats, Review, Storefront, StorefrontStatus } from './types.js';

export const MarketplaceEvents = Object.freeze({
  StorefrontRegistered: 'marketplace.storefront.registered',
  ListingCreated: 'marketplace.listing.created',
  ListingStatusChanged: 'marketplace.listing.status_changed',
  ReviewAdded: 'marketplace.review.added',
  PurchaseCompleted: 'marketplace.purchase.completed',
} as const);

export class MarketplaceModule implements IModule {
  readonly id = 'marketplace';
  readonly tags = ['core', 'marketplace', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  private commerce?: CommerceModule;
  readonly engine = new MarketplaceEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('marketplace', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    this.commerce = this.tryModule<CommerceModule>('commerce');
    kernel.logger.info('marketplace module initialized (MAZA)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- storefronts -------------------------------------------------------

  registerStorefront(input: RegisterStorefrontInput): Storefront {
    const storefront = this.engine.registerStorefront(input);
    void this.api.bus.emit(MarketplaceEvents.StorefrontRegistered, { id: storefront.id, vendorId: storefront.vendorId });
    return storefront;
  }
  getStorefront(id: string): Storefront | undefined { return this.engine.getStorefront(id); }
  listStorefronts(filter?: { vendorId?: string; status?: StorefrontStatus }): Storefront[] {
    return this.engine.listStorefronts(filter);
  }
  setStorefrontStatus(id: string, status: StorefrontStatus): Storefront | undefined {
    return this.engine.setStorefrontStatus(id, status);
  }

  // ---- listings ----------------------------------------------------------

  async createListing(input: CreateListingInput): Promise<Listing> {
    const listing = this.engine.createListing(input);
    void this.api.bus.emit(MarketplaceEvents.ListingCreated, { id: listing.id, storefrontId: listing.storefrontId });
    await this.recordMemory('marketplace_listing', `listing "${listing.title}" created (${listing.priceMinor} ${listing.currency})`, {
      listingId: listing.id, storefrontId: listing.storefrontId, category: listing.category,
    });
    return listing;
  }
  getListing(id: string): Listing | undefined { return this.engine.getListing(id); }
  listListings(filter?: ListListingsFilter): Listing[] { return this.engine.listListings(filter); }

  async setListingStatus(id: string, status: ListingStatus): Promise<Listing | undefined> {
    const listing = this.engine.setListingStatus(id, status);
    if (listing) {
      void this.api.bus.emit(MarketplaceEvents.ListingStatusChanged, { id: listing.id, status: listing.status });
      await this.recordMemory('marketplace_listing', `listing "${listing.title}" → ${listing.status}`, {
        listingId: listing.id, status: listing.status,
      });
    }
    return listing;
  }
  adjustStock(id: string, delta: number): Listing | undefined { return this.engine.adjustStock(id, delta); }

  // ---- reviews -----------------------------------------------------------

  async addReview(input: { listingId: string; reviewerId: string; rating: number; comment?: string }): Promise<Review> {
    const review = this.engine.addReview(input);
    void this.api.bus.emit(MarketplaceEvents.ReviewAdded, { id: review.id, listingId: review.listingId, rating: review.rating });
    await this.recordMemory('marketplace_review', `review ${review.rating}★ on listing ${review.listingId}`, {
      reviewId: review.id, listingId: review.listingId, rating: review.rating,
    });
    return review;
  }
  reviewsForListing(listingId: string): Review[] { return this.engine.reviewsForListing(listingId); }
  reviewsForStorefront(storefrontId: string): Review[] { return this.engine.reviewsForStorefront(storefrontId); }

  // ---- commerce bridge ---------------------------------------------------

  /**
   * Purchase a listing through @jataqi/commerce when available. Returns the
   * commerce order; falls back to a local record when commerce is absent.
   */
  async purchase(listingId: string, buyerId: string): Promise<{ ok: boolean; orderId?: string; error?: string }> {
    const listing = this.engine.getListing(listingId);
    if (!listing) return { ok: false, error: 'listing not found' };
    if (listing.status === 'unlisted' || listing.status === 'archived') return { ok: false, error: `listing is ${listing.status}` };
    if (listing.stock === 0) return { ok: false, error: 'listing is out of stock' };
    if (this.commerce) {
      try {
        const item = await this.commerce.listItem({
          name: listing.title,
          sellerId: listing.vendorId,
          price: { amount: listing.priceMinor, currency: listing.currency },
          platformCommissionPct: 5,
          pricingModel: 'ONE_TIME',
        });
        const result = await this.commerce.purchase(buyerId, item, { currency: listing.currency });
        if (listing.stock !== undefined) this.engine.adjustStock(listing.id, -1);
        void this.api.bus.emit(MarketplaceEvents.PurchaseCompleted, { listingId, buyerId, orderId: result.order.id });
        await this.recordMemory('marketplace_purchase', `purchase of "${listing.title}" by ${buyerId}`, {
          listingId, buyerId, orderId: result.order.id,
        });
        return { ok: true, orderId: result.order.id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    // Local fallback (no commerce module).
    if (listing.stock !== undefined) this.engine.adjustStock(listing.id, -1);
    void this.api.bus.emit(MarketplaceEvents.PurchaseCompleted, { listingId, buyerId });
    await this.recordMemory('marketplace_purchase', `purchase of "${listing.title}" by ${buyerId} (local)`, { listingId, buyerId });
    return { ok: true };
  }

  // ---- analytics ---------------------------------------------------------

  categories(): string[] { return this.engine.categories(); }
  stats(): MarketplaceStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['marketplace', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
