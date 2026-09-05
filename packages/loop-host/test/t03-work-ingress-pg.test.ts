// T-03 authenticated work ingress over a REAL PostgreSQL backend.
//
// Requirements 26-28: an authenticated submission must land in the durable,
// transactional, multi-process substrate with its principal snapshot intact;
// a restart must preserve that provenance; and a genuinely separate OS
// process must read the same authenticated authority boundary from the
// database — with no principal material ever passed on a command line.
//
// When PostgreSQL cannot start these suites SKIP and say so; they never
// fabricate a pass.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  DeterministicTestAuthenticator,
  PrincipalBoundary,
  testCredential,
  type TestPrincipalRecord,
} from '@jataqi/authentication';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import {
  LoopHostService,
  TenantIsolationError,
  WORK_COLLECTION,
  WorkIngressService,
  type AuthenticatedPrincipalSnapshot,
  type HostedWorkItem,
} from '../src/index.js';
import type { StorageModule } from '@jataqi/storage';
import { dropDb, freshDb, makeDriver, makeStorage, pgAvailable, stopPg } from './pg-host-harness.js';

after(async () => {
  await stopPg();
});

const RECORD: TestPrincipalRecord = { id: 'pg-ingress-caller', tenantId: 'acme', roles: ['agent', 'operator'] };
const OTHER: CommercialActor = { id: 'intruder', tenantId: 'other', roles: ['agent'] };

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'two-process-worker.mjs');

function runWorker(
  connectionString: string,
  mode: string,
  workerId: string,
  extraArgs: string[] = [],
): Promise<{ code: number | null; lines: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, connectionString, mode, workerId, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        lines: out
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              return { event: 'unparseable', raw: line };
            }
          }),
      });
    });
  });
}

async function bootIngress(kernel: Awaited<ReturnType<typeof import('./pg-host-harness.js').bootStorageKernel>>) {
  const host = new LoopHostService({ hostId: 't03-pg', leaseTtlMs: 30_000 });
  await host.init(kernel);
  const boundary = new PrincipalBoundary({
    policy: { mode: 'test-only', allowTestMethod: true },
    authenticators: [new DeterministicTestAuthenticator([RECORD])],
  });
  const ingress = new WorkIngressService({ boundary, host });
  return { host, ingress };
}

async function readRaw(kernel: { container: { resolve<T>(token: string): Promise<T> } }, id: string) {
  const storage = (await kernel.container.resolve<StorageModule>('storage')) as unknown as {
    collection<T>(name: string): Promise<{ get(id: string): Promise<T | undefined> }>;
  };
  const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
  return items.get(id);
}

describe('T-03 authenticated ingress over real PostgreSQL', async () => {
  const available = await pgAvailable();
  if (!available) {
    it('SKIPPED: PostgreSQL integration unavailable in this environment', () => {
      assert.ok(true, 'DATABASE INTEGRATION NOT EXECUTED — no fabricated pass.');
    });
    return;
  }

  it('T03-PG1: an authenticated submission persists to PostgreSQL with its snapshot intact', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const storage = makeStorage(driver);
    const { bootStorageKernel } = await import('./pg-host-harness.js');
    const kernel = await bootStorageKernel(storage);
    try {
      const { ingress } = await bootIngress(kernel);
      const receipt = await ingress.submit(testCredential(RECORD), {
        objective: 'Persist authenticated work to PostgreSQL.',
        idempotencyKey: 't03-pg1',
        correlationId: 't03-pg1-corr',
      });
      assert.ok(receipt.workId);
      assert.equal(receipt.tenantId, 'acme');

      const raw = await readRaw(kernel, receipt.workId);
      assert.ok(raw, 'the row must exist in PostgreSQL');
      const snapshot = raw?.principal as AuthenticatedPrincipalSnapshot;
      assert.equal(snapshot.version, 1);
      assert.equal(snapshot.principalId, RECORD.id);
      assert.equal(snapshot.tenantId, RECORD.tenantId);
      assert.deepEqual(snapshot.roles, [...RECORD.roles]);
      assert.equal(snapshot.authenticationEventId, receipt.authentication.authenticationEventId);
      // The credential material never reaches storage.
      const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
      const all = await (items as unknown as { all(): Promise<HostedWorkItem[]> }).all();
      assert.ok(!JSON.stringify(all).includes(testCredential(RECORD).material));
    } finally {
      await kernel.shutdown();
      await dropDb(db.database);
    }
  });

  it('T03-PG2: an unauthenticated submission persists NOTHING', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const storage = makeStorage(driver);
    const { bootStorageKernel } = await import('./pg-host-harness.js');
    const kernel = await bootStorageKernel(storage);
    try {
      const { ingress } = await bootIngress(kernel);
      await assert.rejects(
        () => ingress.submit({ method: 'DETERMINISTIC_TEST', material: 'forged' }, { objective: 'Nope.' }),
      );
      await assert.rejects(() => ingress.submit(undefined, { objective: 'Anonymous.' }));
      const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
      const all = await (items as unknown as { all(): Promise<HostedWorkItem[]> }).all();
      assert.equal(all.length, 0, 'no row may exist for a rejected submission');
    } finally {
      await kernel.shutdown();
      await dropDb(db.database);
    }
  });

  it('T03-PG3: a conflicting caller tenant is rejected and writes nothing', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const storage = makeStorage(driver);
    const { bootStorageKernel } = await import('./pg-host-harness.js');
    const kernel = await bootStorageKernel(storage);
    try {
      const { host, ingress } = await bootIngress(kernel);
      await assert.rejects(
        () => ingress.submit(testCredential(RECORD), { objective: 'Cross-tenant.', tenantId: 'other' }),
        /authoritative/,
      );
      const items = await storage.collection<HostedWorkItem>(WORK_COLLECTION);
      const all = await (items as unknown as { all(): Promise<HostedWorkItem[]> }).all();
      assert.equal(all.length, 0);
      // And no 'other'-tenant work is visible at all.
      assert.equal((await host.list(OTHER, { limit: 50 })).length, 0);
    } finally {
      await kernel.shutdown();
      await dropDb(db.database);
    }
  });

  it('T03-PG4: tenant isolation holds for ingress-created work', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const storage = makeStorage(driver);
    const { bootStorageKernel } = await import('./pg-host-harness.js');
    const kernel = await bootStorageKernel(storage);
    try {
      const { host, ingress } = await bootIngress(kernel);
      const receipt = await ingress.submit(testCredential(RECORD), { objective: 'Tenant scoped.', idempotencyKey: 't03-pg4' });
      await assert.rejects(() => host.get(OTHER, receipt.workId), TenantIsolationError);
      assert.equal((await host.list(OTHER, { limit: 50 })).length, 0);
      const mine = await host.list({ id: RECORD.id, tenantId: 'acme', roles: [...RECORD.roles] }, { limit: 50 });
      assert.equal(mine.length, 1);
    } finally {
      await kernel.shutdown();
      await dropDb(db.database);
    }
  });

  it('T03-PG5: restart/recovery preserves principal provenance across a fresh driver', async () => {
    const db = await freshDb();
    assert.ok(db);
    const { bootStorageKernel } = await import('./pg-host-harness.js');

    // Process 1: submit authenticated work, then shut everything down.
    const driver1 = makeDriver(db.config);
    const kernel1 = await bootStorageKernel(makeStorage(driver1));
    let workId = '';
    let eventId = '';
    try {
      const { ingress } = await bootIngress(kernel1);
      const receipt = await ingress.submit(testCredential(RECORD), {
        objective: 'Survive a restart.',
        idempotencyKey: 't03-pg5',
      });
      workId = receipt.workId;
      eventId = receipt.authentication.authenticationEventId;
    } finally {
      await kernel1.shutdown();
    }

    // Process 2: a brand-new driver and host recover the same work.
    const driver2 = makeDriver(db.config);
    const kernel2 = await bootStorageKernel(makeStorage(driver2));
    try {
      const host = new LoopHostService({ hostId: 't03-pg5-survivor', leaseTtlMs: 30_000 });
      await host.init(kernel2);
      const recovery = await host.recover();
      assert.equal(typeof recovery.reclaimed, 'number');

      const raw = await readRaw(kernel2, workId);
      assert.ok(raw, 'the work item must survive the restart');
      assert.equal(raw?.status, 'QUEUED');
      assert.equal(raw?.principal?.authenticationEventId, eventId, 'provenance must survive the restart');
      assert.equal(raw?.principal?.principalId, RECORD.id);
      assert.equal(raw?.principal?.tenantId, RECORD.tenantId);
      assert.deepEqual(raw?.principal?.roles, [...RECORD.roles]);
    } finally {
      await kernel2.shutdown();
      await dropDb(db.database);
    }
  });

  it('T03-PG6: a separate OS process reads the same authenticated authority boundary', async () => {
    const db = await freshDb();
    assert.ok(db);
    const driver = makeDriver(db.config);
    const storage = makeStorage(driver);
    const { bootStorageKernel } = await import('./pg-host-harness.js');
    const kernel = await bootStorageKernel(storage);
    try {
      const { ingress } = await bootIngress(kernel);
      const receipt = await ingress.submit(testCredential(RECORD), {
        objective: 'Two-process authority continuity.',
        idempotencyKey: 't03-pg6',
      });

      // The child receives ONLY the actor (for a tenant-scoped read) and the
      // work id. No principal, no event id, no roles, no credential.
      const childArgv = [JSON.stringify({ id: RECORD.id, tenantId: RECORD.tenantId, roles: [...RECORD.roles] }), receipt.workId];
      assert.ok(
        !childArgv.join(' ').includes(receipt.authentication.authenticationEventId),
        'the test must not smuggle principal material to the child process',
      );

      const result = await runWorker(db.config.connectionString as string, 'echo-principal', 'proc-t03', childArgv);
      assert.equal(result.code, 0);
      const echo = result.lines.find((line) => line.event === 'principal-echo');
      assert.ok(echo, `expected a principal-echo line, got ${JSON.stringify(result.lines)}`);
      assert.equal(echo.found, true);
      assert.equal(echo.workId, receipt.workId);
      assert.equal(echo.tenantId, 'acme');
      const snapshot = echo.snapshot as AuthenticatedPrincipalSnapshot;
      assert.equal(snapshot.version, 1);
      assert.equal(snapshot.principalId, RECORD.id);
      assert.equal(snapshot.tenantId, RECORD.tenantId);
      assert.deepEqual(snapshot.roles, [...RECORD.roles]);
      assert.equal(snapshot.authenticationEventId, receipt.authentication.authenticationEventId);
    } finally {
      await kernel.shutdown();
      await dropDb(db.database);
    }
  });
});
