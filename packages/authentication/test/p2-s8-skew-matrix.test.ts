// P2-S8 — clock-skew boundary matrix (A-21, spec §15/§17) over real
// PostgreSQL. Fail-hard: embedded-PostgreSQL boot failure FAILS the suite.
//
// The architecture's single documented skew rule is DENY-EARLY with a 300 s
// bound: a window ending at E is treated as ended for all evaluation times
// `now` with `now + 300000 >= E`. Step-up freshness is instead an EXACT
// strict bound (`age > maxAgeMs`), with future-beyond-skew refused. This
// suite asserts every plane flips EXACTLY at its documented boundary — the
// spec's −301 s / −299 s / +299 s / +301 s offsets around each expiry, plus
// ±1 ms probes at the flip itself:
//
//   session window:    E-301000 VALID | E-300001 VALID | E-300000 EXPIRED | E-299000 EXPIRED
//   elevation window:  E-301000 VALID | E-300001 VALID | E-300000 EXPIRED | E-299000 EXPIRED
//   step-up freshness: age maxAge-1 VALID | maxAge VALID | maxAge+1 STALE (+ future probes)
//   delegation window: E-301000 ACTIVE | E-300001 ACTIVE | E-300000 EXPIRED | E-299000 EXPIRED
//
// All probe times derive from DURABLE rows (expiresAt/satisfiedAt read back
// from the store) and every evaluation takes an injected `now` — no wall-clock
// races. The decision-time assessors (assessElevationRow, assessDelegationRow)
// share these exact predicates with the store paths asserted here.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import {
  AuthenticationEventStore,
  AutoLinkedStaticTokenAuthenticator,
  DEV_SECRET_SEAM_KEY_ID,
  IdentityStore,
  InMemoryKeyManagementSeam,
  MfaError,
  MfaFactorStore,
  PrincipalBoundary,
  PrivilegeStore,
  SecretMaterialStore,
  SessionTokenAuthenticator,
  SessionTokenService,
  StaticTokenAuthenticator,
  TokenRegistryStore,
  DelegationStore,
  base32Decode,
  totpAt,
} from '../src/index.js';

let pg: R2Postgres;
let sessions: AuthenticationEventStore;
let service: SessionTokenService;
let privileges: PrivilegeStore;
let delegation: DelegationStore;
let mfa: MfaFactorStore;

const TENANT = `s8skew-${process.pid}`;
const PRINCIPAL = 's8-user';

const SKEW = 300_000;
const STEP_MAX_AGE = 600_000;

let sessionToken = '';
let sessionExpiresAt = 0;
let elevationId = '';
let elevationExpiresAt = 0;
let elevationStepUpAt = 0;
let assuranceId = '';
let assuranceSatisfiedAt = 0;
let assuranceSessionId = '';
let delegationExpiresAt = 0;

function grantInput(tenantId: string, _now: number) {
  return {
    delegatorPrincipalId: PRINCIPAL,
    delegateePrincipalId: 's8-peer',
    tenantId,
    scope: 'tenant' as const,
    capability: { capabilityId: 'cap.p2s8.skew', capabilityVersion: '1' },
    actions: [{ tool: 'docs', operation: 'read' }],
    targetScope: [{ system: 'docs', resourcePattern: 'res-*' }],
    constraints: { maxAgeMs: 600_000, classificationCeiling: 'INTERNAL', impactCeiling: 'EXTERNAL_SIDE_EFFECT' },
    chainDepth: 0,
    chain: ['sha256-delegator-manifest-live'],
    grantedBy: { principalId: PRINCIPAL, authenticationEventId: 'evt-s8-skew' },
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
  };
}

before(async () => {
  pg = await bootR2Postgres('p2s8skew', 61400);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  sessions = await AuthenticationEventStore.open(storage);
  const registry = await TokenRegistryStore.open(storage);
  const identity = await IdentityStore.open(storage);
  service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: () => Date.now() });
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  const secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  mfa = await MfaFactorStore.open(storage, secrets);
  privileges = await PrivilegeStore.open(storage, { stepUpVerifier: mfa, strictStepUp: true });
  delegation = await DelegationStore.open(storage);

  await registry.importRecords(
    [{ token: 's8-skew-static', tenantId: TENANT, principalId: PRINCIPAL, roles: ['agent'] }],
    'p2-s8-skew',
    Date.now(),
  );
  const boundary = new PrincipalBoundary({
    authenticators: [
      new AutoLinkedStaticTokenAuthenticator(new StaticTokenAuthenticator([], { registry }), identity, 'p2-s8-skew'),
      new SessionTokenAuthenticator(service),
    ],
    policy: { mode: 'production' },
    now: () => Date.now(),
    eventStore: sessions,
    sessionTokenService: service,
  });
  const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material: 's8-skew-static' });
  sessionToken = minted.sessionToken;
  const eventId = minted.principal.authenticationEventId;
  const eventRow = await sessions.getEvent(eventId, TENANT);
  assert.ok(eventRow, 'seeded session row readable');
  sessionExpiresAt = eventRow.expiresAt;

  const enrolled = await mfa.enroll({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: PRINCIPAL, correlationId: 's8-seed' });
  const secret = base32Decode(enrolled.sharedSecretBase32);
  // Three DISTINCT consumed steps are needed below (activate + 2 verifies),
  // all within the ±1 window of a STABLE current step. A TOTP step boundary
  // crossing mid-seed would push one code out of window (flaky MFA_CODE_INVALID),
  // so wait for a fresh step first (≥20 s remaining; the seed takes ~2 s).
  // TOTP phase is unix-epoch 30 s steps (mfa.ts totpAt), so the modulo is exact.
  for (;;) {
    if (Date.now() % 30_000 < 10_000) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const stepBase = Date.now();
  await mfa.activate({
    tenantId: TENANT,
    principalId: PRINCIPAL,
    actorPrincipalId: PRINCIPAL,
    factorId: enrolled.factorId,
    code: totpAt(secret, stepBase, enrolled.params),
    correlationId: 's8-seed',
  });
  // A1: the assurance under test for the step-up freshness matrix.
  const stepUp = await mfa.verify({
    tenantId: TENANT,
    principalId: PRINCIPAL,
    actorPrincipalId: PRINCIPAL,
    factorId: enrolled.factorId,
    code: totpAt(secret, stepBase + 30_000, enrolled.params),
    sessionId: eventId,
    level: 'step-up',
    correlationId: 's8-seed',
  });
  assuranceId = stepUp.assuranceId;
  assuranceSatisfiedAt = stepUp.satisfiedAt;
  assuranceSessionId = eventId;
  // A2: grantor assurance bound to the bootstrap session, for the
  // security-admin elevation grant below (strict store verifies it).
  const grantorStepUp = await mfa.verify({
    tenantId: TENANT,
    principalId: PRINCIPAL,
    actorPrincipalId: PRINCIPAL,
    factorId: enrolled.factorId,
    code: totpAt(secret, stepBase - 30_000, enrolled.params),
    sessionId: 'kernel:bootstrap',
    level: 'step-up',
    correlationId: 's8-seed-grantor',
  });

  await privileges.bootstrapFirstElevation({ principalId: PRINCIPAL, tenantId: TENANT, reason: 'p2-s8 skew seed' }, Date.now());
  const elevation = await privileges.grantElevation(
    {
      principalId: 's8-skew-admin',
      tenantId: TENANT,
      scope: 'tenant',
      planeRole: 'security-admin',
      operationClasses: ['security-admin'],
      sessionEventId: eventId,
      stepUpEventId: grantorStepUp.assuranceId,
      stepUpAt: grantorStepUp.satisfiedAt,
      grantedBy: 'kernel:bootstrap',
      grantorPrincipalId: PRINCIPAL,
      grantorSessionEventId: 'kernel:bootstrap',
      reason: 'p2-s8 skew-matrix elevation',
      lifetimeMs: 3_600_000,
    },
    Date.now(),
  );
  elevationId = elevation.id;
  elevationExpiresAt = elevation.expiresAt;
  assert.ok(typeof elevation.stepUpAt === 'number', 'security-admin elevation carries step-up evidence');
  elevationStepUpAt = elevation.stepUpAt as number;

  const probeGrant = await delegation.grantDelegation(grantInput(`s8skew-del-probe-${process.pid}`, Date.now()), Date.now());
  delegationExpiresAt = probeGrant.expiresAt;
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P2-S8 clock-skew boundary matrix (A-21, real PostgreSQL)', () => {
  it('seed complete: all boundary anchors read back from durable rows', async () => {
    assert.ok(pg, 'P2-S8 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
    assert.ok(sessionExpiresAt > 0 && elevationExpiresAt > 0 && delegationExpiresAt > 0);
    assert.ok(assuranceSatisfiedAt > 0 && elevationStepUpAt > 0);
  });

  it('A-21 session window flips exactly at E-300000 (deny-early, inclusive)', async () => {
    const E = sessionExpiresAt;
    assert.equal((await service.verify(sessionToken, TENANT, E - 301_000)).id, PRINCIPAL, 'E-301s: VALID');
    assert.equal((await service.verify(sessionToken, TENANT, E - SKEW - 1)).id, PRINCIPAL, 'E-300000-1ms: VALID');
    await assert.rejects(() => service.verify(sessionToken, TENANT, E - SKEW), 'E-300000 exactly: EXPIRED (inclusive)');
    await assert.rejects(() => service.verify(sessionToken, TENANT, E - 299_000), 'E-299s: EXPIRED');
    await assert.rejects(() => service.verify(sessionToken, TENANT, E + 299_000), 'E+299s: EXPIRED');
    await assert.rejects(() => service.verify(sessionToken, TENANT, E + 301_000), 'E+301s: EXPIRED');
  });

  it('A-21 elevation window flips exactly at E-300000 (durable recheck)', async () => {
    const E = elevationExpiresAt;
    const requirement = {
      principalId: 's8-skew-admin',
      operationClass: 'security-admin' as const,
      scope: 'tenant' as const,
      stepUpRequired: false,
      stepUpMaxAgeMs: STEP_MAX_AGE,
    };
    assert.equal((await privileges.recheckElevation(elevationId, TENANT, requirement, E - 301_000)).verdict, 'VALID');
    assert.equal((await privileges.recheckElevation(elevationId, TENANT, requirement, E - SKEW - 1)).verdict, 'VALID');
    assert.equal((await privileges.recheckElevation(elevationId, TENANT, requirement, E - SKEW)).verdict, 'EXPIRED');
    assert.equal((await privileges.recheckElevation(elevationId, TENANT, requirement, E - 299_000)).verdict, 'EXPIRED');
  });

  it('A-21 step-up staleness flips exactly at age=maxAge (strict) + future-beyond-skew refused', async () => {
    const S = elevationStepUpAt;
    const requirement = {
      principalId: 's8-skew-admin',
      operationClass: 'security-admin' as const,
      scope: 'tenant' as const,
      stepUpRequired: true,
      stepUpMaxAgeMs: STEP_MAX_AGE,
    };
    // All probes are inside the elevation window (1h lifetime): only the
    // step-up rule can deny here.
    assert.equal((await privileges.recheckElevation(elevationId, TENANT, requirement, S + STEP_MAX_AGE - 1)).verdict, 'VALID');
    assert.equal((await privileges.recheckElevation(elevationId, TENANT, requirement, S + STEP_MAX_AGE)).verdict, 'VALID');
    assert.equal((await privileges.recheckElevation(elevationId, TENANT, requirement, S + STEP_MAX_AGE + 1)).verdict, 'STEP_UP_STALE');
    // Future-beyond-skew: stepUpAt more than 300s ahead of `now` is stale;
    // exactly 300s ahead is honored (boundary inclusive-valid).
    assert.equal((await privileges.recheckElevation(elevationId, TENANT, requirement, S - SKEW)).verdict, 'VALID');
    assert.equal((await privileges.recheckElevation(elevationId, TENANT, requirement, S - SKEW - 1)).verdict, 'STEP_UP_STALE');
  });

  it('A-21 MFA assurance freshness flips exactly at age=maxAge (durable verify)', async () => {
    const S = assuranceSatisfiedAt;
    const input = (probeNow: number) => ({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      assuranceId,
      claimedAt: S,
      maxAgeMs: STEP_MAX_AGE,
      sessionId: assuranceSessionId,
      now: probeNow,
    });
    assert.ok(await mfa.verifyStepUpEvidence(input(S + STEP_MAX_AGE - 1)), 'age maxAge-1: VALID');
    assert.ok(await mfa.verifyStepUpEvidence(input(S + STEP_MAX_AGE)), 'age maxAge: VALID (strict >)');
    await assert.rejects(() => mfa.verifyStepUpEvidence(input(S + STEP_MAX_AGE + 1)), (error: unknown) => {
      assert.ok(error instanceof MfaError && error.code === 'MFA_ASSURANCE_EXPIRED');
      return true;
    });
    await assert.rejects(() => mfa.verifyStepUpEvidence(input(S - 1)), (error: unknown) => {
      assert.ok(error instanceof MfaError && error.code === 'MFA_ASSURANCE_MISMATCH');
      return true;
    });
  });

  it('A-21 delegation window flips exactly at E-300000 (durable sweep per tenant)', async () => {
    // sweepExpired is tenant-scoped and mutating: one grant per probe tenant,
    // each probed against its OWN durable expiresAt (grants mint milliseconds
    // apart, so a shared E would break the ±1ms exactness probes).
    const specs: Array<{ offset: (e: number) => number; swept: number; status: 'ACTIVE' | 'EXPIRED' }> = [
      { offset: (e) => e - 301_000, swept: 0, status: 'ACTIVE' },
      { offset: (e) => e - SKEW - 1, swept: 0, status: 'ACTIVE' },
      { offset: (e) => e - SKEW, swept: 1, status: 'EXPIRED' },
      { offset: (e) => e - 299_000, swept: 1, status: 'EXPIRED' },
    ];
    let i = 0;
    for (const spec of specs) {
      const tenant = `s8skew-del-${process.pid}-${i++}`;
      const grant = await delegation.grantDelegation(grantInput(tenant, Date.now()), Date.now());
      const probeNow = spec.offset(grant.expiresAt);
      assert.equal(await delegation.sweepExpired(tenant, probeNow), spec.swept, `${tenant}: swept=${spec.swept} at probe`);
      const rows = await delegation.listDelegations(tenant, 's8-peer');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, spec.status, `${tenant}: status=${spec.status} at probe`);
    }
  });
});
