// Insider risk management + advanced abuse detection.
//
// InsiderRiskEngine monitors privileged activity, detects abnormal access
// patterns (off-hours admin actions, mass exports, bursty privileged
// actions), and tracks a least-privilege posture for roles.
//
// AbuseDetectionEngine identifies spam, automated abuse, credential
// stuffing, fake-account creation, coordinated behavior, API abuse, and
// phishing patterns from registration/auth/API telemetry.

import { randomUUID } from 'node:crypto';
import type { AbuseAlert, InsiderAlert, PrivilegedAction } from './types.js';

// ---- insider risk ---------------------------------------------------------------

export interface InsiderRiskConfig {
  /** Max privileged actions per rolling window before an alert. */
  privilegedBurst?: number;
  windowMs?: number;
  /** Business hours (local 0-23) — admin actions outside these alert. */
  businessHours?: [number, number];
  /** Roles considered privileged (least-privilege posture baseline). */
  privilegedRoles?: string[];
  /** Max roles a principal may hold (least privilege). */
  maxRolesPerPrincipal?: number;
}

export class InsiderRiskEngine {
  private actions: PrivilegedAction[] = [];
  private alerts: InsiderAlert[] = [];
  private cfg: Required<InsiderRiskConfig>;

  constructor(cfg: InsiderRiskConfig = {}) {
    this.cfg = {
      privilegedBurst: cfg.privilegedBurst ?? 5,
      windowMs: cfg.windowMs ?? 10 * 60_000,
      businessHours: cfg.businessHours ?? [6, 22],
      privilegedRoles: cfg.privilegedRoles ?? ['admin'],
      maxRolesPerPrincipal: cfg.maxRolesPerPrincipal ?? 3,
    };
  }

  /** Record a privileged (or sensitive) action and evaluate the rules. */
  observe(input: Omit<PrivilegedAction, 'ts'> & { ts?: number }): InsiderAlert | undefined {
    const action: PrivilegedAction = { ...input, ts: input.ts ?? Date.now() };
    this.actions.push(action);
    const now = action.ts;
    const window = this.actions.filter((a) => a.actor === action.actor && now - a.ts <= this.cfg.windowMs);
    if (action.sensitivity === 'privileged' || action.sensitivity === 'critical') {
      const burst = window.filter((a) => a.sensitivity !== 'standard').length;
      if (burst >= this.cfg.privilegedBurst) {
        return this.alert(action.actor, 'privileged_burst', 'high',
          `${burst} privileged action(s) by ${action.actor} in ${Math.round(this.cfg.windowMs / 60_000)}m`);
      }
      const hour = new Date(now).getHours();
      const [start, end] = this.cfg.businessHours;
      const offHours = hour < start || hour >= end;
      if (offHours && (action.sensitivity === 'critical' || action.action.startsWith('admin.'))) {
        return this.alert(action.actor, 'off_hours_admin', 'medium',
          `${action.action} performed off business hours (hour ${hour})`);
      }
    }
    return undefined;
  }

  /**
   * Least-privilege posture: report principals whose role count exceeds the
   * baseline (role sprawl) — a prerequisite for enforcing least privilege.
   */
  posture(principalRoles: Array<{ principal: string; roles: string[] }>): Array<{ principal: string; roles: string[]; status: 'ok' | 'sprawl' }> {
    return principalRoles.map((p) => ({
      principal: p.principal,
      roles: p.roles,
      status: p.roles.length > this.cfg.maxRolesPerPrincipal ? 'sprawl' as const : 'ok' as const,
    }));
  }

  private alert(actor: string, rule: string, severity: InsiderAlert['severity'], message: string): InsiderAlert {
    const alert: InsiderAlert = { id: randomUUID(), actor, rule, severity, message, ts: Date.now() };
    this.alerts.push(alert);
    return alert;
  }

  alertsList(): InsiderAlert[] {
    return [...this.alerts].reverse();
  }

  /** Analytics: privileged action counts per actor. */
  analytics(): Array<{ actor: string; privileged: number; total: number }> {
    const map = new Map<string, { privileged: number; total: number }>();
    for (const a of this.actions) {
      const rec = map.get(a.actor) ?? { privileged: 0, total: 0 };
      rec.total += 1;
      if (a.sensitivity !== 'standard') rec.privileged += 1;
      map.set(a.actor, rec);
    }
    return [...map.entries()].map(([actor, r]) => ({ actor, ...r })).sort((a, b) => b.privileged - a.privileged);
  }
}

// ---- abuse detection ---------------------------------------------------------------

export interface AbuseObservation {
  kind: 'registration' | 'login' | 'api_call' | 'content' | 'invite';
  actor?: string;
  origin?: string;
  /** e.g. email domain, payload, content text. */
  value?: string;
  ts?: number;
}

export class AbuseDetectionEngine {
  private observations: AbuseObservation[] = [];
  private alerts: AbuseAlert[] = [];

  /** Max registrations per origin within the window (fake-account burst). */
  private readonly registrationBurst = 5;
  private readonly windowMs = 10 * 60_000;

  observe(input: AbuseObservation): AbuseAlert | undefined {
    const obs: AbuseObservation = { ...input, ts: input.ts ?? Date.now() };
    this.observations.push(obs);
    const now = obs.ts ?? Date.now();
    const inWindow = this.observations.filter((o) => now - (o.ts ?? 0) <= this.windowMs);

    if (obs.kind === 'registration' && obs.origin) {
      const burst = inWindow.filter((o) => o.kind === 'registration' && o.origin === obs.origin).length;
      if (burst >= this.registrationBurst) {
        return this.alert('fake_account_burst', 'high',
          `${burst} registrations from ${obs.origin} in ${Math.round(this.windowMs / 60_000)}m`,
          undefined, [obs.origin]);
      }
      // Fake-account similarity: same email domain generating many accounts.
      if (obs.value) {
        const sameDomain = inWindow.filter((o) => o.kind === 'registration' && o.value === obs.value).length;
        if (sameDomain >= 4) {
          return this.alert('email_domain_burst', 'medium',
            `${sameDomain} accounts on ${obs.value} in ${Math.round(this.windowMs / 60_000)}m`, undefined, [obs.origin]);
        }
      }
    }

    if (obs.kind === 'login' && obs.origin) {
      const denials = inWindow.filter((o) => o.kind === 'login' && o.origin === obs.origin && o.value === 'denied').length;
      if (denials >= 6) {
        return this.alert('credential_stuffing', 'high',
          `${denials} denied logins from ${obs.origin} in ${Math.round(this.windowMs / 60_000)}m`, undefined, [obs.origin]);
      }
    }

    if (obs.kind === 'content' && obs.value) {
      const low = obs.value.toLowerCase();
      if (/(bitcoin|wallet|click here|verify your account|urgent action|prize|won \d)/.test(low) && /(http|\.com|\.xyz|\.link)/.test(low)) {
        return this.alert('phishing_content', 'high', `phishing-pattern content blocked (${obs.value.slice(0, 60)})`, obs.actor ? [obs.actor] : undefined);
      }
      if (low.length > 200 && /(buy now|cheap|discount|free|limited time)/.test(low)) {
        return this.alert('spam_content', 'low', `spam-pattern content flagged`, obs.actor ? [obs.actor] : undefined);
      }
    }

    if (obs.kind === 'api_call' && obs.origin) {
      const calls = inWindow.filter((o) => o.kind === 'api_call' && o.origin === obs.origin).length;
      if (calls >= 60) {
        return this.alert('api_abuse', 'medium',
          `${calls} API calls from ${obs.origin} in ${Math.round(this.windowMs / 60_000)}m`, undefined, [obs.origin]);
      }
    }

    return undefined;
  }

  /** Coordinated behavior: distinct actors sharing origins/values. */
  coordinated(): Array<{ key: string; actors: string[]; count: number }> {
    const map = new Map<string, Set<string>>();
    for (const o of this.observations) {
      if (!o.origin || !o.actor) continue;
      const set = map.get(o.origin) ?? new Set<string>();
      set.add(o.actor);
      map.set(o.origin, set);
    }
    return [...map.entries()]
      .filter(([, actors]) => actors.size >= 3)
      .map(([key, actors]) => ({ key, actors: [...actors], count: actors.size }))
      .sort((a, b) => b.count - a.count);
  }

  private alert(rule: string, severity: AbuseAlert['severity'], message: string, actors?: string[], origins?: string[]): AbuseAlert {
    const alert: AbuseAlert = { id: randomUUID(), rule, severity, message, ...(actors ? { actors } : {}), ...(origins ? { origins } : {}), ts: Date.now() };
    this.alerts.push(alert);
    return alert;
  }

  alertsList(): AbuseAlert[] {
    return [...this.alerts].reverse();
  }
}
