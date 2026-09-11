// PostgreSQL integration harness for loop-host P-01 tests. Boots one real
// embedded PostgreSQL instance and hands out fresh databases so the loop-host
// can run against an authoritative, transactional, multi-process backend.
// When a real PostgreSQL cannot start, pgAvailable() is false and suites skip.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import type { PostgresDriverConfig } from '@jataqi/storage-postgres';
import EmbeddedPostgres from 'embedded-postgres';

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
 * P1C-OBS-01 remediation — transient-readiness signature + bounded retry.
 *
 * This is the harness named in the P2-S4 verification report (finding 6,
 * "loop-host embedded-PG parallel-boot flake"). `node --test` boots one embedded
 * PostgreSQL per test file and this workspace has eight such files, so the
 * postmaster readiness log line races the TCP listener under contention and
 * surfaces as ECONNREFUSED. Previously unguarded: the boot error was swallowed
 * into `started: false`, degrading eight real suites into trivially-passing
 * "SKIPPED" placeholders (a false-negative green), while an equivalent failure
 * at `createDatabase` threw and produced a RED run on an unmodified tree.
 *
 * Mirrors the proven `r2-pg.ts` (O-2) pattern.
 */
const PG_TRANSIENT_RE = /ECONNREFUSED|connection refused|not accepting|could not connect|terminating|terminated|the database system is (starting up|shutting down)/i;

export function isTransientPgError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { code?: string }).code ?? '')}` : String(error);
  return PG_TRANSIENT_RE.test(message);
}

async function withPgReadinessRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // Only the readiness race is retried; a genuine capability absence
      // (no binaries) surfaces immediately so the honest skip still works.
      if (!isTransientPgError(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

let server: {
  pg: EmbeddedPostgres;
  port: number;
  user: string;
  password: string;
  databaseDir: string;
  started: boolean;
} | undefined;

async function ensureServer(): Promise<typeof server> {
  if (server) return server;
  const port = 56000 + Math.floor(Math.random() * 1200);
  const user = 'postgres';
  const password = 'postgres';
  const databaseDir = path.join(os.tmpdir(), `jataqi-loophost-pg-${process.pid}`);
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
    onError: (e) => console.warn('[loophost-pg] server stderr:', String((e as Error)?.message ?? e)),
  });
  try {
    // P1C-OBS-01: bounded readiness retry (see the block comment above).
    await withPgReadinessRetry(() => pg.initialise());
    await withPgReadinessRetry(() => pg.start());
  } catch (error) {
    // A failed boot may have left a partial cluster behind.
    await pg.stop().catch(() => undefined);
    await removeClusterDir(databaseDir);
    // P1C-OBS-01: a transient error that survives bounded retry means the
    // binaries are present and the readiness race was simply lost. That must
    // fail loudly — it is NOT "PostgreSQL unavailable", and reporting it as such
    // would silently skip eight real integration suites.
    if (isTransientPgError(error)) {
      throw new Error(
        `[loophost-pg] PostgreSQL boot failed with a TRANSIENT readiness error after bounded retry ` +
        `(binaries are present; refusing to silently skip eight integration suites). ` +
        `cause=${String((error as Error)?.message ?? error)}`,
      );
    }
    console.warn('[loophost-pg] PostgreSQL genuinely unavailable (non-transient); suites will SKIP:', String((error as Error)?.message ?? error));
    server = { pg, port, user, password, databaseDir, started: false };
    return server;
  }
  server = { pg, port, user, password, databaseDir, started: true };
  return server;
}

export async function pgAvailable(): Promise<boolean> {
  const s = await ensureServer();
  return s !== undefined && s.started;
}

export async function stopPg(): Promise<void> {
  if (!server) return;
  const { pg, started, databaseDir } = server;
  if (started) await pg.stop().catch(() => undefined);
  await removeClusterDir(databaseDir);
  server = undefined;
}

let dbCounter = 0;

/** Create a fresh, isolated database for a test suite and a driver config. */
export async function freshDb(): Promise<{ database: string; config: PostgresDriverConfig } | undefined> {
  const s = await ensureServer();
  if (!s || !s.started) return undefined;
  const database = `loophost_${process.pid}_${dbCounter++}_${randomUUID().slice(0, 8)}`;
  // P1C-OBS-01: bounded readiness retry on the first post-boot connection —
  // previously the unguarded throw behind the RED-run signature.
  await withPgReadinessRetry(() => s.pg.createDatabase(database));
  return {
    database,
    config: {
      connectionString: `postgres://${s.user}:${s.password}@127.0.0.1:${s.port}/${database}`,
      requireExplicitConfig: true,
      max: 10,
    },
  };
}

export async function dropDb(database: string): Promise<void> {
  if (!server || !server.started) return;
  await server.pg.dropDatabase(database).catch(() => undefined);
}

export function makeDriver(config: PostgresDriverConfig): PostgresDriver {
  return new PostgresDriver({ ...config, requireExplicitConfig: true });
}

/** Compose a @jataqi/storage StorageModule backed by the given Postgres driver. */
export function makeStorage(driver: PostgresDriver): StorageModule {
  return new StorageModule({ driverInstance: driver });
}

/** Boot a kernel whose only module is the given storage module (minimal, fast). */
export async function bootStorageKernel(storage: StorageModule) {
  const kernel = createTestKernel();
  kernel.register(storage);
  await kernel.boot();
  return kernel;
}
