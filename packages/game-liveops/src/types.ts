// NOVA Live-Ops — types (section 15). Live events, player-behavior analytics,
// A/B experiments, and targeted monetization offers. Games evolve continuously.

export type EventStatus = 'scheduled' | 'active' | 'ended';

export interface LiveEvent {
  id: string;
  name: string;
  /** Start/end epoch ms. */
  startAt: number;
  endAt: number;
  /** Optional recurrence: 'daily' | 'weekly' | null. */
  recurrence?: 'daily' | 'weekly' | null;
  /** Rewards or content keys activated by the event. */
  rewards: string[];
  enabled: boolean;
}

export interface TelemetryEvent {
  playerId: string;
  name: string;
  ts: number;
  value?: number;
  /** Arbitrary dimensions (level, region, ...). */
  dims?: Record<string, string | number>;
}

export interface FunnelStage { name: string; count: number }
export interface Funnel { stages: FunnelStage[]; conversion: number[] }

export interface Cohort {
  /** Cohort key (e.g. install day). */
  key: string;
  size: number;
  /** Day N -> retained players. */
  retention: Record<number, number>;
}

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'completed';

export interface Variant { name: string; weight: number; conversions: number; exposures: number; revenue: number }

export interface Experiment {
  id: string;
  name: string;
  metric: string;
  variants: Map<string, Variant>;
  status: ExperimentStatus;
  assignment: Map<string, string>; // playerId -> variant
  startedAt: number;
  endedAt?: number;
  winner?: string;
}

export interface Offer {
  id: string;
  name: string;
  /** Segment expression a player must match. */
  segment: Segment;
  price: { currency: string; amount: number };
  /** Conversion lift estimate (for optimization). */
  priority: number;
  active: boolean;
}

export interface Segment {
  /** Minimum player level (dims.level). */
  minLevel?: number;
  /** Has the player completed a purchase. */
  paying?: boolean;
  /** Player must be in this country. */
  country?: string;
  /** Minimum days since install. */
  minAgeDays?: number;
}

// ---- analytics types ----------------------------------------------------

/** Materialized per-player profile derived from the telemetry stream. */
export interface PlayerProfile {
  id: string;
  /** First-seen timestamp (install). */
  firstSeen: number;
  lastSeen: number;
  level: number;
  country?: string;
  paying: boolean;
  sessions: number;
  revenue: number;
  /** Cumulative play time in seconds. */
  playTimeSec: number;
}

/** A tracked play session. */
export interface Session {
  id: string;
  playerId: string;
  start: number;
  end?: number;
  durationSec?: number;
}

/** Filter for querying the telemetry stream. */
export interface AnalyticsFilter {
  name?: string;
  playerId?: string;
  fromTs?: number;
  toTs?: number;
  /** Dimension equality predicates. */
  dims?: Record<string, string | number>;
}

/** Aggregated metric summary over a filtered event set. */
export interface MetricSummary {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  uniquePlayers: number;
}
