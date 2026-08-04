// DigitalMemoryEngine — the core memory store. Normalizes raw platform signals
// into governed MemoryEvents, enforces per-org policy + consent + retention,
// deduplicates via content hashing with revision versioning, builds an inverted
// token index for keyword search, and supports right-to-delete/export. Tenant
// isolation is enforced on every query (events are always org-scoped).

import { createHash, randomUUID } from 'node:crypto';
import type {
  ConsentState, MemoryCategory, MemoryEvent, MemoryQuery, MemoryStats, OrgMemoryPolicy, RecordInput, RecordResult, Sensitivity,
} from './types.js';

export class MemoryError extends Error {
  constructor(message: string) { super(message); this.name = 'MemoryError'; }
}

export class DigitalMemoryEngine {
  private events = new Map<string, MemoryEvent>();
  /** orgId|'' -> events (tenant index). */
  private byOrg = new Map<string, Set<string>>();
  private inverted = new Map<string, Set<string>>();
  private policies = new Map<string, OrgMemoryPolicy>();
  private consent: ConsentState = { granted: new Map() };

  /** Record a platform signal; applies policy + consent + retention gating. */
  record(input: RecordInput): RecordResult {
    const orgId = input.orgId;
    const policy = orgId !== undefined ? this.policies.get(orgId) : undefined;

    // Policy gating.
    if (policy?.disabled) return { recorded: false, reason: 'org-disabled' };
    if (policy?.blockedCategories?.includes(input.category)) return { recorded: false, reason: 'category-blocked' };
    if (policy?.allowedCategories && policy.allowedCategories.length > 0 && !policy.allowedCategories.includes(input.category)) {
      return { recorded: false, reason: 'category-blocked' };
    }
    // Consent gating.
    if (policy?.consentRequiredCategories?.includes(input.category)) {
      const subject = input.userId ?? orgId ?? '';
      const granted = this.consent.granted.get(subject);
      if (!granted?.has(input.category)) return { recorded: false, reason: 'consent-required' };
    }

    const ts = input.ts ?? Date.now();
    const hash = fingerprint(orgId, input.userId, input.category, input.summary, input.data, input.correlationId);
    const tokens = tokenize([input.summary, ...(input.tags ?? []), ...Object.keys(input.data ?? {})].join(' '));

    // Versioning: a duplicate logical event bumps the revision.
    const existing = this.findByHash(hash, orgId);
    if (existing) {
      existing.version += 1;
      existing.ts = ts;
      existing.tokens = mergeUnique(existing.tokens, tokens);
      this.index(existing.id, tokens);
      return { recorded: true, event: clone(existing), reason: 'retained' };
    }

    const retentionDays = input.retentionDays ?? policy?.retentionByCategory?.[input.category] ?? policy?.retentionDays;
    const event: MemoryEvent = {
      id: randomUUID(),
      category: input.category,
      ts,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(orgId !== undefined ? { orgId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      summary: input.summary,
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
      sensitivity: input.sensitivity ?? 'internal',
      ...(retentionDays !== undefined ? { retentionDays } : {}),
      version: 1,
      hash,
      tokens,
      createdAt: Date.now(),
    };
    this.events.set(event.id, event);
    const orgKey = orgId ?? '';
    const orgSet = this.byOrg.get(orgKey) ?? new Set<string>();
    orgSet.add(event.id);
    this.byOrg.set(orgKey, orgSet);
    this.index(event.id, tokens);
    return { recorded: true, event: clone(event), reason: 'retained' };
  }

  get(id: string): MemoryEvent | undefined {
    const e = this.events.get(id);
    return e ? clone(e) : undefined;
  }

  /** Tenant-scoped query. `orgId` restricts to one tenant; omit for global events. */
  query(filter: MemoryQuery = {}): MemoryEvent[] {
    return this.queryInternal(filter, false);
  }

  /** Cross-org query (internal platform use — learning, adaptation). Searches
   *  all tenants. External APIs must use `query()` with an explicit orgId. */
  queryAll(filter: MemoryQuery = {}): MemoryEvent[] {
    return this.queryInternal(filter, true);
  }

  private queryInternal(filter: MemoryQuery, crossOrg: boolean): MemoryEvent[] {
    let ids: Set<string>;
    if (filter.orgId !== undefined) {
      ids = new Set(this.byOrg.get(filter.orgId) ?? []);
    } else if (crossOrg) {
      ids = new Set<string>();
      for (const orgSet of this.byOrg.values()) for (const id of orgSet) ids.add(id);
    } else {
      ids = new Set(this.byOrg.get('') ?? []);
    }
    let results: MemoryEvent[] = [];
    for (const id of ids) {
      const e = this.events.get(id);
      if (!e) continue;
      if (!matches(e, filter)) continue;
      results.push(e);
    }
    if (filter.text) {
      const wanted = new Set(tokenize(filter.text));
      // Rank by overlap count, drop zero-overlap.
      results = results
        .map((e) => ({ e, score: e.tokens.reduce((s, t) => (wanted.has(t) ? s + 1 : s), 0) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.e);
    } else {
      results.sort((a, b) => b.ts - a.ts);
    }
    const limit = filter.limit ?? 100;
    return results.slice(0, limit).map(clone);
  }

  // ---- governance --------------------------------------------------------

  setPolicy(policy: OrgMemoryPolicy): void { this.policies.set(policy.orgId, policy); }
  getPolicy(orgId: string): OrgMemoryPolicy | undefined { return this.policies.get(orgId); }

  /** Grant a subject's consent for a set of categories. */
  grantConsent(subject: string, categories: MemoryCategory[]): void {
    const set = this.consent.granted.get(subject) ?? new Set<MemoryCategory>();
    for (const c of categories) set.add(c);
    this.consent.granted.set(subject, set);
  }
  revokeConsent(subject: string, category?: MemoryCategory): void {
    const set = this.consent.granted.get(subject);
    if (!set) return;
    if (category) set.delete(category);
    else this.consent.granted.delete(subject);
  }
  hasConsent(subject: string, category: MemoryCategory): boolean {
    return !!this.consent.granted.get(subject)?.has(category);
  }

  // ---- retention ---------------------------------------------------------

  /** Delete expired events; returns the number removed. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [id, e] of this.events) {
      if (e.retentionDays === undefined) continue;
      const expiresAt = e.ts + e.retentionDays * 86_400_000;
      if (expiresAt <= now) { this.remove(id); removed++; }
    }
    return removed;
  }

  // ---- privacy: export + right-to-delete --------------------------------

  /** Export a subject's memory (for subject-access requests). */
  exportFor(filter: { userId?: string; orgId?: string }): MemoryEvent[] {
    return this.query({ ...(filter.userId !== undefined ? { userId: filter.userId } : {}), ...(filter.orgId !== undefined ? { orgId: filter.orgId } : {}), limit: Number.POSITIVE_INFINITY })
      .map(clone);
  }

  /** Right-to-delete: purge a subject's events. Returns the count removed. */
  deleteForSubject(opts: { userId?: string; orgId?: string }): number {
    let removed = 0;
    for (const [id, e] of this.events) {
      const userMatch = opts.userId !== undefined && e.userId === opts.userId;
      const orgMatch = opts.orgId !== undefined && e.orgId === opts.orgId;
      if ((opts.userId === undefined ? orgMatch : opts.orgId === undefined ? userMatch : userMatch && orgMatch)) {
        this.remove(id);
        removed++;
      }
    }
    return removed;
  }

  // ---- stats -------------------------------------------------------------

  stats(orgId?: string): MemoryStats {
    const byCategory: Record<string, number> = {};
    const byOrg: Record<string, number> = {};
    let total = 0;
    for (const e of this.events.values()) {
      if (orgId !== undefined && (e.orgId ?? '') !== orgId) continue;
      total++;
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      const o = e.orgId ?? '';
      byOrg[o] = (byOrg[o] ?? 0) + 1;
    }
    return { total, byCategory, byOrg };
  }

  get size(): number { return this.events.size; }

  /** Load an already-governed persisted event (no policy re-check). */
  hydrate(event: MemoryEvent): void {
    if (this.events.has(event.id)) return;
    const e: MemoryEvent = { ...event, ...(event.data ? { data: { ...event.data } } : {}), ...(event.tags ? { tags: [...event.tags] } : {}), tokens: [...event.tokens] };
    this.events.set(e.id, e);
    const orgKey = e.orgId ?? '';
    const orgSet = this.byOrg.get(orgKey) ?? new Set<string>();
    orgSet.add(e.id);
    this.byOrg.set(orgKey, orgSet);
    this.index(e.id, e.tokens);
  }

  // ---- internals ---------------------------------------------------------

  private findByHash(hash: string, orgId?: string): MemoryEvent | undefined {
    for (const e of this.events.values()) {
      if (e.hash === hash && (e.orgId ?? '') === (orgId ?? '')) return e;
    }
    return undefined;
  }

  private index(id: string, tokens: string[]): void {
    for (const t of new Set(tokens)) {
      const set = this.inverted.get(t) ?? new Set<string>();
      set.add(id);
      this.inverted.set(t, set);
    }
  }

  private remove(id: string): void {
    const e = this.events.get(id);
    if (!e) return;
    this.events.delete(id);
    const orgSet = this.byOrg.get(e.orgId ?? '');
    orgSet?.delete(id);
    for (const t of new Set(e.tokens)) this.inverted.get(t)?.delete(id);
  }
}

// ---- helpers --------------------------------------------------------------

function matches(e: MemoryEvent, f: MemoryQuery): boolean {
  if (f.category !== undefined) {
    const cats = Array.isArray(f.category) ? f.category : [f.category];
    if (!cats.includes(e.category)) return false;
  }
  if (f.userId !== undefined && e.userId !== f.userId) return false;
  if (f.sessionId !== undefined && e.sessionId !== f.sessionId) return false;
  if (f.correlationId !== undefined && e.correlationId !== f.correlationId) return false;
  if (f.tags !== undefined && f.tags.length > 0 && !(f.tags.every((t) => e.tags?.includes(t)))) return false;
  if (f.fromTs !== undefined && e.ts < f.fromTs) return false;
  if (f.toTs !== undefined && e.ts > f.toTs) return false;
  return true;
}

function clone(e: MemoryEvent): MemoryEvent {
  return { ...e, ...(e.data ? { data: { ...e.data } } : {}), ...(e.tags ? { tags: [...e.tags] } : {}), tokens: [...e.tokens] };
}

function fingerprint(orgId: string | undefined, userId: string | undefined, category: string, summary: string, data: Record<string, unknown> | undefined, correlationId: string | undefined): string {
  const canonical = JSON.stringify({ o: orgId ?? '', u: userId ?? '', c: category, s: summary, d: data ?? {}, x: correlationId ?? '' });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Tokenize text for the inverted index (lowercase alphanumeric, length > 2). */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9@.:-]+/g) ?? [])
    .filter((t) => t.length > 2)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''));
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

export type { MemoryCategory, MemoryEvent, MemoryQuery, MemoryStats, OrgMemoryPolicy, RecordInput, RecordResult, Sensitivity };
