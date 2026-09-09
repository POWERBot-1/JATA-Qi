// P2-S1 — the identity-state re-read INSIDE the durable decision transaction
// (spec §24-S1 "identity-state check inside the Phase-B transaction";
// A-11). Real PostgreSQL; fail-hard: if embedded PostgreSQL cannot start,
// before() rejects and the suite FAILS (no skip).
//
// Covered:
//   * A-11: two consecutive decisions with a durable role revocation between
//     them — decision 1 ALLOWs with the full effective role set; after the
//     durable 'operator' assignment is revoked, decision 2 (request still
//     claiming both roles) is NARROWED to ['observer'] by the identity stage
//     and the operator-required test-local policy engine turns it into a
//     DENY. The sealed envelope cites the narrowed role set — proving the
//     decision outcome changed because the durable effective authority
//     changed (not merely that a row changed).
//   * non-ACTIVATED identities (SUSPENDED, terminal DEPROVISIONED) render a
//     DENY with IDENTITY_STATE_INACTIVE BEFORE the PDP runs;
//   * unlinked principals (no identity record) keep the exact pre-P2
//     decision behavior (passthrough — only EXISTING identities are gated);
//   * KERNEL_INTERNAL principals skip the identity re-read (asserted with a
//     counting authority: the lookup never happens for the kernel path,
//     while the session-evidence + PDP stages still apply in full);
//   * IDENTITY_TENANT_MISMATCH — an injected fake authority (an explicit
//     test seam, documented below) returns a row whose tenant differs from
//     the request tenant; a keyed lookup can never naturally produce that
//     mismatch, so this exercises the defensive branch, not a real-world
//     path;
//   * fail-closed: an authority whose lookup THROWS renders a
//     SECURITY_STATE_UNAVAILABLE DENY (the Phase-B transaction rolls back;
//     there is no permissive fallback).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticationEventStore, IdentityStore } from '@jataqi/authentication';
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
import { durableManifest, registrar, type MintedSession } from './r2-fixtures.js';

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

let pg: R2Postgres;
let store: SecurityStateStore;
let sessions: AuthenticationEventStore;
let identity: IdentityStore;
let audit: InMemoryAuditSink;
let gate: AuthorizationGate;
let now: number;

const T0 = Date.now();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;
const clock = (): number => now;

const CAPABILITY_ID = `cap.p2s1-iddec.${process.pid}`;
const TENANT = 'acme';

/**
 * Test-local discretionary policy engine (A-01 allows engines that ADD
 * denials only): ALLOW only while the effective (post-identity-narrowing)
 * role set still contains 'operator'. The denial code is
 * 'PRINCIPAL_REVOKED' — the closed A-01 reason set carries no
 * role-specific code, and this is the semantics being exercised: the
 * principal's previously held authority was revoked durably.
 */
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

async function mintSession(principalId: string, tenantId = TENANT): Promise<MintedSession> {
  const eventId = `evt-${nextId('iddec')}`;
  const row = await sessions.recordEvent(
    {
      eventId,
      tenantId,
      principalId,
      method: 'STATIC_TOKEN',
      verifiedAt: now,
      expiresAt: now + 3_600_000,
    },
    now,
  );
  return { eventId, tenantId, principalId, row };
}

function iddecRequest(
  session: { eventId: string; tenantId: string; principalId: string },
  overrides: Record<string, unknown> = {},
): A01AuthorizationRequest {
  return baseRequest({
    principal: {
      id: session.principalId,
      tenantId: session.tenantId,
      roles: overrides.roles ?? ['operator', 'observer'],
      authenticationMethod: overrides.authenticationMethod ?? 'STATIC_TOKEN',
      authenticationEventId: session.eventId,
    },
    tenantId: session.tenantId,
    capability: { capabilityId: CAPABILITY_ID, capabilityVersion: '1' },
    run: { runId: nextId('run'), correlationId: nextId('corr') },
    ...overrides,
  });
}

before(async () => {
  now = T0;
  pg = await bootR2Postgres('p2s1iddec', 59510);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  store = await SecurityStateStore.open(storage, { now: clock });
  sessions = await AuthenticationEventStore.open(storage);
  identity = await IdentityStore.open(storage);
  audit = new InMemoryAuditSink();
  const provider = new InMemoryCredentialMaterialProvider();
  const broker = new DurableCredentialBroker(store, provider, { now: clock });
  gate = new AuthorizationGate({
    store,
    durableBroker: broker,
    audit,
    now: clock,
    engine: requireOperatorEngine,
    identityAuthorityResolver: () => identity.asStateAuthority(),
  });
  await store.registerManifestVersion(durableManifest(CAPABILITY_ID), registrar());
});

after(async () => {
  await pg.stop();
});

describe('P2-S1 identity-state re-read in the durable decision (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S1 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('A-11: a durable role revocation between two consecutive decisions changes the decision', async () => {
    const alice = nextId('alice');
    await identity.enroll(
      { principalId: alice, tenantId: TENANT, roles: ['operator', 'observer'], enrolledBy: 'admin:a11' },
      now,
    );
    now += 1;
    await identity.activate(alice, TENANT, { authenticationEventId: nextId('auth'), method: 'STATIC_TOKEN' }, now);
    now += 1;
    const session = await mintSession(alice);

    // Decision 1: both roles active — ALLOW with the full effective set.
    const env1 = await gate.decideAsync(iddecRequest(session));
    now += 1;
    assert.equal(env1.decision.decision, 'ALLOW', 'decision 1 must ALLOW while both roles are durably active');
    assert.deepEqual(env1.principal.roles, ['operator', 'observer'], 'decision 1 cites the full effective role set');

    // Revoke the durable 'operator' assignment (the decision must not cache it).
    const assignments = await identity.getRoleAssignments(alice, TENANT);
    const operator = assignments.find((a) => a.role === 'operator');
    assert.ok(operator, 'the operator assignment exists before revocation');
    now += 1;
    await identity.revokeRoleAssignment(operator.id, TENANT, 'A-11 revocation', now);
    now += 1;

    // Decision 2: the request STILL claims both roles — the identity stage
    // narrows them to the currently ACTIVE durable assignments.
    const env2 = await gate.decideAsync(iddecRequest(session));
    now += 1;
    assert.deepEqual(
      env2.principal.roles,
      ['observer'],
      'decision 2 cites the NARROWED effective role set (the revoked role is gone)',
    );
    assert.equal(env2.decision.decision, 'DENY', 'decision 2 must DENY: the effective authority changed');
    assert.ok(
      env2.decision.reasonCodes.includes('PRINCIPAL_REVOKED'),
      'the denial cites the test-local operator-required policy (closed A-01 reason code)',
    );
    assert.equal(env1.manifestId, env2.manifestId, 'both decisions cite the same manifest revision');
  });

  it('a SUSPENDED identity renders a DENY with IDENTITY_STATE_INACTIVE (before the PDP)', async () => {
    const bob = nextId('bob');
    await identity.enroll({ principalId: bob, tenantId: TENANT, roles: ['operator', 'observer'], enrolledBy: 'admin:bob' }, now);
    now += 1;
    await identity.activate(bob, TENANT, { authenticationEventId: nextId('auth'), method: 'STATIC_TOKEN' }, now);
    now += 1;
    await identity.suspend(bob, TENANT, 'A-11 suspension probe', now);
    now += 1;
    const session = await mintSession(bob);
    const env = await gate.decideAsync(iddecRequest(session));
    now += 1;
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['IDENTITY_STATE_INACTIVE'], 'the identity stage denies before the PDP runs');
  });

  it('a terminal (DEPROVISIONED) identity renders IDENTITY_STATE_INACTIVE (no stale privilege)', async () => {
    const carol = nextId('carol');
    await identity.enroll({ principalId: carol, tenantId: TENANT, roles: ['operator'], enrolledBy: 'admin:carol' }, now);
    now += 1;
    await identity.activate(carol, TENANT, { authenticationEventId: nextId('auth'), method: 'STATIC_TOKEN' }, now);
    now += 1;
    await identity.suspend(carol, TENANT, 'review', now);
    now += 1;
    await identity.deactivate(carol, TENANT, 'termination', now);
    now += 1;
    await identity.deprovision(carol, TENANT, 'termination', now);
    now += 1;
    const session = await mintSession(carol);
    const env = await gate.decideAsync(iddecRequest(session, { roles: ['operator'] }));
    now += 1;
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['IDENTITY_STATE_INACTIVE']);
  });

  it('an unlinked principal (no identity record) keeps the exact pre-P2 behavior (passthrough)', async () => {
    // No identity record for this principal: the identity stage must NOT
    // gate the decision — the pre-S1 decision behavior is preserved for
    // unlinked principals (only EXISTING identities are gated).
    const stranger = nextId('stranger');
    const session = await mintSession(stranger);
    const env = await gate.decideAsync(iddecRequest(session));
    now += 1;
    assert.equal(env.decision.decision, 'ALLOW', 'unlinked principals are not gated by the identity stage');
    assert.deepEqual(env.principal.roles, ['operator', 'observer'], 'the request roles pass through un-narrowed');
  });

  it('KERNEL_INTERNAL: the identity re-read is skipped (counting authority; session + PDP still apply)', async () => {
    // A counting fake authority (explicit test seam — an injectable
    // dependency of the decider, not a substitute for the real store): it
    // reports every principal SUSPENDED, so ANY consultation would render a
    // DENY. The kernel path must produce an ALLOW with ZERO consultations.
    let lookups = 0;
    // `kind` is a type-level discriminator (the decider never branches on it;
    // it keys on PRESENCE of the authority), so the fixture carries the
    // real token to satisfy the seam's type. It is a test fixture, not the
    // production authority.
    const countingAuthority = {
      kind: 'p2-identity-state-authority' as const,
      async lookupInTx(_scope: unknown, _tenantId: string, _principalId: string, _now: number) {
        lookups += 1;
        return { state: 'SUSPENDED' as const, activeRoles: [] as const, tenantId: _tenantId };
      },
    };
    const provider = new InMemoryCredentialMaterialProvider();
    const broker = new DurableCredentialBroker(store, provider, { now: clock });
    const kiGate = new AuthorizationGate({
      store,
      durableBroker: broker,
      audit,
      now: clock,
      engine: requireOperatorEngine,
      identityAuthorityResolver: () => countingAuthority,
    });

    const dave = nextId('dave');
    const session = await mintSession(dave);
    now += 1;

    // Control: the SAME session evidence on a STATIC_TOKEN request IS
    // consulted (the authority gates it) — proving the seam is live.
    lookups = 0;
    const control = await kiGate.decideAsync(iddecRequest(session));
    now += 1;
    assert.ok(lookups >= 1, 'the static-token path consults the identity authority');
    assert.equal(control.decision.decision, 'DENY');
    assert.deepEqual(control.decision.reasonCodes, ['IDENTITY_STATE_INACTIVE']);

    // Kernel path: the same session evidence, a KERNEL_INTERNAL principal.
    // The session-evidence stage still requires the active S-8 row; the PDP
    // still runs (operator-required engine satisfied). Only the identity
    // re-read is skipped — by design, cryptographic kernel verification is
    // the authority for that path (same rule as the session stage).
    lookups = 0;
    const kernelEnv = await kiGate.decideAsync(
      iddecRequest(session, { authenticationMethod: 'KERNEL_INTERNAL' }),
    );
    now += 1;
    assert.equal(kernelEnv.decision.decision, 'ALLOW', 'the kernel path succeeds with the session + PDP stages intact');
    assert.equal(lookups, 0, 'the identity authority is NOT consulted for a KERNEL_INTERNAL principal');
  });

  it('IDENTITY_TENANT_MISMATCH: an injected inconsistent record denies (documented defensive seam)', async () => {
    // Documented test seam: a keyed lookup is addressed by
    // (tenantId, principalId), so a naturally stored row can NEVER report a
    // different tenant than the one queried. This fake authority (an
    // injectable decider dependency) returns an inconsistent record to
    // exercise the defensive branch the implementation must keep fail-closed.
    const mismatchAuthority = {
      kind: 'p2-identity-state-authority' as const,
      async lookupInTx(_scope: unknown, _tenantId: string, _principalId: string, _now: number) {
        return { state: 'ACTIVATED' as const, activeRoles: ['observer'] as const, tenantId: 'other-tenant' };
      },
    };
    const provider = new InMemoryCredentialMaterialProvider();
    const broker = new DurableCredentialBroker(store, provider, { now: clock });
    const mmGate = new AuthorizationGate({
      store,
      durableBroker: broker,
      audit,
      now: clock,
      identityAuthorityResolver: () => mismatchAuthority,
    });

    const eve = nextId('eve');
    const session = await mintSession(eve);
    now += 1;
    const env = await mmGate.decideAsync(iddecRequest(session));
    now += 1;
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['IDENTITY_TENANT_MISMATCH']);
  });

  it('fail-closed: an authority lookup failure renders SECURITY_STATE_UNAVAILABLE (no permissive fallback)', async () => {
    // The decider's identity authority THROWS (storage failure inside the
    // Phase-B transaction): the transaction rolls back and the decision is a
    // sealed DENY with SECURITY_STATE_UNAVAILABLE — never an ALLOW.
    const failingAuthority = {
      kind: 'p2-identity-state-authority' as const,
      async lookupInTx(): Promise<never> {
        throw new Error('simulated storage failure in the identity lookup');
      },
    };
    const provider = new InMemoryCredentialMaterialProvider();
    const broker = new DurableCredentialBroker(store, provider, { now: clock });
    const failGate = new AuthorizationGate({
      store,
      durableBroker: broker,
      audit,
      now: clock,
      identityAuthorityResolver: () => failingAuthority,
    });

    const frank = nextId('frank');
    const session = await mintSession(frank);
    now += 1;
    const env = await failGate.decideAsync(iddecRequest(session));
    now += 1;
    assert.equal(env.decision.decision, 'DENY', 'uncertainty never produces ALLOW');
    assert.ok(
      env.decision.reasonCodes.includes('SECURITY_STATE_UNAVAILABLE'),
      'the storage-failure denial code is cited',
    );
  });
});
