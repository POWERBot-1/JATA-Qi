import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import {
  AuthenticationEventStore,
  DeterministicTestAuthenticator,
  testCredential,
  type AuthenticatedPrincipal,
} from '@jataqi/authentication';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import type { LoopRunResult } from '@jataqi/unified-loop';
import type { LoopHostService } from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import { buildHarness, reasoningTask, type Harness } from './helpers.js';

// R2 dispatch-time session re-validation over real PostgreSQL. Fail-hard:
// if PostgreSQL cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let h: Harness;
let sessions: AuthenticationEventStore;
let svc: LoopHostService;
let runnerCalls = 0;

function stubResult(): LoopRunResult {
  return {
    loopId: 'loop-r2',
    correlationId: 'corr-r2',
    tenantId: 'acme',
    outcome: 'COMPLETED',
    trace: [],
    stageOutputs: {},
    records: [],
    finalStage: 'OUTCOME',
    startedAt: 1,
    endedAt: 2,
    continuation: 'TERMINATE',
  } as unknown as LoopRunResult;
}

async function mintPrincipalWithSession(
  actor: CommercialActor,
  requestId: string,
  lifetimeMs: number,
): Promise<AuthenticatedPrincipal> {
  const record = { id: actor.id, tenantId: actor.tenantId, roles: [...actor.roles] };
  const auth = new DeterministicTestAuthenticator([record]);
  const principal = await auth.verify(testCredential(record), h.now(), requestId);
  await sessions.recordEvent(
    {
      eventId: principal.authenticationEventId,
      tenantId: principal.tenantId,
      principalId: principal.id,
      method: 'DETERMINISTIC_TEST',
      verifiedAt: h.now(),
      expiresAt: h.now() + lifetimeMs,
    },
    h.now(),
  );
  return principal;
}

before(async () => {
  pg = await bootR2Postgres('r2loophost', 59400);
  const booted = await bootR2StorageKernel(pg.connectionString);
  // Sessions open over the pre-booted handle; the harness kernel gets a
  // fresh module on the same driver/pool, so both see the same rows.
  sessions = await AuthenticationEventStore.open(booted.storage);
  h = await buildHarness({
    storageModule: new StorageModule({ driverInstance: booted.driver }),
    loopHostConfig: { sessionStore: sessions },
  });
  svc = h.host();
  svc.setRunner(async (_actor, _task, opts) => {
    runnerCalls += 1;
    assert.ok(opts.principal, 'runner must receive principal evidence');
    return stubResult();
  });
  svc.start();
});

after(async () => {
  await pg.stop();
});

describe('R2 dispatch session re-validation over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('dispatches work whose session is ACTIVE', async () => {
    const principal = await mintPrincipalWithSession(h.actor, `r2-active-${process.pid}`, 3_600_000);
    const before = runnerCalls;
    await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    const summary = await svc.tick();
    assert.equal(summary.dispatched, 1);
    assert.equal(runnerCalls, before + 1);
  });

  it('holds work whose session was revoked after enqueue (PRINCIPAL_REVOKED, never dispatched)', async () => {
    const principal = await mintPrincipalWithSession(h.actor, `r2-revoked-${process.pid}`, 3_600_000);
    const before = runnerCalls;
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    await sessions.revokeEvent(principal.authenticationEventId, h.actor.tenantId, 'r2-test', h.now());
    const summary = await svc.tick();
    assert.equal(summary.held, 1);
    assert.equal(runnerCalls, before);
    const held = await svc.list(h.actor, { status: 'HELD' });
    assert.ok(held.some((entry) => entry.id === item.id && entry.heldReason === 'PRINCIPAL_REVOKED'));
  });

  it('holds work whose session is expired or unknown', async () => {
    const expired = await mintPrincipalWithSession(h.actor, `r2-expired-${process.pid}`, 60_000);
    await svc.enqueue(h.actor, { task: reasoningTask() }, expired);
    const record = { id: h.actor.id, tenantId: h.actor.tenantId, roles: [...h.actor.roles] };
    const ghost = await new DeterministicTestAuthenticator([record]).verify(
      testCredential(record),
      h.now(),
      `r2-ghost-${process.pid}`,
    );
    await svc.enqueue(h.actor, { task: reasoningTask() }, ghost);
    const before = runnerCalls;
    const summary = await svc.tick();
    assert.equal(summary.held, 2);
    assert.equal(runnerCalls, before);
    const held = await svc.list(h.actor, { status: 'HELD' });
    assert.ok(held.length >= 2);
    assert.ok(held.every((item) => item.heldReason === 'PRINCIPAL_REVOKED'));
  });

  it('dispatches kernel-internal snapshots without an S-8 row (verified bypass)', async () => {
    const kernelPrincipal = {
      id: 'kernel:worker-1',
      tenantId: h.actor.tenantId,
      roles: [...h.actor.roles],
      authenticationMethod: 'KERNEL_INTERNAL',
      verifiedAt: h.now(),
      authenticationEventId: `kernel-evt-${process.pid}`,
    } as unknown as AuthenticatedPrincipal;
    const kernelActor: CommercialActor = {
      id: 'kernel:worker-1',
      tenantId: h.actor.tenantId,
      roles: [...h.actor.roles],
    };
    const before = runnerCalls;
    await svc.enqueue(kernelActor, { task: reasoningTask() }, kernelPrincipal);
    const summary = await svc.tick();
    assert.equal(summary.dispatched, 1);
    assert.equal(runnerCalls, before + 1);
  });

  // LAST: stops PostgreSQL to prove a session-store outage fails closed.
  it('fails closed (throws, never dispatches) when the session store is unavailable', async () => {
    const principal = await mintPrincipalWithSession(h.actor, `r2-down-${process.pid}`, 3_600_000);
    await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    await pg.server.stop();
    const before = runnerCalls;
    await assert.rejects(() => svc.tick());
    assert.equal(runnerCalls, before);
  });
});
