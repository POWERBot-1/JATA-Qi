// P1 fail-hard embedded-PostgreSQL harness for the production-posture
// qualification suites. Mirrors the R2 harness contract: an embedded
// PostgreSQL that cannot start FAILS the suite (never skips). Also creates
// the non-superuser application role the production RLS contract requires,
// and hands out both the admin and application connection strings.

import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export interface P1Postgres {
  server: EmbeddedPostgres;
  port: number;
  database: string;
  adminConnectionString: string;
  appConnectionString: string;
  appRole: string;
  principalsFile: string;
  stop(): Promise<void>;
}

/**
 * Deterministic lifecycle hygiene for the dedicated per-process cluster data
 * directory (O-3). Every boot allocates a private, pid-named directory with
 * `persistent: true`, so embedded-postgres will never remove it itself. We
 * remove it on stop/boot-failure to prevent unbounded `/tmp` accumulation
 * (~40–50 MB per PG-booting run) without ever touching content we did not
 * create. Best-effort: teardown failure must never fail the suite.
 */
function removeClusterDir(databaseDir: string): void {
  try {
    fs.rmSync(databaseDir, { recursive: true, force: true });
  } catch {
    // Best-effort ops hygiene — never fail the suite over teardown.
  }
}

export async function bootP1Postgres(label: string, portBase: number): Promise<P1Postgres> {
  const port = portBase + Math.floor(Math.random() * 250);
  const databaseDir = path.join(os.tmpdir(), `jataqi-${label}-${process.pid}`);
  const server = new EmbeddedPostgres({
    databaseDir,
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
  try {
    await server.initialise();
    await server.start();
    const database = `${label.replace(/[^a-z0-9]/gi, '_')}_${process.pid}_${randomUUID().slice(0, 8)}`.toLowerCase();
    await server.createDatabase(database);
    const adminConnectionString = `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;
    const admin = new pg.Pool({ connectionString: adminConnectionString, max: 4 });
    const appRole = `p1app_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    try {
      await admin.query(`CREATE ROLE ${appRole} LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${appRole}`);
      await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${appRole}`);
      await admin.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${appRole}`);
      await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${appRole}`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    const principalsFile = path.join(os.tmpdir(), `jataqi-${label}-principals-${randomUUID().slice(0, 8)}.json`);
    fs.writeFileSync(
      principalsFile,
      JSON.stringify([
        { token: 'p1-pg-token-alpha', principalId: 'p1-alpha', tenantId: 'acme', roles: ['agent'] },
        { token: 'p1-pg-token-beta', principalId: 'p1-beta', tenantId: 'acme', roles: ['observer'] },
      ]),
    );
    return {
      server,
      port,
      database,
      adminConnectionString,
      appConnectionString: `postgres://${appRole}:app_pw@127.0.0.1:${port}/${database}`,
      appRole,
      principalsFile,
      async stop() {
        await server.stop().catch(() => undefined);
        removeClusterDir(databaseDir);
      },
    };
  } catch (error) {
    // Boot failed: best-effort stop + remove the partial cluster so a failed
    // boot does not leak a data directory, then rethrow (suite still FAILS).
    await server.stop().catch(() => undefined);
    removeClusterDir(databaseDir);
    throw error;
  }
}
