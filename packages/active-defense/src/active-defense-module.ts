// ActiveDefenseModule — kernel module for the Active Defense & Adaptive
// Resilience Layer. Wires the engines to the platform event bus, records
// findings/incidents into the Digital Memory Engine when present, and exposes
// the full defense API to the gateway, SDK, and CLI.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { AdaptiveDefenseEngine } from './defense.js';
import { DetectionEngine, type DetectionRule } from './detection.js';
import { RiskEngine } from './risk.js';
import { DeceptionEngine } from './deception.js';
import type {
  BanRecord, BanScope, ContainmentAction, ContainmentKind, DefenseReport, DefenseStats,
  Finding, FindingSeverity, IncidentRecord, RecoveryRun, RiskLevel, RiskSignal,
} from './types.js';

export const DefenseEvents = Object.freeze({
  FindingCreated: 'defense.finding.created',
  RiskChanged: 'defense.risk.changed',
  ContainmentStarted: 'defense.containment.started',
  ContainmentApprovalRequested: 'defense.containment.approval.requested',
  ContainmentDecided: 'defense.containment.decided',
  IncidentRecorded: 'defense.incident.recorded',
  RecoveryStarted: 'defense.recovery.started',
  RecoveryCompleted: 'defense.recovery.completed',
  BanAdded: 'defense.ban.added',
  CryptoRotated: 'defense.crypto.rotated',
  TrustReassessed: 'defense.trust.reassessed',
  FindingResolved: 'defense.finding.resolved',
} as const);

/** Bus events this module watches for detection + risk correlation. */
export const WATCHED_EVENTS = [
  'security.auth.denied',
  'security.user.login',
  'security.permission.denied',
  'security.session.revoked',
] as const;

export class ActiveDefenseModule implements IModule {
  readonly id = 'active-defense';
  readonly tags = ['core', 'security', 'defense'] as const;
  readonly dependsOn = [] as const;

  readonly engine = new AdaptiveDefenseEngine((event, payload) => {
    try {
      void this.api?.bus.emit(event, payload);
    } catch { /* bus may not be ready during init */ }
  });

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  private unsubs: Array<() => void> = [];

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('active-defense', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('active-defense module initialized');
  }

  async start(kernel: KernelApi): Promise<void> {
    // Correlate platform security telemetry into findings + risk signals.
    for (const ev of WATCHED_EVENTS) {
      const h = (payload: unknown): void => this.onSecurityEvent(ev, (payload ?? {}) as Record<string, unknown>);
      kernel.bus.on(ev, h);
      this.unsubs.push(() => kernel.bus.off(ev, h));
    }
  }

  async stop(_kernel: KernelApi): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  // ---- telemetry -----------------------------------------------------------

  private onSecurityEvent(type: string, payload: Record<string, unknown>): void {
    const actor = typeof payload.userId === 'string' ? payload.userId
      : typeof payload.username === 'string' ? payload.username : undefined;
    switch (type) {
      case 'security.auth.denied':
        this.engine.detection.ingest({ type, actor, context: payload });
        if (actor) this.engine.ingestRisk(actor, { type: 'login_failed', context: 'auth' });
        break;
      case 'security.user.login':
        this.engine.detection.ingest({ type, actor, context: payload });
        break;
      case 'security.permission.denied':
        this.engine.detection.ingest({ type, actor, severity: 'high', title: 'Permission escalation attempt', context: payload });
        if (actor) this.engine.ingestRisk(actor, { type: 'permission_escalation_attempt', context: 'rbac' });
        break;
      case 'security.session.revoked':
        if (actor) this.engine.ingestRisk(actor, { type: 'session_anomaly', context: 'session' });
        break;
      default:
        break;
    }
  }

  /** Direct telemetry ingestion (gateway hooks, SDKs, other modules). */
  ingest(event: { type: string; actor?: string; severity?: FindingSeverity; title?: string; detail?: string; context?: Record<string, unknown> }): Finding | undefined {
    const finding = this.engine.ingest(event);
    if (finding) void this.recordMemory('defense_finding', `finding ${finding.rule} (${finding.severity})`, { findingId: finding.id, rule: finding.rule });
    return finding;
  }

  ingestRisk(userId: string, signal: RiskSignal): void {
    this.engine.ingestRisk(userId, signal);
  }

  // ---- risk / access ----------------------------------------------------------

  risk(userId: string): { score: number; level: RiskLevel; signals: RiskSignal[] } | undefined {
    const a = this.engine.risk.assess(userId);
    return a ? { score: a.score, level: a.level, signals: a.signals } : undefined;
  }

  evaluateAccess(userId: string, resource = 'standard'): { decision: 'allow' | 'step_up' | 'deny'; reason: string; risk: RiskLevel } {
    return this.engine.evaluateAccess(userId, resource);
  }

  isBlocked(userId: string): boolean {
    return this.engine.isBlocked(userId);
  }

  reassessTrust(userId: string): void {
    this.engine.reassessTrust(userId);
  }

  // ---- findings ------------------------------------------------------------------

  findings(filter?: { severity?: FindingSeverity; status?: Finding['status'] }): Finding[] {
    return this.engine.detection.list(filter);
  }
  acknowledgeFinding(id: string): Finding | undefined { return this.engine.detection.acknowledge(id); }
  resolveFinding(id: string): Finding | undefined {
    const finding = this.engine.detection.resolve(id);
    if (finding) {
      try { void this.api?.bus.emit(DefenseEvents.FindingResolved, { id: finding.id, rule: finding.rule }); } catch { /* bus not ready */ }
    }
    return finding;
  }
  updateSignature(ruleId: string, patch: Partial<DetectionRule>): DetectionRule | undefined { return this.engine.updateSignature(ruleId, patch); }
  adaptThreshold(ruleId: string, delta: { burst?: number; windowMs?: number }): DetectionRule | undefined { return this.engine.adaptThreshold(ruleId, delta); }

  // ---- deception -----------------------------------------------------------------

  createHoneytoken(input: { label: string; value: string; placement: string; oneTime?: boolean }) {
    return this.engine.deception.createHoneytoken(input);
  }
  listHoneytokens() { return this.engine.deception.listHoneytokens(); }
  checkHoneytoken(value: string, source?: string, context?: Record<string, unknown>) {
    return this.engine.deception.checkHoneytoken(value, source, context);
  }
  registerDecoy(input: { name: string; kind: 'api' | 'service' | 'database' | 'credential'; endpoint?: string }) {
    return this.engine.deception.registerDecoy(input);
  }
  listDecoys() { return this.engine.deception.listDecoys(); }
  probeDecoy(name: string, source?: string, context?: Record<string, unknown>) {
    return this.engine.deception.probeDecoy(name, source, context);
  }
  touches() { return this.engine.deception.listTouches(); }

  // ---- containment / bans ------------------------------------------------------------

  contain(input: { kind: ContainmentKind; target: string; reason: string; requestedBy?: string }): ContainmentAction {
    const action = this.engine.contain(input);
    void this.recordMemory('defense_action', `containment ${action.kind} on ${action.target} [${action.status}]`, { actionId: action.id });
    return action;
  }
  listActions(filter?: { status?: ContainmentAction['status']; kind?: ContainmentKind }) { return this.engine.listActions(filter); }
  approveAction(id: string, approver: string) { return this.engine.approveAction(id, approver); }
  denyAction(id: string, approver: string, reason?: string) { return this.engine.denyAction(id, approver, reason); }

  ban(input: { scope: BanScope; value: string; reason: string; durationMs?: number; createdBy?: string }): BanRecord {
    return this.engine.ban(input);
  }
  isBanned(scope: BanScope, value: string): boolean { return this.engine.isBanned(scope, value); }
  listBans(): BanRecord[] { return this.engine.listBans(); }
  liftBan(id: string): boolean { return this.engine.liftBan(id); }

  // ---- dynamic defense / recovery / improvement -------------------------------------

  rotateCryptoMaterial(scope: string, minIntervalMs?: number) { return this.engine.rotateCryptoMaterial(scope, minIntervalMs); }
  validateRuntimeIntegrity(manifest: Array<{ path: string; sha256: string }>) { return this.engine.validateRuntimeIntegrity(manifest); }
  recover(input: { target: string; fromSnapshot?: string }): RecoveryRun {
    const run = this.engine.recover(input);
    void this.recordMemory('defense_recovery', `recovery of ${input.target} ${run.stage}`, { runId: run.id });
    return run;
  }
  recoveryRuns(): RecoveryRun[] { return this.engine.recoveryRuns(); }

  recordIncident(input: { title: string; severity: FindingSeverity; findingIds?: string[]; actionIds?: string[] }): IncidentRecord {
    const incident = this.engine.recordIncident(input);
    void this.recordMemory('defense_incident', `incident ${incident.title} (${incident.severity})`, { incidentId: incident.id });
    return incident;
  }
  listIncidents(): IncidentRecord[] { return this.engine.listIncidents(); }
  reviewIncident(id: string, input: { rca: string; lessonsLearned: string[] }) { return this.engine.reviewIncident(id, input); }

  stats(): DefenseStats { return this.engine.stats(); }
  report(): DefenseReport { return this.engine.report(); }

  // ---- internals -----------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['defense', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}

export { AdaptiveDefenseEngine, APPROVAL_GATED_KINDS, RESOURCE_TIERS } from './defense.js';
export { DetectionEngine, DEFAULT_RULES } from './detection.js';
export { RiskEngine, SIGNAL_WEIGHTS, RISK_BANDS } from './risk.js';
export { DeceptionEngine } from './deception.js';
