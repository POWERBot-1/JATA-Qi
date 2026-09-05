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
import * as os from 'node:os';
import * as path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver, type PostgresDriverConfig } from '@jataqi/storage-postgres';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { CommercialEventStreamModule, type CommercialEventStreamModuleConfig } from '../src/index.js';

let server: { pg: EmbeddedPostgres; port: number; user: string; password: string; started: boolean } | undefined;

async function ensureServer(): Promise<NonNullable<typeof server>> {
  if (server) return server;
  const port = 57000 + Math.floor(Math.random() * 900);
  const user = 'postgres';
  const password = 'postgres';
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), `jataqi-t05-pg-${process.pid}`),
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
    await pg.initialise();
    await pg.start();
    server = { pg, port, user, password, started: true };
  } catch (error) {
    console.warn('[t05-pg] PostgreSQL unavailable:', String((error as Error)?.message ?? error));
    server = { pg, port, user, password, started: false };
  }
  return server;
}

export async function pgAvailable(): Promise<boolean> {
  return (await ensureServer()).started;
}

export async function stopPg(): Promise<void> {
  if (!server) return;
  const { pg, started } = server;
  server = undefined;
  if (started) await pg.stop().catch(() => undefined);
}

let dbCounter = 0;

export async function freshDb(): Promise<{ database: string; connectionString: string; config: PostgresDriverConfig }> {
  const s = await ensureServer();
  if (!s.started) throw new Error('DATABASE INTEGRATION NOT EXECUTED: embedded PostgreSQL failed to start.');
  const database = `t05_${process.pid}_${dbCounter++}_${randomUUID().slice(0, 8)}`;
  await s.pg.createDatabase(database);
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
