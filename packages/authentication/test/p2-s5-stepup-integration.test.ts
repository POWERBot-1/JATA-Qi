// P2-S5 §8 — the privileged plane CONSUMING the MFA assurance signal.
//
// This is the half of S5 that §8 requires and that the S5 report recorded as
// OPEN: "privileged operations requiring stronger assurance must explicitly
// consume the MFA assurance signal."
//
// THE GAP (measured before this change)
//   privilege-store.grantElevation required step-up evidence but only checked
//   that it was PRESENT, finite, not future-beyond-skew, and non-blank. Nothing
//   resolved stepUpEventId against a real assurance record, and the declared
//   stepUpMaxAgeMs was compared nowhere. So `stepUpEventId: 'anything'` with
//   `stepUpAt: now` satisfied the guard.
//
// WHAT THIS PROVES
//   * a REAL assurance from S5 satisfies the plane;
//   * self-asserted evidence is now REFUSED;
//   * expired, wrong-session and wrong-principal evidence are REFUSED;
//   * strict mode refuses when no verifier is configured;
//   * operator-class grants (session auth suffices, spec §9.3) are unaffected;
//   * with NO verifier and strict off, behaviour is byte-for-byte the pre-S5
//     behaviour, so no existing caller is silently broken.
//
// Fail-hard: no skip path. A skipped test here would hide a re-opened gap.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import {
  DEV_SECRET_SEAM_KEY_ID,
  InMemoryKeyManagementSeam,
  MfaError,
  MfaFactorStore,
  PrivilegeStore,
  PrivilegeStoreError,
  SecretMaterialStore,
  base32Decode,
  totpAt,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

let pg: R2Postgres;
let storage: StorageModule;
let mfa: MfaFactorStore;
/** The plane wired to S5's assurance provider. */
let plane: PrivilegeStore;
/** The plane with no verifier — pre-S5 behaviour, must be unchanged. */
let planeUnverified: PrivilegeStore;
/** The plane in strict mode with no verifier — must refuse. */
let planeStrict: PrivilegeStore;

const T0 = Date.now();
/**
 * A bootstrapped security-admin elevation is bound to the session id
 * `kernel:bootstrap` (privilege-store.ts:540). The grantor authority check
 * re-reads that binding, so the grantor's session — and therefore the grantor's
 * step-up assurance — must be presented under it.
 */
const GRANTOR_SESSION = 'kernel:bootstrap';
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;

before(async () => {
  pg = await bootR2Postgres('p2s5stepup', 60200);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  const secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  mfa = await MfaFactorStore.open(storage, secrets);
  plane = await PrivilegeStore.open(storage, { stepUpVerifier: mfa });
  planeUnverified = await PrivilegeStore.open(storage);
  planeStrict = await PrivilegeStore.open(storage, { strictStepUp: true });
});

after(async () => {
  await pg.stop();
});

/** Bootstrap a tenant security-admin and return a grant-ready context. */
async function admin(): Promise<{ principalId: string; tenantId: string }> {
  const tenantId = `acme-${nextId('t')}`;
  const principalId = nextId('secadmin');
  await plane.bootstrapFirstElevation({ principalId, tenantId, reason: 'p2-s5 step-up integration bootstrap' }, T0);
  return { principalId, tenantId };
}

/** Enroll + activate a factor, then earn a REAL assurance from S5. */
async function realAssurance(ctx: { principalId: string; tenantId: string }, sessionId: string) {
  const enrolled = await mfa.enroll({ tenantId: ctx.tenantId, principalId: ctx.principalId, actorPrincipalId: ctx.principalId });
  const secret = base32Decode(enrolled.sharedSecretBase32);
  await mfa.activate({
    tenantId: ctx.tenantId,
    principalId: ctx.principalId,
    actorPrincipalId: ctx.principalId,
    factorId: enrolled.factorId,
    code: totpAt(secret, T0, enrolled.params),
  });
  return mfa.verify({
    tenantId: ctx.tenantId,
    principalId: ctx.principalId,
    actorPrincipalId: ctx.principalId,
    factorId: enrolled.factorId,
    code: totpAt(secret, T0, enrolled.params),
    sessionId,
    level: 'step-up',
  });
}

function grantInput(ctx: { principalId: string; tenantId: string }, sessionEventId: string, stepUpEventId: string, stepUpAt: number) {
  return {
    principalId: nextId('target'),
    tenantId: ctx.tenantId,
    scope: 'tenant' as const,
    planeRole: 'tenant-admin' as const,
    operationClasses: ['tenant-admin'] as const,
    sessionEventId,
    stepUpEventId,
    stepUpAt,
    grantedBy: 'p2-s5-integration',
    grantorPrincipalId: ctx.principalId,
    // The grantor's session is the bootstrap binding, NOT the target's session.
    grantorSessionEventId: GRANTOR_SESSION,
    reason: 'p2-s5 step-up integration',
  };
}

const code = (error: unknown): string =>
  error instanceof PrivilegeStoreError ? error.code : `NOT_A_PRIVILEGE_STORE_ERROR:${String(error)}`;

describe('P2-S5 §8 — the privilege plane consumes MFA assurance (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'this suite requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('a REAL S5 assurance satisfies the plane and the elevation is granted', async () => {
    const ctx = await admin();
    const sessionEventId = nextId('sess');
    const assurance = await realAssurance(ctx, GRANTOR_SESSION);
    // `now` must be >= satisfiedAt: the plane refuses evidence that appears to
    // come from the future, so a module-load timestamp would be rejected.
    const elevation = await plane.grantElevation(
      grantInput(ctx, sessionEventId, assurance.assuranceId, assurance.satisfiedAt),
      Date.now(),
    );
    assert.equal(elevation.status, 'ACTIVE');
    assert.equal(elevation.stepUpEventId, assurance.assuranceId);
  });

  it('SELF-ASSERTED step-up evidence is now REFUSED by the plane (the gap)', async () => {
    const ctx = await admin();
    const sessionEventId = nextId('sess');
    // This is exactly what satisfied the guard before: a fabricated id with a
    // present, non-future timestamp.
    await assert.rejects(
      plane.grantElevation(grantInput(ctx, sessionEventId, 'kernel:bootstrap', T0), T0),
      (error: unknown) => code(error) === 'STEP_UP_UNVERIFIED',
      'a fabricated stepUpEventId must NOT be accepted once a verifier is configured',
    );
  });

  it('EXPIRED assurance is refused — stepUpMaxAgeMs is now actually compared', async () => {
    const ctx = await admin();
    const sessionEventId = nextId('sess');
    const assurance = await realAssurance(ctx, GRANTOR_SESSION);
    // Strict mode is on for the freshness budget so any elapsed time is stale.
    const tight = await PrivilegeStore.open(storage, { stepUpVerifier: mfa, stepUpMaxAgeMs: 1 });
    await assert.rejects(
      tight.grantElevation(grantInput(ctx, sessionEventId, assurance.assuranceId, assurance.satisfiedAt), T0 + 60_000),
      (error: unknown) => code(error) === 'STEP_UP_UNVERIFIED',
    );
  });

  it('assurance earned in a DIFFERENT session is refused (no transplant)', async () => {
    const ctx = await admin();
    // Earned in some other session, then presented as if it were the grantor's.
    const assurance = await realAssurance(ctx, nextId('sess-elsewhere'));
    await assert.rejects(
      plane.grantElevation(grantInput(ctx, nextId('sess-target'), assurance.assuranceId, assurance.satisfiedAt), T0),
      (error: unknown) => code(error) === 'STEP_UP_UNVERIFIED',
    );
  });

  it('assurance belonging to ANOTHER principal is refused', async () => {
    const ctx = await admin();
    const other = await admin();
    // Assurance earned by `other`, presented for a grant under ctx's tenant.
    const assurance = await realAssurance(other, GRANTOR_SESSION);
    await assert.rejects(
      plane.grantElevation(grantInput(ctx, nextId('sess'), assurance.assuranceId, assurance.satisfiedAt), T0),
      (error: unknown) => code(error) === 'STEP_UP_UNVERIFIED',
    );
  });

  it('STRICT mode refuses a step-up grant when no verifier is configured', async () => {
    const ctx = await admin();
    const sessionEventId = nextId('sess');
    await assert.rejects(
      planeStrict.grantElevation(grantInput(ctx, sessionEventId, 'anything', T0), T0),
      (error: unknown) => code(error) === 'STEP_UP_UNVERIFIED',
      'a plane that cannot verify step-up evidence must not accept it in strict mode',
    );
  });

  it('OPERATOR-class grants are unaffected — session authentication still suffices (spec §9.3)', async () => {
    const ctx = await admin();
    const sessionEventId = nextId('sess');
    // No step-up evidence at all, under the strict plane: operator class does
    // not require step-up, so the verifier must not be consulted.
    const elevation = await planeStrict.grantElevation(
      {
        principalId: nextId('operator'),
        tenantId: ctx.tenantId,
        scope: 'tenant',
        planeRole: 'operator',
        operationClasses: ['operator'],
        sessionEventId,
        grantedBy: 'p2-s5-integration',
        grantorPrincipalId: ctx.principalId,
        grantorSessionEventId: GRANTOR_SESSION,
        reason: 'operator class does not require step-up',
      },
      T0,
    );
    assert.equal(elevation.status, 'ACTIVE');
  });

  it('with NO verifier and strict OFF, behaviour is unchanged (no caller silently broken)', async () => {
    const ctx = await admin();
    const sessionEventId = nextId('sess');
    // Pre-S5 behaviour: evidence is accepted on assertion. Preserved
    // deliberately so existing callers keep working; the trade-off is stated in
    // the S5 report rather than hidden.
    const elevation = await planeUnverified.grantElevation(
      grantInput(ctx, sessionEventId, 'kernel:bootstrap', T0),
      T0,
    );
    assert.equal(elevation.status, 'ACTIVE');
  });

  it('step-up belongs to the GRANTOR, not to the elevation TARGET', async () => {
    // An assurance earned by the target must NOT authorize the grantor's act.
    const ctx = await admin();
    const sessionEventId = nextId('sess');
    const target = nextId('target-with-own-mfa');
    // Give the TARGET its own genuine assurance, then try to spend it on a
    // grant the target does not perform.
    const targetEnrolled = await mfa.enroll({ tenantId: ctx.tenantId, principalId: target, actorPrincipalId: target });
    const targetSecret = base32Decode(targetEnrolled.sharedSecretBase32);
    await mfa.activate({
      tenantId: ctx.tenantId, principalId: target, actorPrincipalId: target,
      factorId: targetEnrolled.factorId, code: totpAt(targetSecret, T0, targetEnrolled.params),
    });
    const targetAssurance = await mfa.verify({
      tenantId: ctx.tenantId, principalId: target, actorPrincipalId: target,
      factorId: targetEnrolled.factorId, code: totpAt(targetSecret, T0, targetEnrolled.params),
      sessionId: GRANTOR_SESSION, level: 'step-up',
    });
    await assert.rejects(
      plane.grantElevation(grantInput(ctx, sessionEventId, targetAssurance.assuranceId, targetAssurance.satisfiedAt), T0),
      (error: unknown) => code(error) === 'STEP_UP_UNVERIFIED',
      "the target's own assurance cannot authorize the grantor's privileged act",
    );
  });

  it('the AUTHORIZATION decision is untouched by S5 (no second authority)', async () => {
    // Isolated on the plane WITHOUT a verifier, so the assurance check cannot
    // be the reason for the refusal: a principal without a security-admin
    // elevation is still refused by the grantor authority check alone.
    const ctx = await admin();
    const sessionEventId = nextId('sess');
    await assert.rejects(
      planeUnverified.grantElevation(
        { ...grantInput(ctx, sessionEventId, 'kernel:bootstrap', T0), grantorPrincipalId: nextId('rogue-no-elevation') },
        T0,
      ),
      (error: unknown) => error instanceof PrivilegeStoreError && code(error) !== 'STEP_UP_UNVERIFIED',
      'a rogue grantor is refused by the AUTHORITY check, proving S5 added an assurance check and not a second authority',
    );
  });

  it('an invalid verifier is refused at open (fail-closed wiring)', async () => {
    await assert.rejects(
      PrivilegeStore.open(storage, { stepUpVerifier: {} as never }),
      PrivilegeStoreError,
    );
    await assert.rejects(
      PrivilegeStore.open(storage, { stepUpVerifier: mfa, stepUpMaxAgeMs: 0 }),
      PrivilegeStoreError,
    );
  });

  // -----------------------------------------------------------------------
  // §5.3 — REVOKED-FACTOR ASSURANCE. Written BEFORE the fix so the defect is
  // proven, not assumed. Uses the real S5 factor/revocation path: no mocks, no
  // synthetic status mechanism.
  // -----------------------------------------------------------------------

  it('§5.3 a REVOKED factor invalidates its previously-earned assurance', async () => {
    const ctx = await admin();
    // 1. Earn a genuine assurance from a healthy factor.
    const assurance = await realAssurance(ctx, GRANTOR_SESSION);
    // Sanity: it is usable right now, so the later denial cannot be explained
    // by the assurance having been invalid all along.
    const before = await plane.grantElevation(
      grantInput(ctx, nextId('sess'), assurance.assuranceId, assurance.satisfiedAt),
      Date.now(),
    );
    assert.equal(before.status, 'ACTIVE', 'precondition: the assurance is genuinely valid before revocation');

    // 2. Revoke the factor through the real S5 lifecycle (compromise path).
    const factors = await mfa.listFactors({ tenantId: ctx.tenantId, principalId: ctx.principalId, actorPrincipalId: ctx.principalId });
    const active = factors.find((f) => f.status === 'ACTIVE');
    assert.ok(active, 'the factor is ACTIVE before revocation');
    await mfa.revoke({ tenantId: ctx.tenantId, principalId: ctx.principalId, actorPrincipalId: ctx.principalId, factorId: active!.id });

    // 3. Attempt to spend the SAME assurance, still inside its freshness window.
    await assert.rejects(
      plane.grantElevation(
        grantInput(ctx, nextId('sess'), assurance.assuranceId, assurance.satisfiedAt),
        Date.now(),
      ),
      (error: unknown) => code(error) === 'STEP_UP_UNVERIFIED',
      'a factor revoked as compromised must NOT keep authorizing elevations with its old assurance',
    );
  });

  it('§5.3 a REPLACED factor invalidates its previously-earned assurance', async () => {
    const ctx = await admin();
    const enrolled = await mfa.enroll({ tenantId: ctx.tenantId, principalId: ctx.principalId, actorPrincipalId: ctx.principalId });
    const secret = base32Decode(enrolled.sharedSecretBase32);
    await mfa.activate({
      tenantId: ctx.tenantId, principalId: ctx.principalId, actorPrincipalId: ctx.principalId,
      factorId: enrolled.factorId, code: totpAt(secret, T0, enrolled.params),
    });
    const assurance = await mfa.verify({
      tenantId: ctx.tenantId, principalId: ctx.principalId, actorPrincipalId: ctx.principalId,
      factorId: enrolled.factorId, code: totpAt(secret, T0, enrolled.params),
      sessionId: GRANTOR_SESSION, level: 'step-up',
    });
    // Replacement revokes the old factor and marks it REPLACED.
    await mfa.replace({
      tenantId: ctx.tenantId, principalId: ctx.principalId, actorPrincipalId: ctx.principalId,
      existingFactorId: enrolled.factorId,
      existingCode: totpAt(secret, Math.floor(T0 / 30_000) * 30_000 + 30_000, enrolled.params),
    });
    await assert.rejects(
      plane.grantElevation(
        grantInput(ctx, nextId('sess'), assurance.assuranceId, assurance.satisfiedAt),
        Date.now(),
      ),
      (error: unknown) => code(error) === 'STEP_UP_UNVERIFIED',
      'a replaced factor must not keep authorizing elevations with its old assurance',
    );
  });

  it('MFA verification is still not authorization: MfaError never leaks through the plane', async () => {
    const ctx = await admin();
    try {
      await plane.grantElevation(grantInput(ctx, nextId('sess'), 'mfaasr_does-not-exist', T0), T0);
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(error instanceof PrivilegeStoreError, 'the plane raises its own error type');
      assert.equal((error as PrivilegeStoreError).code, 'STEP_UP_UNVERIFIED');
      assert.ok(!(error instanceof MfaError), 'the MFA error class does not escape the plane boundary');
      // And the message carries no tenant or principal identifier.
      const message = (error as Error).message;
      assert.ok(!message.includes(ctx.tenantId), 'no tenant in the message');
      assert.ok(!message.includes(ctx.principalId), 'no principal in the message');
    }
  });
});
