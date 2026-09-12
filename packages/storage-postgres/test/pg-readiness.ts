// G10 remediation — importable bounded PostgreSQL readiness protection.
//
// Why this exists (measured defect, G10 classification B — test/harness):
// embedded-postgres resolves `start()` on the postmaster's "ready to accept
// connections" log line, which can PRECEDE the TCP listener actually
// accepting connections. An unguarded first connection — the pattern used by
// the real-PostgreSQL integration suites (p1-rls-probe, f01-event-fabric-pg,
// t05-payment-chain-pg, t06-knowledge-tenant-pg, t07-finalization-
// concurrency-pg) — can therefore observe ECONNREFUSED against a server that
// is about to be ready, taking the suite red BEFORE any product assertion
// runs. This is an infrastructure race, not a product failure and not an
// absence of PostgreSQL.
//
// Contract:
//   * BOUNDED — fixed attempt cap, linear backoff (baseDelayMs * attempt),
//     per-attempt connection timeout; never infinite polling, no unbounded
//     sleep.
//   * TRANSIENT-ONLY — only errors classified by the repository's existing
//     predicate `isTransientPgError` (reused verbatim from ./pg-test-harness.js,
//     the P1C-OBS-01 definition — this module adds NO competing definition)
//     are retried. Permanent failures (authentication, configuration, network
//     policy, capability absence) surface on the FIRST attempt, with their
//     original error identity preserved where the caller relies on it.
//   * DIAGNOSTICS PRESERVED — callers surface postmaster stderr through
//     `redactPgDiagnostics` instead of swallowing it, and every diagnostic
//     emitted here is redacted: passwords, connection credentials (URI
//     userinfo), connection strings, tokens and API keys never appear in
//     error messages. Host, port, database, error code and message are
//     preserved so a failure stays attributable from the job log alone.
//   * REAL PostgreSQL — `waitForPgReady` is a full authenticated probe
//     (TCP connect + startup + authentication + `SELECT 1`), not a TCP
//     half-open check.

import pg from 'pg';
import { isTransientPgError } from './pg-test-harness.js';

export { isTransientPgError };

export interface PgReadinessOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Suite label for diagnostics. Must not contain secret material. */
  label: string;
  /** Bounded attempt cap (default: 8). */
  maxAttempts?: number;
  /** Backoff base in ms; the pause before retry n is baseDelayMs * n (default: 500). */
  baseDelayMs?: number;
  /** Per-attempt connection timeout in ms (default: 3000). */
  connectTimeoutMs?: number;
}

export interface WithPgReadinessOptions {
  /** Bounded attempt cap (default: 8). */
  maxAttempts?: number;
  /** Backoff base in ms (default: 500). */
  baseDelayMs?: number;
}

export const PG_READY_DEFAULT_MAX_ATTEMPTS = 8;
export const PG_READY_DEFAULT_BASE_DELAY_MS = 500;
export const PG_READY_DEFAULT_CONNECT_TIMEOUT_MS = 3000;

/**
 * G10: redact secret material from diagnostic text.
 *
 * Redacts:
 *   * connection-URI userinfo — `scheme://user:pass@` becomes
 *     `scheme://<redacted>@` (host/port/database preserved);
 *   * `password`/`passwd`/`pwd`/`token`/`api-key`/`api_key`/`apikey`/`secret`
 *     parameter or field values (`key=value`, `key: value`);
 *   * `Bearer` tokens.
 *
 * Preserves (non-secret, attribution-relevant): host, port, database name,
 * SQLSTATE / errno codes, error categories.
 */
export function redactPgDiagnostics(message: string): string {
  return message
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/\s]+@/g, '$1<redacted>@')
    .replace(
      /(\b(?:password|passwd|pwd|token|api[-_]?key|apikey|secret)\b)\s*[=:]\s*([^\s,;"'`&]+)/gi,
      '$1=<redacted>',
    )
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer <redacted>');
}

function errMessage(error: unknown): string {
  return redactPgDiagnostics(String((error as Error)?.message ?? error));
}

function errCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && code.length > 0 ? code : '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * G10: readiness failure carrying redacted, attributable diagnostics.
 *
 * `attemptsUsed` distinguishes "retry budget exhausted" (transient readiness
 * race lost — the binaries are present and the server merely lost the race)
 * from `attemptsUsed === 1` (permanent failure surfaced immediately).
 */
export class PgReadinessError extends Error {
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly attemptsUsed: number;
  readonly lastErrorCode: string;
  readonly elapsedMs: number;

  constructor(
    label: string,
    host: string,
    port: number,
    attemptsUsed: number,
    lastError: unknown,
    elapsedMs: number,
  ) {
    const code = errCode(lastError);
    const target = host && port > 0 ? ` at ${host}:${port}` : '';
    super(
      `[pg-readiness:${label}] PostgreSQL not ready${target} after ${attemptsUsed} bounded attempt(s) in ${elapsedMs}ms` +
        (code ? `; last error code: ${code}` : '') +
        `; last error: ${errMessage(lastError)}`,
    );
    this.name = 'PgReadinessError';
    this.label = label;
    this.host = host;
    this.port = port;
    this.attemptsUsed = attemptsUsed;
    this.lastErrorCode = code;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * G10: bounded readiness probe against a real PostgreSQL instance.
 *
 * Attempts a full authenticated connection (`connect` + `SELECT 1`) up to
 * `maxAttempts` times, retrying ONLY transient readiness errors (per
 * `isTransientPgError`). Resolves with the attempt count on success; throws
 * `PgReadinessError` (redacted diagnostics) when the bounded budget is
 * exhausted or a permanent error occurs on the first attempt.
 */
export async function waitForPgReady(options: PgReadinessOptions): Promise<{ attempts: number }> {
  const maxAttempts = options.maxAttempts ?? PG_READY_DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? PG_READY_DEFAULT_BASE_DELAY_MS;
  const startedAt = Date.now();
  let lastError: unknown;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const client = new pg.Client({
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      database: options.database,
      connectionTimeoutMillis: options.connectTimeoutMs ?? PG_READY_DEFAULT_CONNECT_TIMEOUT_MS,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      if (!isTransientPgError(error) || attempt === maxAttempts) {
        throw new PgReadinessError(
          options.label,
          options.host,
          options.port,
          attempt,
          error,
          Date.now() - startedAt,
        );
      }
      await sleep(baseDelayMs * attempt);
    }
  }
  // Defensive: the loop always returns or throws for any sane config
  // (maxAttempts >= 1). Kept so the failure path can never be silent.
  throw new PgReadinessError(options.label, options.host, options.port, attemptsUsed, lastError, Date.now() - startedAt);
}

/**
 * G10: bounded transient-only retry for a boot operation (`initialise` /
 * `start`). Non-transient errors are rethrown with their original identity
 * (callers' honest-skip and fail-hard paths depend on it); a transient error
 * that exhausts the bounded budget is wrapped in `PgReadinessError` so the
 * job log shows a readiness loss, not an unattributable stack.
 */
export async function withPgReadiness<T>(
  label: string,
  operation: () => Promise<T>,
  options: WithPgReadinessOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? PG_READY_DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? PG_READY_DEFAULT_BASE_DELAY_MS;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientPgError(error)) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw new PgReadinessError(label, '', 0, attempt, error, Date.now() - startedAt);
      }
      await sleep(baseDelayMs * attempt);
    }
  }
  // Unreachable: the loop always returns or throws.
  throw new Error(`[pg-readiness:${label}] exhausted ${maxAttempts} bounded attempt(s)`);
}
