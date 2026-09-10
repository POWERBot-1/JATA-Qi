// P2-S2 — session/token lifecycle THROUGH the durable A-01 decision
// (spec §6 + §24-S2). Real PostgreSQL; fail-hard.
//
// Covered:
//   * a SESSION_TOKEN principal with an ACTIVE session + ACTIVATED identity
//     renders ALLOW (the session stage + identity stage + PDP all pass);
//   * after the session is revoked, the SAME request renders DENY
//     (PRINCIPAL_REVOKED from the session stage — no re-authentication, no
//     decision, no stale authorization);
//   * privilege change during an active session: a durable role revocation
//     between two decisions narrows the second (the S1 A-11 proof repeated
//     for a SESSION_TOKEN principal);
//   * expired / unknown / cross-tenant sessions render session-stage DENYs;
//   * a suspended identity with a live session row renders
//     IDENTITY_STATE_INACTIVE (the session stage passes, the identity stage
//     denies — layered, exactly as specified);
//   * store outage renders SECURITY_STATE_UNAVAILABLE (never ALLOW), and
//     decisions resume after recovery.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthenticationEventStore,
  IdentityStore,
  fingerprintSessionToken,
  mintSessionTokenMaterial,
} from '@jataqi/authentication';
import {
  AuthorizationGate,
  DurableCredentialBroker,
  InMemoryAuditSink,
  InMemoryCredentialMaterialProvider,
  SecurityStateStore,
  type A01AuthorizationRequest,
  type A01CapabilityManifest,
  type A01DecisionOutcome,
  type A01DenialReason,
} from '../src/index.js';
import { baseRequest } from './helpers.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import { durableManifest, registrar } from './r2-fixtures.js';

let pg: R2Postgres;
let store: SecurityStateStore;
let sessions: AuthenticationEventStore;
let identity: IdentityStore;
let gate: AuthorizationGate;
let now: number;

const T0 = Date.now();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;
const clock = (): number => now;

const CAPABILITY_ID = `cap.p2s2-sessdec.${process.pid}`;
const TENANT = 'acme';

// Test-local discretionary policy engine (A-01 allows engines that ADD
// denials only): ALLOW only while the effective (post-identity-narrowing)
// role set still contains 'operator'.
const requireOperatorEngine = {
  id: 'test-operator-required',
  evaluate(request: A01AuthorizationRequest, _manifest: A01CapabilityManifest): {
    readonly outcome: A01DecisionOutcome;
    readonly reasons: readonly A01DenialReason[];
  } {
    const roles = request.principal?.roles ?? [];
    return roles.includes('operator')
      ? { outcome: 'ALLOW' as const, reasons: [] as readonly A01DenialReason[] }
      : { outcome: 'DENY' as const, reasons: ['PRINCIPAL_REVOKED'] as const };
  },
};

/** Record a token-bound session row directly (the S2 mint path is covered in the authentication package). */
async function mintTokenSession(
  principalId: string,
  roles: ('operator' | 'observer')[],
  tenantId = TENANT,
): Promise<{ eventId: string; material: string }> {
  const eventId = nextId('evt');
  const material = mintSessionTokenMaterial();
  await sessions.recordEvent(
    {
      eventId,
      tenantId,
      principalId,
      method: 'STATIC_TOKEN',
      verifiedAt: now,
      expiresAt: now + 3_600_000,
      sessionToken: { fingerprint: fingerprintSessionToken(material), roles: [...roles] },
    },
    now,
  );
  return { eventId, material };
}

function sessionRequest(
  session: { eventId: string; tenantId: string; principalId: string },
  overrides: Record<string, unknown> = {},
): A01AuthorizationRequest {
  return baseRequest({
    principal: {
      id: session.principalId,
      tenantId: session.tenantId,
      roles: overrides.roles ?? ['operator', 'observer'],
      authenticationMethod: 'SESSION_TOKEN',
      authenticationEventId: session.eventId,
    },
    tenantId: session.tenantId,
    capability: { capabilityId: CAPABILITY_ID, capabilityVersion: '1' },
    run: { runId: nextId('run'), correlationId: nextId('corr') },
    ...overrides,
  });
}

async function enrollActive(principalId: string, roles: ('operator' | 'observer')[], tenantId = TENANT): Promise<void> {
  await identity.enroll({ principalId, tenantId, roles: [...roles], enrolledBy: 'p2-s2-test' }, now);
  await identity.activate(principalId, tenantId, { authenticationEventId: nextId('evt'), method: 'STATIC_TOKEN' }, now);
}

before(async () => {
  now = T0;
  pg = await bootR2Postgres('p2s2sessdec', 64600);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  store = await SecurityStateStore.open(storage, { now: clock });
  sessions = await AuthenticationEventStore.open(storage);
  identity = await IdentityStore.open(storage);
  const broker = new DurableCredentialBroker(store, new InMemoryCredentialMaterialProvider(), { now: clock });
  gate = new AuthorizationGate({
    store,
    durableBroker: broker,
    audit: new InMemoryAuditSink(),
    now: clock,
    engine: requireOperatorEngine,
    identityAuthorityResolver: () => identity.asStateAuthority(),
  });
  await store.registerManifestVersion(durableManifest(CAPABILITY_ID), registrar());
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P2-S2 session lifecycle through the durable decision (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('ACTIVE session + ACTIVATED identity ⇒ ALLOW for a SESSION_TOKEN principal', async () => {
    const principalId = nextId('alice');
    await enrollActive(principalId, ['operator', 'observer']);
    const { eventId } = await mintTokenSession(principalId, ['operator', 'observer']);
    const envelope = await gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId }));
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.deepEqual([...(envelope.principal?.roles ?? [])], ['operator', 'observer']);
  });

  it('revoked session ⇒ session-stage DENY (no stale authorization after revocation)', async () => {
    const principalId = nextId('bob');
    await enrollActive(principalId, ['operator', 'observer']);
    const { eventId } = await mintTokenSession(principalId, ['operator', 'observer']);
    const before = await gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId }));
    assert.equal(before.decision.decision, 'ALLOW');
    await sessions.revokeEvent(eventId, TENANT, 'decision-test', now);
    const after = await gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId }));
    assert.equal(after.decision.decision, 'DENY', 'the revoked session authorizes nothing further');
    assert.deepEqual(after.decision.reasonCodes, ['PRINCIPAL_REVOKED']);
  });

  it('privilege change during an active session: durable role revocation narrows the next decision', async () => {
    const principalId = nextId('carol');
    await enrollActive(principalId, ['operator', 'observer']);
    const { eventId } = await mintTokenSession(principalId, ['operator', 'observer']);
    const first = await gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId }));
    assert.equal(first.decision.decision, 'ALLOW');
    // The durable 'operator' assignment is revoked; the session row is untouched.
    const assignments = await identity.getRoleAssignments(principalId, TENANT);
    const operatorGrant = assignments.find((row) => row.role === 'operator' && row.status === 'ACTIVE');
    assert.ok(operatorGrant, 'an ACTIVE operator assignment exists to revoke');
    await identity.revokeRoleAssignment(operatorGrant.id, TENANT, 'privilege change', now);
    assert.equal((await sessions.getEvent(eventId, TENANT))?.status, 'ACTIVE', 'the session row itself is untouched');
    const second = await gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId }));
    assert.equal(second.decision.decision, 'DENY', 'the decision outcome changes because the effective authority changed');
    assert.deepEqual([...(second.principal?.roles ?? [])], ['observer'], 'the sealed envelope cites the narrowed role set');
  });

  it('expired / unknown / cross-tenant sessions ⇒ session-stage DENYs', async () => {
    const principalId = nextId('dave');
    await enrollActive(principalId, ['operator']);
    // Expired on read (deny-early).
    const expiredId = nextId('evt');
    await sessions.recordEvent(
      {
        eventId: expiredId,
        tenantId: TENANT,
        principalId,
        method: 'STATIC_TOKEN',
        verifiedAt: now - 3_600_000,
        expiresAt: now - 1_000,
      },
      now,
    );
    const expired = await gate.decideAsync(sessionRequest({ eventId: expiredId, tenantId: TENANT, principalId }));
    assert.equal(expired.decision.decision, 'DENY');
    assert.deepEqual(expired.decision.reasonCodes, ['PRINCIPAL_REVOKED']);

    // Unknown event id.
    const unknown = await gate.decideAsync(sessionRequest({ eventId: nextId('missing'), tenantId: TENANT, principalId }));
    assert.equal(unknown.decision.decision, 'DENY');
    assert.deepEqual(unknown.decision.reasonCodes, ['PRINCIPAL_REVOKED']);

    // Cross-tenant session use: the row lives in TENANT, the request is foreign.
    const { eventId } = await mintTokenSession(principalId, ['operator']);
    const foreign = sessionRequest({ eventId, tenantId: 'foreign', principalId });
    const denied = await gate.decideAsync(foreign);
    assert.equal(denied.decision.decision, 'DENY', 'cross-tenant session use fails closed');
  });

  it('suspended identity + live session ⇒ IDENTITY_STATE_INACTIVE (identity stage denies)', async () => {
    const principalId = nextId('erin');
    await enrollActive(principalId, ['operator']);
    const { eventId } = await mintTokenSession(principalId, ['operator']);
    assert.equal(
      (await gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId }))).decision.decision,
      'ALLOW',
    );
    await identity.suspend(principalId, TENANT, 'decision-test', now);
    assert.equal((await sessions.getEvent(eventId, TENANT))?.status, 'ACTIVE', 'the session row is still ACTIVE');
    const denied = await gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId }));
    assert.equal(denied.decision.decision, 'DENY');
    assert.deepEqual(denied.decision.reasonCodes, ['IDENTITY_STATE_INACTIVE']);
  });

  it('deprovisioned identity ⇒ DENY (cascade revoked the session; identity terminal)', async () => {
    const principalId = nextId('frank');
    await enrollActive(principalId, ['operator']);
    const { eventId } = await mintTokenSession(principalId, ['operator']);
    await identity.suspend(principalId, TENANT, 'decision-test', now);
    await identity.deactivate(principalId, TENANT, 'decision-test', now);
    const cascade = await identity.deprovision(principalId, TENANT, 'decision-test', now);
    assert.ok(cascade.sessionsRevoked >= 1);
    const denied = await gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId }));
    assert.equal(denied.decision.decision, 'DENY', 'a deprovisioned identity authorizes nothing');
  });

  it('outage ⇒ DENY SECURITY_STATE_UNAVAILABLE (never ALLOW); recovery ⇒ decisions resume', async () => {
    const principalId = nextId('gail');
    await enrollActive(principalId, ['operator']);
    const { eventId } = await mintTokenSession(principalId, ['operator']);
    const request = sessionRequest({ eventId, tenantId: TENANT, principalId });
    assert.equal((await gate.decideAsync(request)).decision.decision, 'ALLOW');
    await pg.server.stop();
    try {
      // The decider cannot even confirm the failure receipt while the
      // store is down, so it throws the closed denial (P1 shape) — never
      // an ALLOW, never a silent pass.
      await assert.rejects(
        () => gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId })),
        (error: unknown) => {
          assert.ok(error instanceof Error && error.name === 'AuthorizationDeniedError', `closed denial, got ${String(error)}`);
          assert.ok(
            (error as { reasons?: readonly string[] }).reasons?.includes('SECURITY_STATE_UNAVAILABLE'),
            `outage denies SECURITY_STATE_UNAVAILABLE, got ${String(error)}`,
          );
          return true;
        },
      );
    } finally {
      try {
        await pg.server.stop();
      } catch {
        /* already down is fine */
      }
      await pg.server.start();
    }
    assert.equal(
      (await gate.decideAsync(sessionRequest({ eventId, tenantId: TENANT, principalId }))).decision.decision,
      'ALLOW',
      'decisions resume after recovery',
    );
  });
});
