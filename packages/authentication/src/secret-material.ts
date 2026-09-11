// P2-S7 — Secret-material seam (spec §12 consumers: TOTP secrets (S5),
// break-glass sealed credential (S6), future session-assertion signing).
//
// This is the boundary S5 and S6 consume so that neither needs a second
// secret-storage architecture. It is built ON the key-management seam
// (`key-management.ts`): secrets are sealed with a seam-held encryption key, so
// plaintext never rests in the database and never rests in this process beyond
// the single call that needs it.
//
// SECURITY INVARIANTS ENFORCED HERE (not by callers):
//
//  * CONTEXT BINDING — the sealing context is derived from
//    (tenantId, principalId, purpose, secretId) and bound as GCM additional
//    authenticated data. A blob sealed for one binding CANNOT be opened under
//    another, so manipulating an identifier yields a cryptographic failure and
//    not someone else's secret.
//  * NO IDENTIFIER ORACLE — a wrong tenant, a wrong principal, a wrong purpose,
//    and a non-existent secret are all reported as `SECRET_UNKNOWN`. Existence
//    and ownership are never distinguishable to a caller that has not proven
//    the binding.
//  * NO AMBIENT AUTHORITY — the acting principal is an explicit argument on
//    every operation. Nothing is read from a process-local "current user".
//  * TENANT ISOLATION AT THE DATA PLANE — reads and writes go through the
//    tenant-scoped storage scope (PostgreSQL RLS), exactly as the delegation
//    and privilege planes do. No cross-tenant query path exists.
//  * REVOCATION IS TERMINAL; ROTATION RETIRES.
//  * PRODUCTION REFUSES DEV — the dev seam is `kind: 'dev-inmemory'` and
//    `assertProductionSecretSeam` refuses it. No fallback.
//  * ACCESS IS AUDITED WITHOUT THE SECRET — every operation records actor,
//    tenant, purpose, credential id, provider id, result, correlation id and
//    timestamp. NEVER the material, never the sealed blob, never a key.
//  * AUDIT IS NOT BEST-EFFORT — the audit row is written in the SAME
//    transaction as the data operation, so an operation that cannot be audited
//    does not happen. Fail-closed is never weakened to improve audit
//    availability; if anything it is tightened.
//  * NO MATERIAL IN DIAGNOSTICS — errors carry secretId/version/purpose only.

import { randomUUID } from 'node:crypto';
import { StorageModule, type SecurityCollectionSource, type StorageWriteScope } from '@jataqi/storage';
import type { IdentityProviderHealth } from './contracts.js';
import { KeyManagementError, type KeyManagementSeam, type SealedBlob } from './key-management.js';

// ---------------------------------------------------------------------------
// Closed vocabulary
// ---------------------------------------------------------------------------

/**
 * The purposes this seam will seal for. Closed and explicit: an unspecified
 * purpose is refused, so a new consumer must be added deliberately rather than
 * reusing an existing binding.
 */
export type SecretPurpose = 'totp' | 'break-glass-seal' | 'session-assertion';

export const RECOGNIZED_SECRET_PURPOSES: readonly SecretPurpose[] = Object.freeze([
  'totp',
  'break-glass-seal',
  'session-assertion',
]);

export type SecretStatus = 'ACTIVE' | 'RETIRED' | 'REVOKED';

export type SecretOperation = 'seal' | 'open' | 'rotate' | 'revoke' | 'list';

export type SecretAccessResult =
  | 'SUCCESS'
  | 'REFUSED_INVALID_ARGUMENT'
  | 'REFUSED_UNKNOWN'
  | 'REFUSED_REVOKED'
  | 'MALFORMED'
  | 'SEAM_UNAVAILABLE'
  | 'CONFLICT';

export type SecretMaterialFailureCode =
  | 'SECRET_INVALID_ARGUMENT'
  /** Non-existent, wrong tenant, wrong principal, or wrong purpose — deliberately indistinguishable. */
  | 'SECRET_UNKNOWN'
  | 'SECRET_REVOKED'
  | 'SECRET_CONFLICT'
  | 'SECRET_SEAM_UNAVAILABLE'
  | 'SECRET_DEV_PROVIDER_IN_PRODUCTION'
  | 'SECRET_MALFORMED';

/** Identifier-only error. Never carries plaintext, sealed data, or key material. */
export class SecretMaterialError extends Error {
  readonly code: SecretMaterialFailureCode;
  readonly secretId?: string;
  readonly version?: number;
  readonly purpose?: SecretPurpose;

  constructor(
    code: SecretMaterialFailureCode,
    detail: { readonly secretId?: string; readonly version?: number; readonly purpose?: SecretPurpose } = {},
  ) {
    super(
      `${code}` +
        (detail.secretId !== undefined ? ` secretId=${detail.secretId}` : '') +
        (detail.version !== undefined ? ` version=${detail.version}` : '') +
        (detail.purpose !== undefined ? ` purpose=${detail.purpose}` : '') +
        ' (fail-closed)',
    );
    this.name = 'SecretMaterialError';
    this.code = code;
    this.secretId = detail.secretId;
    this.version = detail.version;
    this.purpose = detail.purpose;
  }
}

export function isSecretPurpose(value: unknown): value is SecretPurpose {
  return typeof value === 'string' && (RECOGNIZED_SECRET_PURPOSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Documents and references
// ---------------------------------------------------------------------------

export const SECRET_MATERIAL_COLLECTION = 'identity.secret-material';
export const SECRET_ACCESS_COLLECTION = 'identity.secret-material-access';

/**
 * The durable row. Holds ONLY the sealed blob and its binding metadata —
 * never plaintext. Safe to persist, replicate, and back up.
 */
export interface SecretMaterialDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly purpose: SecretPurpose;
  readonly secretId: string;
  readonly version: number;
  readonly status: SecretStatus;
  readonly sealed: SealedBlob;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt?: number;
}

/**
 * The access-audit row. Identifiers and outcome only — by construction there
 * is no field in which material could be carried.
 */
export interface SecretAccessRecord {
  readonly id: string;
  /** The tenant the operation was scoped to. */
  readonly tenantId: string;
  /** Who asked. Always explicit; never ambient. */
  readonly actorPrincipalId: string;
  /** Whose secret was targeted (the caller's claim). */
  readonly principalId: string;
  /** Absent for `list`, which is not purpose-scoped. Never a placeholder. */
  readonly purpose?: SecretPurpose;
  /** Absent for `list`. Never a wildcard sentinel. */
  readonly secretId?: string;
  readonly version?: number;
  readonly operation: SecretOperation;
  readonly result: SecretAccessResult;
  /** Key-seam identifier, for citing the provider without naming a vendor. */
  readonly providerId: string;
  /** Sealing key identifier + version, when one was resolved. */
  readonly keyId?: string;
  readonly keyVersion?: number;
  readonly correlationId: string;
  readonly at: number;
}

/** Optional hook so a composition can also route access into its own stream. */
export interface SecretAccessAuditSink {
  record(entry: SecretAccessRecord): Promise<void>;
}

/** What a caller receives instead of the secret: a reference, never material. */
export interface SecretRef {
  readonly secretId: string;
  readonly version: number;
  readonly purpose: SecretPurpose;
  readonly status: SecretStatus;
  /** Identifier of the seam key that sealed this version (for audit). */
  readonly sealingKeyId: string;
  readonly sealingKeyVersion: number;
}

export interface SealSecretInput {
  readonly tenantId: string;
  /** The acting principal. Required — this seam has no ambient authority. */
  readonly actorPrincipalId: string;
  readonly principalId: string;
  readonly purpose: SecretPurpose;
  readonly secretId: string;
  /** Plaintext, consumed once and never retained, logged, or returned. */
  readonly material: Uint8Array;
  readonly correlationId?: string;
}

export interface OpenSecretInput {
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly principalId: string;
  readonly purpose: SecretPurpose;
  readonly secretId: string;
  /** Omit to open the ACTIVE version. */
  readonly version?: number;
  readonly correlationId?: string;
}

export interface RotateSecretInput {
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly principalId: string;
  readonly purpose: SecretPurpose;
  readonly secretId: string;
  readonly material: Uint8Array;
  readonly correlationId?: string;
}

export interface RevokeSecretInput {
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly principalId: string;
  /** Purpose is part of the binding: a revoke must name the purpose it means. */
  readonly purpose: SecretPurpose;
  readonly secretId: string;
  readonly version: number;
  readonly correlationId?: string;
}

// ---------------------------------------------------------------------------
// Context derivation
// ---------------------------------------------------------------------------

/**
 * Derive the sealing context (GCM additional authenticated data).
 *
 * Every element of the security binding is included, so a blob cannot be
 * re-targeted by substituting any one of them. Exported for test assertion —
 * the function itself is pure and secret-free.
 */
export function deriveSecretContext(input: {
  readonly tenantId: string;
  readonly principalId: string;
  readonly purpose: SecretPurpose;
  readonly secretId: string;
}): string {
  return `s7|${input.tenantId}|${input.principalId}|${input.purpose}|${input.secretId}`;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** True when the underlying key seam is a declared development implementation. */
export function isDevelopmentSecretSeam(seam: KeyManagementSeam | undefined): boolean {
  return !seam || typeof seam !== 'object' || seam.kind !== 'external';
}

/**
 * P2-INV-08 (secret half) — production refuses a development seam.
 * Throws; there is no fallback and no silent downgrade to in-memory behavior.
 */
export function assertProductionSecretSeam(seam: KeyManagementSeam | undefined): asserts seam is KeyManagementSeam {
  if (!seam || typeof seam !== 'object') throw new SecretMaterialError('SECRET_SEAM_UNAVAILABLE');
  if (seam.kind !== 'external') throw new SecretMaterialError('SECRET_DEV_PROVIDER_IN_PRODUCTION');
}

function assertBinding(input: {
  readonly tenantId: unknown;
  readonly actorPrincipalId: unknown;
  readonly principalId: unknown;
  readonly purpose: unknown;
  readonly secretId: unknown;
}): void {
  if (typeof input.tenantId !== 'string' || input.tenantId.length === 0) {
    throw new SecretMaterialError('SECRET_INVALID_ARGUMENT');
  }
  // An explicit actor is mandatory: no operation may proceed on ambient
  // authority, so a missing actor is an argument failure, not an anonymous
  // access.
  if (typeof input.actorPrincipalId !== 'string' || input.actorPrincipalId.length === 0) {
    throw new SecretMaterialError('SECRET_INVALID_ARGUMENT');
  }
  if (typeof input.principalId !== 'string' || input.principalId.length === 0) {
    throw new SecretMaterialError('SECRET_INVALID_ARGUMENT');
  }
  if (typeof input.secretId !== 'string' || input.secretId.length === 0 || input.secretId.length > 256) {
    throw new SecretMaterialError('SECRET_INVALID_ARGUMENT');
  }
  if (!isSecretPurpose(input.purpose)) {
    throw new SecretMaterialError('SECRET_INVALID_ARGUMENT');
  }
}

// ---------------------------------------------------------------------------
// Durable store
// ---------------------------------------------------------------------------

/**
 * The authoritative secret-material store.
 *
 * Refuses a non-transactional source at open — a memory or filesystem driver is
 * never authoritative secret state, mirroring the delegation and privilege
 * planes. All reads and writes are tenant-scoped, so PostgreSQL RLS enforces
 * isolation at the data plane and no cross-tenant query path exists.
 */
export class SecretMaterialStore {
  private constructor(
    private readonly source: SecurityCollectionSource,
    private readonly seam: KeyManagementSeam,
    private readonly encryptionKeyId: string,
    private readonly auditSink: SecretAccessAuditSink | undefined,
  ) {}

  /**
   * Open the store against the durable authority.
   *
   * The encryption key is resolved EAGERLY and must be ACTIVE: a store that
   * cannot obtain its sealing key does not open, rather than opening and
   * failing later on the first secret.
   */
  static async open(
    source: SecurityCollectionSource,
    seam: KeyManagementSeam,
    encryptionKeyId: string,
    options: { readonly auditSink?: SecretAccessAuditSink } = {},
  ): Promise<SecretMaterialStore> {
    // A source that cannot answer the question is treated as non-transactional:
    // the store refuses rather than leaking a driver-level TypeError.
    let transactional = false;
    try {
      transactional = source.supportsTransactions() === true;
    } catch {
      transactional = false;
    }
    if (!transactional) {
      // Class of failure only — never a connection string or driver detail.
      throw new SecretMaterialError('SECRET_SEAM_UNAVAILABLE');
    }
    if (!seam || typeof seam !== 'object') throw new SecretMaterialError('SECRET_SEAM_UNAVAILABLE');
    if (typeof encryptionKeyId !== 'string' || encryptionKeyId.length === 0) {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT');
    }
    if (options.auditSink !== undefined && typeof options.auditSink.record !== 'function') {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT');
    }
    const store = new SecretMaterialStore(source, seam, encryptionKeyId, options.auditSink);
    // Fail fast if the sealing key is unusable.
    await store.#activeEncryptor();
    const driver = source.getDriver();
    if (typeof driver.ensureIndex === 'function') {
      await driver.ensureIndex(SECRET_MATERIAL_COLLECTION, { name: 'by_principal', keys: ['principalId'], includeTenant: true });
    }
    return store;
  }

  /** The ACTIVE sealing key, or a refusal. Never falls back to another key. */
  async #activeEncryptor(): Promise<{ encryptor: Awaited<ReturnType<KeyManagementSeam['getEncryptor']>>; ref: import('./key-management.js').KeyRef }> {
    const refs = await this.seam.listKeys('encryption');
    const active = refs.find((ref) => ref.keyId === this.encryptionKeyId && ref.status === 'ACTIVE');
    if (!active) throw new SecretMaterialError('SECRET_SEAM_UNAVAILABLE');
    return { encryptor: await this.seam.getEncryptor(active.keyId, active.version), ref: active };
  }

  // ---------------------------------------------------------------------
  // Audit (in-transaction, never best-effort)
  // ---------------------------------------------------------------------

  async #audit(scope: StorageWriteScope, entry: Omit<SecretAccessRecord, 'id'>): Promise<void> {
    const record: SecretAccessRecord = { id: `s7acc_${randomUUID()}`, ...entry };
    const rows = await scope.collection<SecretAccessRecord>(SECRET_ACCESS_COLLECTION);
    // A throw here aborts the surrounding transaction, which is the point:
    // an unauditable credential access must not complete.
    await rows.put(record);
    if (this.auditSink) await this.auditSink.record(record);
  }

  /**
   * Audit a REFUSED or failed access in its OWN committed transaction.
   *
   * This is necessary, not cosmetic: a refusal ends by throwing, and a throw
   * out of the surrounding transaction would ROLL BACK an audit row written
   * inside it — so intruder attempts would leave no trace at all. Writing the
   * refusal in a separate transaction keeps it durable without weakening the
   * refusal itself. If this write fails, the error propagates: the caller still
   * gets no material, so fail-closed holds either way.
   */
  async #auditStandalone(tenantId: string, entry: Omit<SecretAccessRecord, 'id'>): Promise<void> {
    await this.#inTenant(tenantId, (scope) => this.#audit(scope, entry));
  }

  /**
   * Seal a secret. Returns a reference — never the material.
   * The plaintext is consumed here and is not retained by this object.
   */
  async seal(input: SealSecretInput): Promise<SecretRef> {
    assertBinding(input);
    const correlationId = input.correlationId ?? `corr_${randomUUID()}`;
    if (!(input.material instanceof Uint8Array) || input.material.length === 0) {
      await this.#inTenant(input.tenantId, async (scope) => {
        await this.#audit(scope, this.#entry(input, 'seal', 'REFUSED_INVALID_ARGUMENT', correlationId));
      });
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { secretId: input.secretId, purpose: input.purpose });
    }
    const { encryptor, ref } = await this.#activeEncryptor();
    const context = deriveSecretContext(input);
    let sealed: SealedBlob;
    try {
      sealed = await encryptor.encrypt(input.material, context);
    } catch {
      // Never propagate the provider's raw error (it could echo input bytes).
      await this.#inTenant(input.tenantId, async (scope) => {
        await this.#audit(scope, this.#entry(input, 'seal', 'SEAM_UNAVAILABLE', correlationId, ref));
      });
      throw new SecretMaterialError('SECRET_SEAM_UNAVAILABLE', { secretId: input.secretId, purpose: input.purpose });
    }
    const now = Date.now();
    const id = `${input.secretId}::1`;
    const doc: SecretMaterialDoc = {
      id,
      tenantId: input.tenantId,
      principalId: input.principalId,
      purpose: input.purpose,
      secretId: input.secretId,
      version: 1,
      status: 'ACTIVE',
      sealed,
      createdAt: now,
      updatedAt: now,
    };
    await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
      const existing = await rows.get(id);
      if (existing) {
        // Throwing here rolls this transaction back, so the conflict is audited
        // in its own committed transaction instead.
        throw new SecretMaterialError('SECRET_CONFLICT', { secretId: input.secretId, version: 1 });
      }
      await rows.put(doc);
      await this.#audit(scope, this.#entry(input, 'seal', 'SUCCESS', correlationId, ref));
    }).catch(async (error: unknown) => {
      if (error instanceof SecretMaterialError && error.code === 'SECRET_CONFLICT') {
        await this.#auditStandalone(input.tenantId, this.#entry(input, 'seal', 'CONFLICT', correlationId, ref));
      }
      throw error;
    });
    return {
      secretId: input.secretId,
      version: 1,
      purpose: input.purpose,
      status: 'ACTIVE',
      sealingKeyId: sealed.keyId,
      sealingKeyVersion: sealed.version,
    };
  }

  /**
   * Open a secret. The caller MUST present the full binding; a mismatch on any
   * element is reported as `SECRET_UNKNOWN`, indistinguishable from a
   * non-existent secret.
   *
   * The read, the authorization decision, the decryption, and the audit record
   * all happen inside ONE tenant-scoped transaction: the material is returned
   * only if the access was audited.
   */
  async open(input: OpenSecretInput): Promise<Uint8Array> {
    assertBinding(input);
    const correlationId = input.correlationId ?? `corr_${randomUUID()}`;
    const version = input.version;
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { secretId: input.secretId, purpose: input.purpose });
    }

    // Transaction A: tenant-scoped read and the authorization decision. It
    // returns a verdict rather than throwing, so nothing it observes is lost to
    // a rollback.
    type Verdict =
      | { readonly kind: 'unknown' }
      | { readonly kind: 'revoked'; readonly version: number }
      | { readonly kind: 'ok'; readonly doc: SecretMaterialDoc };
    const verdict: Verdict = await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
      // Tenant-scoped read: RLS makes another tenant's row invisible, so a
      // cross-tenant lookup cannot succeed and cannot be distinguished from a
      // miss.
      const doc =
        version !== undefined
          ? await rows.get(`${input.secretId}::${version}`)
          : ((await rows.query({ where: (row) => row.secretId === input.secretId })).find((row) => row.status === 'ACTIVE') ??
            (await rows.query({ where: (row) => row.secretId === input.secretId }))[0]);

      // Binding check. Every mismatch yields the SAME verdict so that ownership
      // and existence are not distinguishable to an unbound caller.
      if (!doc || doc.principalId !== input.principalId || doc.purpose !== input.purpose) return { kind: 'unknown' };
      if (doc.status === 'REVOKED') return { kind: 'revoked', version: doc.version };
      if (doc.sealed.context !== deriveSecretContext(input)) {
        // Defence in depth: even if a row were somehow re-pointed, the AAD
        // binding must still match exactly.
        return { kind: 'unknown' };
      }
      return { kind: 'ok', doc };
    });

    if (verdict.kind === 'unknown') {
      await this.#auditStandalone(input.tenantId, this.#entry(input, 'open', 'REFUSED_UNKNOWN', correlationId));
      throw new SecretMaterialError('SECRET_UNKNOWN', { secretId: input.secretId, purpose: input.purpose });
    }
    if (verdict.kind === 'revoked') {
      await this.#auditStandalone(
        input.tenantId,
        this.#entry(input, 'open', 'REFUSED_REVOKED', correlationId, undefined, verdict.version),
      );
      throw new SecretMaterialError('SECRET_REVOKED', { secretId: input.secretId, version: verdict.version, purpose: input.purpose });
    }

    const doc = verdict.doc;
    let material: Uint8Array;
    try {
      const decryptor = await this.seam.getDecryptor(doc.sealed.keyId, doc.sealed.version);
      material = await decryptor.decrypt(doc.sealed, deriveSecretContext(input));
    } catch (error) {
      // A revoked/expired sealing key ⇒ the secret is unrecoverable, which is
      // the correct fail-closed outcome. Anything else is malformed material.
      const result: SecretAccessResult =
        error instanceof KeyManagementError && error.code !== 'KEY_MALFORMED' ? 'SEAM_UNAVAILABLE' : 'MALFORMED';
      await this.#auditStandalone(input.tenantId, this.#entry(input, 'open', result, correlationId, undefined, doc.version));
      throw new SecretMaterialError(result === 'SEAM_UNAVAILABLE' ? 'SECRET_SEAM_UNAVAILABLE' : 'SECRET_MALFORMED', {
        secretId: doc.secretId,
        version: doc.version,
        purpose: doc.purpose,
      });
    }
    // Transaction B: the access is audited and COMMITTED before the material is
    // handed back. If the audit cannot be written, the caller gets an error and
    // no material — an unaudited credential access cannot happen.
    await this.#inTenant(input.tenantId, (scope) =>
      this.#audit(scope, this.#entry(input, 'open', 'SUCCESS', correlationId, undefined, doc.version)),
    );
    return material;
  }

  /**
   * Rotate: seal `material` as version+1 (ACTIVE) and RETIRE the previous
   * ACTIVE version. The retired version can still be opened until it is revoked.
   */
  async rotate(input: RotateSecretInput): Promise<SecretRef> {
    assertBinding(input);
    const correlationId = input.correlationId ?? `corr_${randomUUID()}`;
    const secretId = input.secretId;
    if (!(input.material instanceof Uint8Array) || input.material.length === 0) {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { secretId, purpose: input.purpose });
    }
    const current = await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
      const candidates = await rows.query({ where: (row) => row.secretId === secretId });
      return candidates.find((row) => row.status === 'ACTIVE');
    });
    if (!current || current.principalId !== input.principalId || current.purpose !== input.purpose) {
      await this.#auditStandalone(input.tenantId, this.#entry(input, 'rotate', 'REFUSED_UNKNOWN', correlationId));
      throw new SecretMaterialError('SECRET_UNKNOWN', { secretId, purpose: input.purpose });
    }
    const { encryptor, ref } = await this.#activeEncryptor();
    const sealed = await encryptor.encrypt(input.material, deriveSecretContext(input));
    const now = Date.now();
    const nextVersion = current.version + 1;
    const nextDoc: SecretMaterialDoc = {
      id: `${secretId}::${nextVersion}`,
      tenantId: input.tenantId,
      principalId: input.principalId,
      purpose: input.purpose,
      secretId,
      version: nextVersion,
      status: 'ACTIVE',
      sealed,
      createdAt: now,
      updatedAt: now,
    };
    await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
      if (await rows.get(nextDoc.id)) {
        throw new SecretMaterialError('SECRET_CONFLICT', { secretId, version: nextVersion });
      }
      // CAS on the outgoing row so two concurrent rotations cannot both win.
      // The guard keys on (status, version) rather than on a timestamp: the
      // winner flips status ACTIVE→RETIRED, so every racer that read the same
      // pre-state fails the guard regardless of clock resolution. A timestamp
      // guard would be unsound when two rotations land in the same
      // millisecond.
      const retired = await rows.cas(
        current.id,
        (row) => row !== undefined && row.status === 'ACTIVE' && row.version === current.version,
        (row) => ({ ...row, status: 'RETIRED', updatedAt: now }),
      );
      if (!retired.ok) {
        throw new SecretMaterialError('SECRET_CONFLICT', { secretId, version: current.version });
      }
      await rows.put(nextDoc);
      await this.#audit(scope, this.#entry(input, 'rotate', 'SUCCESS', correlationId, ref, nextVersion));
    }).catch(async (error: unknown) => {
      // A throw rolls the transaction back, so a losing racer is audited in its
      // own committed transaction.
      if (error instanceof SecretMaterialError && error.code === 'SECRET_CONFLICT') {
        await this.#auditStandalone(input.tenantId, this.#entry(input, 'rotate', 'CONFLICT', correlationId, ref, nextVersion));
      }
      throw error;
    });
    return {
      secretId,
      version: nextVersion,
      purpose: input.purpose,
      status: 'ACTIVE',
      sealingKeyId: sealed.keyId,
      sealingKeyVersion: sealed.version,
    };
  }

  /** Terminal. The version can never be opened again. */
  async revoke(input: RevokeSecretInput): Promise<void> {
    assertBinding(input);
    const correlationId = input.correlationId ?? `corr_${randomUUID()}`;
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { secretId: input.secretId, version: input.version });
    }
    await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
      const id = `${input.secretId}::${input.version}`;
      const doc = await rows.get(id);
      // Indistinguishable from non-existent when any binding element differs —
      // including purpose, so a wrong-purpose revoke reveals nothing.
      if (!doc || doc.principalId !== input.principalId || doc.purpose !== input.purpose) {
        throw new SecretMaterialError('SECRET_UNKNOWN', { secretId: input.secretId, version: input.version });
      }
      const revokedAt = Date.now();
      await rows.put({ ...doc, status: 'REVOKED', revokedAt, updatedAt: revokedAt });
      await this.#audit(scope, this.#entry(input, 'revoke', 'SUCCESS', correlationId, undefined, input.version));
    }).catch(async (error: unknown) => {
      if (error instanceof SecretMaterialError && error.code === 'SECRET_UNKNOWN') {
        await this.#auditStandalone(input.tenantId, this.#entry(input, 'revoke', 'REFUSED_UNKNOWN', correlationId, undefined, input.version));
      }
      throw error;
    });
  }

  /** List references for a principal. Returns metadata only — never material. */
  async list(input: { readonly tenantId: string; readonly principalId: string; readonly actorPrincipalId: string }): Promise<readonly SecretRef[]> {
    if (typeof input.tenantId !== 'string' || typeof input.principalId !== 'string' || typeof input.actorPrincipalId !== 'string') {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT');
    }
    const correlationId = `corr_${randomUUID()}`;
    return this.#inTenant(input.tenantId, async (scope) => {
      const collection = await scope.collection<SecretMaterialDoc>(SECRET_MATERIAL_COLLECTION);
      const rows = await collection.query({ where: (row) => row.principalId === input.principalId });
      await this.#audit(scope, {
        tenantId: input.tenantId,
        actorPrincipalId: input.actorPrincipalId,
        principalId: input.principalId,
        operation: 'list',
        result: 'SUCCESS',
        providerId: this.seam.id,
        correlationId,
        at: Date.now(),
      });
      return rows.map((doc) => ({
        secretId: doc.secretId,
        version: doc.version,
        purpose: doc.purpose,
        status: doc.status,
        sealingKeyId: doc.sealed.keyId,
        sealingKeyVersion: doc.sealed.version,
      }));
    });
  }

  async health(): Promise<IdentityProviderHealth> {
    const seamHealth = await this.seam.health();
    return {
      status: seamHealth.status,
      checkedAt: Date.now(),
      // Secret-free: seam status and the sealing key identifier only.
      detail: `s7 secret-material store; sealingKey=${this.encryptionKeyId}; seam=${seamHealth.status}`,
    };
  }

  /** Build the identifier-only audit entry for an operation. */
  #entry(
    input: { readonly tenantId: string; readonly actorPrincipalId: string; readonly principalId: string; readonly purpose?: SecretPurpose; readonly secretId: string },
    operation: SecretOperation,
    result: SecretAccessResult,
    correlationId: string,
    ref?: { readonly keyId: string; readonly version: number },
    version?: number,
  ): Omit<SecretAccessRecord, 'id'> {
    return {
      tenantId: input.tenantId,
      actorPrincipalId: input.actorPrincipalId,
      principalId: input.principalId,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      secretId: input.secretId,
      ...(version !== undefined ? { version } : {}),
      operation,
      result,
      providerId: this.seam.id,
      ...(ref ? { keyId: ref.keyId, keyVersion: ref.version } : {}),
      correlationId,
      at: Date.now(),
    };
  }

  async #inTenant<T>(tenantId: string, fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    StorageModule.validateTenantId(tenantId);
    return this.source.atomically(async (scope) => {
      // Fail closed on a non-atomic scope: secret state (and its audit) must
      // never be written outside a transaction.
      if (!scope.atomic) throw new SecretMaterialError('SECRET_SEAM_UNAVAILABLE');
      return fn(scope);
    }, { tenantId });
  }
}

/** Identifier of the dev key seam key used by the S7 test suites. */
export const DEV_SECRET_SEAM_KEY_ID = 's7-dev-secret-wrapping-key';

/** A stable, non-cryptographic identifier for correlation in tests. */
export function newSecretId(): string {
  return `sec_${randomUUID()}`;
}
