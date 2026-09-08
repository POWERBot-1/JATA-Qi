// P1 — PostgreSQL/RLS production posture probe (S4).
//
// The R2 implementation creates RLS policies on every collection table and
// verifies enforcement in test suites that deliberately connect through a
// non-superuser application role. Nothing, however, VERIFIED the posture of a
// real deployment at boot: the runtime role could be a superuser, could carry
// BYPASSRLS, could own the tables without FORCE ROW LEVEL SECURITY, or FORCE
// could have failed silently (pre-P1 the DDL error was swallowed).
//
// This probe turns those assumptions into an explicit, fail-closed production
// contract (P1 INV-11/INV-12). It performs ONLY read-only catalog queries plus
// a self-contained canary exercise on a dedicated scratch table that it
// creates and drops itself — it never touches real security collections'
// rows, never reads secrets, and never emits credentials.
//
// The probe result is deterministic and machine-readable: `ok === false`
// together with `failures` (stable codes) is a boot-blocking condition under
// the production posture. Diagnostics contain table/role names only.

import type pg from 'pg';
import { deriveTableName } from './naming.js';
import {
  ensureTenantIsolation,
  setTenantContext,
  TENANT_ID_COLUMN,
  TENANT_RLS_SETTING,
  TENANT_SYSTEM_SCOPE,
} from './tenant-isolation.js';

/** Stable failure codes produced by the probe (machine-readable contract). */
export type RlsProbeFailureCode =
  | 'P1_RLS_SUPERUSER_ROLE'
  | 'P1_RLS_BYPASSRLS_ROLE'
  | 'P1_RLS_TABLE_MISSING'
  | 'P1_RLS_NOT_ENABLED'
  | 'P1_RLS_FORCE_NOT_ENABLED'
  | 'P1_RLS_CANARY_CROSS_TENANT_READ'
  | 'P1_RLS_CANARY_CROSS_TENANT_WRITE'
  | 'P1_RLS_CANARY_NO_CONTEXT_BLIND'
  | 'P1_RLS_PROBE_ERROR';

export interface RlsProbeTableStatus {
  readonly table: string;
  readonly exists: boolean;
  readonly rlsEnabled: boolean;
  readonly forceRls: boolean;
  readonly ownedByCurrentUser: boolean;
}

export interface RlsProbeResult {
  readonly ok: boolean;
  readonly role: string;
  readonly isSuperuser: boolean;
  readonly bypassesRls: boolean;
  readonly tables: readonly RlsProbeTableStatus[];
  readonly canaryCrossTenantReadRefused: boolean;
  readonly canaryCrossTenantWriteRefused: boolean;
  readonly canaryNoContextBlind: boolean;
  readonly failures: readonly { readonly code: RlsProbeFailureCode; readonly detail: string }[];
  readonly probedAt: number;
}

/** The JATA Qi security collections whose RLS posture production must verify. */
export const P1_SECURITY_COLLECTIONS: readonly string[] = Object.freeze([
  'authorization.manifests',
  'authorization.credentials',
  'authorization.credential-uses',
  'authorization.consumed-envelopes',
  'authorization.idempotency',
  'authorization.rate-windows',
  'authorization.run-budgets',
  'authorization.decisions',
  'authentication.events',
  'authentication.token-registry',
]);

function fail(
  failures: { code: RlsProbeFailureCode; detail: string }[],
  code: RlsProbeFailureCode,
  detail: string,
): void {
  failures.push({ code, detail });
}

async function inTransaction<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* preserve the original error */
    }
    throw error;
  }
}

/**
 * Verify the production RLS posture of `pool`.
 *
 * Checks (all fail-closed):
 *  1. the connected role is neither `rolsuper` nor `rolbypassrls`;
 *  2. every expected security collection table exists with
 *     `relrowsecurity` AND `relforcerowsecurity` enabled;
 *  3. a canary exercise on a dedicated scratch table proves:
 *     cross-tenant read is refused, cross-tenant write is refused
 *     (WITH CHECK), and a session with NO tenant context sees no rows —
 *     including when the probe connection itself OWNS the canary table
 *     (owner + FORCE + tenant context must still be restricted).
 *
 * The canary table is created, exercised, and dropped inside this call. It
 * never holds real data. `extraCollections` extends the verified table set.
 */
export async function verifyRlsPosture(
  pool: pg.Pool,
  options: { readonly extraCollections?: readonly string[] } = {},
): Promise<RlsProbeResult> {
  const failures: { code: RlsProbeFailureCode; detail: string }[] = [];
  const collections = [
    ...P1_SECURITY_COLLECTIONS,
    ...(options.extraCollections ?? []),
  ];
  const client = await pool.connect();
  try {
    // -- 1. role posture ---------------------------------------------------
    let role = '(unknown)';
    let isSuperuser = true;
    let bypassesRls = true;
    try {
      const roles = await client.query(
        `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      const row = roles.rows[0] as
        | { rolname: string; rolsuper: boolean; rolbypassrls: boolean }
        | undefined;
      if (!row) {
        fail(failures, 'P1_RLS_PROBE_ERROR', 'current_user could not be resolved in pg_roles');
      } else {
        role = row.rolname;
        isSuperuser = row.rolsuper === true;
        bypassesRls = row.rolbypassrls === true;
        if (isSuperuser) {
          fail(
            failures,
            'P1_RLS_SUPERUSER_ROLE',
            `the runtime database role "${role}" is a superuser; superusers bypass RLS entirely. Use a dedicated non-superuser application role (fail-closed).`,
          );
        }
        if (bypassesRls) {
          fail(
            failures,
            'P1_RLS_BYPASSRLS_ROLE',
            `the runtime database role "${role}" has BYPASSRLS; it defeats every row-level security policy. Use a non-BYPASSRLS application role (fail-closed).`,
          );
        }
      }
    } catch (error) {
      fail(failures, 'P1_RLS_PROBE_ERROR', `pg_roles check failed: ${(error as Error).message}`);
    }

    // -- 2. security-table posture -----------------------------------------
    const tables: RlsProbeTableStatus[] = [];
    for (const logical of collections) {
      const table = deriveTableName('collection', logical);
      try {
        const res = await client.query(
          `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = $1 AND n.nspname = current_schema()`,
          [table],
        );
        const row = res.rows[0] as
          | { relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }
          | undefined;
        if (!row) {
          tables.push({ table, exists: false, rlsEnabled: false, forceRls: false, ownedByCurrentUser: false });
          fail(
            failures,
            'P1_RLS_TABLE_MISSING',
            `expected security collection table "${table}" (for "${logical}") does not exist; the security-state stores must open (and create their tables) before the posture is verified (fail-closed).`,
          );
          continue;
        }
        const rlsEnabled = row.relrowsecurity === true;
        const forceRls = row.relforcerowsecurity === true;
        const ownedByCurrentUser = row.owner === role;
        tables.push({ table, exists: true, rlsEnabled, forceRls, ownedByCurrentUser });
        if (!rlsEnabled) {
          fail(failures, 'P1_RLS_NOT_ENABLED', `ROW LEVEL SECURITY is not enabled on "${table}" (fail-closed).`);
        }
        if (!forceRls) {
          fail(
            failures,
            'P1_RLS_FORCE_NOT_ENABLED',
            `FORCE ROW LEVEL SECURITY is not enabled on "${table}"${
              ownedByCurrentUser ? ' (owned by the runtime role — the owner would bypass RLS)' : ''
            } (fail-closed).`,
          );
        }
      } catch (error) {
        tables.push({ table, exists: false, rlsEnabled: false, forceRls: false, ownedByCurrentUser: false });
        fail(failures, 'P1_RLS_PROBE_ERROR', `catalog check for "${table}" failed: ${(error as Error).message}`);
      }
    }

    // -- 3. canary exercise (dedicated scratch table; created + dropped) ----
    const canary = `p1_rls_canary_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    let canaryReadRefused = false;
    let canaryWriteRefused = false;
    let canaryBlind = false;
    try {
      await client.query(
        `CREATE TABLE "${canary}" (id text PRIMARY KEY, body jsonb NOT NULL, ${TENANT_ID_COLUMN} text, updated_at timestamptz NOT NULL DEFAULT now())`,
      );
      // Same strict policy the driver applies to every collection table —
      // including fail-closed FORCE (the probe connection OWNS this table, so
      // the canary also proves FORCE is actually effective for the owner).
      await ensureTenantIsolation(client, canary);
      // Seed two tenants' rows in system scope (the documented broad scope,
      // acquired explicitly for this maintenance-style write).
      await inTransaction(client, async () => {
        await client.query(`SELECT set_config('${TENANT_RLS_SETTING}', '${TENANT_SYSTEM_SCOPE}', true)`);
        await client.query(
          `INSERT INTO "${canary}" (id, body, ${TENANT_ID_COLUMN}) VALUES ('a', '{"v":1}', 'p1-canary-a'), ('b', '{"v":2}', 'p1-canary-b')`,
        );
      });

      // (a) tenant-a context: sees ONLY tenant-a's row; reading tenant-b's
      //     row by primary key returns nothing.
      await inTransaction(client, async () => {
        await setTenantContext(client, 'p1-canary-a');
        const visible = await client.query(`SELECT id FROM "${canary}"`);
        const foreign = await client.query(`SELECT id FROM "${canary}" WHERE id = 'b'`);
        canaryReadRefused = visible.rows.length === 1 && foreign.rows.length === 0;
      });
      if (!canaryReadRefused) {
        fail(
          failures,
          'P1_RLS_CANARY_CROSS_TENANT_READ',
          'a tenant-scoped session could read another tenant\'s canary row (RLS is not enforcing reads)',
        );
      }

      // (b) tenant-a context: writing a tenant-b row must violate WITH CHECK.
      try {
        await inTransaction(client, async () => {
          await setTenantContext(client, 'p1-canary-a');
          await client.query(
            `INSERT INTO "${canary}" (id, body, ${TENANT_ID_COLUMN}) VALUES ('c', '{"v":3}', 'p1-canary-b')`,
          );
        });
        fail(
          failures,
          'P1_RLS_CANARY_CROSS_TENANT_WRITE',
          'a tenant-scoped session could write another tenant\'s canary row (WITH CHECK is not enforcing writes)',
        );
      } catch {
        canaryWriteRefused = true; // expected: RLS violation error
      }

      // (c) NO tenant context (RESET): the session must see no rows at all.
      try {
        await inTransaction(client, async () => {
          await client.query(`RESET ${TENANT_RLS_SETTING}`);
          const visible = await client.query(`SELECT id FROM "${canary}"`);
          canaryBlind = visible.rows.length === 0;
        });
      } catch (error) {
        // RESET of an unset custom GUC can raise 'parameter ... cannot be
        // changed now' only inside a tx in odd builds; treat a hard error as
        // a failed blindness check (fail-closed direction).
        void error;
        canaryBlind = false;
      }
      if (!canaryBlind) {
        fail(
          failures,
          'P1_RLS_CANARY_NO_CONTEXT_BLIND',
          'a session with no tenant context could see canary rows (unset GUC must be blind)',
        );
      }
    } catch (error) {
      fail(failures, 'P1_RLS_PROBE_ERROR', `canary exercise failed: ${(error as Error).message}`);
    } finally {
      // Scratch cleanup: system scope, best effort (never masks a failure).
      try {
        await client.query(`SELECT set_config('${TENANT_RLS_SETTING}', '${TENANT_SYSTEM_SCOPE}', false)`);
        await client.query(`DROP TABLE IF EXISTS "${canary}"`);
        await client.query(`RESET ${TENANT_RLS_SETTING}`);
      } catch {
        /* best effort only */
      }
    }

    return {
      ok: failures.length === 0,
      role,
      isSuperuser,
      bypassesRls,
      tables,
      canaryCrossTenantReadRefused: canaryReadRefused,
      canaryCrossTenantWriteRefused: canaryWriteRefused,
      canaryNoContextBlind: canaryBlind,
      failures,
      probedAt: Date.now(),
    };
  } finally {
    client.release();
  }
}
