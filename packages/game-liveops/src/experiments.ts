// Experimentation framework — deterministic A/B/n experiments and feature flags.
// Assignment is a stable hash of (playerId, experimentId) so each player always
// lands in the same bucket, traffic allocation is configurable, and conversion
// revenue is tracked with z-test significance reporting. Lifecycle:
// draft → running → (paused) → completed.

import type { Experiment, ExperimentStatus, Variant } from './types.js';
import type { Segment } from './types.js';

/** FNV-1a hash → 0..1 (stable per input). */
function hash01(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

export interface CreateExperimentInput {
  id: string;
  name: string;
  metric: string;
  variants: Array<{ name: string; weight: number }>;
  /** Percentage of players enrolled (0..100); the rest see the baseline. */
  trafficPct?: number;
  /** Baseline variant for significance comparison (default: first variant). */
  baseline?: string;
}

export interface VariantReport {
  name: string;
  exposures: number;
  conversions: number;
  conversionRate: number;
  revenue: number;
  revenuePerExposure: number;
  /** Lift vs baseline conversion rate. */
  lift: number;
  /** z-score vs baseline (two-proportion test). */
  z: number;
  significant: boolean;
}

export interface ExperimentReport {
  id: string;
  status: ExperimentStatus;
  baseline: string;
  variants: VariantReport[];
  /** Recommended winner (highest conversion among significant lifts). */
  winner: string | null;
}

export class ExperimentManager {
  private experiments = new Map<string, Experiment>();
  private trafficPct = new Map<string, number>();
  private baseline = new Map<string, string>();

  /** Create a draft experiment. */
  create(input: CreateExperimentInput): Experiment {
    if (this.experiments.has(input.id)) throw new Error(`experiment ${input.id} exists`);
    if (input.variants.length < 2) throw new Error('need >= 2 variants');
    const totalWeight = input.variants.reduce((s, v) => s + v.weight, 0);
    if (totalWeight <= 0) throw new Error('variant weights must sum > 0');
    const variants = new Map<string, Variant>();
    for (const v of input.variants) variants.set(v.name, { name: v.name, weight: v.weight, conversions: 0, exposures: 0, revenue: 0 });
    const exp: Experiment = {
      id: input.id, name: input.name, metric: input.metric, variants, status: 'draft',
      assignment: new Map(), startedAt: 0,
    };
    this.experiments.set(input.id, exp);
    this.trafficPct.set(input.id, input.trafficPct ?? 100);
    this.baseline.set(input.id, input.baseline ?? input.variants[0]!.name);
    return exp;
  }

  get(id: string): Experiment | undefined { return this.experiments.get(id); }
  list(): Experiment[] { return [...this.experiments.values()]; }

  start(id: string): Experiment { return this.set(id, 'running', (e) => { if (e.startedAt === 0) e.startedAt = Date.now(); }); }
  pause(id: string): Experiment { return this.set(id, 'paused'); }
  resume(id: string): Experiment { return this.set(id, 'running'); }
  complete(id: string): Experiment { return this.set(id, 'completed', (e) => { e.endedAt = Date.now(); }); }

  private set(id: string, status: ExperimentStatus, fn?: (e: Experiment) => void): Experiment {
    const e = this.experiments.get(id);
    if (!e) throw new Error(`experiment ${id} not found`);
    e.status = status; fn?.(e); return e;
  }

  /**
   * Deterministically assign a player to a variant. Players outside the traffic
   * allocation are assigned to the baseline (and not counted as exposed). The
   * assignment is stable for the life of the experiment.
   */
  assign(playerId: string, experimentId: string, now = Date.now()): string {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`experiment ${experimentId} not found`);
    if (exp.status !== 'running') throw new Error(`experiment ${experimentId} is ${exp.status}`);
    const cached = exp.assignment.get(playerId);
    if (cached) return cached;
    const baseline = this.baseline.get(experimentId)!;
    const pct = hash01(`${experimentId}:${playerId}`) * 100;
    let variant: string;
    if (pct >= (this.trafficPct.get(experimentId) ?? 100)) {
      variant = baseline; // not enrolled — control
    } else {
      variant = this.weightedPick(exp, hash01(`variant:${experimentId}:${playerId}`));
    }
    exp.assignment.set(playerId, variant);
    exp.variants.get(variant)!.exposures++;
    void now;
    return variant;
  }

  /** Multi-factor (multivariate) assignment across several experiments at once. */
  assignAll(playerId: string, experimentIds: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of experimentIds) out[id] = this.assign(playerId, id);
    return out;
  }

  /** Record a conversion (goal) for the player's assigned variant. */
  convert(playerId: string, experimentId: string, revenue = 0): void {
    const exp = this.experiments.get(experimentId);
    if (!exp) return;
    const variant = exp.assignment.get(playerId);
    if (!variant) return;
    const v = exp.variants.get(variant);
    if (!v) return;
    v.conversions++;
    v.revenue += revenue;
  }

  /** Statistical report with per-variant lift and significance vs the baseline. */
  report(experimentId: string): ExperimentReport {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`experiment ${experimentId} not found`);
    const baselineName = this.baseline.get(experimentId)!;
    const base = exp.variants.get(baselineName)!;
    const baseRate = base.exposures > 0 ? base.conversions / base.exposures : 0;
    const reports: VariantReport[] = [];
    let winner: string | null = null;
    let bestLift = 0;
    for (const v of exp.variants.values()) {
      const rate = v.exposures > 0 ? v.conversions / v.exposures : 0;
      const lift = baseRate > 0 ? (rate - baseRate) / baseRate : (rate > 0 ? 1 : 0);
      const z = this.zTest(base.conversions, base.exposures, v.conversions, v.exposures);
      const significant = v.name !== baselineName && Math.abs(z) >= 1.96 && v.exposures > 0;
      reports.push({
        name: v.name, exposures: v.exposures, conversions: v.conversions, conversionRate: rate,
        revenue: v.revenue, revenuePerExposure: v.exposures > 0 ? v.revenue / v.exposures : 0,
        lift, z, significant,
      });
      if (significant && lift > bestLift) { bestLift = lift; winner = v.name; }
    }
    return { id: experimentId, status: exp.status, baseline: baselineName, variants: reports, winner };
  }

  /** Pick the experiment winner (significant lift over baseline). */
  pickWinner(experimentId: string): string | null { return this.report(experimentId).winner; }

  /** Two-proportion z-test between baseline and a variant. */
  private zTest(c1: number, n1: number, c2: number, n2: number): number {
    if (n1 === 0 || n2 === 0) return 0;
    const p1 = c1 / n1, p2 = c2 / n2;
    const pooled = (c1 + c2) / (n1 + n2);
    if (pooled === 0 || pooled === 1) return 0;
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    return se > 0 ? (p2 - p1) / se : 0;
  }

  private weightedPick(exp: Experiment, r: number): string {
    const total = [...exp.variants.values()].reduce((s, v) => s + v.weight, 0);
    let acc = (r * total) % total;
    for (const v of exp.variants.values()) {
      acc -= v.weight;
      if (acc <= 0) return v.name;
    }
    return [...exp.variants.keys()][0]!;
  }
}

// ---- Feature flags + canary rollouts ------------------------------------

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  /** 0..100 percent of players (deterministic). */
  rolloutPct: number;
  /** Optional targeting segment. */
  segment?: Segment;
}

export class FeatureFlagManager {
  private flags = new Map<string, FeatureFlag>();

  set(flag: FeatureFlag): void { this.flags.set(flag.key, flag); }
  get(key: string): FeatureFlag | undefined { return this.flags.get(key); }
  list(): FeatureFlag[] { return [...this.flags.values()]; }
  remove(key: string): boolean { return this.flags.delete(key); }

  /** Is the flag on for this player? (enabled + rollout gate + segment match). */
  isEnabled(key: string, playerId: string, profile?: { level?: number; country?: string; paying?: boolean; firstSeen?: number }): boolean {
    const f = this.flags.get(key);
    if (!f || !f.enabled) return false;
    if (f.segment && !segmentMatches(f.segment, profile)) return false;
    const pct = hash01(`flag:${key}:${playerId}`) * 100;
    return pct < f.rolloutPct;
  }

  /** Convenience: a canary rollout (small percentage) for a key. */
  enableCanary(key: string, rolloutPct = 5, segment?: Segment): FeatureFlag {
    const flag: FeatureFlag = { key, enabled: true, rolloutPct, ...(segment ? { segment } : {}) };
    this.set(flag);
    return flag;
  }
}

/** Evaluate a Segment against an optional player profile. */
export function segmentMatches(segment: Segment, p?: { level?: number; country?: string; paying?: boolean; firstSeen?: number }): boolean {
  if (segment.minLevel !== undefined && (p?.level ?? 0) < segment.minLevel) return false;
  if (segment.paying !== undefined && !!p?.paying !== segment.paying) return false;
  if (segment.country !== undefined && p?.country !== segment.country) return false;
  if (segment.minAgeDays !== undefined) {
    const ageDays = p?.firstSeen !== undefined ? (Date.now() - p.firstSeen) / 86_400_000 : 0;
    if (ageDays < segment.minAgeDays) return false;
  }
  return true;
}
