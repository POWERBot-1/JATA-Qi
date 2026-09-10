// INV-15/GAP-07 — Ambient security-scope minimization: system-scope audit.
//
// The P1 production contract (PG-5/INV-15) forbids an ambient session-level
// system scope ('*') on pooled PostgreSQL sessions: pooled sessions must
// start UNSET (blind — they see and write no tenant-scoped rows), and system
// scope may exist ONLY inside explicit per-transaction `SET LOCAL` grants
// whose exceptions are enumerated in the boot audit.
//
// This module is the enumeration mechanism. Every system-scope grant issued
// by the engine flows through one of the driver's labeled choke points
// (`withSystemScope`, the unscoped branch of `beginTransaction`, and the
// schema-isolation backfill path), which counts the use under a stable
// label. The boot-posture invariant (P1 composition) fails closed if:
//
//   * a pooled session ever starts with a non-empty scope GUC again
//     (`hasAmbientConnectScope()` — a live negative test, not a flag), or
//   * an operation is observed under a label that is NOT declared in
//     `ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS` below.
//
// A new broad-scope access pattern therefore cannot appear silently: it
// either declares itself here (a reviewable, justified change) or the
// production posture refuses to boot.

import type pg from 'pg';

/**
 * A declared system-scope exception: everything observed under a label with
 * this prefix is a legitimate, enumerated use of system scope. The registry
 * is deliberately narrow; adding a prefix is a security-relevant change and
 * must carry a justification that survives review.
 */
export interface SystemScopeException {
  /** Label prefix covered by the exception. */
  readonly labelPrefix: string;
  /** Why this system-scope use is necessary and how it is bounded. */
  readonly justification: string;
}

export const ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS: readonly SystemScopeException[] = Object.freeze([
  Object.freeze({
    labelPrefix: 'poolpath:',
    justification:
      'legacy/unscoped pool-path collection operations (pre-tenant lookups such as the S-9 ' +
      'fingerprint and S-8 session reads, the R1 storage audit sink, and development-class ' +
      'product caches). Each operation runs in its own explicit BEGIN/SET LOCAL \'*\' COMMIT ' +
      'transaction acquired on demand — never a session-level ambient scope — and each use is ' +
      'counted per collection so the set of consumers stays enumerable.',
  }),
  Object.freeze({
    labelPrefix: 'transaction:system',
    justification:
      'explicitly unscoped composed transactions (`beginTransaction()` without a tenantId): the ' +
      'R2 durable-security system flows (S-1 policy/manifest reads, security-state seed, ' +
      'mirror, reachability probe and retention/GC), the P2-S1 identity core (pre-tenant ' +
      'federation-binding PK reads, the principal-uniqueness query on the enrollment/' +
      'auto-link creation paths, the one-shot jti replay consume, and the boot-invariant ' +
      'binding count — each a single bounded operation, counted per use), and other ' +
      'cross-tenant system compositions. The scope is transaction-local `SET LOCAL` and ' +
      'reverts on commit/rollback.',
  }),
  Object.freeze({
    labelPrefix: 'schema:isolation',
    justification:
      'the tenant-isolation DDL path for freshly opened collection tables — specifically the ' +
      'idempotent legacy backfill `UPDATE ... SET tenant_id = body->>\'tenantId\'`, which must ' +
      'span tenants to migrate pre-column rows into RLS-visible state. One-time per table, ' +
      'bounded, and catalog-guarded (skipped once isolation already exists).',
  }),
]);

/** True when `label` falls under a declared exception prefix. */
export function isDeclaredSystemScopeLabel(label: string): boolean {
  return ENUMERATED_SYSTEM_SCOPE_EXCEPTIONS.some((exception) => label.startsWith(exception.labelPrefix));
}

/**
 * Machine-readable boot-audit artifact for INV-15/GAP-07. `uses` maps every
 * label ever observed by this driver to a monotonic operation count;
 * `undeclaredLabels` lists observed labels that violate the exception
 * registry (the posture check turns those into boot failures).
 */
export interface SystemScopeAudit {
  /**
   * Static marker of the minimization itself. The structural truth is the
   * driver's live `hasAmbientConnectScope()` probe; this constant exists so
   * the artifact is greppable/assertable by machine and by tests.
   */
  readonly ambientConnectScopePresent: false;
  readonly totalSystemScopeOperations: number;
  readonly uses: Readonly<Record<string, number>>;
  readonly undeclaredLabels: readonly string[];
}

/** Per-driver counter behind `PostgresDriver.getSystemScopeAudit()`. */
export class SystemScopeCounter {
  private readonly uses = new Map<string, number>();
  private total = 0;

  note(label: string): void {
    this.uses.set(label, (this.uses.get(label) ?? 0) + 1);
    this.total += 1;
  }

  snapshot(): SystemScopeAudit {
    const sorted = [...this.uses.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const uses: Record<string, number> = {};
    const undeclared: string[] = [];
    for (const [label, count] of sorted) {
      uses[label] = count;
      if (!isDeclaredSystemScopeLabel(label)) undeclared.push(label);
    }
    return {
      ambientConnectScopePresent: false,
      totalSystemScopeOperations: this.total,
      uses,
      undeclaredLabels: Object.freeze(undeclared),
    };
  }
}

/**
 * Supplies explicit, labeled, transaction-scoped system authority to
 * handles that used to rely on the ambient session scope. Implemented by
 * `PostgresDriver.withSystemScope`; consumed by `PostgresCollection`.
 */
export interface SystemScopeRunner {
  run<T>(label: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
}
