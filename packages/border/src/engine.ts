// BorderEngine — KARIS BORDER X core: border posts, traveler crossings with
// watchlist screening, cargo manifests with risk flagging, inspections.
// Pure engine.

import { randomUUID } from 'node:crypto';
import type {
  BorderPost, BorderStats, CargoManifest, Clearance, Crossing, CrossingMode,
  ManifestStatus, WatchlistEntry,
} from './types.js';

export interface RegisterPostInput {
  name: string;
  crossing: string;
  location?: string;
}

export interface ProcessCrossingInput {
  postId: string;
  travelerId: string;
  travelerName: string;
  documentNo: string;
  mode: CrossingMode;
  direction: 'inbound' | 'outbound';
}

export interface DeclareManifestInput {
  postId: string;
  reference: string;
  consignor: string;
  consignee: string;
  description: string;
  weightKg: number;
}

export class BorderEngine {
  private posts = new Map<string, BorderPost>();
  private crossings = new Map<string, Crossing>();
  private manifests = new Map<string, CargoManifest>();
  private watchlist = new Map<string, WatchlistEntry>();

  // ---- posts -------------------------------------------------------------

  registerPost(input: RegisterPostInput): BorderPost {
    if (!input.name || !input.crossing) throw new Error('name and crossing are required');
    const post: BorderPost = {
      id: randomUUID(), name: input.name, crossing: input.crossing.toUpperCase(),
      ...(input.location ? { location: input.location } : {}),
      status: 'open', createdAt: Date.now(),
    };
    this.posts.set(post.id, post);
    return post;
  }

  getPost(id: string): BorderPost | undefined { return this.posts.get(id); }
  listPosts(status?: BorderPost['status']): BorderPost[] {
    const all = [...this.posts.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  setPostStatus(id: string, status: BorderPost['status']): BorderPost | undefined {
    const post = this.posts.get(id);
    if (!post) return undefined;
    post.status = status;
    return post;
  }

  // ---- watchlist ---------------------------------------------------------

  addWatchlist(input: { name: string; documentNo: string; category: WatchlistEntry['category']; reason: string }): WatchlistEntry {
    if (!input.name || !input.documentNo) throw new Error('name and documentNo are required');
    const entry: WatchlistEntry = {
      id: randomUUID(), name: input.name, documentNo: input.documentNo,
      category: input.category, reason: input.reason, active: true, createdAt: Date.now(),
    };
    this.watchlist.set(entry.id, entry);
    return entry;
  }

  listWatchlist(activeOnly?: boolean): WatchlistEntry[] {
    const all = [...this.watchlist.values()];
    return activeOnly ? all.filter((e) => e.active) : all;
  }

  setWatchlistActive(id: string, active: boolean): WatchlistEntry | undefined {
    const entry = this.watchlist.get(id);
    if (!entry) return undefined;
    entry.active = active;
    return entry;
  }

  /** Screening: any active watchlist match on document number or name. */
  screen(documentNo: string, name?: string): WatchlistEntry[] {
    const doc = documentNo.trim().toLowerCase();
    const nm = name?.trim().toLowerCase();
    return this.listWatchlist(true).filter((e) =>
      e.documentNo.toLowerCase() === doc || (nm !== undefined && e.name.toLowerCase() === nm));
  }

  // ---- crossings ---------------------------------------------------------

  processCrossing(input: ProcessCrossingInput): Crossing {
    const post = this.posts.get(input.postId);
    if (!post) throw new Error(`unknown post ${input.postId}`);
    if (post.status !== 'open') throw new Error(`post ${post.name} is ${post.status}`);
    const matches = this.screen(input.documentNo, input.travelerName);
    let clearance: Clearance = 'cleared';
    let reason: string | undefined;
    if (matches.length > 0) {
      clearance = 'referred';
      reason = `watchlist match: ${matches.map((m) => m.reason).join('; ')}`;
    }
    const crossing: Crossing = {
      id: randomUUID(), postId: input.postId,
      travelerId: input.travelerId, travelerName: input.travelerName,
      documentNo: input.documentNo, mode: input.mode, direction: input.direction,
      clearance, ...(reason ? { reason } : {}), crossedAt: Date.now(),
    };
    this.crossings.set(crossing.id, crossing);
    return crossing;
  }

  getCrossing(id: string): Crossing | undefined { return this.crossings.get(id); }

  listCrossings(filter?: { postId?: string; clearance?: Clearance; direction?: Crossing['direction'] }): Crossing[] {
    return [...this.crossings.values()].filter((c) =>
      (!filter?.postId || c.postId === filter.postId) &&
      (!filter?.clearance || c.clearance === filter.clearance) &&
      (!filter?.direction || c.direction === filter.direction));
  }

  /** Escalate/override a crossing decision (officer review). */
  overrideClearance(id: string, clearance: Clearance, reason?: string): Crossing | undefined {
    const crossing = this.crossings.get(id);
    if (!crossing) return undefined;
    crossing.clearance = clearance;
    if (reason) crossing.reason = reason;
    return crossing;
  }

  // ---- manifests ---------------------------------------------------------

  declareManifest(input: DeclareManifestInput): CargoManifest {
    const post = this.posts.get(input.postId);
    if (!post) throw new Error(`unknown post ${input.postId}`);
    if (input.weightKg < 0) throw new Error('weightKg must be non-negative');
    const manifest: CargoManifest = {
      id: randomUUID(), postId: input.postId, reference: input.reference,
      consignor: input.consignor, consignee: input.consignee,
      description: input.description, weightKg: input.weightKg,
      status: 'declared', declaredAt: Date.now(), flagged: false,
    };
    // Simple risk heuristic: oversized or vaguely-described cargo gets flagged.
    if (input.weightKg > 10_000 || input.description.trim().toLowerCase() === 'general goods') {
      manifest.flagged = true;
      manifest.status = 'inspected';
    }
    this.manifests.set(manifest.id, manifest);
    return manifest;
  }

  getManifest(id: string): CargoManifest | undefined { return this.manifests.get(id); }
  getManifestByRef(ref: string): CargoManifest | undefined {
    return [...this.manifests.values()].find((m) => m.reference === ref);
  }

  listManifests(filter?: { postId?: string; status?: ManifestStatus; flagged?: boolean }): CargoManifest[] {
    return [...this.manifests.values()].filter((m) =>
      (!filter?.postId || m.postId === filter.postId) &&
      (!filter?.status || m.status === filter.status) &&
      (filter?.flagged === undefined || m.flagged === filter.flagged));
  }

  updateManifestStatus(id: string, status: ManifestStatus): CargoManifest | undefined {
    const manifest = this.manifests.get(id);
    if (!manifest) return undefined;
    manifest.status = status;
    return manifest;
  }

  // ---- analytics ---------------------------------------------------------

  stats(): BorderStats {
    const allCrossings = [...this.crossings.values()];
    const allManifests = [...this.manifests.values()];
    return {
      posts: this.posts.size,
      postsOpen: this.listPosts('open').length,
      crossings: allCrossings.length,
      cleared: allCrossings.filter((c) => c.clearance === 'cleared').length,
      referred: allCrossings.filter((c) => c.clearance === 'referred').length,
      denied: allCrossings.filter((c) => c.clearance === 'denied').length,
      manifests: allManifests.length,
      inspected: allManifests.filter((m) => m.status === 'inspected').length,
      held: allManifests.filter((m) => m.status === 'held').length,
      watchlistEntries: this.watchlist.size,
    };
  }
}
