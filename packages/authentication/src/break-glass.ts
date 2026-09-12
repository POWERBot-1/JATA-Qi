// P2-S6 — Break-Glass + Administrative Controls (spec §9.4 / §24-S6).
//
// Emergency authority is NEVER standing. Activation is an explicit named act,
// requires S5-verified step-up, is sealed through S7 purpose `break-glass-seal`,
// is narrow (≤ 3 operation classes), short-lived (default 15 min, max 60 min),
// reason-mandatory, durably audited, reviewed, auto-expired at every read, and
// CAS-revocable. Reactivation is a NEW record. Terminal rows are immutable.
//
// This module is NOT an authorization engine: it produces a durable emergency
// grant that the existing privilege plane can cite (`planeRole: 'break-glass'`).
// Standing `grantElevation` still refuses break-glass (privilege-store.ts).

import { randomBytes, randomUUID } from 'node:crypto';
import { StorageModule, type SecurityCollectionSource, type StorageWriteScope } from '@jataqi/storage';
import {
  assertIdentityDocumentShape,
  IDENTITY_EVENTS_COLLECTION,
  type IdentityEventDoc,
  type IdentityEventKind,
} from './identity-types.js';
import type { MfaFactorStore } from './mfa.js';
import {
  DEFAULT_STEP_UP_MAX_AGE_MS,
  isElevationExpired,
  PRIVILEGE_CLOCK_SKEW_MS,
  PRIVILEGE_PLATFORM_TENANT,
  type PrivilegeOperationClass,
  type PrivilegeScope,
} from './privilege-types.js';
import { isPrivilegeOperationClass } from './privilege-types.js';
import type { PrivilegeStore } from './privilege-store.js';
import type { SecretMaterialStore } from './secret-material.js';

export const BREAK_GLASS_COLLECTION = 'privileged.break-glass';

/** Spec §9.4: default 15 min, hard cap 60 min. No extension of an existing record. */
export const DEFAULT_BREAK_GLASS_LIFETIME_MS = 15 * 60_000;
export const MAX_BREAK_GLASS_LIFETIME_MS = 60 * 60_000;
/** Post-event review deadline (default 24 h). */
export const DEFAULT_BREAK_GLASS_REVIEW_DEADLINE_MS = 24 * 60 * 60_000;
export const MAX_BREAK_GLASS_OPERATION_CLASSES = 3;
export const BREAK_GLASS_CLOCK_SKEW_MS = PRIVILEGE_CLOCK_SKEW_MS;

export type BreakGlassStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export type BreakGlassFailureCode =
  | 'BG_INVALID_ARGUMENT'
  | 'BG_SEAM_UNAVAILABLE'
  | 'BG_STEP_UP_REQUIRED'
  | 'BG_STEP_UP_UNVERIFIED'
  | 'BG_REASON_REQUIRED'
  | 'BG_SCOPE_FROZEN'
  | 'BG_ONE_SHOT'
  | 'BG_UNKNOWN'
  | 'BG_TERMINAL'
  | 'BG_EXPIRED'
  | 'BG_REVOKED'
  | 'BG_NOT_ACTIVE'
  | 'BG_WINDOW_POLICY'
  | 'BG_REVIEW_OVERDUE';

export class BreakGlassError extends Error {
  readonly code: BreakGlassFailureCode;
  constructor(code: BreakGlassFailureCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'BreakGlassError';
    this.code = code;
  }
}

export interface BreakGlassDoc {
  readonly id: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly scope: PrivilegeScope;
  readonly operationClasses: readonly PrivilegeOperationClass[];
  readonly sessionEventId: string;
  readonly stepUpEventId: string;
  readonly stepUpAt: number;
  readonly reason: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly status: BreakGlassStatus;
  readonly reviewRequired: true;
  readonly reviewDeadline: number;
  readonly reviewedAt?: number;
  readonly reviewDecision?: string;
  readonly reviewedBy?: string;
  /** S7 SecretRef identifiers — field names avoid material-shaped tokens. */
  readonly sealRefId: string;
  readonly sealRefVersion: number;
  readonly elevationId?: string;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
  readonly correlationId: string;
  readonly updatedAt: number;
}

export interface ActivateBreakGlassInput {
  readonly principalId: string;
  readonly tenantId: string;
  readonly scope: PrivilegeScope;
  readonly operationClasses: readonly PrivilegeOperationClass[];
  readonly sessionEventId: string;
  readonly stepUpEventId: string;
  readonly stepUpAt: number;
  readonly reason: string;
  readonly actorPrincipalId: string;
  readonly lifetimeMs?: number;
  readonly reviewDeadlineMs?: number;
  readonly correlationId?: string;
}

export interface RevokeBreakGlassInput {
  readonly breakGlassId: string;
  readonly tenantId: string;
  readonly scope: PrivilegeScope;
  readonly revokedBy: string;
  readonly reason: string;
  readonly correlationId?: string;
}

export interface ReviewBreakGlassInput {
  readonly breakGlassId: string;
  readonly tenantId: string;
  readonly scope: PrivilegeScope;
  readonly reviewedBy: string;
  readonly decision: string;
  readonly correlationId?: string;
}

const DOC_FIELDS = new Set([
  'id',
  'principalId',
  'tenantId',
  'scope',
  'operationClasses',
  'sessionEventId',
  'stepUpEventId',
  'stepUpAt',
  'reason',
  'issuedAt',
  'expiresAt',
  'status',
  'reviewRequired',
  'reviewDeadline',
  'reviewedAt',
  'reviewDecision',
  'reviewedBy',
  'sealRefId',
  'sealRefVersion',
  'elevationId',
  'revokedAt',
  'revocationReason',
  'correlationId',
  'updatedAt',
]);

const EVENT_FIELDS = new Set([
  'id',
  'at',
  'tenantId',
  'kind',
  'principalId',
  'resource',
  'authority',
  'decision',
  'result',
  'detail',
  'correlationId',
]);

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** One-shot claim key: at most one ACTIVE break-glass per (principal, tenant, scope). */
export function breakGlassActiveClaimId(principalId: string, tenantId: string, scope: PrivilegeScope): string {
  return `bg-active:${scope}:${tenantId}:${principalId}`;
}

export function isBreakGlassExpired(expiresAt: number, now: number): boolean {
  return isElevationExpired(expiresAt, now);
}

export function isBreakGlassReviewOverdue(doc: BreakGlassDoc, now: number): boolean {
  if (doc.reviewedAt !== undefined) return false;
  return now + BREAK_GLASS_CLOCK_SKEW_MS >= doc.reviewDeadline;
}

export interface BreakGlassBus {
  emit(event: IdentityEventDoc): Promise<void>;
}

export class BreakGlassStore {
  private constructor(
    private readonly source: SecurityCollectionSource,
    private readonly secrets: SecretMaterialStore,
    private readonly stepUp: MfaFactorStore,
    private readonly privileges: PrivilegeStore,
    private readonly bus: BreakGlassBus | undefined,
  ) {}

  static async open(
    source: SecurityCollectionSource,
    secrets: SecretMaterialStore,
    stepUp: MfaFactorStore,
    privileges: PrivilegeStore,
    options: { readonly bus?: BreakGlassBus } = {},
  ): Promise<BreakGlassStore> {
    let transactional = false;
    try {
      transactional = source.supportsTransactions() === true;
    } catch {
      transactional = false;
    }
    if (!transactional) {
      throw new BreakGlassError('BG_SEAM_UNAVAILABLE', 'BreakGlassStore requires a transactional driver (fail-closed).');
    }
    if (!secrets || typeof secrets !== 'object') {
      throw new BreakGlassError('BG_SEAM_UNAVAILABLE', 'S7 secret-material seam is required (fail-closed).');
    }
    if (!stepUp || typeof stepUp.verifyStepUpEvidence !== 'function') {
      throw new BreakGlassError('BG_SEAM_UNAVAILABLE', 'S5 step-up verifier is required (fail-closed).');
    }
    if (!privileges || typeof privileges.grantBreakGlassElevation !== 'function') {
      throw new BreakGlassError('BG_SEAM_UNAVAILABLE', 'privilege plane break-glass grant path is required (fail-closed).');
    }
    const store = new BreakGlassStore(source, secrets, stepUp, privileges, options.bus);
    const driver = source.getDriver();
    if (typeof driver.ensureIndex === 'function') {
      await driver.ensureIndex(BREAK_GLASS_COLLECTION, { name: 'by_principal', keys: ['principalId'], includeTenant: true });
    }
    return store;
  }

  async #inTenant<T>(tenantId: string, fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    StorageModule.validateTenantId(tenantId);
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) throw new BreakGlassError('BG_SEAM_UNAVAILABLE', 'break-glass write requires an atomic transaction (fail-closed).');
      return fn(scope);
    }, { tenantId });
  }

  async #inSystem<T>(fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) throw new BreakGlassError('BG_SEAM_UNAVAILABLE', 'platform break-glass requires an atomic transaction (fail-closed).');
      return fn(scope);
    });
  }

  async #scopeOf<T>(scope: PrivilegeScope, tenantId: string, fn: (s: StorageWriteScope) => Promise<T>): Promise<T> {
    return scope === 'tenant' ? this.#inTenant(tenantId, fn) : this.#inSystem(fn);
  }

  async #appendEvent(scope: StorageWriteScope, event: IdentityEventDoc): Promise<void> {
    assertIdentityDocumentShape(event as unknown as Record<string, unknown>, EVENT_FIELDS, 'identityEvent');
    const events = await scope.collection<IdentityEventDoc>(IDENTITY_EVENTS_COLLECTION);
    const res = await events.cas(event.id, (cur) => cur === undefined, () => ({ ...event }));
    if (!res.ok) {
      throw new BreakGlassError('BG_ONE_SHOT', `identity event "${event.id}" already recorded (fail-closed).`);
    }
    if (this.bus) await this.bus.emit(event);
  }

  #event(
    kind: IdentityEventKind,
    doc: BreakGlassDoc,
    actor: string,
    result: string,
    detail: string,
  ): IdentityEventDoc {
    return {
      id: randomUUID(),
      at: doc.updatedAt,
      tenantId: doc.tenantId,
      kind,
      principalId: doc.principalId,
      resource: BREAK_GLASS_COLLECTION,
      authority: { actor, authenticationEventId: doc.sessionEventId },
      decision: 'ALLOW',
      result,
      detail,
      correlationId: doc.correlationId,
    };
  }

  #assertActivationInput(input: ActivateBreakGlassInput, now: number): void {
    if (!isNonBlank(input.principalId) || !isNonBlank(input.actorPrincipalId)) {
      throw new BreakGlassError('BG_INVALID_ARGUMENT', 'principalId and actorPrincipalId are required (fail-closed).');
    }
    if (input.actorPrincipalId !== input.principalId) {
      throw new BreakGlassError(
        'BG_INVALID_ARGUMENT',
        'break-glass activation is first-person: actor must equal the activating principal (fail-closed).',
      );
    }
    if (input.scope === 'tenant' && !isNonBlank(input.tenantId)) {
      throw new BreakGlassError('BG_INVALID_ARGUMENT', 'tenant-scoped activation requires tenantId (fail-closed).');
    }
    if (!isNonBlank(input.sessionEventId)) {
      throw new BreakGlassError('BG_INVALID_ARGUMENT', 'sessionEventId is required (fail-closed).');
    }
    if (!isNonBlank(input.reason) || input.reason.trim().length === 0) {
      throw new BreakGlassError('BG_REASON_REQUIRED', 'activation reason is mandatory and non-blank (A-12d; fail-closed).');
    }
    if (!Array.isArray(input.operationClasses) || input.operationClasses.length === 0) {
      throw new BreakGlassError('BG_INVALID_ARGUMENT', 'operationClasses must be a non-empty array (fail-closed).');
    }
    if (input.operationClasses.length > MAX_BREAK_GLASS_OPERATION_CLASSES) {
      throw new BreakGlassError('BG_INVALID_ARGUMENT', `at most ${MAX_BREAK_GLASS_OPERATION_CLASSES} operation classes (spec §9.4; fail-closed).`);
    }
    const unique = new Set<string>();
    for (const cls of input.operationClasses) {
      if (!isPrivilegeOperationClass(cls)) {
        throw new BreakGlassError('BG_INVALID_ARGUMENT', `unrecognized operation class (fail-closed).`);
      }
      unique.add(cls);
    }
    if (unique.size !== input.operationClasses.length) {
      throw new BreakGlassError('BG_INVALID_ARGUMENT', 'duplicate operation classes refused (fail-closed).');
    }
    const lifetime = input.lifetimeMs ?? DEFAULT_BREAK_GLASS_LIFETIME_MS;
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > MAX_BREAK_GLASS_LIFETIME_MS) {
      throw new BreakGlassError('BG_WINDOW_POLICY', `lifetime must be within (0, ${MAX_BREAK_GLASS_LIFETIME_MS}] ms (fail-closed).`);
    }
    const reviewMs = input.reviewDeadlineMs ?? DEFAULT_BREAK_GLASS_REVIEW_DEADLINE_MS;
    if (!Number.isFinite(reviewMs) || reviewMs <= 0) {
      throw new BreakGlassError('BG_INVALID_ARGUMENT', 'reviewDeadlineMs must be a positive finite number (fail-closed).');
    }
    if (!isNonBlank(input.stepUpEventId) || typeof input.stepUpAt !== 'number' || !Number.isFinite(input.stepUpAt)) {
      throw new BreakGlassError('BG_STEP_UP_REQUIRED', 'S5-verified step-up evidence is required (fail-closed).');
    }
    if (input.stepUpAt > now + BREAK_GLASS_CLOCK_SKEW_MS) {
      throw new BreakGlassError('BG_STEP_UP_UNVERIFIED', 'step-up timestamp is future-beyond-skew (fail-closed).');
    }
  }

  /**
   * Explicit activation. Verifies S5 step-up BEFORE any write. Seals a
   * one-shot credential through S7. CAS-claims the active slot so concurrent
   * activations produce exactly one winner (A-23).
   */
  async activate(input: ActivateBreakGlassInput, now: number = Date.now()): Promise<BreakGlassDoc> {
    this.#assertActivationInput(input, now);
    const tenantId = input.scope === 'tenant' ? input.tenantId : PRIVILEGE_PLATFORM_TENANT;
    const lifetime = input.lifetimeMs ?? DEFAULT_BREAK_GLASS_LIFETIME_MS;
    const reviewMs = input.reviewDeadlineMs ?? DEFAULT_BREAK_GLASS_REVIEW_DEADLINE_MS;
    const correlationId = input.correlationId?.trim() || `bgcorr_${randomUUID()}`;

    try {
      await this.stepUp.verifyStepUpEvidence({
        tenantId: input.scope === 'tenant' ? input.tenantId : input.tenantId,
        principalId: input.principalId,
        assuranceId: input.stepUpEventId,
        claimedAt: input.stepUpAt,
        maxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS,
        sessionId: input.sessionEventId,
        requiredLevel: 'step-up',
        now,
      });
    } catch (error) {
      if (error instanceof BreakGlassError) throw error;
      throw new BreakGlassError(
        'BG_STEP_UP_UNVERIFIED',
        `step-up evidence failed verification (${error instanceof Error ? error.name : 'unknown'}); activation refused (fail-closed).`,
      );
    }

    const id = randomUUID();
    const sealSecretId = `bgseal_${id}`;
    const material = randomBytes(32);
    let sealVersion = 1;
    try {
      const sealed = await this.secrets.seal({
        tenantId,
        principalId: input.principalId,
        actorPrincipalId: input.actorPrincipalId,
        purpose: 'break-glass-seal',
        secretId: sealSecretId,
        material,
        correlationId,
      });
      sealVersion = sealed.version;
    } catch {
      throw new BreakGlassError('BG_SEAM_UNAVAILABLE', 'S7 break-glass-seal failed; activation refused (fail-closed).');
    }

    const doc: BreakGlassDoc = {
      id,
      principalId: input.principalId,
      tenantId,
      scope: input.scope,
      operationClasses: [...input.operationClasses],
      sessionEventId: input.sessionEventId,
      stepUpEventId: input.stepUpEventId,
      stepUpAt: input.stepUpAt,
      reason: input.reason.trim(),
      issuedAt: now,
      expiresAt: now + lifetime,
      status: 'ACTIVE',
      reviewRequired: true,
      reviewDeadline: now + reviewMs,
      sealRefId: sealSecretId,
      sealRefVersion: sealVersion,
      correlationId,
      updatedAt: now,
    };
    assertIdentityDocumentShape(doc as unknown as Record<string, unknown>, DOC_FIELDS, 'breakGlass');

    const claimId = breakGlassActiveClaimId(input.principalId, tenantId, input.scope);
    const inserted = await this.#scopeOf(input.scope, tenantId, async (scope) => {
      const rows = await scope.collection<BreakGlassDoc>(BREAK_GLASS_COLLECTION);
      const claim = await rows.cas(
        claimId,
        (cur) => cur === undefined || cur.status !== 'ACTIVE' || isBreakGlassExpired(cur.expiresAt, now),
        () => ({ ...doc, id: claimId }),
      );
      if (!claim.ok) {
        throw new BreakGlassError(
          'BG_ONE_SHOT',
          'an ACTIVE break-glass already exists for this principal/scope (A-23 one-shot; fail-closed).',
        );
      }
      const put = await rows.cas(id, (cur) => cur === undefined, () => ({ ...doc }));
      if (!put.ok) {
        throw new BreakGlassError('BG_ONE_SHOT', 'break-glass id collision (fail-closed).');
      }
      await this.#appendEvent(
        scope,
        this.#event(
          'PRIVILEGE_BREAKGLASS_ACTIVATED',
          doc,
          input.actorPrincipalId,
          'activated',
          `classes=${doc.operationClasses.join(',')};scope=${doc.scope};expiresAt=${doc.expiresAt}`,
        ),
      );
      return doc;
    });

    const elevation = await this.privileges.grantBreakGlassElevation({
      breakGlassId: inserted.id,
      principalId: inserted.principalId,
      tenantId: inserted.tenantId,
      scope: inserted.scope,
      operationClasses: inserted.operationClasses,
      sessionEventId: inserted.sessionEventId,
      stepUpEventId: inserted.stepUpEventId,
      stepUpAt: inserted.stepUpAt,
      reason: inserted.reason,
      expiresAt: inserted.expiresAt,
      issuedAt: inserted.issuedAt,
      correlationId,
    });

    return this.#scopeOf(input.scope, tenantId, async (scope) => {
      const rows = await scope.collection<BreakGlassDoc>(BREAK_GLASS_COLLECTION);
      const withEl: BreakGlassDoc = { ...inserted, elevationId: elevation.id, updatedAt: Date.now() };
      await rows.put(withEl);
      const claim = await rows.get(claimId);
      if (claim && claim.id === claimId) {
        await rows.put({ ...withEl, id: claimId });
      }
      return withEl;
    });
  }

  async #load(scope: StorageWriteScope, id: string): Promise<BreakGlassDoc | undefined> {
    const rows = await scope.collection<BreakGlassDoc>(BREAK_GLASS_COLLECTION);
    const row = await rows.get(id);
    if (!row) return undefined;
    assertIdentityDocumentShape(row as unknown as Record<string, unknown>, DOC_FIELDS, 'breakGlass');
    return row;
  }

  /** Server-side validity: ACTIVE, unexpired, scope match. Terminal rows never resurrect. */
  async assertActive(
    breakGlassId: string,
    tenantId: string,
    scope: PrivilegeScope,
    now: number = Date.now(),
  ): Promise<BreakGlassDoc> {
    const storageTenant = scope === 'tenant' ? tenantId : PRIVILEGE_PLATFORM_TENANT;
    return this.#scopeOf(scope, storageTenant, async (tx) => {
      const row = await this.#load(tx, breakGlassId);
      if (!row) throw new BreakGlassError('BG_UNKNOWN', 'break-glass record not found (fail-closed).');
      if (row.scope !== scope || (scope === 'tenant' && row.tenantId !== tenantId)) {
        throw new BreakGlassError('BG_UNKNOWN', 'break-glass record not found (fail-closed).');
      }
      if (row.status === 'REVOKED') throw new BreakGlassError('BG_REVOKED', 'break-glass was revoked (fail-closed).');
      if (row.status === 'EXPIRED' || isBreakGlassExpired(row.expiresAt, now)) {
        throw new BreakGlassError('BG_EXPIRED', 'break-glass window has passed (deny-early; fail-closed).');
      }
      if (row.status !== 'ACTIVE') throw new BreakGlassError('BG_NOT_ACTIVE', 'break-glass is not ACTIVE (fail-closed).');
      return row;
    });
  }

  /**
   * Scope freeze (A-12c): any attempt to change operationClasses / tenant /
   * scope after activation is refused. There is no mutate API; this helper
   * exists so tests and callers cannot invent one.
   */
  expandScope(): never {
    throw new BreakGlassError('BG_SCOPE_FROZEN', 'break-glass scope is frozen at activation; expansion refused (A-12c; fail-closed).');
  }

  /**
   * Reactivation of a terminal record is refused. Callers must `activate()` a
   * NEW record with fresh S5 evidence (A-12b).
   */
  reactivate(_id: string): never {
    throw new BreakGlassError('BG_TERMINAL', 'terminal break-glass records are immutable; reactivation requires a new activation (A-12b; fail-closed).');
  }

  async revoke(input: RevokeBreakGlassInput, now: number = Date.now()): Promise<BreakGlassDoc> {
    if (!isNonBlank(input.breakGlassId) || !isNonBlank(input.revokedBy) || !isNonBlank(input.reason)) {
      throw new BreakGlassError('BG_INVALID_ARGUMENT', 'revocation requires id, revokedBy, and non-blank reason (fail-closed).');
    }
    const storageTenant = input.scope === 'tenant' ? input.tenantId : PRIVILEGE_PLATFORM_TENANT;
    const updated = await this.#scopeOf(input.scope, storageTenant, async (scope) => {
      const rows = await scope.collection<BreakGlassDoc>(BREAK_GLASS_COLLECTION);
      const res = await rows.cas(
        input.breakGlassId,
        (cur) => cur !== undefined && cur.status === 'ACTIVE',
        (cur) => ({
          ...cur,
          status: 'REVOKED' as const,
          revokedAt: now,
          revocationReason: input.reason.trim(),
          updatedAt: now,
        }),
      );
      if (res.ok) {
        const doc = res.doc as BreakGlassDoc;
        await this.#appendEvent(scope, this.#event('PRIVILEGE_BREAKGLASS_REVOKED', doc, input.revokedBy, 'revoked', `reason=${input.reason.trim()}`));
        const claimId = breakGlassActiveClaimId(doc.principalId, doc.tenantId, doc.scope);
        const claim = await rows.get(claimId);
        if (claim && claim.status === 'ACTIVE') {
          await rows.cas(claimId, (c) => c !== undefined && c.status === 'ACTIVE', (c) => ({ ...c, status: 'REVOKED' as const, revokedAt: now, updatedAt: now }));
        }
        return doc;
      }
      const current = await this.#load(scope, input.breakGlassId);
      if (current && (current.status === 'REVOKED' || current.status === 'EXPIRED')) {
        return current;
      }
      throw new BreakGlassError('BG_UNKNOWN', 'break-glass record not found (fail-closed).');
    });
    if (updated.elevationId) {
      await this.privileges.revokeBreakGlassElevation({
        elevationId: updated.elevationId,
        tenantId: updated.tenantId,
        scope: updated.scope,
        reason: input.reason.trim(),
        now,
      });
    }
    return updated;
  }

  async review(input: ReviewBreakGlassInput, now: number = Date.now()): Promise<BreakGlassDoc> {
    if (!isNonBlank(input.breakGlassId) || !isNonBlank(input.reviewedBy) || !isNonBlank(input.decision)) {
      throw new BreakGlassError('BG_INVALID_ARGUMENT', 'review requires id, reviewedBy, and non-blank decision (fail-closed).');
    }
    const storageTenant = input.scope === 'tenant' ? input.tenantId : PRIVILEGE_PLATFORM_TENANT;
    return this.#scopeOf(input.scope, storageTenant, async (scope) => {
      const rows = await scope.collection<BreakGlassDoc>(BREAK_GLASS_COLLECTION);
      const current = await this.#load(scope, input.breakGlassId);
      if (!current) throw new BreakGlassError('BG_UNKNOWN', 'break-glass record not found (fail-closed).');
      if (current.reviewedAt !== undefined) {
        throw new BreakGlassError('BG_TERMINAL', 'review records are append-once; already reviewed (fail-closed).');
      }
      const res = await rows.cas(
        input.breakGlassId,
        (cur) => cur !== undefined && cur.reviewedAt === undefined,
        (cur) => ({
          ...cur,
          reviewedAt: now,
          reviewDecision: input.decision.trim(),
          reviewedBy: input.reviewedBy,
          updatedAt: now,
        }),
      );
      if (!res.ok) throw new BreakGlassError('BG_TERMINAL', 'review lost a CAS race (fail-closed).');
      const doc = res.doc as BreakGlassDoc;
      await this.#appendEvent(scope, this.#event('PRIVILEGE_BREAKGLASS_REVIEWED', doc, input.reviewedBy, 'reviewed', `decision=${input.decision.trim()}`));
      return doc;
    });
  }

  /** P2-INV-06: no ACTIVE break-glass older than the hard cap; no standing flags. */
  async assertNoStandingOrOverlong(now: number = Date.now()): Promise<{ readonly ok: true; readonly active: number }> {
    return this.#inSystem(async (scope) => {
      const rows = await scope.collection<BreakGlassDoc>(BREAK_GLASS_COLLECTION);
      const all = await rows.query({ where: (row) => row.status === 'ACTIVE' && !String(row.id).startsWith('bg-active:') });
      let active = 0;
      for (const row of all) {
        assertIdentityDocumentShape(row as unknown as Record<string, unknown>, DOC_FIELDS, 'breakGlass');
        active += 1;
        if (row.expiresAt - row.issuedAt > MAX_BREAK_GLASS_LIFETIME_MS) {
          throw new BreakGlassError('BG_WINDOW_POLICY', `ACTIVE break-glass "${row.id}" exceeds the 60 min hard cap (P2-INV-06; fail-closed).`);
        }
        if (isBreakGlassExpired(row.expiresAt, now)) {
          throw new BreakGlassError('BG_WINDOW_POLICY', `ACTIVE break-glass "${row.id}" is past its window (P2-INV-06; fail-closed).`);
        }
        if (row.reviewRequired !== true) {
          throw new BreakGlassError('BG_WINDOW_POLICY', `ACTIVE break-glass "${row.id}" lacks reviewRequired (no standing-ability; P2-INV-06; fail-closed).`);
        }
      }
      return { ok: true, active };
    });
  }

  /** P2-INV-07: no overdue unreviewed break-glass. */
  async assertNoOverdueUnreviewed(now: number = Date.now()): Promise<{ readonly ok: true; readonly overdue: number }> {
    return this.#inSystem(async (scope) => {
      const rows = await scope.collection<BreakGlassDoc>(BREAK_GLASS_COLLECTION);
      const all = await rows.query({ where: (row) => !String(row.id).startsWith('bg-active:') });
      let overdue = 0;
      for (const row of all) {
        assertIdentityDocumentShape(row as unknown as Record<string, unknown>, DOC_FIELDS, 'breakGlass');
        if (isBreakGlassReviewOverdue(row, now)) {
          overdue += 1;
          await this.#appendEvent(
            scope,
            this.#event('PRIVILEGE_BREAKGLASS_REVIEW_DUE', { ...row, updatedAt: now }, 'system', 'review-due', 'reviewDeadline elapsed without a recorded review'),
          ).catch(() => undefined);
        }
      }
      if (overdue > 0) {
        throw new BreakGlassError('BG_REVIEW_OVERDUE', `${overdue} break-glass record(s) have an overdue unreviewed reviewDeadline (P2-INV-07; fail-closed).`);
      }
      return { ok: true, overdue: 0 };
    });
  }
}
