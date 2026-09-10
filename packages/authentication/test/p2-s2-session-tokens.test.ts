// P2-S2 — DURABLE SESSION / TOKEN LIFECYCLE (spec §6, §24-S2).
//
// Covers, over real PostgreSQL (fail-hard — embedded-PostgreSQL boot
// failure FAILS the suite, never skips):
//
//   * mint: authenticated identity required, tenant binding explicit,
//     lifecycle state durable, material returned ONCE and never persisted;
//   * verify: authoritative lookup, tenant binding verified, expiry
//     enforced (exact deny-early boundary), revoked rejected, identity
//     gate, malformed/unknown rejected with closed codes — never a mint;
//   * rotate: CAS-guarded swap, old token dies immediately cross-process,
//     rotation bound, concurrent-rotation single winner;
//   * revoke: explicit, durable, idempotent, cross-tenant refused;
//   * concurrent-session policy: N=3 refuse-new default, revoke-oldest,
//     expired rows excluded from the count;
//   * expiry hygiene: markExpired flips + SESSION_EXPIRED;
//   * deprovisioning: the P2-S1 cascade kills token-bearing sessions;
//   * audit: SESSION_CREATED/ROTATED/REVOKED/EXPIRED in-tx with the state
//     change, fingerprints only — token material appears NOWHERE durable;
//   * A-14 fixation: server-random ids/tokens (100-id non-derivation),
//     unknown tokens never minted;
//   * §21.2 coexistence: pre-token rows stay valid via the original path;
//   * races: revoke+validate (A-05 analog), deprovision+validate, duplicate
//     operations — no post-revocation ALLOW, exactly-once terminal state.
//
// Multiprocess fan-out (A-18, 32 processes), store outage (A-19), the
// Phase-B decision integration, and dispatch re-validation (A-04) live in
// their own suites (p2-s2-session-fanout, p2-s2-session-outage,
// authorization-boundary/p2-s2-session-decision,
// loop-host/p2-s2-session-dispatch).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriver } from '@jataqi/storage-postgres';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import {
  assessSessionRow,
  assertSessionDocumentShape,
  AuthenticationEventStore,
  AuthenticationModule,
  AuthenticationStoreError,
  AutoLinkedStaticTokenAuthenticator,
  DEFAULT_SESSION_CONCURRENCY_POLICY,
  IdentityStore,
  JtiReplayStore,
  PrincipalBoundary,
  PrincipalValidationError,
  SessionTokenAuthenticator,
  SessionTokenError,
  SessionTokenService,
  StaticTokenAuthenticator,
  TokenRegistryStore,
  fingerprintSessionToken,
  type AuthenticatedPrincipal,
  type IdentityEventKind,
} from '../src/index.js';

let pg: R2Postgres;
let sessions: AuthenticationEventStore;
let registry: TokenRegistryStore;
let identity: IdentityStore;
let service: SessionTokenService;

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;
const TENANT = (suffix: string): string => `acme-${suffix}-${process.pid}`;

// Every token material minted in this suite (the audit scan asserts NONE of
// it ever appears in durable state).
const mintedMaterials: string[] = [];
const usedTenants = new Set<string>();

let now: number;
const clock = (): number => now;

before(async () => {
  pg = await bootR2Postgres('p2s2sess', 63700);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  sessions = await AuthenticationEventStore.open(storage);
  registry = await TokenRegistryStore.open(storage);
  identity = await IdentityStore.open(storage);
  await JtiReplayStore.open(storage);
  service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: clock });
  now = Date.now();
});

after(async () => {
  if (pg) await pg.stop();
});

async function importToken(principalId: string, tenantId: string, roles: ('observer' | 'agent' | 'operator')[], expiresAt?: number): Promise<string> {
  const material = `s2-static-${nextId('tok')}`;
  await registry.importRecords(
    [{ token: material, tenantId, principalId, roles, ...(expiresAt !== undefined ? { expiresAt } : {}) }],
    'p2-s2-test',
    now,
  );
  return material;
}

/** A login boundary: durable auto-linked static auth + session-token verification + mint. */
function loginBoundary(): PrincipalBoundary {
  return new PrincipalBoundary({
    authenticators: [
      new AutoLinkedStaticTokenAuthenticator(
        new StaticTokenAuthenticator([], { registry }),
        identity,
        'p2-s2-test',
      ),
      new SessionTokenAuthenticator(service),
    ],
    policy: { mode: 'production' },
    now: clock,
    eventStore: sessions,
    sessionTokenService: service,
  });
}

async function loginAndMint(
  principalId: string,
  tenantId: string,
  roles: ('observer' | 'agent' | 'operator')[] = ['agent'],
): Promise<{ principal: AuthenticatedPrincipal; sessionToken: string; eventId: string }> {
  usedTenants.add(tenantId);
  const material = await importToken(principalId, tenantId, roles);
  const boundary = loginBoundary();
  const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material });
  mintedMaterials.push(minted.sessionToken);
  assert.equal(minted.principal.id, principalId);
  assert.equal(minted.principal.tenantId, tenantId);
  return { principal: minted.principal, sessionToken: minted.sessionToken, eventId: minted.principal.authenticationEventId };
}

async function sessionEvents(tenantId: string, kind: IdentityEventKind, principalId?: string) {
  const rows = await identity.queryEvents(tenantId, kind);
  return principalId === undefined ? rows : rows.filter((row) => row.principalId === principalId);
}

async function expectSessionCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    () => promise,
    (error: unknown) => {
      assert.ok(error instanceof SessionTokenError, `expected SessionTokenError, got ${String(error)}`);
      assert.equal(error.code, code);
      return true;
    },
  );
}

describe('P2-S2 session mint (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('mints a 256-bit token: row recorded WITH the fingerprint, material returned ONCE and never persisted', async () => {
    const tenantId = TENANT('mint');
    const { sessionToken, eventId } = await loginAndMint('alice', tenantId, ['agent', 'observer']);
    assert.equal(sessionToken.length, 43, 'base64url(32 bytes) is 43 chars');
    assert.match(sessionToken, /^[A-Za-z0-9\-_]{43}$/);

    const row = await sessions.getEvent(eventId, tenantId);
    assert.ok(row, 'the session row is durably recorded');
    assert.equal(row.tenantId, tenantId);
    assert.equal(row.principalId, 'alice');
    assert.equal(row.method, 'STATIC_TOKEN');
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.sessionFingerprint, fingerprintSessionToken(sessionToken));
    assert.deepEqual([...(row.roles ?? [])], ['agent', 'observer']);
    assert.equal(row.rotationCount, 0);
    // The material appears NOWHERE in the durable row (one-way fingerprint only).
    assert.ok(!JSON.stringify(row).includes(sessionToken), 'token material must never be persisted');

    const created = await sessionEvents(tenantId, 'SESSION_CREATED', 'alice');
    assert.equal(created.length, 1);
    assert.equal(created[0]?.authority?.authenticationEventId, eventId);
    assert.ok(created[0]?.detail?.includes(row.sessionFingerprint ?? '<missing>'), 'SESSION_CREATED cites the fingerprint');
    assert.ok(!JSON.stringify(created[0]).includes(sessionToken), 'SESSION_CREATED must never carry material');
  });

  it('mint requires a real credential: SESSION_TOKEN credentials are refused (no chaining)', async () => {
    const tenantId = TENANT('chain');
    const { sessionToken } = await loginAndMint('bob', tenantId);
    const boundary = loginBoundary();
    await assert.rejects(
      () => boundary.authenticateWithSessionToken({ method: 'SESSION_TOKEN', material: sessionToken }),
      /cannot mint a further session|no chaining/,
    );
    // The service refuses too (defense in depth — a SESSION_TOKEN principal
    // presented directly to mintFor).
    const presented = await service.verify(sessionToken, tenantId, now);
    assert.equal(presented.authenticationMethod, 'SESSION_TOKEN');
    await expectSessionCode(service.mintFor(presented, now), 'SESSION_TOKEN_UNKNOWN');
  });

  it('mint without a configured service fails closed', async () => {
    const tenantId = TENANT('nosvc');
    const material = await importToken('carol', tenantId, ['agent']);
    const boundary = new PrincipalBoundary({
      authenticators: [new StaticTokenAuthenticator([], { registry })],
      policy: { mode: 'production' },
      now: clock,
      eventStore: sessions,
    });
    await assert.rejects(
      () => boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material }),
      /not configured/,
    );
  });

  it('mint narrows roles BEFORE recording (widening throws)', async () => {
    const tenantId = TENANT('narrow');
    const material = await importToken('dave', tenantId, ['agent', 'observer']);
    const boundary = loginBoundary();
    const minted = await boundary.authenticateWithSessionToken(
      { method: 'STATIC_TOKEN', material },
      ['observer'],
    );
    mintedMaterials.push(minted.sessionToken);
    assert.deepEqual([...minted.actor.roles], ['observer']);
    const row = await sessions.getEvent(minted.principal.authenticationEventId, tenantId);
    assert.deepEqual([...(row?.roles ?? [])], ['observer']);
    await assert.rejects(
      () => boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material }, ['admin']),
      /not in the authenticated principal's verified role set/,
    );
  });

  it('mint caps the row lifetime at credentialExpiresAt', async () => {
    const tenantId = TENANT('cap');
    const material = await importToken('erin', tenantId, ['agent'], now + 3_600_000);
    const boundary = loginBoundary();
    const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material });
    mintedMaterials.push(minted.sessionToken);
    const row = await sessions.getEvent(minted.principal.authenticationEventId, tenantId);
    assert.equal(row?.expiresAt, now + 3_600_000, 'a session can never outlive the credential that verified it');
  });

  it('failed authentication mints nothing (no row, no SESSION_CREATED)', async () => {
    const tenantId = TENANT('failmint');
    usedTenants.add(tenantId);
    const boundary = loginBoundary();
    await assert.rejects(
      () => boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material: 'wrong-token' }),
      PrincipalValidationError,
    );
    assert.equal((await sessionEvents(tenantId, 'SESSION_CREATED')).length, 0);
  });

  it('minting twice from one authenticated principal object is refused insert-once (lost material = re-authenticate)', async () => {
    const tenantId = TENANT('twice');
    const material = await importToken('frank', tenantId, ['agent']);
    const boundary = loginBoundary();
    const first = await boundary.authenticate({ method: 'STATIC_TOKEN', material });
    // The legacy path already recorded this event id (pre-token row)...
    const minted = await service.mintFor({ ...first, authenticationEventId: nextId('evt') }, now);
    mintedMaterials.push(minted.material);
    // ...so a second mint reusing the SAME event id is an insert-once refusal.
    await assert.rejects(
      () => service.mintFor({ ...first, authenticationEventId: minted.event.id }, now),
      /already recorded/,
    );
    assert.equal((await sessionEvents(tenantId, 'SESSION_CREATED', 'frank')).length, 2);
  });
});

describe('P2-S2 session verification (real PostgreSQL)', () => {
  it('verifies a live token: authoritative lookup, tenant derived server-side', async () => {
    const tenantId = TENANT('verify');
    const { sessionToken, eventId } = await loginAndMint('gina', tenantId, ['operator']);
    const principal = await service.verify(sessionToken, tenantId, now);
    assert.equal(principal.id, 'gina');
    assert.equal(principal.tenantId, tenantId);
    assert.deepEqual([...principal.roles], ['operator']);
    assert.equal(principal.authenticationMethod, 'SESSION_TOKEN');
    assert.equal(principal.authenticationEventId, eventId, 'the session reference is stable across presentations');
    assert.equal(principal.verifiedAt, now);
    // No context tenant: the tenant is derived from the row (server-side).
    const derived = await service.verify(sessionToken, undefined, now);
    assert.equal(derived.tenantId, tenantId);
  });

  it('unknown tokens deny SESSION_TOKEN_UNKNOWN and mint nothing (fixation defense)', async () => {
    const tenantId = TENANT('unknown');
    usedTenants.add(tenantId);
    const before = (await sessionEvents(tenantId, 'SESSION_CREATED')).length;
    const attackerSupplied = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await expectSessionCode(service.verify(attackerSupplied, tenantId, now), 'SESSION_TOKEN_UNKNOWN');
    await expectSessionCode(service.verify(attackerSupplied, tenantId, now), 'SESSION_TOKEN_UNKNOWN');
    assert.equal(await sessions.findSessionByFingerprint(fingerprintSessionToken(attackerSupplied)), undefined);
    assert.equal((await sessionEvents(tenantId, 'SESSION_CREATED')).length, before, 'a presented unknown token is a denial, never a mint');
  });

  it('malformed tokens deny SESSION_TOKEN_MALFORMED without touching the store', async () => {
    const tenantId = TENANT('malformed');
    for (const bad of ['', 'short', 'has spaces in it!!!!', 'x'.repeat(513), 'not*url*safe*xxxxxxxxxxxxxxxxxxxxxxxxx']) {
      await expectSessionCode(service.verify(bad, tenantId, now), 'SESSION_TOKEN_MALFORMED');
    }
    await expectSessionCode(
      service.verify(undefined as unknown as string, tenantId, now),
      'SESSION_TOKEN_MALFORMED',
    );
  });

  it('revoked sessions deny SESSION_TOKEN_REVOKED', async () => {
    const tenantId = TENANT('revoked');
    const { sessionToken } = await loginAndMint('henry', tenantId);
    await service.revoke(sessionToken, tenantId, 'test-revocation', now);
    await expectSessionCode(service.verify(sessionToken, tenantId, now), 'SESSION_TOKEN_REVOKED');
  });

  it('expiry denies at the exact deny-early boundary (now + 300s >= expiresAt)', async () => {
    const tenantId = TENANT('expiry');
    const { sessionToken, eventId } = await loginAndMint('iris', tenantId);
    const row = await sessions.getEvent(eventId, tenantId);
    const expiresAt = row?.expiresAt ?? 0;
    assert.ok(expiresAt > now);
    // One millisecond inside the live window: verifies.
    const live = await service.verify(sessionToken, tenantId, expiresAt - 300_001);
    assert.equal(live.id, 'iris');
    // Exactly at the skew boundary: expired (fail closed).
    await expectSessionCode(service.verify(sessionToken, tenantId, expiresAt - 300_000), 'SESSION_TOKEN_EXPIRED');
    await expectSessionCode(service.verify(sessionToken, tenantId, expiresAt + 1), 'SESSION_TOKEN_EXPIRED');
  });

  it('a forged context tenant denies SESSION_TOKEN_TENANT_MISMATCH (substitution defense)', async () => {
    const tenantId = TENANT('tenantok');
    const { sessionToken } = await loginAndMint('judy', tenantId);
    await expectSessionCode(service.verify(sessionToken, 'other-tenant', now), 'SESSION_TOKEN_TENANT_MISMATCH');
    // The row tenant is authoritative: the correct tenant still verifies.
    const principal = await service.verify(sessionToken, tenantId, now);
    assert.equal(principal.tenantId, tenantId);
  });

  it('suspended identities deny SESSION_IDENTITY_INACTIVE even with a live row; re-activation restores use', async () => {
    const tenantId = TENANT('suspend');
    const { sessionToken, eventId } = await loginAndMint('karl', tenantId);
    assert.equal((await service.verify(sessionToken, tenantId, now)).id, 'karl');
    await identity.suspend('karl', tenantId, 'test-suspension', now);
    const row = await sessions.getEvent(eventId, tenantId);
    assert.equal(row?.status, 'ACTIVE', 'suspension does not flip the session row (S1 semantics)');
    await expectSessionCode(service.verify(sessionToken, tenantId, now), 'SESSION_IDENTITY_INACTIVE');
    // Verification never mutates identity state (no re-activation here).
    assert.equal((await identity.getPrincipal('karl', tenantId))?.state, 'SUSPENDED');
    await identity.activate('karl', tenantId, { authenticationEventId: nextId('evt'), method: 'STATIC_TOKEN' }, now + 1);
    assert.equal((await service.verify(sessionToken, tenantId, now + 1)).id, 'karl');
  });

  it('unlinked principals (no identity record) pass through (pre-P2 coexistence)', async () => {
    const tenantId = TENANT('unlinked');
    usedTenants.add(tenantId);
    const material = await importToken('liam', tenantId, ['agent']);
    // Plain static auth: NO auto-link, so no identity record exists.
    const boundary = new PrincipalBoundary({
      authenticators: [new StaticTokenAuthenticator([], { registry })],
      policy: { mode: 'production' },
      now: clock,
      eventStore: sessions,
      sessionTokenService: service,
    });
    const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material });
    mintedMaterials.push(minted.sessionToken);
    assert.equal(await identity.getPrincipal('liam', tenantId), undefined);
    const principal = await service.verify(minted.sessionToken, tenantId, now);
    assert.equal(principal.id, 'liam');
  });

  it('deprovisioning (P2-S1 cascade) kills token-bearing sessions: verify denies REVOKED', async () => {
    const tenantId = TENANT('deprov');
    const { sessionToken, eventId } = await loginAndMint('mia', tenantId);
    assert.equal((await service.verify(sessionToken, tenantId, now)).id, 'mia');
    await identity.suspend('mia', tenantId, 'test', now + 1);
    await identity.deactivate('mia', tenantId, 'test', now + 2);
    const cascade = await identity.deprovision('mia', tenantId, 'test', now + 3);
    assert.ok(cascade.sessionsRevoked >= 1, 'the cascade revokes token-bearing S-8 rows');
    assert.equal((await sessions.getEvent(eventId, tenantId))?.status, 'REVOKED');
    await expectSessionCode(service.verify(sessionToken, tenantId, now + 4), 'SESSION_TOKEN_REVOKED');
    // A removed credential cannot re-authenticate either (token cascade).
    assert.ok(cascade.tokensRevoked >= 1);
  });
});

describe('P2-S2 session rotation (real PostgreSQL)', () => {
  it('rotates: replacement minted, chain evidence kept, SESSION_ROTATED cites previous + new', async () => {
    const tenantId = TENANT('rotate');
    const { sessionToken, eventId } = await loginAndMint('nina', tenantId);
    const oldFp = fingerprintSessionToken(sessionToken);
    const rotated = await service.rotate(sessionToken, tenantId, now);
    mintedMaterials.push(rotated.material);
    assert.notEqual(rotated.material, sessionToken);
    assert.equal(rotated.material.length, 43);
    const row = await sessions.getEvent(eventId, tenantId);
    assert.equal(row?.sessionFingerprint, fingerprintSessionToken(rotated.material));
    assert.equal(row?.previousFingerprint, oldFp);
    assert.equal(row?.rotationCount, 1);
    assert.ok((row?.rotatedAt ?? 0) >= now);
    const events = await sessionEvents(tenantId, 'SESSION_ROTATED', 'nina');
    assert.equal(events.length, 1);
    assert.ok(events[0]?.detail?.includes(oldFp), 'SESSION_ROTATED cites the previous fingerprint');
    assert.ok(events[0]?.detail?.includes(row?.sessionFingerprint ?? '<missing>'), 'SESSION_ROTATED cites the new fingerprint');
    assert.ok(!JSON.stringify(events[0]).includes(sessionToken), 'no material in SESSION_ROTATED');
    assert.ok(!JSON.stringify(events[0]).includes(rotated.material), 'no material in SESSION_ROTATED');
  });

  it('the superseded token dies immediately: old denies UNKNOWN, new verifies', async () => {
    const tenantId = TENANT('olddead');
    const { sessionToken } = await loginAndMint('omar', tenantId);
    const rotated = await service.rotate(sessionToken, tenantId, now);
    mintedMaterials.push(rotated.material);
    await expectSessionCode(service.verify(sessionToken, tenantId, now), 'SESSION_TOKEN_UNKNOWN');
    assert.equal((await service.verify(rotated.material, tenantId, now)).id, 'omar');
  });

  it('rotation of revoked / expired / pre-token sessions is refused with closed codes', async () => {
    const tenantId = TENANT('rotref');
    const revoked = await loginAndMint('paul', tenantId);
    await service.revoke(revoked.sessionToken, tenantId, 'test', now);
    await expectSessionCode(service.rotate(revoked.sessionToken, tenantId, now), 'SESSION_TOKEN_REVOKED');

    const expired = await loginAndMint('quinn', tenantId);
    const row = await sessions.getEvent(expired.eventId, tenantId);
    await expectSessionCode(
      service.rotate(expired.sessionToken, tenantId, (row?.expiresAt ?? 0) + 1),
      'SESSION_TOKEN_EXPIRED',
    );

    // Pre-token rows carry no token to rotate: re-authenticate.
    const material = await importToken('ruth', tenantId, ['agent']);
    const boundary = loginBoundary();
    const legacy = await boundary.authenticate({ method: 'STATIC_TOKEN', material });
    const preRow = await sessions.getEvent(legacy.authenticationEventId, tenantId);
    assert.equal(preRow?.sessionFingerprint, undefined);
    await assert.rejects(
      () => sessions.rotateSessionToken({
        eventId: legacy.authenticationEventId,
        tenantId,
        expectedFingerprint: fingerprintSessionToken('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        newFingerprint: fingerprintSessionToken('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
        maxRotations: 32,
      }, now),
      (error: unknown) => error instanceof SessionTokenError && error.code === 'SESSION_TOKEN_UNKNOWN',
    );
  });

  it('cross-tenant rotation is refused', async () => {
    const tenantId = TENANT('rottenant');
    const { sessionToken } = await loginAndMint('sam', tenantId);
    await expectSessionCode(service.rotate(sessionToken, 'other-tenant', now), 'SESSION_TOKEN_TENANT_MISMATCH');
    // The live token is untouched.
    assert.equal((await service.verify(sessionToken, tenantId, now)).id, 'sam');
  });

  it('the rotation bound refuses further rotation; full re-authentication works after', async () => {
    const tenantId = TENANT('rotbound');
    const bounded = new SessionTokenService({ eventStore: sessions, identityStore: identity, maxRotationsPerEvent: 2, now: clock });
    const material = await importToken('tina', tenantId, ['agent']);
    const boundary = new PrincipalBoundary({
      authenticators: [new AutoLinkedStaticTokenAuthenticator(new StaticTokenAuthenticator([], { registry }), identity, 'p2-s2-test')],
      policy: { mode: 'production' },
      now: clock,
      eventStore: sessions,
      sessionTokenService: bounded,
    });
    const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material });
    mintedMaterials.push(minted.sessionToken);
    const first = await bounded.rotate(minted.sessionToken, tenantId, now);
    mintedMaterials.push(first.material);
    const second = await bounded.rotate(first.material, tenantId, now + 1);
    mintedMaterials.push(second.material);
    assert.equal((await sessions.getEvent(minted.principal.authenticationEventId, tenantId))?.rotationCount, 2);
    await expectSessionCode(bounded.rotate(second.material, tenantId, now + 2), 'SESSION_ROTATION_LIMIT');
    // Full re-authentication mints a fresh, usable session.
    const fresh = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material });
    mintedMaterials.push(fresh.sessionToken);
    assert.equal((await bounded.verify(fresh.sessionToken, tenantId, now + 3)).id, 'tina');
  });

  it('concurrent rotation has exactly one winner; losers deny UNKNOWN (single live token)', async () => {
    const tenantId = TENANT('rotrace');
    const { sessionToken, eventId } = await loginAndMint('uma', tenantId);
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.rotate(sessionToken, tenantId, now)),
    );
    const winners = attempts.filter((a) => a.status === 'fulfilled');
    const losers = attempts.filter((a) => a.status === 'rejected');
    assert.equal(winners.length, 1, 'exactly one rotation wins the CAS');
    assert.equal(losers.length, 7);
    for (const loser of losers) {
      const reason = (loser as PromiseRejectedResult).reason;
      assert.ok(reason instanceof SessionTokenError && reason.code === 'SESSION_TOKEN_UNKNOWN', `loser denies UNKNOWN, got ${String(reason)}`);
    }
    const row = await sessions.getEvent(eventId, tenantId);
    assert.equal(row?.rotationCount, 1, 'the rotation chain is monotonic (exactly one step)');
    assert.equal((await sessionEvents(tenantId, 'SESSION_ROTATED', 'uma')).length, 1);
    // Exactly one live token: the winner verifies; the presented token is dead.
    const winnerMaterial = (winners[0] as PromiseFulfilledResult<{ material: string }>).value.material;
    mintedMaterials.push(winnerMaterial);
    assert.equal((await service.verify(winnerMaterial, tenantId, now)).id, 'uma');
    await expectSessionCode(service.verify(sessionToken, tenantId, now), 'SESSION_TOKEN_UNKNOWN');
  });
});

describe('P2-S2 session revocation (real PostgreSQL)', () => {
  it('revokes explicitly and durably: row REVOKED + SESSION_REVOKED, then verify denies', async () => {
    const tenantId = TENANT('revoke');
    const { sessionToken, eventId } = await loginAndMint('vera', tenantId);
    const revoked = await service.revoke(sessionToken, tenantId, 'key-compromise', now);
    assert.equal(revoked.status, 'REVOKED');
    assert.equal(revoked.revocationReason, 'key-compromise');
    const events = await sessionEvents(tenantId, 'SESSION_REVOKED', 'vera');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.authority?.authenticationEventId, eventId);
    assert.equal(events[0]?.detail, 'key-compromise');
    await expectSessionCode(service.verify(sessionToken, tenantId, now), 'SESSION_TOKEN_REVOKED');
  });

  it('re-revocation is idempotent: same row, no second SESSION_REVOKED', async () => {
    const tenantId = TENANT('revmore');
    const { sessionToken } = await loginAndMint('walt', tenantId);
    const first = await service.revoke(sessionToken, tenantId, 'first', now);
    const second = await service.revoke(sessionToken, tenantId, 'second', now + 1);
    assert.equal(second.status, 'REVOKED');
    assert.equal(second.revokedAt, first.revokedAt, 'the original revocation stands');
    assert.equal((await sessionEvents(tenantId, 'SESSION_REVOKED', 'walt')).length, 1);
  });

  it('revoking an unknown token throws (no silent success)', async () => {
    const tenantId = TENANT('revunknown');
    await expectSessionCode(
      service.revoke('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', tenantId, 'test', now),
      'SESSION_TOKEN_UNKNOWN',
    );
  });

  it('cross-tenant revocation is refused; the row is untouched', async () => {
    const tenantId = TENANT('revtenant');
    const { sessionToken, eventId } = await loginAndMint('xena', tenantId);
    // Refused (on PostgreSQL the driver itself refuses the cross-tenant
    // write before the store predicate even runs — defense in depth; on
    // other drivers the store predicate refuses with its own message).
    await assert.rejects(
      () => service.revoke(sessionToken, 'other-tenant', 'hostile', now),
      /cross-tenant/i,
    );
    assert.equal((await sessions.getEvent(eventId, tenantId))?.status, 'ACTIVE');
    assert.equal((await service.verify(sessionToken, tenantId, now)).id, 'xena');
  });

  it('the operator row path (revokeEvent) kills tokens too (single source of truth)', async () => {
    const tenantId = TENANT('revrow');
    const { sessionToken, eventId } = await loginAndMint('yara', tenantId);
    await sessions.revokeEvent(eventId, tenantId, 'operator-path', now);
    await expectSessionCode(service.verify(sessionToken, tenantId, now), 'SESSION_TOKEN_REVOKED');
  });
});

describe('P2-S2 concurrent-session policy (real PostgreSQL)', () => {
  it('defaults to N=3 refuse-new: the 4th concurrent session is refused with a closed code', async () => {
    assert.deepEqual({ ...DEFAULT_SESSION_CONCURRENCY_POLICY }, { maxActiveSessions: 3, onExceed: 'refuse-new' });
    const tenantId = TENANT('policy');
    const principalId = 'zane';
    const material = await importToken(principalId, tenantId, ['agent']);
    const boundary = loginBoundary();
    const held: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material });
      held.push(minted.sessionToken);
      mintedMaterials.push(minted.sessionToken);
    }
    await assert.rejects(
      () => boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material }),
      /SESSION_CONCURRENCY_REFUSED/,
    );
    // After revoking one, minting works again.
    await service.revoke(held[0] as string, tenantId, 'make-room', now);
    const replacement = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material });
    mintedMaterials.push(replacement.sessionToken);
    assert.equal((await service.verify(replacement.sessionToken, tenantId, now)).id, principalId);
  });

  it('revoke-oldest: the oldest live session dies in the same transaction as the new mint', async () => {
    const tenantId = TENANT('oldest');
    const principalId = 'amy';
    const material = await importToken(principalId, tenantId, ['agent']);
    const boundary = loginBoundary();
    const policy = { maxActiveSessions: 2, onExceed: 'revoke-oldest' } as const;
    // Distinct timestamps per mint so "oldest" is deterministic (the store
    // orders by verifiedAt, then createdAt, then id).
    const first = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material }, undefined, policy);
    mintedMaterials.push(first.sessionToken);
    now += 1;
    const second = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material }, undefined, policy);
    mintedMaterials.push(second.sessionToken);
    now += 1;
    const third = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material }, undefined, policy);
    mintedMaterials.push(third.sessionToken);
    now += 1;
    // The oldest is revoked (policy reason); the others live.
    await expectSessionCode(service.verify(first.sessionToken, tenantId, now), 'SESSION_TOKEN_REVOKED');
    assert.equal((await service.verify(second.sessionToken, tenantId, now)).id, principalId);
    assert.equal((await service.verify(third.sessionToken, tenantId, now)).id, principalId);
    const revocations = await sessionEvents(tenantId, 'SESSION_REVOKED', principalId);
    assert.equal(revocations.length, 1);
    assert.equal(revocations[0]?.detail, 'concurrent-session-policy: revoke-oldest');
  });

  it('expired rows do not count against the cap (liveness is evaluated on read)', async () => {
    const tenantId = TENANT('polive');
    usedTenants.add(tenantId);
    const principalId = 'ben';
    // Three ACTIVE-but-expired rows (deny-early: expiresAt <= now + 300s).
    for (let i = 0; i < 3; i += 1) {
      await sessions.recordEvent(
        {
          eventId: nextId('evt'),
          tenantId,
          principalId,
          method: 'STATIC_TOKEN',
          verifiedAt: now - 3_600_000,
          expiresAt: now - 1_000,
        },
        now,
        { sessionPolicy: { maxActiveSessions: 3, onExceed: 'refuse-new' } },
      );
    }
    // A fourth records fine: the dead rows are not live sessions.
    const row = await sessions.recordEvent(
      {
        eventId: nextId('evt'),
        tenantId,
        principalId,
        method: 'STATIC_TOKEN',
        verifiedAt: now,
        expiresAt: now + 3_600_000,
      },
      now,
      { sessionPolicy: { maxActiveSessions: 3, onExceed: 'refuse-new' } },
    );
    assert.equal(row.status, 'ACTIVE');
  });

  it('invalid policies fail closed (caller bugs, never silent)', async () => {
    const tenantId = TENANT('polbad');
    await assert.rejects(
      () => sessions.recordEvent(
        { eventId: nextId('evt'), tenantId, principalId: 'cid', method: 'STATIC_TOKEN', verifiedAt: now, expiresAt: now + 1000 },
        now,
        { sessionPolicy: { maxActiveSessions: 0, onExceed: 'refuse-new' } },
      ),
      /maxActiveSessions/,
    );
    await assert.rejects(
      () => sessions.recordEvent(
        { eventId: nextId('evt'), tenantId, principalId: 'cid', method: 'STATIC_TOKEN', verifiedAt: now, expiresAt: now + 1000 },
        now,
        { sessionPolicy: { maxActiveSessions: 3, onExceed: 'accumulate' as never } },
      ),
      /onExceed/,
    );
  });
});

describe('P2-S2 expiry hygiene + store input validation (real PostgreSQL)', () => {
  it('markExpired flips past-expiry rows (SESSION_EXPIRED) and no-ops otherwise', async () => {
    const tenantId = TENANT('markexp');
    usedTenants.add(tenantId);
    const deadId = nextId('evt');
    await sessions.recordEvent(
      { eventId: deadId, tenantId, principalId: 'dee', method: 'STATIC_TOKEN', verifiedAt: now - 3_600_000, expiresAt: now - 1_000 },
      now,
    );
    const flipped = await service.markExpired(deadId, tenantId, now);
    assert.equal(flipped?.status, 'EXPIRED');
    assert.equal((await sessionEvents(tenantId, 'SESSION_EXPIRED', 'dee')).length, 1);

    const liveId = nextId('evt');
    await sessions.recordEvent(
      { eventId: liveId, tenantId, principalId: 'dee', method: 'STATIC_TOKEN', verifiedAt: now, expiresAt: now + 3_600_000 },
      now,
    );
    const untouched = await service.markExpired(liveId, tenantId, now);
    assert.equal(untouched?.status, 'ACTIVE', 'live rows are not flipped');
    assert.equal((await sessionEvents(tenantId, 'SESSION_EXPIRED', 'dee')).length, 1, 'no second event');
    assert.equal(await service.markExpired(nextId('missing'), tenantId, now), undefined);
  });

  it('recordEvent validates the session-token binding fail-closed', async () => {
    const tenantId = TENANT('bindbad');
    const base = { eventId: '', tenantId, principalId: 'eli', method: 'STATIC_TOKEN' as const, verifiedAt: now, expiresAt: now + 3_600_000 };
    await assert.rejects(
      () => sessions.recordEvent({ ...base, eventId: nextId('evt'), sessionToken: { fingerprint: 'short', roles: ['agent'] } }, now),
      /64-hex session-token fingerprint/,
    );
    await assert.rejects(
      () => sessions.recordEvent({ ...base, eventId: nextId('evt'), sessionToken: { fingerprint: 'a'.repeat(64), roles: [] } }, now),
      /non-empty recognized asserted role set/,
    );
    await assert.rejects(
      () => sessions.recordEvent({ ...base, eventId: nextId('evt'), sessionToken: { fingerprint: 'a'.repeat(64), roles: ['bogus' as never] } }, now),
      /non-empty recognized asserted role set/,
    );
    await assert.rejects(
      () => sessions.recordEvent({ ...base, eventId: nextId('evt'), sessionToken: { fingerprint: 'a'.repeat(64), roles: ['system'] } }, now),
      /can never be asserted on a session-token row/,
    );
  });

  it('rotateSessionToken validates its input fail-closed', async () => {
    const tenantId = TENANT('rotbad');
    const good = { eventId: nextId('evt'), tenantId, expectedFingerprint: 'a'.repeat(64), newFingerprint: 'b'.repeat(64), maxRotations: 32 };
    await assert.rejects(() => sessions.rotateSessionToken({ ...good, eventId: '' }, now), /requires an event id/);
    await assert.rejects(() => sessions.rotateSessionToken({ ...good, expectedFingerprint: 'zz' }, now), /64-hex expected fingerprint/);
    await assert.rejects(() => sessions.rotateSessionToken({ ...good, newFingerprint: 'a'.repeat(64) }, now), /differs/);
    await assert.rejects(() => sessions.rotateSessionToken({ ...good, maxRotations: -1 }, now), /integer >= 0/);
  });

  it('service construction validates fail-closed', async () => {
    assert.throws(
      () => new SessionTokenService({} as never),
      /requires the authoritative session store/,
    );
    assert.throws(
      () => new SessionTokenService({ eventStore: sessions, maxRotationsPerEvent: -1 }),
      /maxRotationsPerEvent/,
    );
    assert.throws(
      () => new SessionTokenService({ eventStore: sessions, sessionLifetimeMs: 0 }),
      /sessionLifetimeMs/,
    );
  });

  it('assessSessionRow rejects malformed lifecycle fields (pure fail-closed matrix)', async () => {
    const valid = {
      id: 'evt-x',
      tenantId: 'acme',
      principalId: 'zed',
      method: 'STATIC_TOKEN',
      verifiedAt: now,
      expiresAt: now + 3_600_000,
      status: 'ACTIVE',
      sessionFingerprint: 'a'.repeat(64),
      roles: ['agent'],
      rotationCount: 1,
      rotatedAt: now,
      previousFingerprint: 'b'.repeat(64),
      issuer: 'https://issuer.example',
    };
    assert.equal(assessSessionRow({ ...valid }, now).active, true);
    const cases: [string, Record<string, unknown>][] = [
      ['bad sessionFingerprint', { sessionFingerprint: 'zz' }],
      ['bad previousFingerprint', { previousFingerprint: 'zz' }],
      ['empty roles', { roles: [] }],
      ['unrecognized role', { roles: ['bogus'] }],
      ['negative rotationCount', { rotationCount: -1 }],
      ['non-integer rotationCount', { rotationCount: 1.5 }],
      ['bad rotatedAt', { rotatedAt: Number.NaN }],
      ['blank issuer', { issuer: '  ' }],
    ];
    for (const [label, override] of cases) {
      const assessment = assessSessionRow({ ...valid, ...override }, now);
      assert.equal(assessment.active, false, label);
      assert.equal(assessment.status, 'UNKNOWN', label);
    }
    // Pre-token rows (no lifecycle fields) assess as before.
    const { sessionFingerprint: _a, roles: _b, rotationCount: _c, rotatedAt: _d, previousFingerprint: _e, issuer: _f, ...preToken } = valid;
    assert.equal(assessSessionRow(preToken, now).active, true);
  });

  it('closed schema: the new fields are allowed; material-shaped fields are refused', async () => {
    assertSessionDocumentShape(
      { id: 'x', tenantId: 't', principalId: 'p', method: 'STATIC_TOKEN', verifiedAt: 1, expiresAt: 2, status: 'ACTIVE', createdAt: 1, updatedAt: 1, sessionFingerprint: 'a'.repeat(64), roles: ['agent'], rotationCount: 0 },
      'test',
    );
    assert.throws(
      () => assertSessionDocumentShape({ id: 'x', sessionTokenMaterial: 'secret' }, 'test'),
      AuthenticationStoreError,
    );
    assert.throws(
      () => assertSessionDocumentShape({ id: 'x', sessionToken: 'secret' }, 'test'),
      AuthenticationStoreError,
    );
  });
});

describe('P2-S2 lifecycle races (real PostgreSQL)', () => {
  it('revoke + validate race: terminal state exactly once; zero post-revocation ALLOWs', async () => {
    const tenantId = TENANT('race');
    const { sessionToken, eventId } = await loginAndMint('finn', tenantId);
    // Phase 1: 4 revokers race 4 validators (25 presentations each).
    const revokers = Array.from({ length: 4 }, () => service.revoke(sessionToken, tenantId, 'race-revocation', now));
    const validators = Array.from({ length: 4 }, async () => {
      const outcomes: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        try {
          await service.verify(sessionToken, tenantId, now);
          outcomes.push('ok');
        } catch (error) {
          assert.ok(error instanceof SessionTokenError, `validators deny closed, got ${String(error)}`);
          outcomes.push(error.code);
        }
      }
      return outcomes;
    });
    const [revokeResults, validateResults] = await Promise.all([
      Promise.allSettled(revokers),
      Promise.all(validators),
    ]);
    for (const result of revokeResults) {
      assert.equal(result.status, 'fulfilled', 'revocation is idempotent under contention (no CAS-throw races)');
    }
    assert.ok(validateResults.flat().includes('SESSION_TOKEN_REVOKED'), 'validators observe the revocation');
    assert.equal((await sessions.getEvent(eventId, tenantId))?.status, 'REVOKED');
    assert.equal((await sessionEvents(tenantId, 'SESSION_REVOKED', 'finn')).length, 1, 'exactly one revocation record');
    // Phase 2: AFTER the revocation commits, 80 further presentations ALL deny.
    const postRevoke = await Promise.all(
      Array.from({ length: 80 }, () => service.verify(sessionToken, tenantId, now).then(
        () => 'ok' as const,
        (error: unknown) => (error instanceof SessionTokenError ? error.code : `unexpected:${String(error)}`),
      )),
    );
    assert.ok(postRevoke.every((outcome) => outcome === 'SESSION_TOKEN_REVOKED'), `zero post-revocation ALLOWs, got ${JSON.stringify(postRevoke.slice(0, 5))}`);
  });

  it('deprovision + validate race: validators end denying; the cascade claims the row', async () => {
    const tenantId = TENANT('deprow');
    const { sessionToken, eventId } = await loginAndMint('gail', tenantId);
    const validating = (async () => {
      let denied = false;
      for (let i = 0; i < 60 && !denied; i += 1) {
        try {
          await service.verify(sessionToken, tenantId, now + i);
        } catch (error) {
          assert.ok(error instanceof SessionTokenError, `deny closed, got ${String(error)}`);
          denied = true;
        }
      }
      return denied;
    })();
    const deprovisioning = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await identity.suspend('gail', tenantId, 'race', now);
      await identity.deactivate('gail', tenantId, 'race', now + 1);
      return identity.deprovision('gail', tenantId, 'race', now + 2);
    })();
    const [denied, cascade] = await Promise.all([validating, deprovisioning]);
    assert.equal(denied, true, 'validation ends denying once the cascade lands');
    assert.ok(cascade.sessionsRevoked >= 1);
    assert.equal((await sessions.getEvent(eventId, tenantId))?.status, 'REVOKED');
    await expectSessionCode(service.verify(sessionToken, tenantId, now + 100), 'SESSION_TOKEN_REVOKED');
  });

  it('duplicate lifecycle operations: idempotent revoke, single-winner rotate, insert-once mint', async () => {
    const tenantId = TENANT('dupes');
    const { sessionToken, eventId } = await loginAndMint('hal', tenantId);
    // Duplicate revoke (serial): idempotent, one event.
    await service.revoke(sessionToken, tenantId, 'dupe-1', now);
    await service.revoke(sessionToken, tenantId, 'dupe-2', now + 1);
    assert.equal((await sessionEvents(tenantId, 'SESSION_REVOKED', 'hal')).length, 1);

    const live = await loginAndMint('hal-2', tenantId);
    // Duplicate rotate with the SAME presented material (serial): the second
    // presentation is no longer live.
    const rotated = await service.rotate(live.sessionToken, tenantId, now);
    mintedMaterials.push(rotated.material);
    await expectSessionCode(service.rotate(live.sessionToken, tenantId, now), 'SESSION_TOKEN_UNKNOWN');
    assert.equal((await sessions.getEvent(eventId, tenantId))?.status, 'REVOKED');
  });
});

describe('P2-S2 boundary + module integration (real PostgreSQL)', () => {
  it('SESSION_TOKEN through the boundary validates WITHOUT re-recording (row count stable)', async () => {
    const tenantId = TENANT('norecord');
    const { sessionToken, eventId } = await loginAndMint('ivan', tenantId);
    const boundary = loginBoundary();
    const createdBefore = (await sessionEvents(tenantId, 'SESSION_CREATED', 'ivan')).length;
    const principal = await boundary.authenticate({ method: 'SESSION_TOKEN', material: sessionToken, context: { tenantId } });
    assert.equal(principal.authenticationMethod, 'SESSION_TOKEN');
    assert.equal(principal.authenticationEventId, eventId);
    assert.equal(
      (await sessionEvents(tenantId, 'SESSION_CREATED', 'ivan')).length,
      createdBefore,
      'validation never re-records (insert-once would refuse it)',
    );
    // Unknown sessions through the boundary deny with the closed code in the message.
    await assert.rejects(
      () => boundary.authenticate({ method: 'SESSION_TOKEN', material: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' }),
      /SESSION_TOKEN_UNKNOWN/,
    );
  });

  it('a boundary whose policy excludes SESSION_TOKEN refuses the authenticator at construction', async () => {
    assert.throws(
      () => new PrincipalBoundary({
        authenticators: [new SessionTokenAuthenticator(service)],
        policy: { allowedMethods: ['STATIC_TOKEN'] },
        eventStore: sessions,
      }),
      /does not admit/,
    );
  });

  it('without a registered session authenticator, SESSION_TOKEN is structurally unsupported', async () => {
    const tenantId = TENANT('nosessauth');
    const { sessionToken } = await loginAndMint('jane', tenantId);
    const boundary = new PrincipalBoundary({
      authenticators: [new StaticTokenAuthenticator([], { registry })],
      policy: { mode: 'production' },
      now: clock,
      eventStore: sessions,
    });
    await assert.rejects(
      () => boundary.authenticate({ method: 'SESSION_TOKEN', material: sessionToken }),
      /not supported by any registered authenticator/,
    );
  });

  it('the authentication module wires the service (container + factory seam + mint)', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule({
      driverInstance: new PostgresDriver({ connectionString: pg.connectionString, requireExplicitConfig: true, max: 4 }),
    }));
    const module = new AuthenticationModule({
      durableSessions: { enabled: true },
      policy: { mode: 'production' },
      authenticatorFactory: async (stores) => {
        assert.ok(stores.sessionStore, 'session store to the factory');
        assert.ok(stores.tokenRegistry, 'token registry to the factory');
        assert.ok(stores.identityStore, 'identity store to the factory');
        assert.ok(stores.jtiReplay, 'jti replay to the factory');
        assert.ok(stores.sessionTokens, 'session-token service to the factory (P2-S2)');
        const tenantId = TENANT('modwire');
        usedTenants.add(tenantId);
        await stores.tokenRegistry.importRecords(
          [{ token: 'modwire-token', tenantId, principalId: 'kate', roles: ['agent'] }],
          'p2-s2-test',
          Date.now(),
        );
        return [
          new AutoLinkedStaticTokenAuthenticator(
            new StaticTokenAuthenticator([], { registry: stores.tokenRegistry }),
            stores.identityStore,
            'p2-s2-test',
          ),
          new SessionTokenAuthenticator(stores.sessionTokens),
        ];
      },
    });
    kernel.register(module);
    await kernel.boot();
    assert.ok(kernel.container.has('authentication.session-tokens'), 'the service is published on the container');
    assert.deepEqual(module.getService().listAuthenticatorIds(), ['static-token:auto-linked', 'session-token']);
    const boundary = module.getService();
    const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material: 'modwire-token' });
    mintedMaterials.push(minted.sessionToken);
    assert.equal(minted.principal.id, 'kate');
    const presented = await boundary.authenticate({ method: 'SESSION_TOKEN', material: minted.sessionToken });
    assert.equal(presented.authenticationMethod, 'SESSION_TOKEN');
    assert.equal(presented.authenticationEventId, minted.principal.authenticationEventId);
  });
});

describe('P2-S2 fixation defense + migration coexistence (real PostgreSQL)', () => {
  it('A-14: 100 static verifications mint unique server-random ids (zero match the old derivation)', async () => {
    // Both static paths (constructor table + durable registry) mint
    // randomUUID event ids — never `${requestId}:${hash16}` (which always
    // contained a ':').
    const table = new StaticTokenAuthenticator([
      { token: 'fix-table', principalId: 'fix', tenantId: 'acme-fix', roles: ['agent'] },
    ]);
    const tableIds = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const principal = await table.verify({ method: 'STATIC_TOKEN', material: 'fix-table' }, now, `req-${i}`);
      tableIds.add(principal.authenticationEventId);
      assert.ok(!principal.authenticationEventId.includes(':'), `server-random id, got ${principal.authenticationEventId}`);
    }
    assert.equal(tableIds.size, 100, '100 minted ids, zero collisions');

    const tenantId = TENANT('fixreg');
    usedTenants.add(tenantId);
    const material = await importToken('fixreg', tenantId, ['agent']);
    const durable = new StaticTokenAuthenticator([], { registry });
    const durableIds = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const principal = await durable.verify({ method: 'STATIC_TOKEN', material }, now, `req-${i}`);
      durableIds.add(principal.authenticationEventId);
      assert.ok(!principal.authenticationEventId.includes(':'), `server-random id, got ${principal.authenticationEventId}`);
    }
    assert.equal(durableIds.size, 100, '100 minted ids, zero collisions');
  });

  it('A-14: 100 minted session tokens are unique; attacker values are denials, never mints', async () => {
    const tenantId = TENANT('fixtok');
    const principalId = 'fixaji';
    const material = await importToken(principalId, tenantId, ['agent']);
    const boundary = loginBoundary();
    // The N=3 policy is explicit config: raise it for the 100-mint load.
    const policy = { maxActiveSessions: 200, onExceed: 'refuse-new' } as const;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material }, undefined, policy);
      assert.equal(minted.sessionToken.length, 43);
      seen.add(minted.sessionToken);
    }
    assert.equal(seen.size, 100, '100 minted tokens, zero collisions');
    for (const token of seen) mintedMaterials.push(token);
    // Attacker-supplied values: denials, and the mint count is unchanged.
    const created = (await sessionEvents(tenantId, 'SESSION_CREATED', principalId)).length;
    await expectSessionCode(service.verify('EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', tenantId, now), 'SESSION_TOKEN_UNKNOWN');
    assert.equal((await sessionEvents(tenantId, 'SESSION_CREATED', principalId)).length, created);
  });

  it('§21.2 coexistence: pre-token rows stay valid via the original credential path', async () => {
    const tenantId = TENANT('coexist');
    const material = await importToken('legacy', tenantId, ['agent']);
    const boundary = loginBoundary();
    const legacy = await boundary.authenticate({ method: 'STATIC_TOKEN', material });
    const row = await sessions.getEvent(legacy.authenticationEventId, tenantId);
    assert.equal(row?.sessionFingerprint, undefined, 'legacy recording carries no token binding');
    assert.equal((await sessions.assertActive(legacy.authenticationEventId, tenantId, now)).active, true);
    const created = await sessionEvents(tenantId, 'SESSION_CREATED', 'legacy');
    assert.equal(created.length, 1);
    assert.match(created[0]?.detail ?? '', /pre-token session/);
    // The original credential path still verifies (S-9 unchanged).
    const again = await boundary.authenticate({ method: 'STATIC_TOKEN', material });
    assert.equal(again.id, 'legacy');
    // And session-token verification of an unknown value does not disturb it.
    await expectSessionCode(service.verify('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', tenantId, now), 'SESSION_TOKEN_UNKNOWN');
    assert.equal((await sessions.assertActive(legacy.authenticationEventId, tenantId, now)).active, true);
  });

  it('audit scan: NO minted token material appears in ANY durable session/identity event', async () => {
    assert.ok(mintedMaterials.length > 100, `expected a large minted population, got ${mintedMaterials.length}`);
    for (const tenantId of usedTenants) {
      for (const kind of ['SESSION_CREATED', 'SESSION_ROTATED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'AUTH_LOGIN', 'AUTH_FAILED'] as IdentityEventKind[]) {
        for (const event of await identity.queryEvents(tenantId, kind)) {
          const json = JSON.stringify(event);
          for (const material of mintedMaterials) {
            assert.ok(!json.includes(material), `material leak in ${kind} (${tenantId})`);
          }
        }
      }
    }
  });
});
