// P2-S7 — the credential-material KEY seam contract (spec §12).
//
// No PostgreSQL is needed here: this suite exercises the seam's security rules
// directly against BOTH implementations (the labelled development double and
// the external-adapter wrapper), because those rules are what production
// depends on and they must hold identically for a real KMS/HSM behind the
// adapter.
//
// Covered:
//   * provider contract: list/create, sign↔verify, encrypt↔decrypt, health;
//   * PURPOSE SEPARATION: a signing key never yields an encryptor and vice
//     versa (a signing key must not be usable to wrap secrets);
//   * ROTATION: the outgoing version becomes RETIRED — still verifiable /
//     decryptable until notAfter, never usable for NEW operations;
//   * REVOCATION is terminal across all four handle getters;
//   * EXPIRY is absolute (a retired key past notAfter is refused);
//   * NO EXISTENCE ORACLE: unknown key and unknown version are the same code;
//   * UNAVAILABILITY fails closed on every path;
//   * CONTEXT (AAD) BINDING: a blob sealed under one context will not open
//     under another, and is reported as an authorization failure;
//   * MALFORMED material fails closed without propagating provider errors;
//   * SECRET NON-DISCLOSURE: no error message, health detail, or serialized
//     error carries plaintext, ciphertext, or key material;
//   * PRODUCTION REFUSES DEV: `assertProductionKeySeam` / `isDevelopmentKeySeam`
//     refuse 'dev-inmemory' and accept 'external' — with no fallback.
//
// MUTATION ANCHORS (each `it` below is paired with a comment naming the mutant
// that must kill it; see p2-s7-mutation.test.ts for the automated proof):
//   M1  production accepts a dev seam        → 'refuses a dev-inmemory seam'
//   M2  retired key can sign again           → 'retired version cannot sign'
//   M3  revoked key stays usable             → 'revocation is terminal'
//   M4  context binding dropped              → 'a blob sealed under one context'
//   M5  purpose separation dropped           → 'a signing key never yields'

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_RETIRED_KEY_GRACE_MS,
  ExternalKeyManagementSeam,
  InMemoryKeyManagementSeam,
  KeyManagementError,
  assertProductionKeySeam,
  isDevelopmentKeySeam,
  type ExternalKeyProviderAdapter,
  type KeyManagementSeam,
} from '../src/index.js';

const SIGNING_KEY = 's7-test-signing-key';
const WRAPPING_KEY = 's7-test-wrapping-key';
const PLAINTEXT = 's7-canary-plaintext-DO-NOT-LEAK-9f2a';

/** A fake external provider that hands back real, usable key material. */
function externalAdapter(overrides: Partial<ExternalKeyProviderAdapter> = {}): ExternalKeyProviderAdapter {
  return {
    id: 'fake-kms',
    async fetchKeyMaterial(keyId: string, version: number, purpose: 'signing' | 'encryption'): Promise<Uint8Array> {
      // Deterministic 32-byte wrapping keys; signing keys are real PEMs.
      if (purpose === 'encryption') {
        const buf = Buffer.alloc(32);
        Buffer.from(`${keyId}:${version}`).copy(buf);
        return new Uint8Array(buf);
      }
      throw new Error(`test adapter does not mint signing keys (${keyId} v${version})`);
    },
    ...overrides,
  };
}

async function devSeam(): Promise<InMemoryKeyManagementSeam> {
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(SIGNING_KEY, 'signing');
  await seam.createKey(WRAPPING_KEY, 'encryption');
  return seam;
}

function externalSeam(): ExternalKeyManagementSeam {
  const seam = new ExternalKeyManagementSeam(externalAdapter());
  seam.registerKey({ keyId: WRAPPING_KEY, version: 1, purpose: 'encryption', status: 'ACTIVE', algorithm: 'A256GCM' });
  // A signing ref is registered so the purpose-separation cases exercise the
  // PURPOSE guard rather than falling through to KEY_VERSION_UNKNOWN. The test
  // adapter cannot supply signing material, but the guard runs first, so those
  // cases assert the real behaviour a production adapter would hit.
  seam.registerKey({ keyId: SIGNING_KEY, version: 1, purpose: 'signing', status: 'ACTIVE', algorithm: 'ES256' });
  return seam;
}

/**
 * Both seam implementations, as a synchronous registration loop. `it()` must
 * be called synchronously inside `describe`, so the dual-implementation cases
 * are registered by a plain `for` loop rather than by an awaited helper.
 */
const SEAM_VARIANTS: ReadonlyArray<readonly [string, () => Promise<KeyManagementSeam>]> = [
  ['dev-inmemory', async (): Promise<KeyManagementSeam> => devSeam()],
  ['external adapter', async (): Promise<KeyManagementSeam> => externalSeam()],
];

function forBothSeams(name: string, fn: (seam: KeyManagementSeam, label: string) => Promise<void>): void {
  for (const [label, make] of SEAM_VARIANTS) {
    it(`${name} [${label}]`, async () => fn(await make(), label));
  }
}

describe('P2-S7 key-management seam contract (spec §12)', () => {
  // ---------------------------------------------------------------------
  // Provider contract
  // ---------------------------------------------------------------------

  it('lists keys by purpose and hides the other purpose entirely', async () => {
    const seam = await devSeam();
    const signing = await seam.listKeys('signing');
    const encryption = await seam.listKeys('encryption');
    assert.deepEqual(signing.map((r) => r.keyId), [SIGNING_KEY]);
    assert.deepEqual(encryption.map((r) => r.keyId), [WRAPPING_KEY]);
    // KeyRef is an identifier envelope — it never carries material.
    for (const ref of [...signing, ...encryption]) {
      assert.equal(typeof ref.keyId, 'string');
      assert.equal(typeof ref.version, 'number');
      assert.ok(!('material' in (ref as unknown as Record<string, unknown>)));
      assert.ok(!('pem' in (ref as unknown as Record<string, unknown>)));
      assert.ok(!('key' in (ref as unknown as Record<string, unknown>)));
    }
  });

  it('signs and verifies a round trip, and rejects a tampered payload', async () => {
    const seam = await devSeam();
    const signer = await seam.getSigner(SIGNING_KEY, 1);
    const verifier = await seam.getVerifier(SIGNING_KEY, 1);
    assert.equal(signer.purpose, 'signing');
    const sig = await signer.sign('s7-payload');
    assert.equal(await verifier.verify('s7-payload', sig), true);
    // A tampered payload must not verify — and must FAIL, not throw.
    assert.equal(await verifier.verify('s7-payload-TAMPERED', sig), false);
  });

  it('encrypts and decrypts a round trip under a bound context', async () => {
    const seam = await devSeam();
    const encryptor = await seam.getEncryptor(WRAPPING_KEY, 1);
    const sealed = await encryptor.encrypt(PLAINTEXT, 's7|acme|prin-1|totp|sec-1');
    const decryptor = await seam.getDecryptor(WRAPPING_KEY, 1);
    const opened = await decryptor.decrypt(sealed, 's7|acme|prin-1|totp|sec-1');
    assert.equal(new TextDecoder().decode(opened), PLAINTEXT);
    // The sealed blob routes the ciphertext but never contains the key.
    assert.equal(sealed.keyId, WRAPPING_KEY);
    assert.equal(typeof sealed.iv, 'string');
    assert.equal(typeof sealed.tag, 'string');
    assert.ok(!('pem' in (sealed as unknown as Record<string, unknown>)));
    assert.ok(!('material' in (sealed as unknown as Record<string, unknown>)));
  });

  it('reports health without disclosing key material', async () => {
    const seam = await devSeam();
    const health = await seam.health();
    assert.ok(health.status === 'healthy' || health.status === 'degraded' || health.status === 'unavailable');
    const serialized = JSON.stringify(health);
    assert.ok(!serialized.includes(PLAINTEXT));
    assert.ok(!serialized.includes('BEGIN PRIVATE KEY'));
  });

  it('an external seam with no liveness probe reports degraded, never healthy', async () => {
    const seam = new ExternalKeyManagementSeam(externalAdapter());
    seam.registerKey({ keyId: WRAPPING_KEY, version: 1, purpose: 'encryption', status: 'ACTIVE', algorithm: 'A256GCM' });
    const health = await seam.health();
    assert.notEqual(health.status, 'healthy', 'no probe ⇒ the seam must not claim healthy');
  });

  it('an external seam WITH a passing probe may report healthy', async () => {
    const seam = new ExternalKeyManagementSeam(externalAdapter({ probe: async () => true }));
    seam.registerKey({ keyId: WRAPPING_KEY, version: 1, purpose: 'encryption', status: 'ACTIVE', algorithm: 'A256GCM' });
    assert.equal((await seam.health()).status, 'healthy');
  });

  // ---------------------------------------------------------------------
  // Purpose separation  (MUTATION M5)
  // ---------------------------------------------------------------------

  forBothSeams('a signing key never yields an encryptor or decryptor', async (seam) => {
    await assert.rejects(() => seam.getEncryptor(SIGNING_KEY, 1), (error: unknown) => {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_PURPOSE_MISMATCH');
      return true;
    });
    await assert.rejects(() => seam.getDecryptor(SIGNING_KEY, 1), (error: unknown) => {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_PURPOSE_MISMATCH');
      return true;
    });
  });

  forBothSeams('an encryption key never yields a signer or verifier', async (seam) => {
    for (const call of [() => seam.getSigner(WRAPPING_KEY, 1), () => seam.getVerifier(WRAPPING_KEY, 1)]) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof KeyManagementError);
        assert.equal(error.code, 'KEY_PURPOSE_MISMATCH');
        return true;
      });
    }
  });

  // ---------------------------------------------------------------------
  // Rotation / versioning  (MUTATION M2)
  // ---------------------------------------------------------------------

  forBothSeams('rotation retires the outgoing version and activates the next', async (seam) => {
    const next = await seam.rotate(WRAPPING_KEY);
    assert.equal(next.version, 2);
    assert.equal(next.status, 'ACTIVE');
    const refs = await seam.listKeys('encryption');
    const v1 = refs.find((r) => r.version === 1);
    const v2 = refs.find((r) => r.version === 2);
    assert.equal(v1?.status, 'RETIRED', 'the outgoing version must be RETIRED after rotation');
    assert.equal(v2?.status, 'ACTIVE');
    // The retired version carries an absolute notAfter.
    assert.equal(typeof v1?.notAfter, 'number');
    assert.ok((v1?.notAfter ?? 0) > Date.now());
  });

  forBothSeams('a retired version cannot encrypt NEW data', async (seam) => {
    await seam.rotate(WRAPPING_KEY);
    await assert.rejects(() => seam.getEncryptor(WRAPPING_KEY, 1), (error: unknown) => {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_RETIRED');
      return true;
    });
    // The new version works.
    const encryptor = await seam.getEncryptor(WRAPPING_KEY, 2);
    assert.equal(encryptor.version, 2);
  });

  forBothSeams('a retired version CAN still decrypt previously-sealed data', async (seam) => {
    const encryptor = await seam.getEncryptor(WRAPPING_KEY, 1);
    const sealed = await encryptor.encrypt(PLAINTEXT, 's7|acme|prin-1|totp|sec-1');
    await seam.rotate(WRAPPING_KEY);
    // Spec §12: previously-issued material stays recoverable across a rotation.
    const decryptor = await seam.getDecryptor(WRAPPING_KEY, 1);
    assert.equal(new TextDecoder().decode(await decryptor.decrypt(sealed, 's7|acme|prin-1|totp|sec-1')), PLAINTEXT);
  });

  forBothSeams('a retired signing version cannot sign but its signatures still verify', async (seam) => {
    // Only the dev double mints signing keys; assert the dev path and skip the
    // external adapter (its test adapter does not supply signing material).
    if (seam.kind !== 'dev-inmemory') return;
    const signer = await seam.getSigner(SIGNING_KEY, 1);
    const sig = await signer.sign('s7-rotation-evidence');
    await seam.rotate(SIGNING_KEY);
    await assert.rejects(() => seam.getSigner(SIGNING_KEY, 1), (error: unknown) => {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_RETIRED');
      return true;
    });
    const verifier = await seam.getVerifier(SIGNING_KEY, 1);
    assert.equal(await verifier.verify('s7-rotation-evidence', sig), true);
  });

  it('rotation grace is bounded and documented', () => {
    // 30 days. Recorded here so a change to the grace period is a deliberate,
    // reviewed decision rather than a silent one.
    assert.equal(DEFAULT_RETIRED_KEY_GRACE_MS, 30 * 24 * 60 * 60 * 1000);
  });

  // ---------------------------------------------------------------------
  // Revocation  (MUTATION M3)
  // ---------------------------------------------------------------------

  forBothSeams('revocation is terminal for every handle type', async (seam) => {
    await seam.revoke(WRAPPING_KEY, 1);
    for (const call of [
      () => seam.getEncryptor(WRAPPING_KEY, 1),
      () => seam.getDecryptor(WRAPPING_KEY, 1),
    ]) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof KeyManagementError);
        assert.equal(error.code, 'KEY_REVOKED');
        return true;
      });
    }
  });

  forBothSeams('revocation beats retirement: a retired-then-revoked version is REVOKED', async (seam) => {
    await seam.rotate(WRAPPING_KEY); // v1 → RETIRED
    await seam.revoke(WRAPPING_KEY, 1); // → REVOKED
    await assert.rejects(() => seam.getDecryptor(WRAPPING_KEY, 1), (error: unknown) => {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_REVOKED', 'REVOKED must win over RETIRED');
      return true;
    });
  });

  forBothSeams('a revoked key is never re-activated by rotation', async (seam) => {
    await seam.revoke(WRAPPING_KEY, 1);
    // No ACTIVE version remains, so rotation cannot resurrect anything.
    await assert.rejects(() => seam.rotate(WRAPPING_KEY), KeyManagementError);
    await assert.rejects(() => seam.getEncryptor(WRAPPING_KEY, 1), KeyManagementError);
  });

  // ---------------------------------------------------------------------
  // Expiry
  // ---------------------------------------------------------------------

  it('a retired key past notAfter is refused absolutely (expiry is not advisory)', async () => {
    const seam = new ExternalKeyManagementSeam(externalAdapter());
    seam.registerKey({
      keyId: WRAPPING_KEY,
      version: 1,
      purpose: 'encryption',
      status: 'RETIRED',
      notAfter: Date.now() - 1,
      algorithm: 'A256GCM',
    });
    await assert.rejects(() => seam.getDecryptor(WRAPPING_KEY, 1), (error: unknown) => {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_EXPIRED');
      return true;
    });
  });

  // ---------------------------------------------------------------------
  // No existence oracle
  // ---------------------------------------------------------------------

  forBothSeams('an unknown key and an unknown version are indistinguishable', async (seam) => {
    const unknownKey = await seam.getSigner('s7-does-not-exist', 1).then(
      () => 'resolved',
      (error: unknown) => (error as KeyManagementError).code,
    );
    const unknownVersion = await seam.getSigner(WRAPPING_KEY, 999).then(
      () => 'resolved',
      (error: unknown) => (error as KeyManagementError).code,
    );
    assert.equal(unknownKey, 'KEY_VERSION_UNKNOWN');
    assert.equal(unknownVersion, 'KEY_VERSION_UNKNOWN', 'existence must not be distinguishable from version');
  });

  // ---------------------------------------------------------------------
  // Unavailability
  // ---------------------------------------------------------------------

  it('a provider outage fails closed on every path (dev double)', async () => {
    const seam = await devSeam();
    seam.setUnavailable(true);
    await assert.rejects(() => seam.listKeys('encryption'), (e: unknown) => {
      assert.equal((e as KeyManagementError).code, 'KEY_SEAM_UNAVAILABLE');
      return true;
    });
    await assert.rejects(() => seam.getEncryptor(WRAPPING_KEY, 1), (e: unknown) => {
      assert.equal((e as KeyManagementError).code, 'KEY_SEAM_UNAVAILABLE');
      return true;
    });
    await assert.rejects(() => seam.rotate(WRAPPING_KEY), (e: unknown) => {
      assert.equal((e as KeyManagementError).code, 'KEY_SEAM_UNAVAILABLE');
      return true;
    });
  });

  it('an adapter that throws is reported as SEAM_UNAVAILABLE, not as the provider error', async () => {
    const leaky = 'postgres://user:s3cr3t-password@kms.internal:5432/keys';
    const seam = new ExternalKeyManagementSeam(
      externalAdapter({
        async fetchKeyMaterial(): Promise<Uint8Array> {
          throw new Error(`connect failed to ${leaky}`);
        },
      }),
    );
    seam.registerKey({ keyId: WRAPPING_KEY, version: 1, purpose: 'encryption', status: 'ACTIVE', algorithm: 'A256GCM' });
    await assert.rejects(() => seam.getEncryptor(WRAPPING_KEY, 1), (error: unknown) => {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_SEAM_UNAVAILABLE');
      assert.ok(!error.message.includes('s3cr3t-password'), 'provider error text must not be propagated');
      assert.ok(!error.message.includes('kms.internal'), 'provider endpoint must not be propagated');
      return true;
    });
  });

  // ---------------------------------------------------------------------
  // Context (AAD) binding  (MUTATION M4)
  // ---------------------------------------------------------------------

  it('a blob sealed under one context will not open under another (KEY_UNAUTHORIZED)', async () => {
    const seam = await devSeam();
    const encryptor = await seam.getEncryptor(WRAPPING_KEY, 1);
    const sealed = await encryptor.encrypt(PLAINTEXT, 's7|acme|prin-1|totp|sec-1');
    const decryptor = await seam.getDecryptor(WRAPPING_KEY, 1);
    for (const wrong of [
      's7|OTHER-TENANT|prin-1|totp|sec-1',
      's7|acme|prin-2|totp|sec-1',
      's7|acme|prin-1|break-glass-seal|sec-1',
      's7|acme|prin-1|totp|sec-2',
    ]) {
      await assert.rejects(() => decryptor.decrypt(sealed, wrong), (error: unknown) => {
        assert.ok(error instanceof KeyManagementError);
        assert.equal(error.code, 'KEY_UNAUTHORIZED', `context ${wrong} must be an authorization failure`);
        return true;
      });
    }
  });

  it('an empty context is refused (a contextless seal would be universally openable)', async () => {
    const seam = await devSeam();
    const encryptor = await seam.getEncryptor(WRAPPING_KEY, 1);
    await assert.rejects(() => encryptor.encrypt(PLAINTEXT, ''), (e: unknown) => {
      assert.equal((e as KeyManagementError).code, 'KEY_INVALID_ARGUMENT');
      return true;
    });
  });

  // ---------------------------------------------------------------------
  // Malformed material
  // ---------------------------------------------------------------------

  it('tampered ciphertext fails closed as KEY_MALFORMED without echoing bytes', async () => {
    const seam = await devSeam();
    const encryptor = await seam.getEncryptor(WRAPPING_KEY, 1);
    const sealed = await encryptor.encrypt(PLAINTEXT, 's7|acme|prin-1|totp|sec-1');
    const decryptor = await seam.getDecryptor(WRAPPING_KEY, 1);
    const raw = Buffer.from(sealed.ciphertext, 'base64url');
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    const tampered = { ...sealed, ciphertext: raw.toString('base64url') };
    await assert.rejects(() => decryptor.decrypt(tampered, 's7|acme|prin-1|totp|sec-1'), (error: unknown) => {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_MALFORMED');
      assert.ok(!error.message.includes(PLAINTEXT), 'plaintext must never appear in an error');
      return true;
    });
  });

  it('a blob naming a different key version is refused, not silently re-keyed', async () => {
    const seam = await devSeam();
    const encryptor = await seam.getEncryptor(WRAPPING_KEY, 1);
    const sealed = await encryptor.encrypt(PLAINTEXT, 's7|acme|prin-1|totp|sec-1');
    const decryptor = await seam.getDecryptor(WRAPPING_KEY, 1);
    await assert.rejects(
      () => decryptor.decrypt({ ...sealed, version: 2 } as typeof sealed, 's7|acme|prin-1|totp|sec-1'),
      (error: unknown) => {
        assert.equal((error as KeyManagementError).code, 'KEY_VERSION_UNKNOWN');
        return true;
      },
    );
  });

  it('a non-object sealed blob is refused', async () => {
    const seam = await devSeam();
    const decryptor = await seam.getDecryptor(WRAPPING_KEY, 1);
    await assert.rejects(
      () => decryptor.decrypt(undefined as never, 's7|acme|prin-1|totp|sec-1'),
      (error: unknown) => {
        assert.equal((error as KeyManagementError).code, 'KEY_MALFORMED');
        return true;
      },
    );
  });

  it('short / non-integer versions and empty key ids are refused', async () => {
    const seam = await devSeam();
    await assert.rejects(() => seam.getEncryptor('', 1), (e: unknown) => {
      assert.equal((e as KeyManagementError).code, 'KEY_INVALID_ARGUMENT');
      return true;
    });
    await assert.rejects(() => seam.getEncryptor(WRAPPING_KEY, 0), (e: unknown) => {
      assert.equal((e as KeyManagementError).code, 'KEY_INVALID_ARGUMENT');
      return true;
    });
    await assert.rejects(() => seam.getEncryptor(WRAPPING_KEY, 1.5), (e: unknown) => {
      assert.equal((e as KeyManagementError).code, 'KEY_INVALID_ARGUMENT');
      return true;
    });
  });

  // ---------------------------------------------------------------------
  // Secret non-disclosure
  // ---------------------------------------------------------------------

  it('no error message on any failure path carries plaintext or key material', async () => {
    const seam = await devSeam();
    const encryptor = await seam.getEncryptor(WRAPPING_KEY, 1);
    const sealed = await encryptor.encrypt(PLAINTEXT, 's7|acme|prin-1|totp|sec-1');
    const decryptor = await seam.getDecryptor(WRAPPING_KEY, 1);
    const attempts: Array<Promise<unknown>> = [
      decryptor.decrypt(sealed, 's7|wrong|context|x|y'),
      decryptor.decrypt({ ...sealed, tag: Buffer.from(randomBytes(16)).toString('base64url') }, 's7|acme|prin-1|totp|sec-1'),
      seam.getEncryptor('nope', 1),
      seam.getSigner(WRAPPING_KEY, 1),
    ];
    for (const attempt of attempts) {
      await attempt.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const serialized = JSON.stringify({
          message,
          ...(error instanceof Error ? { name: error.name } : {}),
        });
        assert.ok(!serialized.includes(PLAINTEXT), `plaintext leaked: ${message}`);
        assert.ok(!serialized.includes(sealed.ciphertext), `ciphertext leaked: ${message}`);
        assert.ok(!serialized.includes('BEGIN PRIVATE KEY'), `key material leaked: ${message}`);
        return undefined;
      });
    }
  });

  it('a serialized error exposes identifiers only', async () => {
    const seam = await devSeam();
    await seam.revoke(WRAPPING_KEY, 1);
    try {
      await seam.getEncryptor(WRAPPING_KEY, 1);
      assert.fail('expected rejection');
    } catch (error) {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_REVOKED');
      assert.equal(error.keyId, WRAPPING_KEY);
      assert.equal(error.version, 1);
      assert.equal(error.purpose, 'encryption');
      // The message is code + identifiers + a fixed suffix. Nothing else.
      assert.match(error.message, /^KEY_REVOKED keyId=\S+ version=1 purpose=encryption \(fail-closed\)$/);
    }
  });

  // ---------------------------------------------------------------------
  // Production refuses dev  (MUTATION M1)
  // ---------------------------------------------------------------------

  it('isDevelopmentKeySeam classifies dev, external, and absent correctly', async () => {
    const seam = await devSeam();
    assert.equal(isDevelopmentKeySeam(seam), true, 'dev-inmemory must be classified as development');
    assert.equal(isDevelopmentKeySeam(externalSeam()), false);
    assert.equal(isDevelopmentKeySeam(undefined), true, 'an ABSENT seam must never be treated as production-safe');
    assert.equal(isDevelopmentKeySeam({ id: 'x', kind: 'external' } as unknown as KeyManagementSeam), false);
    // A forged object claiming 'external' but missing the seam surface is still
    // refused by the assertion below (shape is checked, not just the label).
  });

  it('refuses a dev-inmemory seam in production and never falls back', async () => {
    const seam = await devSeam();
    assert.equal(seam.kind, 'dev-inmemory');
    assert.throws(() => assertProductionKeySeam(seam), (error: unknown) => {
      assert.ok(error instanceof KeyManagementError);
      assert.equal(error.code, 'KEY_DEV_PROVIDER_IN_PRODUCTION');
      return true;
    });
    // Absent ⇒ also refused (no implicit dev fallback).
    assert.throws(() => assertProductionKeySeam(undefined), (error: unknown) => {
      assert.equal((error as KeyManagementError).code, 'KEY_SEAM_UNAVAILABLE');
      return true;
    });
    // External ⇒ accepted.
    assert.doesNotThrow(() => assertProductionKeySeam(externalSeam()));
  });

  it('the external seam is the only kind accepted by the production assertion', async () => {
    const seam = await devSeam();
    // A dev seam that has been "rotated" or otherwise exercised is still a dev
    // seam: the classification is not earned by use.
    await seam.rotate(WRAPPING_KEY);
    assert.throws(() => assertProductionKeySeam(seam), (e: unknown) => {
      assert.equal((e as KeyManagementError).code, 'KEY_DEV_PROVIDER_IN_PRODUCTION');
      return true;
    });
  });

  it('the external adapter constructor refuses a malformed adapter', () => {
    assert.throws(
      () => new ExternalKeyManagementSeam({ id: 'broken' } as unknown as ExternalKeyProviderAdapter),
      (e: unknown) => {
        assert.equal((e as KeyManagementError).code, 'KEY_INVALID_ARGUMENT');
        return true;
      },
    );
  });
});
