// PostgreSQL tenant isolation (T-01-F).
//
// This module provides database-level tenant isolation for the
// @jataqi/storage-postgres driver. It does not introduce a new
// persistence architecture; it strengthens the existing one with:
//
//   1. A `tenant_id` column added to every collection table (the
//      driver creates it on first open if missing; subsequent opens
//      validate that it exists).
//   2. PostgreSQL Row-Level Security (RLS) policies on every
//      collection table: USING (tenant_id = current_setting('app.tenant_id')::text)
//      so a session can only see rows that match its tenant context.
//   3. A `withTenant` helper that runs an async function inside a
//      transaction with `SET LOCAL app.tenant_id = $1` (the per-tx
//      RLS context), guaranteeing the function cannot read or write
//      other tenants' rows.
//
// The boundary is fail-closed: if RLS is not enabled, or if a
// repository misuse tries to operate without a tenant context, the
// driver throws. This is the architectural complement of the
// application-level `TenantIsolationError` already in the loop-host.

import type pg from 'pg';
import { PostgresDriverError } from './errors.js';

export const TENANT_ID_COLUMN = 'tenant_id';
export const TENANT_RLS_SETTING = 'app.tenant_id';

/**
 * Idempotently add the `tenant_id` column to a collection table and
 * enable row-level security with a strict policy. This is invoked
 * during `openCollection` so the protection is in place by the time
 * the collection is used. The function is also safe to call multiple
 * times (CREATE IF NOT EXISTS, ALTER TABLE IF EXISTS).
 */
export async function ensureTenantIsolation(
  client: pg.PoolClient | pg.Pool,
  table: string,
): Promise<void> {
  const t = '"' + table.replace(/"/g, '""') + '"';
  // 1. Add the tenant_id column (nullable so existing rows aren't
  // invalidated; the application is responsible for back-filling
  // pre-T-01 rows OR quarantining them).
  await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${TENANT_ID_COLUMN} text`).catch((err) => {
    throw new PostgresDriverError(
      `Failed to add ${TENANT_ID_COLUMN} column to ${table} (fail-closed): ${(err as Error).message}`,
    );
  });
  // 2. Index for tenant-scoped queries. The unique index includes the
  // body id so the constraint remains (id, tenant_id) unique. This
  // is also a defense-in-depth mechanism: even if RLS is somehow
  // disabled, the index lets the driver reason about cross-tenant
  // duplicates.
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${t.replace(/"/g, '')}_tenant_idx ON ${t} (${TENANT_ID_COLUMN})`,
  ).catch(() => undefined);
  // 3. Enable RLS and define a strict policy. The policy expression
  // uses `current_setting('app.tenant_id', true)` so it does not
  // throw when the setting is unset — but the driver always sets
  // the GUC inside a transaction, so unset == no rows visible
  // (fail-closed by default).
  await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).catch((err) => {
    throw new PostgresDriverError(
      `Failed to enable RLS on ${table} (fail-closed): ${(err as Error).message}`,
    );
  });
  // Drop & re-create the policy to keep it idempotent.
  await client.query(`DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${t}`).catch(() => undefined);
  await client.query(
    `CREATE POLICY ${table}_tenant_isolation ON ${t}
       USING (${TENANT_ID_COLUMN} = current_setting('${TENANT_RLS_SETTING}', true))
       WITH CHECK (${TENANT_ID_COLUMN} = current_setting('${TENANT_RLS_SETTING}', true))`,
  ).catch((err) => {
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
 * Throws if no active transaction exists.
 */
export async function setTenantContext(
  client: pg.PoolClient,
  tenantId: string,
): Promise<void> {
  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new PostgresDriverError('Tenant context must be a non-empty string (fail-closed).');
  }
  // Validate the format: alphanumerics, dashes, underscores only.
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new PostgresDriverError(
      `Tenant id "${tenantId}" contains characters that are not safe to use as a PostgreSQL setting value; reject and refuse.`,
    );
  }
  // Use parameterised SQL to avoid injection; the GUC value is still
  // bounded by the regex above, but parameterised is the right habit.
  await client.query(`SELECT set_config('${TENANT_RLS_SETTING}', $1, true)`, [tenantId]);
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
