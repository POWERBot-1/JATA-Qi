// G10 regression suite — bounded PostgreSQL readiness protection
// (real embedded PostgreSQL; FAIL-HARD, no skip).
//
// Regression under test (G10, classification B — test/harness defect):
// embedded-postgres resolves `start()` before the TCP listener reliably
// accepts connections; the unguarded first connection used by the affected
// suites (p1-rls-probe, f01-event-fabric-pg, t05-payment-chain-pg,
// t06-knowledge-tenant-pg, t07-finalization-concurrency-pg) can then observe
// ECONNREFUSED and the suite goes red BEFORE any product assertion runs.
//
// Proven here against a REAL PostgreSQL:
//   1. the pre-fix pattern (single unguarded connection while the server is
//      not ready) fails with ECONNREFUSED — characterized, deterministic;
//   2. the remediation (bounded retry/backoff) bridges the REAL startup
//      window: transient ECONNREFUSED -> retry -> PostgreSQL ready ->
//      success, with at least two attempts proving the retry path executed;
//   3. a never-ready port fails after the bounded cap — no hang, redacted
//      attributable diagnostics;
//   4. a permanent failure (authentication) is NOT retried — it surfaces on
//      the first attempt;
//   5. diagnostics redact passwords, connection credentials, connection
//      strings, tokens and API keys;
//   6. `withPgReadiness` (the initialise/start guard) retries transient
//      operations and surfaces permanent ones immediately;
//   7. the transient predicate is REUSED from the existing harness
//      (same function reference — no competing definition).
//
// Tests run sequentially in declaration order: test 2 starts the shared
// server instance that tests 4-5 rely on; test 1 runs while it is not yet
// started.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import {
  PgReadinessError,
  isTransientPgError as readinessPredicate,
  redactPgDiagnostics,
  waitForPgReady,
  withPgReadiness,
} from './pg-readiness.js';
import { isTransientPgError as harnessPredicate } from './pg-test-harness.js';

const HOST = '127.0.0.1';
const USER = 'postgres';
// Distinctive (not the default 'postgres' literal) so the redaction
// assertions prove the configured credential cannot leak, not just a
// generic word.
const PASSWORD = 'g10readinesspw';
const WRONG_PASSWORD = 'g10wrongpassword';

let server: EmbeddedPostgres;
let port: number;
let clusterDir: string;
let started = false;
let characterizationError: PgReadinessError | undefined;
let neverReadyError: PgReadinessError | undefined;

async function removeClusterDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — never fail the suite over teardown.
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  port = 55500 + Math.floor(Math.random() * 500);
  clusterDir = path.join(os.tmpdir(), `jataqi-pg-readiness-${process.pid}`);
  server = new EmbeddedPostgres({
    databaseDir: clusterDir,
    port,
    user: USER,
    password: PASSWORD,
    authMethod: 'password',
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ['--no-locale', '--encoding=UTF8'],
    postgresFlags: [],
    onLog: () => {},
    onError: (e) => {
      // G10: postmaster stderr is preserved (not swallowed), redacted.
      console.warn('[pg-readiness-test] embedded postgres stderr:', redactPgDiagnostics(String((e as Error)?.message ?? e)));
    },
  });
  // Pre-initialise (initdb) so test 2's race window is exactly the
  // start() -> listener-accepting transition.
  await server.initialise();
});

after(async () => {
  if (started) await server.stop().catch(() => undefined);
  await removeClusterDir(clusterDir);
});

async function aClosedLoopbackPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(0, HOST, resolve));
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('expected numeric probe port');
  const closedPort = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return closedPort;
}

describe('G10 — bounded PostgreSQL readiness protection (real embedded PostgreSQL)', () => {
  it('characterizes the pre-fix failure: the unguarded single connection while the server is not ready fails ECONNREFUSED', async () => {
    assert.equal(started, false, 'server must not be started yet for the characterization');
    let thrown: unknown;
    try {
      await waitForPgReady({
        host: HOST,
        port,
        user: USER,
        password: PASSWORD,
        database: 'postgres',
        label: 'g10-characterization',
        maxAttempts: 1,
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof PgReadinessError, 'expected PgReadinessError');
    characterizationError = thrown as PgReadinessError;
    assert.equal(characterizationError.attemptsUsed, 1, 'single unguarded attempt — the pre-fix pattern');
    assert.match(characterizationError.lastErrorCode, /ECONNREFUSED/, 'refused while not ready');
    assert.match(characterizationError.message, /ECONNREFUSED/);
    assert.match(characterizationError.message, new RegExp(String(port)), 'port preserved for attribution');
    assert.match(characterizationError.message, /g10-characterization/, 'label preserved for attribution');
  });

  it('bounded retry bridges the REAL startup race (transient ECONNREFUSED -> retry/backoff -> ready -> success)', async () => {
    // start() begins 700ms after the first probe, so attempt 1 is
    // deterministically refused; the retry budget must then carry the
    // connection through to the real, just-started server.
    const startPromise = (async () => {
      await delay(700);
      await server.start();
      started = true; // teardown must stop the server even if this test fails
    })();
    try {
      const result = await waitForPgReady({
        host: HOST,
        port,
        user: USER,
        password: PASSWORD,
        database: 'postgres',
        label: 'g10-late-start',
      });
      assert.ok(result.attempts >= 2, `retry path must have executed (attempts=${result.attempts})`);
    } finally {
      await startPromise.catch(() => undefined);
    }
  });

  it('a never-ready port fails after the bounded cap without hanging, with redacted diagnostics', async () => {
    const deadPort = await aClosedLoopbackPort();
    const began = Date.now();
    let thrown: unknown;
    try {
      await waitForPgReady({
        host: HOST,
        port: deadPort,
        user: USER,
        password: PASSWORD,
        database: 'postgres',
        label: 'g10-never-ready',
        maxAttempts: 3,
        baseDelayMs: 25,
        connectTimeoutMs: 1000,
      });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - began;
    assert.ok(thrown instanceof PgReadinessError, 'expected PgReadinessError');
    neverReadyError = thrown as PgReadinessError;
    assert.equal(neverReadyError.attemptsUsed, 3, 'bounded cap hit — no infinite polling');
    assert.ok(elapsed < 10_000, `terminated promptly (elapsed=${elapsed}ms)`);
    assert.match(neverReadyError.message, /ECONNREFUSED/, 'attribution preserved (errno)');
    assert.match(neverReadyError.message, new RegExp(String(deadPort)), 'port preserved');
    assert.match(neverReadyError.message, /g10-never-ready/, 'label preserved');
    assert.ok(!neverReadyError.message.includes(PASSWORD), 'password never appears in diagnostics');
  });

  it('a permanent authentication failure is NOT retried — it surfaces on the first attempt', async () => {
    assert.equal(started, true, 'requires the running server from the late-start test');
    const began = Date.now();
    let thrown: unknown;
    try {
      await waitForPgReady({
        host: HOST,
        port,
        user: USER,
        password: WRONG_PASSWORD,
        database: 'postgres',
        label: 'g10-permanent-auth',
        maxAttempts: 5,
        baseDelayMs: 25,
      });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - began;
    assert.ok(thrown instanceof PgReadinessError, 'expected PgReadinessError');
    assert.equal(
      (thrown as PgReadinessError).attemptsUsed,
      1,
      'permanent failure must not be retried',
    );
    assert.ok(elapsed < 5000, `surfaced promptly (elapsed=${elapsed}ms)`);
    assert.match((thrown as PgReadinessError).message, /password authentication failed/);
    assert.ok(!((thrown as PgReadinessError).message ?? '').includes(WRONG_PASSWORD), 'wrong password never echoed');
  });

  it('diagnostics redact passwords, connection credentials, connection strings, tokens and API keys', () => {
    const connectionUri = `postgres://${USER}:${PASSWORD}@${HOST}:${port}/postgres`;
    const raw = `boot failed: connect via ${connectionUri} (password=${PASSWORD} token=tok_live_9f8e7d api_key=AKIAEXAMPLESECRET); auth: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig`;
    const redacted = redactPgDiagnostics(raw);
    assert.ok(!redacted.includes(PASSWORD), 'password redacted');
    assert.ok(!redacted.includes('tok_live_9f8e7d'), 'token redacted');
    assert.ok(!redacted.includes('AKIAEXAMPLESECRET'), 'API key redacted');
    assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiJ9'), 'Bearer token redacted');
    assert.ok(!redacted.includes(`${USER}:${PASSWORD}@`), 'URI userinfo redacted');
    assert.ok(redacted.includes('<redacted>'), 'redaction marker present');
    assert.ok(redacted.includes(`${HOST}:${port}/postgres`), 'non-secret host/port/database preserved');
    // Integration: the readiness error raised in test 1 must not carry the
    // configured credential either.
    assert.ok(characterizationError, 'characterization error from test 1');
    assert.ok(!characterizationError.message.includes(PASSWORD));
    assert.ok(!characterizationError.message.includes(`${USER}:${PASSWORD}`));
  });

  it('withPgReadiness retries transient boot operations and surfaces permanent ones immediately', async () => {
    // Transient twice, then success.
    let transientCalls = 0;
    const transientThenOk = async (): Promise<string> => {
      transientCalls += 1;
      if (transientCalls < 3) throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      return 'ok';
    };
    const transientResult = await withPgReadiness('g10-op-transient', transientThenOk, { baseDelayMs: 1 });
    assert.equal(transientResult, 'ok', 'transient operation retried until success');
    assert.equal(transientCalls, 3, 'exactly two transient failures before success');

    // Permanent: rethrown with original identity, never retried.
    let permanentCalls = 0;
    const permanent = new Error('password authentication failed for user "x"');
    const permanentOp = async (): Promise<never> => {
      permanentCalls += 1;
      throw permanent;
    };
    await assert.rejects(
      withPgReadiness('g10-op-permanent', permanentOp, { baseDelayMs: 1, maxAttempts: 5 }),
      (error: unknown) => error === permanent,
    );
    assert.equal(permanentCalls, 1, 'permanent operation not retried');

    // Transient exhaustion: bounded, wrapped with diagnostics.
    let exhaustedCalls = 0;
    const alwaysRefused = async (): Promise<never> => {
      exhaustedCalls += 1;
      throw new Error('connect ECONNREFUSED 127.0.0.1:1');
    };
    await assert.rejects(
      withPgReadiness('g10-op-exhausted', alwaysRefused, { baseDelayMs: 1, maxAttempts: 2 }),
      PgReadinessError,
    );
    assert.equal(exhaustedCalls, 2, 'bounded budget, no infinite polling');
  });

  it('reuses the existing repository transient predicate (no competing definition)', () => {
    assert.equal(
      readinessPredicate,
      harnessPredicate,
      'pg-readiness must reuse pg-test-harness.isTransientPgError verbatim',
    );
  });
});
