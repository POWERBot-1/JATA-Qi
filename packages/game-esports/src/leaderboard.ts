// Leaderboard — a ranked ladder over Elo ratings, with per-player W/L/D record,
// rank tiers, and seasons. recordMatch() is the single mutation point so ratings
// and records stay consistent.

import { tierFor, updateRatings, RANK_TIERS } from './rating.js';
import type { RankTier } from './rating.js';

export interface PlayerRecord {
  playerId: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  played: number;
  joinedAt: number;
}

export interface Season { id: number; startedAt: number; endedAt?: number }

export class Leaderboard {
  private players = new Map<string, PlayerRecord>();
  private seasons: Season[] = [];
  private currentSeason: Season;
  private kFactor: number;
  private startingRating: number;

  constructor(opts: { kFactor?: number; startingRating?: number; now?: number } = {}) {
    this.kFactor = opts.kFactor ?? 32;
    this.startingRating = opts.startingRating ?? 1200;
    this.currentSeason = { id: 1, startedAt: opts.now ?? Date.now() };
    this.seasons.push(this.currentSeason);
  }

  register(playerId: string, rating = this.startingRating): PlayerRecord {
    let p = this.players.get(playerId);
    if (p) return p;
    p = { playerId, rating, wins: 0, losses: 0, draws: 0, played: 0, joinedAt: Date.now() };
    this.players.set(playerId, p);
    return p;
  }

  get(playerId: string): PlayerRecord | undefined { return this.players.get(playerId); }

  /** Record a match result (scoreA: 1=A win, 0.5=draw, 0=A loss). */
  recordMatch(a: string, b: string, scoreA: number): { a: PlayerRecord; b: PlayerRecord } {
    const pa = this.register(a);
    const pb = this.register(b);
    const result = updateRatings(pa.rating, pb.rating, scoreA, this.kFactor);
    pa.rating = Math.round(result.a); pb.rating = Math.round(result.b);
    pa.played++; pb.played++;
    if (scoreA > 0.5) { pa.wins++; pb.losses++; }
    else if (scoreA < 0.5) { pa.losses++; pb.wins++; }
    else { pa.draws++; pb.draws++; }
    return { a: pa, b: pb };
  }

  /** Ranked ladder (highest rating first; ties broken by wins then fewer games). */
  ranking(): PlayerRecord[] {
    return [...this.players.values()].sort((x, y) =>
      y.rating - x.rating || y.wins - x.wins || x.played - y.played);
  }

  rank(playerId: string): number {
    const r = this.ranking();
    return r.findIndex((p) => p.playerId === playerId) + 1; // 0 if unranked
  }

  top(n: number): PlayerRecord[] { return this.ranking().slice(0, n); }

  /** Count of players in each rank tier. */
  tierDistribution(): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const t of tierList()) dist[t.name] = 0;
    for (const p of this.players.values()) {
      const t = tierFor(p.rating).name;
      dist[t] = (dist[t] ?? 0) + 1;
    }
    return dist;
  }

  /** End the current season and start a new one (ratings persist by default). */
  newSeason(opts: { resetRatings?: boolean; now?: number } = {}): Season {
    this.currentSeason.endedAt = opts.now ?? Date.now();
    if (opts.resetRatings) for (const p of this.players.values()) p.rating = this.startingRating;
    this.currentSeason = { id: this.currentSeason.id + 1, startedAt: opts.now ?? Date.now() };
    this.seasons.push(this.currentSeason);
    return this.currentSeason;
  }

  get season(): Season { return this.currentSeason; }
  get playerCount(): number { return this.players.size; }
}

/** Ordered list of rank tiers (helper for tests/UX). */
export function tierList(): RankTier[] { return [...RANK_TIERS]; }
