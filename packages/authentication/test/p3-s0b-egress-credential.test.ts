// P3-B0 S0b (OD-7) — governed egress-provider credential handle on the S7
// secret-material seam (real PostgreSQL; fail-hard, same posture as S7).
//
// Covered:
//   * CLOSED-SET CONTRACT: `'egress-provider'` is accepted; the recognized set
//     is exactly the four purposes, frozen; unauthorized purposes (near-miss
//     spellings, case variants, empties, non-strings) remain REFUSED;
//   * HANDLE SEMANTICS: issue returns a reference (id/audience/scopes +
//     version/status), NEVER material; malformed handles are refused;
//   * GOVERNED ACCESS: resolution requires the full explicit binding (no
//     ambient authority); cross-tenant / wrong-principal / cross-purpose
//     access all fail closed as SECRET_UNKNOWN, indistinguishable from a
//     miss; an AAD re-pointed row still will not open;
//   * LIFECYCLE: rotation retires the outgoing version and activates
//     version+1 (CAS-serialized: concurrent rotations never share a version);
//     revocation is TERMINAL; a revoked credential id cannot be silently
//     re-issued;
//   * AUDIT / NON-DISCLOSURE: every broker operation is audited with the
//     egress purpose and identifier fields only; no stored row, audit record,
//     handle, or error message ever carries the plaintext;
//   * P2 INVARIANTS PRESERVED: the seam's production guard, its
//     non-transactional-source refusal, and its AAD context derivation are
//     unchanged by this slice.
//
// This suite changes no product behavior outside the slice: the matchers,
// R-17, `isNarrowing`, `ALLOWED_AUDIT_FIELDS`, and every other S7 consumer
// (TOTP, break-glass) run unmodified in their own suites.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import {
  DEV_SECRET_SEAM_KEY_ID,
  InMemoryKeyManagementSeam,
  RECOGNIZED_SECRET_PURPOSES,
  SECRET_ACCESS_COLLECTION,
  SECRET_MATERIAL_COLLECTION,
  SecretMaterialError,
  SecretMaterialStore,
  assertProductionSecretSeam,
  deriveSecretContext,
  isSecretPurpose,
  newSecretId,
  EgressCredentialBroker,
  EGRESS_PROVIDER_PURPOSE,
  isEgressCredentialHandle,
  type EgressCredentialContext,
  type EgressCredentialHandle,
  type SecretAccessRecord,
  type SecretMaterialDoc,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

let pg: R2Postgres;
let storage: StorageModule;
let seam: InMemoryKeyManagementSeam;
let store: SecretMaterialStore;
let broker: EgressCredentialBroker;

const TENANT = 'acme';
const OTHER_TENANT = 'other';
const PRINCIPAL = 'prin-s0b-owner';
const OTHER_PRINCIPAL = 'prin-s0b-intruder';
const ACTOR = 'prin-s0b-actor';
/** Deliberately distinctive so any leak into diagnostics is unmissable. */
const PLAINTEXT = 's0b-CANARY-egress-credential-77aa1f';
const ROTATED = 's0b-CANARY-rotated-31c9e2';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

let seq = 0;
const nextCredentialId = (): string => `${newSecretId()}-${process.pid}-${++seq}`;

const CTX: EgressCredentialContext = { tenantId: TENANT, actorPrincipalId: ACTOR, principalId: PRINCIPAL };

function issueInput(credentialId: string, overrides: Record<string, unknown> = {}) {
  return {
    ...CTX,
    credentialId,
    audience: 'api.openai.com',
    scopes: ['chat.completions'],
    material: bytes(PLAINTEXT),
    correlationId: `corr-${credentialId}`,
    ...overrides,
  };
}

/** Read every audit record for a credential, directly from the durable store. */
async function auditFor(credentialId: string, tenantId = TENANT): Promise<readonly SecretAccessRecord[]> {
  return storage.atomically(async (scope) => {
    const rows = await scope.collection<SecretAccessRecord>(SECRET_ACCESS_COLLECTION);
    return rows.query({ where: (row) => row.secretId === credentialId });
  }, { tenantId });
}

/** Read the stored rows for a credential, directly from the durable store. */
async function docsFor(credentialId: string, tenantId = TENANT): Promise<readonly SecretMaterialDoc[]> {
  return storage.atomically(async (scope) => {
    const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
    return rows.query({ where: (row) => row.secretId === credentialId });
  }, { tenantId });
}

before(async () => {
  pg = await bootR2Postgres('p3s0begr', 60300);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  store = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  broker = new EgressCredentialBroker(store);
});

after(async () => {
  await pg.stop();
});

describe('P3-B0 S0b (OD-7) governed egress-provider credential handle (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P3-S0b requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
    assert.ok(broker, 'the egress credential broker must be constructed over an open store');
  });

  // ---------------------------------------------------------------------
  // Closed-set contract
  // ---------------------------------------------------------------------

  it('accepts exactly the new egress-provider purpose and nothing else', () => {
    // The recognized set is exactly the four purposes, frozen, in order.
    assert.deepEqual([...RECOGNIZED_SECRET_PURPOSES], ['totp', 'break-glass-seal', 'session-assertion', 'egress-provider']);
    assert.equal(Object.isFrozen(RECOGNIZED_SECRET_PURPOSES), true, 'the recognized set must remain frozen');
    assert.equal(EGRESS_PROVIDER_PURPOSE, 'egress-provider');

    for (const purpose of ['totp', 'break-glass-seal', 'session-assertion', 'egress-provider']) {
      assert.equal(isSecretPurpose(purpose), true, `${purpose} must be recognized`);
    }

    // Unauthorized purposes remain refused — including near-misses and case
    // variants, so the closed set was extended by exactly one value.
    for (const rejected of [
      'egress',
      'provider',
      'provider-key',
      'egress provider',
      'Egress-Provider',
      'EGRESS-PROVIDER',
      'egress-provider ',
      ' egress-provider',
      'egress-provider-rotate',
      'totp-extra',
      'break-glass',
      '',
      123,
      null,
      undefined,
    ]) {
      assert.equal(isSecretPurpose(rejected), false, `must refuse: ${JSON.stringify(rejected)}`);
    }
  });

  it('the store still refuses unrecognized purposes (rejection discipline preserved)', async () => {
    // The broker pins the purpose by construction (its input has no purpose
    // field), so the closed-set discipline is asserted at the seam it governs:
    // a direct store operation with an unrecognized purpose must be refused,
    // exactly as before this slice.
    const credentialId = nextCredentialId();
    await assert.rejects(
      () =>
        store.seal({
          tenantId: TENANT,
          actorPrincipalId: ACTOR,
          principalId: PRINCIPAL,
          purpose: 'not-a-purpose' as never,
          secretId: credentialId,
          material: bytes(PLAINTEXT),
        }),
      (error: unknown) => {
        assert.ok(error instanceof SecretMaterialError);
        assert.equal(error.code, 'SECRET_INVALID_ARGUMENT');
        return true;
      },
    );
    // And nothing was written: no row, no audit row, no credential.
    assert.equal((await docsFor(credentialId)).length, 0);
    assert.equal((await auditFor(credentialId)).length, 0);
    // The broker's input type carries no purpose field: the egress purpose is
    // the only one it can seal (asserted behaviorally in the issue tests).
    const issued = await broker.issue(issueInput(credentialId));
    assert.equal(issued.credentialId, credentialId);
    const issuedDocs = await docsFor(credentialId);
    assert.equal(issuedDocs.length, 1);
    assert.equal(issuedDocs[0]?.purpose, 'egress-provider');
  });

  it('the sealing context binds the new purpose like every other element', () => {
    const base = { tenantId: TENANT, principalId: PRINCIPAL, purpose: EGRESS_PROVIDER_PURPOSE, secretId: 'sec-eg-1' };
    const context = deriveSecretContext(base);
    assert.equal(context, `s7|${TENANT}|${PRINCIPAL}|egress-provider|sec-eg-1`);
    for (const mutated of [
      { ...base, tenantId: OTHER_TENANT },
      { ...base, principalId: OTHER_PRINCIPAL },
      { ...base, purpose: 'totp' as const },
      { ...base, secretId: 'sec-eg-2' },
    ]) {
      assert.notEqual(deriveSecretContext(mutated), context, 'each binding element must change the context');
    }
  });

  // ---------------------------------------------------------------------
  // Handle semantics — a reference, never material
  // ---------------------------------------------------------------------

  it('issue seals under the egress purpose and returns a handle WITHOUT material', async () => {
    const credentialId = nextCredentialId();
    const handle: EgressCredentialHandle = await broker.issue(issueInput(credentialId));
    assert.equal(handle.credentialId, credentialId);
    assert.equal(handle.audience, 'api.openai.com');
    assert.deepEqual([...handle.scopes], ['chat.completions']);
    assert.equal(handle.version, 1);
    assert.equal(handle.status, 'ACTIVE');
    assert.equal(isEgressCredentialHandle(handle), true);

    // The handle is shareable by construction: serializing it cannot leak.
    assert.ok(!JSON.stringify(handle).includes(PLAINTEXT), 'handle must never carry the material');

    // The durable row is the egress purpose and holds only ciphertext.
    const docs = await docsFor(credentialId);
    assert.equal(docs.length, 1);
    assert.equal(docs[0]?.purpose, 'egress-provider');
    assert.ok(!JSON.stringify(docs[0]).includes(PLAINTEXT), 'plaintext must never rest in the database');
    assert.ok(!JSON.stringify(docs[0]).includes(Buffer.from(PLAINTEXT).toString('base64')), 'nor base64 of it');
  });

  it('refuses to re-issue an existing credential id (no silent overwrite)', async () => {
    const credentialId = nextCredentialId();
    await broker.issue(issueInput(credentialId));
    await assert.rejects(() => broker.issue(issueInput(credentialId)), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_CONFLICT');
      return true;
    });
    // Still exactly one row, v1 ACTIVE.
    const docs = await docsFor(credentialId);
    assert.equal(docs.length, 1);
    assert.equal(docs[0]?.status, 'ACTIVE');
  });

  it('refuses empty material and malformed handle shapes', async () => {
    await assert.rejects(
      () => broker.issue(issueInput(nextCredentialId(), { material: bytes('') })),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_INVALID_ARGUMENT');
        return true;
      },
    );
    for (const malformed of [
      undefined,
      null,
      {},
      { credentialId: '', audience: null, scopes: [], version: 1, status: 'ACTIVE' },
      { credentialId: 'c', audience: 'a', scopes: [], version: 0, status: 'ACTIVE' },
      { credentialId: 'c', audience: 'a', scopes: [1], version: 1, status: 'ACTIVE' },
      { credentialId: 'c', audience: 'a', scopes: ['s'], version: 1.5, status: 'ACTIVE' },
      { credentialId: 'c', audience: 'a', scopes: ['s'], version: 1, status: 'PENDING' },
    ]) {
      assert.equal(isEgressCredentialHandle(malformed), false, `must not be a handle: ${JSON.stringify(malformed)}`);
      // The malformed value IS the handle argument: the broker must refuse it
      // before any store access happens.
      await assert.rejects(() => broker.resolve(malformed as EgressCredentialHandle, CTX), (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_INVALID_ARGUMENT');
        return true;
      });
    }
    // A structurally well-formed handle that names an unknown credential is a
    // HANDLE, and fails closed as UNKNOWN (not as an argument error).
    const unknownShape: EgressCredentialHandle = { credentialId: 'c-unknown', audience: null, scopes: [], version: 1, status: 'ACTIVE' };
    assert.equal(isEgressCredentialHandle(unknownShape), true);
    await assert.rejects(() => broker.resolve(unknownShape, CTX), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_UNKNOWN');
      return true;
    });
  });

  // ---------------------------------------------------------------------
  // Governed handle access — no ambient authority, no identifier oracle
  // ---------------------------------------------------------------------

  it('resolves the material only through the governed seam', async () => {
    const credentialId = nextCredentialId();
    const handle = await broker.issue(issueInput(credentialId));
    const opened = await broker.resolve(handle, CTX);
    assert.equal(text(opened), PLAINTEXT);
  });

  it('refuses a missing actor: no ambient authority on the handle', async () => {
    const credentialId = nextCredentialId();
    const handle = await broker.issue(issueInput(credentialId));
    await assert.rejects(
      () => broker.resolve(handle, { ...CTX, actorPrincipalId: '' }),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_INVALID_ARGUMENT');
        return true;
      },
    );
    await assert.rejects(
      () => broker.resolve(handle, { ...CTX, actorPrincipalId: undefined as unknown as string }),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_INVALID_ARGUMENT');
        return true;
      },
    );
  });

  it('cross-tenant resolution is refused and indistinguishable from a miss (real RLS)', async () => {
    const credentialId = nextCredentialId();
    await broker.issue(issueInput(credentialId));

    const fromOtherTenant = await broker
      .resolve(
        { credentialId, audience: null, scopes: [], version: 1, status: 'ACTIVE' },
        { tenantId: OTHER_TENANT, actorPrincipalId: ACTOR, principalId: PRINCIPAL },
      )
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);
    const genuinelyMissing = await broker
      .resolve({ credentialId: 's0b-never-existed', audience: null, scopes: [], version: 1, status: 'ACTIVE' }, CTX)
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);

    assert.equal(fromOtherTenant, 'SECRET_UNKNOWN', 'a cross-tenant read must fail closed');
    assert.equal(genuinelyMissing, 'SECRET_UNKNOWN');
    assert.equal(fromOtherTenant, genuinelyMissing, 'cross-tenant must be indistinguishable from a miss');
    assert.equal((await docsFor(credentialId, OTHER_TENANT)).length, 0, 'RLS must make the row invisible');
  });

  it('a wrong principal and a cross-purpose secret are indistinguishable from a miss', async () => {
    const credentialId = nextCredentialId();
    const handle = await broker.issue(issueInput(credentialId));

    const wrongPrincipal = await broker
      .resolve(handle, { ...CTX, principalId: OTHER_PRINCIPAL })
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);

    // A TOTP secret under the SAME credential id is invisible to the egress
    // broker: purpose is part of the binding, and the miss is indistinguishable.
    await store.seal({
      tenantId: TENANT,
      actorPrincipalId: ACTOR,
      principalId: OTHER_PRINCIPAL,
      purpose: 'totp',
      secretId: `${credentialId}-totp`,
      material: bytes('totp-never-here'),
    });
    const crossPurpose = await broker
      .resolve({ credentialId: `${credentialId}-totp`, audience: null, scopes: [], version: 1, status: 'ACTIVE' }, CTX)
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);

    const missing = await broker
      .resolve({ credentialId: 's0b-also-never-existed', audience: null, scopes: [], version: 1, status: 'ACTIVE' }, CTX)
      .then(() => 'opened', (error: unknown) => (error as SecretMaterialError).code);

    assert.equal(wrongPrincipal, 'SECRET_UNKNOWN');
    assert.equal(crossPurpose, 'SECRET_UNKNOWN');
    assert.equal(missing, 'SECRET_UNKNOWN');
    assert.equal(
      new Set([wrongPrincipal, crossPurpose, missing]).size,
      1,
      'ownership and purpose must not be distinguishable — no identifier oracle',
    );
  });

  it('an egress credential cannot be opened through another consumer\u2019s purpose', async () => {
    const credentialId = nextCredentialId();
    await broker.issue(issueInput(credentialId));

    // S5's consumer purpose on the same credential id: refused, indistinguishable.
    await assert.rejects(
      () =>
        store.open({
          tenantId: TENANT,
          actorPrincipalId: ACTOR,
          principalId: PRINCIPAL,
          purpose: 'totp',
          secretId: credentialId,
        }),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_UNKNOWN');
        return true;
      },
    );
  });

  it('a row re-pointed directly in the database still will not open (AAD defence in depth)', async () => {
    const victimId = nextCredentialId();
    const attackerId = nextCredentialId();
    await broker.issue(issueInput(victimId));
    await broker.issue(issueInput(attackerId, { principalId: OTHER_PRINCIPAL }));

    // Simulate a data-plane compromise: rewrite the attacker's row so it
    // claims the victim's principal under the egress purpose. The stored AAD
    // still names the attacker's binding, so the open must fail closed.
    await storage.atomically(async (scope) => {
      const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
      const doc = await rows.get(`${attackerId}::1`);
      assert.ok(doc);
      await rows.put({ ...doc, principalId: PRINCIPAL });
    }, { tenantId: TENANT });

    await assert.rejects(
      () => broker.resolve({ credentialId: attackerId, audience: null, scopes: [], version: 1, status: 'ACTIVE' }, CTX),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_UNKNOWN');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------
  // Lifecycle — rotation retires, revocation is terminal
  // ---------------------------------------------------------------------

  it('rotation retires v1, activates v2, and returns a new material-free handle', async () => {
    const credentialId = nextCredentialId();
    const v1 = await broker.issue(issueInput(credentialId));

    const v2 = await broker.rotate(v1, { ...CTX, material: bytes(ROTATED), correlationId: `corr-rotate-${credentialId}` });
    assert.equal(v2.credentialId, credentialId);
    assert.equal(v2.audience, 'api.openai.com');
    assert.deepEqual([...v2.scopes], ['chat.completions'], 'declared metadata carries over unchanged');
    assert.equal(v2.version, 2);
    assert.equal(v2.status, 'ACTIVE');
    assert.ok(!JSON.stringify(v2).includes(ROTATED), 'the rotated handle must never carry the material');

    // The new version serves the new material.
    assert.equal(text(await broker.resolve(v2, CTX)), ROTATED);
    // The retired version remains openable until revoked (the store's
    // rotation semantics, unchanged by this slice).
    assert.equal(text(await broker.resolve(v1, CTX)), PLAINTEXT);

    const docs = await docsFor(credentialId);
    assert.equal(docs.length, 2);
    assert.equal(docs.find((d) => d.version === 1)?.status, 'RETIRED');
    assert.equal(docs.find((d) => d.version === 2)?.status, 'ACTIVE');
  });

  it('rotation by a wrong principal or missing actor is refused, leaving state unchanged', async () => {
    const credentialId = nextCredentialId();
    const handle = await broker.issue(issueInput(credentialId));
    for (const input of [
      { ...CTX, material: bytes(ROTATED), principalId: OTHER_PRINCIPAL },
      { ...CTX, material: bytes(ROTATED), actorPrincipalId: '' },
    ]) {
      await assert.rejects(() => broker.rotate(handle, input), (error: unknown) => {
        assert.ok(error instanceof SecretMaterialError);
        assert.ok(['SECRET_UNKNOWN', 'SECRET_INVALID_ARGUMENT'].includes(error.code));
        return true;
      });
    }
    const docs = await docsFor(credentialId);
    assert.equal(docs.length, 1, 'a refused rotation must not change the secret state');
    assert.equal(docs[0]?.status, 'ACTIVE');
    assert.equal(text(await broker.resolve(handle, CTX)), PLAINTEXT);
  });

  it('concurrent rotations through the broker: no shared version, no gap, one ACTIVE', async () => {
    const credentialId = nextCredentialId();
    const handle = await broker.issue(issueInput(credentialId));

    const racers = 6;
    const results = await Promise.allSettled(
      Array.from({ length: racers }, (_, index) =>
        broker.rotate(handle, {
          ...CTX,
          material: bytes(`${ROTATED}-${index}`),
          correlationId: `corr-race-${credentialId}-${index}`,
        }),
      ),
    );

    const wins = results
      .map((r, index) => ({ r, index }))
      .filter((entry) => entry.r.status === 'fulfilled') as Array<{ r: PromiseFulfilledResult<EgressCredentialHandle>; index: number }>;
    const losses = results.filter((r) => r.status === 'rejected');
    assert.equal(wins.length + losses.length, racers);
    assert.ok(wins.length >= 1, 'at least one rotation must succeed');
    for (const loss of losses) {
      const error = (loss as PromiseRejectedResult).reason as SecretMaterialError;
      assert.equal(error.code, 'SECRET_CONFLICT', 'a losing racer must fail closed, never corrupt state');
    }

    const versions = wins.map((entry) => entry.r.value.version);
    assert.equal(new Set(versions).size, versions.length, 'two racers must never claim the same version');
    assert.deepEqual(
      [...versions].sort((a, b) => a - b),
      Array.from({ length: wins.length }, (_, i) => i + 2),
      'versions must be exactly 2..n+1 with no gap and no duplicate',
    );

    const docs = await docsFor(credentialId);
    assert.equal(docs.length, wins.length + 1, 'one row per version, none lost');
    const active = docs.filter((d) => d.status === 'ACTIVE');
    assert.equal(active.length, 1, 'exactly one ACTIVE version must remain');
    assert.equal(active[0]?.version, wins.length + 1);

    const highest = wins.reduce((best, entry) => (entry.r.value.version > best.r.value.version ? entry : best));
    assert.equal(
      text(await broker.resolve(highest.r.value, CTX)),
      `${ROTATED}-${highest.index}`,
      'the ACTIVE material must be exactly the highest-version winner\u2019s, with no interleaving',
    );
  });

  it('revocation is terminal for the version, on the broker path', async () => {
    const credentialId = nextCredentialId();
    const v1 = await broker.issue(issueInput(credentialId));
    const v2 = await broker.rotate(v1, { ...CTX, material: bytes(ROTATED) });
    assert.equal(text(await broker.resolve(v2, CTX)), ROTATED);

    await broker.revoke(v2, CTX, { correlationId: `corr-revoke-${credentialId}` });
    await assert.rejects(() => broker.resolve(v2, CTX), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_REVOKED');
      return true;
    });
    // The retired v1 remains openable until IT is revoked too.
    assert.equal(text(await broker.resolve(v1, CTX)), PLAINTEXT);
    await broker.revoke(v1, CTX, { correlationId: `corr-revoke-v1-${credentialId}` });
    await assert.rejects(() => broker.resolve(v1, CTX), (error: unknown) => {
      assert.equal((error as SecretMaterialError).code, 'SECRET_REVOKED');
      return true;
    });
  });

  it('a revoked credential id cannot be silently re-issued under the same id', async () => {
    const credentialId = nextCredentialId();
    const handle = await broker.issue(issueInput(credentialId));
    await broker.revoke(handle, CTX);
    await assert.rejects(
      () => broker.issue(issueInput(credentialId)),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_CONFLICT');
        return true;
      },
    );
  });

  it('a wrong-purpose or wrong-principal revoke is refused, leaving the credential intact', async () => {
    const credentialId = nextCredentialId();
    const handle = await broker.issue(issueInput(credentialId));
    // Purpose is pinned by the module, so the only cross-binding vector left
    // is the principal; a revoke naming another principal is UNKNOWN.
    await assert.rejects(
      () => broker.revoke(handle, { ...CTX, principalId: OTHER_PRINCIPAL }),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_UNKNOWN');
        return true;
      },
    );
    // Still resolvable: the revoke was refused.
    assert.equal(text(await broker.resolve(handle, CTX)), PLAINTEXT);
  });

  // ---------------------------------------------------------------------
  // Audit / non-disclosure
  // ---------------------------------------------------------------------

  it('audits every broker operation with the egress purpose and identifier fields only', async () => {
    const credentialId = nextCredentialId();
    const v1 = await broker.issue(issueInput(credentialId));
    await broker.resolve(v1, CTX, { correlationId: `corr-open-${credentialId}` });
    const v2 = await broker.rotate(v1, { ...CTX, material: bytes(ROTATED), correlationId: `corr-rotate-${credentialId}` });
    await broker.revoke(v2, CTX, { correlationId: `corr-revoke-${credentialId}` });

    const audit = await auditFor(credentialId);
    for (const operation of ['seal', 'open', 'rotate', 'revoke']) {
      const row = audit.find((record) => record.operation === operation && record.result === 'SUCCESS');
      assert.ok(row, `the ${operation} must be audited`);
      assert.equal(row?.purpose, 'egress-provider', 'the audit row must carry the egress purpose');
      assert.equal(row?.actorPrincipalId, ACTOR);
      assert.equal(row?.tenantId, TENANT);
      assert.equal(row?.secretId, credentialId);
      assert.equal(row?.providerId, seam.id);
      assert.ok(row?.correlationId);
      assert.equal(typeof row?.at, 'number');
      assert.ok((row?.at ?? 0) > 0);
    }
  });

  it('audits REFUSED handle accesses too', async () => {
    const credentialId = nextCredentialId();
    const handle = await broker.issue(issueInput(credentialId));
    await assert.rejects(
      () => broker.resolve(handle, { ...CTX, principalId: OTHER_PRINCIPAL, }, { correlationId: `corr-deny-${credentialId}` }),
    );
    const audit = await auditFor(credentialId);
    const denied = audit.find((row) => row.operation === 'open' && row.result === 'REFUSED_UNKNOWN');
    assert.ok(denied, 'a refused access must still be audited');
    assert.equal(denied?.correlationId, `corr-deny-${credentialId}`);
    assert.equal(denied?.actorPrincipalId, ACTOR);
    assert.equal(denied?.purpose, 'egress-provider');
  });

  it('no handle, stored row, audit record, or error ever contains the plaintext', async () => {
    const credentialId = nextCredentialId();
    const v1 = await broker.issue(issueInput(credentialId));
    await broker.resolve(v1, CTX);
    const v2 = await broker.rotate(v1, { ...CTX, material: bytes(ROTATED) });
    await broker.revoke(v2, CTX);

    const serializedHandles = JSON.stringify([v1, v2]);
    assert.ok(!serializedHandles.includes(PLAINTEXT));
    assert.ok(!serializedHandles.includes(ROTATED));

    const docs = await docsFor(credentialId);
    assert.ok(docs.length === 2);
    for (const doc of docs) {
      const serialized = JSON.stringify(doc);
      assert.ok(!serialized.includes(PLAINTEXT));
      assert.ok(!serialized.includes(ROTATED));
    }

    const audit = await auditFor(credentialId);
    for (const record of audit) {
      const serialized = JSON.stringify(record);
      assert.ok(!serialized.includes(PLAINTEXT), `plaintext leaked into audit: ${serialized}`);
      assert.ok(!serialized.includes(ROTATED), `rotated plaintext leaked into audit: ${serialized}`);
      assert.ok(!serialized.includes(Buffer.from(PLAINTEXT).toString('base64')));
      assert.ok(!serialized.includes(Buffer.from(ROTATED).toString('base64')));
      for (const key of Object.keys(record)) {
        assert.ok(
          !['material', 'plaintext', 'secret', 'value', 'ciphertext', 'sealed', 'pem', 'key'].includes(key),
          `audit record carries a material-shaped field: ${key}`,
        );
      }
    }

    // Error messages carry identifiers only.
    const errorTexts: string[] = [];
    await broker.resolve(v2, CTX).catch((error: unknown) => errorTexts.push(String(error)));
    assert.equal(errorTexts.length, 1);
    const errorMsg = errorTexts[0];
    assert.ok(errorMsg, 'a revoked resolve must produce exactly one error');
    assert.ok(errorMsg.includes(credentialId), 'the error must still identify the credential');
    assert.ok(!errorMsg.includes(ROTATED), 'the error must never carry the material');
  });

  // ---------------------------------------------------------------------
  // P2 invariants preserved (the seam this module is built on)
  // ---------------------------------------------------------------------

  it('the seam still refuses a non-transactional source at open', async () => {
    const memory = new StorageModule();
    const kernel = createTestKernel();
    kernel.register(memory);
    await kernel.boot();
    await assert.rejects(
      () => SecretMaterialStore.open(memory, seam, DEV_SECRET_SEAM_KEY_ID),
      (error: unknown) => {
        assert.equal((error as SecretMaterialError).code, 'SECRET_SEAM_UNAVAILABLE');
        return true;
      },
    );
    await kernel.shutdown();
  });

  it('the production guard still refuses a dev seam (no fallback), unchanged by this slice', () => {
    assert.equal(seam.kind, 'dev-inmemory');
    assert.throws(() => assertProductionSecretSeam(seam), (error: unknown) => {
      assert.ok(error instanceof SecretMaterialError);
      assert.equal(error.code, 'SECRET_DEV_PROVIDER_IN_PRODUCTION');
      return true;
    });
  });

  it('the existing S7 consumers are unaffected: totp still seals and opens', async () => {
    const secretId = nextCredentialId();
    await store.seal({
      tenantId: TENANT,
      actorPrincipalId: ACTOR,
      principalId: PRINCIPAL,
      purpose: 'totp',
      secretId,
      material: bytes('totp-secret-unchanged'),
    });
    assert.equal(
      text(await store.open({ tenantId: TENANT, actorPrincipalId: ACTOR, principalId: PRINCIPAL, purpose: 'totp', secretId })),
      'totp-secret-unchanged',
    );
  });
});
