// Global Resilience Engineering — types.

export type RegionRole = 'primary' | 'standby' | 'readonly';
export type RegionHealth = 'healthy' | 'degraded' | 'down';

export interface RegionTopology {
  id: string;
  name: string;
  /** Geographic location, e.g. 'NBO-1' / 'LON-1'. */
  location: string;
  role: RegionRole;
  health: RegionHealth;
  /** Failover priority (lower = preferred standby). */
  priority: number;
  /** Latest health probe latency in ms. */
  latencyMs: number;
  /** Failure count in the current window (health scoring). */
  failures: number;
  registeredAt: number;
}

export type FailoverStatus = 'idle' | 'evaluating' | 'failing_over' | 'promoted' | 'completed' | 'failed' | 'manual';

export interface FailoverRun {
  id: string;
  workload: string;
  fromRegion: string;
  toRegion: string;
  reason: string;
  status: FailoverStatus;
  /** Human approval required for failback to a recovered primary. */
  requiresApproval: boolean;
  approvedBy?: string;
  startedAt: number;
  completedAt?: number;
}

export interface RecoveryPlanStep {
  name: string;
  action: 'restore' | 'validate_integrity' | 'verify_config' | 'reestablish_comms' | 'health_check' | 'resume';
  description: string;
}

export interface RecoveryPlan {
  id: string;
  workload: string;
  /** Recovery Point Objective — max acceptable data loss (ms). */
  rpoMs: number;
  /** Recovery Time Objective — max acceptable downtime (ms). */
  rtoMs: number;
  steps: RecoveryPlanStep[];
  createdBy: string;
  createdAt: number;
}

export interface DrExecution {
  id: string;
  planId: string;
  workload: string;
  status: 'running' | 'completed' | 'failed' | 'violated';
  startedAt: number;
  finishedAt?: number;
  /** Per-step results with timestamps. */
  steps: Array<{ name: string; ok: boolean; at: number; detail?: string }>;
  /** Whether RTO was met (elapsed <= rtoMs). */
  rtoMet?: boolean;
  /** Snapshot age at restore (data-loss exposure). */
  dataLossMs?: number;
  error?: string;
}

export type FaultKind = 'region_loss' | 'dependency_failure' | 'latency' | 'traffic_spike' | 'certificate_expiry' | 'data_corruption';

export interface FaultInjection {
  id: string;
  workload: string;
  kind: FaultKind;
  /** Target region / service / dependency. */
  target: string;
  /** Severity 0..1 (e.g. 1.0 = total region loss, 0.3 = degraded). */
  intensity: number;
  durationMs: number;
  startedAt: number;
  finishedAt?: number;
  /** True while the fault is active. */
  active: boolean;
}

export interface AvailabilityRecord {
  id: string;
  workload: string;
  /** Window in ms (e.g. 30d). */
  windowMs: number;
  /** Observed uptime fraction 0..1 within the window. */
  uptime: number;
  /** 9s uptime label, e.g. '99.95%'. */
  uptimeLabel: string;
  /** SLO target 0..1. */
  slo: number;
  /** Error budget remaining 0..1 (0 = budget exhausted). */
  errorBudget: number;
  recordedAt: number;
}

export interface ProbeResult {
  workload: string;
  region: string;
  ok: boolean;
  latencyMs: number;
  at: number;
  detail?: string;
}
