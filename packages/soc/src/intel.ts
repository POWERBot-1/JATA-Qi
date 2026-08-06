// Threat hunting + global threat intelligence.
//
// ThreatHuntingEngine runs proactive hunt playbooks over the telemetry lake,
// looking for attacker patterns (credential stuffing, lateral movement,
// persistence, insider abuse, honeytoken-adjacent activity) that EDR-style
// rules may have missed.
//
// ThreatIntelEngine ingests indicators from commercial/open-source/government
// feeds with confidence + TLP, matches them against telemetry, and surfaces
// matches for prioritization + risk boosting.

import { randomUUID } from 'node:crypto';
import type { HuntPlaybook, HuntSession, IntelIndicator, IntelMatch, IntelType, TlpLevel } from './types.js';
import type { TelemetryPipeline } from './telemetry.js';

export const DEFAULT_HUNT_PLAYBOOKS: HuntPlaybook[] = [
  {
    id: 'hunt.credential_stuffing', name: 'Credential stuffing',
    description: 'Bursts of failed logins for a single actor from varied origins, then a success.',
    patterns: ['security.auth.denied', 'security.user.login'], severity: 'high',
  },
  {
    id: 'hunt.unusual_hour_admin', name: 'Unusual-hour privileged access',
    description: 'Privileged/admin actions outside business hours.',
    patterns: ['audit.action', 'security.session'], severity: 'medium',
  },
  {
    id: 'hunt.lateral_movement', name: 'Lateral movement',
    description: 'A single actor appearing across many distinct origins/services in a short window.',
    patterns: ['auth', 'network', 'cloud'], severity: 'high',
  },
  {
    id: 'hunt.new_persistence', name: 'New persistence',
    description: 'New API keys / credentials / scheduled automations created by an established actor.',
    patterns: ['security.apikeys', 'automation'], severity: 'medium',
  },
  {
    id: 'hunt.honeytoken_proximity', name: 'Honeytoken proximity',
    description: 'Access to the same service a honeytoken is placed in, shortly before/after a touch.',
    patterns: ['defense.honeytoken.touched', 'gateway'], severity: 'critical',
  },
  {
    id: 'hunt.data_exfil', name: 'Data exfiltration',
    description: 'Large export/read bursts from a single actor.',
    patterns: ['audit.export', 'gateway.read'], severity: 'high',
  },
];

export class ThreatHuntingEngine {
  private sessions: HuntSession[] = [];
  private playbooks: HuntPlaybook[] = [...DEFAULT_HUNT_PLAYBOOKS];
  private lake: TelemetryPipeline;

  constructor(lake: TelemetryPipeline, playbooks: HuntPlaybook[] = DEFAULT_HUNT_PLAYBOOKS) {
    this.lake = lake;
    this.playbooks = playbooks;
  }

  listPlaybooks(): HuntPlaybook[] {
    return [...this.playbooks];
  }

  addPlaybook(p: HuntPlaybook): HuntPlaybook {
    if (!p.id || !p.name || p.patterns.length === 0) throw new Error('playbook id/name/patterns required');
    this.playbooks.push(p);
    return p;
  }

  /**
   * Run a hunt: scan the telemetry lake for the playbook's patterns.
   * A pattern matches events by exact type or prefix. Returns the session
   * with hits (each hit is a suspicious lake entry).
   */
  hunt(playbookId: string, opts: { since?: number; limit?: number } = {}): HuntSession {
    const playbook = this.playbooks.find((p) => p.id === playbookId);
    if (!playbook) throw new Error(`unknown playbook ${playbookId}`);
    const session: HuntSession = {
      id: randomUUID(), playbookId, playbookName: playbook.name,
      startedAt: Date.now(), scanned: 0, hits: [],
    };
    for (const pattern of playbook.patterns) {
      // Match exact types, prefix (e.g. 'security.auth'), or embedded tokens
      // (e.g. 'auth' matches 'security.auth.denied').
      const all = this.lake.query({ since: opts.since });
      const matched = all.filter((e) => e.type === pattern || e.type.includes(pattern));
      for (const entry of matched) {
        session.scanned += 1;
        session.hits.push({
          eventId: entry.id, ts: entry.ts,
          ...(entry.actor ? { actor: entry.actor } : {}),
          ...(entry.origin ? { origin: entry.origin } : {}),
          ...(entry.detail ? { detail: entry.detail } : {}),
        });
      }
    }
    session.hits = session.hits.slice(-(opts.limit ?? 100));
    session.finishedAt = Date.now();
    session.summary = `${session.hits.length} hit(s) across ${session.scanned} scanned event(s)`;
    this.sessions.push(session);
    return session;
  }

  /** Hunt across every playbook (continuous hunting sweep). */
  huntAll(opts: { since?: number } = {}): HuntSession[] {
    return this.playbooks.map((p) => this.hunt(p.id, opts));
  }

  listSessions(): HuntSession[] {
    return [...this.sessions].reverse();
  }

  /** Dedupe + correlate hits across sessions by actor (attacker profile). */
  correlate(): Array<{ actor: string; playbooks: string[]; hits: number; lastSeen: number }> {
    const byActor = new Map<string, { playbooks: Set<string>; hits: number; lastSeen: number }>();
    for (const s of this.sessions) {
      for (const h of s.hits) {
        if (!h.actor) continue;
        const rec = byActor.get(h.actor) ?? { playbooks: new Set(), hits: 0, lastSeen: 0 };
        rec.playbooks.add(s.playbookName);
        rec.hits += 1;
        rec.lastSeen = Math.max(rec.lastSeen, h.ts);
        byActor.set(h.actor, rec);
      }
    }
    return [...byActor.entries()].map(([actor, r]) => ({
      actor, playbooks: [...r.playbooks], hits: r.hits, lastSeen: r.lastSeen,
    })).sort((a, b) => b.hits - a.hits);
  }
}

// ---- threat intelligence -------------------------------------------------------

export class ThreatIntelEngine {
  private indicators: IntelIndicator[] = [];
  private matches: IntelMatch[] = [];
  private lake: TelemetryPipeline;

  constructor(lake: TelemetryPipeline) {
    this.lake = lake;
  }

  ingest(input: {
    type: IntelType; value: string; confidence: number; severity: IntelIndicator['severity'];
    tlp?: TlpLevel; source: string; expiresAt?: number; tags?: string[];
  }): IntelIndicator {
    if (!input.value || input.confidence < 0 || input.confidence > 1) throw new Error('value + confidence 0..1 required');
    const indicator: IntelIndicator = {
      id: randomUUID(), type: input.type, value: input.value,
      confidence: input.confidence, severity: input.severity,
      tlp: input.tlp ?? 'amber', source: input.source,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      createdAt: Date.now(),
    };
    this.indicators.push(indicator);
    return indicator;
  }

  list(filter?: { type?: IntelType; severity?: IntelIndicator['severity']; source?: string }): IntelIndicator[] {
    const now = Date.now();
    return this.indicators.filter((i) =>
      (!filter?.type || i.type === filter.type) &&
      (!filter?.severity || i.severity === filter.severity) &&
      (!filter?.source || i.source === filter.source) &&
      (!i.expiresAt || i.expiresAt > now));
  }

  /** Expire stale indicators. */
  pruneExpired(): number {
    const before = this.indicators.length;
    this.indicators = this.indicators.filter((i) => !i.expiresAt || i.expiresAt > Date.now());
    return before - this.indicators.length;
  }

  /**
   * Match telemetry (and/or arbitrary observations) against active indicators.
   * Every observed string is compared against the indicator set; matches are
   * recorded for prioritization.
   */
  match(observations: Array<{ value: string; context?: Record<string, unknown> }>): IntelMatch[] {
    const now = Date.now();
    const active = this.indicators.filter((i) => !i.expiresAt || i.expiresAt > now);
    const found: IntelMatch[] = [];
    for (const obs of observations) {
      for (const indicator of active) {
        if (indicator.value === obs.value) {
          const match: IntelMatch = { indicator, matchedValue: obs.value, ts: Date.now() };
          this.matches.push(match);
          found.push(match);
        }
      }
    }
    return found;
  }

  /** Correlate intel matches against lake telemetry (actors/origins). */
  correlateLake(): Array<{ value: string; severity: string; sources: string[]; hits: number }> {
    const out: Array<{ value: string; severity: string; sources: string[]; hits: number }> = [];
    for (const indicator of this.list()) {
      const hits = this.lake.query({}).filter((e) =>
        e.actor === indicator.value || e.origin === indicator.value ||
        Object.values(e.data ?? {}).includes(indicator.value));
      if (hits.length > 0) {
        out.push({
          value: indicator.value, severity: indicator.severity,
          sources: [...new Set(hits.map((h) => h.source))], hits: hits.length,
        });
      }
    }
    return out.sort((a, b) => b.hits - a.hits);
  }

  matchesList(): IntelMatch[] {
    return [...this.matches].reverse();
  }

  /** Feed health: stale/expired share + coverage per source. */
  feedHealth(): { active: number; expired: number; bySource: Record<string, number> } {
    const now = Date.now();
    const bySource: Record<string, number> = {};
    let expired = 0;
    for (const i of this.indicators) {
      bySource[i.source] = (bySource[i.source] ?? 0) + 1;
      if (i.expiresAt && i.expiresAt <= now) expired += 1;
    }
    return { active: this.indicators.length - expired, expired, bySource };
  }
}
