// MAZA — Marketplace Intelligence (Phase 7) types.

export type StorefrontStatus = 'active' | 'suspended' | 'closed';

export interface Storefront {
  id: string;
  vendorId: string;
  name: string;
  description?: string;
  /** Marketplace categories the storefront trades in. */
  categories: string[];
  status: StorefrontStatus;
  /** Aggregate rating 0..5 (computed from reviews). */
  rating: number;
  reviewCount: number;
  createdAt: number;
}

export type ListingStatus = 'listed' | 'unlisted' | 'out_of_stock' | 'archived';

export interface Listing {
  id: string;
  storefrontId: string;
  vendorId: string;
  title: string;
  description?: string;
  category: string;
  /** Price in minor units. */
  priceMinor: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** Physical stock remaining (null = digital/unlimited). */
  stock?: number;
  status: ListingStatus;
  /** Average rating of this listing (from reviews). */
  rating: number;
  reviewCount: number;
  createdAt: number;
}

export interface Review {
  id: string;
  listingId: string;
  storefrontId: string;
  reviewerId: string;
  /** 1..5 stars. */
  rating: number;
  comment?: string;
  createdAt: number;
}

export interface MarketplaceStats {
  storefronts: number;
  activeStorefronts: number;
  listings: number;
  listedListings: number;
  reviews: number;
  categories: number;
  avgListingPriceMinor?: number;
  topCategory?: { category: string; count: number };
}
