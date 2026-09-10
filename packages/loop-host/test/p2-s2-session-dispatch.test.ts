// P2-S2 — session/token lifecycle at dispatch (A-04 for SESSION_TOKEN
// principals, spec §6 + §24-S2). Real PostgreSQL; fail-hard.
//
// Covered:
//   * work enqueued with a session-token principal dispatches while the
//     session is ACTIVE (the SESSION_TOKEN method flows through snapshot
//     freeze → authorizeDispatch → dispatch re-validation unchanged);
//   * a token revocation after enqueue HELDs the work with
//     PRINCIPAL_REVOKED — never dispatched, never resumed silently, and
//     resumption without re-authentication is impossible;
//   * rotation preserves in-flight work (the session row stays ACTIVE —
//     only the bearer changes), while the superseded token itself is dead;
//   * deprovisioning (P2-S1 cascade) HELDs queued session work;
//   * expired token sessions HELD.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import {
  AuthenticationEventStore,
  AutoLinkedStaticTokenAuthenticator,
  IdentityStore,
  PrincipalBoundary,
  SessionTokenAuthenticator,
  SessionTokenService,
  StaticTokenAuthenticator,
  TokenRegistryStore,
  type AuthenticatedPrincipal,
} from '@jataqi/authentication';
import type { LoopRunResult } from '@jataqi/unified-loop';
import type { LoopHostService } from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import { buildHarness, reasoningTask, type Harness } from './helpers.js';

let pg: R2Postgres;
let h: Harness;
let sessions: AuthenticationEventStore;
let identity: IdentityStore;
let service: SessionTokenService;
let svc: LoopHostService;
let runnerCalls = 0;
let seq = 0;

function stubResult(): LoopRunResult {
  return {
    loopId: 'loop-p2s2',
    correlationId: 'corr-p2s2',
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

/** Log in (durable auto-linked static auth) and mint a session token. */
async function mintSessionPrincipal(tag: string): Promise<{ principal: AuthenticatedPrincipal; sessionToken: string }> {
  const boundary = new PrincipalBoundary({
    authenticators: [
      new AutoLinkedStaticTokenAuthenticator(
        new StaticTokenAuthenticator([], { registry }),
        identity,
        'p2-s2-dispatch',
      ),
      new SessionTokenAuthenticator(service),
    ],
    policy: { mode: 'production' },
    now: h.now,
    eventStore: sessions,
    sessionTokenService: service,
  });
  const staticMaterial = `p2s2-dispatch-${tag}-${process.pid}-${++seq}`;
  await registry.importRecords(
    [{ token: staticMaterial, tenantId: h.actor.tenantId, principalId: h.actor.id, roles: [...h.actor.roles] }],
    'p2-s2-dispatch',
    h.now(),
  );
  const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material: staticMaterial });
  assert.equal(minted.principal.authenticationMethod, 'STATIC_TOKEN');
  // Present the session token back through the boundary: the dispatch
  // principal is session-authenticated (method SESSION_TOKEN).
  const principal = await boundary.authenticate({ method: 'SESSION_TOKEN', material: minted.sessionToken });
  assert.equal(principal.authenticationMethod, 'SESSION_TOKEN');
  return { principal, sessionToken: minted.sessionToken };
}

let registry: TokenRegistryStore;

before(async () => {
  pg = await bootR2Postgres('p2s2dispatch', 64900);
  const booted = await bootR2StorageKernel(pg.connectionString);
  sessions = await AuthenticationEventStore.open(booted.storage);
  registry = await TokenRegistryStore.open(booted.storage);
  identity = await IdentityStore.open(booted.storage);
  h = await buildHarness({
    storageModule: new StorageModule({ driverInstance: booted.driver }),
    loopHostConfig: { sessionStore: sessions },
  });
  service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: h.now });
  svc = h.host();
  svc.setRunner(async (_actor, _task, opts) => {
    runnerCalls += 1;
    assert.ok(opts.principal, 'runner must receive principal evidence');
    return stubResult();
  });
  svc.start();
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P2-S2 session-token dispatch re-validation (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('dispatches work whose token session is ACTIVE', async () => {
    const { principal } = await mintSessionPrincipal('active');
    const before = runnerCalls;
    await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    const summary = await svc.tick();
    assert.equal(summary.dispatched, 1);
    assert.equal(runnerCalls, before + 1);
  });

  it('A-04: holds work whose token was revoked after enqueue (PRINCIPAL_REVOKED, never dispatched)', async () => {
    const { principal, sessionToken } = await mintSessionPrincipal('revoked');
    const before = runnerCalls;
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    await service.revoke(sessionToken, h.actor.tenantId, 'p2-s2-dispatch-test', h.now());
    const summary = await svc.tick();
    assert.equal(summary.held, 1);
    assert.equal(runnerCalls, before, 'revoked work is never dispatched');
    const held = await svc.list(h.actor, { status: 'HELD' });
    assert.ok(held.some((entry) => entry.id === item.id && entry.heldReason === 'PRINCIPAL_REVOKED'));
    // Never resumed silently: further ticks keep it HELD (re-authentication
    // — a fresh enqueue under a live session — is the only way forward).
    const again = await svc.tick();
    assert.equal(again.dispatched, 0);
    const stillHeld = await svc.list(h.actor, { status: 'HELD' });
    assert.ok(stillHeld.some((entry) => entry.id === item.id && entry.heldReason === 'PRINCIPAL_REVOKED'));
  });

  it('rotation preserves in-flight work (row stays ACTIVE) while the old token dies', async () => {
    const { principal, sessionToken } = await mintSessionPrincipal('rotated');
    const before = runnerCalls;
    await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    const rotated = await service.rotate(sessionToken, h.actor.tenantId, h.now());
    assert.equal((await sessions.getEvent(principal.authenticationEventId, h.actor.tenantId))?.status, 'ACTIVE');
    const summary = await svc.tick();
    assert.equal(summary.dispatched, 1, 'rotation changes the bearer, not the session');
    assert.equal(runnerCalls, before + 1);
    // The superseded bearer itself authorizes nothing further.
    await assert.rejects(
      () => service.verify(sessionToken, h.actor.tenantId, h.now()),
      /SESSION_TOKEN_UNKNOWN/,
    );
    assert.equal((await service.verify(rotated.material, h.actor.tenantId, h.now())).id, h.actor.id);
  });

  it('deprovisioning HELDs queued session work (cascade revokes the row)', async () => {
    const { principal } = await mintSessionPrincipal('deprovisioned');
    const before = runnerCalls;
    const item = await svc.enqueue(h.actor, { task: reasoningTask() }, principal);
    // The login auto-linked an ACTIVATED identity; drive it to terminal.
    await identity.suspend(h.actor.id, h.actor.tenantId, 'p2-s2-dispatch-test', h.now());
    await identity.deactivate(h.actor.id, h.actor.tenantId, 'p2-s2-dispatch-test', h.now());
    const cascade = await identity.deprovision(h.actor.id, h.actor.tenantId, 'p2-s2-dispatch-test', h.now());
    assert.ok(cascade.sessionsRevoked >= 1, 'the cascade claims the token session row');
    const summary = await svc.tick();
    assert.equal(summary.held, 1);
    assert.equal(runnerCalls, before);
    const held = await svc.list(h.actor, { status: 'HELD' });
    assert.ok(held.some((entry) => entry.id === item.id && entry.heldReason === 'PRINCIPAL_REVOKED'));
  });

  it('holds work whose token session expired between enqueue and dispatch', async () => {
    // A 310s lifetime is ACTIVE on read (above the 300s deny-early
    // skew), so the login + enqueue are real; the S2 expiry pass then
    // marks the row EXPIRED before the dispatch tick runs.
    const shortLived = new SessionTokenService({
      eventStore: sessions,
      identityStore: identity,
      sessionLifetimeMs: 310_000,
      now: h.now,
    });
    const boundary = new PrincipalBoundary({
      authenticators: [
        new AutoLinkedStaticTokenAuthenticator(
          new StaticTokenAuthenticator([], { registry }),
          identity,
          'p2-s2-dispatch',
        ),
        new SessionTokenAuthenticator(shortLived),
      ],
      policy: { mode: 'production' },
      now: h.now,
      eventStore: sessions,
      sessionTokenService: shortLived,
    });
    // NOTE: the actor identity was deprovisioned by the previous test, so
    // this login uses a fresh principal (the harness actor's tenant).
    const staticMaterial = `p2s2-dispatch-expired-${process.pid}`;
    await registry.importRecords(
      [{ token: staticMaterial, tenantId: h.actor.tenantId, principalId: 'expired-user', roles: [...h.actor.roles] }],
      'p2-s2-dispatch',
      h.now(),
    );
    const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material: staticMaterial });
    const principal = await boundary.authenticate({ method: 'SESSION_TOKEN', material: minted.sessionToken });
    const actor = { ...h.actor, id: 'expired-user' };
    const before = runnerCalls;
    const item = await svc.enqueue(actor, { task: reasoningTask() }, principal);
    // Time passes past the session's expiry; then the S2 expiry pass runs.
    h.advance(320_000);
    const marked = await shortLived.markExpired(principal.authenticationEventId, h.actor.tenantId, h.now());
    assert.equal(marked?.status, 'EXPIRED', 'the S2 expiry pass marks the row EXPIRED');
    // (Previously-held items from earlier tests re-report each tick, so
    // the assertion targets this item's HELD status — not the tick total.)
    await svc.tick();
    assert.equal(runnerCalls, before, 'expired work is never dispatched');
    const held = await svc.list(actor, { status: 'HELD' });
    assert.ok(held.some((entry) => entry.id === item.id && entry.heldReason === 'PRINCIPAL_REVOKED'));
  });
});
