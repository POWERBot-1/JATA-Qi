// P2-S2 — multiprocess session/token lifecycle (A-18 32-process fan-out +
// multiprocess A-05 revoke/validate race) over ONE shared real PostgreSQL
// backend. Fail-hard: embedded-PostgreSQL boot failure FAILS the suite.
//
// Workers are separate OS processes (`p2-s2-fanout-worker.mjs`, mirrored on
// the R2 multiprocess harness): no process-local security state is shared —
// every verdict comes from the durable store.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import {
  AuthenticationEventStore,
  IdentityStore,
  SessionTokenService,
  TokenRegistryStore,
  fingerprintSessionToken,
} from '../src/index.js';

let pg: R2Postgres;
let sessions: AuthenticationEventStore;
let registry: TokenRegistryStore;
let identity: IdentityStore;
let service: SessionTokenService;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TENANT = `fanout-${process.pid}`;
const T0 = Date.now();
const now = T0;

function runWorker(op: 'mint' | 'verify' | 'rotate' | 'revoke', payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const encoded = Buffer.from(JSON.stringify({ ...payload, now }), 'utf8').toString('base64url');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(HERE, 'p2-s2-fanout-worker.mjs'), op, pg.connectionString, encoded],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`worker failed: ${error.message} :: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>);
        } catch {
          reject(new Error(`worker printed non-JSON: ${stdout} :: ${stderr}`));
        }
      },
    );
  });
}

function requireOk(result: Record<string, unknown>): Record<string, unknown> {
  assert.equal(result.workerError, undefined, `worker crashed: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true, `worker denied unexpectedly: ${JSON.stringify(result)}`);
  return result;
}

before(async () => {
  pg = await bootR2Postgres('p2s2fanout', 64000);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  sessions = await AuthenticationEventStore.open(storage);
  registry = await TokenRegistryStore.open(storage);
  identity = await IdentityStore.open(storage);
  service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: () => now });
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P2-S2 32-process session fan-out (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('A-18: 32 processes mint/verify/rotate/revoke over one store — consistent chains, zero lost revocations', async () => {
    // 32 principals (one tenant): the per-(principal, tenant) N=3 policy
    // never interferes, and the shared tenant exercises multiprocess
    // contention on one namespace.
    const principals = Array.from({ length: 32 }, (_, i) => `fan-${i}`);
    for (const principalId of principals) {
      await registry.importRecords(
        [{ token: `fanout-static-${principalId}`, tenantId: TENANT, principalId, roles: ['agent'] }],
        'p2-s2-fanout',
        now,
      );
    }

    // Wave 1 — 32 processes mint (fresh credential auth + token mint each).
    const minted = await Promise.all(
      principals.map((principalId) => runWorker('mint', { principalId, tenantId: TENANT, staticMaterial: `fanout-static-${principalId}` })),
    );
    for (const result of minted) requireOk(result);
    const firstMaterials = minted.map((m) => m.material as string);
    const eventIds = minted.map((m) => m.eventId as string);
    assert.equal(new Set(firstMaterials).size, 32, '32 distinct tokens minted');
    assert.equal(new Set(eventIds).size, 32, '32 distinct sessions minted');

    // Wave 2 — 32 processes verify (all ACCEPT, cross-process visibility).
    const verified = await Promise.all(
      firstMaterials.map((material) => runWorker('verify', { material, tenantId: TENANT })),
    );
    for (const result of verified) requireOk(result);

    // Wave 3 — 32 processes rotate (each event rotates exactly once).
    const rotated = await Promise.all(
      firstMaterials.map((material) => runWorker('rotate', { material, tenantId: TENANT })),
    );
    for (const result of rotated) {
      requireOk(result);
      assert.equal(result.rotationCount, 1);
    }
    const secondMaterials = rotated.map((m) => m.material as string);
    assert.equal(new Set(secondMaterials).size, 32, '32 distinct replacement tokens');

    // Wave 4 — old tokens are dead everywhere; new tokens verify everywhere.
    const oldChecks = await Promise.all(
      firstMaterials.map((material) => runWorker('verify', { material, tenantId: TENANT })),
    );
    for (const result of oldChecks) {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SESSION_TOKEN_UNKNOWN', `superseded token denies UNKNOWN, got ${JSON.stringify(result)}`);
    }
    const newChecks = await Promise.all(
      secondMaterials.map((material) => runWorker('verify', { material, tenantId: TENANT })),
    );
    for (const result of newChecks) requireOk(result);

    // Wave 5 — 32 processes revoke.
    const revoked = await Promise.all(
      secondMaterials.map((material) => runWorker('revoke', { material, tenantId: TENANT, reason: 'fanout-done' })),
    );
    for (const result of revoked) {
      requireOk(result);
      assert.equal(result.status, 'REVOKED');
    }

    // Parent-side final audit (authoritative reads):
    //  * all 32 rows REVOKED, rotation chains monotonic (count 1, previous set);
    //  * live fingerprints unique across the population (zero duplicates);
    //  * zero usable tokens remain (all 64 materials deny);
    //  * audit: exactly 32 CREATED + 32 ROTATED + 32 REVOKED.
    const fingerprints = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      const row = await sessions.getEvent(eventIds[i] as string, TENANT);
      assert.equal(row?.status, 'REVOKED', `row ${i} terminal`);
      assert.equal(row?.rotationCount, 1, `row ${i} rotated exactly once`);
      assert.ok(row?.previousFingerprint, `row ${i} keeps chain evidence`);
      assert.equal(row?.previousFingerprint, fingerprintSessionToken(firstMaterials[i] as string));
      assert.equal(row?.sessionFingerprint, fingerprintSessionToken(secondMaterials[i] as string));
      fingerprints.add(row?.sessionFingerprint as string);
    }
    assert.equal(fingerprints.size, 32, 'zero duplicate live fingerprints');
    for (const material of [...firstMaterials, ...secondMaterials]) {
      await assert.rejects(
        () => service.verify(material, TENANT, now),
        (error: unknown) => error instanceof Error && /SESSION_TOKEN_(REVOKED|UNKNOWN)/.test(error.message),
      );
    }
    assert.equal((await identity.queryEvents(TENANT, 'SESSION_CREATED')).length, 32);
    assert.equal((await identity.queryEvents(TENANT, 'SESSION_ROTATED')).length, 32);
    assert.equal((await identity.queryEvents(TENANT, 'SESSION_REVOKED')).length, 32);
  });

  it('multiprocess A-05: 8 processes rotating one token — exactly one winner', async () => {
    const tenantId = `fanout-race-${process.pid}`;
    await registry.importRecords(
      [{ token: 'fanout-race-static', tenantId, principalId: 'racer', roles: ['agent'] }],
      'p2-s2-fanout',
      now,
    );
    const minted = requireOk(await runWorker('mint', { principalId: 'racer', tenantId, staticMaterial: 'fanout-race-static' }));
    const material = minted.material as string;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runWorker('rotate', { material, tenantId })),
    );
    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok === false);
    assert.equal(winners.length, 1, 'exactly one cross-process rotation wins');
    assert.equal(losers.length, 7);
    for (const loser of losers) {
      assert.equal(loser.workerError, undefined, `no worker crash: ${JSON.stringify(loser)}`);
      assert.equal(loser.code, 'SESSION_TOKEN_UNKNOWN');
    }
    const row = await sessions.getEvent(minted.eventId as string, tenantId);
    assert.equal(row?.rotationCount, 1, 'the cross-process chain advanced exactly once');
    assert.equal((await identity.queryEvents(tenantId, 'SESSION_ROTATED')).length, 1);
  });

  it('multiprocess A-05: revoke commits, then 8 processes validate — zero post-revocation ALLOWs', async () => {
    const tenantId = `fanout-revoke-${process.pid}`;
    await registry.importRecords(
      [{ token: 'fanout-revoke-static', tenantId, principalId: 'revokee', roles: ['agent'] }],
      'p2-s2-fanout',
      now,
    );
    const minted = requireOk(await runWorker('mint', { principalId: 'revokee', tenantId, staticMaterial: 'fanout-revoke-static' }));
    const material = minted.material as string;
    // The revocation commits in the parent (one durable terminal state)...
    await service.revoke(material, tenantId, 'fanout-revoke', now);
    // ...then 8 separate processes present the token: ALL deny REVOKED.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runWorker('verify', { material, tenantId })),
    );
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SESSION_TOKEN_REVOKED', `post-revocation presentation denies, got ${JSON.stringify(result)}`);
    }
    assert.equal((await identity.queryEvents(tenantId, 'SESSION_REVOKED')).length, 1);
  });
});
