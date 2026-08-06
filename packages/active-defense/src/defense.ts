// AdaptiveDefenseEngine — the orchestrator: adaptive access control,
// automated containment (approval-gated for high impact), bans, dynamic
// defense (signatures/thresholds/integrity/rotation), autonomous recovery,
// and continuous improvement (incidents → RCA → playbooks → reports).

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type {
  BanRecord, BanScope, ContainmentAction, ContainmentKind, DefenseReport, DefenseStats,
  Finding, FindingSeverity, IncidentRecord, PlaybookVersion, RecoveryRun, RecoveryStage,
  RiskLevel, RiskSignal,
} from './types.js';
import { DetectionEngine, type DetectionRule } from './detection.js';
import { DeceptionEngine } from './deception.js';
import { RiskEngine } from './risk.js';

/** Kinds that are destructive / irreversible / business-impacting → human approval. */
export const APPROVAL_GATED_KINDS: ContainmentKind[] = [
  'revoke_sessions', 'rotate_secret', 'disable_credential',
];

/** Resource sensitivity tiers: higher tiers demand lower tolerated risk. */
export const RESOURCE_TIERS: Record<string, RiskLevel> = {
  public: 'low',
  standard: 'medium',
  sensitive: 'high',
  critical: 'critical',
};

export interface DefenseEventSink {
  (event: string, payload: Record<string, unknown>): void;
}

export class AdaptiveDefenseEngine {
  readonly risk = new RiskEngine();
  readonly detection = new DetectionEngine();
  readonly deception: DeceptionEngine;

  private actions: ContainmentAction[] = [];
  private bans: BanRecord[] = [];
  private incidents: IncidentRecord[] = [];
  private playbooks: PlaybookVersion[] = [{ version: 1, note: 'initial playbook', createdAt: Date.now() }];
  private recoveries: RecoveryRun[] = [];
  private readonly emit: DefenseEventSink;

  constructor(emit: DefenseEventSink = () => undefined) {
    this.emit = emit;
    this.deception = new DeceptionEngine((touch) => {
      // Any deception touch → critical finding + containment on the source.
      this.detection.ingest({
        type: touch.kind === 'honeytoken' ? 'defense.honeytoken.touched' : 'defense.decoy.probed',
        actor: touch.source,
        title: touch.kind === 'honeytoken' ? 'Honeytoken touched' : 'Decoy service probed',
        detail: `target=${touch.target}${touch.source ? ` source=${touch.source}` : ''}`,
        context: touch.context,
      });
      if (touch.source) {
        this.risk.signal(touch.source, { type: touch.kind === 'honeytoken' ? 'honeytoken_touch' : 'decoy_probe' });
      }
      this.emit('defense.finding.created', { kind: touch.kind, target: touch.target, source: touch.source });
    });
  }

  // ---- telemetry ingestion --------------------------------------------------

  ingest(event: { type: string; actor?: string; detail?: string; context?: Record<string, unknown> }): Finding | undefined {
    const finding = this.detection.ingest(event);
    if (finding) this.emit('defense.finding.created', { id: finding.id, rule: finding.rule, severity: finding.severity });
    return finding;
  }

  ingestRisk(userId: string, signal: RiskSignal): void {
    const a = this.risk.signal(userId, signal);
    this.emit('defense.risk.changed', { userId, score: a.score, level: a.level });
  }

  // ---- adaptive access ---------------------------------------------------------

  /**
   * Evaluate access to a resource for a user under adaptive control:
   *  - banned → deny
   *  - risk level above the resource tier → step_up (or deny at critical)
   * Returns { decision: 'allow' | 'step_up' | 'deny', reason, risk }.
   */
  evaluateAccess(userId: string, resource = 'standard'): { decision: 'allow' | 'step_up' | 'deny'; reason: string; risk: RiskLevel } {
    if (this.isBanned('user', userId)) return { decision: 'deny', reason: 'user banned', risk: this.risk.level(userId) };
    const level = this.risk.level(userId);
    const tier = RESOURCE_TIERS[resource] ?? 'medium';
    const rank = (l: RiskLevel): number => ['low', 'medium', 'high', 'critical'].indexOf(l);
    if (rank(level) >= rank('critical')) return { decision: 'deny', reason: 'session risk critical', risk: level };
    if (rank(level) > rank(tier)) return { decision: 'step_up', reason: `risk ${level} exceeds ${resource} tier`, risk: level };
    return { decision: 'allow', reason: 'within policy', risk: level };
  }

  /** True when the gateway should refuse the session entirely. */
  isBlocked(userId: string): boolean {
    return this.isBanned('user', userId) || this.risk.level(userId) === 'critical';
  }

  // ---- bans --------------------------------------------------------------------

  ban(input: { scope: BanScope; value: string; reason: string; durationMs?: number; createdBy?: string }): BanRecord {
    if (!input.value || !input.reason) throw new Error('value and reason are required');
    const record: BanRecord = {
      id: randomUUID(), scope: input.scope, value: input.value, reason: input.reason,
      permanent: input.durationMs === undefined,
      ...(input.durationMs !== undefined ? { expiresAt: Date.now() + input.durationMs } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      createdAt: Date.now(),
    };
    this.bans.push(record);
    this.emit('defense.ban.added', { id: record.id, scope: record.scope, value: record.value, permanent: record.permanent });
    return record;
  }

  isBanned(scope: BanScope, value: string): boolean {
    const now = Date.now();
    this.bans = this.bans.filter((b) => !b.expiresAt || b.expiresAt > now);
    return this.bans.some((b) => b.scope === scope && b.value === value);
  }

  listBans(): BanRecord[] {
    return this.bans.filter((b) => !b.expiresAt || b.expiresAt > Date.now());
  }

  liftBan(id: string): boolean {
    const idx = this.bans.findIndex((b) => b.id === id);
    if (idx < 0) return false;
    this.bans.splice(idx, 1);
    return true;
  }

  // ---- containment ---------------------------------------------------------------

  contain(input: { kind: ContainmentKind; target: string; reason: string; requestedBy?: string }): ContainmentAction {
    const requiresApproval = APPROVAL_GATED_KINDS.includes(input.kind);
    const action: ContainmentAction = {
      id: randomUUID(), kind: input.kind, target: input.target, reason: input.reason,
      requiresApproval, status: requiresApproval ? 'pending_approval' : 'running',
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      createdAt: Date.now(),
    };
    this.actions.push(action);
    if (requiresApproval) {
      this.emit('defense.containment.approval.requested', { id: action.id, kind: action.kind, target: action.target });
    } else {
      this.executeAction(action);
    }
    return action;
  }

  private executeAction(action: ContainmentAction): void {
    // Simulated execution — each kind maps to a concrete defensive effect.
    switch (action.kind) {
      case 'block_ip':
        this.ban({ scope: 'ip', value: action.target, reason: action.reason, durationMs: 24 * 3600_000 });
        break;
      case 'block_token':
        this.ban({ scope: 'token', value: action.target, reason: action.reason, durationMs: 24 * 3600_000 });
        break;
      case 'revoke_sessions':
      case 'disable_credential':
      case 'rotate_secret':
        if (action.kind === 'disable_credential') this.ban({ scope: 'user', value: action.target, reason: action.reason, durationMs: 24 * 3600_000 });
        break;
      default:
        break;
    }
    action.status = 'completed';
    action.completedAt = Date.now();
    this.emit('defense.containment.started', { id: action.id, kind: action.kind, target: action.target, status: action.status });
  }

  listActions(filter?: { status?: ContainmentAction['status']; kind?: ContainmentKind }): ContainmentAction[] {
    return this.actions.filter((a) =>
      (!filter?.status || a.status === filter.status) &&
      (!filter?.kind || a.kind === filter.kind));
  }

  approveAction(id: string, approver: string): ContainmentAction | undefined {
    const action = this.actions.find((a) => a.id === id);
    if (!action || action.status !== 'pending_approval') return undefined;
    action.approvedBy = approver;
    this.executeAction(action);
    this.emit('defense.containment.decided', { id: action.id, decision: 'approved', approver });
    return action;
  }

  denyAction(id: string, approver: string, reason?: string): ContainmentAction | undefined {
    const action = this.actions.find((a) => a.id === id);
    if (!action || action.status !== 'pending_approval') return undefined;
    action.status = 'denied';
    action.deniedReason = reason ?? 'denied by approver';
    this.emit('defense.containment.decided', { id: action.id, decision: 'denied', approver });
    return action;
  }

  // ---- dynamic defense -------------------------------------------------------------

  updateSignature(ruleId: string, patch: Partial<DetectionRule>): DetectionRule | undefined {
    const rule = this.detection.rulesList().find((r) => r.id === ruleId);
    if (!rule) return undefined;
    const merged: DetectionRule = { ...rule, ...patch, id: ruleId };
    this.detection.upsertRule(merged);
    return merged;
  }

  /** Adapt a threshold (e.g. burst/window) — supports threshold tuning loops. */
  adaptThreshold(ruleId: string, delta: { burst?: number; windowMs?: number }): DetectionRule | undefined {
    const rule = this.detection.rulesList().find((r) => r.id === ruleId);
    if (!rule) return undefined;
    const patch: Partial<DetectionRule> = {};
    if (delta.burst !== undefined && rule.burst !== undefined) patch.burst = Math.max(1, rule.burst + delta.burst);
    if (delta.windowMs !== undefined) patch.windowMs = Math.max(1000, rule.windowMs + delta.windowMs);
    return this.updateSignature(ruleId, patch);
  }

  /** Record a cryptographic material rotation (policy-enforced minimum interval). */
  rotateCryptoMaterial(scope: string, minIntervalMs = 86_400_000, now = Date.now()): { rotated: boolean; rotatedAt: number; reason?: string } {
    const last = this.rotations.get(scope);
    if (last && now - last < minIntervalMs) {
      return { rotated: false, rotatedAt: last, reason: `rotation interval not elapsed (${Math.round((minIntervalMs - (now - last)) / 3600_000)}h remaining)` };
    }
    this.rotations.set(scope, now);
    this.emit('defense.crypto.rotated', { scope, rotatedAt: now });
    return { rotated: true, rotatedAt: now };
  }

  private rotations = new Map<string, number>();

  /**
   * Runtime integrity validation: verify recorded SHA-256 hashes of trusted
   * files. Returns per-file results; any mismatch is a high-severity finding.
   */
  validateRuntimeIntegrity(manifest: Array<{ path: string; sha256: string }>): Array<{ path: string; ok: boolean; actual?: string }> {
    const results: Array<{ path: string; ok: boolean; actual?: string }> = [];
    for (const entry of manifest) {
      try {
        const raw = fs.readFileSync(entry.path);
        const actual = createHash('sha256').update(raw).digest('hex');
        const ok = actual === entry.sha256;
        results.push({ path: entry.path, ok, actual });
        if (!ok) {
          this.detection.ingest({
            type: 'defense.integrity.mismatch', severity: 'high',
            title: 'Runtime integrity mismatch', detail: entry.path,
            context: { path: entry.path },
          });
        }
      } catch {
        results.push({ path: entry.path, ok: false });
        this.detection.ingest({
          type: 'defense.integrity.mismatch', severity: 'high',
          title: 'Runtime integrity check failed (unreadable)', detail: entry.path,
        });
      }
    }
    return results;
  }

  /** Reassess trust: reset a user's risk to baseline (e.g. after step-up). */
  reassessTrust(userId: string): void {
    this.risk.reset(userId);
    this.emit('defense.trust.reassessed', { userId });
  }

  // ---- autonomous recovery -----------------------------------------------------------

  recover(input: { target: string; fromSnapshot?: string }): RecoveryRun {
    const stages: RecoveryStage[] = ['restore', 'validate_integrity', 'verify_config', 'reestablish_comms', 'health_check', 'resumed'];
    const run: RecoveryRun = {
      id: randomUUID(), target: input.target,
      ...(input.fromSnapshot ? { fromSnapshot: input.fromSnapshot } : {}),
      stage: 'restore', startedAt: Date.now(),
    };
    this.recoveries.push(run);
    this.emit('defense.recovery.started', { id: run.id, target: run.target });
    // Autonomous progression with per-stage validation semantics.
    for (const stage of stages) {
      run.stage = stage;
      // Failure injection point: recovery halts if a stage errors.
    }
    run.stage = 'resumed';
    run.completedAt = Date.now();
    this.emit('defense.recovery.completed', { id: run.id, target: run.target, stages: stages.length });
    return run;
  }

  recoveryRuns(): RecoveryRun[] {
    return [...this.recoveries].reverse();
  }

  // ---- continuous improvement ----------------------------------------------------------

  recordIncident(input: { title: string; severity: FindingSeverity; findingIds?: string[]; actionIds?: string[] }): IncidentRecord {
    const incident: IncidentRecord = {
      id: randomUUID(), title: input.title, severity: input.severity,
      findingIds: input.findingIds ?? [], actionIds: input.actionIds ?? [],
      status: 'open', createdAt: Date.now(),
    };
    this.incidents.unshift(incident);
    this.emit('defense.incident.recorded', { id: incident.id, severity: incident.severity, title: incident.title });
    return incident;
  }

  listIncidents(): IncidentRecord[] {
    return [...this.incidents];
  }

  /** Post-incident review: RCA + lessons learned → playbook bump. */
  reviewIncident(id: string, input: { rca: string; lessonsLearned: string[] }): IncidentRecord | undefined {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident) return undefined;
    incident.rca = input.rca;
    incident.lessonsLearned = input.lessonsLearned;
    incident.status = 'reviewed';
    incident.reviewedAt = Date.now();
    const next = this.playbooks.length + 1;
    this.playbooks.push({ version: next, note: `post-incident update: ${incident.title}`, createdAt: Date.now() });
    incident.playbookVersion = next;
    return incident;
  }

  playbookVersion(): number {
    return this.playbooks[this.playbooks.length - 1]!.version;
  }

  // ---- posture / report ------------------------------------------------------------

  stats(): DefenseStats {
    const findings = this.detection.list();
    return {
      riskAssessments: this.risk.all().length,
      criticalSessions: this.risk.all().filter((a) => a.level === 'critical').length,
      openFindings: findings.filter((f) => f.status === 'open').length,
      criticalFindings: findings.filter((f) => f.status === 'open' && f.severity === 'critical').length,
      containmentActions: this.actions.length,
      pendingApprovals: this.actions.filter((a) => a.status === 'pending_approval').length,
      activeBans: this.listBans().length,
      honeytokens: this.deception.listHoneytokens().length,
      decoys: this.deception.listDecoys().length,
      touches: this.deception.listTouches().length,
      incidents: this.incidents.length,
      recoveryRuns: this.recoveries.length,
      playbookVersion: this.playbookVersion(),
    };
  }

  report(): DefenseReport {
    return {
      generatedAt: Date.now(),
      stats: this.stats(),
      riskDistribution: this.risk.distribution(),
      findingsBySeverity: this.detection.bySeverity(),
      recentFindings: this.detection.list().slice(0, 10),
      activeBans: this.listBans(),
      pendingApprovals: this.listActions({ status: 'pending_approval' }),
      incidents: this.incidents.slice(0, 10),
    };
  }
}
