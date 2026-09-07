import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthorizationDeniedError,
  AuthorizationGate,
  CapabilityManifestRegistry,
  InMemoryAuditSink,
  type A01AuthorizationEnvelope,
  type A01CapabilityManifest,
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

// R2 enforcement binding (Tx-1/Tx-2) over real PostgreSQL. Fail-hard: if
// PostgreSQL cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let world: R2World;
const T0 = Date.now();

before(async () => {
  pg = await bootR2Postgres('r2enforce', 57600);
  world = await buildR2World(pg.connectionString, T0);
});

after(async () => {
  await pg.stop();
});

const EXPECTED = { tool: 'test-tool', operation: 'do' } as const;

async function decidedEnvelope(
  capabilityId: string,
  tenantRunId: string,
  idempotencyKey?: string,
): Promise<A01AuthorizationEnvelope> {
  const session = await mintSession(world);
  return world.gate.decideAsync(
    durableRequest(capabilityId, session, {
      run: { runId: tenantRunId, correlationId: `corr-${tenantRunId}` },
      ...(idempotencyKey ? { idempotencyKey } : {}),
      provenance: { source: 'r2-enforce-test' },
    }),
  );
}

describe('R2 enforcement binding over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('executes once: side effect runs, CONSUMED receipt closes reconciliation', async () => {
    const capabilityId = uniqueCapability('enforce.once');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const envelope = await decidedEnvelope(capabilityId, `run-once-${process.pid}`);
    assert.equal(envelope.decision.decision, 'ALLOW');
    let calls = 0;
    const result = await world.gate.executeAuthorized(
      envelope,
      async () => {
        calls += 1;
        return { ok: true };
      },
      { ...EXPECTED },
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1);
    const orphans = await world.store.findDecisionsWithoutConsumption('acme');
    assert.ok(
      !orphans.some((o) => o.envelopeId === envelope.envelopeId),
      'executed decision must leave reconciliation',
    );
    assert.ok(world.audit.consumed().length > 0, 'sink must hold a CONSUMED record');
  });

  it('refuses envelope replay: the side effect never runs twice', async () => {
    const capabilityId = uniqueCapability('enforce.replay');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const envelope = await decidedEnvelope(capabilityId, `run-replay-${process.pid}`);
    let calls = 0;
    await world.gate.executeAuthorized(envelope, async () => ({ n: ++calls }), { ...EXPECTED });
    await assert.rejects(
      () => world.gate.executeAuthorized(envelope, async () => ({ n: ++calls }), { ...EXPECTED }),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.ok(error.reasons.includes('REPLAYED_AUTHORIZATION'));
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it('returns the COMPLETED receipt for a reused idempotency key without re-running', async () => {
    const capabilityId = uniqueCapability('enforce.idem');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const key = `idem-${process.pid}-1`;
    const first = await decidedEnvelope(capabilityId, `run-idem-a-${process.pid}`, key);
    const second = await decidedEnvelope(capabilityId, `run-idem-b-${process.pid}`, key);
    let calls = 0;
    await world.gate.executeAuthorized(first, async () => ({ n: ++calls }), { ...EXPECTED });
    const replayed = (await world.gate.executeAuthorized(
      second,
      async () => ({ n: ++calls }),
      { ...EXPECTED },
    )) as unknown as Record<string, unknown>;
    assert.equal(calls, 1);
    assert.equal(replayed.idempotentReplay, true);
    assert.equal(replayed.decisionId, first.decision.decisionId);
    assert.equal(replayed.envelopeId, first.envelopeId);
  });

  it('conflicts a duplicate key while the first attempt holds a live lease', async () => {
    const capabilityId = uniqueCapability('enforce.conflict');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const key = `idem-${process.pid}-2`;
    const first = await decidedEnvelope(capabilityId, `run-conf-a-${process.pid}`, key);
    const second = await decidedEnvelope(capabilityId, `run-conf-b-${process.pid}`, key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const inFlight = world.gate.executeAuthorized(
      first,
      async () => {
        calls += 1;
        await gate;
        return 'first-result';
      },
      { ...EXPECTED },
    );
    await assert.rejects(
      () => world.gate.executeAuthorized(second, async () => 'second-result', { ...EXPECTED }),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.ok(error.reasons.includes('IDEMPOTENCY_CONFLICT'));
        return true;
      },
    );
    release();
    assert.equal(await inFlight, 'first-result');
    assert.equal(calls, 1);
  });

  it('enforces the pinned run budget across envelopes of one run', async () => {
    const capabilityId = uniqueCapability('enforce.budget');
    await world.store.registerManifestVersion(
      durableManifest(capabilityId, { budgetPerRunCostUnits: 10 }),
      registrar(),
    );
    const runId = `run-budget-${process.pid}`;
    const session = await mintSession(world);
    const first = await world.gate.decideAsync(
      durableRequest(capabilityId, session, {
        run: { runId, correlationId: `corr-${runId}` },
        budgetCostUnits: 6,
      }),
    );
    const second = await world.gate.decideAsync(
      durableRequest(capabilityId, session, {
        run: { runId, correlationId: `corr-${runId}` },
        budgetCostUnits: 6,
      }),
    );
    await world.gate.executeAuthorized(first, async () => 'one', { ...EXPECTED });
    await assert.rejects(
      () => world.gate.executeAuthorized(second, async () => 'two', { ...EXPECTED }),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.ok(error.reasons.includes('BUDGET_EXHAUSTED'));
        return true;
      },
    );
  });

  it('denies execution after a manifest rotation (stale citations)', async () => {
    const capabilityId = uniqueCapability('enforce.stale');
    const v1 = durableManifest(capabilityId);
    await world.store.registerManifestVersion(v1, registrar());
    const envelope = await decidedEnvelope(capabilityId, `run-stale-${process.pid}`);
    const v2: A01CapabilityManifest = {
      ...v1,
      version: '2',
      budgetPerRunCostUnits: v1.budgetPerRunCostUnits - 1,
    };
    await world.store.registerManifestVersion(v2, registrar());
    let calls = 0;
    await assert.rejects(
      () =>
        world.gate.executeAuthorized(
          envelope,
          async () => {
            calls += 1;
            return 'stale';
          },
          { ...EXPECTED },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.ok(error.reasons.includes('CAPABILITY_VERSION_MISMATCH'));
        return true;
      },
    );
    assert.equal(calls, 0);
  });

  it('denies execution when the session is revoked between decide and execute', async () => {
    const capabilityId = uniqueCapability('enforce.sessrev');
    await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(durableRequest(capabilityId, session));
    await world.sessions.revokeEvent(session.eventId, session.tenantId, 'r2-test', world.now());
    await assert.rejects(
      () => world.gate.executeAuthorized(envelope, async () => 'revoked', { ...EXPECTED }),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.ok(error.reasons.includes('PRINCIPAL_REVOKED'));
        return true;
      },
    );
  });

  it('refuses sync-path (R1) envelopes that carry no durable citations', async () => {
    const capabilityId = uniqueCapability('enforce.r1refuse');
    const m = durableManifest(capabilityId);
    await world.store.registerManifestVersion(m, registrar());
    const syncRegistry = new CapabilityManifestRegistry();
    syncRegistry.register(m);
    const syncGate = new AuthorizationGate({
      manifests: syncRegistry,
      audit: new InMemoryAuditSink(),
      now: world.now,
    });
    const session = await mintSession(world);
    const r1Envelope = syncGate.decide(durableRequest(capabilityId, session));
    assert.equal(r1Envelope.decision.decision, 'ALLOW');
    assert.equal(r1Envelope.manifestId, undefined);
    await assert.rejects(
      () => world.gate.executeAuthorized(r1Envelope, async () => 'r1', { ...EXPECTED }),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizationDeniedError);
        assert.ok(error.reasons.includes('CAPABILITY_VERSION_MISMATCH'));
        return true;
      },
    );
  });
});
