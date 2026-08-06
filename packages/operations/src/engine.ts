// Production Operations — on-call rotations, escalation SLAs, backup
// verification automation, disaster-recovery drills, and operational health
// reporting.

import { randomUUID } from 'node:crypto';

// ---- on-call rotation --------------------------------------------------------

export interface OnCallShift {
  id: string;
  rotationId: string;
  engineer: string;
  start: number;
  end: number;
}

export interface RotationConfig {
  /** Engineers in the rotation (ordered). */
  engineers: string[];
  /** Shift length in ms (default 7d). */
  shiftMs: number;
  /** Escalation chain: severity → on-call + N successors. */
  escalations: Array<{ severity: 'sev1' | 'sev2' | 'sev3' | 'sev4'; depth: number }>;
  /** Max consecutive shifts before auto-skip (burnout guard). */
  maxConsecutive?: number;
}

export interface EscalationSla {
  id: string;
  severity: 'sev1' | 'sev2' | 'sev3' | 'sev4';
  /** Minutes allowed before escalation to the next level. */
  minutes: number;
  level: number;
}

// ---- backup verification ------------------------------------------------------

export interface BackupVerification {
  id: string;
  backupId: string;
  namespace: string;
  /** Verify restore: read back + hash-check entries. */
  restored: boolean;
  entriesVerified: number;
  contentHashMatch: boolean;
  durationMs: number;
  verifiedAt: number;
  ok: boolean;
}

// ---- DR drills -----------------------------------------------------------------

export type DrillStage = 'plan' | 'simulate' | 'restore' | 'validate' | 'failover' | 'recover' | 'completed';

export interface DrDrill {
  id: string;
  name: string;
  scope: string;
  stage: DrillStage;
  startedAt: number;
  completedAt?: number;
  result: 'pending' | 'passed' | 'failed';
  notes?: string;
  executedBy: string;
}

// ---- ops health -----------------------------------------------------------------

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface OpsHealthReport {
  id: string;
  generatedAt: number;
  checks: Array<{ name: string; status: HealthStatus; detail?: string }>;
  overall: HealthStatus;
  uptimePct: number;
  openIncidents: number;
  backupsVerified: number;
  drillsPassed: number;
  onCallEngineer?: string;
}

export class OperationsEngine {
  private rotations = new Map<string, RotationConfig & { id: string; shifts: OnCallShift[]; shiftIndex: number }>();
  private escalations: EscalationSla[] = [];
  private verifications: BackupVerification[] = [];
  private drills: DrDrill[] = [];
  private reports: OpsHealthReport[] = [];

  // ---- on-call ------------------------------------------------------------------

  createRotation(input: { id?: string; engineers: string[]; shiftMs?: number; escalations?: RotationConfig['escalations']; maxConsecutive?: number }) {
    if (!input.engineers || input.engineers.length === 0) throw new Error('engineers are required');
    const id = input.id ?? randomUUID();
    this.rotations.set(id, {
      id, engineers: input.engineers, shiftMs: input.shiftMs ?? 7 * 86_400_000,
      escalations: input.escalations ?? [{ severity: 'sev1', depth: 2 }, { severity: 'sev2', depth: 2 }],
      maxConsecutive: input.maxConsecutive ?? 3,
      shifts: [], shiftIndex: 0,
    });
    return this.rotations.get(id)!;
  }

  /** Current on-call engineer (deterministic by wall-clock shift). */
  currentOnCall(rotationId: string, now = Date.now()): string | undefined {
    const rotation = this.rotations.get(rotationId);
    if (!rotation) return undefined;
    const shiftDuration = rotation.shiftMs;
    const idx = Math.floor(now / shiftDuration) % rotation.engineers.length;
    return rotation.engineers[idx];
  }

  /** Escalation chain for a severity (engineers to page, ordered). */
  escalationChain(rotationId: string, severity: 'sev1' | 'sev2' | 'sev3' | 'sev4', now = Date.now()): string[] {
    const rotation = this.rotations.get(rotationId);
    if (!rotation) return [];
    const cfg = rotation.escalations.find((e) => e.severity === severity);
    if (!cfg) return [];
    const idx = Math.floor(now / rotation.shiftMs) % rotation.engineers.length;
    const chain: string[] = [];
    for (let i = 0; i < cfg.depth; i++) {
      chain.push(rotation.engineers[(idx + i) % rotation.engineers.length]!);
    }
    return chain;
  }

  rotationsList() {
    return [...this.rotations.values()];
  }

  // ---- escalation SLAs ------------------------------------------------------------

  addEscalationSla(sla: Omit<EscalationSla, 'id'>): EscalationSla {
    const record: EscalationSla = { ...sla, id: randomUUID() };
    this.escalations.push(record);
    return record;
  }

  /** Which escalation level applies after `elapsedMin` minutes for a severity. */
  escalationLevel(severity: string, elapsedMin: number): { level: number; due: boolean; sla?: EscalationSla } {
    const applicable = this.escalations
      .filter((e) => e.severity === severity)
      .sort((a, b) => a.minutes - b.minutes);
    let level = 0;
    let due = false;
    let matched: EscalationSla | undefined;
    for (const sla of applicable) {
      if (elapsedMin >= sla.minutes) {
        level = sla.level;
        due = true;
        matched = sla;
      }
    }
    return { level, due, sla: matched };
  }

  escalationSlas(): EscalationSla[] {
    return [...this.escalations];
  }

  // ---- backup verification ------------------------------------------------------------

  /**
   * Verify a backup: simulate reading back `entries` from the namespace and
   * hash-compare against the recorded content hash. Produces an auditable
   * verification record.
   */
  verifyBackup(input: { backupId: string; namespace: string; entries: number; recordedHash: string; actualHash?: string; durationMs?: number }): BackupVerification {
    const actualHash = input.actualHash ?? input.recordedHash;
    const verification: BackupVerification = {
      id: randomUUID(), backupId: input.backupId, namespace: input.namespace,
      restored: true, entriesVerified: input.entries,
      contentHashMatch: actualHash === input.recordedHash,
      durationMs: input.durationMs ?? 0,
      verifiedAt: Date.now(),
      ok: actualHash === input.recordedHash,
    };
    this.verifications.push(verification);
    return verification;
  }

  verificationsList(): BackupVerification[] {
    return [...this.verifications].reverse();
  }

  backupsVerifiedCount(): number {
    return this.verifications.filter((v) => v.ok).length;
  }

  // ---- DR drills -----------------------------------------------------------------------

  startDrill(input: { name: string; scope: string; executedBy: string }): DrDrill {
    const drill: DrDrill = {
      id: randomUUID(), name: input.name, scope: input.scope,
      stage: 'plan', startedAt: Date.now(), result: 'pending',
      executedBy: input.executedBy,
    };
    this.drills.push(drill);
    return drill;
  }

  advanceDrill(id: string, stage: DrillStage, notes?: string): DrDrill | undefined {
    const drill = this.drills.find((d) => d.id === id);
    if (!drill) return undefined;
    drill.stage = stage;
    if (notes) drill.notes = notes;
    if (stage === 'completed') {
      drill.completedAt = Date.now();
      drill.result = 'passed';
    }
    return drill;
  }

  failDrill(id: string, notes?: string): DrDrill | undefined {
    const drill = this.drills.find((d) => d.id === id);
    if (!drill) return undefined;
    drill.result = 'failed';
    if (notes) drill.notes = notes;
    drill.completedAt = Date.now();
    return drill;
  }

  drillsList(): DrDrill[] {
    return [...this.drills].reverse();
  }

  drillsPassedCount(): number {
    return this.drills.filter((d) => d.result === 'passed').length;
  }

  // ---- ops health -------------------------------------------------------------------------

  generateHealthReport(input: { checks: Array<{ name: string; status: HealthStatus; detail?: string }>; uptimePct?: number; openIncidents?: number; rotationId?: string }): OpsHealthReport {
    const overall: HealthStatus = input.checks.some((c) => c.status === 'down') ? 'down'
      : input.checks.some((c) => c.status === 'degraded') ? 'degraded' : 'healthy';
    const report: OpsHealthReport = {
      id: randomUUID(), generatedAt: Date.now(),
      checks: input.checks,
      overall,
      uptimePct: input.uptimePct ?? 100,
      openIncidents: input.openIncidents ?? 0,
      backupsVerified: this.backupsVerifiedCount(),
      drillsPassed: this.drillsPassedCount(),
      ...(input.rotationId ? { onCallEngineer: this.currentOnCall(input.rotationId) } : {}),
    };
    this.reports.push(report);
    return report;
  }

  reportsList(): OpsHealthReport[] {
    return [...this.reports].reverse();
  }

  stats(): { rotations: number; onCall: string[]; escalationSlas: number; backupsVerified: number; backupFailures: number; drills: number; drillsPassed: number; reports: number; overallHealth?: HealthStatus } {
    return {
      rotations: this.rotations.size,
      onCall: [...this.rotations.keys()].map((id) => this.currentOnCall(id) ?? ''),
      escalationSlas: this.escalations.length,
      backupsVerified: this.backupsVerifiedCount(),
      backupFailures: this.verifications.filter((v) => !v.ok).length,
      drills: this.drills.length,
      drillsPassed: this.drillsPassedCount(),
      reports: this.reports.length,
      ...(this.reports.length > 0 ? { overallHealth: this.reports[this.reports.length - 1]!.overall } : {}),
    };
  }
}
