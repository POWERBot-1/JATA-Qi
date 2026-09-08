// P1 (S4) — RLS POSTURE PROBE SUITE.
//
// Proves the production PostgreSQL/RLS contract is actually verified:
//   * a superuser runtime role        ⇒ probe FAILS (P1_RLS_SUPERUSER_ROLE);
//   * a BYPASSRLS-free non-superuser role with RLS+FORCE on every security
//     table (incl. canary cross-tenant read/write refusal and no-context
//     blindness) ⇒ probe PASSES;
//   * a security table without FORCE  ⇒ probe FAILS (P1_RLS_FORCE_NOT_ENABLED).
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the
// suite FAILS (no skip — P1 qualification never silently passes).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { PostgresDriver, verifyRlsPosture, P1_SECURITY_COLLECTIONS, deriveTableName, ensureTenantIsolation } from '../src/index.js';

let server: EmbeddedPostgres;
let port: number;
let adminPool: pg.Pool;
let clusterDir: string;

/** O-3 lifecycle hygiene: remove the pid-named cluster dir on teardown
 * (`persistent: true` embedded-postgres never removes it). Best-effort. */
async function removeClusterDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — never fail the suite over teardown.
  }
}

before(async () => {
  port = 55900 + Math.floor(Math.random() * 400);
  clusterDir = path.join(os.tmpdir(), `jataqi-p1-probe-${process.pid}`);
  server = new EmbeddedPostgres({
    databaseDir: clusterDir,
    port,
    user: 'postgres',
    password: 'postgres',
    authMethod: 'password',
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ['--no-locale', '--encoding=UTF8'],
    postgresFlags: [],
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  adminPool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, max: 4 });
});

after(async () => {
  if (adminPool) await adminPool.end().catch(() => undefined);
  if (server) await server.stop().catch(() => undefined);
  await removeClusterDir(clusterDir);
});

async function freshDatabase(): Promise<string> {
  const name = `p1_probe_${randomUUID().slice(0, 8).replace(/-/g, '_')}`;
  await adminPool.query(`CREATE DATABASE ${name}`);
  return name;
}

/** Create every expected security collection table with RLS + FORCE. */
async function createSecurityTables(db: string, skipForceFor?: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/${db}`, max: 2 });
  try {
    for (const logical of P1_SECURITY_COLLECTIONS) {
      const table = deriveTableName('collection', logical);
      await pool.query(
        `CREATE TABLE IF NOT EXISTS "${table}" (id text PRIMARY KEY, body jsonb NOT NULL, tenant_id text, updated_at timestamptz NOT NULL DEFAULT now())`,
      );
      await ensureTenantIsolation(pool, table);
      if (skipForceFor !== undefined && logical === skipForceFor) {
        await pool.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function createAppRole(db: string): Promise<string> {
  const role = `p1app_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/${db}`, max: 2 });
  try {
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await pool.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
    await pool.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
    await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${role}`);
    return role;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

describe('P1 RLS posture probe (S4 — INV-11/INV-12)', () => {
  it('FAILS CLOSED for a superuser runtime role (P1_RLS_SUPERUSER_ROLE)', async () => {
    const db = await freshDatabase();
    await createSecurityTables(db);
    const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/${db}`, max: 2 });
    try {
      const result = await verifyRlsPosture(pool);
      assert.equal(result.ok, false, 'superuser posture must not pass');
      assert.equal(result.isSuperuser, true);
      assert.ok(result.failures.some((f) => f.code === 'P1_RLS_SUPERUSER_ROLE'), 'superuser failure code present');
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it('PASSES for a non-superuser role with RLS+FORCE on every security table (canary incl.)', async () => {
    const db = await freshDatabase();
    await createSecurityTables(db);
    const role = await createAppRole(db);
    const driver = new PostgresDriver({
      connectionString: `postgres://${role}:app_pw@127.0.0.1:${port}/${db}`,
      requireExplicitConfig: true,
      max: 4,
    });
    try {
      await driver.init();
      // The driver method caches the result for observability (INV-14).
      const result = await driver.verifyRlsPosture();
      assert.deepEqual(
        result.failures.map((f) => f.code),
        [],
        `probe must pass for a healthy non-superuser posture (got: ${JSON.stringify(result.failures)})`,
      );
      assert.equal(result.ok, true);
      assert.equal(result.isSuperuser, false);
      assert.equal(result.bypassesRls, false);
      assert.equal(result.canaryCrossTenantReadRefused, true);
      assert.equal(result.canaryCrossTenantWriteRefused, true);
      assert.equal(result.canaryNoContextBlind, true);
      assert.equal(result.tables.length, P1_SECURITY_COLLECTIONS.length);
      assert.ok(result.tables.every((t) => t.rlsEnabled && t.forceRls && t.exists));
      assert.equal(driver.getLastRlsPosture(), result, 'probe result cached for observability');
    } finally {
      await driver.close().catch(() => undefined);
    }
  });

  it('FAILS CLOSED for a BYPASSRLS runtime role (P1_RLS_BYPASSRLS_ROLE)', async () => {
    const db = await freshDatabase();
    await createSecurityTables(db);
    const bypassRole = `p1bypass_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    const admin = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/${db}`, max: 2 });
    try {
      await admin.query(`CREATE ROLE ${bypassRole} LOGIN PASSWORD 'bp_pw' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE`);
      await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${bypassRole}`);
      await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${bypassRole}`);
      await admin.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${bypassRole}`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    const pool = new pg.Pool({ connectionString: `postgres://${bypassRole}:bp_pw@127.0.0.1:${port}/${db}`, max: 2 });
    try {
      const result = await verifyRlsPosture(pool);
      assert.equal(result.ok, false, 'BYPASSRLS posture must not pass');
      assert.equal(result.bypassesRls, true);
      assert.ok(result.failures.some((f) => f.code === 'P1_RLS_BYPASSRLS_ROLE'), 'bypassrls failure code present');
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it('FAILS CLOSED when FORCE ROW LEVEL SECURITY is missing on a security table', async () => {
    const db = await freshDatabase();
    await createSecurityTables(db, 'authorization.manifests');
    const role = await createAppRole(db);
    const pool = new pg.Pool({ connectionString: `postgres://${role}:app_pw@127.0.0.1:${port}/${db}`, max: 2 });
    try {
      const result = await verifyRlsPosture(pool);
      assert.equal(result.ok, false, 'missing FORCE must not pass');
      assert.ok(
        result.failures.some((f) => f.code === 'P1_RLS_FORCE_NOT_ENABLED'),
        'force failure code present',
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it('FAILS CLOSED when an expected security table does not exist', async () => {
    const db = await freshDatabase();
    const role = await createAppRole(db);
    const pool = new pg.Pool({ connectionString: `postgres://${role}:app_pw@127.0.0.1:${port}/${db}`, max: 2 });
    try {
      const result = await verifyRlsPosture(pool);
      assert.equal(result.ok, false);
      assert.ok(
        result.failures.some((f) => f.code === 'P1_RLS_TABLE_MISSING'),
        'missing-table failure code present',
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it('diagnostics never contain credentials or connection strings', async () => {
    const db = await freshDatabase();
    await createSecurityTables(db);
    const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/${db}`, max: 2 });
    try {
      const result = await verifyRlsPosture(pool);
      const rendered = JSON.stringify(result);
      assert.ok(!rendered.includes('postgres:'), 'no credentials in probe diagnostics');
      assert.ok(!rendered.includes('connectionString'), 'no connection strings in probe diagnostics');
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});
