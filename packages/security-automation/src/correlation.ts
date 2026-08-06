// Cross-pillar correlation engine.
//
// Subscribes to security events from every pillar and turns them into
// coordinated defense: auto-opened SOC incidents (severity-mapped, deduped),
// automated bans (abuse alerts → block the actor/origin), risk signals
// (insider alerts), and auto-closure when the underlying issue is remediated.

import type { SecurityIncidentRecord } from '@jataqi/soc';
import type { FindingSeverity } from '@jataqi/active-defense';
import type { ContainmentKind } from '@jataqi/active-defense';

export type IncidentSeverityLevel = 'sev1' | 'sev2' | 'sev3' | 'sev4';

export interface CorrelationRule {
  id: string;
  /** Bus event that triggers the correlation. */
  event: string;
  /** Severity mapping for the opened incident. */
  severity: IncidentSeverityLevel;
  /** Incident title (may use ${field} placeholders from the payload). */
  title: string;
  /** Dedupe: don't re-open while an open correlated incident has the same key. */
  key: string;
  /** Optional bus event that closes the correlated incident (remediation). */
  closeOn?: string;
  /** Key extracted from the close payload (${field} placeholders). */
  closeKey?: string;
  /** Auto-ban actors (payload field name) for 24h on trigger. */
  banActorsFrom?: string;
  /** Auto-ban origins (payload field name) for 24h on trigger. */
  banOriginsFrom?: string;
  /** Emit a risk signal for the actor (payload field name) on trigger. */
  riskSignalFor?: string;
  /** Risk signal type to apply. */
  riskType?: string;
}

/** Map a finding/alert severity onto the incident scale. */
export function mapSeverity(severity: string): IncidentSeverityLevel {
  switch (severity) {
    case 'critical': return 'sev1';
    case 'high': return 'sev2';
    case 'medium': return 'sev3';
    default: return 'sev4';
  }
}

export const DEFAULT_CORRELATION_RULES: CorrelationRule[] = [
  {
    id: 'correlate.defense.finding', event: 'defense.finding.created',
    severity: 'sev2', title: 'Active defense finding: ${rule}',
    key: 'defense:${rule}', closeOn: 'defense.finding.resolved', closeKey: 'defense:${rule}',
  },
  {
    id: 'correlate.supplychain.vulnerable', event: 'supplychain.dependency.vulnerable',
    severity: 'sev2', title: 'Supply chain: ${count} vulnerable dependency(-ies)',
    key: 'supplychain:vulnerable',
  },
  {
    id: 'correlate.supplychain.mismatch', event: 'supplychain.deployment.mismatch',
    severity: 'sev1', title: 'Deployment integrity mismatch: ${artifactName} → ${environment}',
    key: 'supplychain:mismatch:${artifactName}:${environment}',
  },
  {
    id: 'correlate.supplychain.drift', event: 'supplychain.integrity.drift',
    severity: 'sev2', title: 'Integrity drift on release ${release}',
    key: 'supplychain:drift:${release}',
  },
  {
    id: 'correlate.resilience.failover', event: 'resilience.failover.completed',
    severity: 'sev3', title: 'Automated failover ${from} → ${to} (${workload})',
    key: 'resilience:region:${to}',
    closeOn: 'resilience.region.health', closeKey: 'resilience:region:${region}',
  },
  {
    id: 'correlate.resilience.slo', event: 'resilience.slo.violated',
    severity: 'sev2', title: 'SLO violated for ${workload} (uptime ${uptime} < ${slo})',
    key: 'resilience:slo:${workload}',
  },
  {
    id: 'correlate.resilience.dr', event: 'resilience.dr.executed',
    severity: 'sev2', title: 'DR execution ${status} for ${workload}',
    key: 'resilience:dr:${workload}:${status}',
  },
  {
    id: 'correlate.infra.firmware', event: 'infra.firmware.mismatch',
    severity: 'sev2', title: 'Firmware mismatch on asset ${serial}',
    key: 'infra:firmware:${serial}',
  },
  {
    id: 'correlate.infra.drift', event: 'infra.config.drift',
    severity: 'sev3', title: 'Config drift on ${assetId}: ${key}',
    key: 'infra:drift:${assetId}:${key}',
  },
  {
    id: 'correlate.abuse.alert', event: 'soc.abuse.alert',
    severity: 'sev2', title: 'Abuse alert [${rule}]: ${message}',
    key: 'soc:abuse:${id}',
    banActorsFrom: 'actors', banOriginsFrom: 'origins',
  },
  {
    id: 'correlate.insider.alert', event: 'soc.insider.alert',
    severity: 'sev3', title: 'Insider risk [${rule}]: ${message}',
    key: 'soc:insider:${id}',
    riskSignalFor: 'actor', riskType: 'insider_misuse',
  },
];

export interface CorrelatedIncident {
  /** SOC incident id. */
  incidentId: string;
  ruleId: string;
  key: string;
  severity: IncidentSeverityLevel;
  title: string;
  openedAt: number;
  closedAt?: number;
}

export interface CorrelationSink {
  openIncident(input: { title: string; severity: string; commander?: string; responders?: string[] }): SecurityIncidentRecord;
  transitionIncident(id: string, status: string, by: string, note: string): SecurityIncidentRecord | undefined;
  ban(input: { scope: 'user' | 'ip' | 'token'; value: string; reason: string; durationMs?: number; createdBy?: string }): unknown;
  riskSignal(userId: string, signal: { type: string; context?: string }): void;
}

export function interpolate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (_m, field: string) => {
    const value = payload[field];
    return value === undefined || value === null ? '' : String(value);
  });
}

export class CorrelationEngine {
  private rules: CorrelationRule[];
  private correlated: CorrelatedIncident[] = [];
  private sink: CorrelationSink;
  private readonly defaultBanMs = 24 * 3600_000;

  constructor(sink: CorrelationSink, rules: CorrelationRule[] = DEFAULT_CORRELATION_RULES) {
    this.sink = sink;
    // Copy so per-engine rule upserts never mutate the shared default set.
    this.rules = [...rules];
  }

  rulesList(): CorrelationRule[] {
    return [...this.rules];
  }

  upsertRule(rule: CorrelationRule): void {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) this.rules[idx] = rule;
    else this.rules.push(rule);
  }

  correlatedList(): CorrelatedIncident[] {
    return [...this.correlated].reverse();
  }

  openCount(): number {
    return this.correlated.filter((c) => !c.closedAt).length;
  }

  /** Ingest a bus event; returns the correlated incident (or undefined on dedupe). */
  ingest(event: string, payload: Record<string, unknown>): CorrelatedIncident | undefined {
    // Close path first.
    for (const rule of this.rules) {
      if (rule.closeOn === event) {
        const closeKey = rule.closeKey ? interpolate(rule.closeKey, payload) : undefined;
        if (closeKey !== undefined) {
          const match = this.correlated.find((c) => c.key === closeKey && !c.closedAt);
          if (match) {
            match.closedAt = Date.now();
            this.sink.transitionIncident(match.incidentId, 'closed', 'secauto', `auto-closed: ${event}`);
            return match;
          }
        }
      }
    }
    // Open path.
    for (const rule of this.rules) {
      if (rule.event !== event) continue;
      const key = interpolate(rule.key, payload);
      if (this.correlated.some((c) => c.key === key && !c.closedAt)) {
        return undefined; // dedupe — incident already open
      }
      const title = interpolate(rule.title, payload);
      const incident = this.sink.openIncident({
        title, severity: rule.severity, commander: 'soc-auto',
        responders: ['secauto'],
      });
      const record: CorrelatedIncident = {
        incidentId: incident.id, ruleId: rule.id, key, severity: rule.severity,
        title, openedAt: Date.now(),
      };
      this.correlated.push(record);
      // Automated containment within authorized boundaries.
      if (rule.banActorsFrom) {
        for (const actor of asArray(payload[rule.banActorsFrom])) {
          this.sink.ban({ scope: 'user', value: actor, reason: `auto-ban from ${rule.id}`, durationMs: this.defaultBanMs, createdBy: 'secauto' });
        }
      }
      if (rule.banOriginsFrom) {
        for (const origin of asArray(payload[rule.banOriginsFrom])) {
          this.sink.ban({ scope: 'ip', value: origin, reason: `auto-ban from ${rule.id}`, durationMs: this.defaultBanMs, createdBy: 'secauto' });
        }
      }
      if (rule.riskSignalFor) {
        const actor = typeof payload[rule.riskSignalFor] === 'string' ? payload[rule.riskSignalFor] as string : undefined;
        if (actor) this.sink.riskSignal(actor, { type: rule.riskType ?? 'suspicious_activity', context: rule.id });
      }
      return record;
    }
    return undefined;
  }
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

export type { FindingSeverity, ContainmentKind };
