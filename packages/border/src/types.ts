// KARIS BORDER X — Border Security Intelligence (Phase 7) types.

export interface BorderPost {
  id: string;
  name: string;
  /** Two-letter country codes for the crossing, e.g. 'KE-UG'. */
  crossing: string;
  location?: string;
  status: 'open' | 'closed' | 'restricted';
  createdAt: number;
}

export type CrossingMode = 'road' | 'rail' | 'air' | 'sea' | 'foot';
export type Clearance = 'cleared' | 'referred' | 'denied';

export interface Crossing {
  id: string;
  postId: string;
  travelerId: string;
  travelerName: string;
  /** Passport / national ID number. */
  documentNo: string;
  mode: CrossingMode;
  direction: 'inbound' | 'outbound';
  clearance: Clearance;
  /** Reason when not cleared. */
  reason?: string;
  crossedAt: number;
}

export type ManifestStatus = 'declared' | 'inspected' | 'cleared' | 'held';

export interface CargoManifest {
  id: string;
  postId: string;
  reference: string;
  consignor: string;
  consignee: string;
  /** Cargo description. */
  description: string;
  weightKg: number;
  status: ManifestStatus;
  declaredAt: number;
  /** Flagged for inspection by risk rules. */
  flagged: boolean;
}

export interface WatchlistEntry {
  id: string;
  name: string;
  documentNo: string;
  category: 'person' | 'vehicle' | 'organization';
  reason: string;
  active: boolean;
  createdAt: number;
}

export interface BorderStats {
  posts: number;
  postsOpen: number;
  crossings: number;
  cleared: number;
  referred: number;
  denied: number;
  manifests: number;
  inspected: number;
  held: number;
  watchlistEntries: number;
}
