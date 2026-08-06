// MarketplaceModule — MAZA kernel module. Wraps the engine, emits bus
// events, records listing/review milestones into the Digital Memory Engine,
// and composes @jataqi/commerce for purchases when present (additive —
// the engine works without it).

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import type { CommerceModule } from '@jataqi/commerce';
import { MarketplaceEngine, type CreateListingInput, type ListListingsFilter, type RegisterStorefrontInput } from './engine.js';
import type { Cart, Listing, ListingStatus, MarketplaceStats, Order, OrderStatus, Payout, Review, Storefront, StorefrontStatus } from './types.js';

export const MarketplaceEvents = Object.freeze({
  StorefrontRegistered: 'marketplace.storefront.registered',
  ListingCreated: 'marketplace.listing.created',
  ListingStatusChanged: 'marketplace.listing.status_changed',
  ReviewAdded: 'marketplace.review.added',
  PurchaseCompleted: 'marketplace.purchase.completed',
  OrderCreated: 'marketplace.order.created',
  OrderPaid: 'marketplace.order.paid',
  OrderCancelled: 'marketplace.order.cancelled',
  OrderRefunded: 'marketplace.order.refunded',
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

  // ---- MAZA purchase flows ------------------------------------------------

  createCart(buyerId: string): Cart {
    return this.engine.createCart(buyerId);
  }
  getCart(id: string): Cart | undefined { return this.engine.getCart(id); }
  getCartForBuyer(buyerId: string): Cart | undefined { return this.engine.getCartForBuyer(buyerId); }

  async addToCart(cartId: string, listingId: string, quantity = 1): Promise<Cart> {
    const cart = this.engine.addToCart(cartId, listingId, quantity);
    await this.recordMemory('marketplace_cart', `added listing ${listingId} ×${quantity} to cart`, {
      cartId, listingId, quantity,
    });
    return cart;
  }
  removeFromCart(cartId: string, listingId: string): Cart { return this.engine.removeFromCart(cartId, listingId); }
  clearCart(cartId: string): Cart { return this.engine.clearCart(cartId); }

  /**
   * Checkout a cart → paid order + per-vendor payouts. Emits
   * marketplace.order.created / marketplace.order.paid and records memory.
   */
  async checkout(cartId: string): Promise<Order> {
    const { order } = this.engine.checkout(cartId);
    void this.api.bus.emit(MarketplaceEvents.OrderCreated, { id: order.id, buyerId: order.buyerId, totalMinor: order.totalMinor, currency: order.currency });
    void this.api.bus.emit(MarketplaceEvents.OrderPaid, { id: order.id, buyerId: order.buyerId, totalMinor: order.totalMinor });
    await this.recordMemory('marketplace_order', `checkout ${order.currency} ${order.totalMinor} (${order.items.length} item(s)) by ${order.buyerId}`, {
      orderId: order.id, buyerId: order.buyerId, totalMinor: order.totalMinor,
    });
    return order;
  }

  async quickPurchase(listingId: string, buyerId: string): Promise<Order> {
    const order = this.engine.quickPurchase(listingId, buyerId);
    void this.api.bus.emit(MarketplaceEvents.OrderCreated, { id: order.id, buyerId: order.buyerId, listingId });
    void this.api.bus.emit(MarketplaceEvents.OrderPaid, { id: order.id, buyerId: order.buyerId, listingId });
    await this.recordMemory('marketplace_purchase', `quick purchase of listing ${listingId} by ${buyerId}`, {
      orderId: order.id, listingId, buyerId,
    });
    return order;
  }

  getOrder(id: string): Order | undefined { return this.engine.getOrder(id); }
  listOrders(filter?: { buyerId?: string; vendorId?: string; status?: OrderStatus }): Order[] {
    return this.engine.listOrders(filter);
  }

  async cancelOrder(orderId: string, buyerId: string): Promise<Order> {
    const order = this.engine.cancelOrder(orderId, buyerId);
    void this.api.bus.emit(MarketplaceEvents.OrderCancelled, { id: order.id, buyerId });
    await this.recordMemory('marketplace_order', `order ${order.id} cancelled (restocked)`, { orderId: order.id });
    return order;
  }

  async refundOrder(orderId: string): Promise<Order> {
    const order = this.engine.refundOrder(orderId);
    void this.api.bus.emit(MarketplaceEvents.OrderRefunded, { id: order.id, buyerId: order.buyerId });
    await this.recordMemory('marketplace_order', `order ${order.id} refunded (restocked, payouts voided)`, { orderId: order.id });
    return order;
  }

  listPayouts(vendorId?: string, status?: Payout['status']): Payout[] {
    return this.engine.listPayouts(vendorId, status);
  }
  markPayoutPaid(id: string): Payout | undefined { return this.engine.markPayoutPaid(id); }

  orderAnalytics(): { orders: number; gmvMinor: number; commissionMinor: number; pendingPayoutsMinor: number } {
    return this.engine.orderAnalytics();
  }
}
