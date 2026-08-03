// Analytics engine — ingests the telemetry stream and derives the metrics a
// live-ops team runs on: active users (DAU/WAU/MAU), new vs returning, cohort
// retention (D1/D7/D30), funnel conversion, session duration, match outcomes,
// economy totals, and revenue (ARPDAU/ARPPU/LTV). All queries are deterministic
// and run over the same in-memory event store.

import type {
  AnalyticsFilter, Cohort, Funnel, FunnelStage, MetricSummary, PlayerProfile, Session, TelemetryEvent,
} from './types.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Bucket helpers. */
export function dayKey(ts: number): number { return Math.floor(ts / DAY); }
export function weekKey(ts: number): number { return Math.floor(ts / WEEK); }
export function monthKey(ts: number): number { return new Date(ts).getUTCFullYear() * 12 + new Date(ts).getUTCMonth(); }

export class Analytics {
  private events: TelemetryEvent[] = [];
  private profiles = new Map<string, PlayerProfile>();
  private sessions = new Map<string, Session>();
  /** dayKey -> set of active players. */
  private activeByDay = new Map<number, Set<string>>();
  /** dayKey -> revenue. */
  private revenueByDay = new Map<number, number>();
  /** dayKey -> set of paying players. */
  private payersByDay = new Map<number, Set<string>>();

  /** Ingest a telemetry event; updates profiles and indexes. */
  track(e: TelemetryEvent): void {
    this.events.push(e);
    const p = this.profileFor(e.playerId, e.ts);
    p.lastSeen = Math.max(p.lastSeen, e.ts);
    if (e.dims) {
      if (typeof e.dims.level === 'number') p.level = Math.max(p.level, e.dims.level);
      if (typeof e.dims.country === 'string') p.country = e.dims.country;
      if (e.dims.paying) p.paying = true;
    }
    this.markActive(e.playerId, e.ts);
    if (e.name === 'purchase' && typeof e.value === 'number' && e.value > 0) {
      p.paying = true;
      p.revenue += e.value;
      const d = dayKey(e.ts);
      this.revenueByDay.set(d, (this.revenueByDay.get(d) ?? 0) + e.value);
      this.payersByDay.get(d) ?? this.payersByDay.set(d, new Set());
      this.payersByDay.get(d)!.add(e.playerId);
    }
    if (e.name === 'session_end' && typeof e.value === 'number') p.playTimeSec += e.value;
  }

  /** Ingest many events at once. */
  trackAll(events: TelemetryEvent[]): void { for (const e of events) this.track(e); }

  // ---- sessions ----------------------------------------------------------

  sessionStart(id: string, playerId: string, ts: number): Session {
    const p = this.profileFor(playerId, ts);
    p.sessions += 1;
    p.lastSeen = Math.max(p.lastSeen, ts);
    this.markActive(playerId, ts);
    const s: Session = { id, playerId, start: ts };
    this.sessions.set(id, s);
    return s;
  }

  sessionEnd(id: string, ts: number): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    s.end = ts;
    s.durationSec = (ts - s.start) / 1000;
    const p = this.profiles.get(s.playerId);
    if (p && s.durationSec > 0) p.playTimeSec += s.durationSec;
    return s;
  }

  // ---- active users ------------------------------------------------------

  /** Unique active players on a given day key (defaults to the latest seen). */
  dau(at?: number): number {
    const key = at ?? this.lastDay();
    return this.activeByDay.get(key)?.size ?? 0;
  }
  /** Unique active players in the 7-day window ending at `at`. */
  wau(at?: number): number {
    const end = at ?? this.lastDay();
    const set = new Set<string>();
    for (let d = end - 6; d <= end; d++) for (const p of this.activeByDay.get(d) ?? []) set.add(p);
    return set.size;
  }
  /** Unique active players in the 30-day window ending at `at`. */
  mau(at?: number): number {
    const end = at ?? this.lastDay();
    const set = new Set<string>();
    for (let d = end - 29; d <= end; d++) for (const p of this.activeByDay.get(d) ?? []) set.add(p);
    return set.size;
  }

  /** New vs returning players for a day. */
  newVsReturning(at?: number): { new: number; returning: number; total: number } {
    const key = at ?? this.lastDay();
    const active = this.activeByDay.get(key) ?? new Set<string>();
    let newly = 0;
    for (const p of active) if (dayKey(this.profiles.get(p)!.firstSeen) === key) newly++;
    const returning = active.size - newly;
    return { new: newly, returning, total: active.size };
  }

  // ---- cohorts + retention ----------------------------------------------

  /** Group players into cohorts by install granularity. */
  cohorts(granularity: 'day' | 'week' = 'day'): Map<number, Set<string>> {
    const out = new Map<number, Set<string>>();
    for (const [id, p] of this.profiles) {
      const k = granularity === 'day' ? dayKey(p.firstSeen) : weekKey(p.firstSeen);
      const set = out.get(k) ?? new Set<string>();
      set.add(id);
      out.set(k, set);
    }
    return out;
  }

  /**
   * Retention for a cohort at a given day offset (D1, D7, D30). Returns the
   * retained count and rate relative to the cohort size.
   */
  retention(cohortKey: number, dayOffset: number, granularity: 'day' | 'week' = 'day'): { retained: number; size: number; rate: number } {
    const members = this.cohorts(granularity).get(cohortKey);
    const size = members?.size ?? 0;
    if (size === 0) return { retained: 0, size: 0, rate: 0 };
    const targetDay = cohortKey + dayOffset;
    let retained = 0;
    for (const m of members!) if ((this.activeByDay.get(targetDay) ?? new Set()).has(m)) retained++;
    return { retained, size, rate: retained / size };
  }

  /** Cohort retention curves for all cohorts (for cohort tables/charts). */
  cohortTable(granularity: 'day' | 'week' = 'day', maxOffset = 30): Cohort[] {
    const cs = this.cohorts(granularity);
    return [...cs.entries()].map(([key, members]) => {
      const retention: Record<number, number> = {};
      for (let d = 0; d <= maxOffset; d++) retention[d] = this.retention(key, d, granularity).retained;
      return { key: String(key), size: members.size, retention };
    });
  }

  // ---- funnels -----------------------------------------------------------

  /**
   * Funnel over an ordered list of event names. A player reaches stage K if they
   * fired events stage0..stageK in chronological order. Returns per-stage counts
   * and step + overall conversion.
   */
  funnel(stages: string[], opts: { fromTs?: number; toTs?: number } = {}): Funnel {
    const byPlayer = new Map<string, TelemetryEvent[]>();
    for (const e of this.events) {
      if (!stages.includes(e.name)) continue;
      if (opts.fromTs !== undefined && e.ts < opts.fromTs) continue;
      if (opts.toTs !== undefined && e.ts > opts.toTs) continue;
      const arr = byPlayer.get(e.playerId) ?? [];
      arr.push(e);
      byPlayer.set(e.playerId, arr);
    }
    const counts = stages.map(() => 0);
    for (const arr of byPlayer.values()) {
      arr.sort((a, b) => a.ts - b.ts);
      let stageIdx = 0;
      for (const e of arr) {
        if (e.name === stages[stageIdx]) {
          counts[stageIdx]! += 1;
          stageIdx++;
          if (stageIdx >= stages.length) break;
        }
      }
    }
    const stageList: FunnelStage[] = stages.map((name, i) => ({ name, count: counts[i]! }));
    const conversion = counts.map((c, i) => (i === 0 ? (counts[0]! > 0 ? 1 : 0) : counts[i - 1]! > 0 ? c / counts[i - 1]! : 0));
    return { stages: stageList, conversion };
  }

  // ---- sessions + economy + matches -------------------------------------

  avgSessionDuration(): number {
    let total = 0; let n = 0;
    for (const s of this.sessions.values()) if (s.durationSec !== undefined) { total += s.durationSec; n++; }
    return n > 0 ? total / n : 0;
  }

  /** Wins / losses / draws parsed from 'match_end' events (dims.result). */
  matchAnalytics(): { wins: number; losses: number; draws: number; total: number } {
    let wins = 0, losses = 0, draws = 0;
    for (const e of this.events) {
      if (e.name !== 'match_end') continue;
      const r = e.dims?.result;
      if (r === 'win') wins++;
      else if (r === 'loss') losses++;
      else if (r === 'draw') draws++;
    }
    return { wins, losses, draws, total: wins + losses + draws };
  }

  /** Economy totals: earn / spend volume from named events. */
  economyAnalytics(): { earn: number; spend: number; net: number } {
    let earn = 0, spend = 0;
    for (const e of this.events) {
      if (typeof e.value !== 'number') continue;
      if (e.name === 'earn' || e.name === 'reward') earn += e.value;
      else if (e.name === 'spend' || e.name === 'purchase') spend += e.value;
    }
    return { earn, spend, net: earn - spend };
  }

  // ---- revenue -----------------------------------------------------------

  totalRevenue(): number { let r = 0; for (const p of this.profiles.values()) r += p.revenue; return r; }
  /** Revenue accrued on a given day key (defaults to the latest seen). */
  revenueOn(at?: number): number { return this.revenueByDay.get(at ?? this.lastDay()) ?? 0; }
  /** Average revenue per daily active user for a day key. */
  arpDau(at?: number): number { const d = at ?? this.lastDay(); const users = this.dau(d); return users > 0 ? this.revenueOn(d) / users : 0; }
  /** Average revenue per paying user (all time). */
  arppu(): number {
    let payers = 0; for (const p of this.profiles.values()) if (p.paying) payers++;
    return payers > 0 ? this.totalRevenue() / payers : 0;
  }
  /** Life-time value foundation: cumulative revenue per player in a cohort. */
  ltv(cohortKey: number, granularity: 'day' | 'week' = 'day'): number {
    const members = this.cohorts(granularity).get(cohortKey);
    const size = members?.size ?? 0;
    if (size === 0) return 0;
    let rev = 0;
    for (const m of members!) rev += this.profiles.get(m)!.revenue;
    return rev / size;
  }

  // ---- queries -----------------------------------------------------------

  /** Return the raw events matching a filter. */
  query(filter: AnalyticsFilter): TelemetryEvent[] {
    return this.events.filter((e) => this.matches(e, filter));
  }

  /** Aggregate a filtered event set into a metric summary (over `value`). */
  aggregate(filter: AnalyticsFilter): MetricSummary {
    const matched = this.query(filter);
    const players = new Set<string>();
    let sum = 0, min = Infinity, max = -Infinity;
    for (const e of matched) {
      players.add(e.playerId);
      if (typeof e.value === 'number') { sum += e.value; min = Math.min(min, e.value); max = Math.max(max, e.value); }
    }
    const valued = matched.filter((e) => typeof e.value === 'number');
    return {
      count: matched.length,
      sum,
      avg: valued.length > 0 ? sum / valued.length : 0,
      min: min === Infinity ? 0 : min,
      max: max === -Infinity ? 0 : max,
      uniquePlayers: players.size,
    };
  }

  // ---- accessors ---------------------------------------------------------

  profile(playerId: string): PlayerProfile | undefined { return this.profiles.get(playerId); }
  listProfiles(): PlayerRecord[] { return [...this.profiles.values()]; }
  eventCount(): number { return this.events.length; }
  sessionCount(): number { return this.sessions.size; }

  // ---- internals ---------------------------------------------------------

  private profileFor(playerId: string, ts: number): PlayerProfile {
    let p = this.profiles.get(playerId);
    if (!p) {
      p = { id: playerId, firstSeen: ts, lastSeen: ts, level: 0, paying: false, sessions: 0, revenue: 0, playTimeSec: 0 };
      this.profiles.set(playerId, p);
    }
    return p;
  }

  private markActive(playerId: string, ts: number): void {
    const d = dayKey(ts);
    const set = this.activeByDay.get(d) ?? new Set<string>();
    set.add(playerId);
    this.activeByDay.set(d, set);
  }

  private lastDay(): number {
    let last = -1;
    for (const d of this.activeByDay.keys()) if (d > last) last = d;
    return last < 0 ? dayKey(Date.now()) : last;
  }

  private matches(e: TelemetryEvent, f: AnalyticsFilter): boolean {
    if (f.name && e.name !== f.name) return false;
    if (f.playerId && e.playerId !== f.playerId) return false;
    if (f.fromTs !== undefined && e.ts < f.fromTs) return false;
    if (f.toTs !== undefined && e.ts > f.toTs) return false;
    if (f.dims) for (const [k, v] of Object.entries(f.dims)) if (e.dims?.[k] !== v) return false;
    return true;
  }
}

/** Alias for the profile-list return type. */
export type PlayerRecord = PlayerProfile;
