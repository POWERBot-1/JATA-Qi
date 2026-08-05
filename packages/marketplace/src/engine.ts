// MarketplaceEngine — MAZA core: storefronts, listings with inventory,
// reviews & ratings, listing search/filter, and analytics. The transactional
// layer (orders/payouts) is delegated to @jataqi/commerce — this engine
// provides the storefront/product layer only. Pure engine.

import { randomUUID } from 'node:crypto';
import type { Listing, ListingStatus, MarketplaceStats, Review, Storefront, StorefrontStatus } from './types.js';

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
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
}
