// SocModule — Global Security Operations kernel module. Wires the telemetry
// pipeline + security data lake, threat hunting, threat intelligence, insider
// risk, abuse detection, incident command, adversarial validation, and
// security metrics into the platform bus and the gateway.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { TelemetryPipeline } from './telemetry.js';
import { ThreatHuntingEngine, ThreatIntelEngine } from './intel.js';
import { InsiderRiskEngine, AbuseDetectionEngine } from './insider-abuse.js';
import { IncidentCommand } from './incident.js';
import { AdversarialValidationEngine } from './validation.js';
import type {
  AbuseAlert, ExerciseCampaign, HuntSession, IncidentComm, IncidentEvidence,
  InsiderAlert, IntelIndicator, IntelMatch, LakeEntry, SecurityIncidentRecord,
  SocKpis, SocReport, TabletopScenario, TelemetrySource,
} from './types.js';

export const SocEvents = Object.freeze({
  EventIngested: 'soc.event.ingested',
  IncidentOpened: 'soc.incident.opened',
  IncidentUpdated: 'soc.incident.updated',
  InsiderAlert: 'soc.insider.alert',
  AbuseAlert: 'soc.abuse.alert',
  IntelMatched: 'soc.intel.matched',
  HuntComplete: 'soc.hunt.complete',
  CampaignComplete: 'soc.campaign.complete',
} as const);

export class SocModule implements IModule {
  readonly id = 'soc';
  readonly tags = ['core', 'security', 'governance'] as const;
  readonly dependsOn = [] as const;

  readonly lake = new TelemetryPipeline();
  readonly hunting: ThreatHuntingEngine;
  readonly intel: ThreatIntelEngine;
  readonly insider = new InsiderRiskEngine();
  readonly abuse = new AbuseDetectionEngine();
  readonly incidentCommand = new IncidentCommand();
  readonly validation: AdversarialValidationEngine;

  private api!: KernelApi;

  constructor() {
    this.hunting = new ThreatHuntingEngine(this.lake);
    this.intel = new ThreatIntelEngine(this.lake);
    // Detection observer for validation campaigns: consult our own engines.
    this.validation = new AdversarialValidationEngine(this.lake, (eventType) => this.detect(eventType));
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('soc', this);
    kernel.logger.info('soc module initialized (Global Security Operations)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless; sweep on demand */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  /** Whether any detection engine flags the given telemetry event type. */
  private detect(eventType: string): boolean {
    // Simulated: a control is considered "detected" when one of the engines
    // has a rule/playbook for the event type.
    const playbooks = this.hunting.listPlaybooks();
    const covered = playbooks.some((p) => p.patterns.some((pat) => eventType === pat || eventType.startsWith(pat)));
    if (eventType === 'defense.honeytoken.touched') return true;
    if (eventType === 'security.auth.denied') return true;
    if (eventType === 'security.permission.denied') return true;
    if (eventType === 'audit.action') return true;
    return covered;
  }

  // ---- telemetry ------------------------------------------------------------

  ingest(input: Omit<Parameters<TelemetryPipeline['ingest']>[0], never> & { source: TelemetrySource; type: string }): LakeEntry {
    const entry = this.lake.ingest(input);
    void this.api?.bus.emit(SocEvents.EventIngested, { id: entry.id, type: entry.type, source: entry.source });
    return entry;
  }

  ingestBatch(inputs: Array<{ source: TelemetrySource; type: string; actor?: string; origin?: string; severity?: 'info' | 'low' | 'medium' | 'high' | 'critical'; detail?: string; data?: Record<string, unknown> }>): LakeEntry[] {
    return this.lake.ingestBatch(inputs);
  }

  query(filter: Parameters<TelemetryPipeline['query']>[0] = {}): LakeEntry[] {
    return this.lake.query(filter);
  }

  verifyLake(): { valid: boolean; brokenAt?: string } {
    return this.lake.verifyChain();
  }

  exportJsonl(): string { return this.lake.exportJsonl(); }
  exportCsv(): string { return this.lake.exportCsv(); }
  lakeAnalytics(since?: number) { return this.lake.analytics(since); }

  // ---- threat hunting ---------------------------------------------------------

  hunt(playbookId: string, opts?: { since?: number; limit?: number }): HuntSession {
    const session = this.hunting.hunt(playbookId, opts);
    void this.api?.bus.emit(SocEvents.HuntComplete, { id: session.id, playbook: session.playbookId, hits: session.hits.length });
    return session;
  }
  huntAll(opts?: { since?: number }): HuntSession[] { return this.hunting.huntAll(opts); }
  huntSessions() { return this.hunting.listSessions(); }
  huntPlaybooks() { return this.hunting.listPlaybooks(); }
  huntCorrelation() { return this.hunting.correlate(); }

  // ---- threat intelligence ------------------------------------------------------

  ingestIntel(input: { type: string; value: string; confidence: number; severity: string; tlp?: string; source: string; expiresAt?: number; tags?: string[] }): IntelIndicator {
    return this.intel.ingest(input as never);
  }
  listIntel(filter?: { type?: string; severity?: string; source?: string }): IntelIndicator[] {
    return this.intel.list(filter as never);
  }
  pruneIntel(): number { return this.intel.pruneExpired(); }
  matchIntel(observations: Array<{ value: string; context?: Record<string, unknown> }>): IntelMatch[] {
    const matches = this.intel.match(observations);
    if (matches.length > 0) void this.api?.bus.emit(SocEvents.IntelMatched, { count: matches.length });
    return matches;
  }
  intelMatches() { return this.intel.matchesList(); }
  intelCorrelation() { return this.intel.correlateLake(); }
  intelFeedHealth() { return this.intel.feedHealth(); }

  // ---- insider risk -------------------------------------------------------------

  observeInsider(input: { actor: string; action: string; sensitivity: string; detail?: string; ts?: number }): InsiderAlert | undefined {
    const alert = this.insider.observe({ ...input, sensitivity: input.sensitivity as never });
    if (alert) void this.api?.bus.emit(SocEvents.InsiderAlert, { id: alert.id, actor: alert.actor, rule: alert.rule, severity: alert.severity });
    return alert;
  }
  insiderAlerts() { return this.insider.alertsList(); }
  insiderAnalytics() { return this.insider.analytics(); }
  insiderPosture(principalRoles: Array<{ principal: string; roles: string[] }>) { return this.insider.posture(principalRoles); }

  // ---- abuse detection -------------------------------------------------------------

  observeAbuse(input: { kind: string; actor?: string; origin?: string; value?: string; ts?: number }): AbuseAlert | undefined {
    const alert = this.abuse.observe({ ...input, kind: input.kind as never });
    if (alert) void this.api?.bus.emit(SocEvents.AbuseAlert, { id: alert.id, rule: alert.rule, severity: alert.severity });
    return alert;
  }
  abuseAlerts() { return this.abuse.alertsList(); }
  abuseCoordinated() { return this.abuse.coordinated(); }

  // ---- incident command -------------------------------------------------------------

  openIncident(input: { title: string; severity: string; commander?: string; responders?: string[] }): SecurityIncidentRecord {
    const incident = this.incidentCommand.open(input);
    void this.api?.bus.emit(SocEvents.IncidentOpened, { id: incident.id, title: incident.title, severity: incident.severity });
    return incident;
  }
  getIncident(id: string) { return this.incidentCommand.get(id); }
  listIncidents(filter?: { severity?: string; status?: string }) { return this.incidentCommand.list(filter as never); }
  transitionIncident(id: string, status: string, by: string, note: string) {
    const incident = this.incidentCommand.transition(id, status as never, by, note);
    if (incident) void this.api?.bus.emit(SocEvents.IncidentUpdated, { id, status: incident.status });
    return incident;
  }
  assignCommander(id: string, commander: string) { return this.incidentCommand.assignCommander(id, commander); }
  addResponder(id: string, responder: string) { return this.incidentCommand.addResponder(id, responder); }
  preserveEvidence(id: string, input: { description: string; artifactHash?: string; preservedBy: string }): IncidentEvidence | undefined {
    return this.incidentCommand.preserveEvidence(id, input);
  }
  communicateIncident(id: string, input: { channel: string; message: string; by: string; to?: string }): IncidentComm | undefined {
    return this.incidentCommand.communicate(id, { ...input, channel: input.channel as never });
  }
  sweepEscalations() { return this.incidentCommand.sweepEscalations(); }
  reviewIncident(id: string, input: { rca: string; lessons: string[]; by: string }) { return this.incidentCommand.review(id, input); }

  // ---- adversarial validation ----------------------------------------------------------

  runCampaign(kind: string): ExerciseCampaign {
    const campaign = this.validation.runCampaign(kind as never);
    void this.api?.bus.emit(SocEvents.CampaignComplete, { id: campaign.id, kind: campaign.kind, score: campaign.score });
    return campaign;
  }
  campaigns() { return this.validation.campaignsList(); }
  validationScore() { return this.validation.validationScore(); }
  addTabletop(input: { title: string; description: string; injects: string[]; facilitatorNotes?: string[] }): TabletopScenario {
    return this.validation.addScenario(input);
  }
  tabletops() { return this.validation.scenariosList(); }

  // ---- metrics / report ------------------------------------------------------------

  kpis(): SocKpis {
    const incidents = this.incidentCommand.list();
    const icm = this.incidentCommand.metrics();
    const open = incidents.filter((i) => i.status !== 'closed');
    const now = Date.now();
    const findingsToday = this.lake.query({ since: now - 86_400_000 }).filter((e) => e.severity === 'high' || e.severity === 'critical').length;
    return {
      incidents: incidents.length,
      openIncidents: open.length,
      sev1Incidents: incidents.filter((i) => i.severity === 'sev1').length,
      avgTimeToTriageMin: icm.avgTimeToTriageMin,
      avgTimeToContainMin: icm.avgTimeToContainMin,
      avgTimeToResolveMin: icm.avgTimeToResolveMin,
      findingsToday,
      telemetryEvents: this.lake.count(),
      lakeEntries: this.lake.count(),
      huntsRun: this.hunting.listSessions().length,
      intelIndicators: this.intel.list().length,
      intelMatches: this.intel.matchesList().length,
      insiderAlerts: this.insider.alertsList().length,
      abuseAlerts: this.abuse.alertsList().length,
      campaignsRun: this.validation.campaignsList().length,
      validationScore: this.validation.validationScore(),
      exercises: this.validation.scenariosList().length,
    };
  }

  report(): SocReport {
    const kpis = this.kpis();
    const recentAlerts: SocReport['recentAlerts'] = [
      ...this.insider.alertsList().slice(0, 5).map((a) => ({ type: 'insider' as const, severity: a.severity, message: a.message, ts: a.ts })),
      ...this.abuse.alertsList().slice(0, 5).map((a) => ({ type: 'abuse' as const, severity: a.severity, message: a.message, ts: a.ts })),
      ...this.hunting.listSessions().slice(0, 5).filter((s) => s.hits.length > 0).map((s) => ({ type: 'hunt' as const, severity: 'medium' as const, message: `${s.playbookName}: ${s.hits.length} hit(s)`, ts: s.startedAt })),
    ].sort((a, b) => b.ts - a.ts).slice(0, 10);
    const intelBySeverity: Record<string, number> = {};
    for (const i of this.intel.list()) intelBySeverity[i.severity] = (intelBySeverity[i.severity] ?? 0) + 1;
    return {
      generatedAt: Date.now(),
      kpis,
      openIncidents: this.incidentCommand.list({ status: undefined }).filter((i) => i.status !== 'closed'),
      recentAlerts,
      intelBySeverity,
      incidentStatusDistribution: this.incidentCommand.statusDistribution(),
      lakeIntegrity: { entries: this.lake.count(), chainValid: this.lake.verifyChain().valid },
    };
  }
}
