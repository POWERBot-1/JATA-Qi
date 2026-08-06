// DlpEngine — Data Loss Prevention.
//
// Detects sensitive data (PII, cards, credentials, secrets, health, source
// code) in outbound content across channels, and applies configurable
// actions: allow, block, redact, quarantine, or notify. Incidents carry
// redacted evidence only (never raw content) and feed the SOC correlation
// engine for coordinated response.

import { randomUUID } from 'node:crypto';
import type { DlpAction, DlpChannel, DlpIncident, DlpPolicyStats, DlpRule, DlpScanResult, SensitiveDataType } from './types.js';

/** Shannon entropy of a string (0..~8 bits/char). */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export const DEFAULT_DLP_RULES: DlpRule[] = [
  {
    id: 'dlp.card', name: 'Payment card numbers', dataType: 'card',
    patterns: ['\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\\b'],
    action: 'redact', threshold: 1, redactionMask: '••••',
  },
  {
    id: 'dlp.email_pii', name: 'Bulk PII export', dataType: 'pii',
    patterns: ['[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'],
    action: 'block', threshold: 10,
  },
  {
    id: 'dlp.national_id', name: 'National ID numbers', dataType: 'pii',
    patterns: ['\\b\\d{7,8}\\b'],
    action: 'redact', threshold: 1, redactionMask: '••••',
  },
  {
    id: 'dlp.credential', name: 'Credentials / API keys', dataType: 'credential',
    patterns: ['(?:api[_-]?key|secret|password|token)\\s*[:=]\\s*["\']?[A-Za-z0-9_\\-]{12,}'],
    minEntropy: 3.5,
    action: 'block', threshold: 1,
  },
  {
    id: 'dlp.private_key', name: 'Private keys', dataType: 'secret',
    patterns: ['-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'],
    action: 'quarantine', threshold: 1,
  },
  {
    id: 'dlp.health', name: 'Health records', dataType: 'health',
    patterns: ['\\b(?:diagnosis|patient|medical record)\\b.{0,80}', '\\bICD-10\\b'],
    action: 'block', threshold: 3,
  },
  {
    id: 'dlp.source_code', name: 'Proprietary source markers', dataType: 'source_code',
    patterns: ['\\b(?:internal-use-only|jataqi-core|do-not-distribute)\\b'],
    action: 'notify', threshold: 1, notifyTo: ['dpo@jataqi.ai'],
  },
];

export class DlpEngine {
  private rules: DlpRule[];
  private incidents: DlpIncident[] = [];
  private scans = 0;
  private blocked = 0;
  private redacted = 0;
  private quarantined = 0;
  private onIncident: (incident: DlpIncident) => void;

  constructor(onIncident: (incident: DlpIncident) => void = () => undefined, rules: DlpRule[] = DEFAULT_DLP_RULES) {
    this.rules = [...rules];
    this.onIncident = onIncident;
  }

  rulesList(): DlpRule[] {
    return [...this.rules];
  }

  addRule(rule: DlpRule): void {
    this.rules.push(rule);
  }

  upsertRule(rule: DlpRule): void {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) this.rules[idx] = rule;
    else this.rules.push(rule);
  }

  removeRule(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    return this.rules.length < before;
  }

  /**
   * Scan content for sensitive data on a channel. Applies every matching
   * rule's action (worst-action wins: block > quarantine > redact > notify >
   * allow) and returns per-rule results + the incident (if any).
   */
  scan(input: { content: string; channel: DlpChannel; actor?: string; destination?: string }): {
    results: DlpScanResult[]; incident?: DlpIncident; action: DlpAction;
  } {
    this.scans += 1;
    const results: DlpScanResult[] = [];
    const incidents: DlpIncident[] = [];
    let redactedContent = input.content;
    let worst: DlpAction = 'allow';
    const rank: Record<DlpAction, number> = { allow: 0, notify: 1, redact: 2, quarantine: 3, block: 4 };

    for (const rule of this.rules) {
      if (rule.channels && rule.channels.length > 0 && !rule.channels.includes(input.channel)) continue;
      let matches = 0;
      let content = redactedContent;
      for (const pattern of rule.patterns) {
        const re = new RegExp(pattern, 'gi');
        for (const m of content.matchAll(re)) {
          const raw = m[0]!;
          if (rule.minEntropy !== undefined && shannonEntropy(raw) < rule.minEntropy) continue;
          matches += 1;
          if (rule.action === 'redact') {
            redactedContent = redactedContent.replace(raw, rule.redactionMask ?? '••••');
          }
        }
      }
      if (matches === 0) continue;
      const threshold = rule.threshold ?? 1;
      const triggered = matches >= threshold;
      if (!triggered) continue;
      const riskScore = Math.min(100, matches * 15 + (rule.action === 'block' ? 25 : 0));
      const action = rule.action;
      results.push({ ruleId: rule.id, dataType: rule.dataType, matches, redacted: redactedContent, riskScore, action });
      if (rank[action] > rank[worst]) worst = action;
      if (action !== 'allow') {
        const severity = action === 'block' ? 'high' : action === 'quarantine' ? 'critical' : action === 'redact' ? 'medium' : 'low';
        const incident: DlpIncident = {
          id: randomUUID(), ruleId: rule.id, dataType: rule.dataType, channel: input.channel,
          ...(input.actor ? { actor: input.actor } : {}),
          ...(input.destination ? { destination: input.destination } : {}),
          matches, action, severity,
          evidence: redactEvidence(input.content, rule.dataType),
          createdAt: Date.now(), status: 'open',
        };
        this.incidents.push(incident);
        incidents.push(incident);
        this.onIncident(incident);
      }
    }
    // Apply counters.
    if (worst === 'block') this.blocked += 1;
    else if (worst === 'quarantine') this.quarantined += 1;
    else if (worst === 'redact') this.redacted += 1;
    return { results, incident: incidents[0], action: worst };
  }

  incidentsList(filter?: { dataType?: SensitiveDataType; status?: DlpIncident['status']; channel?: DlpChannel }): DlpIncident[] {
    return this.incidents.filter((i) =>
      (!filter?.dataType || i.dataType === filter.dataType) &&
      (!filter?.status || i.status === filter.status) &&
      (!filter?.channel || i.channel === filter.channel));
  }

  updateIncident(id: string, status: DlpIncident['status']): DlpIncident | undefined {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident) return undefined;
    incident.status = status;
    return incident;
  }

  stats(): DlpPolicyStats {
    const byDataType: Record<string, number> = {};
    for (const i of this.incidents) byDataType[i.dataType] = (byDataType[i.dataType] ?? 0) + 1;
    return {
      rules: this.rules.length,
      scans: this.scans,
      incidents: this.incidents.length,
      openIncidents: this.incidents.filter((i) => i.status === 'open').length,
      blocked: this.blocked,
      redacted: this.redacted,
      quarantined: this.quarantined,
      byDataType,
    };
  }
}

/** Build evidence with only the sensitive fragments redacted (no raw content). */
function redactEvidence(content: string, dataType: SensitiveDataType): string {
  const snippet = content.length > 120 ? content.slice(0, 120) : content;
  const rules: Record<SensitiveDataType, RegExp> = {
    pii: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b\d{7,8}\b/g,
    card: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g,
    credential: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{4,}/gi,
    secret: /-----BEGIN [^-]+-----/g,
    health: /\b(?:diagnosis|patient|medical record)\b.{0,40}/gi,
    source_code: /\b(?:internal-use-only|jataqi-core)\b/gi,
  };
  return snippet.replace(rules[dataType] ?? /$^/, '••••');
}
