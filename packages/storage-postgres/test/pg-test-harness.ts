// Shared integration-test harness: boots a real embedded PostgreSQL instance
// (when binaries are available) and hands out per-suite databases and drivers.
//
// If a real PostgreSQL cannot be started in the current environment the harness
// reports `pgAvailable === false` and callers skip — so a machine without the
// binaries still shows CODE VERIFIED with DATABASE INTEGRATION NOT EXECUTED
// rather than a fabricated pass.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { PostgresDriverConfig } from '../src/index.js';
import { PostgresDriver } from '../src/index.js';

/** O-3 lifecycle hygiene: remove the pid-named cluster dir (never deleted by
 * `persistent: true` embedded-postgres) on stop/boot-failure. Best-effort. */
async function removeClusterDir(databaseDir: string): Promise<void> {
  try {
    await fs.rm(databaseDir, { recursive: true, force: true });
  } catch {
    // Best-effort — never fail the suite over teardown.
  }
}

let serverState: {
  pg: EmbeddedPostgres;
  port: number;
  user: string;
  password: string;
  databaseDir: string;
  started: boolean;
} | undefined;

async function ensureServer(): Promise<typeof serverState> {
  if (serverState) return serverState;
  const port = 55000 + Math.floor(Math.random() * 1000);
  const user = 'postgres';
  const password = 'postgres';
  const databaseDir = path.join(os.tmpdir(), `jataqi-pg-p01-${process.pid}`);
  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user,
    password,
    authMethod: 'password',
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ['--no-locale', '--encoding=UTF8'],
    postgresFlags: [],
    onLog: () => {},
    onError: (e) => {
      console.warn('[pg-test] embedded postgres stderr:', String((e as Error)?.message ?? e));
    },
  });
  try {
    await pg.initialise();
    await pg.start();
  } catch (error) {
    console.warn('[pg-test] PostgreSQL integration unavailable; tests will SKIP:', String((error as Error)?.message ?? error));
    serverState = { pg, port, user, password, databaseDir, started: false };
    // A failed boot may have left a partial cluster behind.
    await pg.stop().catch(() => undefined);
    await removeClusterDir(databaseDir);
    return serverState;
  }
  serverState = { pg, port, user, password, databaseDir, started: true };
  return serverState;
}

export async function stopServer(): Promise<void> {
  if (!serverState) return;
  const { pg, started, databaseDir } = serverState;
  if (started) await pg.stop().catch(() => undefined);
  await removeClusterDir(databaseDir);
  serverState = undefined;
}

/** True when a real PostgreSQL backend can be exercised in this environment. */
export async function pgAvailable(): Promise<boolean> {
  const state = await ensureServer();
  return state !== undefined && state.started;
}

let dbCounter = 0;

/**
 * Create a fresh dedicated database and return a driver config that connects
 * to it. Each call isolates the caller from other suites.
 */
export async function newTestDb(): Promise<{ database: string; config: PostgresDriverConfig } | undefined> {
  const state = await ensureServer();
  if (!state || !state.started) return undefined;
  const database = `jata_test_${process.pid}_${dbCounter++}_${randomUUID().slice(0, 8)}`;
  await state.pg.createDatabase(database);
  const config: PostgresDriverConfig = {
    connectionString: `postgres://${state.user}:${state.password}@127.0.0.1:${state.port}/${database}`,
    requireExplicitConfig: true,
    max: 10,
  };
  return { database, config };
}

export async function dropTestDb(database: string): Promise<void> {
  const state = serverState;
  if (!state || !state.started) return;
  await state.pg.dropDatabase(database).catch(() => undefined);
}

/** Build a fresh PostgresDriver (own connection pool) for the given config. */
export function makeDriver(config: PostgresDriverConfig): PostgresDriver {
  return new PostgresDriver({ ...config, requireExplicitConfig: true });
}
