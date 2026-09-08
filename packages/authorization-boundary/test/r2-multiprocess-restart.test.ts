import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { A01AuthorizationEnvelope, A01AuthorizationRequest } from '../src/index.js';
import { bootR2Postgres, type R2Postgres } from './r2-pg.js';
import {
  buildR2World,
  durableManifest,
  durableRequest,
  mintSession,
  registrar,
  uniqueCapability,
  type R2World,
} from './r2-fixtures.js';

// R2 multiprocess contention + restart recovery over real PostgreSQL.
// Fail-hard: if PostgreSQL cannot start, before() rejects and the suite
// FAILS (no skip).

let pg: R2Postgres;
let world: R2World;
const T0 = Date.now();
const HERE = path.dirname(fileURLToPath(import.meta.url));

function runWorker(
  mode: 'decide' | 'execute',
  payload: A01AuthorizationRequest | A01AuthorizationEnvelope,
): Promise<Record<string, unknown>> {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(HERE, 'r2-two-process-worker.mjs'), mode, pg.connectionString, encoded],
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

before(async () => {
  pg = await bootR2Postgres('r2mp', 58500);
  world = await buildR2World(pg.connectionString, T0);
});

after(async () => {
  await pg.stop();
});

describe('R2 multiprocess + restart over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('consumes one envelope exactly once across 8 separate processes', async () => {
    const capabilityId = uniqueCapability('mp.consume');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(durableRequest(capabilityId, session));
    assert.equal(envelope.decision.decision, 'ALLOW');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runWorker('execute', envelope)),
    );
    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok === false);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.result, 'worker-ok');
    assert.equal(losers.length, 7);
    for (const loser of losers) {
      const codes = (loser.reasonCodes ?? []) as string[];
      assert.ok(
        codes.includes('REPLAYED_AUTHORIZATION'),
        `loser must cite REPLAYED_AUTHORIZATION, got ${JSON.stringify(loser)}`,
      );
    }
  });

  it('shares one durable rate window across 32 separate processes (exactly max ALLOW)', async () => {
    const capabilityId = uniqueCapability('mp.rate');
    await world.store.registerManifestVersion(
      durableManifest(capabilityId, { rateLimit: { windowMs: 60_000, max: 5 } }),
      registrar(),
    );
    const session = await mintSession(world);
    const request = durableRequest(capabilityId, session);
    // V-2 stabilization (2026-09-08 remediation): each worker buckets its
    // decision into the epoch-anchored fixed window floor(now / windowMs) —
    // the exact S-6 fixed-window semantics the product guarantees. This
    // test's precondition is that all 32 decisions land in ONE window; when
    // the burst straddles a window boundary the (correct) limiter admits max
    // in EACH window and the exact-5 assertion fails spuriously (verified
    // 2026-09-08: on-demand reproduction at launch offsets ~56.6 s in-minute
    // yields exactly 10 = 5+5 allows, deterministically, on this branch AND
    // on canonical 10fc9ba — pre-existing, not a product defect). Align the
    // burst to a fresh window instead of hoping for one: if the current
    // window has less than ALIGNMENT_MARGIN_MS left, wait until just past
    // the boundary. Measured on this 2-vCPU runner: decide burst spans
    // [subtest start + 1.2 s, + 2.6 s] (spread 1.1–1.4 s; whole subtest
    // ≤ 3.1 s under full-suite load), so the 15 s margin is ~5x the worst
    // observed burst; a post-alignment straddle would require a >15 s burst,
    // never observed. This changes WHEN the burst starts — never WHAT it
    // asserts: 32 OS processes, one durable window, exactly max ALLOW.
    const WINDOW_MS = 60_000;
    const ALIGNMENT_MARGIN_MS = 15_000;
    const remainingInWindow = WINDOW_MS - (Date.now() % WINDOW_MS);
    if (remainingInWindow < ALIGNMENT_MARGIN_MS) {
      await new Promise((resolve) => setTimeout(resolve, remainingInWindow + 100));
    }
    const results = await Promise.all(
      Array.from({ length: 32 }, () => runWorker('decide', request)),
    );
    for (const result of results) {
      assert.equal(result.ok, true, `worker must answer, got ${JSON.stringify(result)}`);
    }
    const allows = results.filter((r) => r.decision === 'ALLOW');
    const denies = results.filter((r) => r.decision === 'DENY');
    assert.equal(allows.length, 5);
    assert.equal(denies.length, 27);
  });

  // LAST: restarts PostgreSQL itself, then proves every durable verdict
  // survived (sessions, manifests, consumption, idempotency, rate).
  it('recovers all security verdicts across a PostgreSQL restart', async () => {
    const capabilityId = uniqueCapability('mp.restart');
    const registered = await world.store.registerManifestVersion(
      durableManifest(capabilityId, { rateLimit: { windowMs: 60_000, max: 1 } }),
      registrar(),
    );
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(
      durableRequest(capabilityId, session, { idempotencyKey: `restart-${process.pid}` }),
    );
    assert.equal(envelope.decision.decision, 'ALLOW');
    await world.gate.executeAuthorized(envelope, async () => 'pre-restart', {
      tool: 'test-tool',
      operation: 'do',
    });
    // Exhaust the rate window (max 1): this decide consumed the only token.
    const denied = await world.gate.decideAsync(durableRequest(capabilityId, session));
    assert.equal(denied.decision.decision, 'DENY');

    await pg.server.stop();
    await pg.server.start();
    world = await buildR2World(pg.connectionString, T0);

    // Session row survived and is still ACTIVE.
    assert.equal((await world.sessions.assertActive(session.eventId, 'acme', world.now())).active, true);
    // Manifest authority survived.
    const active = await world.store.getActiveManifest(capabilityId);
    assert.equal(active?.digest, registered.digest);
    // S-4 consumption survived: replay still refused.
    await assert.rejects(
      () => world.gate.executeAuthorized(envelope, async () => 'post-restart', { tool: 'test-tool', operation: 'do' }),
      /REPLAYED_AUTHORIZATION/,
    );
    // S-6 rate window survived: the exhausted principal is still denied.
    const stillDenied = await world.gate.decideAsync(durableRequest(capabilityId, session));
    assert.equal(stillDenied.decision.decision, 'DENY');
    // S-5 COMPLETED survived: the same key replays the receipt, no side effect.
    const session2 = await mintSession(world, { principalId: 'user:bob' });
    const replay = await world.gate.decideAsync(
      durableRequest(capabilityId, session2, { idempotencyKey: `restart-${process.pid}` }),
    );
    let calls = 0;
    const out = (await world.gate.executeAuthorized(
      replay,
      async () => {
        calls += 1;
        return 're-ran';
      },
      { tool: 'test-tool', operation: 'do' },
    )) as unknown as Record<string, unknown>;
    assert.equal(calls, 0);
    assert.equal(out.idempotentReplay, true);
    assert.equal(out.envelopeId, envelope.envelopeId);
  });
});
