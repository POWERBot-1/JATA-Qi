import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticationEventStore } from '@jataqi/authentication';
import type { PostgresDriver } from '@jataqi/storage-postgres';
import {
  AuthorizationDeniedError,
  AuthorizationGate,
  DurableCredentialBroker,
  InMemoryAuditSink,
  InMemoryCredentialMaterialProvider,
  SecurityStateStore,
  type A01AuthorizationEnvelope,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import {
  durableManifest,
  durableRequest,
  mintSession,
  registrar,
  uniqueCapability,
  type R2World,
} from './r2-fixtures.js';

// F1 (post-verification remediation) regression: a live PostgreSQL outage
// surfaces pool-level 'error' events. The driver MUST handle them (the host
// must not terminate from an unhandled pool event), mark the authoritative
// store degraded (observable via getPoolHealth), fail every security-state
// operation closed with SECURITY_STATE_UNAVAILABLE (no side effect, no
// memory fallback), and recover without a restart when PostgreSQL is
// healthy again.
//
// Fail-hard: real embedded PostgreSQL is stopped/restarted mid-suite (no
// mocks, no seam); if the backend cannot start, before() rejects and the
// suite FAILS (no skip). Note: an unhandled pool 'error' event would crash
// this very test process under node:test, so host survival is proven by
// the suite completing at all.

let pg: R2Postgres;
let driver: PostgresDriver;
let world: R2World;
let capabilityId: string;
let stashedEnvelope: A01AuthorizationEnvelope | undefined;
const T0 = Date.now();

async function pollFor(label: string, ready: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ready()) return;
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${label} (fail-hard; no silent pass)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function deniedReasons(error: unknown): readonly string[] {
  assert.ok(
    error instanceof AuthorizationDeniedError,
    `expected AuthorizationDeniedError, got ${error instanceof Error ? error.message : String(error)}`,
  );
  return error.reasons;
}

before(async () => {
  pg = await bootR2Postgres('r2poolout', 63400);
  const booted = await bootR2StorageKernel(pg.connectionString);
  driver = booted.driver;
  let now = T0;
  const clock = (): number => now;
  const store = await SecurityStateStore.open(booted.storage, { now: clock });
  const sessions = await AuthenticationEventStore.open(booted.storage);
  const provider = new InMemoryCredentialMaterialProvider();
  const broker = new DurableCredentialBroker(store, provider, { now: clock });
  const audit = new InMemoryAuditSink();
  const gate = new AuthorizationGate({ store, durableBroker: broker, audit, now: clock });
  world = {
    storage: booted.storage,
    store,
    sessions,
    broker,
    provider,
    gate,
    audit,
    now: clock,
    advance: (ms: number): void => {
      now += ms;
    },
  };
  capabilityId = uniqueCapability('pool.outage');
  await world.store.registerManifestVersion(durableManifest(capabilityId), registrar());
});

after(async () => {
  await pg.stop();
});

const EXPECTED = { tool: 'test-tool', operation: 'do' } as const;

describe('F1 pool-outage robustness over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'F1 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('healthy baseline: decide ALLOWs, execute runs the effect, pool is not degraded', async () => {
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(durableRequest(capabilityId, session));
    assert.equal(envelope.decision.decision, 'ALLOW');
    let effects = 0;
    await world.gate.executeAuthorized(
      envelope,
      async () => {
        effects += 1;
        return 'baseline';
      },
      { ...EXPECTED },
    );
    assert.equal(effects, 1);
    // A second, unexecuted ALLOW envelope: the outage tests below attempt to
    // execute it while the authoritative store is unreachable.
    stashedEnvelope = await world.gate.decideAsync(durableRequest(capabilityId, session));
    assert.equal(stashedEnvelope.decision.decision, 'ALLOW');
    const health = driver.getPoolHealth();
    assert.equal(health.degraded, false);
    assert.equal(health.poolErrors, 0);
  });

  it('pool outage: host survives, store is marked degraded, decide fails closed with SECURITY_STATE_UNAVAILABLE', async () => {
    assert.ok(stashedEnvelope, 'baseline must stash an unexecuted ALLOW envelope first');
    await pg.server.stop();
    // Every pooled backend dies; the pool emits 'error' (previously
    // unhandled → the host process died here). Survival + the recorded
    // degradation below prove F1 items 1–2.
    await pollFor('pool degradation to be recorded', () => driver.getPoolHealth().degraded, 15000);
    const health = driver.getPoolHealth();
    assert.ok(health.poolErrors >= 1, 'expected at least one recorded pool error');
    assert.ok(typeof health.lastPoolErrorAt === 'number');
    assert.ok(typeof health.lastPoolErrorMessage === 'string' && health.lastPoolErrorMessage.length > 0);

    const session = await mintSession(world).catch((error: unknown) => error);
    assert.ok(
      session instanceof Error,
      'session issuance during an outage must fail closed, not fabricate a session',
    );
    const preOutage = await world.sessions
      .recordEvent(
        {
          eventId: 'evt-outage-never',
          tenantId: 'acme',
          principalId: 'user:alice',
          method: 'STATIC_TOKEN',
          verifiedAt: T0,
          expiresAt: T0 + 3_600_000,
        },
        T0,
      )
      .then(
        () => 'written' as const,
        () => 'refused' as const,
      );
    assert.equal(preOutage, 'refused');

    const request = durableRequest(capabilityId, {
      eventId: 'evt-outage-1',
      tenantId: 'acme',
      principalId: 'user:alice',
      row: {} as never,
    });
    await assert.rejects(world.gate.decideAsync(request), (error: unknown) => {
      assert.ok(deniedReasons(error).includes('SECURITY_STATE_UNAVAILABLE'));
      return true;
    });
  });

  it('pool outage: a pre-outage ALLOW envelope executes no side effect and the gate keeps no memory fallback', async () => {
    assert.ok(stashedEnvelope, 'baseline must stash an unexecuted ALLOW envelope first');
    let effects = 0;
    await assert.rejects(
      world.gate.executeAuthorized(
        stashedEnvelope,
        async () => {
          effects += 1;
          return 'must-not-run';
        },
        { ...EXPECTED },
      ),
      (error: unknown) => {
        assert.ok(deniedReasons(error).includes('SECURITY_STATE_UNAVAILABLE'));
        return true;
      },
    );
    assert.equal(effects, 0, 'no side effect may run while the authoritative store is unreachable');
    // No memory fallback: the gate is still durably attached (sync decide
    // still refuses instead of consulting process-local state).
    assert.ok(world.gate.securityStore, 'gate must remain durably attached during an outage (no silent R1 downgrade)');
    assert.throws(() => world.gate.decide(null), (error: unknown) => {
      assert.ok(deniedReasons(error).includes('SECURITY_STATE_UNAVAILABLE'));
      return true;
    });
  });

  it('recovery: operations succeed again and degradation clears without a restart', async () => {
    await pg.server.start();
    // The pool replaces dead backends on demand; drive live decides until
    // one ALLOWs (each attempt exercises the F1 recovery hook).
    let envelope: A01AuthorizationEnvelope | undefined;
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        const session = await mintSession(world);
        const candidate = await world.gate.decideAsync(durableRequest(capabilityId, session));
        if (candidate.decision.decision === 'ALLOW') {
          envelope = candidate;
          break;
        }
      } catch {
        // Still recovering — retry until the deadline (fail-hard below).
      }
      if (Date.now() >= deadline) {
        assert.fail('PostgreSQL recovered but durable decide never ALLOWed again (fail-hard; no silent pass)');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(envelope);
    let effects = 0;
    const out = await world.gate.executeAuthorized(
      envelope,
      async () => {
        effects += 1;
        return 'recovered';
      },
      { ...EXPECTED },
    );
    assert.equal(out, 'recovered');
    assert.equal(effects, 1);
    const health = driver.getPoolHealth();
    assert.equal(health.degraded, false, 'degradation must clear once live round-trips succeed');
    assert.ok(health.poolErrors >= 1, 'the outage must remain visible in the monotonic error counter');
  });
});
