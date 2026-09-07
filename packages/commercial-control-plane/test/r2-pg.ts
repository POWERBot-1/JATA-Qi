// R2 fail-hard embedded-PostgreSQL helper for the authorization-boundary
// durable-security suites. Unlike the canonical storage-postgres harness
// (which skips when PostgreSQL is unavailable), this helper THROWS: an R2
// suite that cannot obtain a real PostgreSQL backend FAILS — it must never
// silently pass without exercising the durable store.

import { randomUUID } from 'node:crypto';
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

export async function bootR2Postgres(label: string, portBase: number): Promise<R2Postgres> {
  const port = portBase + Math.floor(Math.random() * 250);
  const user = 'postgres';
  const password = 'postgres';
  const server = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), `jataqi-${label}-${process.pid}`),
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
  // Fail-hard: any failure here rejects and fails the suite (no skip).
  await server.initialise();
  await server.start();
  const database = `${label.replace(/[^a-z0-9]/gi, '_')}_${process.pid}_${randomUUID().slice(0, 8)}`;
  await server.createDatabase(database);
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
    },
  };
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
