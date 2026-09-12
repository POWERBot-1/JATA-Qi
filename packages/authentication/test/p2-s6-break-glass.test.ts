// P2-S6 — Break-Glass + Administrative Controls, over real PostgreSQL.
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the
// suite FAILS. No skip.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import {
  BreakGlassError,
  BreakGlassStore,
  DEFAULT_BREAK_GLASS_LIFETIME_MS,
  DEV_SECRET_SEAM_KEY_ID,
  IDENTITY_EVENTS_COLLECTION,
  InMemoryKeyManagementSeam,
  MAX_BREAK_GLASS_LIFETIME_MS,
  MfaFactorStore,
  PrivilegeStore,
  PrivilegeStoreError,
  SecretMaterialStore,
  totpAt,
  type IdentityEventDoc,
  type MfaFactorStore as MfaStore,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import { base32Decode } from '../src/mfa.js';

let pg: R2Postgres;
let storage: StorageModule;
let secrets: SecretMaterialStore;
let mfa: MfaStore;
let privileges: PrivilegeStore;
let bg: BreakGlassStore;

const TENANT = 'acme';
const OTHER = 'other';
const PRINCIPAL = 'prin-s6-op';
const ACTOR = PRINCIPAL;
const SESSION = 'sess-s6-a';

const code = (err: unknown): string =>
  err instanceof BreakGlassError ? err.code : err instanceof PrivilegeStoreError ? err.code : `OTHER:${String(err)}`;

async function enrolledStepUp(principalId: string, tag: string) {
  const enrolled = await mfa.enroll({ tenantId: TENANT, principalId, actorPrincipalId: ACTOR, correlationId: tag });
  const secret = base32Decode(enrolled.sharedSecretBase32);
  await mfa.activate({
    tenantId: TENANT,
    principalId,
    actorPrincipalId: ACTOR,
    factorId: enrolled.factorId,
    code: totpAt(secret, Date.now(), enrolled.params),
    correlationId: tag,
  });
  const verified = await mfa.verify({
    tenantId: TENANT,
    principalId,
    actorPrincipalId: ACTOR,
    factorId: enrolled.factorId,
    code: totpAt(secret, Date.now() + 30_000, enrolled.params),
    sessionId: SESSION,
    level: 'step-up',
    correlationId: tag,
  });
  return { ...verified, secret, factorId: enrolled.factorId };
}

before(async () => {
  pg = await bootR2Postgres('p2s6bg', 59800);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  mfa = await MfaFactorStore.open(storage, secrets);
  privileges = await PrivilegeStore.open(storage, { stepUpVerifier: mfa, strictStepUp: true });
  bg = await BreakGlassStore.open(storage, secrets, mfa, privileges);
});

after(async () => {
  await pg.stop();
});

describe('P2-S6 break-glass (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg);
  });

  it('open() fails closed without S5 or S7 seams', async () => {
    await assert.rejects(
      BreakGlassStore.open(storage, undefined as never, mfa, privileges),
      (e: unknown) => code(e) === 'BG_SEAM_UNAVAILABLE',
    );
    await assert.rejects(
      BreakGlassStore.open(storage, secrets, undefined as never, privileges),
      (e: unknown) => code(e) === 'BG_SEAM_UNAVAILABLE',
    );
  });

  it('A-12d: activation without a reason is refused', async () => {
    const step = await enrolledStepUp('prin-s6-noreason', 'noreason');
    await assert.rejects(
      bg.activate({
        principalId: 'prin-s6-noreason',
        tenantId: TENANT,
        scope: 'tenant',
        operationClasses: ['operator'],
        sessionEventId: SESSION,
        stepUpEventId: step.assuranceId,
        stepUpAt: step.satisfiedAt,
        reason: '   ',
        actorPrincipalId: 'prin-s6-noreason',
      }),
      (e: unknown) => code(e) === 'BG_REASON_REQUIRED',
    );
  });

  it('activation without valid S5 step-up is refused (self-asserted evidence)', async () => {
    await assert.rejects(
      bg.activate({
        principalId: PRINCIPAL,
        tenantId: TENANT,
        scope: 'tenant',
        operationClasses: ['operator'],
        sessionEventId: SESSION,
        stepUpEventId: 'kernel:bootstrap',
        stepUpAt: Date.now(),
        reason: 'emergency',
        actorPrincipalId: PRINCIPAL,
      }),
      (e: unknown) => code(e) === 'BG_STEP_UP_UNVERIFIED',
    );
  });

  it('happy path: activate, assertActive, durable PRIVILEGE_BREAKGLASS_ACTIVATED', async () => {
    const step = await enrolledStepUp('prin-s6-ok', 'ok');
    const doc = await bg.activate({
      principalId: 'prin-s6-ok',
      tenantId: TENANT,
      scope: 'tenant',
      operationClasses: ['operator'],
      sessionEventId: SESSION,
      stepUpEventId: step.assuranceId,
      stepUpAt: step.satisfiedAt,
      reason: 'pager storm',
      actorPrincipalId: 'prin-s6-ok',
      correlationId: 'corr-s6-ok',
    });
    assert.equal(doc.status, 'ACTIVE');
    assert.equal(doc.reviewRequired, true);
    assert.ok(doc.expiresAt - doc.issuedAt <= DEFAULT_BREAK_GLASS_LIFETIME_MS);
    assert.ok(doc.elevationId);
    const live = await bg.assertActive(doc.id, TENANT, 'tenant');
    assert.equal(live.id, doc.id);
    const events = await storage.atomically(
      async (scope) => {
        const rows = await scope.collection<IdentityEventDoc>(IDENTITY_EVENTS_COLLECTION);
        return rows.query({ where: (row) => row.correlationId === 'corr-s6-ok' });
      },
      { tenantId: TENANT },
    );
    assert.ok(events.some((e) => e.kind === 'PRIVILEGE_BREAKGLASS_ACTIVATED'));
    for (const e of events) {
      const serialized = JSON.stringify(e);
      assert.ok(!serialized.toLowerCase().includes('material'));
    }
  });

  it('A-12a: past-lifetime assertActive denies (deny-early)', async () => {
    const step = await enrolledStepUp('prin-s6-life', 'life');
    const doc = await bg.activate({
      principalId: 'prin-s6-life',
      tenantId: TENANT,
      scope: 'tenant',
      operationClasses: ['operator'],
      sessionEventId: SESSION,
      stepUpEventId: step.assuranceId,
      stepUpAt: step.satisfiedAt,
      reason: 'short window',
      actorPrincipalId: 'prin-s6-life',
      lifetimeMs: 1_000,
    });
    await assert.rejects(
      bg.assertActive(doc.id, TENANT, 'tenant', doc.issuedAt + 1_000 + 301_000),
      (e: unknown) => code(e) === 'BG_EXPIRED',
    );
    await bg.revoke({
      breakGlassId: doc.id,
      tenantId: TENANT,
      scope: 'tenant',
      revokedBy: 'prin-s6-life',
      reason: 'sweep expired canary',
    });
  });

  it('lifetime above 60 min is refused at activation (P2-INV-06 window)', async () => {
    const step = await enrolledStepUp('prin-s6-cap', 'cap');
    await assert.rejects(
      bg.activate({
        principalId: 'prin-s6-cap',
        tenantId: TENANT,
        scope: 'tenant',
        operationClasses: ['operator'],
        sessionEventId: SESSION,
        stepUpEventId: step.assuranceId,
        stepUpAt: step.satisfiedAt,
        reason: 'too long',
        actorPrincipalId: 'prin-s6-cap',
        lifetimeMs: MAX_BREAK_GLASS_LIFETIME_MS + 1,
      }),
      (e: unknown) => code(e) === 'BG_WINDOW_POLICY',
    );
  });

  it('A-12b: reactivate() on a record is refused; a new activate() after revoke mints a new id', async () => {
    const principalId = 'prin-s6-re';
    const enrolled = await mfa.enroll({ tenantId: TENANT, principalId, actorPrincipalId: ACTOR });
    const secret = base32Decode(enrolled.sharedSecretBase32);
    await mfa.activate({
      tenantId: TENANT,
      principalId,
      actorPrincipalId: ACTOR,
      factorId: enrolled.factorId,
      code: totpAt(secret, Date.now(), enrolled.params),
    });
    const firstStep = await mfa.verify({
      tenantId: TENANT,
      principalId,
      actorPrincipalId: ACTOR,
      factorId: enrolled.factorId,
      code: totpAt(secret, Date.now(), enrolled.params),
      sessionId: SESSION,
      level: 'step-up',
    });
    const first = await bg.activate({
      principalId,
      tenantId: TENANT,
      scope: 'tenant',
      operationClasses: ['operator'],
      sessionEventId: SESSION,
      stepUpEventId: firstStep.assuranceId,
      stepUpAt: firstStep.satisfiedAt,
      reason: 'first',
      actorPrincipalId: principalId,
    });
    await assert.throws(() => bg.reactivate(first.id), (e: unknown) => code(e) === 'BG_TERMINAL');
    await bg.revoke({ breakGlassId: first.id, tenantId: TENANT, scope: 'tenant', revokedBy: principalId, reason: 'done' });
    const second = await bg.activate({
      principalId,
      tenantId: TENANT,
      scope: 'tenant',
      operationClasses: ['operator'],
      sessionEventId: SESSION,
      stepUpEventId: firstStep.assuranceId,
      stepUpAt: firstStep.satisfiedAt,
      reason: 'second',
      actorPrincipalId: principalId,
    });
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'ACTIVE');
  });

  it('A-12c: scope cannot expand after activation', () => {
    assert.throws(() => bg.expandScope(), (e: unknown) => code(e) === 'BG_SCOPE_FROZEN');
  });

  it('revocation is server-side and subsequent assertActive fails', async () => {
    const step = await enrolledStepUp('prin-s6-rev', 'rev');
    const doc = await bg.activate({
      principalId: 'prin-s6-rev',
      tenantId: TENANT,
      scope: 'tenant',
      operationClasses: ['security-admin'],
      sessionEventId: SESSION,
      stepUpEventId: step.assuranceId,
      stepUpAt: step.satisfiedAt,
      reason: 'revoke-me',
      actorPrincipalId: 'prin-s6-rev',
    });
    const revoked = await bg.revoke({
      breakGlassId: doc.id,
      tenantId: TENANT,
      scope: 'tenant',
      revokedBy: 'prin-s6-rev',
      reason: 'incident closed',
    });
    assert.equal(revoked.status, 'REVOKED');
    await assert.rejects(bg.assertActive(doc.id, TENANT, 'tenant'), (e: unknown) => code(e) === 'BG_REVOKED');
    const again = await bg.revoke({
      breakGlassId: doc.id,
      tenantId: TENANT,
      scope: 'tenant',
      revokedBy: 'prin-s6-rev',
      reason: 'incident closed',
    });
    assert.equal(again.status, 'REVOKED');
  });

  it('A-23: concurrent activations yield exactly one ACTIVE winner', async () => {
    const principalId = 'prin-s6-race';
    const enrolled = await mfa.enroll({ tenantId: TENANT, principalId, actorPrincipalId: ACTOR });
    const secret = base32Decode(enrolled.sharedSecretBase32);
    await mfa.activate({
      tenantId: TENANT,
      principalId,
      actorPrincipalId: ACTOR,
      factorId: enrolled.factorId,
      code: totpAt(secret, Date.now(), enrolled.params),
    });
    const assurance = await mfa.verify({
      tenantId: TENANT,
      principalId,
      actorPrincipalId: ACTOR,
      factorId: enrolled.factorId,
      code: totpAt(secret, Date.now() + 30_000, enrolled.params),
      sessionId: SESSION,
      level: 'step-up',
    });
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        bg.activate({
          principalId,
          tenantId: TENANT,
          scope: 'tenant',
          operationClasses: ['operator'],
          sessionEventId: SESSION,
          stepUpEventId: assurance.assuranceId,
          stepUpAt: assurance.satisfiedAt,
          reason: 'race',
          actorPrincipalId: principalId,
        }),
      ),
    );
    const wins = attempts.filter((a) => a.status === 'fulfilled');
    const losses = attempts.filter((a) => a.status === 'rejected');
    assert.equal(wins.length, 1, `exactly one winner, got ${wins.length}`);
    assert.equal(losses.length, 7);
    for (const loss of losses) {
      assert.equal(code((loss as PromiseRejectedResult).reason), 'BG_ONE_SHOT');
    }
  });

  it('TENANT isolation: foreign tenant cannot assertActive (RLS)', async () => {
    const step = await enrolledStepUp('prin-s6-iso', 'iso');
    const doc = await bg.activate({
      principalId: 'prin-s6-iso',
      tenantId: TENANT,
      scope: 'tenant',
      operationClasses: ['operator'],
      sessionEventId: SESSION,
      stepUpEventId: step.assuranceId,
      stepUpAt: step.satisfiedAt,
      reason: 'iso',
      actorPrincipalId: 'prin-s6-iso',
    });
    await assert.rejects(bg.assertActive(doc.id, OTHER, 'tenant'), (e: unknown) => code(e) === 'BG_UNKNOWN');
  });

  it('review is append-once; P2-INV-06 holds for live ACTIVE set', async () => {
    const step = await enrolledStepUp('prin-s6-revw', 'revw');
    const doc = await bg.activate({
      principalId: 'prin-s6-revw',
      tenantId: TENANT,
      scope: 'tenant',
      operationClasses: ['operator'],
      sessionEventId: SESSION,
      stepUpEventId: step.assuranceId,
      stepUpAt: step.satisfiedAt,
      reason: 'review me',
      actorPrincipalId: 'prin-s6-revw',
    });
    const reviewed = await bg.review({
      breakGlassId: doc.id,
      tenantId: TENANT,
      scope: 'tenant',
      reviewedBy: 'security-admin',
      decision: 'justified',
    });
    assert.ok(reviewed.reviewedAt);
    await assert.rejects(
      bg.review({
        breakGlassId: doc.id,
        tenantId: TENANT,
        scope: 'tenant',
        reviewedBy: 'security-admin',
        decision: 'again',
      }),
      (e: unknown) => code(e) === 'BG_TERMINAL',
    );
    const inv = await bg.assertNoStandingOrOverlong();
    assert.equal(inv.ok, true);
  });

  it('P2-INV-07 fails closed on overdue unreviewed records', async () => {
    const step = await enrolledStepUp('prin-s6-due', 'due');
    await bg.activate({
      principalId: 'prin-s6-due',
      tenantId: TENANT,
      scope: 'platform',
      operationClasses: ['operator'],
      sessionEventId: SESSION,
      stepUpEventId: step.assuranceId,
      stepUpAt: step.satisfiedAt,
      reason: 'overdue path',
      actorPrincipalId: 'prin-s6-due',
      reviewDeadlineMs: 1,
    });
    await assert.rejects(bg.assertNoOverdueUnreviewed(Date.now() + 400_000), (e: unknown) => code(e) === 'BG_REVIEW_OVERDUE');
  });

  it('standing grantElevation still refuses planeRole break-glass', async () => {
    await assert.rejects(
      privileges.grantElevation(
        {
          principalId: PRINCIPAL,
          tenantId: TENANT,
          scope: 'tenant',
          planeRole: 'break-glass',
          operationClasses: ['operator'],
          sessionEventId: SESSION,
          grantedBy: PRINCIPAL,
          grantorPrincipalId: PRINCIPAL,
          grantorSessionEventId: SESSION,
          reason: 'nope',
        },
        Date.now(),
      ),
      (e: unknown) => code(e) === 'BREAK_GLASS_NOT_AUTHORIZED',
    );
  });

  it('BreakGlassStore does not expose authorize/grant/decide', () => {
    const surface = Object.getOwnPropertyNames(BreakGlassStore.prototype);
    for (const forbidden of ['authorize', 'grant', 'decide', 'evaluatePolicy', 'assignRole']) {
      assert.ok(!surface.includes(forbidden));
    }
  });
});
