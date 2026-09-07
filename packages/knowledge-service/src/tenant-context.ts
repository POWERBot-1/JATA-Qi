// S-1 (Tenant Boundary Hardening) — the authoritative tenant-context guard for
// tenant-bound knowledge operations.
//
// Why this module exists
// ----------------------
// Before S-1 the KnowledgeService applied two different tenant disciplines in
// one class: the WRITE path (`ingestText`) failed closed through the T-08.1 K1
// guard, while every READ/DELETE path gated on `tenantId !== undefined`, so
// "no tenant" meant "all tenants". Independent verification proved the
// consequence: `retrieve()`/`stats()` disclosed every tenant's data and
// `deleteDocument()` destroyed a foreign tenant's document when called without
// a tenant.
//
// The contract enforced here (identical for read, write and delete):
//
//   1. tenant supplied and non-blank  → that exact tenant, never widened;
//   2. tenant missing/blank/ambiguous → REFUSED (throw) — no data-plane work;
//   3. cross-tenant identifier        → denied by the caller's scoped lookup;
//   4. no implicit default tenant     → DEFAULT_TENANT_ID is reachable ONLY
//      through the explicit T-08.1 K1 test-compat flags, never through
//      NODE_ENV, never silently, and never as "every tenant".
//
// Note the difference between "no tenant" and "all tenants": even in test-compat
// mode the guard resolves to ONE isolated bucket (the reserved default), so an
// operation can never span tenants. Widening is not representable any more.

import { DEFAULT_TENANT_ID } from './types.js';

/** Stable machine-readable code for a refused tenant context. */
export const TENANT_CONTEXT_REQUIRED = 'TENANT_CONTEXT_REQUIRED';

/**
 * Thrown when a tenant-bound operation is invoked without an unambiguous tenant.
 * It is a refusal, not a partial result: callers must perform no data-plane work.
 */
export class TenantContextError extends Error {
  readonly code = TENANT_CONTEXT_REQUIRED;
  /** Operation that was refused (e.g. `KnowledgeService.retrieve`). */
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = 'TenantContextError';
    this.operation = operation;
  }
}

/** Minimal logger shape, so a refusal is always observable (auditable). */
export interface TenantContextLogger {
  warn?(message: string, meta?: Record<string, unknown>): void;
}

export interface ResolveTenantContextOptions {
  /** Subject used in the refusal/warning message (default `KnowledgeService`). */
  subject?: string;
  /** Where the tenant was expected, e.g. `opts.tenantId` (message only). */
  source?: string;
  /** Observability sink for the fail-closed/fallback decision. */
  logger?: TenantContextLogger;
  /**
   * When false (default) the T-08.1 K1 test-compat fallback is NOT honoured and
   * a missing tenant always throws. Vector/RAG boundaries use this strict mode
   * because no reserved default bucket exists at that layer.
   */
  allowTestOnlyDefaultFallback?: boolean;
}

/**
 * True only when an explicit T-08.1 K1 test-compat flag authorizes the isolated
 * DEFAULT_TENANT_ID bucket. No NODE_ENV value (including unset/development/
 * staging/test) may authorize it — that authorization was removed by T-08.1 K1
 * and is not reintroduced here.
 */
export function isDefaultTenantFallbackAuthorized(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK === '1' ||
    env.JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK === '1'
  );
}

/** True when the value is a usable tenant id (present and not blank). */
export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolve the tenant for one tenant-bound operation, or refuse.
 *
 * @param requested tenant supplied by the caller (`undefined`/`null`/blank are refusals)
 * @param operation operation name recorded in the refusal and the audit warning
 */
export function resolveTenantContext(
  requested: string | undefined | null,
  operation: string,
  opts: ResolveTenantContextOptions = {},
): string {
  const subject = opts.subject ?? 'KnowledgeService';
  const source = opts.source ?? 'opts.tenantId';
  if (isTenantId(requested)) return requested;

  const allowFallback = opts.allowTestOnlyDefaultFallback !== false && isDefaultTenantFallbackAuthorized();
  const message =
    `${subject}: ${operation} tenantId missing — falling back to DEFAULT_TENANT_ID="${DEFAULT_TENANT_ID}" ` +
    '(test-only fail-safe)';
  try {
    opts.logger?.warn?.(message, { fallbackTenantId: DEFAULT_TENANT_ID, op: operation } as Record<string, unknown>);
  } catch {
    // logger unavailable during early boot — still surface the decision
    console.warn(message);
  }
  if (!allowFallback) {
    throw new TenantContextError(
      `${subject}.${operation}`,
      `${message}. Provide ${source} or set JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK=1 for test-only compat. ` +
        'No cross-tenant or all-tenant operation exists: a tenant-bound call without an unambiguous tenant is ' +
        'refused. Failing closed.',
    );
  }
  return DEFAULT_TENANT_ID;
}
