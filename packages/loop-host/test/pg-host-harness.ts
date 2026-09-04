// PostgreSQL integration harness for loop-host P-01 tests. Boots one real
// embedded PostgreSQL instance and hands out fresh databases so the loop-host
// can run against an authoritative, transactional, multi-process backend.
// When a real PostgreSQL cannot start, pgAvailable() is false and suites skip.

import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import type { PostgresDriverConfig } from '@jataqi/storage-postgres';
import EmbeddedPostgres from 'embedded-postgres';

let server: {
  pg: EmbeddedPostgres;
  port: number;
  user: string;
  password: string;
  started: boolean;
} | undefined;

async function ensureServer(): Promise<typeof server> {
  if (server) return server;
  const port = 56000 + Math.floor(Math.random() * 1200);
  const user = 'postgres';
  const password = 'postgres';
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), `jataqi-loophost-pg-${process.pid}`),
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
    await pg.initialise();
    await pg.start();
  } catch (error) {
    console.warn('[loophost-pg] PostgreSQL unavailable; suites will SKIP:', String((error as Error)?.message ?? error));
    server = { pg, port, user, password, started: false };
    return server;
  }
  server = { pg, port, user, password, started: true };
  return server;
}

export async function pgAvailable(): Promise<boolean> {
  const s = await ensureServer();
  return s !== undefined && s.started;
}

export async function stopPg(): Promise<void> {
  if (!server) return;
  const { pg, started } = server;
  if (started) await pg.stop().catch(() => undefined);
  server = undefined;
}

let dbCounter = 0;

/** Create a fresh, isolated database for a test suite and a driver config. */
export async function freshDb(): Promise<{ database: string; config: PostgresDriverConfig } | undefined> {
  const s = await ensureServer();
  if (!s || !s.started) return undefined;
  const database = `loophost_${process.pid}_${dbCounter++}_${randomUUID().slice(0, 8)}`;
  await s.pg.createDatabase(database);
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
