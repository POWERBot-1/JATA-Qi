// PostgreSQL tenant isolation (T-01-F / T-06 production wiring).
//
// This module provides database-level tenant isolation for the
// @jataqi/storage-postgres driver. It does not introduce a new
// persistence architecture; it strengthens the existing one with:
//
//   1. A `tenant_id` column added to every collection table (the
//      driver creates it on first open if missing; subsequent opens
//      validate that it exists).
//   2. PostgreSQL Row-Level Security (RLS) policies on every
//      collection table.
//   3. Tenant context helpers (`setTenantContext`) that run code inside
//      a transaction with `SET LOCAL app.tenant_id = $1` (the per-tx
//      RLS context).
//
// Policy semantics (T-06, strict + explicit system scope):
//
//   USING/WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
//                     OR current_setting('app.tenant_id', true) = '*')
//
//   - A session WITH a tenant context (GUC = tenant A) can only see and
//     write rows whose tenant_id is 'A': cross-tenant reads are empty and
//     cross-tenant writes fail the WITH CHECK (fail-closed). Application
//     flows that carry a tenant run under this context.
//   - A session WITHOUT a tenant context (GUC unset) sees NO rows and can
//     write NO rows: an unconfigured connection fails closed by default.
//   - A session with the explicit SYSTEM marker (GUC = '*', set on the
//     driver's own pool via connection startup options) is the server-side
//     system scope: it sees and writes all rows, exactly like the pre-RLS
//     driver. '*' is not a valid tenant id (see the charset below), so it
//     can never collide with a real tenant context. Production deployments
//     use one application role for system flows and per-tenant contexts for
//     tenant flows; application-level authorization (system/global_admin
//     roles) still governs what the system scope may do — RLS is the
//     defense-in-depth tenant boundary, not a replacement for it.
//
// Enforcement note: PostgreSQL does not apply RLS to superusers
// (BYPASSRLS). The embedded-PostgreSQL suites connect as `postgres`, so
// policy presence is verified there and ENFORCEMENT is verified with a
// non-superuser application role (see the t01/t06 suites). Production must
// use a non-superuser role for RLS to be enforced (documented activation
// requirement).
//
// The boundary is fail-closed: a tenant-scoped repository call can never
// see or write another tenant's rows, and the driver additionally verifies
// document ownership at the application layer (`assertTenantId` and the
// collection-level tenant checks).

import type pg from 'pg';
import { PostgresDriverError } from './errors.js';

export const TENANT_ID_COLUMN = 'tenant_id';
export const TENANT_RLS_SETTING = 'app.tenant_id';
/** Valid tenant-id alphabet (mirrors the storage-module validation). */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/**
 * Explicit system-scope marker for RLS sessions that must span tenants
 * (the driver's own pool, unscoped transactions). '*' is deliberately NOT a
 * valid tenant id, so a system context can never be confused with (or
 * forged as) a tenant context by the application layers.
 */
export const TENANT_SYSTEM_SCOPE = '*';

/** True when `value` is a usable tenant id (non-empty, safe charset). */
export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && TENANT_ID_PATTERN.test(value);
}

/**
 * Idempotently add the `tenant_id` column to a collection table, enable
 * row-level security with the T-06 strict policy, and backfill the column
 * from each row's own body (legacy rows written before the column existed).
 * This is invoked by `openCollection` on the production path so protection
 * is in place before the collection is used, and by `runWithTenant` for the
 * scoped helper. Safe to call multiple times and from multiple processes
 * (CREATE IF NOT EXISTS / ALTER TABLE IF EXISTS; policy-create races on
 * duplicate_object are treated as already-present).
 */
export async function ensureTenantIsolation(
  client: pg.PoolClient | pg.Pool,
  table: string,
): Promise<void> {
  const t = '"' + table.replace(/"/g, '""') + '"';
  // 1. Add the tenant_id column (nullable so existing rows aren't
  // invalidated).
  await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${TENANT_ID_COLUMN} text`).catch((err) => {
    throw new PostgresDriverError(
      `Failed to add ${TENANT_ID_COLUMN} column to ${table} (fail-closed): ${(err as Error).message}`,
    );
  });
  // 1b. Backfill legacy rows from their own body (idempotent): rows written
  // before the column existed keep their tenant in body.tenantId; once the
  // column is stamped, tenant-scoped RLS sessions can see them again.
  await client.query(
    `UPDATE ${t} SET ${TENANT_ID_COLUMN} = body->>'tenantId'
     WHERE ${TENANT_ID_COLUMN} IS NULL AND body ? 'tenantId'`,
  ).catch(() => undefined);
  // 2. Index for tenant-scoped queries.
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${t.replace(/"/g, '')}_tenant_idx ON ${t} (${TENANT_ID_COLUMN})`,
  ).catch(() => undefined);
  // 3. Enable RLS and define the strict policy (see module comment).
  await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).catch((err) => {
    throw new PostgresDriverError(
      `Failed to enable RLS on ${table} (fail-closed): ${(err as Error).message}`,
    );
  });
  // Drop & re-create the policy to keep it idempotent. Concurrent first-boot
  // create races surface as duplicate_object (42710); the policy then
  // already exists, which is the desired end state.
  await client.query(`DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${t}`).catch(() => undefined);
  await client.query(
    `CREATE POLICY ${table}_tenant_isolation ON ${t}
       USING (${TENANT_ID_COLUMN} = current_setting('${TENANT_RLS_SETTING}', true)
              OR current_setting('${TENANT_RLS_SETTING}', true) = '${TENANT_SYSTEM_SCOPE}')
       WITH CHECK (${TENANT_ID_COLUMN} = current_setting('${TENANT_RLS_SETTING}', true)
              OR current_setting('${TENANT_RLS_SETTING}', true) = '${TENANT_SYSTEM_SCOPE}')`,
  ).catch((err) => {
    if ((err as { code?: string })?.code === '42710') return;
    throw new PostgresDriverError(
      `Failed to create RLS policy on ${table} (fail-closed): ${(err as Error).message}`,
    );
  });
  // Force RLS even for the table owner (otherwise the owner bypasses
  // the policy; in production we always use a non-superuser
  // application role, but the FORCE keeps the contract honest).
  await client.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`).catch(() => undefined);
}

/**
 * Set the per-transaction tenant context using `SET LOCAL` so the
 * setting is bound to the transaction and reverts on commit/rollback.
 * The system marker is refused: system scope is set by the driver's pool
 * (or `setSystemTenantContext`), never through the tenant API.
 */
export async function setTenantContext(
  client: pg.PoolClient,
  tenantId: string,
): Promise<void> {
  if (!isTenantId(tenantId)) {
    throw new PostgresDriverError(
      'Tenant context must be a non-empty string of [A-Za-z0-9_-] (fail-closed).',
    );
  }
  // Use parameterised SQL to avoid injection; the GUC value is still
  // bounded by the regex above, but parameterised is the right habit.
  await client.query(`SELECT set_config('${TENANT_RLS_SETTING}', $1, true)`, [tenantId]);
}

/**
 * Set the per-transaction SYSTEM scope ('*') using `SET LOCAL`. Used by the
 * driver for unscoped transactions so their reads/writes behave exactly like
 * the pre-RLS driver. Never a tenant context.
 */
export async function setSystemTenantContext(client: pg.PoolClient): Promise<void> {
  await client.query(`SELECT set_config('${TENANT_RLS_SETTING}', $1, true)`, [TENANT_SYSTEM_SCOPE]);
}

/**
 * Result of a tenant-isolated operation. The operation is always
 * performed inside a transaction, so the caller never has to reason
 * about the boundary.
 */
export interface TenantContextOptions {
  /** Tenant id to bind the transaction to. */
  tenantId: string;
  /** Optional logger. */
  onWarning?: (message: string) => void;
}

/** Error class for tenant-isolation failures (distinct from
 *  PostgresDriverError so callers can disambiguate). */
export class TenantIsolationDriverError extends PostgresDriverError {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationDriverError';
  }
}

/**
 * Assert that the body of a document carries the expected tenant id.
 * This is the application-level check that complements RLS: even if
 * RLS is somehow disabled, a repository call that hands the driver a
 * document with the wrong tenant id fails closed.
 */
export function assertTenantId<T extends { tenantId?: string }>(doc: T, tenantId: string, context: string): void {
  if (!doc || typeof doc !== 'object') return;
  const docTenant = (doc as { tenantId?: string }).tenantId;
  if (docTenant === undefined) {
    throw new TenantIsolationDriverError(
      `Document in ${context} has no tenantId field; refusing to write (fail-closed).`,
    );
  }
  if (docTenant !== tenantId) {
    throw new TenantIsolationDriverError(
      `Document in ${context} has tenantId="${docTenant}" which does not match active tenant "${tenantId}" (cross-tenant write refused).`,
    );
  }
}
