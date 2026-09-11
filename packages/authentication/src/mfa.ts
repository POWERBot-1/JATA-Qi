/**
 * P2-S5 — MFA / stronger identity assurance.
 *
 * WHAT THIS IS
 *
 * A governed MFA capability that plugs into the EXISTING identity, session,
 * credential, audit and privilege architecture. It adds an authentication
 * ASSURANCE signal; it does not add an authorization engine.
 *
 * THE SECURITY CHAIN THIS RESPECTS
 *
 *   identity → authentication → MFA assurance → authorization decision → capability
 *
 * S5 produces the third link only. Consistent with the S7 correction
 * ("S7 binds and audits; S7 does not authorize"), the same is true here:
 *
 *   MFA VERIFICATION IS NOT AUTHORIZATION.
 *
 * A satisfied MFA challenge proves something about who is presenting a factor.
 * It does not decide what that principal may do — that remains the existing
 * authority plane's job (see `privilege-store.ts`). S5 makes the plane's
 * existing `stepUpEventId` / `stepUpAt` fields MEANINGFUL; it does not replace
 * the plane.
 *
 * THE GAP THIS CLOSES (measured, not assumed)
 *
 * Before S5, `privilege-store.ts` required step-up evidence but only checked
 * that it was PRESENT and not future-beyond-skew:
 *
 *   - `stepUpMaxAgeMs` was declared on every register entry and used in NO
 *     comparison anywhere (verified: it appears only in type/register
 *     positions at privilege-store.ts:332,358,474,528,554).
 *   - `stepUpEventId` was never resolved against any event store; it was only
 *     propagated (delegation-store.ts:351) and typed.
 *
 * So a caller could satisfy the guard by asserting `stepUpAt: Date.now()` and
 * `stepUpEventId: 'anything'` — the bootstrap path does exactly that
 * (privilege-store.ts:427-428). The control LOOKED enforced (it throws
 * STEP_UP_REQUIRED) but was satisfiable by self-assertion.
 *
 * `verifyStepUpEvidence()` below is the fix: the plane can now resolve a
 * durable assurance record and enforce tenant, principal, session and
 * FRESHNESS against the register's declared `stepUpMaxAgeMs`.
 *
 * FACTOR CHOICE
 *
 * TOTP (RFC 6238), implemented locally over `node:crypto` HMAC-SHA1. No vendor
 * dependency, no network dependency, no third-party authenticator service.
 *
 * TOTP DOES NOT SOLVE ACCOUNT TAKEOVER. It raises the cost of a
 * credential-only compromise. It does not resist a real-time phishing proxy,
 * and it is not a possession proof in the FIDO2 sense. This is stated rather
 * than implied.
 *
 * SECRET HANDLING
 *
 * The TOTP shared secret is sealed through the S7 `SecretMaterialStore` with
 * `purpose: 'totp'` (a purpose S7 already reserved and nothing consumed). It is
 * therefore never plaintext at rest, never in an audit record, and never
 * retrievable after enrollment — `enroll()` returns it ONCE. There is no
 * in-memory production fallback and no dev double in this module: the secret
 * path is whatever S7's seam is, and S7 already refuses a dev seam in
 * production.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { StorageModule, type SecurityCollectionSource, type StorageWriteScope } from '@jataqi/storage';
import type { SecretMaterialStore, SecretRef } from './secret-material.js';

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export const MFA_FACTOR_COLLECTION = 'identity.mfa-factor';
export const MFA_ASSURANCE_COLLECTION = 'identity.mfa-assurance';
export const MFA_EVENT_COLLECTION = 'identity.mfa-event';
export const MFA_THROTTLE_COLLECTION = 'identity.mfa-throttle';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type MfaFactorKind = 'totp';

export type MfaFactorStatus = 'PENDING' | 'ACTIVE' | 'REVOKED' | 'REPLACED';

/**
 * Assurance levels are an ORDERED scale. A consumer declares the level it
 * needs; S5 reports the level it actually achieved. S5 never decides whether
 * that level is sufficient — the authority plane does.
 */
export type MfaAssuranceLevel = 'none' | 'single-factor' | 'multi-factor' | 'step-up';

export const MFA_ASSURANCE_RANK: Readonly<Record<MfaAssuranceLevel, number>> = Object.freeze({
  none: 0,
  'single-factor': 1,
  'multi-factor': 2,
  'step-up': 3,
});

/** The full audit vocabulary required by the S5 mandate. */
export type MfaEventKind =
  | 'ENROLLMENT_ATTEMPTED'
  | 'ENROLLMENT_SUCCEEDED'
  | 'ENROLLMENT_FAILED'
  | 'ACTIVATION_SUCCEEDED'
  | 'ACTIVATION_FAILED'
  | 'VERIFICATION_SUCCEEDED'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_REPLAYED'
  | 'FACTOR_REVOKED'
  | 'FACTOR_REPLACED'
  | 'RECOVERY_ATTEMPTED'
  | 'RECOVERY_SUCCEEDED'
  | 'RECOVERY_FAILED'
  | 'STEP_UP_REQUESTED'
  | 'STEP_UP_SATISFIED'
  | 'STEP_UP_DENIED'
  | 'THROTTLED';

export type MfaOperation = 'enroll' | 'activate' | 'verify' | 'revoke' | 'replace' | 'recover';

/** Closed failure codes. Messages are identifier-only by construction. */
export type MfaFailureCode =
  | 'MFA_INVALID_ARGUMENT'
  | 'MFA_UNKNOWN'
  | 'MFA_NOT_ACTIVE'
  | 'MFA_CODE_INVALID'
  | 'MFA_CODE_REPLAYED'
  | 'MFA_ALREADY_ENROLLED'
  | 'MFA_NOT_ENROLLED'
  | 'MFA_THROTTLED'
  | 'MFA_RECOVERY_NOT_ELIGIBLE'
  | 'MFA_ASSURANCE_UNKNOWN'
  | 'MFA_ASSURANCE_EXPIRED'
  | 'MFA_ASSURANCE_MISMATCH'
  | 'MFA_SEAM_UNAVAILABLE';

export class MfaError extends Error {
  readonly code: MfaFailureCode;
  readonly factorId?: string;
  readonly operation?: MfaOperation;

  constructor(code: MfaFailureCode, detail: { readonly factorId?: string; readonly operation?: MfaOperation } = {}) {
    // Identifier-only. No secret, no code value, no tenant, no principal.
    super(`MFA operation refused: ${code}`);
    this.name = 'MfaError';
    this.code = code;
    if (detail.factorId !== undefined) this.factorId = detail.factorId;
    if (detail.operation !== undefined) this.operation = detail.operation;
  }
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — local, no vendor
// ---------------------------------------------------------------------------

export interface TotpParameters {
  readonly periodSeconds: number;
  readonly digits: number;
  readonly window: number;
  readonly secretBytes: number;
}

export const DEFAULT_TOTP_PARAMETERS: TotpParameters = Object.freeze({
  periodSeconds: 30,
  digits: 6,
  window: 1,
  secretBytes: 20,
});

/** RFC 4648 base32 (no padding) — the encoding authenticator apps expect. */
export function base32Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32 for enrollment import. Rejects anything malformed (fail-closed). */
export function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  if (clean.length === 0) throw new MfaError('MFA_INVALID_ARGUMENT');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) throw new MfaError('MFA_INVALID_ARGUMENT');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function hotp(secret: Uint8Array, counter: number, digits: number): string {
  const buffer = Buffer.alloc(8);
  // 64-bit big-endian counter.
  for (let i = 7; i >= 0; i -= 1) {
    buffer[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const digest = createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP code for an absolute instant. */
export function totpAt(secret: Uint8Array, atMs: number, params: TotpParameters = DEFAULT_TOTP_PARAMETERS): string {
  const step = Math.floor(atMs / 1000 / params.periodSeconds);
  return hotp(secret, step, params.digits);
}

/**
 * Verify a presented code against the ±window.
 *
 * Returns the matched time step, or undefined. The step is returned (not a
 * boolean) so the caller can record WHICH step was consumed for replay
 * resistance — consuming only "the current step" would let an attacker replay
 * a code inside the window after a legitimate use.
 */
export function totpVerifyStep(
  secret: Uint8Array,
  code: string,
  atMs: number,
  params: TotpParameters = DEFAULT_TOTP_PARAMETERS,
): number | undefined {
  if (typeof code !== 'string') return undefined;
  const presented = code.trim();
  if (!/^[0-9]+$/.test(presented) || presented.length !== params.digits) return undefined;
  const current = Math.floor(atMs / 1000 / params.periodSeconds);
  const expected = Buffer.from(presented, 'utf8');
  for (let delta = -params.window; delta <= params.window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const candidate = Buffer.from(hotp(secret, step, params.digits), 'utf8');
    // Constant-time: code comparison must not leak by timing.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return step;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Durable documents
// ---------------------------------------------------------------------------

export interface MfaFactorDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly kind: MfaFactorKind;
  readonly status: MfaFactorStatus;
  /** S7 SecretRef identifiers — never the secret itself. */
  readonly secretId: string;
  readonly secretVersion: number;
  readonly params: TotpParameters;
  readonly enrolledAt: number;
  readonly activatedAt?: number;
  readonly revokedAt?: number;
  readonly replacedById?: string;
  /** Monotonic guard for CAS. */
  readonly revision: number;
}

export interface MfaAssuranceDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  /** The session this assurance was earned in. Binding prevents transplant. */
  readonly sessionId?: string;
  readonly level: MfaAssuranceLevel;
  readonly factorId: string;
  readonly factorKind: MfaFactorKind;
  readonly satisfiedAt: number;
  readonly correlationId: string;
}

export interface MfaEventRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly actorPrincipalId: string;
  readonly kind: MfaEventKind;
  readonly operation: MfaOperation;
  readonly factorId?: string;
  readonly assuranceId?: string;
  readonly sessionId?: string;
  readonly correlationId: string;
  readonly at: number;
}

interface MfaThrottleDoc {
  id: string;
  tenantId: string;
  principalId: string;
  operation: MfaOperation;
  failures: number;
  windowStartedAt: number;
  lockedUntil?: number;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface MfaThrottlePolicy {
  /** Failures allowed inside the window before lockout. */
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly lockoutMs: number;
}

export const DEFAULT_MFA_THROTTLE_POLICY: MfaThrottlePolicy = Object.freeze({
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
});

/** How long a step-up assurance stays usable by default. */
export const DEFAULT_MFA_STEP_UP_MAX_AGE_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Audit sink (optional, never best-effort on the throwing path)
// ---------------------------------------------------------------------------

export interface MfaAuditSink {
  record(entry: MfaEventRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface EnrollInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly actorPrincipalId: string;
  readonly correlationId?: string;
}

export interface EnrollResult {
  readonly factorId: string;
  /**
   * Returned ONCE, at enrollment only. There is no API that returns it again:
   * the sealed secret is write-only from this module's perspective after this
   * call. Losing it means enrolling a replacement.
   */
  readonly sharedSecretBase32: string;
  readonly params: TotpParameters;
  readonly status: MfaFactorStatus;
}

export interface VerifyInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly actorPrincipalId: string;
  readonly factorId: string;
  readonly code: string;
  /** Binds the resulting assurance to a session, preventing transplant. */
  readonly sessionId?: string;
  /** Request step-up level; default multi-factor. */
  readonly level?: MfaAssuranceLevel;
  readonly correlationId?: string;
}

export interface VerifyResult {
  readonly assuranceId: string;
  readonly level: MfaAssuranceLevel;
  readonly satisfiedAt: number;
  readonly factorId: string;
}

/**
 * The step-up evidence the privilege plane should verify INSTEAD OF trusting
 * caller-supplied timestamps.
 */
export interface StepUpEvidenceInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly assuranceId: string;
  readonly claimedAt: number;
  readonly maxAgeMs: number;
  readonly sessionId?: string;
  readonly requiredLevel?: MfaAssuranceLevel;
  readonly now: number;
}

export class MfaFactorStore {
  private constructor(
    private readonly source: SecurityCollectionSource,
    private readonly secrets: SecretMaterialStore,
    private readonly auditSink: MfaAuditSink | undefined,
    private readonly throttle: MfaThrottlePolicy,
  ) {}

  static async open(
    source: SecurityCollectionSource,
    secrets: SecretMaterialStore,
    options: {
      readonly auditSink?: MfaAuditSink;
      readonly throttlePolicy?: MfaThrottlePolicy;
    } = {},
  ): Promise<MfaFactorStore> {
    // Same posture as S7: a source that cannot transact is refused, not degraded.
    let transactional = false;
    try {
      transactional = source.supportsTransactions() === true;
    } catch {
      transactional = false;
    }
    if (!transactional) throw new MfaError('MFA_SEAM_UNAVAILABLE');
    if (!secrets || typeof secrets !== 'object') throw new MfaError('MFA_SEAM_UNAVAILABLE');
    if (options.auditSink !== undefined && typeof options.auditSink.record !== 'function') {
      throw new MfaError('MFA_INVALID_ARGUMENT');
    }
    const policy = options.throttlePolicy ?? DEFAULT_MFA_THROTTLE_POLICY;
    if (
      !Number.isFinite(policy.maxFailures) ||
      policy.maxFailures < 1 ||
      !Number.isFinite(policy.windowMs) ||
      policy.windowMs < 1 ||
      !Number.isFinite(policy.lockoutMs) ||
      policy.lockoutMs < 0
    ) {
      throw new MfaError('MFA_INVALID_ARGUMENT');
    }
    const store = new MfaFactorStore(source, secrets, options.auditSink, policy);
    const driver = source.getDriver();
    if (typeof driver.ensureIndex === 'function') {
      await driver.ensureIndex(MFA_FACTOR_COLLECTION, { name: 'by_principal', keys: ['principalId'], includeTenant: true });
      await driver.ensureIndex(MFA_ASSURANCE_COLLECTION, { name: 'by_principal', keys: ['principalId'], includeTenant: true });
    }
    return store;
  }

  // -------------------------------------------------------------------
  // Tenant scoping — every read and write is inside an RLS-scoped transaction
  // -------------------------------------------------------------------

  async #inTenant<T>(tenantId: string, fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    StorageModule.validateTenantId(tenantId);
    return this.source.atomically(async (scope) => {
      // Fail closed on a non-atomic scope: MFA state (and its audit) must never
      // be written outside a transaction.
      if (!scope.atomic) throw new MfaError('MFA_SEAM_UNAVAILABLE');
      return fn(scope);
    }, { tenantId });
  }

  async #audit(entry: Omit<MfaEventRecord, 'id'>): Promise<void> {
    const record: MfaEventRecord = { id: `mfaev_${randomUUID()}`, ...entry };
    await this.#inTenant(entry.tenantId, async (scope) => {
      const rows = await scope.collection<MfaEventRecord>(MFA_EVENT_COLLECTION);
      // A throw aborts the surrounding transaction: an unauditable MFA event
      // must not complete. Audit availability never weakens fail-closed.
      await rows.put(record);
    });
    if (this.auditSink) await this.auditSink.record(record);
  }

  /** Audit a REFUSED operation in its own committed transaction, then throw. */
  async #refuse(code: MfaFailureCode, entry: Omit<MfaEventRecord, 'id'>, factorId?: string): Promise<never> {
    await this.#audit(entry).catch(() => undefined);
    throw new MfaError(code, { factorId, operation: entry.operation });
  }

  #correlation(input: { readonly correlationId?: string }): string {
    return input.correlationId?.trim() || `mfacor_${randomUUID()}`;
  }

  // -------------------------------------------------------------------
  // Throttle
  // -------------------------------------------------------------------

  #throttleId(tenantId: string, principalId: string, operation: MfaOperation): string {
    return `mfath_${tenantId}_${principalId}_${operation}`;
  }

  async #checkThrottle(scope: StorageWriteScope, tenantId: string, principalId: string, operation: MfaOperation, now: number): Promise<void> {
    const rows = await scope.collection<MfaThrottleDoc>(MFA_THROTTLE_COLLECTION);
    const doc = await rows.get(this.#throttleId(tenantId, principalId, operation));
    if (!doc) return;
    if (doc.lockedUntil !== undefined && doc.lockedUntil > now) throw new MfaError('MFA_THROTTLED', { operation });
  }

  async #noteFailure(scope: StorageWriteScope, tenantId: string, principalId: string, operation: MfaOperation, now: number): Promise<boolean> {
    const rows = await scope.collection<MfaThrottleDoc>(MFA_THROTTLE_COLLECTION);
    const id = this.#throttleId(tenantId, principalId, operation);
    const existing = await rows.get(id);
    const fresh = existing === undefined || now - existing.windowStartedAt > this.throttle.windowMs;
    const failures = fresh ? 1 : existing!.failures + 1;
    const locked = failures >= this.throttle.maxFailures;
    const doc: MfaThrottleDoc = {
      id,
      tenantId,
      principalId,
      operation,
      failures: locked ? 0 : failures,
      windowStartedAt: fresh || locked ? now : existing!.windowStartedAt,
      ...(locked ? { lockedUntil: now + this.throttle.lockoutMs } : {}),
    };
    await rows.put(doc);
    // Lockout EXPIRES. Account protection must not become a permanent,
    // attacker-triggered denial of service against the victim.
    return locked;
  }

  /**
   * Record a failure in its OWN committed transaction.
   *
   * This is necessary, not cosmetic. A refusal ends by throwing, and a throw
   * aborts the surrounding transaction — so incrementing the counter inside the
   * same transaction silently rolls the increment back and the throttle never
   * accumulates. The first version of this module had exactly that bug: the
   * throttle looked implemented and never engaged.
   *
   * Returns true when the failure budget is exhausted (the caller then reports
   * MFA_THROTTLED). A failure to record is swallowed: throttling is a control,
   * not a gate, and a throttle-bookkeeping outage must not be able to block a
   * legitimate verification.
   */
  async #noteFailureCommitted(tenantId: string, principalId: string, operation: MfaOperation, now: number): Promise<boolean> {
    try {
      return await this.#inTenant(tenantId, (scope) => this.#noteFailure(scope, tenantId, principalId, operation, now));
    } catch {
      return false;
    }
  }

  async #clearThrottle(scope: StorageWriteScope, tenantId: string, principalId: string, operation: MfaOperation): Promise<void> {
    const rows = await scope.collection<MfaThrottleDoc>(MFA_THROTTLE_COLLECTION);
    await rows.delete(this.#throttleId(tenantId, principalId, operation));
  }

  // -------------------------------------------------------------------
  // Factor lookup — identical failure for every wrong-binding case
  // -------------------------------------------------------------------

  async #factor(scope: StorageWriteScope, tenantId: string, principalId: string, factorId: string): Promise<MfaFactorDoc | undefined> {
    const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
    const doc = await rows.get(factorId);
    // Cross-tenant rows are invisible under RLS; a cross-principal row is
    // indistinguishable from a nonexistent one. No identifier oracle.
    if (!doc || doc.tenantId !== tenantId || doc.principalId !== principalId) return undefined;
    return doc;
  }

  // -------------------------------------------------------------------
  // Enrollment
  // -------------------------------------------------------------------

  async enroll(input: EnrollInput): Promise<EnrollResult> {
    const correlationId = this.#correlation(input);
    if (!isNonBlank(input.tenantId) || !isNonBlank(input.principalId) || !isNonBlank(input.actorPrincipalId)) {
      await this.#refuse('MFA_INVALID_ARGUMENT', {
        tenantId: safeTenant(input.tenantId),
        principalId: input.principalId ?? '',
        actorPrincipalId: input.actorPrincipalId ?? '',
        kind: 'ENROLLMENT_FAILED',
        operation: 'enroll',
        correlationId,
        at: Date.now(),
      });
    }
    const now = Date.now();
    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'ENROLLMENT_ATTEMPTED',
      operation: 'enroll',
      correlationId,
      at: now,
    });

    // One ACTIVE/PENDING factor per principal. Replacement is an explicit
    // operation, so an attacker who can call enroll cannot silently swap a
    // victim's factor out from under them.
    const clash = await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
      const all = await rows.query({ where: (row) => row.principalId === input.principalId });
      return all.some((doc) => doc.status === 'ACTIVE' || doc.status === 'PENDING');
    });
    if (clash) {
      await this.#refuse('MFA_ALREADY_ENROLLED', {
        tenantId: input.tenantId,
        principalId: input.principalId,
        actorPrincipalId: input.actorPrincipalId,
        kind: 'ENROLLMENT_FAILED',
        operation: 'enroll',
        correlationId,
        at: Date.now(),
      });
    }

    const factorId = `mfaf_${randomUUID()}`;
    const secretId = `mfasec_${factorId.slice(5)}`;
    const secret = randomBytes(DEFAULT_TOTP_PARAMETERS.secretBytes);
    const params = DEFAULT_TOTP_PARAMETERS;

    // Sealed through S7 with purpose 'totp': never plaintext at rest, and the
    // sealing context binds tenant+principal+purpose+secretId as GCM AAD.
    let ref: SecretRef;
    try {
      ref = await this.secrets.seal({
        tenantId: input.tenantId,
        principalId: input.principalId,
        actorPrincipalId: input.actorPrincipalId,
        purpose: 'totp',
        secretId,
        material: secret,
        correlationId,
      });
    } catch {
      // Never propagate a provider error: it could echo input bytes.
      await this.#refuse('MFA_SEAM_UNAVAILABLE', {
        tenantId: input.tenantId,
        principalId: input.principalId,
        actorPrincipalId: input.actorPrincipalId,
        kind: 'ENROLLMENT_FAILED',
        operation: 'enroll',
        correlationId,
        at: Date.now(),
      }, factorId);
      // Unreachable: #refuse always throws. Present so control flow is provable.
      throw new MfaError('MFA_SEAM_UNAVAILABLE', { factorId, operation: 'enroll' });
    }

    const doc: MfaFactorDoc = {
      id: factorId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      kind: 'totp',
      status: 'PENDING',
      secretId: ref.secretId,
      secretVersion: ref.version,
      params,
      enrolledAt: now,
      revision: 1,
    };
    await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
      await rows.put(doc);
    });
    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'ENROLLMENT_SUCCEEDED',
      operation: 'enroll',
      factorId,
      correlationId,
      at: Date.now(),
    });

    return {
      factorId,
      sharedSecretBase32: base32Encode(secret),
      params,
      status: 'PENDING',
    };
  }

  // -------------------------------------------------------------------
  // Activation (enrollment confirmation)
  // -------------------------------------------------------------------

  async activate(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly actorPrincipalId: string;
    readonly factorId: string;
    readonly code: string;
    readonly correlationId?: string;
  }): Promise<{ readonly factorId: string; readonly status: MfaFactorStatus }> {
    const correlationId = this.#correlation(input);
    const now = Date.now();
    const attempt = async (): Promise<{ factorId: string; status: MfaFactorStatus }> => {
      return this.#inTenant(input.tenantId, async (scope) => {
        await this.#checkThrottle(scope, input.tenantId, input.principalId, 'activate', now);
        const doc = await this.#factor(scope, input.tenantId, input.principalId, input.factorId);
        if (!doc) throw new MfaError('MFA_UNKNOWN', { factorId: input.factorId, operation: 'activate' });
        if (doc.status !== 'PENDING') throw new MfaError('MFA_NOT_ACTIVE', { factorId: input.factorId, operation: 'activate' });
        const material = await this.secrets.open({
          tenantId: input.tenantId,
          principalId: input.principalId,
          actorPrincipalId: input.actorPrincipalId,
          purpose: 'totp',
          secretId: doc.secretId,
          correlationId,
        });
        const step = totpVerifyStep(material, input.code, now, doc.params);
        // Detect only. The failure is recorded AFTER this transaction aborts,
        // otherwise the increment is rolled back with it.
        if (step === undefined) throw new MfaError('MFA_CODE_INVALID', { factorId: input.factorId, operation: 'activate' });
        const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
        await rows.put({ ...doc, status: 'ACTIVE' as const, activatedAt: now, revision: doc.revision + 1 });
        await this.#clearThrottle(scope, input.tenantId, input.principalId, 'activate');
        return { factorId: doc.id, status: 'ACTIVE' as const };
      });
    };
    let result: { factorId: string; status: MfaFactorStatus };
    try {
      result = await attempt();
    } catch (error) {
      const code = error instanceof MfaError ? error.code : 'MFA_SEAM_UNAVAILABLE';
      let locked = false;
      if (code === 'MFA_CODE_INVALID') {
        locked = await this.#noteFailureCommitted(input.tenantId, input.principalId, 'activate', now);
      }
      await this.#audit({
        tenantId: input.tenantId,
        principalId: input.principalId,
        actorPrincipalId: input.actorPrincipalId,
        kind: 'ACTIVATION_FAILED',
        operation: 'activate',
        factorId: input.factorId,
        correlationId,
        at: Date.now(),
      }).catch(() => undefined);
      if (locked) throw new MfaError('MFA_THROTTLED', { factorId: input.factorId, operation: 'activate' });
      throw error instanceof MfaError ? error : new MfaError(code, { factorId: input.factorId, operation: 'activate' });
    }
    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'ACTIVATION_SUCCEEDED',
      operation: 'activate',
      factorId: result.factorId,
      correlationId,
      at: Date.now(),
    });
    return result;
  }

  // -------------------------------------------------------------------
  // Verification — the assurance producer
  // -------------------------------------------------------------------

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const correlationId = this.#correlation(input);
    const level = input.level ?? 'multi-factor';
    const now = Date.now();

    const produce = async (): Promise<VerifyResult> => {
      return this.#inTenant(input.tenantId, async (scope) => {
        await this.#checkThrottle(scope, input.tenantId, input.principalId, 'verify', now);
        const doc = await this.#factor(scope, input.tenantId, input.principalId, input.factorId);
        if (!doc) throw new MfaError('MFA_UNKNOWN', { factorId: input.factorId, operation: 'verify' });
        if (doc.status !== 'ACTIVE') throw new MfaError('MFA_NOT_ACTIVE', { factorId: input.factorId, operation: 'verify' });

        const material = await this.secrets.open({
          tenantId: input.tenantId,
          principalId: input.principalId,
          actorPrincipalId: input.actorPrincipalId,
          purpose: 'totp',
          secretId: doc.secretId,
          correlationId,
        });
        const step = totpVerifyStep(material, input.code, now, doc.params);
        // Detect only — see #noteFailureCommitted for why the increment cannot
        // happen inside this transaction.
        if (step === undefined) throw new MfaError('MFA_CODE_INVALID', { factorId: input.factorId, operation: 'verify' });

        // REPLAY RESISTANCE. A time step may be consumed at most once per
        // factor. Without this, a code captured in transit stays valid for the
        // rest of its ±window even after the legitimate holder used it.
        //
        // The claim MUST be an atomic compare-and-swap, not get-then-put. The
        // first version of this module did get-then-put, which passed a
        // standalone run and then let 5 of 6 concurrent racers consume the same
        // code under full-suite load: every transaction observed "not consumed"
        // before any of them wrote. `cas` takes a driver-level per-document
        // lock, so exactly one racer can win the claim.
        const consumedKey = `mfacons_${input.tenantId}_${input.principalId}_${input.factorId}_${step}`;
        const consumedRows = await scope.collection<{ id: string; consumedAt: number }>(MFA_THROTTLE_COLLECTION);
        const claimed = await consumedRows.cas(
          consumedKey,
          (current) => current === undefined,
          () => ({ id: consumedKey, consumedAt: now }),
        );
        if (!claimed.ok) throw new MfaError('MFA_CODE_REPLAYED', { factorId: input.factorId, operation: 'verify' });

        const assuranceId = `mfaasr_${randomUUID()}`;
        const assurance: MfaAssuranceDoc = {
          id: assuranceId,
          tenantId: input.tenantId,
          principalId: input.principalId,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          level,
          factorId: doc.id,
          factorKind: doc.kind,
          satisfiedAt: now,
          correlationId,
        };
        const assuranceRows = await scope.collection<MfaAssuranceDoc>(MFA_ASSURANCE_COLLECTION);
        await assuranceRows.put(assurance);
        await this.#clearThrottle(scope, input.tenantId, input.principalId, 'verify');
        return { assuranceId, level, satisfiedAt: now, factorId: doc.id };
      });
    };

    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'STEP_UP_REQUESTED',
      operation: 'verify',
      factorId: input.factorId,
      sessionId: input.sessionId,
      correlationId,
      at: now,
    });

    let result: VerifyResult;
    try {
      result = await produce();
    } catch (error) {
      let locked = false;
      if (error instanceof MfaError && error.code === 'MFA_CODE_INVALID') {
        locked = await this.#noteFailureCommitted(input.tenantId, input.principalId, 'verify', now);
      }
      const kind: MfaEventKind =
        error instanceof MfaError && error.code === 'MFA_CODE_REPLAYED' ? 'VERIFICATION_REPLAYED' : 'VERIFICATION_FAILED';
      await this.#audit({
        tenantId: input.tenantId,
        principalId: input.principalId,
        actorPrincipalId: input.actorPrincipalId,
        kind,
        operation: 'verify',
        factorId: input.factorId,
        sessionId: input.sessionId,
        correlationId,
        at: Date.now(),
      }).catch(() => undefined);
      if (locked || (error instanceof MfaError && error.code === 'MFA_THROTTLED')) {
        await this.#audit({
          tenantId: input.tenantId,
          principalId: input.principalId,
          actorPrincipalId: input.actorPrincipalId,
          kind: 'THROTTLED',
          operation: 'verify',
          factorId: input.factorId,
          correlationId,
          at: Date.now(),
        }).catch(() => undefined);
      }
      if (error instanceof MfaError) {
        await this.#audit({
          tenantId: input.tenantId,
          principalId: input.principalId,
          actorPrincipalId: input.actorPrincipalId,
          kind: 'STEP_UP_DENIED',
          operation: 'verify',
          factorId: input.factorId,
          correlationId,
          at: Date.now(),
        }).catch(() => undefined);
      }
      if (locked) throw new MfaError('MFA_THROTTLED', { factorId: input.factorId, operation: 'verify' });
      throw error instanceof MfaError ? error : new MfaError('MFA_SEAM_UNAVAILABLE', { factorId: input.factorId, operation: 'verify' });
    }

    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'VERIFICATION_SUCCEEDED',
      operation: 'verify',
      factorId: result.factorId,
      assuranceId: result.assuranceId,
      sessionId: input.sessionId,
      correlationId,
      at: Date.now(),
    });
    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'STEP_UP_SATISFIED',
      operation: 'verify',
      factorId: result.factorId,
      assuranceId: result.assuranceId,
      sessionId: input.sessionId,
      correlationId,
      at: Date.now(),
    });
    return result;
  }

  // -------------------------------------------------------------------
  // THE FIX: verifiable step-up evidence for the existing authority plane
  // -------------------------------------------------------------------

  /**
   * Resolve a step-up assurance and prove it is real, correctly bound, and
   * still fresh.
   *
   * This is what `privilege-store.grantElevation` should consult instead of
   * trusting caller-supplied `stepUpAt` / `stepUpEventId`. It enforces the
   * register's declared `stepUpMaxAgeMs`, which before S5 was declared on every
   * entry and checked nowhere.
   *
   * S5 still does NOT decide whether the operation may proceed — it returns the
   * verified assurance, and the plane decides.
   */
  async verifyStepUpEvidence(input: StepUpEvidenceInput): Promise<MfaAssuranceDoc> {
    const base = {
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.principalId,
      operation: 'verify' as MfaOperation,
      correlationId: `mfacor_${randomUUID()}`,
      at: Date.now(),
    };
    if (
      !isNonBlank(input.tenantId) ||
      !isNonBlank(input.principalId) ||
      !isNonBlank(input.assuranceId) ||
      !Number.isFinite(input.claimedAt) ||
      !Number.isFinite(input.maxAgeMs) ||
      input.maxAgeMs < 0
    ) {
      await this.#refuse('MFA_INVALID_ARGUMENT', { ...base, kind: 'STEP_UP_DENIED' });
    }
    const doc = await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<MfaAssuranceDoc>(MFA_ASSURANCE_COLLECTION);
      const found = await rows.get(input.assuranceId);
      if (!found || found.tenantId !== input.tenantId || found.principalId !== input.principalId) return undefined;
      return found;
    });
    // Unknown, cross-tenant and cross-principal are the SAME refusal.
    if (!doc) await this.#refuse('MFA_ASSURANCE_UNKNOWN', { ...base, kind: 'STEP_UP_DENIED' });

    // The caller's claimed timestamp must agree with the durable record, so a
    // caller cannot present an old assurance with a fresh timestamp.
    if (doc!.satisfiedAt !== input.claimedAt) {
      await this.#refuse('MFA_ASSURANCE_MISMATCH', { ...base, kind: 'STEP_UP_DENIED', assuranceId: doc!.id });
    }
    // FRESHNESS — the check that did not exist before S5.
    if (input.now - doc!.satisfiedAt > input.maxAgeMs) {
      await this.#refuse('MFA_ASSURANCE_EXPIRED', { ...base, kind: 'STEP_UP_DENIED', assuranceId: doc!.id });
    }
    if (input.now < doc!.satisfiedAt) {
      await this.#refuse('MFA_ASSURANCE_MISMATCH', { ...base, kind: 'STEP_UP_DENIED', assuranceId: doc!.id });
    }
    // Session binding: an assurance earned in one session cannot be replayed
    // into another. A low-assurance session cannot inherit a high-assurance one.
    if (input.sessionId !== undefined && doc!.sessionId !== input.sessionId) {
      await this.#refuse('MFA_ASSURANCE_MISMATCH', { ...base, kind: 'STEP_UP_DENIED', assuranceId: doc!.id });
    }
    if (input.requiredLevel !== undefined && MFA_ASSURANCE_RANK[doc!.level] < MFA_ASSURANCE_RANK[input.requiredLevel]) {
      await this.#refuse('MFA_ASSURANCE_MISMATCH', { ...base, kind: 'STEP_UP_DENIED', assuranceId: doc!.id });
    }
    return doc!;
  }

  // -------------------------------------------------------------------
  // Lifecycle: revoke / replace / recover
  // -------------------------------------------------------------------

  async revoke(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly actorPrincipalId: string;
    readonly factorId: string;
    readonly correlationId?: string;
  }): Promise<void> {
    const correlationId = this.#correlation(input);
    const now = Date.now();
    const sealed = await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
      const doc = await this.#factor(scope, input.tenantId, input.principalId, input.factorId);
      if (!doc) throw new MfaError('MFA_UNKNOWN', { factorId: input.factorId, operation: 'revoke' });
      if (doc.status === 'REVOKED' || doc.status === 'REPLACED') return undefined;
      await rows.put({ ...doc, status: 'REVOKED' as const, revokedAt: now, revision: doc.revision + 1 });
      return { secretId: doc.secretId, secretVersion: doc.secretVersion };
    });
    if (sealed) {
      // Revoke the sealed secret too, so a revoked factor cannot be re-opened.
      await this.secrets
        .revoke({
          tenantId: input.tenantId,
          principalId: input.principalId,
          actorPrincipalId: input.actorPrincipalId,
          purpose: 'totp',
          secretId: sealed.secretId,
          version: sealed.secretVersion,
          correlationId,
        })
        .catch(() => undefined);
    }
    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'FACTOR_REVOKED',
      operation: 'revoke',
      factorId: input.factorId,
      correlationId,
      at: now,
    });
  }

  /**
   * Replace a factor. Requires a SUCCESSFUL verification of the EXISTING factor
   * first — replacement is a step-up operation, so an attacker holding only a
   * password cannot swap the victim's factor.
   */
  async replace(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly actorPrincipalId: string;
    readonly existingFactorId: string;
    readonly existingCode: string;
    readonly correlationId?: string;
  }): Promise<EnrollResult> {
    const correlationId = this.#correlation(input);
    const stepped = await this.verify({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      factorId: input.existingFactorId,
      code: input.existingCode,
      level: 'step-up',
      correlationId,
    });
    await this.revoke({ ...input, factorId: input.existingFactorId, correlationId });
    await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
      const doc = await this.#factor(scope, input.tenantId, input.principalId, input.existingFactorId);
      if (doc) await rows.put({ ...doc, status: 'REPLACED' as const, revision: doc.revision + 1 });
    });
    const enrolled = await this.enroll({ ...input, correlationId });
    await this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
      const old = await this.#factor(scope, input.tenantId, input.principalId, input.existingFactorId);
      if (old) await rows.put({ ...old, replacedById: enrolled.factorId, revision: old.revision + 1 });
    });
    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'FACTOR_REPLACED',
      operation: 'replace',
      factorId: enrolled.factorId,
      assuranceId: stepped.assuranceId,
      correlationId,
      at: Date.now(),
    });
    return enrolled;
  }

  /**
   * Recovery: revoke the lost factor and enroll a replacement WITHOUT a code
   * from the old factor.
   *
   * SECURITY: this is the weakest path in any MFA system and the classic
   * account-takeover vector. It is deliberately NOT weaker than the mechanism
   * it replaces, by three enforced properties:
   *
   *   1. It requires an explicit, separately-supplied recovery authorization
   *      token that the CALLER must already hold. S5 does not invent the
   *      authorization — it refuses without it, and it does not decide whether
   *      the token is sufficient (that is the authority plane's policy).
   *   2. It is throttled on its own counter, independent of verify.
   *   3. It yields only a PENDING factor. Recovery alone grants NO assurance:
   *      the replacement must still be activated with a real code, and until
   *      then the principal has no MFA and therefore cannot satisfy any
   *      step-up requirement. Recovery cannot be used to bypass MFA.
   */
  async recover(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly actorPrincipalId: string;
    readonly factorId: string;
    readonly recoveryAuthorizationToken: string;
    readonly validateRecoveryToken: (token: string) => Promise<boolean>;
    readonly correlationId?: string;
  }): Promise<EnrollResult> {
    const correlationId = this.#correlation(input);
    const now = Date.now();
    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'RECOVERY_ATTEMPTED',
      operation: 'recover',
      factorId: input.factorId,
      correlationId,
      at: now,
    });

    const allowed = await this.#inTenant(input.tenantId, async (scope) => {
      await this.#checkThrottle(scope, input.tenantId, input.principalId, 'recover', now);
      return true;
    }).catch(() => false);
    if (!allowed) {
      await this.#refuse('MFA_THROTTLED', {
        tenantId: input.tenantId,
        principalId: input.principalId,
        actorPrincipalId: input.actorPrincipalId,
        kind: 'RECOVERY_FAILED',
        operation: 'recover',
        factorId: input.factorId,
        correlationId,
        at: Date.now(),
      });
    }

    let tokenValid = false;
    try {
      tokenValid = (await input.validateRecoveryToken(input.recoveryAuthorizationToken)) === true;
    } catch {
      tokenValid = false;
    }
    if (!tokenValid) {
      await this.#inTenant(input.tenantId, async (scope) => {
        await this.#noteFailure(scope, input.tenantId, input.principalId, 'recover', Date.now());
      }).catch(() => undefined);
      await this.#refuse('MFA_RECOVERY_NOT_ELIGIBLE', {
        tenantId: input.tenantId,
        principalId: input.principalId,
        actorPrincipalId: input.actorPrincipalId,
        kind: 'RECOVERY_FAILED',
        operation: 'recover',
        factorId: input.factorId,
        correlationId,
        at: Date.now(),
      });
    }

    const existed = await this.#inTenant(input.tenantId, async (scope) => {
      const doc = await this.#factor(scope, input.tenantId, input.principalId, input.factorId);
      if (!doc) return false;
      const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
      await rows.put({ ...doc, status: 'REVOKED' as const, revokedAt: Date.now(), revision: doc.revision + 1 });
      return true;
    });
    if (!existed) {
      await this.#refuse('MFA_UNKNOWN', {
        tenantId: input.tenantId,
        principalId: input.principalId,
        actorPrincipalId: input.actorPrincipalId,
        kind: 'RECOVERY_FAILED',
        operation: 'recover',
        factorId: input.factorId,
        correlationId,
        at: Date.now(),
      });
    }

    const enrolled = await this.enroll({ ...input, correlationId });
    await this.#inTenant(input.tenantId, async (scope) => {
      await this.#clearThrottle(scope, input.tenantId, input.principalId, 'recover');
    }).catch(() => undefined);
    await this.#audit({
      tenantId: input.tenantId,
      principalId: input.principalId,
      actorPrincipalId: input.actorPrincipalId,
      kind: 'RECOVERY_SUCCEEDED',
      operation: 'recover',
      factorId: enrolled.factorId,
      correlationId,
      at: Date.now(),
    });
    return enrolled;
  }

  // -------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------

  async listFactors(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly actorPrincipalId: string;
  }): Promise<readonly MfaFactorDoc[]> {
    if (!isNonBlank(input.tenantId) || !isNonBlank(input.principalId) || !isNonBlank(input.actorPrincipalId)) {
      throw new MfaError('MFA_INVALID_ARGUMENT');
    }
    return this.#inTenant(input.tenantId, async (scope) => {
      const rows = await scope.collection<MfaFactorDoc>(MFA_FACTOR_COLLECTION);
      const all = await rows.query({ where: (row) => row.principalId === input.principalId });
      // Defensive: RLS already scopes this, but the filter is cheap and makes
      // the tenant binding explicit in code as well as in the database.
      return all.filter((doc) => doc.tenantId === input.tenantId && doc.principalId === input.principalId);
    });
  }

  /** Is this principal MFA-capable right now? An availability signal, not a decision. */
  async hasActiveFactor(input: { readonly tenantId: string; readonly principalId: string; readonly actorPrincipalId: string }): Promise<boolean> {
    const factors = await this.listFactors(input);
    return factors.some((doc) => doc.status === 'ACTIVE');
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A tenant id is needed to even open the RLS scope, so an invalid one has to be
 * handled before any tenant-scoped work. StorageModule validates it properly;
 * this only avoids writing an undefined into an audit row.
 */
function safeTenant(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : 'unknown';
}
