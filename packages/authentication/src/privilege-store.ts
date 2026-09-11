// P2-S3 — the durable Privileged Access Plane store + service (spec §9, §24-S3).
//
// The elevation store is the ONLY writer of `privileged.elevations`, and the
// authoritative source for "does this principal hold a valid elevation for
// this operation class?". It is built on the same transactional PostgreSQL
// substrate as S-8/S-9 and the S1 identity core:
//
//   * non-transactional drivers refused at open (fail-closed);
//   * tenant-scoped elevations in tenant transactions (RLS-bound);
//   * platform-scoped elevations under `PRIVILEGE_PLATFORM_TENANT` via
//     explicit, enumerated system-scope transactions (INV-15 pattern);
//   * CAS-guarded transitions (ACTIVE ⇒ REVOKED/EXPIRED); insert-once ids;
//   * a one-time, single-winner first-elevation bootstrap (kernel:bootstrap);
//   * closed schema + material-shaped-field refusal;
//   * every grant/revoke emits a durable `identity.events` record in the same
//     transaction (PRIVILEGE_ELEVATION / PRIVILEGE_REVOKED — an audit-write
//     failure fails the operation; no unaudited elevation exists).
//
// No elevation is ever derived from a role string, a caller claim, or a
// process-local cache: every check re-reads durable state.

import { createHash, randomUUID } from 'node:crypto';
import { StorageModule, type SecurityCollectionSource, type StorageWriteScope } from '@jataqi/storage';
import {
  assertElevationDocumentShape,
  DEFAULT_ELEVATION_LIFETIME_MS,
  DEFAULT_STEP_UP_MAX_AGE_MS,
  foldElevationAssessments,
  isElevationExpired,
  MAX_ELEVATION_LIFETIME_MS,
  PRIVILEGE_PLATFORM_TENANT,
  PRIVILEGED_ELEVATIONS_COLLECTION,
  PrivilegeRequiredError,
  PrivilegeStoreError,
  assessElevationRow,
  type GrantElevationInput,
  type PrivilegeElevationAssessment,
  type PrivilegeElevationDoc,
  type PrivilegeElevationStatus,
  type PrivilegeEnforcer,
  type PrivilegeOperationClass,
  type PrivilegeScope,
  type PrivilegeStateAuthority,
} from './privilege-types.js';
import { isPrivilegeOperationClass, isPrivilegeRole } from './privilege-types.js';
import { resolvePrivilegeRequirement } from './privileged-operations.js';
import { assertIdentityDocumentShape, IDENTITY_EVENTS_COLLECTION, type IdentityEventDoc } from './identity-types.js';

/** SHA-256 hex — the deterministic bootstrap marker derivation (one-way). */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

const ELEVATION_FIELDS = new Set([
  'id', 'principalId', 'tenantId', 'scope', 'planeRole', 'operationClasses', 'sessionEventId',
  'stepUpEventId', 'stepUpAt', 'grantedBy', 'reason', 'issuedAt', 'expiresAt', 'status',
  'revokedAt', 'revocationReason', 'updatedAt',
]);

const IDENTITY_EVENT_FIELDS = new Set([
  'id', 'at', 'tenantId', 'kind', 'principalId', 'resource', 'authority', 'decision', 'result',
  'detail', 'correlationId',
]);

/** Deterministic bootstrap-marker elevation id (single-winner per tenant + scope). */
export function bootstrapElevationId(tenantId: string, scope: PrivilegeScope = 'tenant'): string {
  return `bootstrap-${sha256Hex(`${scope}:${tenantId}`)}`;
}

/**
 * P2-S3 service-migration seam: resolve the privilege enforcer from a
 * composition kernel, or `undefined` when the privileged plane is not
 * attached (pre-P2-S3 migration coexistence — the service's own role check
 * remains the gate, spec §9.1). This is the ONLY lenient path: when the
 * plane IS attached, every elevation assertion below fails closed on any
 * storage problem. The structural `KernelApi` shape keeps this helper free
 * of a module-type dependency (no import cycle with `authentication-module`).
 */
export function resolvePrivilegeEnforcerFromKernel(kernel: {
  getModule(id: string): unknown;
}): PrivilegeEnforcer | undefined {
  try {
    const auth = kernel.getModule('authentication') as
      | { getPrivilegeStore?: () => PrivilegeStore }
      | undefined;
    const store = auth?.getPrivilegeStore?.();
    return store?.asEnforcer();
  } catch {
    return undefined; // the authentication module / privilege plane is not attached
  }
}

/** The one-time first-elevation bootstrap input (composition root). */
export interface BootstrapElevationInput {
  readonly principalId: string;
  readonly tenantId: string;
  /**
   * The bootstrap scope. `tenant` mints the initial tenant security-admin
   * elevation; `platform` mints the initial platform security-admin elevation
   * (the cutover runbook provisions BOTH — spec §21.4 "initial security-admin
   * elevations", plural). One-shot per (tenant, scope).
   */
  readonly scope?: PrivilegeScope;
  /** Mandatory, non-blank operator-supplied reason (audited). */
  readonly reason: string;
  readonly correlationId?: string;
}

/** Revocation input. */
export interface RevokeElevationInput {
  readonly elevationId: string;
  /** The tenant the elevation belongs to (tenant-scoped revocations). */
  readonly tenantId: string;
  readonly scope: PrivilegeScope;
  /** The acting security-admin (recorded in the audit). */
  readonly revokedBy: string;
  /** The acting security-admin's session (re-read in-tx for authorization). */
  readonly revokerSessionEventId: string;
  /** Mandatory, non-blank revocation reason. */
  readonly reason: string;
  readonly correlationId?: string;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertValidGrant(input: GrantElevationInput, now: number): void {
  if (!isNonBlank(input.principalId)) throw new PrivilegeStoreError('INVALID_INPUT', 'elevation principalId is required (fail-closed).');
  if (input.scope === 'tenant' && !isNonBlank(input.tenantId)) throw new PrivilegeStoreError('INVALID_INPUT', 'tenant-scoped elevation requires a tenantId (fail-closed).');
  if (!isPrivilegeRole(input.planeRole)) throw new PrivilegeStoreError('INVALID_INPUT', `"${String(input.planeRole)}" is not a recognized plane role (fail-closed).`);
  if (input.planeRole === 'break-glass') {
    throw new PrivilegeStoreError(
      'BREAK_GLASS_NOT_AUTHORIZED',
      'break-glass activations are S6 (spec §9.4): the standing grant path never mints a break-glass elevation (fail-closed).',
    );
  }
  if (!Array.isArray(input.operationClasses) || input.operationClasses.length === 0) {
    throw new PrivilegeStoreError('INVALID_INPUT', 'elevation operationClasses must be a non-empty array (fail-closed).');
  }
  for (const cls of input.operationClasses) {
    if (!isPrivilegeOperationClass(cls)) {
      throw new PrivilegeStoreError('INVALID_INPUT', `"${String(cls)}" is not a recognized operation class (fail-closed).`);
    }
    // The standing role must match its own class (spec §9.1: strict, no
    // transitivity — a tenant-admin elevation never covers platform-admin).
    if (cls !== input.planeRole) {
      throw new PrivilegeStoreError(
        'ROLE_CLASS_MISMATCH',
        `plane role "${input.planeRole}" cannot cover operation class "${cls}" (spec §9.1 no-transitivity; fail-closed).`,
      );
    }
  }
  if (!isNonBlank(input.sessionEventId)) throw new PrivilegeStoreError('INVALID_INPUT', 'elevation sessionEventId (session binding) is required (fail-closed).');
  if (!isNonBlank(input.reason)) throw new PrivilegeStoreError('INVALID_INPUT', 'elevation reason is mandatory and non-blank (fail-closed).');
  if (!isNonBlank(input.grantedBy)) throw new PrivilegeStoreError('INVALID_INPUT', 'elevation grantedBy (acting authority) is required (fail-closed).');
  if (!isNonBlank(input.grantorPrincipalId)) throw new PrivilegeStoreError('INVALID_INPUT', 'elevation grantorPrincipalId is required (fail-closed).');
  if (!isNonBlank(input.grantorSessionEventId)) throw new PrivilegeStoreError('INVALID_INPUT', 'elevation grantorSessionEventId is required (fail-closed).');
  const lifetime = input.lifetimeMs ?? DEFAULT_ELEVATION_LIFETIME_MS;
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > MAX_ELEVATION_LIFETIME_MS) {
    throw new PrivilegeStoreError('INVALID_LIFETIME', `elevation lifetime must be within (0, ${MAX_ELEVATION_LIFETIME_MS}] ms (fail-closed).`);
  }
  // Step-up: every covered class requiring step-up must carry fresh evidence.
  for (const cls of input.operationClasses) {
    if (cls === 'operator') continue; // operator-class: session auth suffices (§9.3)
    if (typeof input.stepUpAt !== 'number' || !Number.isFinite(input.stepUpAt)) {
      throw new PrivilegeStoreError('STEP_UP_REQUIRED', `operation class "${cls}" requires step-up evidence (stepUpAt + stepUpEventId) — fail-closed.`);
    }
    if (input.stepUpAt > now + 300_000) {
      throw new PrivilegeStoreError('STEP_UP_FUTURE', 'step-up evidence timestamp is future-beyond-skew (fail-closed).');
    }
    if (!isNonBlank(input.stepUpEventId)) {
      throw new PrivilegeStoreError('STEP_UP_REQUIRED', `operation class "${cls}" requires a stepUpEventId reference (fail-closed).`);
    }
  }
}

function buildElevation(input: GrantElevationInput, now: number, id: string): PrivilegeElevationDoc {
  const lifetime = input.lifetimeMs ?? DEFAULT_ELEVATION_LIFETIME_MS;
  const tenantId = input.scope === 'tenant' ? input.tenantId : PRIVILEGE_PLATFORM_TENANT;
  return {
    id,
    principalId: input.principalId,
    tenantId,
    scope: input.scope,
    planeRole: input.planeRole,
    operationClasses: [...input.operationClasses],
    sessionEventId: input.sessionEventId,
    ...(input.stepUpEventId !== undefined ? { stepUpEventId: input.stepUpEventId } : {}),
    ...(input.stepUpAt !== undefined ? { stepUpAt: input.stepUpAt } : {}),
    grantedBy: input.grantedBy.trim(),
    reason: input.reason.trim(),
    issuedAt: now,
    expiresAt: now + lifetime,
    status: 'ACTIVE',
    updatedAt: now,
  };
}

/**
 * P2-S3 elevation repository. All operations fail closed: a missing/expired/
 * revoked elevation is a denial (never an ambiguity), a forbidden grant is
 * refused, a non-transactional source is refused at open, and every mutation
 * is audited in the same transaction.
 */
/**
 * The assurance verifier this plane consults for step-up evidence.
 *
 * Defined STRUCTURALLY, not by importing the MFA module: the privilege plane
 * consumes an assurance signal, it does not implement or own one. S5's
 * `MfaFactorStore.verifyStepUpEvidence` satisfies this shape, and any future
 * assurance provider can too. This is deliberately NOT a second authorization
 * system — the decision below stays exactly where it was.
 */
export interface StepUpEvidenceVerifier {
  verifyStepUpEvidence(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly assuranceId: string;
    readonly claimedAt: number;
    readonly maxAgeMs: number;
    readonly sessionId?: string;
    readonly now: number;
  }): Promise<unknown>;
}

export interface PrivilegeStoreOptions {
  /**
   * When supplied, step-up evidence is VERIFIED against a durable assurance
   * record instead of being trusted because the caller supplied it.
   */
  readonly stepUpVerifier?: StepUpEvidenceVerifier;
  /**
   * When true, a step-up-requiring grant is REFUSED if no verifier is
   * configured. This is the fail-closed posture for production: a plane that
   * cannot verify step-up evidence must not accept it.
   *
   * Defaults to false so that existing callers are not silently broken; the
   * trade-off is stated rather than hidden — see the S5 report finding 1.
   */
  readonly strictStepUp?: boolean;
  /** Freshness budget applied to verified evidence. */
  readonly stepUpMaxAgeMs?: number;
}

export class PrivilegeStore {
  private constructor(
    private readonly source: SecurityCollectionSource,
    private readonly stepUpVerifier: StepUpEvidenceVerifier | undefined,
    private readonly strictStepUp: boolean,
    private readonly stepUpMaxAgeMs: number,
  ) {}

  static async open(source: SecurityCollectionSource, options: PrivilegeStoreOptions = {}): Promise<PrivilegeStore> {
    if (!source.supportsTransactions()) {
      throw new PrivilegeStoreError(
        'NON_TRANSACTIONAL_SOURCE',
        'PrivilegeStore requires a transactional storage driver (PostgreSQL); a non-transactional store is never authoritative privilege state (fail-closed).',
      );
    }
    if (options.stepUpVerifier !== undefined && typeof options.stepUpVerifier.verifyStepUpEvidence !== 'function') {
      throw new PrivilegeStoreError('INVALID_OPTIONS', 'stepUpVerifier must expose verifyStepUpEvidence (fail-closed).');
    }
    const maxAge = options.stepUpMaxAgeMs ?? DEFAULT_STEP_UP_MAX_AGE_MS;
    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      throw new PrivilegeStoreError('INVALID_OPTIONS', 'stepUpMaxAgeMs must be a positive finite number (fail-closed).');
    }
    const store = new PrivilegeStore(source, options.stepUpVerifier, options.strictStepUp === true, maxAge);
    const driver = source.getDriver();
    if (typeof driver.ensureIndex === 'function') {
      await driver.ensureIndex(PRIVILEGED_ELEVATIONS_COLLECTION, { name: 'by_principal', keys: ['principalId'], includeTenant: true });
    }
    return store;
  }

  // -- scope helpers ---------------------------------------------------------

  /**
   * P2-S5: step-up evidence must be VERIFIED, not merely ASSERTED.
   *
   * Before S5 this plane checked only that `stepUpAt` was present, finite and
   * not future-beyond-skew, and that `stepUpEventId` was non-blank. Nothing
   * resolved the id against a real assurance record, and the declared
   * `stepUpMaxAgeMs` was compared nowhere — so `stepUpEventId: 'anything'` with
   * `stepUpAt: now` satisfied the guard.
   *
   * This closes that. It runs BEFORE any transaction, so a failed verification
   * writes nothing. It changes no authorization decision: the grantor authority
   * assessment below is untouched.
   */
  async #verifyStepUpEvidence(input: GrantElevationInput, now: number): Promise<void> {
    // Only classes that actually require step-up are checked; 'operator' is
    // satisfied by session authentication (spec §9.3), exactly as before.
    const requiresStepUp = input.operationClasses.some((cls) => cls !== 'operator');
    if (!requiresStepUp) return;
    if (this.stepUpVerifier === undefined) {
      if (this.strictStepUp) {
        throw new PrivilegeStoreError(
          'STEP_UP_UNVERIFIED',
          'step-up evidence cannot be verified: no assurance verifier is configured and strict step-up is enabled (fail-closed).',
        );
      }
      // Unverified pass-through. This is the pre-S5 behaviour, preserved for
      // callers that have not been wired to an assurance provider.
      return;
    }
    // assertValidGrant has already proven these are present and finite.
    const assuranceId = input.stepUpEventId;
    const claimedAt = input.stepUpAt;
    if (typeof assuranceId !== 'string' || typeof claimedAt !== 'number') {
      throw new PrivilegeStoreError('STEP_UP_REQUIRED', 'step-up evidence is missing for a step-up-requiring class (fail-closed).');
    }
    try {
      // WHOSE assurance? The GRANTOR's, in the GRANTOR's session.
      //
      // `input.principalId` is the TARGET of the elevation — the principal
      // being granted power. Step-up is required to PERFORM the privileged act,
      // so the assurance must belong to the actor: the security-admin granting
      // it. Verifying against the target would let a caller authorize their own
      // action with somebody else's (or the victim's) assurance, which is
      // exactly the confusion S5 exists to prevent.
      await this.stepUpVerifier.verifyStepUpEvidence({
        tenantId: input.tenantId,
        principalId: input.grantorPrincipalId,
        assuranceId,
        claimedAt,
        maxAgeMs: this.stepUpMaxAgeMs,
        sessionId: input.grantorSessionEventId,
        now,
      });
    } catch (error) {
      // Fail closed, and never echo the verifier's detail: it may carry
      // identifiers from another tenant or principal.
      const reason = error instanceof Error ? error.name : 'UnknownError';
      throw new PrivilegeStoreError('STEP_UP_UNVERIFIED', `step-up evidence failed verification (${reason}); elevation refused (fail-closed).`);
    }
  }

  private async inTenant<T>(tenantId: string, fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    StorageModule.validateTenantId(tenantId);
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) throw new PrivilegeStoreError('NON_ATOMIC', 'elevation write requires an atomic transaction (fail-closed).');
      return fn(scope);
    }, { tenantId });
  }

  private async inSystem<T>(fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) throw new PrivilegeStoreError('NON_ATOMIC', 'platform elevation operation requires an atomic transaction (fail-closed).');
      return fn(scope);
    });
  }

  // -- events ----------------------------------------------------------------

  private async appendEventInTx(scope: StorageWriteScope, event: IdentityEventDoc): Promise<void> {
    assertIdentityDocumentShape(event as unknown as Record<string, unknown>, IDENTITY_EVENT_FIELDS, 'identityEvent');
    const events = await scope.collection<IdentityEventDoc>(IDENTITY_EVENTS_COLLECTION);
    const res = await events.cas(event.id, (cur) => cur === undefined, () => ({ ...event }));
    if (!res.ok) {
      throw new PrivilegeStoreError('EVENT_ALREADY_RECORDED', `identity event "${event.id}" is already recorded (fail-closed).`);
    }
  }

  private elevationEvent(
    kind: 'PRIVILEGE_ELEVATION' | 'PRIVILEGE_REVOKED',
    doc: PrivilegeElevationDoc,
    actor: string,
    sessionEventId: string,
    result: string,
    correlationId: string | undefined,
    detail: string,
  ): IdentityEventDoc {
    return {
      id: randomUUID(),
      at: doc.updatedAt,
      tenantId: doc.tenantId,
      kind,
      principalId: doc.principalId,
      resource: PRIVILEGED_ELEVATIONS_COLLECTION,
      authority: { actor, authenticationEventId: sessionEventId },
      decision: 'ALLOW',
      result,
      detail,
      ...(correlationId ? { correlationId } : {}),
    };
  }

  // -- authority / enforcer surfaces -----------------------------------------

  /** The privilege-state authority the durable A-01 decider consults. */
  asStateAuthority(): PrivilegeStateAuthority {
    return {
      kind: 'p2-privilege-state-authority',
      assessInTx: async (scope: StorageWriteScope, requirement, now: number): Promise<PrivilegeElevationAssessment> => {
        const elevations = await scope.collection<PrivilegeElevationDoc>(PRIVILEGED_ELEVATIONS_COLLECTION);
        const rows = await elevations.query({ where: (e) => e.principalId === requirement.principalId });
        for (const row of rows) {
          assertElevationDocumentShape(row as unknown as Record<string, unknown>, ELEVATION_FIELDS, 'elevation');
        }
        return foldElevationAssessments(rows, requirement, now);
      },
      assessPlatform: async (requirement, now: number): Promise<PrivilegeElevationAssessment> => {
        return this.inSystem(async (scope) => {
          const elevations = await scope.collection<PrivilegeElevationDoc>(PRIVILEGED_ELEVATIONS_COLLECTION);
          const rows = await elevations.query({ where: (e) => e.principalId === requirement.principalId });
          for (const row of rows) {
            assertElevationDocumentShape(row as unknown as Record<string, unknown>, ELEVATION_FIELDS, 'elevation');
          }
          return foldElevationAssessments(rows, { ...requirement, scope: 'platform' }, now);
        });
      },
    };
  }

  /** A service-facing enforcement seam for the PO-1…PO-8 migration. */
  asEnforcer(): PrivilegeEnforcer {
    return {
      kind: 'p2-privilege-enforcer',
      assertElevation: async (principalId: string, tenantId: string, operationId: string, now: number): Promise<void> => {
        await this.assertElevationForOperation(principalId, tenantId, operationId, now);
      },
    };
  }

  /** Assert a valid elevation for a register operation (fail-closed denial otherwise). */
  async assertElevationForOperation(
    principalId: string,
    tenantId: string,
    operationId: string,
    now: number,
    opts?: { readonly sessionEventId?: string },
  ): Promise<void> {
    const entry = resolvePrivilegeRequirement(operationId);
    if (!entry) {
      throw new PrivilegeStoreError('UNREGISTERED_OPERATION', `"${operationId}" is not a registered privileged operation (register integrity; fail-closed).`);
    }
    const requirement = {
      principalId,
      tenantId: entry.scope === 'tenant' ? tenantId : PRIVILEGE_PLATFORM_TENANT,
      ...(opts?.sessionEventId !== undefined ? { sessionEventId: opts.sessionEventId } : {}),
      operationClass: entry.opClass,
      scope: entry.scope,
      stepUpRequired: entry.stepUpRequired,
      stepUpMaxAgeMs: entry.stepUpMaxAgeMs,
    };
    const authority = this.asStateAuthority();
    const assessment = entry.scope === 'tenant'
      ? await this.inTenant(tenantId, (scope) => authority.assessInTx(scope, requirement, now))
      : await authority.assessPlatform(requirement, now);
    if (assessment.verdict !== 'VALID') {
      throw new PrivilegeRequiredError(
        assessment.verdict,
        assessment.detail ?? `no valid ${entry.opClass} elevation for "${principalId}"`,
      );
    }
  }

  // -- grant / bootstrap / revoke -------------------------------------------

  /** Grant an elevation (the grantor must durably hold a security-admin elevation). */
  async grantElevation(input: GrantElevationInput, now: number): Promise<PrivilegeElevationDoc> {
    assertValidGrant(input, now);
    await this.#verifyStepUpEvidence(input, now);
    const grantorRequirement = {
      principalId: input.grantorPrincipalId,
      tenantId: input.scope === 'tenant' ? input.tenantId : PRIVILEGE_PLATFORM_TENANT,
      sessionEventId: input.grantorSessionEventId,
      operationClass: 'security-admin' as PrivilegeOperationClass,
      scope: input.scope,
      stepUpRequired: true,
      stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS,
    };
    const authority = this.asStateAuthority();
    const id = randomUUID();
    if (input.scope === 'tenant') {
      return this.inTenant(input.tenantId, async (scope) => {
        const grantor = await authority.assessInTx(scope, grantorRequirement, now);
        if (grantor.verdict !== 'VALID') {
          throw new PrivilegeRequiredError(grantor.verdict, `grantor lacks a valid security-admin elevation (${grantor.verdict}); plane-role grant refused (fail-closed).`);
        }
        return this.insertElevationInTx(scope, input, now, id, input.grantorSessionEventId);
      });
    }
    return this.inSystem(async (scope) => {
      const grantor = await authority.assessInTx(scope, grantorRequirement, now);
      if (grantor.verdict !== 'VALID') {
        throw new PrivilegeRequiredError(grantor.verdict, `grantor lacks a valid platform security-admin elevation (${grantor.verdict}); plane-role grant refused (fail-closed).`);
      }
      return this.insertElevationInTx(scope, input, now, id, input.grantorSessionEventId);
    });
  }

  private async insertElevationInTx(
    scope: StorageWriteScope,
    input: GrantElevationInput,
    now: number,
    id: string,
    actorSessionEventId: string,
  ): Promise<PrivilegeElevationDoc> {
    const doc = buildElevation(input, now, id);
    assertElevationDocumentShape(doc as unknown as Record<string, unknown>, ELEVATION_FIELDS, 'elevation');
    const elevations = await scope.collection<PrivilegeElevationDoc>(PRIVILEGED_ELEVATIONS_COLLECTION);
    const res = await elevations.cas(id, (cur) => cur === undefined, () => ({ ...doc }));
    if (!res.ok) {
      throw new PrivilegeStoreError('ELEVATION_ID_CONFLICT', `elevation id "${id}" already exists (fail-closed).`);
    }
    const event = this.elevationEvent(
      'PRIVILEGE_ELEVATION',
      doc,
      input.grantedBy,
      actorSessionEventId,
      'granted',
      input.correlationId,
      `planeRole=${doc.planeRole};classes=${doc.operationClasses.join(',')};scope=${doc.scope};expiresAt=${doc.expiresAt}`,
    );
    await this.appendEventInTx(scope, event);
    return doc;
  }

  /**
   * First-elevation bootstrap (spec §21.4): the composition root mints ONE
   * initial `security-admin` elevation per (tenant, scope), granted by
   * `kernel:bootstrap`, with a mandatory reason and short lifetime. Single
   * winner: a concurrent second activation fails (CAS insert-once).
   */
  async bootstrapFirstElevation(input: BootstrapElevationInput, now: number): Promise<PrivilegeElevationDoc> {
    if (!isNonBlank(input.principalId)) throw new PrivilegeStoreError('INVALID_INPUT', 'bootstrap principalId is required (fail-closed).');
    if (!isNonBlank(input.tenantId)) throw new PrivilegeStoreError('INVALID_INPUT', 'bootstrap tenantId is required (fail-closed).');
    if (!isNonBlank(input.reason)) throw new PrivilegeStoreError('INVALID_INPUT', 'bootstrap reason is mandatory and non-blank (fail-closed).');
    const scope = input.scope ?? 'tenant';
    StorageModule.validateTenantId(input.tenantId);
    const doc: PrivilegeElevationDoc = {
      id: bootstrapElevationId(input.tenantId, scope),
      principalId: input.principalId,
      tenantId: scope === 'tenant' ? input.tenantId : PRIVILEGE_PLATFORM_TENANT,
      scope,
      planeRole: 'security-admin',
      operationClasses: ['security-admin'],
      sessionEventId: 'kernel:bootstrap',
      stepUpEventId: 'kernel:bootstrap',
      stepUpAt: now,
      grantedBy: 'kernel:bootstrap',
      reason: input.reason.trim(),
      issuedAt: now,
      expiresAt: now + DEFAULT_ELEVATION_LIFETIME_MS,
      status: 'ACTIVE',
      updatedAt: now,
    };
    assertElevationDocumentShape(doc as unknown as Record<string, unknown>, ELEVATION_FIELDS, 'elevation');
    const insert = async (txScope: StorageWriteScope): Promise<PrivilegeElevationDoc> => {
      const elevations = await txScope.collection<PrivilegeElevationDoc>(PRIVILEGED_ELEVATIONS_COLLECTION);
      const res = await elevations.cas(doc.id, (cur) => cur === undefined, () => ({ ...doc }));
      if (!res.ok) {
        throw new PrivilegeStoreError(
          'BOOTSTRAP_ALREADY_USED',
          `the first-elevation bootstrap (${scope}) for tenant "${input.tenantId}" was already consumed (single-winner; a second activation is refused — fail-closed).`,
        );
      }
      const event = this.elevationEvent(
        'PRIVILEGE_ELEVATION',
        doc,
        'kernel:bootstrap',
        'kernel:bootstrap',
        'bootstrap',
        input.correlationId,
        `planeRole=security-admin;scope=${scope};bootstrap (first elevation)`,
      );
      await this.appendEventInTx(txScope, event);
      return doc;
    };
    return scope === 'tenant' ? this.inTenant(input.tenantId, insert) : this.inSystem(insert);
  }

  /** Revoke an elevation (CAS-guarded, idempotent, reason-mandatory, audited). */
  async revokeElevation(input: RevokeElevationInput, now: number): Promise<{ readonly elevationId: string; readonly status: PrivilegeElevationStatus }> {
    if (!isNonBlank(input.elevationId)) throw new PrivilegeStoreError('INVALID_INPUT', 'revocation elevationId is required (fail-closed).');
    if (!isNonBlank(input.reason)) throw new PrivilegeStoreError('INVALID_INPUT', 'revocation reason is mandatory and non-blank (fail-closed).');
    if (!isNonBlank(input.revokedBy)) throw new PrivilegeStoreError('INVALID_INPUT', 'revokedBy (acting authority) is required (fail-closed).');
    if (!isNonBlank(input.revokerSessionEventId)) throw new PrivilegeStoreError('INVALID_INPUT', 'revokerSessionEventId is required (fail-closed).');
    const grantorRequirement = {
      principalId: input.revokedBy,
      tenantId: input.scope === 'tenant' ? input.tenantId : PRIVILEGE_PLATFORM_TENANT,
      sessionEventId: input.revokerSessionEventId,
      operationClass: 'security-admin' as PrivilegeOperationClass,
      scope: input.scope,
      stepUpRequired: true,
      stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS,
    };
    const authority = this.asStateAuthority();
    const doRevoke = async (scope: StorageWriteScope): Promise<{ readonly elevationId: string; readonly status: PrivilegeElevationStatus }> => {
      const revoker = await authority.assessInTx(scope, grantorRequirement, now);
      if (revoker.verdict !== 'VALID') {
        throw new PrivilegeRequiredError(revoker.verdict, `revoker lacks a valid security-admin elevation (${revoker.verdict}); revocation refused (fail-closed).`);
      }
      const elevations = await scope.collection<PrivilegeElevationDoc>(PRIVILEGED_ELEVATIONS_COLLECTION);
      const res = await elevations.cas(
        input.elevationId,
        (cur) => cur !== undefined && cur.status === 'ACTIVE',
        (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: input.reason.trim(), updatedAt: now }),
      );
      if (res.ok) {
        const doc = res.doc as PrivilegeElevationDoc;
        const event = this.elevationEvent(
          'PRIVILEGE_REVOKED',
          doc,
          input.revokedBy,
          input.revokerSessionEventId,
          'revoked',
          input.correlationId,
          `reason=${doc.revocationReason ?? ''}`,
        );
        await this.appendEventInTx(scope, event);
        return { elevationId: input.elevationId, status: 'REVOKED' };
      }
      // Idempotent: an already-terminal row is not an error.
      const current = await elevations.get(input.elevationId);
      if (current && (current.status === 'REVOKED' || current.status === 'EXPIRED')) {
        return { elevationId: input.elevationId, status: current.status };
      }
      throw new PrivilegeStoreError('ELEVATION_NOT_FOUND', `elevation "${input.elevationId}" was not found (fail-closed).`);
    };
    if (input.scope === 'tenant') {
      if (!isNonBlank(input.tenantId)) throw new PrivilegeStoreError('INVALID_INPUT', 'tenant-scoped revocation requires a tenantId (fail-closed).');
      return this.inTenant(input.tenantId, doRevoke);
    }
    return this.inSystem(doRevoke);
  }

  // -- enforcement re-check + boot invariants -------------------------------

  /** Tenant-scoped enforcement re-check by elevation id (Tx-1). */
  async recheckElevation(
    elevationId: string,
    tenantId: string,
    requirement: {
      readonly principalId: string;
      readonly sessionEventId?: string;
      readonly operationClass: PrivilegeOperationClass;
      readonly scope: PrivilegeScope;
      readonly stepUpRequired: boolean;
      readonly stepUpMaxAgeMs: number;
    },
    now: number,
  ): Promise<PrivilegeElevationAssessment> {
    return this.inTenant(tenantId, async (scope) => {
      const elevations = await scope.collection<PrivilegeElevationDoc>(PRIVILEGED_ELEVATIONS_COLLECTION);
      const row = await elevations.get(elevationId);
      if (!row) {
        return { verdict: 'REQUIRED', elevationId, operationClass: requirement.operationClass, detail: 'elevation row vanished (fail-closed)' };
      }
      assertElevationDocumentShape(row as unknown as Record<string, unknown>, ELEVATION_FIELDS, 'elevation');
      if (row.tenantId !== tenantId) {
        return { verdict: 'SCOPE_MISMATCH', elevationId, operationClass: requirement.operationClass, detail: 'elevation tenant does not match the request tenant' };
      }
      return assessElevationRow(row, requirement, now);
    });
  }

  /** Platform-scoped enforcement re-check (system scope). */
  async recheckPlatformElevation(
    elevationId: string,
    requirement: {
      readonly principalId: string;
      readonly sessionEventId?: string;
      readonly operationClass: PrivilegeOperationClass;
      readonly stepUpRequired: boolean;
      readonly stepUpMaxAgeMs: number;
    },
    now: number,
  ): Promise<PrivilegeElevationAssessment> {
    return this.inSystem(async (scope) => {
      const elevations = await scope.collection<PrivilegeElevationDoc>(PRIVILEGED_ELEVATIONS_COLLECTION);
      const row = await elevations.get(elevationId);
      if (!row) {
        return { verdict: 'REQUIRED', elevationId, operationClass: requirement.operationClass, detail: 'platform elevation row vanished (fail-closed)' };
      }
      assertElevationDocumentShape(row as unknown as Record<string, unknown>, ELEVATION_FIELDS, 'elevation');
      return assessElevationRow(row, { ...requirement, scope: 'platform' }, now);
    });
  }

  /**
   * P2-INV-05 support: every ACTIVE elevation must respect the bounded-window
   * policy (max lifetime + non-past expiry) at read. A violation is a boot
   * failure (structural policy break, never silently tolerated).
   */
  async assertActiveElevationsWithinBounds(now: number): Promise<{ readonly ok: true; readonly active: number }> {
    return this.inSystem(async (scope) => {
      const elevations = await scope.collection<PrivilegeElevationDoc>(PRIVILEGED_ELEVATIONS_COLLECTION);
      const rows = await elevations.query({ where: (e) => e.status === 'ACTIVE' });
      let active = 0;
      for (const row of rows) {
        assertElevationDocumentShape(row as unknown as Record<string, unknown>, ELEVATION_FIELDS, 'elevation');
        active += 1;
        if (row.expiresAt - row.issuedAt > MAX_ELEVATION_LIFETIME_MS) {
          throw new PrivilegeStoreError('WINDOW_POLICY_VIOLATION', `ACTIVE elevation "${row.id}" exceeds the bounded-window policy (fail-closed).`);
        }
        if (isElevationExpired(row.expiresAt, now)) {
          throw new PrivilegeStoreError('WINDOW_POLICY_VIOLATION', `ACTIVE elevation "${row.id}" is past its window and was never marked EXPIRED (fail-closed).`);
        }
      }
      return { ok: true, active };
    });
  }

  /**
   * Boot canary (P2-INV-05 positive path): mint a canary elevation, assert it
   * reads VALID, revoke it, assert the revocation renders REVOKED, then sweep.
   * Availability failure is a boot failure (never degrades to pass).
   */
  async runBootCanary(now: number): Promise<{ ok: true; detail: string }> {
    const tenantId = 'p2-canary';
    const adminPrincipal = 'p2-canary-admin';
    const targetPrincipal = 'p2-canary-operator';
    // Seed a canary security-admin through the bootstrap path (one-shot).
    await this.bootstrapFirstElevation({ principalId: adminPrincipal, tenantId, reason: 'p2-s3 boot canary', correlationId: 'p2-s3-boot-canary' }, now);
    // Grant a canary operator elevation under the canary admin.
    const grant = await this.grantElevation(
      {
        principalId: targetPrincipal,
        tenantId,
        scope: 'tenant',
        planeRole: 'operator',
        operationClasses: ['operator'],
        sessionEventId: 'p2-canary-session',
        grantedBy: adminPrincipal,
        grantorPrincipalId: adminPrincipal,
        grantorSessionEventId: 'kernel:bootstrap',
        reason: 'p2-s3 boot canary operator elevation',
        correlationId: 'p2-s3-boot-canary',
      },
      now,
    );
    // Positive: the canary operator's elevation reads VALID.
    await this.assertElevationForOperation(targetPrincipal, tenantId, 'billing.subscription.create', now);
    // Negative: a principal without elevation is a denial (never a pass).
    let denied = false;
    try {
      await this.assertElevationForOperation('p2-canary-nobody', tenantId, 'billing.subscription.create', now);
    } catch (error) {
      if (error instanceof PrivilegeRequiredError) denied = true;
      else throw error;
    }
    if (!denied) throw new PrivilegeStoreError('CANARY_DENY_PATH_FAILED', 'boot canary: an unelevated principal was not denied (fail-closed).');
    // Revoke + assert REVOKED.
    await this.revokeElevation(
      { elevationId: grant.id, tenantId, scope: 'tenant', revokedBy: adminPrincipal, revokerSessionEventId: 'kernel:bootstrap', reason: 'p2-s3 boot canary sweep', correlationId: 'p2-s3-boot-canary' },
      now,
    );
    let revoked = false;
    try {
      await this.assertElevationForOperation(targetPrincipal, tenantId, 'billing.subscription.create', now);
    } catch (error) {
      if (error instanceof PrivilegeRequiredError && error.verdict === 'REVOKED') revoked = true;
      else throw error;
    }
    if (!revoked) throw new PrivilegeStoreError('CANARY_REVOKE_PATH_FAILED', 'boot canary: the revoked elevation still reads valid (fail-closed).');
    await this.sweepCanary(tenantId, now);
    return { ok: true, detail: 'grant=valid;deny-path=denied;revoke=revoked;swept' };
  }

  /** Remove the canary tenant's elevation + event rows (boot-canary hygiene only). */
  private async sweepCanary(tenantId: string, now: number): Promise<void> {
    await this.inTenant(tenantId, async (scope) => {
      const elevations = await scope.collection<PrivilegeElevationDoc>(PRIVILEGED_ELEVATIONS_COLLECTION);
      const rows = await elevations.query({ where: () => true });
      for (const row of rows) {
        await elevations.delete(row.id);
      }
      const events = await scope.collection<IdentityEventDoc>(IDENTITY_EVENTS_COLLECTION);
      const eventRows = await events.query({ where: () => true });
      for (const row of eventRows) {
        await events.delete(row.id);
      }
    });
    void now;
  }
}
