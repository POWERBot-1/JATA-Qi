// P2-S2 — session/token lifecycle under store outage (A-19, spec §15).
//
// Proves the fail-closed contract over real PostgreSQL: while the store is
// unreachable, session-token verification / rotation / minting THROW
// (never ALLOW, never a memory fallback, never a minted token); after the
// store recovers, the SAME durable sessions verify again (no state is
// reconstructed from process memory — the rows never left the store).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import {
  AuthenticationEventStore,
  AuthenticationStoreError,
  AutoLinkedStaticTokenAuthenticator,
  IdentityStore,
  PrincipalBoundary,
  SessionTokenAuthenticator,
  SessionTokenService,
  StaticTokenAuthenticator,
  TokenRegistryStore,
} from '../src/index.js';

let pg: R2Postgres;
let sessions: AuthenticationEventStore;
let service: SessionTokenService;

const TENANT = `outage-${process.pid}`;
const T0 = Date.now();
const now = T0;
const clock = (): number => now;

let sessionToken = '';
let eventId = '';

before(async () => {
  pg = await bootR2Postgres('p2s2outage', 64300);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  sessions = await AuthenticationEventStore.open(storage);
  const registry = await TokenRegistryStore.open(storage);
  const identity = await IdentityStore.open(storage);
  service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: clock });

  // One durable session, minted while the store is healthy.
  await registry.importRecords(
    [{ token: 'outage-static', tenantId: TENANT, principalId: 'outage-user', roles: ['agent'] }],
    'p2-s2-outage',
    now,
  );
  const boundary = new PrincipalBoundary({
    authenticators: [
      new AutoLinkedStaticTokenAuthenticator(
        new StaticTokenAuthenticator([], { registry }),
        identity,
        'p2-s2-outage',
      ),
      new SessionTokenAuthenticator(service),
    ],
    policy: { mode: 'production' },
    now: clock,
    eventStore: sessions,
    sessionTokenService: service,
  });
  const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material: 'outage-static' });
  sessionToken = minted.sessionToken;
  eventId = minted.principal.authenticationEventId;
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P2-S2 session lifecycle under store outage (real PostgreSQL)', () => {
  it('PostgreSQL backend started and the session verifies while healthy', async () => {
    assert.ok(pg, 'P2-S2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
    assert.equal((await service.verify(sessionToken, TENANT, now)).id, 'outage-user');
  });

  it('A-19: outage ⇒ verification/rotation/mint THROW (never ALLOW, never memory fallback)', async () => {
    await pg.server.stop();
    try {
      // Verification of a previously-live token throws (fail-closed).
      await assert.rejects(
        () => service.verify(sessionToken, TENANT, now),
        (error: unknown) => {
          assert.ok(error instanceof AuthenticationStoreError, `fail-closed store error, got ${String(error)}`);
          assert.ok(!(error instanceof Error && /ALLOW/.test(error.message)), 'never an allow');
          return true;
        },
      );
      // Rotation throws too.
      await assert.rejects(
        () => service.rotate(sessionToken, TENANT, now),
        (error: unknown) => error instanceof AuthenticationStoreError,
      );
      // Minting throws (no session is recorded without the store).
      const phantom = {
        id: 'outage-user',
        tenantId: TENANT,
        roles: ['agent'] as const,
        authenticationMethod: 'STATIC_TOKEN' as const,
        verifiedAt: now,
        authenticationEventId: `phantom-${process.pid}`,
      };
      await assert.rejects(
        () => service.mintFor(phantom, now),
        (error: unknown) => error instanceof AuthenticationStoreError,
      );
      // The fingerprint lookup itself throws (no silent undefined — the
      // verifier cannot mistake outage for unknown-and-harmless; the
      // service wraps it uniformly — verified above by the
      // verify/rotate rejections).
      await assert.rejects(
        () => sessions.findSessionByFingerprint('a'.repeat(64)),
        (error: unknown) => error instanceof Error,
      );
    } finally {
      // Leave the server up for the recovery test and teardown (P1 shape:
      // stop-then-start — never start-on-running, which poisons stop()).
      try {
        await pg.server.stop();
      } catch {
        /* already down is fine */
      }
      await pg.server.start();
    }
  });

  it('A-19: recovery ⇒ the SAME durable session verifies again (store-mediated, not memory)', async () => {
    const principal = await service.verify(sessionToken, TENANT, now);
    assert.equal(principal.id, 'outage-user');
    assert.equal(principal.authenticationEventId, eventId, 'the pre-outage session identity survives (store-mediated)');
    assert.equal((await sessions.getEvent(eventId, TENANT))?.status, 'ACTIVE');
  });
});
