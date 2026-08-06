// ResilienceEngineeringModule — kernel module for Global Resilience
// Engineering. Wraps the engine, emits bus events on failover / DR / faults.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { ResilienceEngine, DEFAULT_RECOVERY_STEPS, DEFAULT_TOPOLOGY } from './engine.js';
import type {
  AvailabilityRecord, DrExecution, FailoverRun, FaultInjection, FaultKind,
  ProbeResult, RecoveryPlan, RegionRole,
} from './types.js';

/** Optional DR integration: supplies the age of the latest disaster-recovery
 *  snapshot so recovery-plan executions can measure RPO exposure from real
 *  backup data (wired to @jataqi/disaster-recovery in the bootstrap). */
export interface DrSnapshotProvider {
  /** Age in ms of the newest snapshot for a workload namespace (undefined = none). */
  latestSnapshotAgeMs(namespace?: string): number | undefined;
}

export const ResilienceEvents = Object.freeze({
  RegionHealthChanged: 'resilience.region.health',
  FailoverCompleted: 'resilience.failover.completed',
  FailbackApproved: 'resilience.failback.approved',
  DrExecuted: 'resilience.dr.executed',
  FaultInjected: 'resilience.fault.injected',
  FaultEnded: 'resilience.fault.ended',
  ResilienceTest: 'resilience.test.completed',
  SloViolation: 'resilience.slo.violated',
} as const);

export class ResilienceEngineeringModule implements IModule {
  readonly id = 'resilience-engineering';
  readonly tags = ['core', 'resilience', 'infrastructure'] as const;
  readonly dependsOn = [] as const;

  readonly engine: ResilienceEngine;
  private api!: KernelApi;
  private drProvider?: DrSnapshotProvider;

  constructor(topology?: Array<{ name: string; location: string; role: RegionRole; priority: number }>) {
    this.engine = new ResilienceEngine(topology);
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('resilience-engineering', this);
    kernel.logger.info('resilience-engineering module initialized (global resilience)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  /** Attach a disaster-recovery snapshot provider (RPO wiring). */
  attachDrProvider(provider: DrSnapshotProvider): void {
    this.drProvider = provider;
  }

  drProviderAttached(): boolean {
    return this.drProvider !== undefined;
  }

  // ---- topology ---------------------------------------------------------------

  registerRegion(input: { name: string; location: string; role: RegionRole; priority: number }) {
    return this.engine.registerRegion(input);
  }
  regionsList() { return this.engine.regionsList(); }
  setRegionRole(name: string, role: RegionRole) { return this.engine.setRegionRole(name, role); }

  recordProbe(workload: string, region: string, ok: boolean, latencyMs?: number, detail?: string): ProbeResult {
    const result = this.engine.recordProbe(workload, region, ok, latencyMs, detail);
    void this.api?.bus.emit(ResilienceEvents.RegionHealthChanged, {
      region, health: result.ok ? 'healthy' : 'degraded', ok: result.ok,
    });
    return result;
  }
  regionHealth() { return this.engine.regionHealth(); }

  // ---- failover ------------------------------------------------------------------

  evaluateFailover(workload: string): FailoverRun | undefined {
    const run = this.engine.evaluateFailover(workload);
    if (run) void this.api?.bus.emit(ResilienceEvents.FailoverCompleted, { id: run.id, workload, from: run.fromRegion, to: run.toRegion });
    return run;
  }
  failback(workload: string, approver: string): FailoverRun | undefined {
    const run = this.engine.failback(workload, approver);
    if (run) void this.api?.bus.emit(ResilienceEvents.FailbackApproved, { id: run.id, workload, approver });
    return run;
  }
  failoverHistory() { return this.engine.failoverHistory(); }

  // ---- DR orchestration -----------------------------------------------------------

  createPlan(input: { workload: string; rpoMs: number; rtoMs: number; createdBy: string }): RecoveryPlan {
    return this.engine.createPlan(input);
  }
  plansList() { return this.engine.plansList(); }
  executePlan(planId: string, opts?: { snapshotAgeMs?: number; failStep?: string }): DrExecution {
    let effective = { ...(opts ?? {}) };
    // When no snapshot age is supplied, measure RPO exposure from the DR
    // provider's latest snapshot (real backup data).
    if (effective.snapshotAgeMs === undefined && this.drProvider) {
      const plan = this.engine.plansList().find((p) => p.id === planId);
      const age = plan ? this.drProvider.latestSnapshotAgeMs(plan.workload) : this.drProvider.latestSnapshotAgeMs();
      if (age !== undefined) effective = { ...effective, snapshotAgeMs: age };
    }
    const execution = this.engine.executePlan(planId, effective);
    void this.api?.bus.emit(ResilienceEvents.DrExecuted, { id: execution.id, workload: execution.workload, status: execution.status, rtoMet: execution.rtoMet });
    return execution;
  }
  executionsList() { return this.engine.executionsList(); }
  drCompliance() { return this.engine.drCompliance(); }

  // ---- fault injection + resilience tests --------------------------------------------

  injectFault(input: { workload: string; kind: FaultKind; target: string; intensity: number; durationMs: number }): FaultInjection {
    const fault = this.engine.injectFault(input);
    void this.api?.bus.emit(ResilienceEvents.FaultInjected, { id: fault.id, kind: fault.kind, target: fault.target, intensity: fault.intensity });
    return fault;
  }
  endFault(id: string): FaultInjection | undefined {
    const fault = this.engine.endFault(id);
    if (fault) void this.api?.bus.emit(ResilienceEvents.FaultEnded, { id: fault.id });
    return fault;
  }
  activeFaults() { return this.engine.activeFaults(); }
  faultsList() { return this.engine.faultsList(); }

  runResilienceTest(input: { workload: string; kind: FaultKind; target: string; intensity: number; durationMs: number; planId: string; snapshotAgeMs?: number; failStep?: string }): { fault: FaultInjection; execution: DrExecution; survived: boolean } {
    const result = this.engine.runResilienceTest(input);
    void this.api?.bus.emit(ResilienceEvents.ResilienceTest, {
      workload: input.workload, kind: input.kind, survived: result.survived,
    });
    return result;
  }

  // ---- availability validation --------------------------------------------------------

  recordAvailability(input: { workload: string; windowMs: number; uptime: number; slo: number }): AvailabilityRecord {
    const record = this.engine.recordAvailability(input);
    if (record.uptime < record.slo) {
      void this.api?.bus.emit(ResilienceEvents.SloViolation, { workload: input.workload, uptime: record.uptime, slo: record.slo });
    }
    return record;
  }
  availabilityList() { return this.engine.availabilityList(); }
  availabilitySummary() { return this.engine.availabilitySummary(); }
  probesList(filter?: { workload?: string; region?: string; ok?: boolean }) { return this.engine.probesList(filter); }

  stats() { return this.engine.stats(); }
}

export { DEFAULT_RECOVERY_STEPS, DEFAULT_TOPOLOGY };
