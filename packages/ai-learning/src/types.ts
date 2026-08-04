// JATA Qi AI Learning Platform — types (CLP Phase 3). Prompt registry with
// versioning + approval workflows, per-response quality tracking, drift
// detection, and model/provider benchmarking. Composes @jataqi/memory (records
// AI events), @jataqi/evals (structured evaluation), and @jataqi/llm-gateway
// (routing observation) — does not duplicate them.

/** Prompt lifecycle states. */
export type PromptVersionStatus = 'draft' | 'reviewed' | 'active' | 'deprecated';

/** A versioned prompt template with variables. */
export interface PromptVersion {
  id: string;
  templateId: string;
  version: number;
  content: string;
  /** Variables extracted from {{mustache}} placeholders. */
  variables: string[];
  status: PromptVersionStatus;
  notes?: string;
  approvedBy?: string;
  createdAt: number;
}

/** A prompt template (container for versions). */
export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  category: string;
  versions: PromptVersion[];
  activeVersionId?: string;
  createdAt: number;
  updatedAt: number;
}

/** The outcome of a single AI response (tracked for quality scoring). */
export interface ResponseOutcome {
  id: string;
  promptTemplateId?: string;
  promptVersionId?: string;
  model: string;
  provider: string;
  outcome: 'accepted' | 'edited' | 'rejected';
  rating?: number; // 1..5
  latencyMs: number;
  costUsd?: number;
  confidence?: number; // 0..1
  tokensIn?: number;
  tokensOut?: number;
  ts: number;
  userId?: string;
  orgId?: string;
}

/** Aggregated quality metrics for a prompt version, model, or provider. */
export interface QualityMetrics {
  total: number;
  accepted: number;
  edited: number;
  rejected: number;
  acceptanceRate: number;
  avgRating: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  avgConfidence: number;
  avgTokensIn: number;
  avgTokensOut: number;
}

/** A drift alert when quality degrades beyond a threshold. */
export interface DriftAlert {
  id: string;
  scope: string; // templateId or model name
  metric: 'acceptanceRate' | 'avgRating' | 'avgLatencyMs';
  baselineValue: number;
  recentValue: number;
  change: number; // negative = degradation for rate/rating; positive for latency
  severity: 'warning' | 'critical';
  detectedAt: number;
}

/** Model/provider benchmark comparison. */
export interface ModelBenchmark {
  model: string;
  provider: string;
  metrics: QualityMetrics;
  /** Cost per 1k accepted responses. */
  costPerAccept: number;
  /** Latency percentile (p50/p95). */
  p50Latency: number;
  p95Latency: number;
}

// ---- prompt experiments (CLP Phase 4) -------------------------------------

/** Lifecycle of a champion/challenger prompt experiment. */
export type ExperimentStatus = 'running' | 'concluded' | 'cancelled';

/** Outcome decision of an evaluated experiment. */
export type ExperimentDecision = 'promote' | 'keep' | 'insufficient-data' | 'regression';

/** Which variant an online serve call routed traffic to. */
export type ExperimentVariant = 'champion' | 'challenger';

/**
 * A controlled champion/challenger experiment over two versions of a prompt
 * template. Traffic is split between the active ("champion") version and a
 * candidate ("challenger") version; recorded response outcomes are compared
 * and the challenger is promoted only when it beats the champion by a
 * measurable, statistically honest margin (CLP Phase 4 — eval-gated learning).
 */
export interface PromptExperiment {
  id: string;
  templateId: string;
  name: string;
  /** The template version currently active (baseline). */
  championVersionId: string;
  /** The candidate version under test. */
  challengerVersionId: string;
  status: ExperimentStatus;
  startedAt: number;
  concludedAt?: number;
  decision?: ExperimentDecision;
  /** Human-readable justification of the decision. */
  reason?: string;
  /** Traffic share routed to the challenger (0..1). */
  challengerTraffic: number;
  /** Minimum recorded outcomes per variant before evaluation may conclude. */
  minOutcomes: number;
  /** Minimum acceptance-rate gain (percentage points) required to promote. */
  minAcceptanceGain: number;
  /** Per-variant quality metrics from the last evaluation. */
  metrics?: { champion: QualityMetrics; challenger: QualityMetrics };
  createdBy: string;
}
