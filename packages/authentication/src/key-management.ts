// P2-S7 — Key-management seam (spec §12).
//
// This is the identity-side key material boundary: the seam that OIDC JWKS
// verification (S1), TOTP secrets (S5), the break-glass sealed credential (S6),
// and future session-assertion signing all consume. It is DISTINCT from the A-01
// broker `CredentialMaterialProvider` in `@jataqi/authorization-boundary`; spec
// §12 is explicit that both seams exist and both must be external in production.
//
// SECURITY INVARIANTS ENFORCED HERE (not left to callers):
//
//  * PURPOSE SEPARATION — a signing key can never be obtained as an encryptor
//    and vice versa. Contract-enforced, per spec §12.
//  * REVOKED IS TERMINAL — a revoked version can never sign, encrypt, verify, or
//    decrypt again. No code path returns material for it.
//  * RETIRED IS VERIFIABLE, NOT USABLE — a retired version may still verify or
//    decrypt (so previously-issued evidence stays checkable until `notAfter`),
//    but can never produce NEW signatures or ciphertext.
//  * EXPIRY IS ABSOLUTE — `notAfter` passed ⇒ refused, retired or not.
//  * PRODUCTION REFUSES DEV — `assertProductionKeySeam` throws on a
//    `dev-inmemory` seam. There is no fallback and no silent downgrade.
//  * NO MATERIAL IN DIAGNOSTICS — errors carry keyId/version/purpose only. Key
//    material, plaintext, and ciphertext never appear in an Error message.
//
// NO KMS/HSM AVAILABILITY IS CLAIMED. A production provider is an external
// dependency (owner decision D2); this file defines the boundary, honestly
// labels the development double, and refuses to let the double into production.

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import type { IdentityProviderHealth } from './contracts.js';

// ---------------------------------------------------------------------------
// Closed vocabulary
// ---------------------------------------------------------------------------

/** Seam classification. Production posture requires `'external'`. */
export type KeySeamKind = 'dev-inmemory' | 'external';

/** Key purpose. Signing and encryption keys are never interchangeable. */
export type KeyPurpose = 'signing' | 'encryption';

/**
 * Key lifecycle status.
 * - ACTIVE: usable for new operations.
 * - RETIRED: superseded by a rotation; still verifiable/decryptable until
 *   `notAfter`, never usable for new operations.
 * - REVOKED: terminal. Nothing may use it again.
 */
export type KeyStatus = 'ACTIVE' | 'RETIRED' | 'REVOKED';

export const RECOGNIZED_KEY_STATUSES: readonly KeyStatus[] = Object.freeze(['ACTIVE', 'RETIRED', 'REVOKED']);

export const RECOGNIZED_KEY_PURPOSES: readonly KeyPurpose[] = Object.freeze(['signing', 'encryption']);

/** Closed failure vocabulary — no free-form reason strings. */
export type KeyManagementFailureCode =
  | 'KEY_INVALID_ARGUMENT'
  | 'KEY_UNKNOWN'
  | 'KEY_VERSION_UNKNOWN'
  | 'KEY_PURPOSE_MISMATCH'
  | 'KEY_REVOKED'
  | 'KEY_RETIRED'
  | 'KEY_EXPIRED'
  | 'KEY_MALFORMED'
  | 'KEY_SEAM_UNAVAILABLE'
  | 'KEY_SEAM_TIMEOUT'
  | 'KEY_UNAUTHORIZED'
  | 'KEY_DEV_PROVIDER_IN_PRODUCTION';

/**
 * The single error type for this seam.
 *
 * The message is deliberately restricted to identifiers: keyId, version,
 * purpose, and the failure code. It never contains key material, plaintext,
 * ciphertext, or an underlying provider's raw error text (which could embed a
 * connection string or a partial key).
 */
export class KeyManagementError extends Error {
  readonly code: KeyManagementFailureCode;
  readonly keyId?: string;
  readonly version?: number;
  readonly purpose?: KeyPurpose;

  constructor(
    code: KeyManagementFailureCode,
    detail: { readonly keyId?: string; readonly version?: number; readonly purpose?: KeyPurpose } = {},
  ) {
    // Identifier-only by construction. `detail` is a closed shape, so a caller
    // cannot smuggle material into the message.
    super(
      `${code}` +
        (detail.keyId !== undefined ? ` keyId=${detail.keyId}` : '') +
        (detail.version !== undefined ? ` version=${detail.version}` : '') +
        (detail.purpose !== undefined ? ` purpose=${detail.purpose}` : '') +
        ' (fail-closed)',
    );
    this.name = 'KeyManagementError';
    this.code = code;
    this.keyId = detail.keyId;
    this.version = detail.version;
    this.purpose = detail.purpose;
  }
}

// ---------------------------------------------------------------------------
// Contract (spec §12)
// ---------------------------------------------------------------------------

/** A key reference: the ONLY key representation that crosses a boundary. */
export interface KeyRef {
  readonly keyId: string;
  readonly version: number;
  readonly purpose: KeyPurpose;
  readonly status: KeyStatus;
  /** Epoch ms. A RETIRED key stops being verifiable at this instant. */
  readonly notAfter?: number;
  readonly algorithm: string;
}

/** Produces NEW signatures. Obtainable only for an ACTIVE signing key. */
export interface Signer {
  readonly keyId: string;
  readonly version: number;
  readonly purpose: 'signing';
  readonly algorithm: string;
  sign(payload: Uint8Array | string): Promise<Uint8Array>;
}

/**
 * Checks signatures. Obtainable for an ACTIVE or unexpired RETIRED signing key;
 * NEVER for a REVOKED one. This is what keeps previously-issued evidence
 * verifiable across a rotation, per spec §12.
 */
export interface Verifier {
  readonly keyId: string;
  readonly version: number;
  readonly purpose: 'signing';
  readonly algorithm: string;
  verify(payload: Uint8Array | string, signature: Uint8Array): Promise<boolean>;
}

/** Produces NEW ciphertext. Obtainable only for an ACTIVE encryption key. */
export interface Encryptor {
  readonly keyId: string;
  readonly version: number;
  readonly purpose: 'encryption';
  readonly algorithm: string;
  /**
   * `context` binds the ciphertext to a purpose/tenant/principal string. A
   * ciphertext sealed under one context will not open under another — this is
   * what makes identifier manipulation useless (see `secret-material.ts`).
   */
  encrypt(plaintext: Uint8Array | string, context: string): Promise<SealedBlob>;
}

/**
 * Opens ciphertext. Obtainable for an ACTIVE or unexpired RETIRED encryption
 * key; NEVER for a REVOKED one. The sealing context must match exactly.
 */
export interface Decryptor {
  readonly keyId: string;
  readonly version: number;
  readonly purpose: 'encryption';
  readonly algorithm: string;
  decrypt(sealed: SealedBlob, context: string): Promise<Uint8Array>;
}

/** Ciphertext plus everything needed to route it — but never the key. */
export interface SealedBlob {
  readonly keyId: string;
  readonly version: number;
  readonly algorithm: string;
  /** base64url iv */
  readonly iv: string;
  /** base64url ciphertext */
  readonly ciphertext: string;
  /** base64url GCM auth tag */
  readonly tag: string;
  /** The context this blob was sealed under (AAD). Not secret. */
  readonly context: string;
}

/**
 * The key-management seam (spec §12).
 *
 * PROVIDER-NEUTRAL means nothing here DEPENDS ON a vendor: the seam is defined
 * solely by this interface plus `ExternalKeyProviderAdapter`, so a cloud KMS, an
 * HSM, a secrets manager, or a Vault-like backend can each implement the adapter
 * without the seam changing. There is no vendor import, no vendor type, and no
 * vendor-specific branch anywhere in this module.
 *
 * Accuracy note: vendor class names (KMS, HSM) and one product name used as an
 * example ("Vault-like") do appear in these comments. An earlier revision of
 * this comment claimed "Nothing here names a vendor", which was not true — the
 * accurate claim is the one above: no vendor is depended upon.
 */
export interface KeyManagementSeam {
  /** Seam identifier (for audit citations). Never secret. */
  readonly id: string;
  /** Classification. Production refuses `'dev-inmemory'`. */
  readonly kind: KeySeamKind;

  listKeys(purpose: KeyPurpose): Promise<readonly KeyRef[]>;

  /** ACTIVE signing key only. */
  getSigner(keyId: string, version: number): Promise<Signer>;
  /** ACTIVE or unexpired RETIRED signing key. Never REVOKED. */
  getVerifier(keyId: string, version: number): Promise<Verifier>;
  /** ACTIVE encryption key only. */
  getEncryptor(keyId: string, version: number): Promise<Encryptor>;
  /** ACTIVE or unexpired RETIRED encryption key. Never REVOKED. */
  getDecryptor(keyId: string, version: number): Promise<Decryptor>;

  /**
   * Creates `version + 1` as ACTIVE and RETIRES the previously-active version.
   * The retired version stays verifiable until its `notAfter`.
   */
  rotate(keyId: string): Promise<KeyRef>;

  /** Terminal. The version can never be used again. */
  revoke(keyId: string, version: number): Promise<void>;

  /** Surfaces at boot under the production posture (P2-INV-08). */
  health(): Promise<IdentityProviderHealth>;
}

/**
 * The external-provider adapter surface. A real KMS/HSM/secret-manager
 * integration implements THIS, not the seam directly, so the seam's security
 * rules (purpose separation, revocation, expiry) are enforced in one place
 * rather than re-implemented per vendor.
 */
export interface ExternalKeyProviderAdapter {
  readonly id: string;
  /**
   * Fetch raw key material for `(keyId, version, purpose)`.
   * MUST throw on any failure — never return undefined, never fall back.
   * The returned bytes are held only inside the seam and are never logged.
   */
  fetchKeyMaterial(keyId: string, version: number, purpose: KeyPurpose): Promise<Uint8Array>;
  /** Optional liveness probe. Absent ⇒ health() reports 'degraded', never 'healthy'. */
  probe?(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isKeyPurpose(value: unknown): value is KeyPurpose {
  return value === 'signing' || value === 'encryption';
}

/** True when the seam is a declared development implementation. */
export function isDevelopmentKeySeam(seam: KeyManagementSeam | undefined): boolean {
  if (!seam || typeof seam !== 'object') return true;
  return seam.kind !== 'external';
}

/**
 * P2-INV-08 — production refuses a development key seam.
 *
 * There is no fallback path: this throws, and the caller (the production boot
 * invariant) fails closed. A production composition whose identity-key
 * configuration came from a development source is refused outright, per spec
 * §12 "Bootstrap trust".
 */
export function assertProductionKeySeam(seam: KeyManagementSeam | undefined): asserts seam is KeyManagementSeam {
  if (!seam || typeof seam !== 'object') {
    throw new KeyManagementError('KEY_SEAM_UNAVAILABLE');
  }
  if (seam.kind !== 'external') {
    throw new KeyManagementError('KEY_DEV_PROVIDER_IN_PRODUCTION');
  }
}

function assertValidVersion(version: unknown): asserts version is number {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new KeyManagementError('KEY_INVALID_ARGUMENT');
  }
}

function assertValidKeyId(keyId: unknown): asserts keyId is string {
  if (typeof keyId !== 'string' || keyId.length === 0 || keyId.length > 256) {
    throw new KeyManagementError('KEY_INVALID_ARGUMENT');
  }
}

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  throw new KeyManagementError('KEY_INVALID_ARGUMENT');
}

// ---------------------------------------------------------------------------
// Development double
// ---------------------------------------------------------------------------

interface DevKeyEntry {
  readonly keyId: string;
  readonly version: number;
  readonly purpose: KeyPurpose;
  readonly algorithm: string;
  status: KeyStatus;
  notAfter?: number;
  /** Private key material. NEVER leaves this module and NEVER enters an error. */
  readonly signing?: { readonly pem: string };
  readonly encryption?: { readonly key: Uint8Array };
}

const DEV_SIGNING_ALGORITHM = 'ES256';
const DEV_ENCRYPTION_ALGORITHM = 'A256GCM';

/**
 * In-process development/test key seam.
 *
 * Explicitly classified `kind: 'dev-inmemory'` so the production posture refuses
 * it. Key material lives only in this process and is lost on restart — the
 * honest posture for a development double, and the reason it must never be
 * promoted. It performs REAL cryptography (ES256 / AES-256-GCM) so the seam's
 * security rules are exercised genuinely rather than stubbed.
 */
export class InMemoryKeyManagementSeam implements KeyManagementSeam {
  readonly id = 's7-inmemory-key-seam';
  readonly kind = 'dev-inmemory' as const;

  readonly #entries = new Map<string, DevKeyEntry>();
  #healthy = true;

  /** Test hook: simulate a provider outage. Production code never calls this. */
  setUnavailable(unavailable: boolean): void {
    this.#healthy = !unavailable;
  }

  #assertAvailable(): void {
    if (!this.#healthy) throw new KeyManagementError('KEY_SEAM_UNAVAILABLE');
  }

  /** Create the first (version 1) key of a given purpose. */
  async createKey(keyId: string, purpose: KeyPurpose): Promise<KeyRef> {
    this.#assertAvailable();
    assertValidKeyId(keyId);
    if (!isKeyPurpose(purpose)) throw new KeyManagementError('KEY_INVALID_ARGUMENT', { keyId, purpose: undefined });
    if ([...this.#entries.values()].some((entry) => entry.keyId === keyId)) {
      throw new KeyManagementError('KEY_INVALID_ARGUMENT', { keyId });
    }
    return this.#mint(keyId, 1, purpose);
  }

  #mint(keyId: string, version: number, purpose: KeyPurpose): KeyRef {
    const entry: DevKeyEntry =
      purpose === 'signing'
        ? {
            keyId,
            version,
            purpose,
            algorithm: DEV_SIGNING_ALGORITHM,
            status: 'ACTIVE',
            signing: { pem: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
          }
        : {
            keyId,
            version,
            purpose,
            algorithm: DEV_ENCRYPTION_ALGORITHM,
            status: 'ACTIVE',
            encryption: { key: new Uint8Array(randomBytes(32)) },
          };
    this.#entries.set(`${keyId}::${version}`, entry);
    return toKeyRef(entry);
  }

  #lookup(keyId: string, version: number): DevKeyEntry {
    this.#assertAvailable();
    assertValidKeyId(keyId);
    assertValidVersion(version);
    const entry = this.#entries.get(`${keyId}::${version}`);
    // An unknown key and an unknown version are deliberately
    // indistinguishable to a caller holding neither — no existence oracle.
    if (!entry) throw new KeyManagementError('KEY_VERSION_UNKNOWN', { keyId, version });
    return entry;
  }

  #assertPurpose(entry: DevKeyEntry, purpose: KeyPurpose): void {
    if (entry.purpose !== purpose) {
      throw new KeyManagementError('KEY_PURPOSE_MISMATCH', {
        keyId: entry.keyId,
        version: entry.version,
        purpose: entry.purpose,
      });
    }
  }

  #assertNotRevoked(entry: DevKeyEntry): void {
    if (entry.status === 'REVOKED') {
      throw new KeyManagementError('KEY_REVOKED', { keyId: entry.keyId, version: entry.version, purpose: entry.purpose });
    }
  }

  #assertNotExpired(entry: DevKeyEntry, now: number): void {
    if (entry.notAfter !== undefined && now >= entry.notAfter) {
      throw new KeyManagementError('KEY_EXPIRED', { keyId: entry.keyId, version: entry.version, purpose: entry.purpose });
    }
  }

  async listKeys(purpose: KeyPurpose): Promise<readonly KeyRef[]> {
    this.#assertAvailable();
    if (!isKeyPurpose(purpose)) throw new KeyManagementError('KEY_INVALID_ARGUMENT');
    return [...this.#entries.values()].filter((entry) => entry.purpose === purpose).map(toKeyRef);
  }

  async getSigner(keyId: string, version: number): Promise<Signer> {
    const entry = this.#lookup(keyId, version);
    this.#assertPurpose(entry, 'signing');
    this.#assertNotRevoked(entry);
    this.#assertNotExpired(entry, Date.now());
    // A RETIRED key must never produce a NEW signature.
    if (entry.status !== 'ACTIVE') {
      throw new KeyManagementError('KEY_RETIRED', { keyId: entry.keyId, version: entry.version, purpose: entry.purpose });
    }
    const pem = entry.signing?.pem;
    if (!pem) throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'signing' });
    const privateKey = createPrivateKey(pem);
    return {
      keyId: entry.keyId,
      version: entry.version,
      purpose: 'signing',
      algorithm: entry.algorithm,
      async sign(payload) {
        return new Uint8Array(createSign('sha256').update(toBytes(payload)).sign(privateKey));
      },
    };
  }

  async getVerifier(keyId: string, version: number): Promise<Verifier> {
    const entry = this.#lookup(keyId, version);
    this.#assertPurpose(entry, 'signing');
    this.#assertNotRevoked(entry);
    // Verification is permitted for RETIRED keys until notAfter — this is what
    // keeps previously-issued evidence checkable across a rotation.
    this.#assertNotExpired(entry, Date.now());
    const pem = entry.signing?.pem;
    if (!pem) throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'signing' });
    const publicKey = createPublicKey(createPrivateKey(pem));
    return {
      keyId: entry.keyId,
      version: entry.version,
      purpose: 'signing',
      algorithm: entry.algorithm,
      async verify(payload, signature) {
        try {
          return createVerify('sha256').update(toBytes(payload)).verify(publicKey, toBytes(signature));
        } catch {
          // A malformed signature is a verification FAILURE, not an exception
          // and not a seam fault. It must never leak material either.
          return false;
        }
      },
    };
  }

  async getEncryptor(keyId: string, version: number): Promise<Encryptor> {
    const entry = this.#lookup(keyId, version);
    this.#assertPurpose(entry, 'encryption');
    this.#assertNotRevoked(entry);
    this.#assertNotExpired(entry, Date.now());
    if (entry.status !== 'ACTIVE') {
      throw new KeyManagementError('KEY_RETIRED', { keyId: entry.keyId, version: entry.version, purpose: entry.purpose });
    }
    const key = entry.encryption?.key;
    if (!key || key.length !== 32) throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'encryption' });
    return {
      keyId: entry.keyId,
      version: entry.version,
      purpose: 'encryption',
      algorithm: entry.algorithm,
      async encrypt(plaintext, context) {
        if (typeof context !== 'string' || context.length === 0) {
          throw new KeyManagementError('KEY_INVALID_ARGUMENT', { keyId: entry.keyId, version: entry.version, purpose: 'encryption' });
        }
        const iv = new Uint8Array(randomBytes(12));
        const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv));
        // The context is bound as additional authenticated data, so a blob
        // sealed for one tenant/principal/purpose cannot be opened for another.
        cipher.setAAD(new TextEncoder().encode(context));
        const ciphertext = Buffer.concat([cipher.update(toBytes(plaintext)), cipher.final()]);
        const tag = cipher.getAuthTag();
        return {
          keyId: entry.keyId,
          version: entry.version,
          algorithm: entry.algorithm,
          iv: Buffer.from(iv).toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
          tag: Buffer.from(tag).toString('base64url'),
          context,
        };
      },
    };
  }

  async getDecryptor(keyId: string, version: number): Promise<Decryptor> {
    const entry = this.#lookup(keyId, version);
    this.#assertPurpose(entry, 'encryption');
    this.#assertNotRevoked(entry);
    // Decryption of previously-sealed material is permitted for RETIRED keys
    // until notAfter; REVOKED is terminal.
    this.#assertNotExpired(entry, Date.now());
    const key = entry.encryption?.key;
    if (!key || key.length !== 32) throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'encryption' });
    return {
      keyId: entry.keyId,
      version: entry.version,
      purpose: 'encryption',
      algorithm: entry.algorithm,
      async decrypt(sealed, context) {
        if (!sealed || typeof sealed !== 'object') throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'encryption' });
        if (typeof context !== 'string' || context.length === 0) {
          throw new KeyManagementError('KEY_INVALID_ARGUMENT', { keyId: entry.keyId, version: entry.version, purpose: 'encryption' });
        }
        if (sealed.keyId !== entry.keyId || sealed.version !== entry.version) {
          // The blob names a different key version: refuse rather than
          // silently decrypting under the wrong key.
          throw new KeyManagementError('KEY_VERSION_UNKNOWN', { keyId: sealed.keyId, version: sealed.version });
        }
        if (sealed.context !== context) {
          // Context mismatch is an authorization-class failure, not a crypto
          // error: the caller is asking to open someone else's blob.
          throw new KeyManagementError('KEY_UNAUTHORIZED', { keyId, version, purpose: 'encryption' });
        }
        try {
          const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(sealed.iv, 'base64url'));
          decipher.setAAD(new TextEncoder().encode(context));
          decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
          return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]));
        } catch {
          // Tampered ciphertext / wrong tag ⇒ malformed. The underlying
          // OpenSSL message is NOT propagated (it can echo input bytes).
          throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'encryption' });
        }
      },
    };
  }

  async rotate(keyId: string): Promise<KeyRef> {
    this.#assertAvailable();
    assertValidKeyId(keyId);
    const versions = [...this.#entries.values()].filter((entry) => entry.keyId === keyId);
    if (versions.length === 0) throw new KeyManagementError('KEY_UNKNOWN', { keyId });
    const active = versions.find((entry) => entry.status === 'ACTIVE');
    if (!active) throw new KeyManagementError('KEY_UNKNOWN', { keyId });
    const now = Date.now();
    // Retire the outgoing version: still verifiable/decryptable until notAfter,
    // never usable for new operations.
    active.status = 'RETIRED';
    active.notAfter = now + DEFAULT_RETIRED_KEY_GRACE_MS;
    return this.#mint(keyId, active.version + 1, active.purpose);
  }

  async revoke(keyId: string, version: number): Promise<void> {
    this.#assertAvailable();
    const entry = this.#lookup(keyId, version);
    entry.status = 'REVOKED';
  }

  async health(): Promise<IdentityProviderHealth> {
    return {
      status: this.#healthy ? 'healthy' : 'unavailable',
      checkedAt: Date.now(),
      // Secret-free by construction: counts and kind only.
      detail: `s7 dev-inmemory key seam; keys=${this.#entries.size}`,
    };
  }
}

/** How long a retired key stays verifiable after a rotation. */
export const DEFAULT_RETIRED_KEY_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

function toKeyRef(entry: DevKeyEntry): KeyRef {
  return {
    keyId: entry.keyId,
    version: entry.version,
    purpose: entry.purpose,
    status: entry.status,
    ...(entry.notAfter !== undefined ? { notAfter: entry.notAfter } : {}),
    algorithm: entry.algorithm,
  };
}

/**
 * Wraps an external provider adapter in the seam, so a KMS/HSM/secret-manager
 * integration inherits every security rule above instead of re-implementing
 * them. The adapter supplies material; the seam enforces purpose separation,
 * revocation, expiry, and secret-free diagnostics.
 *
 * NOTE (residual risk, recorded honestly): `kind: 'external'` is a DECLARATION.
 * The platform cannot cryptographically prove an adapter is backed by a real
 * KMS/HSM. The operator remains accountable for that — the same residual risk
 * already recorded for the A-01 material provider.
 */
export class ExternalKeyManagementSeam implements KeyManagementSeam {
  readonly id: string;
  readonly kind = 'external' as const;

  readonly #adapter: ExternalKeyProviderAdapter;
  readonly #refs = new Map<string, KeyRef>();
  readonly #cache = new Map<string, Uint8Array>();

  constructor(adapter: ExternalKeyProviderAdapter) {
    if (!adapter || typeof adapter !== 'object' || typeof adapter.fetchKeyMaterial !== 'function') {
      throw new KeyManagementError('KEY_INVALID_ARGUMENT');
    }
    this.id = `external:${adapter.id}`;
    this.#adapter = adapter;
  }

  /** Register a key reference the external system already holds. */
  registerKey(ref: KeyRef): void {
    if (!ref || typeof ref.keyId !== 'string' || ref.keyId.length === 0) throw new KeyManagementError('KEY_INVALID_ARGUMENT');
    if (!isKeyPurpose(ref.purpose)) throw new KeyManagementError('KEY_INVALID_ARGUMENT', { keyId: ref.keyId, purpose: undefined });
    assertValidVersion(ref.version);
    this.#refs.set(`${ref.keyId}::${ref.version}`, ref);
  }

  #lookup(keyId: string, version: number): KeyRef {
    assertValidKeyId(keyId);
    assertValidVersion(version);
    const ref = this.#refs.get(`${keyId}::${version}`);
    if (!ref) throw new KeyManagementError('KEY_VERSION_UNKNOWN', { keyId, version });
    return ref;
  }

  async #material(keyId: string, version: number, purpose: KeyPurpose): Promise<Uint8Array> {
    const cacheKey = `${keyId}::${version}::${purpose}`;
    const cached = this.#cache.get(cacheKey);
    if (cached) return cached;
    let material: Uint8Array;
    try {
      material = await this.#adapter.fetchKeyMaterial(keyId, version, purpose);
    } catch {
      // The adapter's own error is NOT propagated: it could contain an
      // endpoint, a connection string, or partial key bytes.
      throw new KeyManagementError('KEY_SEAM_UNAVAILABLE', { keyId, version, purpose });
    }
    if (!(material instanceof Uint8Array) || material.length === 0) {
      throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose });
    }
    this.#cache.set(cacheKey, material);
    return material;
  }

  async listKeys(purpose: KeyPurpose): Promise<readonly KeyRef[]> {
    if (!isKeyPurpose(purpose)) throw new KeyManagementError('KEY_INVALID_ARGUMENT');
    return [...this.#refs.values()].filter((ref) => ref.purpose === purpose);
  }

  #guard(ref: KeyRef, purpose: KeyPurpose, allowRetired: boolean): void {
    if (ref.purpose !== purpose) {
      throw new KeyManagementError('KEY_PURPOSE_MISMATCH', { keyId: ref.keyId, version: ref.version, purpose: ref.purpose });
    }
    if (ref.status === 'REVOKED') {
      throw new KeyManagementError('KEY_REVOKED', { keyId: ref.keyId, version: ref.version, purpose: ref.purpose });
    }
    if (ref.notAfter !== undefined && Date.now() >= ref.notAfter) {
      throw new KeyManagementError('KEY_EXPIRED', { keyId: ref.keyId, version: ref.version, purpose: ref.purpose });
    }
    if (!allowRetired && ref.status !== 'ACTIVE') {
      throw new KeyManagementError('KEY_RETIRED', { keyId: ref.keyId, version: ref.version, purpose: ref.purpose });
    }
  }

  async getSigner(keyId: string, version: number): Promise<Signer> {
    const ref = this.#lookup(keyId, version);
    this.#guard(ref, 'signing', false);
    const material = await this.#material(keyId, version, 'signing');
    const privateKey = createPrivateKey({ key: Buffer.from(material), format: 'pem', type: 'pkcs8' });
    return {
      keyId: ref.keyId,
      version: ref.version,
      purpose: 'signing',
      algorithm: ref.algorithm,
      async sign(payload) {
        return new Uint8Array(createSign('sha256').update(toBytes(payload)).sign(privateKey));
      },
    };
  }

  async getVerifier(keyId: string, version: number): Promise<Verifier> {
    const ref = this.#lookup(keyId, version);
    this.#guard(ref, 'signing', true);
    const material = await this.#material(keyId, version, 'signing');
    // The stored material is the PKCS#8 private key; derive the public half
    // from it exactly as the InMemory seam does (line 442).
    const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(material), format: 'pem', type: 'pkcs8' }));
    return {
      keyId: ref.keyId,
      version: ref.version,
      purpose: 'signing',
      algorithm: ref.algorithm,
      async verify(payload, signature) {
        try {
          return createVerify('sha256').update(toBytes(payload)).verify(publicKey, toBytes(signature));
        } catch {
          return false;
        }
      },
    };
  }

  async getEncryptor(keyId: string, version: number): Promise<Encryptor> {
    const ref = this.#lookup(keyId, version);
    this.#guard(ref, 'encryption', false);
    const material = await this.#material(keyId, version, 'encryption');
    if (material.length !== 32) throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'encryption' });
    return {
      keyId: ref.keyId,
      version: ref.version,
      purpose: 'encryption',
      algorithm: ref.algorithm,
      async encrypt(plaintext, context) {
        if (typeof context !== 'string' || context.length === 0) {
          throw new KeyManagementError('KEY_INVALID_ARGUMENT', { keyId: ref.keyId, version: ref.version, purpose: 'encryption' });
        }
        const iv = new Uint8Array(randomBytes(12));
        const cipher = createCipheriv('aes-256-gcm', Buffer.from(material), Buffer.from(iv));
        cipher.setAAD(new TextEncoder().encode(context));
        const ciphertext = Buffer.concat([cipher.update(toBytes(plaintext)), cipher.final()]);
        return {
          keyId: ref.keyId,
          version: ref.version,
          algorithm: ref.algorithm,
          iv: Buffer.from(iv).toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
          tag: Buffer.from(cipher.getAuthTag()).toString('base64url'),
          context,
        };
      },
    };
  }

  async getDecryptor(keyId: string, version: number): Promise<Decryptor> {
    const ref = this.#lookup(keyId, version);
    this.#guard(ref, 'encryption', true);
    const material = await this.#material(keyId, version, 'encryption');
    if (material.length !== 32) throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'encryption' });
    return {
      keyId: ref.keyId,
      version: ref.version,
      purpose: 'encryption',
      algorithm: ref.algorithm,
      async decrypt(sealed, context) {
        if (!sealed || typeof sealed !== 'object') throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'encryption' });
        if (typeof context !== 'string' || context.length === 0) {
          throw new KeyManagementError('KEY_INVALID_ARGUMENT', { keyId: ref.keyId, version: ref.version, purpose: 'encryption' });
        }
        if (sealed.keyId !== ref.keyId || sealed.version !== ref.version) {
          throw new KeyManagementError('KEY_VERSION_UNKNOWN', { keyId: sealed.keyId, version: sealed.version });
        }
        if (sealed.context !== context) {
          throw new KeyManagementError('KEY_UNAUTHORIZED', { keyId, version, purpose: 'encryption' });
        }
        try {
          const decipher = createDecipheriv('aes-256-gcm', Buffer.from(material), Buffer.from(sealed.iv, 'base64url'));
          decipher.setAAD(new TextEncoder().encode(context));
          decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
          return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]));
        } catch {
          throw new KeyManagementError('KEY_MALFORMED', { keyId, version, purpose: 'encryption' });
        }
      },
    };
  }

  async rotate(keyId: string): Promise<KeyRef> {
    assertValidKeyId(keyId);
    const versions = [...this.#refs.values()].filter((ref) => ref.keyId === keyId);
    if (versions.length === 0) throw new KeyManagementError('KEY_UNKNOWN', { keyId });
    const active = versions.find((ref) => ref.status === 'ACTIVE');
    if (!active) throw new KeyManagementError('KEY_UNKNOWN', { keyId });
    // The external system owns the actual key creation; the seam records the
    // lifecycle transition. An adapter that cannot rotate must throw.
    const next: KeyRef = {
      keyId,
      version: active.version + 1,
      purpose: active.purpose,
      status: 'ACTIVE',
      algorithm: active.algorithm,
    };
    this.registerKey({ ...active, status: 'RETIRED', notAfter: Date.now() + DEFAULT_RETIRED_KEY_GRACE_MS });
    this.registerKey(next);
    return next;
  }

  async revoke(keyId: string, version: number): Promise<void> {
    const ref = this.#lookup(keyId, version);
    this.registerKey({ ...ref, status: 'REVOKED' });
    this.#cache.delete(`${keyId}::${version}::signing`);
    this.#cache.delete(`${keyId}::${version}::encryption`);
  }

  async health(): Promise<IdentityProviderHealth> {
    if (typeof this.#adapter.probe !== 'function') {
      // No liveness probe ⇒ we cannot claim 'healthy'. Honest 'degraded'.
      return { status: 'degraded', checkedAt: Date.now(), detail: 'external key adapter exposes no health probe' };
    }
    try {
      const ok = await this.#adapter.probe();
      return {
        status: ok ? 'healthy' : 'unavailable',
        checkedAt: Date.now(),
        detail: `external key adapter ${this.#adapter.id}`,
      };
    } catch {
      return { status: 'unavailable', checkedAt: Date.now(), detail: `external key adapter ${this.#adapter.id} probe failed` };
    }
  }
}
