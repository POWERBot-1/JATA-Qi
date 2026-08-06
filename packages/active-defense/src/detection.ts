// Detection engine — correlates telemetry into severity-rated findings with
// window-based deduplication.

import { randomUUID } from 'node:crypto';
import type { Finding, FindingSeverity, FindingStatus } from './types.js';

export interface DetectionEvent {
  type: string;
  actor?: string;
  severity?: FindingSeverity;
  title?: string;
  detail?: string;
  context?: Record<string, unknown>;
}

export interface DetectionRule {
  id: string;
  /** Event types this rule watches (exact match). */
  eventTypes: string[];
  severity: FindingSeverity;
  title: string;
  /** Dedupe window in ms — repeated events collapse into one finding. */
  windowMs: number;
  /** Optional burst threshold: only fire after N events in the window. */
  burst?: number;
}

export const DEFAULT_RULES: DetectionRule[] = [
  { id: 'failed_login_burst', eventTypes: ['security.auth.denied'], severity: 'medium', title: 'Repeated authentication failures', windowMs: 60_000, burst: 3 },
  { id: 'honeytoken_touch', eventTypes: ['defense.honeytoken.touched'], severity: 'critical', title: 'Honeytoken touched', windowMs: 300_000 },
  { id: 'decoy_probe', eventTypes: ['defense.decoy.probed'], severity: 'high', title: 'Decoy service probed', windowMs: 300_000 },
  { id: 'login_new_device', eventTypes: ['security.user.login'], severity: 'info', title: 'New device login', windowMs: 300_000 },
  { id: 'permission_escalation', eventTypes: ['security.permission.denied'], severity: 'high', title: 'Permission escalation attempt', windowMs: 300_000 },
  { id: 'integrity_mismatch', eventTypes: ['defense.integrity.mismatch'], severity: 'high', title: 'Runtime integrity mismatch', windowMs: 300_000 },
];

/** Detection engine: ingest telemetry → deduped, severity-rated findings. */
export class DetectionEngine {
  private findings: Finding[] = [];
  private rules: DetectionRule[] = [...DEFAULT_RULES];
  /** ruleId → event counts (sliding windows). */
  private counts = new Map<string, Array<{ ts: number; actor?: string }>>();
  /** ruleId → last finding id (dedupe). */
  private lastByRule = new Map<string, string>();

  constructor(rules: DetectionRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  /** Add or update a detection rule (dynamic defense). */
  upsertRule(rule: DetectionRule): void {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) this.rules[idx] = rule;
    else this.rules.push(rule);
  }

  rulesList(): DetectionRule[] {
    return [...this.rules];
  }

  ingest(ev: DetectionEvent): Finding | undefined {
    const now = Date.now();
    let fired: Finding | undefined;
    for (const rule of this.rules) {
      if (!rule.eventTypes.includes(ev.type)) continue;
      const bucket = this.counts.get(rule.id) ?? [];
      bucket.push({ ts: now, actor: ev.actor });
      const window = bucket.filter((b) => now - b.ts <= rule.windowMs);
      this.counts.set(rule.id, window);
      if (rule.burst && window.length < rule.burst) continue;
      // Dedupe within the window.
      const lastId = this.lastByRule.get(rule.id);
      const last = lastId ? this.findings.find((f) => f.id === lastId) : undefined;
      if (last && now - last.createdAt <= rule.windowMs) {
        if (ev.actor && last.actor !== ev.actor) {
          last.actor = `${last.actor},${ev.actor}`;
        }
        continue;
      }
      const finding: Finding = {
        id: randomUUID(),
        rule: rule.id,
        severity: ev.severity ?? rule.severity,
        title: ev.title ?? rule.title,
        ...(ev.detail ? { detail: ev.detail } : {}),
        ...(ev.actor ? { actor: ev.actor } : {}),
        ...(ev.context ? { context: ev.context } : {}),
        status: 'open',
        createdAt: now,
      };
      this.findings.unshift(finding);
      this.lastByRule.set(rule.id, finding.id);
      fired = finding;
    }
    return fired;
  }

  list(filter?: { severity?: FindingSeverity; status?: FindingStatus }): Finding[] {
    return this.findings.filter((f) =>
      (!filter?.severity || f.severity === filter.severity) &&
      (!filter?.status || f.status === filter.status));
  }

  get(id: string): Finding | undefined {
    return this.findings.find((f) => f.id === id);
  }

  acknowledge(id: string): Finding | undefined {
    return this.setStatus(id, 'acknowledged');
  }

  resolve(id: string): Finding | undefined {
    const f = this.setStatus(id, 'resolved');
    if (f) f.resolvedAt = Date.now();
    return f;
  }

  private setStatus(id: string, status: FindingStatus): Finding | undefined {
    const f = this.findings.find((x) => x.id === id);
    if (!f) return undefined;
    f.status = status;
    return f;
  }

  bySeverity(): Record<FindingSeverity, number> {
    const out: Record<FindingSeverity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
    for (const f of this.findings) if (f.status === 'open') out[f.severity] += 1;
    return out;
  }
}
