// SecurityAutomationModule — cross-pillar security automation.
//
// Wires the platform bus into the CorrelationEngine (auto-incidents,
// auto-bans, risk signals, auto-closure), runs scheduled continuous threat
// hunts through the SOC, and produces compliance evidence reports.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { SocModule } from '@jataqi/soc';
import type { ActiveDefenseModule } from '@jataqi/active-defense';
import { CorrelationEngine, DEFAULT_CORRELATION_RULES, type CorrelationRule } from './correlation.js';
import { HuntScheduler, type HuntScheduleConfig, type HuntSweepResult } from './hunts.js';
import { ComplianceReportBuilder, type ComplianceReportResult, type ComplianceInputs } from './compliance.js';

export const SecurityAutomationEvents = Object.freeze({
  IncidentAutoOpened: 'secauto.incident.opened',
  IncidentAutoClosed: 'secauto.incident.closed',
  AutoBanApplied: 'secauto.ban.applied',
  HuntSweepCompleted: 'secauto.hunt.completed',
  ComplianceReportGenerated: 'secauto.compliance.generated',
} as const);

/** Bus events the automation layer correlates into incidents/actions. */
export const CORRELATION_EVENTS = [
  'defense.finding.created', 'defense.finding.resolved',
  'supplychain.dependency.vulnerable', 'supplychain.deployment.mismatch', 'supplychain.integrity.drift',
  'resilience.failover.completed', 'resilience.region.health', 'resilience.slo.violated', 'resilience.dr.executed',
  'infra.firmware.mismatch', 'infra.config.drift',
  'soc.abuse.alert', 'soc.insider.alert',
] as const;

export class SecurityAutomationModule implements IModule {
  readonly id = 'security-automation';
  readonly tags = ['core', 'security', 'automation'] as const;
  readonly dependsOn = [] as const;

  readonly correlation: CorrelationEngine;
  readonly hunts: HuntScheduler;
  readonly compliance = new ComplianceReportBuilder();

  private api!: KernelApi;
  private soc?: SocModule;
  private defense?: ActiveDefenseModule;
  private unsubs: Array<() => void> = [];

  constructor() {
    // The sink is bound in init once module refs resolve.
    this.correlation = new CorrelationEngine({
      openIncident: (input) => {
        const incident = this.soc!.openIncident({ ...input, commander: input.commander ?? 'soc-auto' });
        try { void this.api?.bus.emit(SecurityAutomationEvents.IncidentAutoOpened, { id: incident.id, title: incident.title, severity: incident.severity }); } catch { /* noop */ }
        return incident;
      },
      transitionIncident: (id, status, by, note) => {
        const incident = this.soc?.transitionIncident(id, status, by, note);
        if (incident) {
          try { void this.api?.bus.emit(SecurityAutomationEvents.IncidentAutoClosed, { id, status }); } catch { /* noop */ }
        }
        return incident;
      },
      ban: (input) => {
        const record = this.defense?.ban(input);
        try { void this.api?.bus.emit(SecurityAutomationEvents.AutoBanApplied, { scope: input.scope, value: input.value }); } catch { /* noop */ }
        return record;
      },
      riskSignal: (userId, signal) => this.defense?.ingestRisk(userId, signal),
    });
    this.hunts = new HuntScheduler(
      { hunt: (id, opts) => this.soc!.hunt(id, opts), huntAll: (opts) => this.soc!.huntAll(opts) },
      (result) => {
        try { void this.api?.bus.emit(SecurityAutomationEvents.HuntSweepCompleted, { at: result.at, hits: result.totalHits, triggered: result.triggered }); } catch { /* noop */ }
      },
    );
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.soc = this.tryModule<SocModule>('soc');
    this.defense = this.tryModule<ActiveDefenseModule>('active-defense');
    kernel.container.registerValue('security-automation', this);
    kernel.logger.info('security-automation module initialized (cross-pillar automation)');
  }

  async start(kernel: KernelApi): Promise<void> {
    for (const ev of CORRELATION_EVENTS) {
      const h = (payload: unknown): void => {
        const result = this.correlation.ingest(ev, (payload ?? {}) as Record<string, unknown>);
        if (result) {
          try { void this.api.bus.emit(SecurityAutomationEvents.IncidentAutoOpened, { id: result.incidentId, severity: result.severity, title: result.title }); } catch { /* noop */ }
        }
      };
      kernel.bus.on(ev, h);
      this.unsubs.push(() => kernel.bus.off(ev, h));
    }
  }

  async stop(_kernel: KernelApi): Promise<void> {
    this.hunts.stop();
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  // ---- correlation surface --------------------------------------------------

  rules(): CorrelationRule[] {
    return this.correlation.rulesList();
  }

  upsertRule(rule: CorrelationRule): void {
    this.correlation.upsertRule(rule);
  }

  correlations(): ReturnType<CorrelationEngine['correlatedList']> {
    return this.correlation.correlatedList();
  }

  correlatedOpenCount(): number {
    return this.correlation.openCount();
  }

  /** Manually trigger correlation for an event (tests / ad-hoc). */
  ingest(event: string, payload: Record<string, unknown>) {
    return this.correlation.ingest(event, payload);
  }

  // ---- scheduled hunts --------------------------------------------------------

  configureHunts(config: HuntScheduleConfig): HuntScheduleConfig {
    return this.hunts.configure(config);
  }

  huntConfig(): HuntScheduleConfig {
    return this.hunts.configValue();
  }

  runHuntSweep(): Promise<HuntSweepResult> {
    return this.hunts.runSweep();
  }

  huntSweeps(): HuntSweepResult[] {
    return this.hunts.sweepsList();
  }

  huntsRunning(): boolean {
    return this.hunts.running;
  }

  // ---- compliance report ------------------------------------------------------

  buildComplianceReport(input: Partial<ComplianceInputs> = {}): ComplianceReportResult {
    const lakeEntries = this.soc?.query({}) ?? [];
    const reviewRun = false;
    const availability = this.resilienceAvailable();
    const supplyStats = this.supplyStats();
    const infraRate = this.infraComplianceRate();
    const report = this.compliance.build({
      lake: lakeEntries,
      reviewRun,
      ...availability,
      ...supplyStats,
      ...(infraRate !== undefined ? { infraComplianceRate: infraRate } : {}),
      incidentCount: this.soc?.listIncidents().length ?? 0,
      huntSweeps: this.hunts.sweepsList().length,
      ...input,
    });
    try { void this.api?.bus.emit(SecurityAutomationEvents.ComplianceReportGenerated, { overall: report.overall, families: report.families.length }); } catch { /* noop */ }
    return report;
  }

  private resilienceAvailable(): { availabilityHealthy?: number; availabilityTotal?: number; failovers?: number } {
    try {
      const resilience = this.api.getModule('resilience-engineering') as unknown as {
        availabilitySummary(): Array<{ healthy: boolean }>;
        failoverHistory(): unknown[];
      };
      const summary = resilience.availabilitySummary();
      return {
        availabilityHealthy: summary.filter((s) => s.healthy).length,
        availabilityTotal: summary.length,
        failovers: resilience.failoverHistory().length,
      };
    } catch {
      return {};
    }
  }

  private supplyStats(): { supplyChainVulnerable?: number; supplyChainAudits?: number } {
    try {
      const sc = this.api.getModule('supply-chain-security') as unknown as {
        stats(): { dependenciesVulnerable: number; dependenciesLicenseDenied: number; dependenciesMismatched: number; repositories: number; pipelines: number; integrityChecks: number };
      };
      const s = sc.stats();
      return {
        supplyChainVulnerable: s.dependenciesVulnerable + s.dependenciesLicenseDenied + s.dependenciesMismatched,
        supplyChainAudits: s.repositories + s.pipelines + s.integrityChecks,
      };
    } catch {
      return {};
    }
  }

  private infraComplianceRate(): number | undefined {
    try {
      const infra = this.api.getModule('infra-governance') as unknown as {
        stats(): { compliancePassRate: number };
      };
      return infra.stats().compliancePassRate;
    } catch {
      return undefined;
    }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}

export { DEFAULT_CORRELATION_RULES };
