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

/**
 * P1C-OBS-01 remediation — transient-readiness signature.
 *
 * embedded-postgres resolves `start()` on the postmaster's "ready to accept
 * connections" log line, which can PRECEDE the TCP listener actually accepting
 * connections. Under the concurrent boot that `node --test` produces (one
 * embedded PostgreSQL per test file, several files per workspace) a runner can
 * therefore observe ECONNREFUSED against a server that is about to be ready.
 *
 * This is an infrastructure race, not a product failure and not an absence of
 * PostgreSQL. It must be retried — and, critically, it must NOT be allowed to
 * masquerade as "PostgreSQL is unavailable in this environment".
 */
const PG_TRANSIENT_RE = /ECONNREFUSED|connection refused|not accepting|could not connect|terminating|terminated|the database system is (starting up|shutting down)/i;

/** True when an error looks like the readiness race rather than a missing capability. */
export function isTransientPgError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { code?: string }).code ?? '')}` : String(error);
  return PG_TRANSIENT_RE.test(message);
}

/** P1C-OBS-01: bounded readiness retry, mirroring the proven `r2-pg.ts` (O-2) pattern. */
async function withPgReadinessRetry<T>(
  label: string,
  operation: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // Only the readiness race is retried. A genuine capability absence
      // (binaries missing, initdb unsupported) is surfaced immediately so the
      // honest-skip path still behaves as documented.
      if (!isTransientPgError(error) || attempt === attempts) throw error;
      pgDiagnostics.retries[label] = (pgDiagnostics.retries[label] ?? 0) + 1;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

/**
 * P1C-OBS-01 diagnostics: published so a future failure is attributable from
 * the job log alone instead of requiring an unretained blob download.
 */
export const pgDiagnostics: {
  attempts: Record<string, number>;
  retries: Record<string, number>;
  outcome: 'STARTED' | 'UNAVAILABLE' | 'TRANSIENT_FAILURE' | 'NOT_ATTEMPTED';
  detail?: string;
} = { attempts: {}, retries: {}, outcome: 'NOT_ATTEMPTED' };

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
    pgDiagnostics.attempts.initialise = (pgDiagnostics.attempts.initialise ?? 0) + 1;
    await withPgReadinessRetry('initialise', () => pg.initialise());
    pgDiagnostics.attempts.start = (pgDiagnostics.attempts.start ?? 0) + 1;
    await withPgReadinessRetry('start', () => pg.start());
  } catch (error) {
    // A failed boot may have left a partial cluster behind.
    await pg.stop().catch(() => undefined);
    await removeClusterDir(databaseDir);

    // P1C-OBS-01: the decisive distinction.
    //
    // BEFORE: every boot error set `started: false`, so a transient readiness
    // race silently degraded a real PostgreSQL integration suite into a
    // trivially-passing "SKIPPED" placeholder — a FALSE-NEGATIVE green run.
    //
    // AFTER: a transient error that survives bounded retry means the binaries
    // exist and the server merely lost a readiness race. That is a real
    // infrastructure failure and MUST fail loudly. Only a non-transient error
    // (no binaries / unsupported platform) keeps the documented honest skip.
    if (isTransientPgError(error)) {
      pgDiagnostics.outcome = 'TRANSIENT_FAILURE';
      pgDiagnostics.detail = String((error as Error)?.message ?? error);
      throw new Error(
        `[pg-test] PostgreSQL boot failed with a TRANSIENT readiness error after bounded retry ` +
        `(this is NOT "PostgreSQL unavailable" — the binaries are present; refusing to silently skip). ` +
        `diagnostics=${JSON.stringify(pgDiagnostics)} cause=${pgDiagnostics.detail}`,
      );
    }

    pgDiagnostics.outcome = 'UNAVAILABLE';
    pgDiagnostics.detail = String((error as Error)?.message ?? error);
    console.warn(
      '[pg-test] PostgreSQL integration genuinely unavailable (non-transient); tests will SKIP:',
      pgDiagnostics.detail,
    );
    serverState = { pg, port, user, password, databaseDir, started: false };
    return serverState;
  }
  pgDiagnostics.outcome = 'STARTED';
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
  // P1C-OBS-01: this was the SECOND unguarded post-boot connection (the first
  // being boot itself). A transient ECONNREFUSED here previously threw straight
  // out of the suite — producing a RED run on an unmodified tree, which is the
  // signature shared by 9 of the 10 historical CI failures. Bounded retry, then
  // a genuine failure (never a skip).
  pgDiagnostics.attempts.createDatabase = (pgDiagnostics.attempts.createDatabase ?? 0) + 1;
  await withPgReadinessRetry('createDatabase', () => state.pg.createDatabase(database));
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
