// R2 — SecurityStateStore: PostgreSQL as the SOLE authoritative security
// state substrate (S-1..S-7 + S-8/S-9/S-10 coordination).
//
// Fail-closed contract:
//   * Construction over a non-transactional driver THROWS (memory and
//     filesystem stores are never authoritative security state).
//   * Every enforcement read/write runs inside an explicit tenant-scoped
//     (or explicit narrow system-scope, for S-1 policy lookup and S-10
//     maintenance) transaction. No ambient tenant, no unscoped export.
//   * Serialization/deadlock (40001/40P01) ⇒ bounded retry, then deny;
//     lock timeout (55P03) ⇒ immediate deny. Any other storage failure ⇒
//     deny with SECURITY_STATE_UNAVAILABLE. A storage failure NEVER
//     converts to ALLOW, to zero usage, or to "unrevoked".
//   * Documents are closed-schema: unknown fields and material-shaped
//     fields are rejected at the repository layer, before any write.

import { randomUUID } from 'node:crypto';
import {
  AUTH_SESSION_CLOCK_SKEW_MS,
  AUTHENTICATION_EVENTS_COLLECTION,
  type AuthenticationEventDoc,
} from '@jataqi/authentication';
import {
  StorageModule,
  type CollectionIndexDef,
  type ICollection,
  type SecurityCollectionSource,
  type StorageWriteScope,
} from '@jataqi/storage';
import { canonicalize, sha256Hex } from './canonical.js';
import { assertAllowedAuditShape } from './audit.js';
import { isNarrowing, validateManifestShape } from './capability-manifests.js';
import {
  ManifestRejectedError,
  type A01CapabilityManifest,
  type A01StoredAuditRecord,
} from './types.js';
import type {
  ConsumedEnvelopeDoc,
  IdempotencyDoc,
  RateWindowDoc,
  RunBudgetDoc,
} from './consumption-stores.js';
import type { CredentialDoc, CredentialUseDoc } from './credential-store.js';

/** R2 S-1: versioned capability manifests + ACTIVE pointers. */
export const SECURITY_MANIFESTS_COLLECTION = 'authorization.manifests';
/** R2 S-2: issued credential bindings (references only, never material). */
export const SECURITY_CREDENTIALS_COLLECTION = 'authorization.credentials';
/** R2 S-3: credential single-use proofs. */
export const SECURITY_CREDENTIAL_USES_COLLECTION = 'authorization.credential-uses';
/** R2 S-4: consumed envelopes (exactly-once enforcement). */
export const SECURITY_CONSUMED_ENVELOPES_COLLECTION = 'authorization.consumed-envelopes';
/** R2 S-5: idempotency ledger. */
export const SECURITY_IDEMPOTENCY_COLLECTION = 'authorization.idempotency';
/** R2 S-6: fixed-window rate counters. */
export const SECURITY_RATE_WINDOWS_COLLECTION = 'authorization.rate-windows';
/** R2 S-7: per-run budget consumption. */
export const SECURITY_RUN_BUDGETS_COLLECTION = 'authorization.run-budgets';
/** R2 S-10: durable authorization audit (extended). */
export const AUTHORIZATION_DECISIONS_COLLECTION = 'authorization.decisions';

/**
 * R2 clock-skew bound for durable-path expiry comparisons
 * (deny-early): `expired ⟺ now + SKEW >= expiresAt`. Must equal the
 * authentication package's session skew (asserted at `open`); the two
 * packages share one conservative clock policy.
 */
export const R2_SKEW_MS = 300_000;

/**
 * P1 (R2-OBS-01 follow-up): the minimum manifest lifetime the DURABLE path can
 * honor. Durable enforcement deny-earlies freshness by the R2 skew bound, so a
 * manifest with `maxLifetimeMs <= R2_SKEW_MS` can NEVER execute durably — its
 * envelope is expired the moment it is sealed. Registering such a manifest
 * into the durable authority is a configuration defect (a capability that can
 * never be used), so the durable registration paths reject it fail-closed.
 *
 * NOTE: this floor applies to the DURABLE authority only. The R1 in-memory
 * registry has no skew-strict freshness check, and existing R1 callers (kernel
 * worker manifests default to 60s) keep their exact semantics. The production
 * posture (P1) makes the durable path mandatory, so production compositions
 * cannot register sub-skew lifetimes at all.
 */
export const MIN_DURABLE_MANIFEST_LIFETIME_MS = R2_SKEW_MS;

/** P1: reject durable registration of a manifest whose lifetime cannot survive the skew window. */
export function assertDurableManifestLifetime(manifest: A01CapabilityManifest): void {
  if (manifest.maxLifetimeMs <= MIN_DURABLE_MANIFEST_LIFETIME_MS) {
    throw new ManifestRejectedError(
      `manifest: maxLifetimeMs (${manifest.maxLifetimeMs}) must exceed the durable skew bound ` +
        `(${MIN_DURABLE_MANIFEST_LIFETIME_MS} ms) — a shorter lifetime can never execute on the durable path ` +
        '(deny-early freshness; R2-OBS-01; fail-closed)',
    );
  }
}

/** Body tenant marker for explicitly system-scoped S-1 rows. */
export const SECURITY_SYSTEM_TENANT = 'system';

/** Maintenance principal attribution for substrate GC batches. */
export const SECURITY_MAINTENANCE_PRINCIPAL = 'kernel:maintenance';

/** R2 §G retention floors (all fail-closed: GC refuses to run when the S-4 interlock trips). */
export const SECURITY_S4_RETENTION_MS = 30 * 86_400_000;
export const SECURITY_S5_COMPLETED_RETENTION_MS = 30 * 86_400_000;
export const SECURITY_S5_FAILED_RETENTION_MS = 7 * 86_400_000;
/** Orphan IN_PROGRESS rows are marked EXPIRED only after leaseExpiry + this grace (never deleted). */
export const SECURITY_S5_ORPHAN_GRACE_MS = 86_400_000;
export const SECURITY_S6_GC_GRACE_MS = 3_600_000;
export const SECURITY_S7_RETENTION_MS = 30 * 86_400_000;
export const SECURITY_GC_DEFAULT_BATCH_SIZE = 500;

/** Enforcement-transaction retry: attempts + inter-attempt backoff (ms). */
export const SECURITY_TX_MAX_ATTEMPTS = 3;
export const SECURITY_TX_BACKOFF_MS: readonly number[] = Object.freeze([5, 25]);

/** Single-document CAS convergence loop bound (mirrors WorkQueue.enqueue). */
export const SECURITY_CAS_MAX_ATTEMPTS = 8;

/** Base error for durable security-state failures (all fail closed). */
export class SecurityStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityStateError';
    Object.setPrototypeOf(this, SecurityStateError.prototype);
  }
}

/**
 * The durable store is unreachable, inconsistent, or exhausted its retry
 * budget. The gate maps this to DENY with SECURITY_STATE_UNAVAILABLE.
 */
export class SecurityStateUnavailableError extends SecurityStateError {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityStateUnavailableError';
    Object.setPrototypeOf(this, SecurityStateUnavailableError.prototype);
  }
}

/**
 * Boot manifest divergence: durable ACTIVE policy differs from the composed
 * seed without an approved rotation record. Boot MUST abort (no silent
 * rotation, no silent keep — an operator decision is required).
 */
export class ManifestDivergenceError extends SecurityStateError {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestDivergenceError';
    Object.setPrototypeOf(this, ManifestDivergenceError.prototype);
  }
}

// ---------------------------------------------------------------------------
// S-1 manifest documents
// ---------------------------------------------------------------------------

export type ManifestVersionStatus = 'ACTIVE' | 'SUPERSEDED';

/** S-1 version row: `id = {capabilityId}::{version}`. Immutable once written. */
export interface ManifestVersionDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'manifest-version';
  readonly capabilityId: string;
  readonly version: string;
  readonly manifest: A01CapabilityManifest;
  readonly manifestDigest: string;
  readonly registeredBy: { readonly principalId: string; readonly tenantId: string; readonly authenticationEventId: string };
  readonly supersedes: string | null;
  readonly status: ManifestVersionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** S-1 pointer row: `id = {capabilityId}::ACTIVE → { activeVersion, manifestId }`. */
export interface ManifestPointerDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'manifest-pointer';
  readonly capabilityId: string;
  readonly activeVersion: string;
  readonly manifestId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** S-1 rotation-approval row: `id = {capabilityId}::ROTATION::{version}`. */
export interface ManifestRotationApprovalDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'rotation-approval';
  readonly capabilityId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly approvedBy: { readonly principalId: string; readonly authenticationEventId: string };
  readonly reason: string;
  readonly approvedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ManifestDoc = ManifestVersionDoc | ManifestPointerDoc | ManifestRotationApprovalDoc;

const ALLOWED_MANIFEST_FIELDS: ReadonlySet<string> = new Set([
  'id', 'tenantId', 'kind', 'capabilityId', 'version', 'manifest', 'manifestDigest',
  'registeredBy', 'supersedes', 'status', 'activeVersion', 'manifestId',
  'approvedBy', 'reason', 'approvedAt', 'createdAt', 'updatedAt',
]);

const FORBIDDEN_MANIFEST_FIELD_PATTERN = /(material|secret|token(?!registry)|password|privatekey)/i;

export function assertManifestDocumentShape(doc: Record<string, unknown>, context: string): void {
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_MANIFEST_FIELDS.has(key)) {
      throw new SecurityStateError(`${context}: unknown field "${key}" would be persisted (closed-schema violation, fail-closed).`);
    }
    if (FORBIDDEN_MANIFEST_FIELD_PATTERN.test(key)) {
      throw new SecurityStateError(`${context}: field "${key}" is material-shaped and must never be persisted (fail-closed).`);
    }
  }
}

/** Deterministic S-1 document ids (opaque PKs; never parsed). */
export function manifestVersionId(capabilityId: string, version: string): string {
  assertManifestKeyPart(capabilityId, 'capabilityId');
  assertManifestKeyPart(version, 'version');
  return `${capabilityId}::${version}`;
}

export function manifestPointerId(capabilityId: string): string {
  assertManifestKeyPart(capabilityId, 'capabilityId');
  return `${capabilityId}::ACTIVE`;
}

export function manifestRotationApprovalId(capabilityId: string, version: string): string {
  assertManifestKeyPart(capabilityId, 'capabilityId');
  assertManifestKeyPart(version, 'version');
  return `${capabilityId}::ROTATION::${version}`;
}

function assertManifestKeyPart(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SecurityStateError(`Manifest ${field} must be a non-empty string (fail-closed).`);
  }
  if (value.includes('::')) {
    throw new SecurityStateError(`Manifest ${field} must not contain "::" (fail-closed).`);
  }
}

/** Canonical digest of a manifest (the enforcement citation). */
export function manifestDigest(manifest: A01CapabilityManifest): string {
  return sha256Hex(canonicalize(manifest as unknown as Record<string, unknown>));
}

export interface ManifestRegistrar {
  readonly principalId: string;
  readonly tenantId: string;
  readonly authenticationEventId: string;
}

function assertRegistrar(registrar: ManifestRegistrar): void {
  if (!registrar || typeof registrar !== 'object') {
    throw new ManifestRejectedError('manifest registration requires registrar attribution (fail-closed).');
  }
  for (const [field, value] of [['principalId', registrar.principalId], ['tenantId', registrar.tenantId], ['authenticationEventId', registrar.authenticationEventId]] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ManifestRejectedError(`manifest registration requires a non-empty registrar ${field} (fail-closed).`);
    }
  }
  StorageModule.validateTenantId(registrar.tenantId);
}

export interface RegisteredManifest {
  readonly manifestId: string;
  readonly capabilityId: string;
  readonly version: string;
  readonly digest: string;
  readonly supersedes: string | null;
}

/** An ACTIVE manifest row resolved for enforcement (system scope). */
export interface ActiveManifest {
  readonly manifestId: string;
  readonly capabilityId: string;
  readonly version: string;
  readonly digest: string;
  readonly manifest: A01CapabilityManifest;
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

export interface SecurityRetryStats {
  transactions: number;
  retriesSerialization: number;
  retriesDeadlock: number;
}

export function pgCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// SecurityStateStore
// ---------------------------------------------------------------------------

export interface SecurityStateStoreOptions {
  /** Injectable clock (ms). Defaults to `Date.now`. */
  readonly now?: () => number;
}

export type TenantScope = { readonly tenantId: string } | { readonly system: true };

export function isTenantScope(scope: TenantScope): scope is { readonly tenantId: string } {
  return 'tenantId' in scope;
}

/**
 * R2 authoritative security-state repository. Owns S-1 (manifests), S-10
 * receipt writes, retention/GC, and the retriable transaction runner shared
 * by every durable enforcement path. S-2/S-3 (credential-store), S-4/S-5
 * (replay/idempotency) and S-6/S-7 (rate/budget) operations run in
 * transactions opened through this store so one enforcement transaction
 * binds them all.
 */
export class SecurityStateStore {
  private readonly source: SecurityCollectionSource;
  private readonly now: () => number;
  private readonly retryStats: SecurityRetryStats = { transactions: 0, retriesSerialization: 0, retriesDeadlock: 0 };

  private constructor(source: SecurityCollectionSource, now: () => number) {
    this.source = source;
    this.now = now;
  }

  get collectionSource(): SecurityCollectionSource {
    return this.source;
  }

  /**
   * Open the store over a storage composition. Refuses non-transactional
   * drivers, asserts the shared clock-skew policy, ensures the reviewed
   * secondary indexes, and probes reachability. Any failure throws (boot
   * MUST abort — there is no degraded security substrate).
   */
  static async open(source: SecurityCollectionSource, options: SecurityStateStoreOptions = {}): Promise<SecurityStateStore> {
    if (!source.supportsTransactions()) {
      throw new SecurityStateUnavailableError(
        'SecurityStateStore requires a transactional storage driver (PostgreSQL); ' +
          'a non-transactional store is never authoritative security state (fail-closed).',
      );
    }
    if (R2_SKEW_MS !== AUTH_SESSION_CLOCK_SKEW_MS) {
      throw new SecurityStateUnavailableError(
        'Security-state clock-skew drift between authorization and authentication packages (fail-closed).',
      );
    }
    const driver = source.getDriver();
    if (typeof driver.ensureIndex !== 'function') {
      throw new SecurityStateUnavailableError(
        'SecurityStateStore requires a driver with the reviewed index seam (fail-closed).',
      );
    }
    for (const [collection, index] of REVIEWED_SECURITY_INDEXES) {
      await driver.ensureIndex(collection, index);
    }
    const store = new SecurityStateStore(source, options.now ?? Date.now);
    await store.verifyReachability();
    return store;
  }

  /** Reachability probe: every authoritative collection answers (system scope). */
  async verifyReachability(): Promise<void> {
    const collections = [
      SECURITY_MANIFESTS_COLLECTION,
      SECURITY_CREDENTIALS_COLLECTION,
      SECURITY_CREDENTIAL_USES_COLLECTION,
      SECURITY_CONSUMED_ENVELOPES_COLLECTION,
      SECURITY_IDEMPOTENCY_COLLECTION,
      SECURITY_RATE_WINDOWS_COLLECTION,
      SECURITY_RUN_BUDGETS_COLLECTION,
      AUTHORIZATION_DECISIONS_COLLECTION,
      AUTHENTICATION_EVENTS_COLLECTION,
    ];
    try {
      await this.source.atomically(async (scope) => {
        for (const name of collections) {
          const collection = await scope.collection<{ id: string }>(name);
          await collection.get('__r2_reachability_probe__');
        }
      });
    } catch (error) {
      throw new SecurityStateUnavailableError(
        `Security-state reachability probe failed: ${error instanceof Error ? error.message : String(error)} (fail-closed).`,
      );
    }
  }

  /** Cumulative transaction/retry counters (perf evidence; monotonic). */
  getRetryStats(): SecurityRetryStats {
    return { ...this.retryStats };
  }

  /**
   * Run `fn` in ONE transaction with bounded serialization/deadlock retry
   * (3 attempts, 5→25ms backoff). Lock timeout (55P03) and any other error
   * throw immediately (no retry): the caller maps them to DENY.
   */
  async transact<T>(scope: TenantScope, fn: (collections: SecurityTxCollections, txId: string) => Promise<T>): Promise<T> {
    const tenantId = isTenantScope(scope) ? scope.tenantId : undefined;
    if (tenantId !== undefined) StorageModule.validateTenantId(tenantId);
    let lastError: unknown;
    for (let attempt = 1; attempt <= SECURITY_TX_MAX_ATTEMPTS; attempt += 1) {
      const txId = randomUUID();
      this.retryStats.transactions += 1;
      try {
        return await this.source.atomically(async (writeScope) => {
          if (!writeScope.atomic) {
            throw new SecurityStateUnavailableError('Security-state transaction is not atomic (fail-closed).');
          }
          return fn(await SecurityTxCollections.open(writeScope), txId);
        }, tenantId !== undefined ? { tenantId } : {});
      } catch (error) {
        lastError = error;
        const code = pgCodeOf(error);
        if (code === '55P03') throw error;
        if ((code === '40001' || code === '40P01') && attempt < SECURITY_TX_MAX_ATTEMPTS) {
          if (code === '40001') this.retryStats.retriesSerialization += 1;
          else this.retryStats.retriesDeadlock += 1;
          await sleepMs(SECURITY_TX_BACKOFF_MS[attempt - 1] ?? 25);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  // -- S-1 manifest authority ---------------------------------------------

  /**
   * Register one immutable manifest version + swing the ACTIVE pointer, in
   * ONE system-scope transaction. Narrowing is enforced against the
   * row-locked current ACTIVE row; concurrent rotations serialize and losers
   * fail closed (caller retries explicitly). Idempotent for byte-identical
   * re-registration (boot-safe); any content change under an existing
   * version is rejected (immutability).
   */
  async registerManifestVersion(
    manifest: A01CapabilityManifest,
    registrar: ManifestRegistrar,
  ): Promise<RegisteredManifest> {
    validateManifestShape(manifest);
    assertDurableManifestLifetime(manifest);
    assertRegistrar(registrar);
    const digest = manifestDigest(manifest);
    const versionId = manifestVersionId(manifest.capabilityId, manifest.version);
    const pointerId = manifestPointerId(manifest.capabilityId);
    const tenantId = manifest.allowTenantWildcard ? SECURITY_SYSTEM_TENANT : manifest.registeredBy.tenantId;
    StorageModule.validateTenantId(tenantId);
    const now = this.now();

    return this.transact({ system: true }, async (collections) => {
      const manifests = collections.manifests;
      const pointer = await manifests.get(pointerId);
      if (pointer !== undefined && pointer.kind !== 'manifest-pointer') {
        throw new SecurityStateUnavailableError(`S-1 pointer row "${pointerId}" is corrupt (fail-closed).`);
      }
      let currentActive: ManifestVersionDoc | undefined;
      if (pointer) {
        const activeRow = await manifests.get(pointer.manifestId);
        if (activeRow === undefined || activeRow.kind !== 'manifest-version') {
          throw new SecurityStateUnavailableError(`S-1 ACTIVE pointer "${pointerId}" dangles (fail-closed).`);
        }
        currentActive = activeRow;
      }

      const existing = await manifests.get(versionId);
      if (existing !== undefined) {
        if (existing.kind !== 'manifest-version') {
          throw new SecurityStateError(`S-1 version row "${versionId}" is corrupt (fail-closed).`);
        }
        if (existing.manifestDigest !== digest) {
          throw new ManifestRejectedError(
            `manifest "${manifest.capabilityId}" version "${manifest.version}" is already registered with different content — versions are immutable (fail-closed).`,
          );
        }
        // Byte-identical re-registration: complete a crashed rotation if the
        // pointer has not swung yet, else pure idempotent success.
        if (pointer && pointer.manifestId === versionId) {
          return { manifestId: versionId, capabilityId: manifest.capabilityId, version: manifest.version, digest, supersedes: existing.supersedes };
        }
        if (currentActive) {
          const check = isNarrowing(currentActive.manifest, manifest);
          if (!check.ok) {
            throw new ManifestRejectedError(
              `manifest "${manifest.capabilityId}" v${manifest.version} rejected: ${check.violation} — new versions may only narrow`,
            );
          }
        }
        await this.swingPointer(manifests, pointerId, pointer, manifest.capabilityId, manifest.version, versionId, currentActive, now);
        return { manifestId: versionId, capabilityId: manifest.capabilityId, version: manifest.version, digest, supersedes: currentActive ? currentActive.id : null };
      }

      if (currentActive) {
        const check = isNarrowing(currentActive.manifest, manifest);
        if (!check.ok) {
          throw new ManifestRejectedError(
            `manifest "${manifest.capabilityId}" v${manifest.version} rejected: ${check.violation} — new versions may only narrow`,
          );
        }
      }
      const versionDoc: ManifestVersionDoc = {
        id: versionId,
        tenantId,
        kind: 'manifest-version',
        capabilityId: manifest.capabilityId,
        version: manifest.version,
        manifest: JSON.parse(JSON.stringify(manifest)) as A01CapabilityManifest,
        manifestDigest: digest,
        registeredBy: { principalId: registrar.principalId, tenantId: registrar.tenantId, authenticationEventId: registrar.authenticationEventId },
        supersedes: currentActive ? currentActive.id : null,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      };
      assertManifestDocumentShape(versionDoc as unknown as Record<string, unknown>, 'registerManifestVersion');
      const inserted = await manifests.cas(versionId, (cur) => cur === undefined, () => cloneDoc(versionDoc));
      if (!inserted.ok) {
        // Lost the first-create race inside this tx: fail closed and let the
        // caller retry explicitly (the retry re-reads the winner's row).
        throw new ManifestRejectedError(
          `manifest "${manifest.capabilityId}" v${manifest.version} lost a concurrent registration race (fail-closed; retry explicitly).`,
        );
      }
      await this.swingPointer(manifests, pointerId, pointer, manifest.capabilityId, manifest.version, versionId, currentActive, now);
      return { manifestId: versionId, capabilityId: manifest.capabilityId, version: manifest.version, digest, supersedes: currentActive ? currentActive.id : null };
    });
  }

  /** Flip the previous ACTIVE row to SUPERSEDED (content-preserving) + swing the pointer (CAS). */
  private async swingPointer(
    manifests: ICollection<ManifestDoc>,
    pointerId: string,
    pointer: ManifestPointerDoc | undefined,
    capabilityId: string,
    version: string,
    versionId: string,
    currentActive: ManifestVersionDoc | undefined,
    now: number,
  ): Promise<void> {
    if (currentActive) {
      const flipped = await manifests.cas(
        currentActive.id,
        (cur) => !!cur && cur.kind === 'manifest-version' && cur.status === 'ACTIVE' && cur.manifestDigest === currentActive.manifestDigest,
        (cur) => {
          if (cur.kind !== 'manifest-version') throw new SecurityStateError('S-1 flip target is not a version row (fail-closed).');
          return { ...cur, status: 'SUPERSEDED' as const, updatedAt: now };
        },
      );
      if (!flipped.ok) {
        throw new ManifestRejectedError(
          `manifest rotation lost a concurrent rotation race while superseding "${currentActive.id}" (fail-closed; retry explicitly).`,
        );
      }
    }
    const expectedVersion = pointer ? pointer.activeVersion : undefined;
    const swung = await manifests.cas(
      pointerId,
      (cur) => {
        if (cur === undefined) return expectedVersion === undefined;
        if (cur.kind !== 'manifest-pointer') return false;
        return cur.activeVersion === expectedVersion;
      },
      () => ({
        id: pointerId,
        tenantId: SECURITY_SYSTEM_TENANT,
        kind: 'manifest-pointer' as const,
        capabilityId,
        activeVersion: version,
        manifestId: versionId,
        createdAt: pointer?.createdAt ?? now,
        updatedAt: now,
      }),
    );
    if (!swung.ok) {
      throw new ManifestRejectedError(
        `manifest rotation lost a concurrent pointer swing for "${pointerId}" (fail-closed; retry explicitly).`,
      );
    }
  }

  /**
   * Resolve the ACTIVE manifest for enforcement. System-scope PK reads
   * (pointer → version) + shape re-validation. Returns undefined ONLY when
   * no pointer row exists (unknown capability); corrupt rows throw
   * (fail closed — never treat corruption as "unknown").
   */
  async getActiveManifest(capabilityId: string): Promise<ActiveManifest | undefined> {
    if (typeof capabilityId !== 'string' || capabilityId.length === 0) return undefined;
    return this.transact({ system: true }, async (collections) => {
      const manifests = collections.manifests;
      const pointer = await manifests.get(manifestPointerId(capabilityId));
      if (pointer === undefined) return undefined;
      if (pointer.kind !== 'manifest-pointer') {
        throw new SecurityStateUnavailableError(`S-1 pointer row for "${capabilityId}" is corrupt (fail-closed).`);
      }
      const row = await manifests.get(pointer.manifestId);
      if (row === undefined || row.kind !== 'manifest-version') {
        throw new SecurityStateUnavailableError(`S-1 ACTIVE pointer for "${capabilityId}" dangles (fail-closed).`);
      }
      if (row.status !== 'ACTIVE') {
        throw new SecurityStateUnavailableError(`S-1 ACTIVE pointer for "${capabilityId}" cites a non-ACTIVE row (fail-closed).`);
      }
      try {
        validateManifestShape(row.manifest);
        assertDurableManifestLifetime(row.manifest);
      } catch (error) {
        throw new SecurityStateUnavailableError(
          `S-1 ACTIVE manifest for "${capabilityId}" fails shape validation: ${error instanceof Error ? error.message : String(error)} (fail-closed).`,
        );
      }
      if (manifestDigest(row.manifest) !== row.manifestDigest) {
        throw new SecurityStateUnavailableError(`S-1 ACTIVE manifest for "${capabilityId}" digest mismatch (fail-closed).`);
      }
      return {
        manifestId: row.id,
        capabilityId: row.capabilityId,
        version: row.version,
        digest: row.manifestDigest,
        manifest: cloneDoc(row.manifest),
      };
    });
  }

  /** Record operator approval for one rotation (capabilityId, version, digest). Idempotent. */
  async approveRotation(input: {
    readonly capabilityId: string;
    readonly version: string;
    readonly manifestDigest: string;
    readonly approvedBy: { readonly principalId: string; readonly authenticationEventId: string };
    readonly reason: string;
  }): Promise<void> {
    assertManifestKeyPart(input.capabilityId, 'capabilityId');
    assertManifestKeyPart(input.version, 'version');
    if (typeof input.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.manifestDigest)) {
      throw new ManifestRejectedError('rotation approval requires a sha256 hex manifestDigest (fail-closed).');
    }
    if (!input.approvedBy || typeof input.approvedBy.principalId !== 'string' || input.approvedBy.principalId.trim().length === 0) {
      throw new ManifestRejectedError('rotation approval requires an approving principalId (fail-closed).');
    }
    if (typeof input.approvedBy.authenticationEventId !== 'string' || input.approvedBy.authenticationEventId.trim().length === 0) {
      throw new ManifestRejectedError('rotation approval requires an approving authenticationEventId (fail-closed).');
    }
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
      throw new ManifestRejectedError('rotation approval requires a reason (fail-closed).');
    }
    const id = manifestRotationApprovalId(input.capabilityId, input.version);
    const now = this.now();
    await this.transact({ system: true }, async (collections) => {
      const manifests = collections.manifests;
      const doc: ManifestRotationApprovalDoc = {
        id,
        tenantId: SECURITY_SYSTEM_TENANT,
        kind: 'rotation-approval',
        capabilityId: input.capabilityId,
        version: input.version,
        manifestDigest: input.manifestDigest,
        approvedBy: { principalId: input.approvedBy.principalId, authenticationEventId: input.approvedBy.authenticationEventId },
        reason: input.reason.trim(),
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      assertManifestDocumentShape(doc as unknown as Record<string, unknown>, 'approveRotation');
      const res = await manifests.cas(id, (cur) => cur === undefined, () => cloneDoc(doc));
      if (!res.ok) {
        const current = await manifests.get(id);
        if (current !== undefined && current.kind === 'rotation-approval' && current.manifestDigest === input.manifestDigest) {
          return;
        }
        throw new ManifestRejectedError(
          `conflicting rotation approval already exists for "${input.capabilityId}" v${input.version} (fail-closed).`,
        );
      }
    });
  }

  /**
   * Boot seed: reconcile composed seed manifests against durable ACTIVE
   * policy. Same version + same digest ⇒ no-op; same version + different
   * digest ⇒ DIVERGENCE ABORT (immutability, no override exists); new
   * version ⇒ requires a matching rotation-approval row, else DIVERGENCE
   * ABORT; unknown capability ⇒ first registration. Any abort throws
   * `ManifestDivergenceError` (boot MUST abort).
   */
  async seedManifests(
    seeds: readonly A01CapabilityManifest[],
    registrar: ManifestRegistrar,
  ): Promise<RegisteredManifest[]> {
    if (!Array.isArray(seeds)) {
      throw new ManifestRejectedError('seedManifests requires a manifest array (fail-closed).');
    }
    assertRegistrar(registrar);
    const results: RegisteredManifest[] = [];
    for (const seed of seeds) {
      validateManifestShape(seed);
      assertDurableManifestLifetime(seed);
      const digest = manifestDigest(seed);
      const active = await this.getActiveManifest(seed.capabilityId);
      if (!active) {
        results.push(await this.registerManifestVersion(seed, registrar));
        continue;
      }
      if (active.version === seed.version) {
        if (active.digest !== digest) {
          throw new ManifestDivergenceError(
            `boot divergence: durable ACTIVE manifest "${seed.capabilityId}" v${seed.version} ` +
              `differs from the composed seed (digest ${active.digest.slice(0, 12)}… vs ${digest.slice(0, 12)}…). ` +
              'Versions are immutable: rotate to a new version with an approved rotation record (fail-closed; boot aborted).',
          );
        }
        results.push({ manifestId: active.manifestId, capabilityId: active.capabilityId, version: active.version, digest: active.digest, supersedes: null });
        continue;
      }
      const approval = await this.transact({ system: true }, async (collections) =>
        collections.manifests.get(manifestRotationApprovalId(seed.capabilityId, seed.version)),
      );
      if (approval === undefined || approval.kind !== 'rotation-approval' || approval.manifestDigest !== digest) {
        throw new ManifestDivergenceError(
          `boot divergence: durable ACTIVE manifest "${seed.capabilityId}" is v${active.version} ` +
            `but the composition seeds v${seed.version} with no matching approved rotation record ` +
            '(fail-closed; boot aborted — approve the rotation explicitly, then reboot).',
        );
      }
      results.push(await this.registerManifestVersion(seed, registrar));
    }
    return results;
  }

  /**
   * List ACTIVE manifests (system scope; boot mirror + GC interlock +
   * diagnostics). Corrupt rows throw (fail closed).
   */
  async listActiveManifests(): Promise<ActiveManifest[]> {
    return this.transact({ system: true }, async (collections) => {
      const manifests = collections.manifests;
      const rows = await manifests.query({});
      const pointers = rows.filter((row): row is ManifestPointerDoc => row.kind === 'manifest-pointer');
      const out: ActiveManifest[] = [];
      for (const pointer of pointers) {
        const row = await manifests.get(pointer.manifestId);
        if (row === undefined || row.kind !== 'manifest-version' || row.status !== 'ACTIVE') {
          throw new SecurityStateUnavailableError(`S-1 ACTIVE pointer "${pointer.id}" dangles (fail-closed).`);
        }
        validateManifestShape(row.manifest);
        assertDurableManifestLifetime(row.manifest);
        out.push({
          manifestId: row.id,
          capabilityId: row.capabilityId,
          version: row.version,
          digest: row.manifestDigest,
          manifest: cloneDoc(row.manifest),
        });
      }
      return out.sort((a, b) => (a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0));
    });
  }

  // -- S-10 receipt writes (in-transaction) ---------------------------------

  /**
   * Write one S-10 audit row inside the caller's transaction (DECISION /
   * CONSUMED / CREDENTIAL_* / GC_BATCH). Closed-schema validated. Callers
   * choose insert-once (replay-sensitive receipts) or idempotent put.
   */
  static async putAuditReceipt(
    decisions: ICollection<A01StoredAuditRecord>,
    record: A01StoredAuditRecord,
    context: string,
    insertOnce: boolean,
  ): Promise<void> {
    assertAllowedAuditShape(record as unknown as Record<string, unknown>, context);
    if (insertOnce) {
      const res = await decisions.cas(record.id, (cur) => cur === undefined, () => cloneDoc(record));
      if (!res.ok) {
        throw new SecurityStateUnavailableError(`${context}: duplicate S-10 receipt id "${record.id}" (fail-closed).`);
      }
      return;
    }
    await decisions.put(cloneDoc(record));
  }

  // -- Retention / GC (§G) ----------------------------------------------------

  /**
   * GC safety interlock: refuse when ANY ACTIVE manifest's maxLifetimeMs +
   * skew exceeds the S-4 retention (deleting a consumed envelope that could
   * still authorize would resurrect it). Throws (delete nothing).
   */
  async assertGcInterlock(): Promise<void> {
    const actives = await this.listActiveManifests();
    for (const active of actives) {
      if (active.manifest.maxLifetimeMs + R2_SKEW_MS > SECURITY_S4_RETENTION_MS) {
        throw new SecurityStateError(
          `GC interlock: ACTIVE manifest "${active.capabilityId}" maxLifetimeMs (${active.manifest.maxLifetimeMs}) + skew exceeds S-4 retention (fail-closed; delete nothing).`,
        );
      }
    }
  }

  /**
   * Substrate retention sweep (explicit, audited, attributed to
   * `kernel:maintenance`). Deletes ONLY rows past their retention floor,
   * in bounded per-tenant batches, each batch evidenced by a GC_BATCH S-10
   * row in the SAME transaction as its deletes. Never deletes: S-1
   * history, S-2/S-3/S-8 revocation evidence, S-5 IN_PROGRESS (orphans are
   * marked EXPIRED, never deleted). Eligibility listing is a full
   * maintenance scan by design (ops-frequency; enforcement never scans).
   */
  async runGarbageCollection(now: number, options: { batchSize?: number } = {}): Promise<GcSummary> {
    if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
      throw new SecurityStateError('GC requires a valid clock (fail-closed).');
    }
    const batchSize = options.batchSize ?? SECURITY_GC_DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 5000) {
      throw new SecurityStateError('GC batchSize must be an integer in (0, 5000] (fail-closed).');
    }
    await this.assertGcInterlock();
    const summary: GcSummary = {
      deletedConsumedEnvelopes: 0,
      deletedIdempotency: 0,
      markedIdempotencyExpired: 0,
      deletedRateWindows: 0,
      deletedRunBudgets: 0,
      batches: 0,
    };
    const s4 = await this.gcDeleteEligible<ConsumedEnvelopeDoc>(
      SECURITY_CONSUMED_ENVELOPES_COLLECTION, now, batchSize,
      (row) => typeof row.consumedAt === 'number' && row.consumedAt < now - SECURITY_S4_RETENTION_MS,
    );
    summary.deletedConsumedEnvelopes = s4.deleted;
    summary.batches += s4.batches;
    const s6 = await this.gcDeleteEligible<RateWindowDoc>(
      SECURITY_RATE_WINDOWS_COLLECTION, now, batchSize,
      (row) => typeof row.windowStart === 'number' && typeof row.windowMs === 'number' &&
        row.windowStart + row.windowMs < now - SECURITY_S6_GC_GRACE_MS,
    );
    summary.deletedRateWindows = s6.deleted;
    summary.batches += s6.batches;
    const s7 = await this.gcDeleteEligible<RunBudgetDoc>(
      SECURITY_RUN_BUDGETS_COLLECTION, now, batchSize,
      (row) => typeof row.updatedAt === 'number' && row.updatedAt < now - SECURITY_S7_RETENTION_MS,
    );
    summary.deletedRunBudgets = s7.deleted;
    summary.batches += s7.batches;
    const s5 = await this.gcIdempotency(now, batchSize);
    summary.deletedIdempotency = s5.deleted;
    summary.markedIdempotencyExpired = s5.markedExpired;
    summary.batches += s5.batches;
    return summary;
  }

  /** List GC-eligible row ids grouped by tenant (system-scope maintenance scan). */
  private async gcEligibleByTenant<T extends { id: string; tenantId: string }>(
    collection: string,
    eligible: (row: T) => boolean,
  ): Promise<Map<string, string[]>> {
    const rows = await this.transact({ system: true }, async (collections) => {
      const handle = await collections.scope.collection<T>(collection);
      return handle.query({});
    });
    const byTenant = new Map<string, string[]>();
    for (const row of rows) {
      if (typeof row.tenantId !== 'string' || row.tenantId.length === 0) {
        throw new SecurityStateError(`GC: row "${row.id}" in "${collection}" has no tenant (fail-closed; delete nothing).`);
      }
      if (!eligible(row)) continue;
      const list = byTenant.get(row.tenantId) ?? [];
      list.push(row.id);
      byTenant.set(row.tenantId, list);
    }
    return byTenant;
  }

  private async gcDeleteEligible<T extends { id: string; tenantId: string }>(
    collection: string,
    now: number,
    batchSize: number,
    eligible: (row: T) => boolean,
  ): Promise<{ deleted: number; batches: number }> {
    const byTenant = await this.gcEligibleByTenant<T>(collection, eligible);
    let deleted = 0;
    let batches = 0;
    for (const [tenantId, ids] of byTenant) {
      for (let start = 0; start < ids.length; start += batchSize) {
        const batch = ids.slice(start, start + batchSize);
        const startedAt = this.now();
        const removed = await this.transact({ tenantId }, async (collections, txId) => {
          const handle = await collections.scope.collection<T>(collection);
          let count = 0;
          for (const id of batch) {
            if (await handle.delete(id)) count += 1;
          }
          await SecurityStateStore.putAuditReceipt(
            collections.decisions,
            {
              id: `gc:${collection}:${tenantId}:${now}:${txId}`,
              kind: 'GC_BATCH',
              collection,
              tenantId,
              deletedCount: count,
              markedExpiredCount: 0,
              maintenanceBy: SECURITY_MAINTENANCE_PRINCIPAL,
              startedAt,
              completedAt: this.now(),
            },
            `gc(${collection})`,
            false,
          );
          return count;
        });
        deleted += removed;
        batches += 1;
      }
    }
    return { deleted, batches };
  }

  private async gcIdempotency(now: number, batchSize: number): Promise<{ deleted: number; markedExpired: number; batches: number }> {
    const rows = await this.transact({ system: true }, async (collections) => collections.idempotency.query({}));
    const deletableByTenant = new Map<string, string[]>();
    const orphansByTenant = new Map<string, string[]>();
    for (const row of rows) {
      if (typeof row.tenantId !== 'string' || row.tenantId.length === 0) {
        throw new SecurityStateError(`GC: idempotency row "${row.id}" has no tenant (fail-closed; delete nothing).`);
      }
      if (
        (row.status === 'COMPLETED' && row.updatedAt < now - SECURITY_S5_COMPLETED_RETENTION_MS) ||
        (row.status === 'FAILED' && row.updatedAt < now - SECURITY_S5_FAILED_RETENTION_MS) ||
        (row.status === 'EXPIRED' && row.updatedAt < now - SECURITY_S5_FAILED_RETENTION_MS)
      ) {
        const list = deletableByTenant.get(row.tenantId) ?? [];
        list.push(row.id);
        deletableByTenant.set(row.tenantId, list);
      } else if (
        row.status === 'IN_PROGRESS' && typeof row.leaseExpiry === 'number' &&
        row.leaseExpiry + SECURITY_S5_ORPHAN_GRACE_MS < now
      ) {
        const list = orphansByTenant.get(row.tenantId) ?? [];
        list.push(row.id);
        orphansByTenant.set(row.tenantId, list);
      }
    }
    let deleted = 0;
    let markedExpired = 0;
    let batches = 0;
    const tenants = new Set([...deletableByTenant.keys(), ...orphansByTenant.keys()]);
    for (const tenantId of tenants) {
      const deletable = deletableByTenant.get(tenantId) ?? [];
      const orphans = orphansByTenant.get(tenantId) ?? [];
      const work: Array<{ id: string; mark: boolean }> = [
        ...deletable.map((id) => ({ id, mark: false as const })),
        ...orphans.map((id) => ({ id, mark: true as const })),
      ];
      for (let start = 0; start < work.length; start += batchSize) {
        const batch = work.slice(start, start + batchSize);
        const startedAt = this.now();
        const outcome = await this.transact({ tenantId }, async (collections, txId) => {
          let removed = 0;
          let marked = 0;
          for (const item of batch) {
            if (!item.mark) {
              if (await collections.idempotency.delete(item.id)) removed += 1;
              continue;
            }
            // Orphan sweep: mark EXPIRED via CAS (never delete). The guard
            // re-checks status + time inside the tx (no TOCTOU).
            const res = await collections.idempotency.cas(
              item.id,
              (cur) => !!cur && cur.status === 'IN_PROGRESS' && typeof cur.leaseExpiry === 'number' &&
                cur.leaseExpiry + SECURITY_S5_ORPHAN_GRACE_MS < this.now(),
              (cur) => ({ ...cur, status: 'EXPIRED' as const, updatedAt: this.now() }),
            );
            if (res.ok) marked += 1;
          }
          await SecurityStateStore.putAuditReceipt(
            collections.decisions,
            {
              id: `gc:${SECURITY_IDEMPOTENCY_COLLECTION}:${tenantId}:${now}:${txId}`,
              kind: 'GC_BATCH',
              collection: SECURITY_IDEMPOTENCY_COLLECTION,
              tenantId,
              deletedCount: removed,
              markedExpiredCount: marked,
              maintenanceBy: SECURITY_MAINTENANCE_PRINCIPAL,
              startedAt,
              completedAt: this.now(),
            },
            'gc(authorization.idempotency)',
            false,
          );
          return { removed, marked };
        });
        deleted += outcome.removed;
        markedExpired += outcome.marked;
        batches += 1;
      }
    }
    return { deleted, markedExpired, batches };
  }

  // -- Reconciliation (ops) ---------------------------------------------------

  /**
   * CONSUMED-consistency reconciliation: ALLOW decisions (DECISION rows)
   * with no matching CONSUMED row — the crash-between-Tx-1-and-Tx-2 orphan
   * set plus legitimately never-executed decisions. Ops runbook query;
   * enforcement never blocks on it.
   */
  async findDecisionsWithoutConsumption(
    tenantId: string,
    options: { since?: number } = {},
  ): Promise<ReadonlyArray<{ decisionId: string; envelopeId: string; decidedAt: number }>> {
    StorageModule.validateTenantId(tenantId);
    return this.transact({ tenantId }, async (collections) => {
      const rows = await collections.decisions.query({});
      const consumed = new Set<string>();
      const orphans: Array<{ decisionId: string; envelopeId: string; decidedAt: number }> = [];
      for (const row of rows) {
        if (row.kind === 'CONSUMED') consumed.add(row.envelopeId);
      }
      for (const row of rows) {
        if (row.kind !== 'DECISION' || row.decision !== 'ALLOW') continue;
        if (options.since !== undefined && row.decidedAt < options.since) continue;
        if (consumed.has(row.envelopeId)) continue;
        const decisionId = row.id.startsWith('decision-') ? row.id.slice('decision-'.length) : row.id;
        orphans.push({ decisionId, envelopeId: row.envelopeId, decidedAt: row.decidedAt });
      }
      return orphans.sort((a, b) => a.decidedAt - b.decidedAt);
    });
  }
}

export interface GcSummary {
  deletedConsumedEnvelopes: number;
  deletedIdempotency: number;
  markedIdempotencyExpired: number;
  deletedRateWindows: number;
  deletedRunBudgets: number;
  batches: number;
}

/**
 * The tx-bound collection handles for one enforcement transaction. All
 * handles share the caller's transaction (single atomic scope).
 */
export class SecurityTxCollections {
  private constructor(
    readonly scope: StorageWriteScope,
    readonly manifests: ICollection<ManifestDoc>,
    readonly credentials: ICollection<CredentialDoc>,
    readonly credentialUses: ICollection<CredentialUseDoc>,
    readonly consumedEnvelopes: ICollection<ConsumedEnvelopeDoc>,
    readonly idempotency: ICollection<IdempotencyDoc>,
    readonly rateWindows: ICollection<RateWindowDoc>,
    readonly runBudgets: ICollection<RunBudgetDoc>,
    readonly decisions: ICollection<A01StoredAuditRecord>,
    readonly sessions: ICollection<AuthenticationEventDoc>,
  ) {}

  static async open(scope: StorageWriteScope): Promise<SecurityTxCollections> {
    const [
      manifests, credentials, credentialUses, consumedEnvelopes, idempotency,
      rateWindows, runBudgets, decisions, sessions,
    ] = await Promise.all([
      scope.collection<ManifestDoc>(SECURITY_MANIFESTS_COLLECTION),
      scope.collection<CredentialDoc>(SECURITY_CREDENTIALS_COLLECTION),
      scope.collection<CredentialUseDoc>(SECURITY_CREDENTIAL_USES_COLLECTION),
      scope.collection<ConsumedEnvelopeDoc>(SECURITY_CONSUMED_ENVELOPES_COLLECTION),
      scope.collection<IdempotencyDoc>(SECURITY_IDEMPOTENCY_COLLECTION),
      scope.collection<RateWindowDoc>(SECURITY_RATE_WINDOWS_COLLECTION),
      scope.collection<RunBudgetDoc>(SECURITY_RUN_BUDGETS_COLLECTION),
      scope.collection<A01StoredAuditRecord>(AUTHORIZATION_DECISIONS_COLLECTION),
      scope.collection<AuthenticationEventDoc>(AUTHENTICATION_EVENTS_COLLECTION),
    ]);
    return new SecurityTxCollections(
      scope, manifests, credentials, credentialUses, consumedEnvelopes, idempotency,
      rateWindows, runBudgets, decisions, sessions,
    );
  }
}

/** Reviewed secondary indexes (§F): operational/GC queries only, never enforcement (hot paths are PK). */
const REVIEWED_SECURITY_INDEXES: ReadonlyArray<readonly [string, CollectionIndexDef]> = Object.freeze([
  [SECURITY_MANIFESTS_COLLECTION, { name: 'by_capability_status', keys: ['capabilityId', 'status'], includeTenant: true }],
  [SECURITY_CREDENTIALS_COLLECTION, { name: 'by_principal_status', keys: ['principalId', 'status'], includeTenant: true }],
  [SECURITY_CREDENTIAL_USES_COLLECTION, { name: 'by_credential', keys: ['credentialId'], includeTenant: true }],
  [SECURITY_CONSUMED_ENVELOPES_COLLECTION, { name: 'by_updated', keys: ['updatedAt'], includeTenant: true }],
  [SECURITY_IDEMPOTENCY_COLLECTION, { name: 'by_status', keys: ['status'], includeTenant: true }],
  [SECURITY_RATE_WINDOWS_COLLECTION, { name: 'by_window', keys: ['windowStart'], includeTenant: true }],
  [SECURITY_RUN_BUDGETS_COLLECTION, { name: 'by_updated', keys: ['updatedAt'], includeTenant: true }],
  [AUTHORIZATION_DECISIONS_COLLECTION, { name: 'by_envelope', keys: ['envelopeId'], includeTenant: true }],
]);

function cloneDoc<T>(doc: T): T {
  return JSON.parse(JSON.stringify(doc)) as T;
}
