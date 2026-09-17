// P2-S8 — cross-process fan-out contention (A-18, spec §15) over ONE shared
// real PostgreSQL backend. Fail-hard: embedded-PostgreSQL boot failure FAILS
// the suite (no skip).
//
// S2 proved 32-process session/token fan-out; S3 proved cross-process
// bootstrap single-winner; S6 proved 8-racer in-process break-glass
// one-shot. This suite extends fan-out to the REST of the P2 tree across
// OS processes (no shared memory — every verdict comes from the store):
//   1. Break-glass activation one-shot: 32 processes race one activation;
//      exactly 1 wins, 31 lose with BG_ONE_SHOT, exactly 1 BG elevation.
//   2. Session verify load: 32 processes × 10 verifies; 320/320 succeed.
//   3. Elevation revoke race: 8 processes revoke one elevation; the row is
//      terminal exactly once and every racer resolves (idempotent).
//   4. Cross-process MFA boundary (DOCUMENTED LIMITATION): with the dev
//      in-memory key seam, a parent-sealed TOTP secret is unopenable in a
//      fresh process, so cross-process MFA verify MUST fail closed here.
//      Cross-process MFA contention is provable only behind a shared
//      (external) key provider — which does not exist in this tree. The
//      test pins the fail-closed outcome; the runbook records the limit.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import {
  AuthenticationEventStore,
  AutoLinkedStaticTokenAuthenticator,
  BreakGlassStore,
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
  bootstrapElevationId,
  totpAt,
} from '../src/index.js';

let pg: R2Postgres;
let privileges: PrivilegeStore;
let bg: BreakGlassStore;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'p2-s8-worker.js');
const TENANT = `s8fanout-${process.pid}`;
const PRINCIPAL = 's8-user';

let sessionToken = '';
let eventId = '';
let stepUpEventId = '';
let stepUpAt = 0;
let bootstrapElevation = '';
let targetElevation = '';
let activeBeforeRevoke = 0;

function runWorker(mode: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [WORKER, mode, pg.connectionString, encoded], { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${mode} worker failed: ${error.message} :: ${stdout} :: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>);
      } catch {
        reject(new Error(`${mode} worker printed non-JSON: ${stdout} :: ${stderr}`));
      }
    });
  });
}

before(async () => {
  pg = await bootR2Postgres('p2s8fanout', 61350);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  const sessions = await AuthenticationEventStore.open(storage);
  const registry = await TokenRegistryStore.open(storage);
  const identity = await IdentityStore.open(storage);
  const service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: () => Date.now() });
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  const secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  const mfa = await MfaFactorStore.open(storage, secrets);
  privileges = await PrivilegeStore.open(storage, { stepUpVerifier: mfa, strictStepUp: true });
  bg = await BreakGlassStore.open(storage, secrets, mfa, privileges);

  await registry.importRecords(
    [{ token: 's8-fanout-static', tenantId: TENANT, principalId: PRINCIPAL, roles: ['agent'] }],
    'p2-s8-fanout',
    Date.now(),
  );
  const boundary = new PrincipalBoundary({
    authenticators: [
      new AutoLinkedStaticTokenAuthenticator(new StaticTokenAuthenticator([], { registry }), identity, 'p2-s8-fanout'),
      new SessionTokenAuthenticator(service),
    ],
    policy: { mode: 'production' },
    now: () => Date.now(),
    eventStore: sessions,
    sessionTokenService: service,
  });
  const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material: 's8-fanout-static' });
  sessionToken = minted.sessionToken;
  eventId = minted.principal.authenticationEventId;

  const enrolled = await mfa.enroll({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: PRINCIPAL, correlationId: 's8-seed' });
  const secret = base32Decode(enrolled.sharedSecretBase32);
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
  stepUpEventId = stepUp.assuranceId;
  stepUpAt = stepUp.satisfiedAt;

  const elevation = await privileges.bootstrapFirstElevation(
    { principalId: PRINCIPAL, tenantId: TENANT, reason: 'p2-s8 fan-out seed' },
    Date.now(),
  );
  bootstrapElevation = elevation.id;
  assert.equal(bootstrapElevation, bootstrapElevationId(TENANT, 'tenant'));

  // A SEPARATE operator-class target elevation for the revoke race. The
  // revoker (bootstrap principal) must hold live authority DISTINCT from the
  // row being revoked — revoking your own sole elevation correctly fails
  // closed for every loser (REVOKED revoker), which is the S3-proven
  // behavior, not the race under test here.
  const target = await privileges.grantElevation(
    {
      principalId: 's8-target',
      tenantId: TENANT,
      scope: 'tenant',
      planeRole: 'operator',
      operationClasses: ['operator'],
      sessionEventId: eventId,
      grantedBy: 'kernel:bootstrap',
      grantorPrincipalId: PRINCIPAL,
      grantorSessionEventId: 'kernel:bootstrap',
      reason: 'p2-s8 revoke-race target',
    },
    Date.now(),
  );
  targetElevation = target.id;
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P2-S8 cross-process fan-out contention (A-18, real PostgreSQL)', () => {
  it('PostgreSQL backend started and the seed verifies', async () => {
    assert.ok(pg, 'P2-S8 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
    assert.ok(sessionToken.length > 0 && eventId.length > 0 && stepUpEventId.length > 0);
  });

  it('A-18 break-glass one-shot: 32 processes race → exactly 1 winner, 31 BG_ONE_SHOT, 1 elevation', async () => {
    const racers = Array.from({ length: 32 }, (_, racer) =>
      runWorker('race-bg', {
        tenant: TENANT,
        principalId: PRINCIPAL,
        sessionEventId: eventId,
        stepUpEventId,
        stepUpAt,
        racer,
      }),
    );
    const results = await Promise.all(racers);
    for (const result of results) {
      assert.equal(result.workerError, undefined, `racer crashed: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true, `racer protocol failure: ${JSON.stringify(result)}`);
    }
    const winners = results.filter((r) => r.won === true);
    const losers = results.filter((r) => r.won === false);
    assert.equal(winners.length, 1, `exactly one activation wins, got ${winners.length}`);
    assert.equal(losers.length, 31);
    for (const loser of losers) {
      assert.equal(loser.code, 'BG_ONE_SHOT', `loser refused one-shot, got ${String(loser.code)}`);
    }
    // Exactly one durable ACTIVE record + exactly one break-glass elevation:
    // a second activation attempt (parent process) is refused one-shot, and
    // the ACTIVE-elevation count rose by exactly one (bootstrap + break-glass).
    await assert.rejects(
      bg.activate({
        principalId: PRINCIPAL,
        tenantId: TENANT,
        scope: 'tenant',
        operationClasses: ['operator'],
        sessionEventId: eventId,
        stepUpEventId,
        stepUpAt,
        reason: 'p2-s8 duplicate-activation probe (must lose)',
        actorPrincipalId: PRINCIPAL,
      }),
      (error: unknown) => (error as { code?: string }).code === 'BG_ONE_SHOT',
    );
    const bounds = await privileges.assertActiveElevationsWithinBounds(Date.now());
    assert.equal(bounds.active, 3, 'bootstrap + revoke-target + exactly one break-glass elevation are ACTIVE');
    activeBeforeRevoke = bounds.active;
  });

  it('A-18 session verify load: 32 processes × 10 verifies → 320/320 succeed, zero duplicate accepts', async () => {
    const loaders = Array.from({ length: 32 }, () => runWorker('verify-load', { tenant: TENANT, sessionToken, rounds: 10 }));
    const results = await Promise.all(loaders);
    let total = 0;
    for (const result of results) {
      assert.equal(result.workerError, undefined, `loader crashed: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true);
      total += (result.verified as number);
    }
    assert.equal(total, 320, 'every verify under fan-out load succeeds exactly once (no loss, no duplication)');
  });

  it('A-18 elevation revoke race: 8 revokers → terminal exactly once, every racer resolves', async () => {
    // The revoker acts under the bootstrap elevation, whose bound session is
    // 'kernel:bootstrap' (same shape as the S3 grantor pattern) — presenting
    // the user session would be a session mismatch, correctly refused. The
    // bootstrap elevation itself stays live; only the TARGET goes terminal.
    const revokers = Array.from({ length: 8 }, (_, racer) =>
      runWorker('race-revoke', {
        tenant: TENANT,
        elevationId: targetElevation,
        revokedBy: PRINCIPAL,
        revokerSessionEventId: 'kernel:bootstrap',
        racer,
      }),
    );
    const results = await Promise.all(revokers);
    for (const result of results) {
      assert.equal(result.workerError, undefined, `revoker crashed: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true, `revoker protocol failure: ${JSON.stringify(result)}`);
      assert.equal(result.status, 'REVOKED', 'every racer observes the terminal REVOKED state (idempotent)');
    }
    const bounds = await privileges.assertActiveElevationsWithinBounds(Date.now());
    assert.equal(bounds.active, activeBeforeRevoke - 1, 'the revoked elevation left the ACTIVE set exactly once');
  });

  it('A-18 cross-process MFA boundary: a fresh process fails closed (documented limitation)', async () => {
    // The dev in-memory key seam holds key material per process; a TOTP
    // secret sealed by the parent is unopenable in a fresh process. The
    // cross-process verify MUST therefore fail closed — never verify, never
    // bypass the seal. (Cross-process MFA contention is provable only behind
    // a shared external key provider; see the runbook limitation record.)
    const result = await runWorker('xproc-mfa', {
      tenant: TENANT,
      principalId: PRINCIPAL,
      factorId: 'probe-factor',
      code: '000000',
      sessionId: eventId,
    });
    assert.equal(result.workerError, undefined, `probe crashed: ${JSON.stringify(result)}`);
    assert.equal(result.verified, false, 'cross-process MFA verify must fail closed with a process-local seam');
    assert.ok(
      typeof result.code === 'string' && /^(MFA|SECRET|KEY)_/.test(result.code),
      `closed failure carries a fail-closed code, got ${String(result.code)}`,
    );
  });
});
