import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimIdempotency,
  idempotencyId,
  type A01AuthorizationEnvelope,
} from '../src/index.js';
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

// R2 retention floors + GC over real PostgreSQL. Fail-hard: if PostgreSQL
// cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let world: R2World;
const T0 = Date.now();
const DAY = 86_400_000;

before(async () => {
  pg = await bootR2Postgres('r2gc', 58200);
  world = await buildR2World(pg.connectionString, T0);
});

after(async () => {
  await pg.stop();
});

async function executeFresh(capabilityId: string, key?: string): Promise<A01AuthorizationEnvelope> {
  const session = await mintSession(world);
  const envelope = await world.gate.decideAsync(
    durableRequest(capabilityId, session, {
      run: { runId: `run-gc-${process.pid}-${key ?? 'plain'}`, correlationId: 'corr-gc' },
      ...(key ? { idempotencyKey: key } : {}),
    }),
  );
  assert.equal(envelope.decision.decision, 'ALLOW');
  await world.gate.executeAuthorized(envelope, async () => 'gc', {
    tool: 'test-tool',
    operation: 'do',
  });
  return envelope;
}

describe('R2 retention + GC over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('deletes nothing before the retention floors', async () => {
    const capabilityId = uniqueCapability('gc.floors');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    await executeFresh(capabilityId, `gc-floor-${process.pid}`);
    const summary = await world.store.runGarbageCollection(world.now() + 3_600_000);
    assert.deepEqual(summary, {
      deletedConsumedEnvelopes: 0,
      deletedIdempotency: 0,
      markedIdempotencyExpired: 0,
      deletedRateWindows: 0,
      deletedRunBudgets: 0,
      batches: 0,
    });
  });

  it('sweeps eligible rows past retention but never S-1 / revocation evidence', async () => {
    const capabilityId = uniqueCapability('gc.sweep');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const completedKey = `gc-sweep-completed-${process.pid}`;
    const executed = await executeFresh(capabilityId, completedKey);

    // A FAILED S-5 row (side effect throws; the error propagates honestly).
    const failedKey = `gc-sweep-failed-${process.pid}`;
    const session = await mintSession(world);
    const doomed = await world.gate.decideAsync(
      durableRequest(capabilityId, session, {
        run: { runId: `run-gc-fail-${process.pid}`, correlationId: 'corr-gc-fail' },
        idempotencyKey: failedKey,
      }),
    );
    await assert.rejects(() =>
      world.gate.executeAuthorized(
        doomed,
        async () => {
          throw new Error('boom');
        },
        { tool: 'test-tool', operation: 'do' },
      ),
    );

    // An orphan IN_PROGRESS S-5 row (claimed, never completed).
    const orphanKey = `gc-sweep-orphan-${process.pid}`;
    await world.store.transact({ tenantId: 'acme' }, async (collections) => {
      await claimIdempotency(collections.idempotency, {
        tenantId: 'acme',
        key: orphanKey,
        now: world.now(),
        leaseMs: 60_000,
      });
    });

    // Revocation evidence that GC must never touch.
    const doomedSession = await mintSession(world);
    await world.sessions.revokeEvent(doomedSession.eventId, 'acme', 'gc-test', world.now());

    world.advance(31 * DAY);
    const summary = await world.store.runGarbageCollection(world.now());
    assert.ok(summary.deletedConsumedEnvelopes >= 1, 'S-4 rows past retention are deleted');
    assert.ok(summary.deletedIdempotency >= 2, 'COMPLETED + FAILED S-5 rows are deleted');
    assert.ok(summary.markedIdempotencyExpired >= 1, 'orphan IN_PROGRESS rows are marked EXPIRED');
    assert.ok(summary.deletedRateWindows >= 1, 'stale S-6 windows are deleted');
    assert.ok(summary.deletedRunBudgets >= 1, 'stale S-7 budgets are deleted');
    assert.ok(summary.batches >= 1, 'every batch carries a GC_BATCH receipt');

    // S-1 manifest history survives; revocation evidence survives.
    assert.ok(await world.store.getActiveManifest(capabilityId));
    const revoked = await world.sessions.getEvent(doomedSession.eventId, 'acme');
    assert.equal(revoked?.status, 'REVOKED');

    // The orphan row still exists, now EXPIRED (reclaimable, never deleted).
    const orphanRow = await world.store.transact({ tenantId: 'acme' }, async (collections) =>
      collections.idempotency.get(idempotencyId('acme', orphanKey)),
    );
    assert.equal(orphanRow?.status, 'EXPIRED');

    // The consumed envelope row is gone (S-4 retention elapsed).
    const consumedRow = await world.store.transact({ tenantId: 'acme' }, async (collections) =>
      collections.consumedEnvelopes.get(executed.envelopeId),
    );
    assert.equal(consumedRow, undefined);
  });

  it('aborts (deleting nothing) when an ACTIVE manifest exceeds the S-4 retention interlock', async () => {
    const dbName = `r2gc_lock_${process.pid}`;
    await pg.server.createDatabase(dbName);
    const lockWorld = await buildR2World(
      `postgres://postgres:postgres@127.0.0.1:${pg.port}/${dbName}`,
      T0,
    );
    const capabilityId = uniqueCapability('gc.interlock');
    await lockWorld.store.registerManifestVersion(
      durableManifest(capabilityId, { maxLifetimeMs: 31 * DAY }),
      registrar(),
    );
    await assert.rejects(() => lockWorld.store.assertGcInterlock(), /interlock/);
    await assert.rejects(
      () => lockWorld.store.runGarbageCollection(lockWorld.now() + 40 * DAY),
      /interlock/,
    );
  });
});
