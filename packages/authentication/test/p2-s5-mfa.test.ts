// P2-S5 — MFA / stronger identity assurance, over real PostgreSQL.
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the suite
// FAILS. No skip — tenant/principal isolation is only meaningful against real
// RLS, and a skipped isolation test is a vacuous one.
//
// Every assertion below is written so that it FAILS if the security mechanism is
// removed. Where a mechanism could be silently absent, the test asserts the
// refusal, not merely the happy path.
//
// THE GAP THIS SUITE GUARDS (measured before S5):
//   privilege-store.ts required stepUpEventId + stepUpAt but only checked that
//   they were present and not future-beyond-skew. stepUpMaxAgeMs was declared on
//   every register entry and compared NOWHERE, and stepUpEventId was never
//   resolved against any event store. So self-asserted evidence passed.
//   'self-asserted step-up evidence is refused' is the test that dies if the fix
//   is reverted.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import {
  DEV_SECRET_SEAM_KEY_ID,
  DEFAULT_TOTP_PARAMETERS,
  InMemoryKeyManagementSeam,
  MFA_ASSURANCE_COLLECTION,
  MFA_EVENT_COLLECTION,
  MFA_FACTOR_COLLECTION,
  MfaError,
  MfaFactorStore,
  SecretMaterialStore,
  base32Decode,
  base32Encode,
  totpAt,
  totpVerifyStep,
  type MfaAssuranceDoc,
  type MfaEventRecord,
  type MfaFactorDoc,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

let pg: R2Postgres;
let storage: StorageModule;
let seam: InMemoryKeyManagementSeam;
let secrets: SecretMaterialStore;
let mfa: MfaFactorStore;

const TENANT = 'acme';
const OTHER_TENANT = 'other';
const PRINCIPAL = 'prin-s5-victim';
const OTHER_PRINCIPAL = 'prin-s5-intruder';
const ACTOR = 'prin-s5-actor';
const SESSION = 'sess-s5-a';
const OTHER_SESSION = 'sess-s5-b';

/** RFC 6238 Appendix B secret (ASCII "12345678901234567890"). */
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

/** Read every MFA audit row for a correlation id, straight from the durable store. */
async function events(correlationId: string, tenantId = TENANT): Promise<readonly MfaEventRecord[]> {
  return storage.atomically(async (scope) => {
    const rows = await scope.collection<MfaEventRecord>(MFA_EVENT_COLLECTION);
    return rows.query({ where: (row) => row.correlationId === correlationId });
  }, { tenantId });
}

async function allEvents(tenantId = TENANT): Promise<readonly MfaEventRecord[]> {
  return storage.atomically(async (scope) => {
    const rows = await scope.collection<MfaEventRecord>(MFA_EVENT_COLLECTION);
    return rows.query({ where: () => true });
  }, { tenantId });
}

async function factorRows(tenantId = TENANT): Promise<readonly MfaFactorDoc[]> {
  return storage.atomically(async (scope) => {
    const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
    return rows.query({ where: () => true });
  }, { tenantId });
}

async function assuranceRows(tenantId = TENANT): Promise<readonly MfaAssuranceDoc[]> {
  return storage.atomically(async (scope) => {
    const rows = await scope.collection<MfaAssuranceDoc>(MFA_ASSURANCE_COLLECTION);
    return rows.query({ where: () => true });
  }, { tenantId });
}

/** Enroll + activate a usable factor for a principal. Returns the live secret. */
async function enrolledFactor(principalId: string, tag: string) {
  const correlationId = `corr-${tag}-${Math.random().toString(36).slice(2)}`;
  const enrolled = await mfa.enroll({ tenantId: TENANT, principalId, actorPrincipalId: ACTOR, correlationId });
  const secret = base32Decode(enrolled.sharedSecretBase32);
  await mfa.activate({
    tenantId: TENANT,
    principalId,
    actorPrincipalId: ACTOR,
    factorId: enrolled.factorId,
    code: totpAt(secret, Date.now(), enrolled.params),
    correlationId,
  });
  return { ...enrolled, secret, correlationId };
}

const code = (mfaError: unknown): string =>
  mfaError instanceof MfaError ? mfaError.code : `NOT_AN_MFA_ERROR:${String(mfaError)}`;

before(async () => {
  pg = await bootR2Postgres('p2s5mfa', 59950);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  mfa = await MfaFactorStore.open(storage, secrets, {
    throttlePolicy: { maxFailures: 3, windowMs: 15 * 60_000, lockoutMs: 60_000 },
  });
});

after(async () => {
  await pg.stop();
});

describe('P2-S5 MFA (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S5 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  // -------------------------------------------------------------------------
  // TOTP correctness — against the RFC, not against itself
  // -------------------------------------------------------------------------

  it('TOTP matches the RFC 6238 Appendix B vector for SHA-1', () => {
    // T=59s → step 1 → 8-digit 94287082 → 6-digit 287082.
    assert.equal(totpAt(RFC_SECRET, 59_000, DEFAULT_TOTP_PARAMETERS), '287082');
    // T=1111111109 → 07081804 → 081804.
    assert.equal(totpAt(RFC_SECRET, 1_111_111_109_000, DEFAULT_TOTP_PARAMETERS), '081804');
    // T=1111111111 → 14050471 → 050471.
    assert.equal(totpAt(RFC_SECRET, 1_111_111_111_000, DEFAULT_TOTP_PARAMETERS), '050471');
    // T=1234567890 → 89005924 → 005924.
    assert.equal(totpAt(RFC_SECRET, 1_234_567_890_000, DEFAULT_TOTP_PARAMETERS), '005924');
    // T=2000000000 → 69279037 → 279037.
    assert.equal(totpAt(RFC_SECRET, 2_000_000_000_000, DEFAULT_TOTP_PARAMETERS), '279037');
  });

  it('the verification window accepts ±1 step and rejects outside it', () => {
    const t = 1_234_567_890_000;
    const step = Math.floor(t / 1000 / 30);
    const current = totpAt(RFC_SECRET, t, DEFAULT_TOTP_PARAMETERS);
    assert.equal(totpVerifyStep(RFC_SECRET, current, t, DEFAULT_TOTP_PARAMETERS), step);
    // A code from one step earlier still verifies inside the window, and the
    // returned step identifies WHICH step was consumed (needed for replay).
    const previous = totpAt(RFC_SECRET, t - 30_000, DEFAULT_TOTP_PARAMETERS);
    assert.equal(totpVerifyStep(RFC_SECRET, previous, t, DEFAULT_TOTP_PARAMETERS), step - 1);
    // Two steps back is outside ±1.
    const stale = totpAt(RFC_SECRET, t - 60_000, DEFAULT_TOTP_PARAMETERS);
    if (stale !== previous && stale !== current) {
      assert.equal(totpVerifyStep(RFC_SECRET, stale, t, DEFAULT_TOTP_PARAMETERS), undefined);
    }
  });

  it('a malformed or wrong-length code is rejected without touching the secret', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '  ', '12 34 56']) {
      assert.equal(totpVerifyStep(RFC_SECRET, bad, 1_234_567_890_000, DEFAULT_TOTP_PARAMETERS), undefined, `code ${JSON.stringify(bad)}`);
    }
  });

  it('base32 round-trips an enrolled secret', () => {
    const encoded = base32Encode(RFC_SECRET);
    assert.deepEqual(base32Decode(encoded), RFC_SECRET);
  });

  // -------------------------------------------------------------------------
  // Enrollment + activation
  // -------------------------------------------------------------------------

  it('enrollment yields a PENDING factor and returns the secret exactly once', async () => {
    const enrolled = await mfa.enroll({ tenantId: TENANT, principalId: 'prin-s5-enroll', actorPrincipalId: ACTOR });
    assert.equal(enrolled.status, 'PENDING');
    assert.ok(enrolled.sharedSecretBase32.length > 0);
    assert.equal(base32Decode(enrolled.sharedSecretBase32).length, DEFAULT_TOTP_PARAMETERS.secretBytes);
    // The durable row holds an S7 secret REFERENCE, never the secret.
    const rows = await factorRows();
    const row = rows.find((doc) => doc.id === enrolled.factorId);
    assert.ok(row, 'factor row exists');
    assert.equal(row!.status, 'PENDING');
    assert.ok(row!.secretId.length > 0);
    assert.ok(!JSON.stringify(row!).includes(enrolled.sharedSecretBase32), 'no secret in the durable row');
  });

  it('a second enrollment for the same principal is refused (no silent factor swap)', async () => {
    const principalId = 'prin-s5-double';
    await mfa.enroll({ tenantId: TENANT, principalId, actorPrincipalId: ACTOR });
    await assert.rejects(
      mfa.enroll({ tenantId: TENANT, principalId, actorPrincipalId: ACTOR }),
      (error: unknown) => code(error) === 'MFA_ALREADY_ENROLLED',
    );
  });

  it('activation with a WRONG code is refused and the factor stays PENDING', async () => {
    const enrolled = await mfa.enroll({ tenantId: TENANT, principalId: 'prin-s5-badact', actorPrincipalId: ACTOR });
    await assert.rejects(
      mfa.activate({
        tenantId: TENANT,
        principalId: 'prin-s5-badact',
        actorPrincipalId: ACTOR,
        factorId: enrolled.factorId,
        code: '000000',
      }),
      (error: unknown) => code(error) === 'MFA_CODE_INVALID' || code(error) === 'MFA_THROTTLED',
    );
    const rows = await factorRows();
    assert.equal(rows.find((doc) => doc.id === enrolled.factorId)!.status, 'PENDING');
  });

  it('a PENDING factor cannot be used to verify (activation is mandatory)', async () => {
    const enrolled = await mfa.enroll({ tenantId: TENANT, principalId: 'prin-s5-pending', actorPrincipalId: ACTOR });
    const secret = base32Decode(enrolled.sharedSecretBase32);
    await assert.rejects(
      mfa.verify({
        tenantId: TENANT,
        principalId: 'prin-s5-pending',
        actorPrincipalId: ACTOR,
        factorId: enrolled.factorId,
        code: totpAt(secret, Date.now(), enrolled.params),
      }),
      (error: unknown) => code(error) === 'MFA_NOT_ACTIVE',
    );
  });

  // -------------------------------------------------------------------------
  // Verification, replay, assurance
  // -------------------------------------------------------------------------

  it('a valid code on an ACTIVE factor produces a durable assurance', async () => {
    const factor = await enrolledFactor('prin-s5-ok', 'ok');
    const result = await mfa.verify({
      tenantId: TENANT,
      principalId: 'prin-s5-ok',
      actorPrincipalId: ACTOR,
      factorId: factor.factorId,
      code: totpAt(factor.secret, Date.now(), factor.params),
      sessionId: SESSION,
    });
    assert.equal(result.level, 'multi-factor');
    const rows = await assuranceRows();
    const doc = rows.find((row) => row.id === result.assuranceId);
    assert.ok(doc, 'assurance row exists');
    assert.equal(doc!.principalId, 'prin-s5-ok');
    assert.equal(doc!.sessionId, SESSION);
    assert.equal(doc!.satisfiedAt, result.satisfiedAt);
  });

  it('REPLAY: the same code cannot be consumed twice for one factor', async () => {
    const factor = await enrolledFactor('prin-s5-replay', 'replay');
    const presented = totpAt(factor.secret, Date.now(), factor.params);
    await mfa.verify({
      tenantId: TENANT,
      principalId: 'prin-s5-replay',
      actorPrincipalId: ACTOR,
      factorId: factor.factorId,
      code: presented,
    });
    await assert.rejects(
      mfa.verify({
        tenantId: TENANT,
        principalId: 'prin-s5-replay',
        actorPrincipalId: ACTOR,
        factorId: factor.factorId,
        code: presented,
      }),
      (error: unknown) => code(error) === 'MFA_CODE_REPLAYED',
    );
  });

  it('CONCURRENCY: racers presenting the same code produce at most one assurance', async () => {
    // NOTE ON TEST POWER: a get-then-put replay guard passed a 6-racer
    // standalone run and still let 5 of 6 win under full-suite load. So this
    // test deliberately over-provisions racers and repeats, because a race test
    // that usually passes proves nothing.
    for (let round = 0; round < 3; round += 1) {
      const racers = await enrolledFactor(`prin-s5-race-${round}`, `race${round}`);
      const sameCode = totpAt(racers.secret, Date.now(), racers.params);
      const attempts = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          mfa.verify({
            tenantId: TENANT,
            principalId: `prin-s5-race-${round}`,
            actorPrincipalId: ACTOR,
            factorId: racers.factorId,
            code: sameCode,
          }),
        ),
      );
      const successes = attempts.filter((a) => a.status === 'fulfilled');
      const reasons = attempts
        .filter((a): a is PromiseRejectedResult => a.status === 'rejected')
        .map((a) => code(a.reason));
      // The SECURITY invariant is "at most one assurance per code", and that is
      // what is asserted. The losers' specific code is deliberately NOT pinned:
      // under row-lock contention a losing transaction may surface a
      // serialization failure rather than reaching the replay branch, and
      // over-specifying that would assert an implementation detail instead of
      // the property. What must hold is that every loser is refused with a
      // fail-closed MFA code, and that exactly one durable assurance exists.
      assert.equal(successes.length, 1, `round ${round}: exactly one racer wins, got ${successes.length}; rejections=${JSON.stringify(reasons.sort())}`);
      assert.equal(reasons.length, 11, `round ${round}: the other 11 are all refused, got ${reasons.length}`);
      for (const reason of reasons) {
        assert.match(reason, /^MFA_/, `round ${round}: every refusal is a fail-closed MFA code, got ${reason}`);
      }
      assert.ok(reasons.filter((r) => r === 'MFA_CODE_REPLAYED').length >= 1, 'at least one loser is explicitly identified as a replay');
      const earned = (await assuranceRows()).filter((row) => row.principalId === `prin-s5-race-${round}`);
      assert.equal(earned.length, 1, `round ${round}: exactly one durable assurance was written, got ${earned.length}`);
    }
  });

  // -------------------------------------------------------------------------
  // Tenant and principal isolation — adversarial
  // -------------------------------------------------------------------------

  it('TENANT ISOLATION: a factor is invisible from another tenant (real RLS)', async () => {
    const factor = await enrolledFactor('prin-s5-xtenant', 'xtenant');
    // The intruder tenant cannot even see the row.
    const otherRows = await storage.atomically(async (scope) => {
      const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
      return rows.query({ where: () => true });
    }, { tenantId: OTHER_TENANT });
    assert.equal(otherRows.length, 0, 'RLS hides every acme row from the other tenant');
    // And a verification attempted under the wrong tenant is refused.
    await assert.rejects(
      mfa.verify({
        tenantId: OTHER_TENANT,
        principalId: 'prin-s5-xtenant',
        actorPrincipalId: ACTOR,
        factorId: factor.factorId,
        code: totpAt(factor.secret, Date.now(), factor.params),
      }),
      (error: unknown) => code(error) === 'MFA_UNKNOWN',
    );
  });

  it('PRINCIPAL ISOLATION: a wrong principal is indistinguishable from a nonexistent factor', async () => {
    const factor = await enrolledFactor('prin-s5-xprincipal', 'xprincipal');
    const validCode = totpAt(factor.secret, Date.now(), factor.params);
    // Wrong principal, with the CORRECT code.
    const wrongPrincipal = await mfa
      .verify({
        tenantId: TENANT,
        principalId: OTHER_PRINCIPAL,
        actorPrincipalId: ACTOR,
        factorId: factor.factorId,
        code: validCode,
      })
      .then(() => 'SUCCEEDED', (error: unknown) => code(error));
    // Nonexistent factor id.
    const nonexistent = await mfa
      .verify({
        tenantId: TENANT,
        principalId: 'prin-s5-xprincipal',
        actorPrincipalId: ACTOR,
        factorId: 'mfaf_does-not-exist',
        code: validCode,
      })
      .then(() => 'SUCCEEDED', (error: unknown) => code(error));
    assert.equal(wrongPrincipal, 'MFA_UNKNOWN');
    assert.equal(nonexistent, 'MFA_UNKNOWN');
    assert.equal(wrongPrincipal, nonexistent, 'no identifier oracle: both paths are identical');
  });

  it('a forged ACTOR cannot enroll, list, or act for another principal', async () => {
    await assert.rejects(
      mfa.enroll({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: '   ' }),
      (error: unknown) => code(error) === 'MFA_INVALID_ARGUMENT',
    );
    await assert.rejects(
      mfa.listFactors({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: '' }),
      (error: unknown) => code(error) === 'MFA_INVALID_ARGUMENT',
    );
  });

  // -------------------------------------------------------------------------
  // THE GAP FIX — verifiable step-up evidence
  // -------------------------------------------------------------------------

  it('step-up evidence resolves against a real assurance record', async () => {
    const factor = await enrolledFactor('prin-s5-stepup', 'stepup');
    const result = await mfa.verify({
      tenantId: TENANT,
      principalId: 'prin-s5-stepup',
      actorPrincipalId: ACTOR,
      factorId: factor.factorId,
      code: totpAt(factor.secret, Date.now(), factor.params),
      sessionId: SESSION,
      level: 'step-up',
    });
    const verified = await mfa.verifyStepUpEvidence({
      tenantId: TENANT,
      principalId: 'prin-s5-stepup',
      assuranceId: result.assuranceId,
      claimedAt: result.satisfiedAt,
      maxAgeMs: 15 * 60_000,
      sessionId: SESSION,
      requiredLevel: 'step-up',
      now: Date.now(),
    });
    assert.equal(verified.id, result.assuranceId);
    assert.equal(verified.level, 'step-up');
  });

  it('SELF-ASSERTED step-up evidence is refused (the pre-S5 gap)', async () => {
    // Before S5, privilege-store accepted ANY non-blank stepUpEventId with a
    // present, non-future stepUpAt. That is exactly what this asserts against.
    const factor = await enrolledFactor('prin-s5-selfassert', 'selfassert');
    void factor;
    await assert.rejects(
      mfa.verifyStepUpEvidence({
        tenantId: TENANT,
        principalId: 'prin-s5-selfassert',
        assuranceId: 'kernel:bootstrap',
        claimedAt: Date.now(),
        maxAgeMs: 15 * 60_000,
        now: Date.now(),
      }),
      (error: unknown) => code(error) === 'MFA_ASSURANCE_UNKNOWN',
      'a fabricated stepUpEventId must NOT resolve — this is the gap S5 closes',
    );
  });

  it('EXPIRED step-up evidence is refused (stepUpMaxAgeMs is now actually enforced)', async () => {
    const factor = await enrolledFactor('prin-s5-expiry', 'expiry');
    const result = await mfa.verify({
      tenantId: TENANT,
      principalId: 'prin-s5-expiry',
      actorPrincipalId: ACTOR,
      factorId: factor.factorId,
      code: totpAt(factor.secret, Date.now(), factor.params),
      level: 'step-up',
    });
    await assert.rejects(
      mfa.verifyStepUpEvidence({
        tenantId: TENANT,
        principalId: 'prin-s5-expiry',
        assuranceId: result.assuranceId,
        claimedAt: result.satisfiedAt,
        // A 1ms budget makes any real elapsed time stale.
        maxAgeMs: 1,
        now: result.satisfiedAt + 60_000,
      }),
      (error: unknown) => code(error) === 'MFA_ASSURANCE_EXPIRED',
    );
  });

  it('step-up evidence cannot be transplanted to another session, principal, or tenant', async () => {
    const factor = await enrolledFactor('prin-s5-transplant', 'transplant');
    const result = await mfa.verify({
      tenantId: TENANT,
      principalId: 'prin-s5-transplant',
      actorPrincipalId: ACTOR,
      factorId: factor.factorId,
      code: totpAt(factor.secret, Date.now(), factor.params),
      sessionId: SESSION,
      level: 'step-up',
    });
    const base = {
      assuranceId: result.assuranceId,
      claimedAt: result.satisfiedAt,
      maxAgeMs: 15 * 60_000,
      now: Date.now(),
    };
    // Another session.
    await assert.rejects(
      mfa.verifyStepUpEvidence({ ...base, tenantId: TENANT, principalId: 'prin-s5-transplant', sessionId: OTHER_SESSION }),
      (error: unknown) => code(error) === 'MFA_ASSURANCE_MISMATCH',
    );
    // Another principal.
    await assert.rejects(
      mfa.verifyStepUpEvidence({ ...base, tenantId: TENANT, principalId: OTHER_PRINCIPAL }),
      (error: unknown) => code(error) === 'MFA_ASSURANCE_UNKNOWN',
    );
    // Another tenant.
    await assert.rejects(
      mfa.verifyStepUpEvidence({ ...base, tenantId: OTHER_TENANT, principalId: 'prin-s5-transplant' }),
      (error: unknown) => code(error) === 'MFA_ASSURANCE_UNKNOWN',
    );
    // A claimed timestamp that disagrees with the durable record.
    await assert.rejects(
      mfa.verifyStepUpEvidence({
        ...base,
        tenantId: TENANT,
        principalId: 'prin-s5-transplant',
        claimedAt: result.satisfiedAt + 1,
      }),
      (error: unknown) => code(error) === 'MFA_ASSURANCE_MISMATCH',
    );
  });

  it('a lower assurance level cannot satisfy a higher requirement', async () => {
    const factor = await enrolledFactor('prin-s5-level', 'level');
    const result = await mfa.verify({
      tenantId: TENANT,
      principalId: 'prin-s5-level',
      actorPrincipalId: ACTOR,
      factorId: factor.factorId,
      code: totpAt(factor.secret, Date.now(), factor.params),
      level: 'multi-factor',
    });
    await assert.rejects(
      mfa.verifyStepUpEvidence({
        tenantId: TENANT,
        principalId: 'prin-s5-level',
        assuranceId: result.assuranceId,
        claimedAt: result.satisfiedAt,
        maxAgeMs: 15 * 60_000,
        requiredLevel: 'step-up',
        now: Date.now(),
      }),
      (error: unknown) => code(error) === 'MFA_ASSURANCE_MISMATCH',
    );
  });

  // -------------------------------------------------------------------------
  // Rate limiting / abuse
  // -------------------------------------------------------------------------

  it('repeated wrong codes throttle, and the lockout is bounded (not a permanent DoS)', async () => {
    const factor = await enrolledFactor('prin-s5-throttle', 'throttle');
    let throttled = false;
    for (let attempt = 0; attempt < 5 && !throttled; attempt += 1) {
      try {
        await mfa.verify({
          tenantId: TENANT,
          principalId: 'prin-s5-throttle',
          actorPrincipalId: ACTOR,
          factorId: factor.factorId,
          code: '000000',
        });
      } catch (error) {
        if (code(error) === 'MFA_THROTTLED') throttled = true;
      }
    }
    assert.ok(throttled, 'the throttle engages within the configured budget');
    // The lockout has an expiry, so account protection cannot become a
    // permanent attacker-triggered denial of service against the victim.
    const rows = await storage.atomically(async (scope) => {
      const throttleRows = await scope.collection<{ id: string; lockedUntil?: number }>('identity.mfa-throttle');
      return throttleRows.query({ where: () => true });
    }, { tenantId: TENANT });
    const lock = rows.find((row) => row.lockedUntil !== undefined);
    assert.ok(lock, 'a lockout was recorded');
    assert.ok(Number.isFinite(lock!.lockedUntil), 'the lockout expires at a finite time');
  });

  // -------------------------------------------------------------------------
  // Lifecycle: revoke / replace / recover
  // -------------------------------------------------------------------------

  it('a REVOKED factor can no longer verify, and its secret is revoked too', async () => {
    const factor = await enrolledFactor('prin-s5-revoke', 'revoke');
    await mfa.revoke({ tenantId: TENANT, principalId: 'prin-s5-revoke', actorPrincipalId: ACTOR, factorId: factor.factorId });
    await assert.rejects(
      mfa.verify({
        tenantId: TENANT,
        principalId: 'prin-s5-revoke',
        actorPrincipalId: ACTOR,
        factorId: factor.factorId,
        code: totpAt(factor.secret, Date.now(), factor.params),
      }),
      (error: unknown) => code(error) === 'MFA_NOT_ACTIVE' || code(error) === 'MFA_SEAM_UNAVAILABLE',
    );
    const rows = await factorRows();
    assert.equal(rows.find((doc) => doc.id === factor.factorId)!.status, 'REVOKED');
  });

  it('REPLACEMENT requires a successful verification of the existing factor', async () => {
    const factor = await enrolledFactor('prin-s5-replace', 'replace');
    // Without the existing code, replacement is refused — a password-only
    // attacker cannot swap the victim's factor.
    await assert.rejects(
      mfa.replace({
        tenantId: TENANT,
        principalId: 'prin-s5-replace',
        actorPrincipalId: ACTOR,
        existingFactorId: factor.factorId,
        existingCode: '000000',
      }),
      (error: unknown) => code(error) === 'MFA_CODE_INVALID' || code(error) === 'MFA_THROTTLED',
    );
    // With it, replacement succeeds and yields a fresh PENDING factor.
    const nextStep = Math.floor(Date.now() / 1000 / 30) + 1;
    const replacement = await mfa.replace({
      tenantId: TENANT,
      principalId: 'prin-s5-replace',
      actorPrincipalId: ACTOR,
      existingFactorId: factor.factorId,
      existingCode: totpAt(factor.secret, nextStep * 30_000, factor.params),
    });
    assert.equal(replacement.status, 'PENDING');
    assert.notEqual(replacement.factorId, factor.factorId);
    const rows = await factorRows();
    assert.equal(rows.find((doc) => doc.id === factor.factorId)!.status, 'REPLACED');
  });

  it('RECOVERY cannot be used to bypass MFA: it yields only a PENDING factor', async () => {
    const factor = await enrolledFactor('prin-s5-recover', 'recover');
    // A wrong recovery token is refused.
    await assert.rejects(
      mfa.recover({
        tenantId: TENANT,
        principalId: 'prin-s5-recover',
        actorPrincipalId: ACTOR,
        factorId: factor.factorId,
        recoveryAuthorizationToken: 'wrong-token',
        validateRecoveryToken: async (token) => token === 'good-token',
      }),
      (error: unknown) => code(error) === 'MFA_RECOVERY_NOT_ELIGIBLE',
    );
    // The old factor survives a failed recovery.
    let rows = await factorRows();
    assert.equal(rows.find((doc) => doc.id === factor.factorId)!.status, 'ACTIVE');
    // A valid token revokes the old factor and issues a REPLACEMENT — but only
    // a PENDING one. Recovery alone therefore grants NO assurance: until the
    // replacement is activated with a real code, the principal has no MFA and
    // cannot satisfy any step-up requirement.
    const replacement = await mfa.recover({
      tenantId: TENANT,
      principalId: 'prin-s5-recover',
      actorPrincipalId: ACTOR,
      factorId: factor.factorId,
      recoveryAuthorizationToken: 'good-token',
      validateRecoveryToken: async (token) => token === 'good-token',
    });
    assert.equal(replacement.status, 'PENDING');
    rows = await factorRows();
    assert.equal(rows.find((doc) => doc.id === factor.factorId)!.status, 'REVOKED');
    assert.equal(await mfa.hasActiveFactor({ tenantId: TENANT, principalId: 'prin-s5-recover', actorPrincipalId: ACTOR }), false);
  });

  // -------------------------------------------------------------------------
  // Audit + secret non-disclosure
  // -------------------------------------------------------------------------

  it('the required audit vocabulary is recorded, and refusals are audited too', async () => {
    const tag = `audit-${Date.now()}`;
    const enrolled = await mfa.enroll({ tenantId: TENANT, principalId: `prin-${tag}`, actorPrincipalId: ACTOR, correlationId: `corr-${tag}` });
    await mfa.activate({
      tenantId: TENANT,
      principalId: `prin-${tag}`,
      actorPrincipalId: ACTOR,
      factorId: enrolled.factorId,
      code: totpAt(base32Decode(enrolled.sharedSecretBase32), Date.now(), enrolled.params),
      correlationId: `corr-${tag}`,
    });
    const rows = await events(`corr-${tag}`);
    const kinds = new Set(rows.map((row) => row.kind));
    for (const required of ['ENROLLMENT_ATTEMPTED', 'ENROLLMENT_SUCCEEDED', 'ACTIVATION_SUCCEEDED']) {
      assert.ok(kinds.has(required as never), `audit vocabulary includes ${required}`);
    }
    // Every row carries actor, tenant, principal, correlation and timestamp.
    for (const row of rows) {
      assert.ok(row.actorPrincipalId.length > 0, 'actor recorded');
      assert.equal(row.tenantId, TENANT);
      assert.ok(row.principalId.length > 0, 'principal recorded');
      assert.ok(row.correlationId.length > 0, 'correlation recorded');
      assert.ok(Number.isFinite(row.at) && row.at > 0, 'timestamp recorded');
    }
  });

  it('NO audit record, factor row, or error message ever contains the TOTP secret', async () => {
    const factor = await enrolledFactor('prin-s5-nondisclosure', 'nondisclosure');
    const secretB32 = factor.sharedSecretBase32;
    const secretHex = Buffer.from(factor.secret).toString('hex');

    const audit = await allEvents();
    for (const row of audit) {
      const serialized = JSON.stringify(row);
      assert.ok(!serialized.includes(secretB32), 'no base32 secret in audit');
      assert.ok(!serialized.includes(secretHex), 'no hex secret in audit');
    }
    const rows = await factorRows();
    for (const row of rows) {
      const serialized = JSON.stringify(row);
      assert.ok(!serialized.includes(secretB32), 'no base32 secret in factor rows');
      assert.ok(!serialized.includes(secretHex), 'no hex secret in factor rows');
    }
    // A refusal must not echo the secret either.
    try {
      await mfa.verify({
        tenantId: TENANT,
        principalId: OTHER_PRINCIPAL,
        actorPrincipalId: ACTOR,
        factorId: factor.factorId,
        code: '000000',
      });
      assert.fail('expected a refusal');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!message.includes(secretB32), 'no secret in the error message');
      assert.ok(!message.includes(secretHex), 'no secret in the error message');
      assert.ok(!message.includes(OTHER_TENANT), 'no tenant in the error message');
    }
  });

  it('MFA verification is an ASSURANCE signal, not an authorization decision', async () => {
    // S5 exposes assurance; it never decides. This asserts the module surface
    // has no authorization engine to misuse: no policy, no role, no grant.
    const surface = Object.getOwnPropertyNames(MfaFactorStore.prototype);
    for (const forbidden of ['authorize', 'grant', 'decide', 'evaluatePolicy', 'assignRole']) {
      assert.ok(!surface.includes(forbidden), `MfaFactorStore exposes no '${forbidden}' — it does not authorize`);
    }
    // And a satisfied verification returns an assurance id, not a permission.
    const factor = await enrolledFactor('prin-s5-notauthz', 'notauthz');
    const result = await mfa.verify({
      tenantId: TENANT,
      principalId: 'prin-s5-notauthz',
      actorPrincipalId: ACTOR,
      factorId: factor.factorId,
      code: totpAt(factor.secret, Date.now(), factor.params),
    });
    assert.deepEqual(
      Object.keys(result).sort(),
      ['assuranceId', 'factorId', 'level', 'satisfiedAt'],
      'the result carries assurance facts only — no permission, role, or grant',
    );
  });
});
