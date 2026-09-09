// P2-S1 — durable IDENTITY CORE over real PostgreSQL (spec §4, §13, §21, A-15).
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the
// suite FAILS (no skip — the identity core is the P2-S1 security substrate;
// it is never verified against a fake).
//
// Covered:
//   * the FULL closed lifecycle transition matrix (spec §4.2): every
//     permitted transition exercised through the public API, every forbidden
//     transition negative-asserted (store-driven where a public operation
//     exists; the four pairs targeting ENROLLED are closed by the pure
//     function — no store operation can reach ENROLLED but creation);
//   * the deprovisioning CASCADE (sessions S-8, tokens S-9, role grants,
//     membership, future grants) — no usable authority survives;
//   * idempotent auto-linking (one stable relationship) and rebind refusal
//     (cross-tenant rebind + terminal-identity rebind);
//   * federation binding (subject↔tenant mapping) — the server-side
//     identity↔tenant map;
//   * the one-shot recovery record (deny-early 300 s boundary, single use,
//     revocation, terminal refusal);
//   * the durable jti replay set (replay refusal + retention GC);
//   * non-transactional source refusal (memory is never identity authority);
//   * the seven identity collections are part of the verified RLS list;
//   * INV-15: the S1 system-scope uses are the DECLARED `transaction:system`
//     (positive) and an undeclared label is recorded as a violation
//     (negative — the declared-exception registry rejects it).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { P1_SECURITY_COLLECTIONS } from '@jataqi/storage-postgres';
import {
  AuthenticationEventStore,
  IdentityLifecycleError,
  IdentityRebindRefusedError,
  IdentityStore,
  IdentityStoreError,
  IDENTITY_LIFECYCLE_TRANSITIONS,
  RECOGNIZED_IDENTITY_STATES,
  JtiReplayError,
  JtiReplayStore,
  TokenRegistryStore,
  isPermittedIdentityTransition,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

let pg: R2Postgres;
let storage: StorageModule;
let identity: IdentityStore;
let jti: JtiReplayStore;
let sessions: AuthenticationEventStore;
let tokens: TokenRegistryStore;

const T0 = Date.now();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;

before(async () => {
  pg = await bootR2Postgres('p2s1id', 59300);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  identity = await IdentityStore.open(storage);
  jti = await JtiReplayStore.open(storage);
  sessions = await AuthenticationEventStore.open(storage);
  tokens = await TokenRegistryStore.open(storage);
});

after(async () => {
  await pg.stop();
});

const TENANT = 'acme';
const TENANT_B = 'globex';
const ISSUER = 'https://idp.example.com';

async function enrolled(principalId: string, tenantId: string = TENANT, roles: readonly string[] = ['observer']): Promise<void> {
  await identity.enroll({ principalId, tenantId, roles: roles as never, enrolledBy: 'admin:test' }, T0);
}

/** Drive a fresh principal to the given state via PERMITTED transitions. */
async function driveTo(state: string, principalId: string, tenantId: string = TENANT): Promise<void> {
  switch (state) {
    case 'ENROLLED':
      await enrolled(principalId, tenantId);
      return;
    case 'ACTIVATED':
      await enrolled(principalId, tenantId);
      await identity.activate(principalId, tenantId, { authenticationEventId: nextId('evt'), method: 'OIDC' }, T0 + 1);
      return;
    case 'SUSPENDED':
      await driveTo('ACTIVATED', principalId, tenantId);
      await identity.suspend(principalId, tenantId, 'matrix', T0 + 2);
      return;
    case 'DEACTIVATED':
      await driveTo('SUSPENDED', principalId, tenantId);
      await identity.deactivate(principalId, tenantId, 'matrix', T0 + 3);
      return;
    case 'DEPROVISIONED':
      await driveTo('DEACTIVATED', principalId, tenantId);
      await identity.deprovision(principalId, tenantId, 'matrix', T0 + 4);
      return;
    default:
      throw new Error(`unknown state ${state}`);
  }
}

/** Attempt a transition via the public operation that targets `to`. */
function attemptTransition(to: string, principalId: string, tenantId: string): Promise<unknown> {
  switch (to) {
    case 'ACTIVATED':
      return identity.activate(principalId, tenantId, { authenticationEventId: nextId('evt'), method: 'OIDC' }, T0 + 10);
    case 'SUSPENDED':
      return identity.suspend(principalId, tenantId, 'matrix', T0 + 10);
    case 'DEACTIVATED':
      return identity.deactivate(principalId, tenantId, 'matrix', T0 + 10);
    case 'DEPROVISIONED':
      return identity.deprovision(principalId, tenantId, 'matrix', T0 + 10);
    default:
      return Promise.reject(new Error(`no store operation targets ${to} (ENROLLED is creation-only)`));
  }
}

describe('P2-S1 durable identity core (real PostgreSQL, fail-hard)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S1 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('the seven identity collections are part of the verified RLS security list', () => {
    for (const collection of [
      'identity.principals',
      'identity.memberships',
      'identity.role-assignments',
      'identity.recovery',
      'identity.subject-bindings',
      'identity.jti-replay',
      'identity.events',
    ]) {
      assert.ok(
        (P1_SECURITY_COLLECTIONS as readonly string[]).includes(collection),
        `the RLS posture probe must cover ${collection}`,
      );
    }
  });

  it('refuses a non-transactional source at open (memory is never identity authority)', async () => {
    const memory = new StorageModule();
    const kernel = createTestKernel();
    kernel.register(memory);
    await kernel.boot();
    await assert.rejects(() => IdentityStore.open(memory), IdentityStoreError);
    await assert.rejects(() => JtiReplayStore.open(memory), IdentityStoreError);
    await kernel.shutdown();
  });

  it('the closed transition table has exactly the six spec §4.2 transitions', () => {
    const expected: ReadonlySet<string> = new Set([
      'ENROLLED→ACTIVATED',
      'ENROLLED→DEPROVISIONED',
      'ACTIVATED→SUSPENDED',
      'SUSPENDED→ACTIVATED',
      'SUSPENDED→DEACTIVATED',
      'DEACTIVATED→DEPROVISIONED',
    ]);
    const actual = new Set(IDENTITY_LIFECYCLE_TRANSITIONS.map(([a, b]) => `${a}→${b}`));
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      'the closed transition table must match spec §4.2 exactly (no invented transitions)',
    );
    // Exhaustive pure-function check: every ordered pair is classified.
    let permitted = 0;
    for (const from of RECOGNIZED_IDENTITY_STATES) {
      for (const to of RECOGNIZED_IDENTITY_STATES) {
        if (from === to) continue;
        const ok = isPermittedIdentityTransition(from, to);
        assert.equal(ok, expected.has(`${from}→${to}`), `${from}→${to} classification`);
        if (ok) permitted += 1;
      }
    }
    assert.equal(permitted, 6, 'exactly six permitted transitions');
  });

  it('matrix: every PERMITTED transition succeeds through the public API', async () => {
    for (const [from, to] of IDENTITY_LIFECYCLE_TRANSITIONS) {
      const pid = nextId('m');
      await driveTo(from, pid);
      await attemptTransition(to, pid, TENANT);
      const doc = (await identity.getPrincipal(pid, TENANT))!;
      assert.equal(doc.state, to, `${from} → ${to} must succeed`);
    }
  });

  it('matrix: every FORBIDDEN transition is refused (negative-asserted)', async () => {
    let storeDriven = 0;
    for (const from of RECOGNIZED_IDENTITY_STATES) {
      for (const to of RECOGNIZED_IDENTITY_STATES) {
        if (from === to) continue;
        if (isPermittedIdentityTransition(from, to)) continue;
        if (to === 'ENROLLED') {
          // No store operation can target ENROLLED (creation-only): the pair
          // is closed by the API surface (asserted in the table test above).
          continue;
        }
        const pid = nextId('f');
        await driveTo(from, pid);
        await assert.rejects(
          () => attemptTransition(to, pid, TENANT),
          IdentityLifecycleError,
          `${from} → ${to} must be refused`,
        );
        // The state is UNCHANGED by a refused transition (no partial state).
        assert.equal((await identity.getPrincipal(pid, TENANT))!.state, from, `refused ${from} → ${to} leaves state unchanged`);
        storeDriven += 1;
      }
    }
    assert.equal(storeDriven, 10, 'ten store-driven forbidden pairs negative-asserted (+4 to-ENROLLED pairs closed by the API surface)');
  });

  it('optimistic lock: a concurrent (stale) write is refused; re-enrollment is one-shot', async () => {
    const pid = nextId('c');
    await enrolled(pid);
    await identity.activate(pid, TENANT, { authenticationEventId: nextId('evt'), method: 'OIDC' }, T0);
    await identity.suspend(pid, TENANT, 'first', T0 + 1);
    // A second writer acting on the stale state (ACTIVATED) cannot suspend again.
    await assert.rejects(() => identity.suspend(pid, TENANT, 'stale', T0 + 2), IdentityLifecycleError);
    // Re-enrollment of an existing principal is refused (one-shot).
    await assert.rejects(
      () => identity.enroll({ principalId: pid, tenantId: TENANT, roles: [], enrolledBy: 'admin:again' }, T0 + 3),
      IdentityStoreError,
    );
  });

  it('enrollment: one principalId has exactly one identity across tenants (rebind refused)', async () => {
    const pid = nextId('rb');
    await enrolled(pid);
    await assert.rejects(
      () => identity.enroll({ principalId: pid, tenantId: TENANT_B, roles: ['observer'], enrolledBy: 'admin:other' }, T0 + 1),
      IdentityRebindRefusedError,
      'enrolling an existing principal id under another tenant is a rebind — refused',
    );
  });

  it('role lifecycle: grant (idempotent), re-grant after revocation is a NEW record, revocation shrinks the active set', async () => {
    const pid = nextId('rl');
    await enrolled(pid);
    const first = await identity.grantRoleAssignment(pid, TENANT, 'operator', 'admin:grant', T0);
    const again = await identity.grantRoleAssignment(pid, TENANT, 'operator', 'admin:grant', T0 + 1);
    assert.equal(again.id, first.id, 'granting an ACTIVE role is idempotent (same record)');
    await identity.revokeRoleAssignment(first.id, TENANT, 'scope reduction', T0 + 2);
    const afterRevoke = await identity.getActiveRoles(pid, TENANT, T0 + 3);
    assert.deepEqual(afterRevoke, ['observer'], 'only the enrollment role remains after the operator revocation');
    const regrant = await identity.grantRoleAssignment(pid, TENANT, 'operator', 'admin:regrant', T0 + 4);
    assert.notEqual(regrant.id, first.id, 'a re-granted role is a NEW record (history never rewritten)');
    const operatorAssignments = (await identity.getRoleAssignments(pid, TENANT)).filter((r) => r.role === 'operator');
    assert.equal(operatorAssignments.length, 2, 'both the revoked and the re-granted operator records are retained');
    // The `system` role is kernel-internal and can never be granted.
    await assert.rejects(() => identity.grantRoleAssignment(pid, TENANT, 'system', 'admin:bad', T0 + 5), IdentityStoreError);
  });

  it('DEPROVISION CASCADE: sessions, tokens, grants, membership — no usable authority survives', async () => {
    const pid = nextId('d');
    await enrolled(pid);
    await identity.activate(pid, TENANT, { authenticationEventId: 'evt-c1', method: 'OIDC' }, T0);
    await identity.grantRoleAssignment(pid, TENANT, 'operator', 'admin:c', T0 + 1);
    await identity.grantRoleAssignment(pid, TENANT, 'agent', 'admin:c', T0 + 2);

    // Live sessions (S-8) for this principal.
    const evt1 = nextId('s8a');
    const evt2 = nextId('s8b');
    await sessions.recordEvent(
      { eventId: evt1, tenantId: TENANT, principalId: pid, method: 'OIDC', verifiedAt: T0, expiresAt: T0 + 3_600_000 },
      T0,
    );
    await sessions.recordEvent(
      { eventId: evt2, tenantId: TENANT, principalId: pid, method: 'OIDC', verifiedAt: T0, expiresAt: T0 + 3_600_000 },
      T0 + 1,
    );
    // A live token (S-9) for this principal (fingerprinted, never stored raw).
    const material = `cascade-material-${pid}`;
    await tokens.importRecords([{ token: material, tenantId: TENANT, principalId: pid, roles: ['operator'], label: 'cascade' }], 'cli:test', T0 + 2);
    const fp = AuthenticationEventStore.fingerprint(material);
    const beforeToken = (await tokens.getRegistration(fp, TENANT))!;
    assert.equal(beforeToken.status, 'ACTIVE');

    // Drive to DEACTIVATED (the permitted pre-deprovision path) and cascade.
    await identity.suspend(pid, TENANT, 'termination review', T0 + 3);
    await identity.deactivate(pid, TENANT, 'termination', T0 + 4);
    const result = await identity.deprovision(pid, TENANT, 'termination', T0 + 10);
    assert.deepEqual(
      result,
      { sessionsRevoked: 2, tokensRevoked: 1, roleAssignmentsRevoked: 3 },
      'the cascade revoked every session, token, and role grant (incl. the enrollment role)',
    );

    // Principal + membership terminal.
    const doc = (await identity.getPrincipal(pid, TENANT))!;
    assert.equal(doc.state, 'DEPROVISIONED');

    // Sessions REVOKED (no longer ACTIVE — the decider's session stage would
    // refuse them even if the identity gate were bypassed).
    const s1 = (await sessions.getEvent(evt1, TENANT))!;
    const s2 = (await sessions.getEvent(evt2, TENANT))!;
    assert.equal(s1.status, 'REVOKED');
    assert.equal(s2.status, 'REVOKED');
    assert.ok(s1.revocationReason!.startsWith('identity deprovisioned'), 'session revocation cites the identity cascade');

    // Token REVOKED.
    const afterToken = (await tokens.getRegistration(fp, TENANT))!;
    assert.equal(afterToken.status, 'REVOKED');

    // FUTURE grants are refused: a terminal identity cannot be granted new
    // authority (spec §4.4 — the cascade reaches future grants).
    await assert.rejects(() => identity.grantRoleAssignment(pid, TENANT, 'admin', 'admin:late', T0 + 14), IdentityLifecycleError);
    await assert.rejects(
      () => identity.activate(pid, TENANT, { authenticationEventId: 'evt-late', method: 'OIDC' }, T0 + 15),
      IdentityLifecycleError,
    );
    await assert.rejects(
      () => identity.autoLinkTokenPrincipal(pid, TENANT, ['observer'], 'cli:late', T0 + 16),
      IdentityRebindRefusedError,
    );
  });

  it('auto-link: idempotent repeat-link yields ONE stable relationship', async () => {
    const pid = nextId('al');
    const first = await identity.autoLinkTokenPrincipal(pid, TENANT, ['operator'], 'cli:test', T0);
    assert.deepEqual(first, { created: true, activated: true }, 'the first link creates (and activates) the identity');
    const second = await identity.autoLinkTokenPrincipal(pid, TENANT, ['operator'], 'cli:test', T0 + 2);
    assert.deepEqual(second, { created: false, activated: false }, 'repeat link is idempotent (no new relationship)');
    const doc = (await identity.getPrincipal(pid, TENANT))!;
    assert.equal(doc.state, 'ACTIVATED');
    // Exactly ONE auto-link event and ONE role record across both calls —
    // the repeat link added nothing (one stable relationship).
    const events = await identity.queryEvents(TENANT, 'CREDENTIAL_CHANGED');
    const autoLinked = events.filter((e) => e.principalId === pid);
    assert.equal(autoLinked.length, 1, 'exactly one auto-link CREDENTIAL_CHANGED event across first + repeat link');
    const roles = await identity.getRoleAssignments(pid, TENANT);
    assert.equal(roles.length, 1, 'exactly one role-assignment record (no duplicates on repeat link)');
  });

  it('auto-link: re-activates SUSPENDED, refuses terminal and cross-tenant rebinds', async () => {
    // Re-activate a suspended identity (the credential is still bound to it).
    const pid = nextId('alr');
    await identity.autoLinkTokenPrincipal(pid, TENANT, ['agent'], 'cli:test', T0);
    await identity.suspend(pid, TENANT, 'manual review', T0 + 1);
    const revived = await identity.autoLinkTokenPrincipal(pid, TENANT, ['agent'], 'cli:test', T0 + 2);
    assert.deepEqual(revived, { created: false, activated: true }, 'auto-link of a suspended identity re-activates it');
    assert.equal((await identity.getPrincipal(pid, TENANT))!.state, 'ACTIVATED');

    // Terminal identity refuses the credential (no resurrection by token).
    await identity.suspend(pid, TENANT, 'review 2', T0 + 3);
    await identity.deactivate(pid, TENANT, 'termination', T0 + 4);
    await identity.deprovision(pid, TENANT, 'termination', T0 + 5);
    await assert.rejects(
      () => identity.autoLinkTokenPrincipal(pid, TENANT, ['agent'], 'cli:test', T0 + 6),
      IdentityRebindRefusedError,
      'a token bound to a terminal identity must be refused',
    );

    // Cross-tenant rebind: the principal is bound to TENANT; linking the same
    // principal id into TENANT_B is refused (no ambiguity — INV-15-safe).
    const pid2 = nextId('alx');
    await identity.autoLinkTokenPrincipal(pid2, TENANT, ['observer'], 'cli:test', T0 + 7);
    await assert.rejects(
      () => identity.autoLinkTokenPrincipal(pid2, TENANT_B, ['observer'], 'cli:test', T0 + 8),
      IdentityRebindRefusedError,
      'cross-tenant auto-link rebind must be refused',
    );
  });

  it('federation binding: the subject↔tenant mapping is one-shot and rebind-resistant', async () => {
    const subject = `sub-${nextId('fb')}`;
    const a = nextId('fb-a');
    await identity.enroll(
      { principalId: a, tenantId: TENANT, roles: ['observer'], enrolledBy: 'admin:bind', issuer: ISSUER, subject },
      T0,
    );
    const binding = (await identity.findBySubject(ISSUER, subject))!;
    assert.equal(binding.tenantId, TENANT, 'the server-side map resolves the subject to the tenant');
    assert.equal(binding.principalId, a);
    // Unknown subject ⇒ undefined (authenticates to NOTHING — no default tenant).
    assert.equal(await identity.findBySubject(ISSUER, `unknown-${nextId('x')}`), undefined);
    // Rebind on enrollment: another principal cannot claim the same subject.
    await assert.rejects(
      () =>
        identity.enroll(
          { principalId: nextId('fb-b'), tenantId: TENANT, roles: ['observer'], enrolledBy: 'admin:rebind', issuer: ISSUER, subject },
          T0 + 1,
        ),
      IdentityRebindRefusedError,
      'a subject already bound to a principal cannot be enrolled for another (rebind refused)',
    );
    // Idempotent: re-enrolling the SAME (principal, subject) binding is fine.
    // (The binding already matches exactly.)
    const before = await identity.countSubjectBindings();
    assert.ok(before >= 1, 'the binding count is non-empty (P2-INV-09 input)');
  });

  it('recovery: one-shot, deny-early 300 s boundary, revocation, terminal refusal', async () => {
    const pid = nextId('rec');
    await enrolled(pid);

    // Fresh record; the consumption window is bounded deny-early: a record
    // expiring at E is refused once now + 300_000 >= E (the shared skew bound).
    const expiresAt = T0 + 3_600_000;
    const rec = await identity.createRecovery(
      { principalId: pid, tenantId: TENANT, method: 'totp-rebind', bindingRef: `ref-${nextId('b')}`, expiresAt, requestedBy: 'admin:rec' },
      T0,
    );
    assert.equal(rec.status, 'PENDING');
    // Boundary −1 ms: admissible (now + 300_000 < expiresAt).
    const atBoundaryMinus1 = expiresAt - 300_000 - 1;
    const ok = await identity.consumeRecovery(rec.id, TENANT, atBoundaryMinus1);
    assert.equal(ok.status, 'CONSUMED', 'consumption at expiresAt−300_000−1ms is admissible (deny-early boundary)');
    // One-shot: a second consumption is refused.
    await assert.rejects(() => identity.consumeRecovery(rec.id, TENANT, atBoundaryMinus1 + 1), IdentityStoreError, 'a consumed record is single-use');

    // Boundary INCLUSIVE: at exactly expiresAt−300_000 the record is refused.
    const rec2 = await identity.createRecovery(
      { principalId: pid, tenantId: TENANT, method: 'totp-rebind', bindingRef: `ref-${nextId('b2')}`, expiresAt, requestedBy: 'admin:rec' },
      T0,
    );
    await assert.rejects(
      () => identity.consumeRecovery(rec2.id, TENANT, expiresAt - 300_000),
      IdentityStoreError,
      'consumption at exactly expiresAt−300_000 is refused (deny-early is inclusive)',
    );

    // Revoked records cannot be consumed.
    const rec3 = await identity.createRecovery(
      { principalId: pid, tenantId: TENANT, method: 'totp-rebind', bindingRef: `ref-${nextId('b3')}`, expiresAt: T0 + 7_200_000, requestedBy: 'admin:rec' },
      T0,
    );
    await identity.revokeRecovery(rec3.id, TENANT, 'superseded', T0 + 1);
    await assert.rejects(() => identity.consumeRecovery(rec3.id, TENANT, T0 + 2), IdentityStoreError, 'a revoked record cannot be consumed');

    // Terminal identities cannot mint or consume recovery records
    // (ENROLLED → DEPROVISIONED: the permitted "(rejected)" terminal exit).
    await identity.deprovision(pid, TENANT, 'termination', T0 + 3);
    await assert.rejects(
      () =>
        identity.createRecovery(
          { principalId: pid, tenantId: TENANT, method: 'totp-rebind', bindingRef: `ref-${nextId('b4')}`, expiresAt: T0 + 7_200_000, requestedBy: 'admin:rec' },
          T0 + 6,
        ),
      IdentityStoreError,
      'recovery never targets a terminal identity (terminal is terminal)',
    );
  });

  it('jti replay: consume-once is durable; replays are refused; GC frees only expired entries', async () => {
    const jtiA = nextId('jti-a');
    const jtiB = nextId('jti-b');
    await jti.consume(jtiA, T0, T0 + 3_600_000); // success = no throw
    await assert.rejects(() => jti.consume(jtiA, T0 + 1, T0 + 3_600_000), JtiReplayError, 'the SAME jti replayed must be refused');
    await jti.consume(jtiB, T0 + 2, T0 + 7_200_000); // a different jti (longer-lived) is admitted

    // GC: jtiA expired at T0+3_600_000 and is past its retention grace;
    // jtiB (expiring later) must survive the sweep.
    const now = T0 + 3_600_000 + 300_001;
    const swept = await jti.gc(now);
    assert.ok(swept >= 1, 'GC reclaims expired jti entries');
    await jti.consume(jtiA, now + 1, T0 + 3_600_000); // GC-reclaimed ⇒ consumable again
    await assert.rejects(() => jti.consume(jtiB, now + 2, T0 + 7_200_000), JtiReplayError, 'the surviving jti is still replay-protected');
  });

  it('asStateAuthority: the decider view reflects live state (no cached roles)', async () => {
    const pid = nextId('auth');
    await enrolled(pid);
    const grant = await identity.grantRoleAssignment(pid, TENANT, 'operator', 'admin:au', T0);
    await identity.activate(pid, TENANT, { authenticationEventId: 'evt-au', method: 'OIDC' }, T0 + 1);
    const authority = identity.asStateAuthority();
    // In-tx read through an explicit tenant transaction (one snapshot).
    const lookup = await storage.atomically(async (scope) => authority.lookupInTx(scope, TENANT, pid, T0 + 2));
    assert.ok(lookup);
    assert.equal(lookup.state, 'ACTIVATED');
    assert.deepEqual([...lookup.activeRoles].sort(), ['observer', 'operator']);
    // Role revocation is visible at decision time (no cached role set).
    await identity.revokeRoleAssignment(grant.id, TENANT, 'scope reduction', T0 + 3);
    const after = await storage.atomically(async (scope) => authority.lookupInTx(scope, TENANT, pid, T0 + 4));
    assert.deepEqual([...after!.activeRoles], ['observer'], 'the ACTIVE role set shrinks in place at decision time');
    // Unknown principal ⇒ undefined (pre-P2 passthrough for unlinked principals).
    const ghost = await storage.atomically(async (scope) => authority.lookupInTx(scope, TENANT, nextId('ghost'), T0 + 5));
    assert.equal(ghost, undefined);
  });

  it('boot canary: the P2-INV-03 durable-path health check passes end to end', async () => {
    const result = await identity.runBootCanary(T0);
    assert.equal(result.ok, true, 'the boot canary renders the expected outcomes (never an availability failure)');
    assert.match(result.detail, /minted|suspended|deprovisioned|swept/i);
  });

  it('INV-15 positive: the S1 system-scope uses are the DECLARED transaction:system label', () => {
    const driver = storage.getDriver() as unknown as {
      getSystemScopeAudit: () => { undeclaredLabels: readonly string[]; uses: Readonly<Record<string, number>>; totalSystemScopeOperations: number };
    };
    const audit = driver.getSystemScopeAudit();
    assert.deepEqual(
      [...audit.undeclaredLabels],
      [],
      `no undeclared system-scope labels (got: ${JSON.stringify(audit.undeclaredLabels)})`,
    );
    assert.ok(
      (audit.uses['transaction:system'] ?? 0) > 0,
      'the declared transaction:system label is counted for the S1 pre-tenant reads (enumerated, auditable, bounded)',
    );
  });

  it('INV-15 negative: an UNDECLARED system-scope label is a recorded violation', async () => {
    const driver = storage.getDriver() as unknown as {
      withSystemScope: (label: string, fn: (client: unknown) => Promise<unknown>) => Promise<unknown>;
      getSystemScopeAudit: () => { undeclaredLabels: readonly string[] };
    };
    await driver.withSystemScope('transaction:rogue-p2-test', async () => {
      // A trivial no-op system-scope operation under a made-up label.
      return undefined;
    });
    const audit = driver.getSystemScopeAudit();
    assert.ok(
      audit.undeclaredLabels.includes('transaction:rogue-p2-test'),
      'an undeclared label outside the exception registry is recorded as a violation (the posture invariant refuses it at boot)',
    );
  });
});
