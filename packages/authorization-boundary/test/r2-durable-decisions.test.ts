import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthorizationDeniedError, AuthorizationGate } from '../src/index.js';
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

// R2 durable decisions (decideAsync) over real PostgreSQL. Fail-hard: if
// PostgreSQL cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let world: R2World;
const T0 = Date.now();

before(async () => {
  pg = await bootR2Postgres('r2decide', 57000);
  world = await buildR2World(pg.connectionString, T0);
});

after(async () => {
  await pg.stop();
});

describe('R2 durable decisions over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('renders an ALLOW with sealed durable citations and an S-10 DECISION row', async () => {
    const capabilityId = uniqueCapability('decide.allow');
    const registered = await world.store.registerManifestVersion(
      durableManifest(capabilityId),
      registrar(),
    );
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(durableRequest(capabilityId, session));
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(envelope.manifestId, registered.manifestId);
    assert.equal(envelope.manifestDigest, registered.digest);
    assert.equal(envelope.sessionEventId, session.eventId);
    assert.equal(envelope.sessionStatus, 'ACTIVE');
    assert.ok(envelope.securityStoreTxId, 'envelope must cite its security-store tx');
    // S-10 DECISION row exists: the decision appears in reconciliation.
    const orphans = await world.store.findDecisionsWithoutConsumption('acme');
    assert.ok(
      orphans.some((o) => o.envelopeId === envelope.envelopeId),
      'ALLOW decision must have a durable DECISION row',
    );
  });

  it('denies unknown capabilities with a machine-readable code', async () => {
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(
      durableRequest(uniqueCapability('decide.unknown'), session),
    );
    assert.equal(envelope.decision.decision, 'DENY');
    assert.ok(envelope.decision.reasonCodes.length > 0, 'DENY must carry reason codes');
    for (const code of envelope.decision.reasonCodes) {
      assert.match(code, /^[A-Z0-9_]+$/, 'reason codes are machine-readable');
    }
  });

  it('denies revoked sessions with PRINCIPAL_REVOKED', async () => {
    const capabilityId = uniqueCapability('decide.revoked');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const session = await mintSession(world);
    await world.sessions.revokeEvent(session.eventId, session.tenantId, 'r2-test', world.now());
    const envelope = await world.gate.decideAsync(durableRequest(capabilityId, session));
    assert.equal(envelope.decision.decision, 'DENY');
    assert.ok(envelope.decision.reasonCodes.includes('PRINCIPAL_REVOKED'));
    assert.equal(envelope.sessionStatus, 'REVOKED');
  });

  it('denies expired sessions with PRINCIPAL_REVOKED', async () => {
    const capabilityId = uniqueCapability('decide.expired');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const session = await mintSession(world, { lifetimeMs: 60_000 });
    world.advance(60_000 + 300_000 + 1);
    try {
      const envelope = await world.gate.decideAsync(durableRequest(capabilityId, session));
      assert.equal(envelope.decision.decision, 'DENY');
      assert.ok(envelope.decision.reasonCodes.includes('PRINCIPAL_REVOKED'));
      assert.equal(envelope.sessionStatus, 'EXPIRED');
    } finally {
      world.advance(-(60_000 + 300_000 + 1));
    }
  });

  it('enforces rate limits from durable state (shared across gate instances)', async () => {
    const capabilityId = uniqueCapability('decide.rate');
    await world.store.registerManifestVersion(
      durableManifest(capabilityId, { rateLimit: { windowMs: 60_000, max: 3 } }),
      registrar(),
    );
    const session = await mintSession(world);
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      outcomes.push((await world.gate.decideAsync(durableRequest(capabilityId, session))).decision.decision);
    }
    assert.deepEqual(outcomes, ['ALLOW', 'ALLOW', 'ALLOW']);
    // A SECOND gate over the same store still sees the exhausted window —
    // the counter is durable, not process-local.
    const gate2 = new AuthorizationGate({
      store: world.store,
      durableBroker: world.broker,
      now: world.now,
    });
    const fourth = await gate2.decideAsync(durableRequest(capabilityId, session));
    assert.equal(fourth.decision.decision, 'DENY');
  });

  it('refuses the sync decide() path when durable state is attached', () => {
    assert.throws(
      () => (world.gate as unknown as { decide(r: unknown): unknown }).decide({}),
      /decideAsync/,
    );
  });

  // LAST: stops the suite PostgreSQL to prove fail-closed on store loss.
  it('fails closed with SECURITY_STATE_UNAVAILABLE when PostgreSQL is gone', async () => {
    const capabilityId = uniqueCapability('decide.down');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const session = await mintSession(world);
    await pg.server.stop();
    // The failure receipt cannot be confirmed while the store is down, so
    // decideAsync throws (fail-closed) carrying SECURITY_STATE_UNAVAILABLE.
    await assert.rejects(() => world.gate.decideAsync(durableRequest(capabilityId, session)), (error: unknown) => {
      assert.ok(error instanceof AuthorizationDeniedError);
      assert.ok(error.reasons.includes('SECURITY_STATE_UNAVAILABLE'));
      return true;
    });
  });
});
