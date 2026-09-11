// R2 fail-hard embedded-PostgreSQL helper for the durable-security suites.
// Unlike the canonical storage-postgres harness (which skips when PostgreSQL
// is unavailable), this helper THROWS: an R2 suite that cannot obtain a real
// PostgreSQL backend FAILS — it must never silently pass without exercising
// the durable store.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';

export interface R2Postgres {
  server: EmbeddedPostgres;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionString: string;
  stop(): Promise<void>;
}

/**
 * Deterministic lifecycle hygiene for the dedicated per-process cluster data
 * directory. Every `bootR2Postgres` allocates a private, pid-named directory
 * (`persistent: true`, so embedded-postgres will never remove it itself).
 * Removing it on stop/boot-failure prevents unbounded `/tmp` accumulation
 * across runs (each process ~40–50 MB) while never touching content we did
 * not create. Cleanup is best-effort: a teardown failure must never turn a
 * green suite red, and a leftover directory on an abnormal exit is bounded.
 */
async function removeClusterDir(databaseDir: string): Promise<void> {
  try {
    await fs.rm(databaseDir, { recursive: true, force: true });
  } catch {
    // Best-effort ops hygiene — never fail the suite over teardown.
  }
}

/**
 * P1C-OBS-01 (extension) — collision-free port allocation.
 *
 * The per-suite port windows are 250 wide, but the `portBase` values callers
 * pass can be closer together than that, so the windows OVERLAP. In this
 * package that is not theoretical: bases 58500 / 58600 / 58700 / 58800 are only
 * 100 apart, giving a four-way overlap across 58600-58949. A plain
 * `base + random(250)` can hand the SAME port to two suites running
 * concurrently; the losing postmaster fails to bind and the other suite sees
 * ECONNREFUSED — a red suite on an unmodified tree.
 *
 * Verify the candidate is actually free before handing it to embedded-postgres.
 * Exhaustion THROWS (fail-hard, consistent with this harness's contract); it
 * never skips and never silently reuses a busy port.
 */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, '127.0.0.1');
  });
}

async function pickFreePort(portBase: number, label: string): Promise<number> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = portBase + Math.floor(Math.random() * 250);
    if (await portIsFree(candidate)) return candidate;
  }
  throw new Error(`${label}: no free port in [${portBase}, ${portBase + 250}) after 60 attempts (fail-closed).`);
}

export async function bootR2Postgres(label: string, portBase: number): Promise<R2Postgres> {
  const port = await pickFreePort(portBase, 'bootR2Postgres');
  const user = 'postgres';
  const password = 'postgres';
  const databaseDir = path.join(os.tmpdir(), `jataqi-${label}-${process.pid}`);
  const server = new EmbeddedPostgres({
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
    // Fail-hard: any failure here rejects and fails the suite (no skip).
    await server.initialise();
    await server.start();
    const database = `${label.replace(/[^a-z0-9]/gi, '_')}_${process.pid}_${randomUUID().slice(0, 8)}`;
    // Startup-readiness retry (O-2): embedded-postgres resolves `start()` at
    // the postmaster's "ready to accept connections" log line, which can
    // precede the TCP listener actually accepting; a fresh server occasionally
    // refuses the first CREATE DATABASE connect (ECONNREFUSED). This step was
    // previously unguarded — the only post-boot connection without the bounded
    // retry that `bootR2StorageKernel` already applies. Retry it the same way,
    // then FAIL (never skip; never mask a real outage).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await server.createDatabase(database);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/ECONNREFUSED|connection refused|not accepting|terminated/i.test(message) || attempt === 3) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
      }
    }
    const connectionString = `postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
    return {
      server,
      port,
      user,
      password,
      database,
      connectionString,
      stop: async () => {
        await server.dropDatabase(database).catch(() => undefined);
        await server.stop().catch(() => undefined);
        await removeClusterDir(databaseDir);
      },
    };
  } catch (error) {
    // Boot (initialise/start/CREATE DATABASE) failed: best-effort stop and
    // remove the partial cluster so a failed boot does not leak a data
    // directory, then rethrow (the suite still FAILS — never skips).
    await server.stop().catch(() => undefined);
    await removeClusterDir(databaseDir);
    throw error;
  }
}

/** Boot a storage kernel over the given connection string (fail-hard). */
export async function bootR2StorageKernel(
  connectionString: string,
  max = 10,
): Promise<{ kernel: Kernel; storage: StorageModule; driver: PostgresDriver }> {
  // Embedded PostgreSQL has a known startup-readiness flake (a fresh
  // server occasionally refuses the first pool connection). Retry the
  // boot boundedly, then FAIL (never skip).
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const driver = new PostgresDriver({ connectionString, requireExplicitConfig: true, max });
    const kernel = createTestKernel();
    const storage = new StorageModule({ driverInstance: driver });
    kernel.register(storage);
    try {
      await kernel.boot();
      return { kernel, storage, driver };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/ECONNREFUSED|connection refused|not accepting|terminated/i.test(message) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  throw lastError;
}
