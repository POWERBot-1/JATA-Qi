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

// ---- MAZA purchase flows (cart → checkout → orders → payouts) -------------

export interface CartItem {
  listingId: string;
  title: string;
  vendorId: string;
  storefrontId: string;
  priceMinor: number;
  currency: string;
  quantity: number;
}

export interface Cart {
  id: string;
  buyerId: string;
  items: CartItem[];
  totalMinor: number;
  currency: string;
  updatedAt: number;
  createdAt: number;
}

export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'refunded';

export interface OrderItem {
  listingId: string;
  title: string;
  vendorId: string;
  storefrontId: string;
  priceMinor: number;
  currency: string;
  quantity: number;
  lineTotalMinor: number;
}

export interface Order {
  id: string;
  buyerId: string;
  items: OrderItem[];
  totalMinor: number;
  currency: string;
  status: OrderStatus;
  /** 5% platform commission (minor units, per seller). */
  commissionMinor: number;
  createdAt: number;
  paidAt?: number;
  cancelledAt?: number;
  refundedAt?: number;
  /** Backward-compat: quick purchases land here too. */
  listingId?: string;
}

export interface Payout {
  id: string;
  vendorId: string;
  orderId: string;
  orderCreatedAt: number;
  /** Gross seller share before commission. */
  amountMinor: number;
  currency: string;
  commissionMinor: number;
  netMinor: number;
  status: 'pending' | 'paid';
  createdAt: number;
}
