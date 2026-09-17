// P2-S8 — whole-tree outage matrix (A-19, spec §15) over real PostgreSQL.
// Fail-hard: embedded-PostgreSQL boot failure FAILS the suite (no skip).
//
// S2 proved fail-closed outage behavior for the session/token plane; R2
// proved it for the security-state pool. This suite extends the outage
// injection to EVERY P2 store on the final artifact: while the store is
// unreachable, identity, session, MFA, privilege, delegation, and
// break-glass operations must THROW (never ALLOW, never resolve with
// authority, never a memory fallback, never an unbounded hang); after the
// store recovers, the SAME durable rows verify again with identical digests.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import {
  AuthenticationEventStore,
  AuthenticationStoreError,
  AutoLinkedStaticTokenAuthenticator,
  BreakGlassStore,
  DelegationStore,
  DEV_SECRET_SEAM_KEY_ID,
  IdentityStore,
  InMemoryKeyManagementSeam,
  MfaFactorStore,
  PrincipalBoundary,
  PrivilegeStore,
  SecretMaterialStore,
  SessionTokenAuthenticator,
  SessionTokenService,
  StaticTokenAuthenticator,
  TokenRegistryStore,
  base32Decode,
  totpAt,
} from '../src/index.js';
import { base32Decode as base32DecodeMfa } from '../src/mfa.js';

let pg: R2Postgres;
let sessions: AuthenticationEventStore;
let identity: IdentityStore;
let service: SessionTokenService;
let privileges: PrivilegeStore;
let delegation: DelegationStore;
let mfa: MfaFactorStore;
let bg: BreakGlassStore;
let registry: TokenRegistryStore;

const TENANT = `s8outage-${process.pid}`;
const PRINCIPAL = 's8-user';
const DELEGATEE = 's8-peer';

let sessionToken = '';
let eventId = '';
let delegationId = '';
let breakGlassId = '';
let factorId = '';

/** Outage operations must REJECT (never resolve), and reject FAST: an
 *  unbounded hang during an outage is itself a fail-closed violation. */
async function rejectsSoon(label: string, fn: () => Promise<unknown>): Promise<unknown> {
  const outcome = await Promise.race([
    fn().then(
      () => 'RESOLVED' as const,
      (error: unknown) => error,
    ),
    new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 15_000)),
  ]);
  assert.notEqual(outcome, 'RESOLVED', `${label} must not succeed while the store is unreachable`);
  assert.notEqual(outcome, 'TIMEOUT', `${label} must fail fast while the store is unreachable (no unbounded hang)`);
  assert.ok(outcome instanceof Error, `${label} rejected with an Error, got ${String(outcome)}`);
  assert.ok(!/ALLOW/.test(outcome.message), `${label} rejection must never read as an allow`);
  return outcome;
}

async function treeDigest(): Promise<Record<string, unknown>> {
  const principal = await service.verify(sessionToken, TENANT, Date.now());
  const event = await sessions.getEvent(eventId, TENANT);
  const identityDoc = await identity.getPrincipal(PRINCIPAL, TENANT);
  const grant = await delegation.getDelegation(TENANT, delegationId);
  const factors = await mfa.listFactors({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: PRINCIPAL });
  const bgDoc = await bg.assertActive(breakGlassId, TENANT, 'tenant', Date.now());
  const bounds = await privileges.assertActiveElevationsWithinBounds(Date.now());
  return {
    sessionPrincipal: principal.id,
    eventStatus: event?.status ?? null,
    identityState: identityDoc?.state ?? null,
    delegationStatus: grant?.status ?? null,
    factorStatuses: factors.map((f) => f.status).sort(),
    bgStatus: bgDoc.status,
    activeElevations: bounds.active,
  };
}

before(async () => {
  pg = await bootR2Postgres('p2s8outage', 61150);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  sessions = await AuthenticationEventStore.open(storage);
  registry = await TokenRegistryStore.open(storage);
  identity = await IdentityStore.open(storage);
  service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: () => Date.now() });
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  const secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  mfa = await MfaFactorStore.open(storage, secrets);
  privileges = await PrivilegeStore.open(storage, { stepUpVerifier: mfa, strictStepUp: true });
  delegation = await DelegationStore.open(storage);
  bg = await BreakGlassStore.open(storage, secrets, mfa, privileges);

  await registry.importRecords(
    [{ token: 's8-outage-static', tenantId: TENANT, principalId: PRINCIPAL, roles: ['agent'] }],
    'p2-s8-outage',
    Date.now(),
  );
  const boundary = new PrincipalBoundary({
    authenticators: [
      new AutoLinkedStaticTokenAuthenticator(new StaticTokenAuthenticator([], { registry }), identity, 'p2-s8-outage'),
      new SessionTokenAuthenticator(service),
    ],
    policy: { mode: 'production' },
    now: () => Date.now(),
    eventStore: sessions,
    sessionTokenService: service,
  });
  const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material: 's8-outage-static' });
  sessionToken = minted.sessionToken;
  eventId = minted.principal.authenticationEventId;

  const enrolled = await mfa.enroll({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: PRINCIPAL, correlationId: 's8-seed' });
  factorId = enrolled.factorId;
  const secret = (typeof base32Decode === 'function' ? base32Decode : base32DecodeMfa)(enrolled.sharedSecretBase32);
  await mfa.activate({
    tenantId: TENANT,
    principalId: PRINCIPAL,
    actorPrincipalId: PRINCIPAL,
    factorId: enrolled.factorId,
    code: totpAt(secret, Date.now(), enrolled.params),
    correlationId: 's8-seed',
  });
  const stepUp = await mfa.verify({
    tenantId: TENANT,
    principalId: PRINCIPAL,
    actorPrincipalId: PRINCIPAL,
    factorId: enrolled.factorId,
    code: totpAt(secret, Date.now() + 30_000, enrolled.params),
    sessionId: eventId,
    level: 'step-up',
    correlationId: 's8-seed',
  });

  await privileges.bootstrapFirstElevation(
    { principalId: PRINCIPAL, tenantId: TENANT, reason: 'p2-s8 outage seed' },
    Date.now(),
  );

  const grant = await delegation.grantDelegation(
    {
      delegatorPrincipalId: PRINCIPAL,
      delegateePrincipalId: DELEGATEE,
      tenantId: TENANT,
      scope: 'tenant',
      capability: { capabilityId: 'cap.p2s8.outage', capabilityVersion: '1' },
      actions: [{ tool: 'docs', operation: 'read' }],
      targetScope: [{ system: 'docs', resourcePattern: 'res-*' }],
      constraints: { maxAgeMs: 3_600_000, classificationCeiling: 'INTERNAL', impactCeiling: 'EXTERNAL_SIDE_EFFECT' },
      chainDepth: 0,
      chain: ['sha256-delegator-manifest-live'],
      grantedBy: { principalId: PRINCIPAL, authenticationEventId: eventId },
      oneShot: false,
      useCount: 5,
      delegatorEvidence: {
        manifestDigest: 'sha256-delegator-manifest-live',
        actions: [{ tool: 'docs', operation: 'read' }],
        targets: [{ system: 'docs', resourcePattern: 'res-*' }],
        classificationCeiling: 'INTERNAL',
        impactCeiling: 'EXTERNAL_SIDE_EFFECT',
        requiresApproval: false,
      },
      correlationId: 's8-seed',
    },
    Date.now(),
  );
  delegationId = grant.id;

  const activated = await bg.activate({
    principalId: PRINCIPAL,
    tenantId: TENANT,
    scope: 'tenant',
    operationClasses: ['operator'],
    sessionEventId: eventId,
    stepUpEventId: stepUp.assuranceId,
    stepUpAt: stepUp.satisfiedAt,
    reason: 'p2-s8 outage seed activation',
    actorPrincipalId: PRINCIPAL,
    correlationId: 's8-seed',
  });
  breakGlassId = activated.id;
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P2-S8 whole-tree outage matrix (A-19, real PostgreSQL)', () => {
  it('healthy baseline: every P2 plane verifies before the outage', async () => {
    assert.ok(pg, 'P2-S8 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
    const digest = await treeDigest();
    assert.equal(digest.sessionPrincipal, PRINCIPAL);
    assert.equal(digest.eventStatus, 'ACTIVE');
    assert.equal(digest.identityState, 'ACTIVATED');
    assert.equal(digest.delegationStatus, 'ACTIVE');
    assert.equal(digest.bgStatus, 'ACTIVE');
    assert.deepEqual(digest.factorStatuses, ['ACTIVE']);
  });

  it('A-19 outage: every P2 plane throws fail-closed (never ALLOW, never memory fallback, never hang)', async () => {
    await pg.server.stop();
    try {
      // Session/token plane (S2 re-run on the final artifact).
      const verifyError = await rejectsSoon('session verify', () => service.verify(sessionToken, TENANT, Date.now()));
      assert.ok(verifyError instanceof AuthenticationStoreError, `fail-closed store error, got ${String(verifyError)}`);
      await rejectsSoon('session rotate', () => service.rotate(sessionToken, TENANT, Date.now()));
      await rejectsSoon('session mint', () =>
        service.mintFor(
          {
            id: PRINCIPAL,
            tenantId: TENANT,
            roles: ['agent'],
            authenticationMethod: 'STATIC_TOKEN',
            verifiedAt: Date.now(),
            authenticationEventId: `phantom-${process.pid}`,
          },
          Date.now(),
        ),
      );
      await rejectsSoon('session event read', () => sessions.getEvent(eventId, TENANT));
      // Identity plane (S1).
      await rejectsSoon('identity principal read', () => identity.getPrincipal(PRINCIPAL, TENANT));
      await rejectsSoon('identity role read', () => identity.getActiveRoles(PRINCIPAL, TENANT, Date.now()));
      // Privilege plane (S3).
      await rejectsSoon('privilege elevation bounds', () => privileges.assertActiveElevationsWithinBounds(Date.now()));
      // Delegation plane (S4).
      await rejectsSoon('delegation read', () => delegation.getDelegation(TENANT, delegationId));
      // MFA plane (S5).
      await rejectsSoon('mfa factor list', () =>
        mfa.listFactors({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: PRINCIPAL }),
      );
      await rejectsSoon('mfa enroll', () =>
        mfa.enroll({ tenantId: TENANT, principalId: `phantom-${process.pid}`, actorPrincipalId: PRINCIPAL, correlationId: 's8-outage' }),
      );
      // Break-glass plane (S6).
      await rejectsSoon('break-glass assertActive', () => bg.assertActive(breakGlassId, TENANT, 'tenant', Date.now()));
      // Token registry (S9): no verification without the store.
      await rejectsSoon('token registry verify', () => registry.verifyByMaterial('s8-outage-static', Date.now(), 's8-outage'));
    } finally {
      // stop-then-start hygiene (never start-on-running): leave the server
      // up for the recovery test and teardown.
      try {
        await pg.server.stop();
      } catch {
        /* already down is fine */
      }
      await pg.server.start();
    }
  });

  it('A-19 recovery: every P2 plane resumes with identical digests (store-mediated, not memory)', async () => {
    // The pool replaces dead backends on demand; drive one live op until it
    // succeeds (bounded), then assert the full digest (R2 recovery shape).
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await service.verify(sessionToken, TENANT, Date.now());
        break;
      } catch {
        if (Date.now() >= deadline) assert.fail('store recovered but session verify never succeeded (fail-hard)');
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const digest = await treeDigest();
    assert.equal(digest.sessionPrincipal, PRINCIPAL);
    assert.equal(digest.eventStatus, 'ACTIVE');
    assert.equal(digest.identityState, 'ACTIVATED');
    assert.equal(digest.delegationStatus, 'ACTIVE');
    assert.equal(digest.bgStatus, 'ACTIVE');
    assert.deepEqual(digest.factorStatuses, ['ACTIVE']);
    assert.ok((digest.activeElevations as number) >= 1);
    // The outflow path works too: a post-recovery factor read sees the seed.
    const factors = await mfa.listFactors({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: PRINCIPAL });
    assert.ok(factors.some((f) => f.id === factorId));
  });
});
