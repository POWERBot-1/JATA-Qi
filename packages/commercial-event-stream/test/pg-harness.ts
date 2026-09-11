// T-05 real-PostgreSQL harness for the canonical delivery worker suites.
//
// Boots ONE embedded PostgreSQL server per test process and hands out fresh
// databases. Every worker under test gets its OWN PostgresDriver (own pool),
// so nothing is shared in-process except the database — the correctness
// boundary is the durable CAS, never a process-local mutex.
//
// PostgreSQL is a HARD requirement for these suites: when it cannot start the
// suites FAIL loudly ("DATABASE INTEGRATION NOT EXECUTED") rather than
// skipping, because T-05 acceptance depends on real transactional evidence.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver, type PostgresDriverConfig } from '@jataqi/storage-postgres';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule, type CommercialEventStreamModuleConfig } from '../src/index.js';

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
 * See `packages/storage-postgres/test/pg-test-harness.ts` for the full rationale.
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
      // surfaces immediately.
      if (!isTransientPgError(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

let server:
  | { pg: EmbeddedPostgres; port: number; user: string; password: string; databaseDir: string; started: boolean }
  | undefined;

async function ensureServer(): Promise<NonNullable<typeof server>> {
  if (server) return server;
  const port = 57000 + Math.floor(Math.random() * 900);
  const user = 'postgres';
  const password = 'postgres';
  const databaseDir = path.join(os.tmpdir(), `jataqi-t05-pg-${process.pid}`);
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
    onError: () => {},
  });
  try {
    // P1C-OBS-01: bounded readiness retry on the two post-boot-adjacent calls.
    // embedded-postgres resolves `start()` on the postmaster log line, which can
    // precede the TCP listener accepting; under concurrent per-file boots this
    // races and surfaces as ECONNREFUSED.
    await withPgReadinessRetry(() => pg.initialise());
    await withPgReadinessRetry(() => pg.start());
    server = { pg, port, user, password, databaseDir, started: true };
  } catch (error) {
    // A failed boot may have left a partial cluster behind.
    await pg.stop().catch(() => undefined);
    await removeClusterDir(databaseDir);
    // P1C-OBS-01: this harness already declares PostgreSQL a HARD requirement,
    // so a transient readiness failure must fail loudly rather than degrade the
    // suite into a false-negative. Only a genuine capability absence (no
    // binaries) may report unavailable.
    if (isTransientPgError(error)) {
      throw new Error(
        `[t05-pg] PostgreSQL boot failed with a TRANSIENT readiness error after bounded retry ` +
        `(binaries are present; refusing to degrade the suite). cause=${String((error as Error)?.message ?? error)}`,
      );
    }
    console.warn('[t05-pg] PostgreSQL unavailable:', String((error as Error)?.message ?? error));
    server = { pg, port, user, password, databaseDir, started: false };
  }
  return server;
}

export async function pgAvailable(): Promise<boolean> {
  return (await ensureServer()).started;
}

export async function stopPg(): Promise<void> {
  if (!server) return;
  const { pg, started, databaseDir } = server;
  server = undefined;
  if (started) await pg.stop().catch(() => undefined);
  await removeClusterDir(databaseDir);
}

let dbCounter = 0;

export async function freshDb(): Promise<{ database: string; connectionString: string; config: PostgresDriverConfig }> {
  const s = await ensureServer();
  if (!s.started) throw new Error('DATABASE INTEGRATION NOT EXECUTED: embedded PostgreSQL failed to start.');
  const database = `t05_${process.pid}_${dbCounter++}_${randomUUID().slice(0, 8)}`;
  // P1C-OBS-01: bounded readiness retry on the first post-boot connection.
  await withPgReadinessRetry(() => s.pg.createDatabase(database));
  const connectionString = `postgres://${s.user}:${s.password}@127.0.0.1:${s.port}/${database}`;
  return { database, connectionString, config: { connectionString, requireExplicitConfig: true, max: 6 } };
}

export async function dropDb(database: string): Promise<void> {
  if (!server?.started) return;
  await server.pg.dropDatabase(database).catch(() => undefined);
}

/**
 * Boot an independent kernel (own driver/pool) hosting the control plane and
 * the delivery worker. Several of these against one database model several
 * worker processes' worth of state ownership inside one test process; the
 * `.mjs` child worker models real OS processes.
 */
export async function bootWorkerKernel(
  config: PostgresDriverConfig,
  stream: CommercialEventStreamModuleConfig,
  now: () => number,
) {
  const driver = new PostgresDriver({ ...config, requireExplicitConfig: true });
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driverInstance: driver }));
  kernel.register(new CommercialControlPlaneModule({ now }));
  kernel.register(new CommercialEventStreamModule({ now, ...stream }));
  await kernel.boot();
  return {
    kernel,
    driver,
    storage: kernel.getModule<StorageModule>('storage'),
    control: kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService(),
    stream: kernel.getModule<CommercialEventStreamModule>('commercial-event-stream').getService(),
    async close() {
      await kernel.shutdown().catch(() => undefined);
      await driver.close().catch(() => undefined);
    },
  };
}
