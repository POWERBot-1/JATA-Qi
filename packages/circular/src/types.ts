// KARIS LOOP — Circular Economy Platform (Phase 7) types.

export type MaterialType = 'plastic' | 'glass' | 'metal' | 'paper' | 'organic' | 'textile' | 'e_waste' | 'other';

/** A recyclable material stream. */
export interface MaterialStream {
  id: string;
  name: string;
  type: MaterialType;
  /** True when the stream is actively collected. */
  active: boolean;
  /** Carbon-equivalent saved per kg recycled (kgCO2e). */
  co2ePerKg: number;
  createdAt: number;
}

export type CollectionStatus = 'scheduled' | 'collected' | 'processed' | 'recycled' | 'diverted' | 'landfill';

export interface Collection {
  id: string;
  streamId: string;
  /** Weight collected in kg. */
  weightKg: number;
  status: CollectionStatus;
  /** Source partner / community / business. */
  source: string;
  collectedAt: number;
}

/** A product registered for take-back / end-of-life processing. */
export interface TakeBackItem {
  id: string;
  productId: string;
  productName: string;
  /** Materials the product is made of (stream ids → fraction 0..1). */
  composition: Record<string, number>;
  /** Returned by the consumer. */
  returnedBy: string;
  status: 'returned' | 'refurbished' | 'recycled' | 'disposed';
  receivedAt: number;
}

/** Circularity score for a product or an organization. */
export interface CircularityScore {
  scope: 'product' | 'organization';
  scopeId: string;
  /** 0..100 composite circularity index. */
  score: number;
  /** Share of material kept in the loop (recycled + refurbished). */
  circularRate: number;
  /** Share diverted to landfill. */
  landfillRate: number;
  totalMaterialKg: number;
  computedAt: number;
}

export interface CircularStats {
  streams: number;
  activeStreams: number;
  collections: number;
  collectedKg: number;
  recycledKg: number;
  divertedKg: number;
  landfillKg: number;
  takeBackItems: number;
  refurbishedItems: number;
  totalCo2eSavedKg: number;
  circularRate: number;
}
