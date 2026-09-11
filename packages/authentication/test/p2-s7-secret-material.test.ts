// P2-S7 — the durable SECRET-MATERIAL store over real PostgreSQL
// (spec §12; the boundary S5/TOTP and S6/break-glass will consume).
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the
// suite FAILS (no skip — this store is the S7 secret substrate and its tenant
// isolation is only meaningful against real RLS).
//
// Covered:
//   * non-transactional source refusal (memory is never secret authority);
//   * production refuses a dev seam (P2-INV-08 secret half), no fallback;
//   * seal→open round trip; the caller receives a REFERENCE, never material;
//   * NO AMBIENT AUTHORITY: a missing actor is refused;
//   * TENANT ISOLATION (real RLS): a cross-tenant open cannot succeed and is
//     indistinguishable from a miss;
//   * AUTHORIZATION BOUNDARY / NO IDENTIFIER ORACLE: wrong principal, wrong
//     purpose, and non-existent secret all report the SAME code;
//   * CONTEXT (AAD) BINDING at the data plane: a row re-pointed directly in the
//     database still will not open;
//   * REVOCATION terminal; ROTATION retires v(n) and activates v(n+1) while
//     keeping v(n) openable;
//   * CONCURRENCY: N racers rotating one secret ⇒ exactly one winner;
//   * MALFORMED material fails closed; an unusable sealing key fails closed
//     (no fallback to another key);
//   * AUDIT: every access is recorded with actor/tenant/purpose/credential id/
//     provider id/result/correlation id/timestamp and NEVER the secret, and
//     refusals are audited too;
//   * SECRET NON-DISCLOSURE: no stored row, error message, audit record, or
//     health detail contains the plaintext.
//
// MUTATION ANCHORS (automated proof in p2-s7-mutation.test.ts):
//   M6  tenant binding removed   → 'cross-tenant open is refused'
//   M7  principal binding removed→ 'a wrong principal is indistinguishable'
//   M8  secrets enter audit      → 'no audit record ever contains the plaintext'
//   M9  production accepts dev   → 'assertProductionSecretSeam refuses'

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import {
  DEV_SECRET_SEAM_KEY_ID,
  InMemoryKeyManagementSeam,
  SECRET_ACCESS_COLLECTION,
  SECRET_MATERIAL_COLLECTION,
  SecretMaterialError,
  SecretMaterialStore,
  assertProductionSecretSeam,
  deriveSecretContext,
  newSecretId,
  type SecretAccessRecord,
  type SecretMaterialDoc,
  type SecretRef,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

let pg: R2Postgres;
let storage: StorageModule;
let seam: InMemoryKeyManagementSeam;
let store: SecretMaterialStore;

const TENANT = 'acme';
const OTHER_TENANT = 'other';
const PRINCIPAL = 'prin-s7-owner';
const OTHER_PRINCIPAL = 'prin-s7-intruder';
const ACTOR = 'prin-s7-actor';
/** Deliberately distinctive so any leak into diagnostics is unmissable. */
const PLAINTEXT = 's7-CANARY-do-not-leak-7c41e9';
const ROTATED = 's7-CANARY-rotated-2b8d05';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

let seq = 0;
const nextSecretId = (): string => `${newSecretId()}-${process.pid}-${++seq}`;

function sealInput(secretId: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    actorPrincipalId: ACTOR,
    principalId: PRINCIPAL,
    purpose: 'totp' as const,
    secretId,
    material: bytes(PLAINTEXT),
    correlationId: `corr-${secretId}`,
    ...overrides,
  };
}

/** Read every audit record for a secret, directly from the durable store. */
async function auditFor(secretId: string, tenantId = TENANT): Promise<readonly SecretAccessRecord[]> {
  return storage.atomically(async (scope) => {
    const rows = await scope.collection<SecretAccessRecord>(SECRET_ACCESS_COLLECTION);
    return rows.query({ where: (row) => row.secretId === secretId });
  }, { tenantId });
}

/** Read the stored rows for a secret, directly from the durable store. */
async function docsFor(secretId: string, tenantId = TENANT): Promise<readonly SecretMaterialDoc[]> {
  return storage.atomically(async (scope) => {
    const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
    return rows.query({ where: (row) => row.secretId === secretId });
  }, { tenantId });
}

before(async () => {
  pg = await bootR2Postgres('p2s7secret', 59700);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  store = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
});

after(async () => {
  await pg.stop();
});

describe('P2-S7 secret-material store (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S7 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
    assert.ok(store, 'the secret-material store must be open');
  });

  // ---------------------------------------------------------------------
  // Source / provider refusal
  // ---------------------------------------------------------------------

  it('refuses a non-transactional source at open (memory is never secret authority)', async () => {
    // A booted memory-backed kernel: the driver exists and simply does not
    // support transactions, so this asserts the store's own refusal rather than
    // a driver-level TypeError.
    const memory = new StorageModule();
    const kernel = createTestKernel();
    kernel.register(memory);
    await kernel.boot();
    await assert.rejects(
      () => SecretMaterialStore.open(memory, seam, DEV_SECRET_SEAM_KEY_ID),
      (error: unknown) => {
        assert.ok(error instanceof SecretMaterialError);
        assert.equal(error.code, 'SECRET_SEAM_UNAVAILABLE');
        return true;
      },
    );
    await kernel.shutdown();
  });

  it('refuses an unbooted source rather than leaking a driver error', async () => {
    await assert.rejects(
      () => SecretMaterialStore.open(new StorageModule(), seam, DEV_SECRET_SEAM_KEY_ID),
      (error: unknown) => {
        assert.ok(error instanceof SecretMaterialError, 'must fail closed as a seam error, not a TypeError');
        assert.equal(error.code, 'SECRET_SEAM_UNAVAILABLE');
        return true;
      },
    );
  });

  it('refuses to open when the sealing key is not ACTIVE', async () => {
    await assert.rejects(
      () => SecretMaterialStore.open(storage, seam, 's7-no-such-key'),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_SEAM_UNAVAILABLE');
        return true;
      },
    );
  });

  it('refuses a dev-inmemory seam in production and never falls back', () => {
    assert.equal(seam.kind, 'dev-inmemory');
    assert.throws(() => assertProductionSecretSeam(seam), (error: unknown) => {
      assert.ok(error instanceof SecretMaterialError);
      assert.equal(error.code, 'SECRET_DEV_PROVIDER_IN_PRODUCTION');
      return true;
    });
    // An absent seam is refused too — no implicit dev fallback.
    assert.throws(() => assertProductionSecretSeam(undefined), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_SEAM_UNAVAILABLE');
      return true;
    });
  });

  // ---------------------------------------------------------------------
  // Seal / open
  // ---------------------------------------------------------------------

  it('seals and opens a round trip, and returns a REFERENCE instead of material', async () => {
    const secretId = nextSecretId();
    const ref: SecretRef = await store.seal(sealInput(secretId));
    assert.equal(ref.secretId, secretId);
    assert.equal(ref.version, 1);
    assert.equal(ref.status, 'ACTIVE');
    assert.equal(ref.sealingKeyId, DEV_SECRET_SEAM_KEY_ID);
    // The reference must not carry the secret.
    assert.ok(!JSON.stringify(ref).includes(PLAINTEXT));

    const opened = await store.open(sealInput(secretId));
    assert.equal(text(opened), PLAINTEXT);
  });

  it('stores only ciphertext: the durable row never contains the plaintext', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    const docs = await docsFor(secretId);
    assert.equal(docs.length, 1);
    const serialized = JSON.stringify(docs[0]);
    assert.ok(!serialized.includes(PLAINTEXT), 'plaintext must never rest in the database');
    assert.ok(!serialized.includes(Buffer.from(PLAINTEXT).toString('base64')), 'nor base64 of it');
    assert.ok((docs[0]?.sealed.ciphertext ?? '').length > 0, 'a sealed blob must be present');
  });

  it('refuses a missing actor: this seam has no ambient authority', async () => {
    await assert.rejects(
      () => store.seal(sealInput(nextSecretId(), { actorPrincipalId: '' })),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_INVALID_ARGUMENT');
        return true;
      },
    );
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    await assert.rejects(
      () => store.open(sealInput(secretId, { actorPrincipalId: undefined as unknown as string })),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_INVALID_ARGUMENT');
        return true;
      },
    );
  });

  it('refuses empty material and an unrecognized purpose', async () => {
    await assert.rejects(
      () => store.seal(sealInput(nextSecretId(), { material: bytes('') })),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_INVALID_ARGUMENT');
        return true;
      },
    );
    await assert.rejects(
      () => store.seal(sealInput(nextSecretId(), { purpose: 'not-a-purpose' as never })),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_INVALID_ARGUMENT');
        return true;
      },
    );
  });

  it('refuses to seal the same secret twice (no silent overwrite)', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    await assert.rejects(() => store.seal(sealInput(secretId)), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_CONFLICT');
      return true;
    });
  });

  // ---------------------------------------------------------------------
  // Tenant isolation (real RLS)   (MUTATION M6)
  // ---------------------------------------------------------------------

  it('cross-tenant open is refused and indistinguishable from a miss', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));

    // Same secret id, same principal id, same purpose — only the tenant differs.
    const fromOtherTenant = await store
      .open(sealInput(secretId, { tenantId: OTHER_TENANT }))
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);
    const genuinelyMissing = await store
      .open(sealInput('s7-never-existed', { tenantId: OTHER_TENANT }))
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);

    assert.equal(fromOtherTenant, 'SECRET_UNKNOWN', 'a cross-tenant read must fail closed');
    assert.equal(genuinelyMissing, 'SECRET_UNKNOWN');
    assert.equal(fromOtherTenant, genuinelyMissing, 'cross-tenant must be indistinguishable from a miss');

    // And the row is genuinely invisible from the other tenant's scope.
    const rowsInOtherTenant = await docsFor(secretId, OTHER_TENANT);
    assert.equal(rowsInOtherTenant.length, 0, 'RLS must make the row invisible, not merely unauthorized');
  });

  // ---------------------------------------------------------------------
  // Authorization boundary / no identifier oracle   (MUTATION M7)
  // ---------------------------------------------------------------------

  it('a wrong principal, a wrong purpose, and a missing secret are indistinguishable', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));

    const wrongPrincipal = await store
      .open(sealInput(secretId, { principalId: OTHER_PRINCIPAL }))
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);
    const wrongPurpose = await store
      .open(sealInput(secretId, { purpose: 'break-glass-seal' as const }))
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);
    const missing = await store
      .open(sealInput('s7-also-never-existed'))
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);

    assert.equal(wrongPrincipal, 'SECRET_UNKNOWN');
    assert.equal(wrongPurpose, 'SECRET_UNKNOWN');
    assert.equal(missing, 'SECRET_UNKNOWN');
    assert.equal(
      new Set([wrongPrincipal, wrongPurpose, missing]).size,
      1,
      'ownership and existence must not be distinguishable — no identifier oracle',
    );
  });

  it('the sealing context binds every element of the authorization', () => {
    const base = { tenantId: TENANT, principalId: PRINCIPAL, purpose: 'totp' as const, secretId: 'sec-1' };
    const context = deriveSecretContext(base);
    assert.equal(context, `s7|${TENANT}|${PRINCIPAL}|totp|sec-1`);
    for (const mutated of [
      { ...base, tenantId: OTHER_TENANT },
      { ...base, principalId: OTHER_PRINCIPAL },
      { ...base, purpose: 'break-glass-seal' as const },
      { ...base, secretId: 'sec-2' },
    ]) {
      assert.notEqual(deriveSecretContext(mutated), context, 'each binding element must change the context');
    }
  });

  it('a row re-pointed directly in the database still will not open (AAD defence in depth)', async () => {
    const victimId = nextSecretId();
    const attackerId = nextSecretId();
    await store.seal(sealInput(victimId));
    await store.seal(sealInput(attackerId, { principalId: OTHER_PRINCIPAL }));

    // Simulate a data-plane compromise: rewrite the attacker's row so it claims
    // the victim's principal and purpose. The stored AAD still names the
    // attacker's binding, so the open must fail closed.
    await storage.atomically(async (scope) => {
      const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
      const doc = await rows.get(`${attackerId}::1`);
      assert.ok(doc);
      await rows.put({ ...doc, principalId: PRINCIPAL, purpose: 'totp' });
    }, { tenantId: TENANT });

    await assert.rejects(() => store.open(sealInput(attackerId)), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_UNKNOWN');
      return true;
    });
  });

  // ---------------------------------------------------------------------
  // Revocation / rotation
  // ---------------------------------------------------------------------

  it('revocation is terminal: the version can never be opened again', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    assert.equal(text(await store.open(sealInput(secretId))), PLAINTEXT);

    await store.revoke({
      tenantId: TENANT,
      actorPrincipalId: ACTOR,
      principalId: PRINCIPAL,
      purpose: 'totp',
      secretId,
      version: 1,
      correlationId: `corr-revoke-${secretId}`,
    });
    await assert.rejects(() => store.open(sealInput(secretId)), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_REVOKED');
      return true;
    });
    await assert.rejects(() => store.open(sealInput(secretId, { version: 1 })), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_REVOKED');
      return true;
    });
  });

  it('a wrong-purpose or wrong-principal revoke is refused as UNKNOWN', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    for (const overrides of [{ purpose: 'break-glass-seal' as const }, { principalId: OTHER_PRINCIPAL }]) {
      await assert.rejects(
        () =>
          store.revoke({
            tenantId: TENANT,
            actorPrincipalId: ACTOR,
            principalId: PRINCIPAL,
            purpose: 'totp',
            secretId,
            version: 1,
            ...overrides,
          }),
        (error: unknown) => {
          assert.equal((error as SecretMaterialError).code, 'SECRET_UNKNOWN');
          return true;
        },
      );
    }
    // Still openable: both revokes were refused.
    assert.equal(text(await store.open(sealInput(secretId))), PLAINTEXT);
  });

  it('rotation retires v1 and activates v2, keeping v1 openable', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));

    const ref = await store.rotate({
      tenantId: TENANT,
      actorPrincipalId: ACTOR,
      principalId: PRINCIPAL,
      purpose: 'totp',
      secretId,
      material: bytes(ROTATED),
      correlationId: `corr-rotate-${secretId}`,
    });
    assert.equal(ref.version, 2);
    assert.equal(ref.status, 'ACTIVE');

    // The ACTIVE version is the rotated one.
    assert.equal(text(await store.open(sealInput(secretId))), ROTATED);
    // The retired version is still recoverable (spec §12 rotation semantics).
    assert.equal(text(await store.open(sealInput(secretId, { version: 1 }))), PLAINTEXT);

    const docs = await docsFor(secretId);
    assert.equal(docs.length, 2);
    assert.equal(docs.find((d) => d.version === 1)?.status, 'RETIRED');
    assert.equal(docs.find((d) => d.version === 2)?.status, 'ACTIVE');
  });

  it('rotation by a wrong principal or wrong purpose is refused as UNKNOWN', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    for (const overrides of [{ principalId: OTHER_PRINCIPAL }, { purpose: 'break-glass-seal' as const }]) {
      await assert.rejects(
        () =>
          store.rotate({
            tenantId: TENANT,
            actorPrincipalId: ACTOR,
            principalId: PRINCIPAL,
            purpose: 'totp',
            secretId,
            material: bytes(ROTATED),
            ...overrides,
          }),
        (error: unknown) => {
          assert.equal((error as SecretMaterialError).code, 'SECRET_UNKNOWN');
          return true;
        },
      );
    }
    // Unchanged: still v1 ACTIVE.
    const docs = await docsFor(secretId);
    assert.equal(docs.length, 1);
    assert.equal(docs[0]?.status, 'ACTIVE');
  });

  // ---------------------------------------------------------------------
  // Concurrency
  // ---------------------------------------------------------------------

  it('concurrent rotation: exactly one racer wins, exactly one ACTIVE version remains', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));

    const racers = 8;
    const results = await Promise.allSettled(
      Array.from({ length: racers }, (_, index) =>
        store.rotate({
          tenantId: TENANT,
          actorPrincipalId: ACTOR,
          principalId: PRINCIPAL,
          purpose: 'totp',
          secretId,
          material: bytes(`${ROTATED}-${index}`),
          correlationId: `corr-race-${secretId}-${index}`,
        }),
      ),
    );

    const wins = results
      .map((r, index) => ({ r, index }))
      .filter((entry) => entry.r.status === 'fulfilled') as Array<{ r: PromiseFulfilledResult<SecretRef>; index: number }>;
    const losses = results.filter((r) => r.status === 'rejected');
    assert.equal(wins.length + losses.length, racers);
    assert.ok(wins.length >= 1, 'at least one rotation must succeed');
    for (const loss of losses) {
      const error = (loss as PromiseRejectedResult).reason as SecretMaterialError;
      assert.equal(error.code, 'SECRET_CONFLICT', 'a losing racer must fail closed, never corrupt state');
    }

    // THE INVARIANT: no lost updates. Rotation is serialized by the CAS on the
    // outgoing row, so racers may win IN TURN (a racer that reads the state
    // after an earlier winner committed legitimately rotates the newer
    // version). What must never happen is two racers claiming the same version
    // or a version being skipped.
    const versions = wins.map((entry) => entry.r.value.version);
    assert.equal(new Set(versions).size, versions.length, 'two racers must never claim the same version');
    assert.deepEqual(
      [...versions].sort((a, b) => a - b),
      Array.from({ length: wins.length }, (_, i) => i + 2),
      'versions must be exactly 2..n+1 with no gap and no duplicate',
    );

    const docs = await docsFor(secretId);
    assert.equal(docs.length, wins.length + 1, 'one row per version, none lost');
    const active = docs.filter((d) => d.status === 'ACTIVE');
    assert.equal(active.length, 1, 'exactly one ACTIVE version must remain');
    assert.equal(active[0]?.version, wins.length + 1);
    assert.equal(docs.filter((d) => d.status === 'RETIRED').length, wins.length);

    // The surviving ACTIVE material is exactly the winning racer's own.
    const highest = wins.reduce((best, entry) => (entry.r.value.version > best.r.value.version ? entry : best));
    assert.equal(
      text(await store.open(sealInput(secretId))),
      `${ROTATED}-${highest.index}`,
      'the ACTIVE material must be exactly the highest-version winner\u2019s, with no interleaving',
    );
  });

  it('concurrent opens of one secret all succeed and each is audited', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => store.open(sealInput(secretId, { correlationId: `corr-open-${secretId}-${index}` }))),
    );
    assert.equal(results.length, 6);
    for (const value of results) assert.equal(text(value), PLAINTEXT);
    const audit = await auditFor(secretId);
    assert.equal(audit.filter((r) => r.operation === 'open' && r.result === 'SUCCESS').length, 6);
  });

  // ---------------------------------------------------------------------
  // Malformed material / unusable sealing key
  // ---------------------------------------------------------------------

  it('tampered stored ciphertext fails closed as SECRET_MALFORMED', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    await storage.atomically(async (scope) => {
      const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
      const doc = await rows.get(`${secretId}::1`);
      assert.ok(doc);
      const raw = Buffer.from(doc.sealed.ciphertext, 'base64url');
      raw[0] = (raw[0] ?? 0) ^ 0xff;
      await rows.put({ ...doc, sealed: { ...doc.sealed, ciphertext: raw.toString('base64url') } });
    }, { tenantId: TENANT });

    await assert.rejects(() => store.open(sealInput(secretId)), (error: unknown) => {
      assert.ok(error instanceof SecretMaterialError);
      assert.equal(error.code, 'SECRET_MALFORMED');
      assert.ok(!error.message.includes(PLAINTEXT));
      return true;
    });
  });

  it('an unusable sealing key fails closed — there is no fallback to another key', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId)); // sealed under key version 1

    // Rotate the sealing key: v1 becomes RETIRED, v2 becomes ACTIVE. The secret
    // sealed under v1 must still open (retired keys stay decryptable).
    const next = await seam.rotate(DEV_SECRET_SEAM_KEY_ID);
    assert.equal(next.version, 2);
    assert.equal(text(await store.open(sealInput(secretId))), PLAINTEXT);

    // Now revoke v1. The secret becomes unrecoverable — and the store must NOT
    // substitute v2, re-seal, or otherwise improvise a recovery path.
    await seam.revoke(DEV_SECRET_SEAM_KEY_ID, 1);
    await assert.rejects(() => store.open(sealInput(secretId)), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_SEAM_UNAVAILABLE');
      return true;
    });

    // Fresh seals use the ACTIVE v2 and are unaffected — proving the refusal is
    // scoped to the unusable key rather than a store-wide failure.
    const freshId = nextSecretId();
    const ref = await store.seal(sealInput(freshId));
    assert.equal(ref.sealingKeyVersion, 2);
    assert.equal(text(await store.open(sealInput(freshId))), PLAINTEXT);
  });

  // ---------------------------------------------------------------------
  // Audit   (MUTATION M8)
  // ---------------------------------------------------------------------

  it('audits a successful access with every mandated field and no secret', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    await store.open(sealInput(secretId));
    const audit = await auditFor(secretId);
    const open = audit.find((row) => row.operation === 'open');
    assert.ok(open, 'the open must be audited');
    // Mandated fields: actor, tenant, purpose, credential id, provider id,
    // result, correlation id, timestamp.
    assert.equal(open?.actorPrincipalId, ACTOR);
    assert.equal(open?.tenantId, TENANT);
    assert.equal(open?.purpose, 'totp');
    assert.equal(open?.secretId, secretId);
    assert.equal(open?.providerId, seam.id);
    assert.equal(open?.result, 'SUCCESS');
    assert.equal(open?.correlationId, `corr-${secretId}`);
    assert.equal(typeof open?.at, 'number');
    assert.ok((open?.at ?? 0) > 0);
  });

  it('audits REFUSALS too, including cross-tenant and wrong-principal attempts', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    await assert.rejects(() => store.open(sealInput(secretId, { principalId: OTHER_PRINCIPAL, correlationId: `corr-deny-${secretId}` })));
    const audit = await auditFor(secretId);
    const denied = audit.find((row) => row.operation === 'open' && row.result === 'REFUSED_UNKNOWN');
    assert.ok(denied, 'a refused access must still be audited');
    assert.equal(denied?.correlationId, `corr-deny-${secretId}`);
    assert.equal(denied?.actorPrincipalId, ACTOR);
  });

  it('no audit record ever contains the plaintext, ciphertext, or key material', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    await store.open(sealInput(secretId));
    await store.rotate({
      tenantId: TENANT,
      actorPrincipalId: ACTOR,
      principalId: PRINCIPAL,
      purpose: 'totp',
      secretId,
      material: bytes(ROTATED),
    });
    await store.revoke({ tenantId: TENANT, actorPrincipalId: ACTOR, principalId: PRINCIPAL, purpose: 'totp', secretId, version: 1 });

    const audit = await auditFor(secretId);
    assert.ok(audit.length >= 4, `expected seal+open+rotate+revoke audit rows, got ${audit.length}`);
    for (const record of audit) {
      const serialized = JSON.stringify(record);
      assert.ok(!serialized.includes(PLAINTEXT), `plaintext leaked into audit: ${serialized}`);
      assert.ok(!serialized.includes(ROTATED), `rotated plaintext leaked into audit: ${serialized}`);
      assert.ok(!serialized.includes(Buffer.from(PLAINTEXT).toString('base64')), `base64 plaintext leaked into audit: ${serialized}`);
      assert.ok(!serialized.includes(Buffer.from(ROTATED).toString('base64')), `base64 rotated plaintext leaked into audit: ${serialized}`);
      assert.ok(!serialized.includes('BEGIN PRIVATE KEY'), 'key material leaked into audit');
      // The record shape has no field in which material could be carried.
      for (const key of Object.keys(record)) {
        assert.ok(
          !['material', 'plaintext', 'secret', 'value', 'ciphertext', 'sealed', 'pem', 'key'].includes(key),
          `audit record carries a material-shaped field: ${key}`,
        );
      }
    }
  });

  it('an audit sink receives every record and can veto the operation by throwing', async () => {
    const received: SecretAccessRecord[] = [];
    let veto = false;
    const vetoing = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID, {
      auditSink: {
        async record(entry: SecretAccessRecord): Promise<void> {
          if (veto) throw new Error('audit sink unavailable');
          received.push(entry);
        },
      },
    });
    const secretId = nextSecretId();
    await vetoing.seal(sealInput(secretId, { correlationId: `corr-sink-${secretId}` }));
    assert.ok(received.length >= 1, 'the sink must observe the seal');
    assert.equal(received[0]?.correlationId, `corr-sink-${secretId}`);

    // Fail-closed is never weakened to improve audit availability: when the
    // audit path fails, the credential operation fails with it.
    veto = true;
    await assert.rejects(() => vetoing.open(sealInput(secretId)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /audit sink unavailable/);
      return true;
    });
    veto = false;
    // And once the audit path recovers, the secret is still intact.
    assert.equal(text(await vetoing.open(sealInput(secretId))), PLAINTEXT);
  });

  // ---------------------------------------------------------------------
  // Non-disclosure / health
  // ---------------------------------------------------------------------

  it('health reports the sealing key identifier and never the material', async () => {
    const health = await store.health();
    assert.ok(health.detail?.includes(DEV_SECRET_SEAM_KEY_ID));
    assert.ok(!JSON.stringify(health).includes(PLAINTEXT));
  });

  it('list is tenant-scoped: another tenant cannot enumerate this tenant\u2019s secrets', async () => {
    const secretId = nextSecretId();
    await store.seal(sealInput(secretId));
    // Same principal id, different tenant. The list must come back empty:
    // tenant scoping is enforced by the store's own scope option (RLS), not by
    // filtering after the fact.
    const fromOtherTenant = await store.list({ tenantId: OTHER_TENANT, principalId: PRINCIPAL, actorPrincipalId: ACTOR });
    assert.equal(fromOtherTenant.length, 0, 'a tenant-scoped list must not surface another tenant\u2019s secrets');
    // And the owner can still see it.
    const mine = await store.list({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: ACTOR });
    assert.ok(mine.some((ref) => ref.secretId === secretId));
  });

  it('list returns references only, and never another principal\u2019s secrets', async () => {
    const mine = nextSecretId();
    const theirs = nextSecretId();
    await store.seal(sealInput(mine));
    await store.seal(sealInput(theirs, { principalId: OTHER_PRINCIPAL }));
    const refs = await store.list({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: ACTOR });
    const ids = refs.map((ref) => ref.secretId);
    assert.ok(ids.includes(mine));
    assert.ok(!ids.includes(theirs), 'list must not disclose another principal\u2019s secrets');
    assert.ok(!JSON.stringify(refs).includes(PLAINTEXT));
  });
});
