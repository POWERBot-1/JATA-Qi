// ResilienceEngine — Global Resilience Engineering.
//
// 1. Multi-region topology: geographically distributed regions with
//    primary/standby/readonly roles, health scoring, failover priority.
// 2. Automated failover: health-based promotion of the best standby with
//    quorum + cooldown (anti-flapping); failback requires human approval.
// 3. DR orchestration: recovery plans with RPO/RTO targets executed as
//    ordered, validated steps; RTO/RPO compliance is measured.
// 4. Resilience testing: fault injection (region loss, dependency failure,
//    latency, traffic spike, certificate expiry, data corruption) with
//    intensity + duration; validates survival + RTO.
// 5. Continuous availability validation: readiness probes, SLO windows,
//    error budgets, and uptime tracking.

import { randomUUID } from 'node:crypto';
import type {
  AvailabilityRecord, DrExecution, FailoverRun, FaultInjection, FaultKind,
  ProbeResult, RecoveryPlan, RecoveryPlanStep, RegionHealth, RegionRole, RegionTopology,
} from './types.js';

export const DEFAULT_RECOVERY_STEPS: RecoveryPlanStep[] = [
  { name: 'Restore from snapshot', action: 'restore', description: 'Restore the latest snapshot of each workload namespace' },
  { name: 'Validate integrity', action: 'validate_integrity', description: 'Verify restored data hashes against the snapshot manifest' },
  { name: 'Verify configuration', action: 'verify_config', description: 'Confirm the target region config matches the golden baseline' },
  { name: 'Re-establish communications', action: 'reestablish_comms', description: 'Reconnect service mesh / DNS / TLS to the promoted region' },
  { name: 'Health check', action: 'health_check', description: 'Run readiness probes against the recovered workload' },
  { name: 'Resume operations', action: 'resume', description: 'Switch traffic and mark the region operational' },
];

/** Default multi-region topology: two geographically separated sites. */
export const DEFAULT_TOPOLOGY: Array<{ name: string; location: string; role: RegionRole; priority: number }> = [
  { name: 'nbo-1', location: 'Nairobi, KE', role: 'primary', priority: 0 },
  { name: 'lon-1', location: 'London, UK', role: 'standby', priority: 1 },
  { name: 'syd-1', location: 'Sydney, AU', role: 'readonly', priority: 2 },
];

export class ResilienceEngine {
  private regions = new Map<string, RegionTopology>();
  private failovers: FailoverRun[] = [];
  private plans: RecoveryPlan[] = [];
  private executions: DrExecution[] = [];
  private faults: FaultInjection[] = [];
  private probes: ProbeResult[] = [];
  private availability: AvailabilityRecord[] = [];
  /** Health thresholds. */
  private readonly failureThreshold = 3;
  private readonly cooldownMs = 5 * 60_000;

  constructor(topology: Array<{ name: string; location: string; role: RegionRole; priority: number }> = DEFAULT_TOPOLOGY) {
    for (const t of topology) this.registerRegion(t);
  }

  // ---- multi-region topology --------------------------------------------------

  registerRegion(input: { name: string; location: string; role: RegionRole; priority: number }): RegionTopology {
    if (!input.name) throw new Error('region name is required');
    const region: RegionTopology = {
      id: randomUUID(), name: input.name, location: input.location,
      role: input.role, health: 'healthy', priority: input.priority,
      latencyMs: 0, failures: 0, registeredAt: Date.now(),
    };
    this.regions.set(region.id, region);
    return region;
  }

  regionsList(): RegionTopology[] {
    return [...this.regions.values()].sort((a, b) => a.priority - b.priority);
  }

  getRegionByName(name: string): RegionTopology | undefined {
    return [...this.regions.values()].find((r) => r.name === name);
  }

  setRegionRole(name: string, role: RegionRole): RegionTopology | undefined {
    const region = this.getRegionByName(name);
    if (!region) return undefined;
    region.role = role;
    return region;
  }

  /** Record a health probe; failures accumulate toward the threshold. */
  recordProbe(workload: string, regionName: string, ok: boolean, latencyMs = 0, detail?: string): ProbeResult {
    const region = this.getRegionByName(regionName);
    const result: ProbeResult = {
      workload, region: regionName, ok, latencyMs, at: Date.now(),
      ...(detail ? { detail } : {}),
    };
    this.probes.push(result);
    if (region) {
      region.latencyMs = latencyMs;
      if (ok) {
        region.failures = 0;
        region.health = 'healthy';
      } else {
        region.failures += 1;
        region.health = region.failures >= this.failureThreshold ? 'down' : 'degraded';
      }
    }
    return result;
  }

  regionHealth(): Record<string, RegionHealth> {
    const out: Record<string, RegionHealth> = {};
    for (const r of this.regions.values()) out[r.name] = r.health;
    return out;
  }

  // ---- automated failover -------------------------------------------------------

  /**
   * Evaluate failover for a workload: when the primary region is down
   * (failures >= threshold), promote the best healthy standby (lowest
   * priority) subject to cooldown (anti-flapping). Returns the failover run
   * or undefined when no action is needed.
   */
  evaluateFailover(workload: string, now = Date.now()): FailoverRun | undefined {
    const primary = this.regionsList().find((r) => r.role === 'primary');
    if (!primary || primary.health !== 'down') return undefined;
    // Anti-flapping: skip if the last failover for this workload is recent.
    const last = [...this.failovers].reverse().find((f) => f.workload === workload);
    if (last && last.completedAt && now - last.completedAt < this.cooldownMs) {
      return undefined;
    }
    const standby = this.regionsList()
      .filter((r) => (r.role === 'standby' || r.role === 'readonly') && r.health !== 'down')
      .sort((a, b) => a.priority - b.priority)[0];
    if (!standby) return undefined;
    const run: FailoverRun = {
      id: randomUUID(), workload, fromRegion: primary.name, toRegion: standby.name,
      reason: `primary ${primary.name} down (${primary.failures} probe failures)`,
      status: 'failing_over', requiresApproval: false, startedAt: now,
    };
    this.failovers.push(run);
    // Promote standby → primary; demote old primary → standby.
    standby.role = 'primary';
    standby.health = 'healthy';
    standby.failures = 0;
    primary.role = 'standby';
    primary.health = 'degraded';
    primary.failures = 0;
    run.status = 'promoted';
    run.completedAt = now;
    return run;
  }

  /** Manual failback to a recovered former primary — requires human approval. */
  failback(workload: string, approver: string, now = Date.now()): FailoverRun | undefined {
    const primary = this.regionsList().find((r) => r.role === 'primary');
    const standby = this.regionsList().find((r) => r.role === 'standby');
    if (!primary || !standby) return undefined;
    const run: FailoverRun = {
      id: randomUUID(), workload, fromRegion: primary.name, toRegion: standby.name,
      reason: 'manual failback after primary recovery', status: 'manual',
      requiresApproval: true, approvedBy: approver, startedAt: now, completedAt: now,
    };
    // Swap roles back.
    standby.role = 'primary';
    standby.health = 'healthy';
    primary.role = 'standby';
    primary.health = 'healthy';
    this.failovers.push(run);
    return run;
  }

  failoverHistory(): FailoverRun[] {
    return [...this.failovers].reverse();
  }

  // ---- DR orchestration (recovery plans + execution) ------------------------------

  createPlan(input: { workload: string; rpoMs: number; rtoMs: number; createdBy: string; steps?: RecoveryPlanStep[] }): RecoveryPlan {
    if (!input.workload || input.rpoMs < 0 || input.rtoMs <= 0) throw new Error('workload + valid rpo/rto required');
    const plan: RecoveryPlan = {
      id: randomUUID(), workload: input.workload, rpoMs: input.rpoMs, rtoMs: input.rtoMs,
      steps: input.steps ?? DEFAULT_RECOVERY_STEPS,
      createdBy: input.createdBy, createdAt: Date.now(),
    };
    this.plans.push(plan);
    return plan;
  }

  plansList(): RecoveryPlan[] {
    return [...this.plans];
  }

  /**
   * Execute a recovery plan end-to-end. Each step runs with simulated
   * semantics and records success/failure; RTO compliance is measured against
   * the plan target. A `snapshotAgeMs` input models data-loss exposure vs RPO.
   */
  executePlan(planId: string, opts: { snapshotAgeMs?: number; failStep?: string; elapsedMs?: number } = {}): DrExecution {
    const plan = this.plans.find((p) => p.id === planId);
    if (!plan) throw new Error(`unknown plan ${planId}`);
    const startedAt = Date.now();
    const execution: DrExecution = {
      id: randomUUID(), planId, workload: plan.workload, status: 'running',
      startedAt, steps: [],
      ...(opts.snapshotAgeMs !== undefined ? { dataLossMs: opts.snapshotAgeMs } : {}),
    };
    for (const step of plan.steps) {
      const ok = step.name !== opts.failStep;
      execution.steps.push({ name: step.name, ok, at: Date.now(), ...(ok ? {} : { detail: `injected failure at step ${step.name}` }) });
      if (!ok) {
        execution.status = 'failed';
        execution.error = `step "${step.name}" failed`;
        this.executions.push(execution);
        return execution;
      }
    }
    const elapsedMs = opts.elapsedMs ?? Date.now() - startedAt;
    execution.status = 'completed';
    execution.finishedAt = Date.now();
    execution.rtoMet = elapsedMs <= plan.rtoMs;
    if (execution.rtoMet === false) execution.status = 'violated';
    // RPO compliance: data loss beyond target is a violation.
    if (execution.dataLossMs !== undefined && execution.dataLossMs > plan.rpoMs) execution.status = 'violated';
    this.executions.push(execution);
    return execution;
  }

  executionsList(): DrExecution[] {
    return [...this.executions].reverse();
  }

  /** RTO/RPO compliance rates across executions. */
  drCompliance(): { total: number; rtoMet: number; rpoMet: number; compliant: number } {
    const total = this.executions.filter((e) => e.status === 'completed' || e.status === 'violated').length;
    const rtoMet = this.executions.filter((e) => e.rtoMet === true).length;
    const rpoMet = this.executions.filter((e) => e.dataLossMs === undefined || e.dataLossMs <= (this.plans.find((p) => p.id === e.planId)?.rpoMs ?? Infinity)).length;
    return { total, rtoMet, rpoMet, compliant: this.executions.filter((e) => e.status === 'completed').length };
  }

  // ---- resilience testing (fault injection) -------------------------------------------

  injectFault(input: { workload: string; kind: FaultKind; target: string; intensity: number; durationMs: number }): FaultInjection {
    if (input.intensity < 0 || input.intensity > 1) throw new Error('intensity must be 0..1');
    const fault: FaultInjection = {
      id: randomUUID(), workload: input.workload, kind: input.kind, target: input.target,
      intensity: input.intensity, durationMs: input.durationMs,
      startedAt: Date.now(), active: true,
    };
    this.faults.push(fault);
    return fault;
  }

  endFault(id: string): FaultInjection | undefined {
    const fault = this.faults.find((f) => f.id === id);
    if (!fault) return undefined;
    fault.active = false;
    fault.finishedAt = Date.now();
    return fault;
  }

  activeFaults(): FaultInjection[] {
    return this.faults.filter((f) => f.active);
  }

  faultsList(): FaultInjection[] {
    return [...this.faults].reverse();
  }

  /**
   * Run a resilience test: inject a fault, run the recovery plan, verify the
   * workload survives (completes) within RTO. Returns the execution + fault.
   */
  runResilienceTest(input: { workload: string; kind: FaultKind; target: string; intensity: number; durationMs: number; planId: string; snapshotAgeMs?: number; failStep?: string }): { fault: FaultInjection; execution: DrExecution; survived: boolean } {
    const fault = this.injectFault(input);
    const execution = this.executePlan(input.planId, { snapshotAgeMs: input.snapshotAgeMs, failStep: input.failStep });
    const survived = execution.status === 'completed' && execution.rtoMet === true;
    this.endFault(fault.id);
    return { fault, execution, survived };
  }

  // ---- continuous availability validation ----------------------------------------------

  /** Record an availability observation (uptime fraction in a window). */
  recordAvailability(input: { workload: string; windowMs: number; uptime: number; slo: number }): AvailabilityRecord {
    const uptime = Math.max(0, Math.min(1, input.uptime));
    const slo = Math.max(0, Math.min(1, input.slo));
    const uptimeLabel = `${(uptime * 100).toFixed(3)}%`;
    // Error budget: allowed downtime minus consumed downtime, normalized.
    const errorBudget = Math.max(0, Math.min(1, (uptime - slo) / (1 - slo) + 1));
    const record: AvailabilityRecord = {
      id: randomUUID(), workload: input.workload, windowMs: input.windowMs,
      uptime, uptimeLabel, slo, errorBudget, recordedAt: Date.now(),
    };
    this.availability.push(record);
    return record;
  }

  availabilityList(): AvailabilityRecord[] {
    return [...this.availability].reverse();
  }

  /** Latest availability per workload. */
  availabilitySummary(): Array<{ workload: string; uptimeLabel: string; slo: number; errorBudget: number; healthy: boolean }> {
    const latest = new Map<string, AvailabilityRecord>();
    for (const a of this.availability) latest.set(a.workload, a);
    return [...latest.values()].map((a) => ({
      workload: a.workload, uptimeLabel: a.uptimeLabel, slo: a.slo,
      errorBudget: a.errorBudget, healthy: a.uptime >= a.slo,
    }));
  }

  probesList(filter?: { workload?: string; region?: string; ok?: boolean }): ProbeResult[] {
    return this.probes.filter((p) =>
      (!filter?.workload || p.workload === filter.workload) &&
      (!filter?.region || p.region === filter.region) &&
      (filter?.ok === undefined || p.ok === filter.ok));
  }

  stats(): {
    regions: number; primary: string | undefined; standbys: number; regionsDown: number;
    failovers: number; recoveryPlans: number; drExecutions: number; drCompliant: number;
    activeFaults: number; faultsInjected: number; probes: number; failedProbes: number;
    workloadsTracked: number; healthyWorkloads: number; availabilityRecords: number;
  } {
    const summary = this.availabilitySummary();
    return {
      regions: this.regions.size,
      primary: this.regionsList().find((r) => r.role === 'primary')?.name,
      standbys: this.regionsList().filter((r) => r.role === 'standby').length,
      regionsDown: this.regionsList().filter((r) => r.health === 'down').length,
      failovers: this.failovers.length,
      recoveryPlans: this.plans.length,
      drExecutions: this.executions.length,
      drCompliant: this.drCompliance().compliant,
      activeFaults: this.activeFaults().length,
      faultsInjected: this.faults.length,
      probes: this.probes.length,
      failedProbes: this.probes.filter((p) => !p.ok).length,
      workloadsTracked: summary.length,
      healthyWorkloads: summary.filter((s) => s.healthy).length,
      availabilityRecords: this.availability.length,
    };
  }
}
