// MarketplaceEngine — MAZA core: storefronts, listings with inventory,
// reviews & ratings, listing search/filter, and analytics. The transactional
// layer (orders/payouts) is delegated to @jataqi/commerce — this engine
// provides the storefront/product layer only. Pure engine.

import { randomUUID } from 'node:crypto';
import type { Cart, Listing, ListingStatus, MarketplaceStats, Order, OrderItem, OrderStatus, Payout, Review, Storefront, StorefrontStatus } from './types.js';

export interface RegisterStorefrontInput {
  vendorId: string;
  name: string;
  description?: string;
  categories?: string[];
}

export interface CreateListingInput {
  storefrontId: string;
  title: string;
  category: string;
  priceMinor: number;
  currency?: string;
  description?: string;
  stock?: number;
}

export interface ListListingsFilter {
  storefrontId?: string;
  category?: string;
  status?: ListingStatus;
  /** Keyword search against title + description. */
  query?: string;
  /** Max price (minor units). */
  maxPrice?: number;
  minRating?: number;
}

export class MarketplaceEngine {
  private storefronts = new Map<string, Storefront>();
  private listings = new Map<string, Listing>();
  private reviews = new Map<string, Review>();
  private carts = new Map<string, Cart>();
  private orders = new Map<string, Order>();
  private payouts: Payout[] = [];

  // ---- storefronts -------------------------------------------------------

  registerStorefront(input: RegisterStorefrontInput): Storefront {
    if (!input.vendorId || !input.name) throw new Error('vendorId and name are required');
    const storefront: Storefront = {
      id: randomUUID(), vendorId: input.vendorId, name: input.name,
      ...(input.description ? { description: input.description } : {}),
      categories: input.categories ?? [],
      status: 'active', rating: 0, reviewCount: 0,
      createdAt: Date.now(),
    };
    this.storefronts.set(storefront.id, storefront);
    return storefront;
  }

  getStorefront(id: string): Storefront | undefined { return this.storefronts.get(id); }

  listStorefronts(filter?: { vendorId?: string; status?: StorefrontStatus }): Storefront[] {
    return [...this.storefronts.values()].filter((s) =>
      (!filter?.vendorId || s.vendorId === filter.vendorId) &&
      (!filter?.status || s.status === filter.status));
  }

  setStorefrontStatus(id: string, status: StorefrontStatus): Storefront | undefined {
    const storefront = this.storefronts.get(id);
    if (!storefront) return undefined;
    storefront.status = status;
    return storefront;
  }

  // ---- listings ----------------------------------------------------------

  createListing(input: CreateListingInput): Listing {
    const storefront = this.storefronts.get(input.storefrontId);
    if (!storefront) throw new Error(`unknown storefront ${input.storefrontId}`);
    if (storefront.status !== 'active') throw new Error(`storefront is ${storefront.status}`);
    if (!input.title || input.priceMinor < 0) throw new Error('valid title and priceMinor are required');
    const listing: Listing = {
      id: randomUUID(),
      storefrontId: storefront.id,
      vendorId: storefront.vendorId,
      title: input.title,
      category: input.category,
      priceMinor: input.priceMinor,
      currency: input.currency ?? 'KES',
      ...(input.description ? { description: input.description } : {}),
      ...(input.stock !== undefined ? { stock: input.stock } : {}),
      status: input.stock === 0 ? 'out_of_stock' : 'listed', rating: 0, reviewCount: 0,
      createdAt: Date.now(),
    };
    this.listings.set(listing.id, listing);
    if (!storefront.categories.includes(listing.category)) storefront.categories.push(listing.category);
    return listing;
  }

  getListing(id: string): Listing | undefined { return this.listings.get(id); }

  listListings(filter: ListListingsFilter = {}): Listing[] {
    const q = filter.query?.trim().toLowerCase();
    return [...this.listings.values()].filter((l) =>
      (!filter.storefrontId || l.storefrontId === filter.storefrontId) &&
      (!filter.category || l.category === filter.category) &&
      (!filter.status || l.status === filter.status) &&
      (filter.maxPrice === undefined || l.priceMinor <= filter.maxPrice) &&
      (filter.minRating === undefined || l.rating >= filter.minRating) &&
      (!q || `${l.title} ${l.description ?? ''}`.toLowerCase().includes(q)));
  }

  setListingStatus(id: string, status: ListingStatus): Listing | undefined {
    const listing = this.listings.get(id);
    if (!listing) return undefined;
    listing.status = status;
    return listing;
  }

  /** Adjust stock; auto-flips status to out_of_stock at zero. */
  adjustStock(id: string, delta: number): Listing | undefined {
    const listing = this.listings.get(id);
    if (!listing) return undefined;
    if (listing.stock === undefined) throw new Error('listing has unlimited (digital) stock');
    const next = listing.stock + delta;
    if (next < 0) throw new Error('stock cannot go negative');
    listing.stock = next;
    if (next === 0 && listing.status === 'listed') listing.status = 'out_of_stock';
    if (next > 0 && listing.status === 'out_of_stock') listing.status = 'listed';
    return listing;
  }

  // ---- reviews -----------------------------------------------------------

  addReview(input: { listingId: string; reviewerId: string; rating: number; comment?: string }): Review {
    const listing = this.listings.get(input.listingId);
    if (!listing) throw new Error(`unknown listing ${input.listingId}`);
    if (input.rating < 1 || input.rating > 5) throw new Error('rating must be 1..5');
    const review: Review = {
      id: randomUUID(), listingId: listing.id, storefrontId: listing.storefrontId,
      reviewerId: input.reviewerId, rating: input.rating,
      ...(input.comment ? { comment: input.comment } : {}),
      createdAt: Date.now(),
    };
    this.reviews.set(review.id, review);
    // Recompute listing + storefront aggregates.
    const listingReviews = this.reviewsForListing(listing.id);
    listing.rating = avg(listingReviews.map((r) => r.rating));
    listing.reviewCount = listingReviews.length;
    const storefront = this.storefronts.get(listing.storefrontId);
    if (storefront) {
      const sfReviews = [...this.reviews.values()].filter((r) => r.storefrontId === storefront.id);
      storefront.rating = avg(sfReviews.map((r) => r.rating));
      storefront.reviewCount = sfReviews.length;
    }
    return review;
  }

  getReview(id: string): Review | undefined { return this.reviews.get(id); }
  reviewsForListing(listingId: string): Review[] {
    return [...this.reviews.values()].filter((r) => r.listingId === listingId);
  }
  reviewsForStorefront(storefrontId: string): Review[] {
    return [...this.reviews.values()].filter((r) => r.storefrontId === storefrontId);
  }

  // ---- analytics ---------------------------------------------------------

  categories(): string[] {
    const set = new Set<string>();
    for (const s of this.storefronts.values()) for (const c of s.categories) set.add(c);
    return [...set].sort();
  }

  stats(): MarketplaceStats {
    const all = [...this.listings.values()];
    const listed = all.filter((l) => l.status === 'listed');
    const priced = listed.filter((l) => l.priceMinor > 0);
    const byCategory = new Map<string, number>();
    for (const l of listed) byCategory.set(l.category, (byCategory.get(l.category) ?? 0) + 1);
    let topCategory: { category: string; count: number } | undefined;
    for (const [category, count] of byCategory) {
      if (!topCategory || count > topCategory.count) topCategory = { category, count };
    }
    return {
      storefronts: this.storefronts.size,
      activeStorefronts: this.listStorefronts({ status: 'active' }).length,
      listings: all.length,
      listedListings: listed.length,
      reviews: this.reviews.size,
      categories: byCategory.size,
      ...(priced.length > 0 ? { avgListingPriceMinor: Math.round(priced.reduce((s, l) => s + l.priceMinor, 0) / priced.length) } : {}),
      ...(topCategory ? { topCategory } : {}),
    };
  }
// ---- MAZA purchase flows: carts → checkout → orders → payouts -------------

  // ---- carts -------------------------------------------------------------

  createCart(buyerId: string): Cart {
    if (!buyerId) throw new Error('buyerId is required');
    const existing = this.getCartForBuyer(buyerId);
    if (existing) return existing;
    const cart: Cart = {
      id: randomUUID(), buyerId, items: [], totalMinor: 0, currency: 'KES',
      updatedAt: Date.now(), createdAt: Date.now(),
    };
    this.carts.set(cart.id, cart);
    return cart;
  }

  getCart(id: string): Cart | undefined { return this.carts.get(id); }

  getCartForBuyer(buyerId: string): Cart | undefined {
    return [...this.carts.values()].find((c) => c.buyerId === buyerId);
  }

  addToCart(cartId: string, listingId: string, quantity = 1): Cart {
    if (quantity < 1) throw new Error('quantity must be >= 1');
    const cart = this.carts.get(cartId);
    if (!cart) throw new Error(`unknown cart ${cartId}`);
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error(`unknown listing ${listingId}`);
    if (listing.status !== 'listed') throw new Error(`listing is ${listing.status}`);
    if (listing.stock !== undefined && listing.stock < quantity) throw new Error(`only ${listing.stock} in stock`);
    const existing = cart.items.find((i) => i.listingId === listingId);
    if (existing) {
      const nextQty = existing.quantity + quantity;
      if (listing.stock !== undefined && listing.stock < nextQty) throw new Error(`only ${listing.stock} in stock`);
      existing.quantity = nextQty;
    } else {
      cart.items.push({
        listingId, title: listing.title, vendorId: listing.vendorId,
        storefrontId: listing.storefrontId, priceMinor: listing.priceMinor,
        currency: listing.currency, quantity,
      });
    }
    this.recomputeCart(cart);
    return cart;
  }

  removeFromCart(cartId: string, listingId: string): Cart {
    const cart = this.carts.get(cartId);
    if (!cart) throw new Error(`unknown cart ${cartId}`);
    cart.items = cart.items.filter((i) => i.listingId !== listingId);
    this.recomputeCart(cart);
    return cart;
  }

  clearCart(cartId: string): Cart {
    const cart = this.carts.get(cartId);
    if (!cart) throw new Error(`unknown cart ${cartId}`);
    cart.items = [];
    cart.totalMinor = 0;
    cart.updatedAt = Date.now();
    return cart;
  }

  private recomputeCart(cart: Cart): void {
    if (cart.items.length === 0) {
      cart.totalMinor = 0;
      cart.currency = 'KES';
    } else {
      const first = cart.items[0]!;
      cart.currency = first.currency;
      cart.totalMinor = cart.items.reduce((s, i) => s + i.priceMinor * i.quantity, 0);
    }
    cart.updatedAt = Date.now();
  }

  // ---- checkout + orders -------------------------------------------------

  /**
   * Checkout a cart: validates availability + stock, decrements inventory,
   * creates a paid order, and generates per-vendor payouts (5% commission).
   * Returns the order and clears the cart.
   */
  checkout(cartId: string): { order: Order; cart: Cart } {
    const cart = this.carts.get(cartId);
    if (!cart) throw new Error(`unknown cart ${cartId}`);
    if (cart.items.length === 0) throw new Error('cart is empty');
    const items: OrderItem[] = [];
    for (const item of cart.items) {
      const listing = this.listings.get(item.listingId);
      if (!listing) throw new Error(`unknown listing ${item.listingId}`);
      if (listing.status !== 'listed') throw new Error(`listing "${listing.title}" is ${listing.status}`);
      if (listing.stock !== undefined && listing.stock < item.quantity) {
        throw new Error(`only ${listing.stock} of "${listing.title}" in stock`);
      }
      if (listing.stock !== undefined) this.adjustStock(listing.id, -item.quantity);
      items.push({
        listingId: listing.id, title: listing.title, vendorId: listing.vendorId,
        storefrontId: listing.storefrontId, priceMinor: listing.priceMinor,
        currency: listing.currency, quantity: item.quantity,
        lineTotalMinor: listing.priceMinor * item.quantity,
      });
    }
    const totalMinor = items.reduce((s, i) => s + i.lineTotalMinor, 0);
    const order: Order = {
      id: randomUUID(), buyerId: cart.buyerId, items,
      totalMinor, currency: cart.currency, status: 'paid',
      commissionMinor: Math.round(totalMinor * 0.05),
      createdAt: Date.now(), paidAt: Date.now(),
    };
    this.orders.set(order.id, order);
    // Payouts per vendor line.
    for (const item of items) {
      const gross = item.lineTotalMinor;
      const commission = Math.round(gross * 0.05);
      this.payouts.push({
        id: randomUUID(), vendorId: item.vendorId, orderId: order.id,
        orderCreatedAt: order.createdAt, amountMinor: gross, currency: item.currency,
        commissionMinor: commission, netMinor: gross - commission,
        status: 'pending', createdAt: Date.now(),
      });
    }
    this.clearCart(cart.id);
    return { order, cart };
  }

  /** Backward-compat single-listing purchase → full order + payout. */
  quickPurchase(listingId: string, buyerId: string): Order {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error(`unknown listing ${listingId}`);
    if (listing.status !== 'listed') throw new Error(`listing is ${listing.status}`);
    if (listing.stock !== undefined && listing.stock < 1) throw new Error('listing is out of stock');
    if (listing.stock !== undefined) this.adjustStock(listing.id, -1);
    const order: Order = {
      id: randomUUID(), buyerId, listingId,
      items: [{
        listingId: listing.id, title: listing.title, vendorId: listing.vendorId,
        storefrontId: listing.storefrontId, priceMinor: listing.priceMinor,
        currency: listing.currency, quantity: 1, lineTotalMinor: listing.priceMinor,
      }],
      totalMinor: listing.priceMinor, currency: listing.currency, status: 'paid',
      commissionMinor: Math.round(listing.priceMinor * 0.05),
      createdAt: Date.now(), paidAt: Date.now(),
    };
    this.orders.set(order.id, order);
    this.payouts.push({
      id: randomUUID(), vendorId: listing.vendorId, orderId: order.id,
      orderCreatedAt: order.createdAt, amountMinor: listing.priceMinor,
      currency: listing.currency, commissionMinor: order.commissionMinor,
      netMinor: listing.priceMinor - order.commissionMinor,
      status: 'pending', createdAt: Date.now(),
    });
    return order;
  }

  getOrder(id: string): Order | undefined { return this.orders.get(id); }

  listOrders(filter?: { buyerId?: string; vendorId?: string; status?: OrderStatus }): Order[] {
    return [...this.orders.values()].filter((o) =>
      (!filter?.buyerId || o.buyerId === filter.buyerId) &&
      (!filter?.status || o.status === filter.status) &&
      (!filter?.vendorId || o.items.some((i) => i.vendorId === filter.vendorId)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Cancel a pending order (restores stock). */
  cancelOrder(orderId: string, buyerId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    if (order.buyerId !== buyerId) throw new Error('order belongs to another buyer');
    if (order.status !== 'pending') throw new Error(`order is ${order.status} — only pending orders can be cancelled`);
    for (const item of order.items) {
      const listing = this.listings.get(item.listingId);
      if (listing?.stock !== undefined) this.adjustStock(listing.id, item.quantity);
    }
    order.status = 'cancelled';
    order.cancelledAt = Date.now();
    return order;
  }

  /** Refund a paid order (restores stock, voids pending payouts). */
  refundOrder(orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    if (order.status !== 'paid') throw new Error(`order is ${order.status} — only paid orders can be refunded`);
    for (const item of order.items) {
      const listing = this.listings.get(item.listingId);
      if (listing?.stock !== undefined) this.adjustStock(listing.id, item.quantity);
    }
    order.status = 'refunded';
    order.refundedAt = Date.now();
    for (const payout of this.payouts) {
      if (payout.orderId === order.id && payout.status === 'pending') {
        payout.status = 'paid'; // voided: mark settled so it drops out of pending
        payout.netMinor = 0;
        payout.commissionMinor = 0;
      }
    }
    return order;
  }

  // ---- payouts -----------------------------------------------------------

  listPayouts(vendorId?: string, status?: Payout['status']): Payout[] {
    return this.payouts.filter((p) =>
      (!vendorId || p.vendorId === vendorId) &&
      (!status || p.status === status));
  }

  markPayoutPaid(id: string): Payout | undefined {
    const payout = this.payouts.find((p) => p.id === id);
    if (!payout) return undefined;
    payout.status = 'paid';
    return payout;
  }

  /** Aggregate order analytics (additive to stats()). */
  orderAnalytics(): { orders: number; gmvMinor: number; commissionMinor: number; pendingPayoutsMinor: number } {
    const paid = [...this.orders.values()].filter((o) => o.status === 'paid');
    return {
      orders: this.orders.size,
      gmvMinor: paid.reduce((s, o) => s + o.totalMinor, 0),
      commissionMinor: paid.reduce((s, o) => s + o.commissionMinor, 0),
      pendingPayoutsMinor: this.payouts.filter((p) => p.status === 'pending').reduce((s, p) => s + p.netMinor, 0),
    };
  }

}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
}
