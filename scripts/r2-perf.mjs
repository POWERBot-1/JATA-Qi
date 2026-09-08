// R2 latency probe: R1 (sync, process-local) vs R2 (durable, PostgreSQL)
// decision + enforcement latency over embedded PostgreSQL. Prints a
// human-readable table and writes machine-readable JSON to
// docs/verification/r2-perf.json.
//
// Usage: node scripts/r2-perf.mjs [--iterations N] [--executions M]

import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { AuthenticationEventStore } from '@jataqi/authentication';
import {
  AuthorizationGate,
  CapabilityManifestRegistry,
  DurableCredentialBroker,
  InMemoryAuditSink,
  InMemoryCredentialMaterialProvider,
  SecurityStateStore,
} from '@jataqi/authorization-boundary';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { principal, baseRequest, manifest } = await import(
  '../packages/authorization-boundary/dist/test/helpers.js'
);

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
const ITERATIONS = flag('--iterations', 200);
const EXECUTIONS = flag('--executions', 100);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

function summarize(name, samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    name,
    n: sorted.length,
    meanMs: +mean.toFixed(3),
    p50Ms: +percentile(sorted, 50).toFixed(3),
    p95Ms: +percentile(sorted, 95).toFixed(3),
    p99Ms: +percentile(sorted, 99).toFixed(3),
    maxMs: +sorted[sorted.length - 1].toFixed(3),
  };
}

// -- R1 world (sync, process-local) ------------------------------------------
const r1Registry = new CapabilityManifestRegistry();
const r1Manifest = manifest({ capabilityId: 'perf.r1', maxLifetimeMs: 3_600_000, rateLimit: { windowMs: 3_600_000, max: 1_000_000 }, budgetPerRunCostUnits: 1_000_000 });
r1Registry.register(r1Manifest);
const r1Gate = new AuthorizationGate({ manifests: r1Registry, audit: new InMemoryAuditSink() });
function r1Request(i) {
  return baseRequest({
    principal: principal({ authenticationEventId: `perf-r1-${i}` }),
    capability: { capabilityId: 'perf.r1', capabilityVersion: '1' },
    run: { runId: `perf-r1-run-${i}`, correlationId: `perf-r1-corr-${i}` },
  });
}
for (let i = 0; i < 10; i += 1) r1Gate.decide(r1Request(`warm-${i}`));
const r1Samples = [];
for (let i = 0; i < ITERATIONS; i += 1) {
  const t0 = performance.now();
  const env = r1Gate.decide(r1Request(i));
  r1Samples.push(performance.now() - t0);
  if (env.decision.decision !== 'ALLOW') throw new Error('R1 perf baseline stopped allowing');
}

// -- R2 world (durable, PostgreSQL) ------------------------------------------
// O-3 lifecycle hygiene (repo-wide embedded-PG cleanup gap): this script
// allocates a persistent, pid-named embedded-PostgreSQL data directory
// (`persistent: true`, so embedded-postgres never removes it itself). The
// whole PostgreSQL lifecycle is wrapped in try/finally so the harness-owned
// directory is removed on SUCCESS and on any BOOT/RUNTIME failure — scoped
// strictly to this process's own `jataqi-r2perf-<pid>` allocation; it never
// touches unrelated /tmp content. Cleanup is best-effort so it can never mask
// the probe's real result; a removal error is logged (observable), and the
// probe's pass/fail/exit semantics are preserved unchanged.
const port = 60500 + Math.floor(Math.random() * 300);
const databaseDir = join(tmpdir(), `jataqi-r2perf-${process.pid}`);
let server;
let driver;
let database = '';

function removeOwnedDataDir() {
  try {
    rmSync(databaseDir, { recursive: true, force: true });
  } catch (error) {
    // Cleanup is best-effort and orthogonal to the probe result. Never mask
    // the probe's real outcome; log the residual for observability.
    console.error(
      `[r2-perf] cleanup warning: could not remove ${databaseDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

try {
  server = new EmbeddedPostgres({
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
  await server.initialise();
  await server.start();
  database = `r2perf_${process.pid}_${randomUUID().slice(0, 8)}`;
  await server.createDatabase(database);
  const connectionString = `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;

  driver = new PostgresDriver({ connectionString, requireExplicitConfig: true, max: 10 });
  const kernel = createTestKernel();
  const storage = new StorageModule({ driverInstance: driver });
  kernel.register(storage);
  await kernel.boot();
  const store = await SecurityStateStore.open(storage);
  const sessions = await AuthenticationEventStore.open(storage);
  const broker = new DurableCredentialBroker(store, new InMemoryCredentialMaterialProvider());
  const gate = new AuthorizationGate({ store, durableBroker: broker, audit: new InMemoryAuditSink() });

  const CAP = 'perf.r2';
  await store.registerManifestVersion(
    manifest({
      capabilityId: CAP,
      maxLifetimeMs: 3_600_000,
      rateLimit: { windowMs: 3_600_000, max: 1_000_000 },
      budgetPerRunCostUnits: 1_000_000,
    }),
    { principalId: 'user:registrar', tenantId: 'acme', authenticationEventId: 'evt-perf-registrar' },
  );
  const now = Date.now();
  await sessions.recordEvent(
    {
      eventId: 'evt-perf-1',
      tenantId: 'acme',
      principalId: 'user:alice',
      method: 'STATIC_TOKEN',
      verifiedAt: now,
      expiresAt: now + 3_600_000,
    },
    now,
  );
  function r2Request(i) {
    return baseRequest({
      principal: principal({ authenticationEventId: 'evt-perf-1' }),
      capability: { capabilityId: CAP, capabilityVersion: '1' },
      run: { runId: `perf-r2-run-${i}`, correlationId: `perf-r2-corr-${i}` },
    });
  }
  for (let i = 0; i < 5; i += 1) {
    const env = await gate.decideAsync(r2Request(`warm-${i}`));
    if (env.decision.decision !== 'ALLOW') throw new Error('R2 perf warmup denied');
  }
  const r2Samples = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t0 = performance.now();
    const env = await gate.decideAsync(r2Request(i));
    r2Samples.push(performance.now() - t0);
    if (env.decision.decision !== 'ALLOW') throw new Error(`R2 perf denied at ${i}`);
  }
  const r2ExecSamples = [];
  for (let i = 0; i < EXECUTIONS; i += 1) {
    const env = await gate.decideAsync(r2Request(`exec-${i}`));
    const t0 = performance.now();
    await gate.executeAuthorized(env, async () => 'perf', { tool: 'test-tool', operation: 'do' });
    r2ExecSamples.push(performance.now() - t0);
  }
  const retryStats = store.getRetryStats();

  const report = {
    generatedAt: new Date().toISOString(),
    iterations: ITERATIONS,
    executions: EXECUTIONS,
    decideR1SyncMs: summarize('decide R1 (sync, process-local)', r1Samples),
    decideR2DurableMs: summarize('decideAsync R2 (durable, PostgreSQL)', r2Samples),
    executeR2DurableMs: summarize('execute R2 (Tx-1 + side effect + Tx-2)', r2ExecSamples),
    retryStats,
  };
  mkdirSync(join(ROOT, 'docs/verification'), { recursive: true });
  writeFileSync(join(ROOT, 'docs/verification/r2-perf.json'), `${JSON.stringify(report, null, 2)}\n`);

  for (const row of [report.decideR1SyncMs, report.decideR2DurableMs, report.executeR2DurableMs]) {
    console.log(
      `${row.name}: n=${row.n} mean=${row.meanMs}ms p50=${row.p50Ms}ms p95=${row.p95Ms}ms p99=${row.p99Ms}ms max=${row.maxMs}ms`,
    );
  }
  console.log(`retryStats: ${JSON.stringify(retryStats)}`);
} finally {
  if (driver) await driver.close().catch(() => undefined);
  if (server) {
    if (database) await server.dropDatabase(database).catch(() => undefined);
    await server.stop().catch(() => undefined);
  }
  removeOwnedDataDir();
}
