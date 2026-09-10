// P2-S1 — durable identity core (spec §4, §21.1).
//
// Identity stores over the authoritative PostgreSQL substrate (R2 discipline):
//   * principals (lifecycle state machine §4.2),
//   * memberships (tenant status; 1:1 with the principal in S1),
//   * role-assignments (role lifecycle: durable grant/revoke),
//   * recovery (one-shot bound records),
//   * subject-bindings (one-shot (issuer, subject) → principal federation
//     binding — the server-side identity↔tenant mapping),
//   * identity.events (append-only security events, spec §13).
//
// Scope discipline (INV-15):
//   * tenant-scoped operations run in explicit tenant transactions;
//   * the ONLY pre-tenant operations are the subject-binding PK read, the
//     principal-uniqueness query (creation paths), the jti replay consume
//     (separate store), and the binding count (boot invariant) — each in an
//     explicit, counted, `transaction:system` transaction (the SAME declared
//     exception the S-9 fingerprint read uses). No ambient scope, no new
//     labels, no RLS bypass, no second security-authority store.

import { createHash, randomUUID } from 'node:crypto';
import type { CommercialActorRole } from '@jataqi/commercial-control-plane';
import { StorageModule, type SecurityCollectionSource, type StorageWriteScope } from '@jataqi/storage';
import { isCommercialActorRole } from './types.js';
import {
  AUTHENTICATION_EVENTS_COLLECTION,
  type AuthenticationEventDoc,
} from './authentication-event-store.js';
import {
  TOKEN_REGISTRY_COLLECTION,
  type TokenRegistryDoc,
} from './token-registry.js';
import { cascadeRevokeDelegationsInTx } from './delegation-store.js';
import {
  assertIdentityDocumentShape,
  IDENTITY_EVENTS_COLLECTION,
  IDENTITY_MEMBERSHIPS_COLLECTION,
  IDENTITY_PRINCIPALS_COLLECTION,
  IDENTITY_RECOVERY_COLLECTION,
  IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
  IDENTITY_SUBJECT_BINDINGS_COLLECTION,
  identityPairKey,
  IdentityLifecycleError,
  IdentityRebindRefusedError,
  IdentityStoreError,
  isIdentityState,
  isPermittedIdentityTransition,
  subjectBindingKey,
  type IdentityEventDoc,
  type IdentityEventKind,
  type IdentityMembershipDoc,
  type IdentityPrincipalDoc,
  type IdentityRecoveryDoc,
  type IdentityRoleAssignmentDoc,
  type IdentityState,
  type IdentityStateAuthority,
  type IdentityStateLookup,
  type IdentitySubjectBindingDoc,
} from './identity-types.js';

/** SHA-256 hex — the deterministic PK derivation (one-way, collision-safe). */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

const PRINCIPAL_FIELDS = new Set([
  'id', 'principalId', 'tenantId', 'state', 'version', 'lastTransition', 'createdAt', 'updatedAt',
]);
const MEMBERSHIP_FIELDS = new Set([
  'id', 'principalId', 'tenantId', 'status', 'since', 'revokedAt', 'revocationReason', 'updatedAt',
]);
const ROLE_ASSIGNMENT_FIELDS = new Set([
  'id', 'principalId', 'tenantId', 'role', 'status', 'grantedBy', 'grantedAt',
  'expiresAt', 'revokedAt', 'revocationReason', 'updatedAt',
]);
const RECOVERY_FIELDS = new Set([
  'id', 'principalId', 'tenantId', 'method', 'bindingRef', 'oneShot', 'expiresAt', 'status',
  'requestedBy', 'createdAt', 'consumedAt', 'revokedAt', 'revocationReason', 'updatedAt',
]);
const SUBJECT_BINDING_FIELDS = new Set([
  'id', 'issuer', 'subject', 'principalId', 'tenantId', 'boundBy', 'boundAt',
]);
const IDENTITY_EVENT_FIELDS = new Set([
  'id', 'at', 'tenantId', 'kind', 'principalId', 'resource', 'authority', 'decision', 'result',
  'detail', 'correlationId',
]);

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Roles an identity record may ever carry. `system` denotes a kernel-internal
 * actor minted only by the kernel (R1/D2); no identity workflow — enrollment,
 * auto-link, or admin grant — may assign it (same rule as
 * `FORBIDDEN_EXTERNAL_ROLES`).
 */
function assertIdentityRoles(roles: readonly CommercialActorRole[], context: string): void {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new IdentityStoreError('INVALID_ROLES', `${context}: roles must be a non-empty array (fail-closed).`);
  }
  for (const role of roles) {
    if (!isCommercialActorRole(role)) {
      throw new IdentityStoreError('INVALID_ROLES', `${context}: "${String(role)}" is not a recognized actor role (fail-closed).`);
    }
    if (role === 'system') {
      throw new IdentityStoreError(
        'FORBIDDEN_ROLE',
        `${context}: role "system" denotes a kernel-internal actor and can never be assigned through an identity workflow (fail-closed).`,
      );
    }
  }
}

export interface EnrollIdentityInput {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly CommercialActorRole[];
  /** The named acting admin (WHO field of the ADMIN_ACTION event). */
  readonly enrolledBy: string;
  /** Federation binding (OIDC issuer + subject) — optional at enrollment. */
  readonly issuer?: string;
  readonly subject?: string;
  /** Correlation id for the audit trail. */
  readonly correlationId?: string;
}

export interface DeprovisionResult {
  readonly sessionsRevoked: number;
  readonly tokensRevoked: number;
  readonly roleAssignmentsRevoked: number;
  /** REMEDIATION (§8.2.7): delegation grants revoked by the disablement cascade. */
  readonly delegationsRevoked: number;
}

export interface AutoLinkResult {
  /** True when the identity was created by this link (first link). */
  readonly created: boolean;
  /** True when an existing ENROLLED/SUSPENDED identity was activated. */
  readonly activated: boolean;
}

export interface RecoveryCreateInput {
  readonly principalId: string;
  readonly tenantId: string;
  /** The recovery method (semantics are S5; S1 stores and enforces the record). */
  readonly method: string;
  /** Opaque reference to the bound challenge — NEVER the challenge material. */
  readonly bindingRef: string;
  readonly expiresAt: number;
  readonly requestedBy: string;
}

/**
 * P2-S1 identity repository. All operations fail closed: a missing principal
 * throws, a forbidden transition throws, a rebind throws, and a non-
 * transactional source is refused at open.
 */
export class IdentityStore {
  private constructor(private readonly source: SecurityCollectionSource) {}

  static async open(source: SecurityCollectionSource): Promise<IdentityStore> {
    if (!source.supportsTransactions()) {
      throw new IdentityStoreError(
        'NON_TRANSACTIONAL_SOURCE',
        'IdentityStore requires a transactional storage driver (PostgreSQL); ' +
          'a non-transactional store is never authoritative identity state (fail-closed).',
      );
    }
    const store = new IdentityStore(source);
    const driver = source.getDriver();
    if (typeof driver.ensureIndex === 'function') {
      // The production RLS contract (p1.production.rls-posture) verifies
      // EVERY security collection table before boot completes, so the store
      // materializes ALL of its tables here — not lazily on first write. A
      // table that only appears on first use would leave a fresh production
      // boot unable to pass the posture probe (fail-closed by design).
      for (const collection of [
        IDENTITY_PRINCIPALS_COLLECTION,
        IDENTITY_MEMBERSHIPS_COLLECTION,
        IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
        IDENTITY_RECOVERY_COLLECTION,
      ]) {
        await driver.ensureIndex(collection, { name: 'by_principal', keys: ['principalId'], includeTenant: true });
      }
      await driver.ensureIndex(IDENTITY_EVENTS_COLLECTION, { name: 'by_kind', keys: ['kind'], includeTenant: true });
      await driver.ensureIndex(IDENTITY_SUBJECT_BINDINGS_COLLECTION, {
        name: 'by_subject',
        keys: ['issuer', 'subject'],
        includeTenant: true,
      });
    }
    return store;
  }

  // -- scope helpers ---------------------------------------------------------

  /** Explicit tenant transaction (RLS-bound; every handle is tenant-bound). */
  private async inTenant<T>(tenantId: string, fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    StorageModule.validateTenantId(tenantId);
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) {
        throw new IdentityStoreError('NON_ATOMIC', 'identity write requires an atomic transaction (fail-closed).');
      }
      return fn(scope);
    }, { tenantId });
  }

  /**
   * Explicit SYSTEM-scope transaction (the enumerated, counted
   * `transaction:system` exception — same class as the S-9 fingerprint read).
   * Used ONLY for: subject-binding PK reads, principal-uniqueness queries on
   * the creation paths, the binding count (boot invariant), and canary sweep.
   * Every use is counted by the driver audit for the INV-15 boot check.
   */
  private async inSystem<T>(fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) {
        throw new IdentityStoreError('NON_ATOMIC', 'identity system-scope operation requires an atomic transaction (fail-closed).');
      }
      return fn(scope);
    });
  }

  // -- events ----------------------------------------------------------------

  /**
   * Append one durable identity event (insert-once). Called inside existing
   * transactions by the store's own workflows (one commit with the state
   * change it records); the public form opens its own tenant transaction.
   */
  private async appendEventInTx(scope: StorageWriteScope, event: IdentityEventDoc): Promise<void> {
    assertIdentityDocumentShape(event as unknown as Record<string, unknown>, IDENTITY_EVENT_FIELDS, 'identityEvent');
    const events = await scope.collection<IdentityEventDoc>(IDENTITY_EVENTS_COLLECTION);
    const res = await events.cas(event.id, (cur) => cur === undefined, () => ({ ...event }));
    if (!res.ok) {
      throw new IdentityStoreError('EVENT_ALREADY_RECORDED', `identity event "${event.id}" is already recorded (fail-closed).`);
    }
  }

  /** Public append (own tenant transaction). */
  async appendEvent(event: IdentityEventDoc): Promise<void> {
    if (!isNonBlank(event.tenantId)) {
      throw new IdentityStoreError('INVALID_EVENT', 'identity event requires a tenantId (fail-closed).');
    }
    await this.inTenant(event.tenantId, (scope) => this.appendEventInTx(scope, event));
  }

  /** Tenant-scoped event query (audit diagnostics; bounded by the caller). */
  async queryEvents(tenantId: string, kind?: IdentityEventKind): Promise<readonly IdentityEventDoc[]> {
    return this.inTenant(tenantId, async (scope) => {
      const events = await scope.collection<IdentityEventDoc>(IDENTITY_EVENTS_COLLECTION);
      const rows = await events.query({ where: (row) => (kind === undefined || row.kind === kind) });
      return rows;
    });
  }

  private makeEvent(partial: Omit<IdentityEventDoc, 'id'>): IdentityEventDoc {
    return { ...partial, id: randomUUID() } as IdentityEventDoc;
  }

  // -- reads -----------------------------------------------------------------

  /** Tenant-scoped read of one identity record. */
  async getPrincipal(principalId: string, tenantId: string): Promise<IdentityPrincipalDoc | undefined> {
    if (!isNonBlank(principalId)) return undefined;
    const pk = identityPairKey(tenantId, principalId, sha256Hex);
    return this.inTenant(tenantId, async (scope) => {
      const principals = await scope.collection<IdentityPrincipalDoc>(IDENTITY_PRINCIPALS_COLLECTION);
      const row = await principals.get(pk);
      return row && row.tenantId === tenantId ? { ...row } : undefined;
    });
  }

  /**
   * Pre-tenant (system-scope, enumerated) federation-binding lookup by
   * (issuer, subject): the server-side identity↔tenant mapping. Returns the
   * binding or undefined (an unknown subject authenticates to NOTHING — there
   * is no default tenant).
   */
  async findBySubject(issuer: string, subject: string): Promise<IdentitySubjectBindingDoc | undefined> {
    if (!isNonBlank(issuer) || !isNonBlank(subject)) return undefined;
    const pk = subjectBindingKey(issuer, subject, sha256Hex);
    return this.inSystem(async (scope) => {
      const bindings = await scope.collection<IdentitySubjectBindingDoc>(IDENTITY_SUBJECT_BINDINGS_COLLECTION);
      const row = await bindings.get(pk);
      return row ? { ...row } : undefined;
    });
  }

  /** Tenant-scoped read of role assignments (all statuses). */
  async getRoleAssignments(principalId: string, tenantId: string): Promise<readonly IdentityRoleAssignmentDoc[]> {
    if (!isNonBlank(principalId)) return [];
    return this.inTenant(tenantId, async (scope) => {
      const roles = await scope.collection<IdentityRoleAssignmentDoc>(IDENTITY_ROLE_ASSIGNMENTS_COLLECTION);
      const rows = await roles.query({ where: (row) => row.principalId === principalId });
      return rows;
    });
  }

  /** Active (non-expired) role set for a principal in a tenant. */
  async getActiveRoles(principalId: string, tenantId: string, now: number): Promise<readonly CommercialActorRole[]> {
    const rows = await this.getRoleAssignments(principalId, tenantId);
    return rows
      .filter((row) => row.status === 'ACTIVE' && (row.expiresAt === undefined || row.expiresAt > now))
      .map((row) => row.role);
  }

  /** Count of federation bindings (P2-INV-09: the mapping must be non-empty under production OIDC). */
  async countSubjectBindings(): Promise<number> {
    return this.inSystem(async (scope) => {
      const bindings = await scope.collection<IdentitySubjectBindingDoc>(IDENTITY_SUBJECT_BINDINGS_COLLECTION);
      return bindings.count();
    });
  }

  // -- lifecycle ---------------------------------------------------------------

  /**
   * Enroll a new identity (privileged workflow, spec §4.2): principal
   * (ENROLLED) + membership (ACTIVE) + role-assignments (+ optional federation
   * binding), all in ONE transaction — no half-identities. One principalId has
   * exactly ONE identity across tenants (the cross-tenant uniqueness check
   * runs in the same system-scope transaction; a taken principal id is
   * refused, never silently rebound).
   */
  async enroll(input: EnrollIdentityInput, now: number): Promise<IdentityPrincipalDoc> {
    if (!isNonBlank(input.principalId)) {
      throw new IdentityStoreError('INVALID_ENROLL', 'enroll requires a non-empty principalId (fail-closed).');
    }
    StorageModule.validateTenantId(input.tenantId);
    assertIdentityRoles(input.roles, 'enroll');
    if (!isNonBlank(input.enrolledBy)) {
      throw new IdentityStoreError('INVALID_ENROLL', 'enroll requires a named enrolling actor (fail-closed).');
    }
    const principalId = input.principalId.trim();
    const tenantId = input.tenantId;
    const pk = identityPairKey(tenantId, principalId, sha256Hex);

    return this.inSystem(async (scope) => {
      const principals = await scope.collection<IdentityPrincipalDoc>(IDENTITY_PRINCIPALS_COLLECTION);
      const memberships = await scope.collection<IdentityMembershipDoc>(IDENTITY_MEMBERSHIPS_COLLECTION);
      const roles = await scope.collection<IdentityRoleAssignmentDoc>(IDENTITY_ROLE_ASSIGNMENTS_COLLECTION);
      const bindings = await scope.collection<IdentitySubjectBindingDoc>(IDENTITY_SUBJECT_BINDINGS_COLLECTION);

      // Same-tenant: the identity already exists — enrollment is one-shot.
      const existing = await principals.get(pk);
      if (existing) {
        throw new IdentityStoreError(
          'ALREADY_ENROLLED',
          `identity "${principalId}" in tenant "${tenantId}" is already enrolled (fail-closed).`,
        );
      }
      // Cross-tenant: one principalId has exactly one identity (no rebind).
      const others = await principals.query({ where: (row) => row.principalId === principalId });
      if (others.length > 0) {
        throw new IdentityRebindRefusedError(
          `principal "${principalId}" already has an identity in tenant "${others[0]!.tenantId}"; ` +
            'rebinding an existing principal to a different tenant is refused',
        );
      }

      const doc: IdentityPrincipalDoc = {
        id: pk,
        principalId,
        tenantId,
        state: 'ENROLLED',
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      assertIdentityDocumentShape(doc as unknown as Record<string, unknown>, PRINCIPAL_FIELDS, 'principal');
      const inserted = await principals.cas(pk, (cur) => cur === undefined, () => ({ ...doc }));
      if (!inserted.ok) {
        throw new IdentityStoreError('ALREADY_ENROLLED', `identity "${principalId}" already exists (concurrent enrollment) (fail-closed).`);
      }

      const membership: IdentityMembershipDoc = {
        id: pk,
        principalId,
        tenantId,
        status: 'ACTIVE',
        since: now,
        updatedAt: now,
      };
      assertIdentityDocumentShape(membership as unknown as Record<string, unknown>, MEMBERSHIP_FIELDS, 'membership');
      await memberships.cas(pk, (cur) => cur === undefined, () => ({ ...membership }));

      const seen = new Set<string>();
      for (const role of input.roles) {
        if (seen.has(role)) continue;
        seen.add(role);
        const assignment: IdentityRoleAssignmentDoc = {
          id: randomUUID(),
          principalId,
          tenantId,
          role,
          status: 'ACTIVE',
          grantedBy: `enroll:${input.enrolledBy.trim()}`,
          grantedAt: now,
          updatedAt: now,
        };
        assertIdentityDocumentShape(assignment as unknown as Record<string, unknown>, ROLE_ASSIGNMENT_FIELDS, 'roleAssignment');
        await roles.cas(assignment.id, (cur) => cur === undefined, () => ({ ...assignment }));
      }

      if (input.issuer !== undefined || input.subject !== undefined) {
        if (!isNonBlank(input.issuer) || !isNonBlank(input.subject)) {
          throw new IdentityStoreError(
            'INVALID_ENROLL',
            'enroll requires BOTH issuer and subject for a federation binding (fail-closed).',
          );
        }
        const bindingPk = subjectBindingKey(input.issuer, input.subject, sha256Hex);
        const binding: IdentitySubjectBindingDoc = {
          id: bindingPk,
          issuer: input.issuer,
          subject: input.subject,
          principalId,
          tenantId,
          boundBy: input.enrolledBy.trim(),
          boundAt: now,
        };
        assertIdentityDocumentShape(binding as unknown as Record<string, unknown>, SUBJECT_BINDING_FIELDS, 'subjectBinding');
        const bound = await bindings.cas(bindingPk, (cur) => cur === undefined, () => ({ ...binding }));
        if (!bound.ok) {
          const current = await bindings.get(bindingPk);
          if (current && current.principalId === principalId && current.tenantId === tenantId) {
            // Idempotent: the binding is already exactly this one.
          } else {
            throw new IdentityRebindRefusedError(
              `subject (${input.issuer}, ${input.subject}) is already bound to a different principal/account; rebind refused`,
            );
          }
        }
      }

      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'IDENTITY_ENROLLED',
        principalId,
        resource: IDENTITY_PRINCIPALS_COLLECTION,
        authority: { actor: input.enrolledBy.trim() },
        decision: 'ALLOW',
        result: 'ENROLLED',
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }));
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'MEMBERSHIP_CHANGED',
        principalId,
        resource: IDENTITY_MEMBERSHIPS_COLLECTION,
        authority: { actor: input.enrolledBy.trim() },
        result: 'ACTIVE',
        detail: 'enrollment',
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }));
      for (const role of seen) {
        await this.appendEventInTx(scope, this.makeEvent({
          at: now,
          tenantId,
          kind: 'ROLE_CHANGED',
          principalId,
          resource: IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
          authority: { actor: input.enrolledBy.trim() },
          result: 'ACTIVE',
          detail: `role=${role} (enrollment)`,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        }));
      }
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'ADMIN_ACTION',
        principalId,
        resource: IDENTITY_PRINCIPALS_COLLECTION,
        authority: { actor: input.enrolledBy.trim() },
        decision: 'ALLOW',
        result: 'enroll',
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }));

      return { ...(inserted.doc as IdentityPrincipalDoc) };
    });
  }

  /**
   * Activate (ENROLLED|SUSPENDED → ACTIVATED). Activation requires fresh
   * verification evidence (a durable authentication event id) — an
   * unverified identity is never active.
   */
  async activate(
    principalId: string,
    tenantId: string,
    evidence: { readonly authenticationEventId: string; readonly method: string },
    now: number,
  ): Promise<IdentityPrincipalDoc> {
    return this.transition(principalId, tenantId, 'ACTIVATED', {
      at: now,
      evidence: `${evidence.method}:${evidence.authenticationEventId}`,
    }, now, 'IDENTITY_ACTIVATED', 'ACTIVE', 'verification');
  }

  /** Suspend (ACTIVATED → SUSPENDED) — immediate, cross-process + the delegation cascade (§8.2.7). */
  async suspend(principalId: string, tenantId: string, reason: string, now: number): Promise<IdentityPrincipalDoc> {
    this.assertReason(reason, 'suspend');
    return this.transition(
      principalId,
      tenantId,
      'SUSPENDED',
      { at: now, reason: reason.trim() },
      now,
      'IDENTITY_SUSPENDED',
      'SUSPENDED',
      reason.trim(),
      { reason: `identity suspended: ${reason.trim()}` },
    );
  }

  /** Deactivate (SUSPENDED → DEACTIVATED) — terminal for use (§4.2 routes deactivation from SUSPENDED only). */
  async deactivate(principalId: string, tenantId: string, reason: string, now: number): Promise<IdentityPrincipalDoc> {
    this.assertReason(reason, 'deactivate');
    return this.transition(principalId, tenantId, 'DEACTIVATED', { at: now, reason: reason.trim() }, now, 'IDENTITY_DEACTIVATED', 'REVOKED', reason.trim());
  }

  private transition(
    principalId: string,
    tenantId: string,
    to: IdentityState,
    lastTransition: { readonly at: number; readonly evidence?: string; readonly reason?: string },
    now: number,
    eventKind: IdentityEventKind,
    membershipStatus: 'ACTIVE' | 'SUSPENDED' | 'REVOKED',
    membershipDetail: string,
    cascade?: { readonly reason: string },
  ): Promise<IdentityPrincipalDoc> {
    if (!isNonBlank(principalId)) {
      return Promise.reject(new IdentityStoreError('INVALID_TRANSITION', `${eventKind} requires a non-empty principalId (fail-closed).`));
    }
    const pk = identityPairKey(tenantId, principalId, sha256Hex);
    return this.inTenant(tenantId, async (scope) => {
      const principals = await scope.collection<IdentityPrincipalDoc>(IDENTITY_PRINCIPALS_COLLECTION);
      const memberships = await scope.collection<IdentityMembershipDoc>(IDENTITY_MEMBERSHIPS_COLLECTION);
      const res = await principals.cas(
        pk,
        (cur) => {
          if (!cur) {
            throw new IdentityStoreError('PRINCIPAL_NOT_FOUND', `identity "${principalId}" does not exist in tenant "${tenantId}" (fail-closed).`);
          }
          if (cur.tenantId !== tenantId) {
            throw new IdentityStoreError('TENANT_MISMATCH', `identity "${principalId}" belongs to another tenant (fail-closed).`);
          }
          return isPermittedIdentityTransition(cur.state, to);
        },
        (cur) => ({
          ...cur,
          state: to,
          version: cur.version + 1,
          lastTransition: { from: cur.state, to, ...lastTransition },
          updatedAt: now,
        }),
      );
      if (!res.ok) {
        const current = await principals.get(pk);
        if (!current) {
          throw new IdentityStoreError('PRINCIPAL_NOT_FOUND', `identity "${principalId}" does not exist (fail-closed).`);
        }
        throw new IdentityLifecycleError(current.state, to);
      }
      // Membership mirrors the principal state (1:1 in S1).
      const mres = await memberships.cas(
        pk,
        (cur) => !!cur && cur.status !== membershipStatus,
        (cur) => ({
          ...cur,
          status: membershipStatus,
          ...(membershipStatus === 'REVOKED' ? { revokedAt: now, revocationReason: membershipDetail } : {}),
          updatedAt: now,
        }),
      );
      if (!mres.ok) {
        const current = await memberships.get(pk);
        if (!current) {
          // The principal CAS succeeded, so a missing membership row is
          // structural corruption: fail the whole transaction (no partial
          // identity state is ever committed).
          throw new IdentityStoreError(
            'MEMBERSHIP_MISSING',
            `membership row for "${principalId}" is missing while the principal exists; refusing partial state (fail-closed)`,
          );
        }
        // Otherwise the membership already carries the target status — fine.
      }
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: eventKind,
        principalId,
        resource: IDENTITY_PRINCIPALS_COLLECTION,
        decision: 'ALLOW',
        result: to,
        detail: lastTransition.reason ?? lastTransition.evidence ?? undefined,
      }));
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'MEMBERSHIP_CHANGED',
        principalId,
        resource: IDENTITY_MEMBERSHIPS_COLLECTION,
        result: membershipStatus,
        detail: membershipDetail,
      }));
      if (cascade) {
        // §8.2.7 / S4.4: disablement cascade — the principal's ACTIVE
        // delegations (as delegator AND delegatee) are REVOKED in the SAME
        // tenant transaction as the state change (fail-closed, auditable).
        await cascadeRevokeDelegationsInTx(scope, { principalId, tenantId, reason: cascade.reason }, now);
      }
      return { ...(res.doc as IdentityPrincipalDoc) };
    });
  }

  private assertReason(reason: string, op: string): void {
    if (!isNonBlank(reason)) {
      throw new IdentityStoreError('MISSING_REASON', `${op} requires a non-blank reason (fail-closed).`);
    }
  }

  /**
   * Deprovision (DEACTIVATED → DEPROVISIONED) + the durable cascade (spec
   * §4.4): in ONE tenant transaction — membership REVOKED, every ACTIVE
   * role-assignment REVOKED, every ACTIVE session (S-8) REVOKED, every
   * ACTIVE static-token registration (S-9) REVOKED. A deprovisioned identity
   * cannot retain usable security authority through stale state: every
   * re-validation site (authentication, Phase-B decision, dispatch) re-reads
   * the now-terminal state. Future grants (P2-S3/S4) are gated by the same
   * identity-state re-read, so the cascade is future-proof by construction.
   */
  async deprovision(principalId: string, tenantId: string, reason: string, now: number): Promise<DeprovisionResult> {
    this.assertReason(reason, 'deprovision');
    const pk = identityPairKey(tenantId, principalId, sha256Hex);
    return this.inTenant(tenantId, async (scope) => {
      const principals = await scope.collection<IdentityPrincipalDoc>(IDENTITY_PRINCIPALS_COLLECTION);
      const memberships = await scope.collection<IdentityMembershipDoc>(IDENTITY_MEMBERSHIPS_COLLECTION);
      const roles = await scope.collection<IdentityRoleAssignmentDoc>(IDENTITY_ROLE_ASSIGNMENTS_COLLECTION);
      const sessions = await scope.collection<AuthenticationEventDoc>(AUTHENTICATION_EVENTS_COLLECTION);
      const tokens = await scope.collection<TokenRegistryDoc>(TOKEN_REGISTRY_COLLECTION);

      const res = await principals.cas(
        pk,
        (cur) => {
          if (!cur) {
            throw new IdentityStoreError('PRINCIPAL_NOT_FOUND', `identity "${principalId}" does not exist in tenant "${tenantId}" (fail-closed).`);
          }
          if (cur.tenantId !== tenantId) {
            throw new IdentityStoreError('TENANT_MISMATCH', `identity "${principalId}" belongs to another tenant (fail-closed).`);
          }
          return isPermittedIdentityTransition(cur.state, 'DEPROVISIONED');
        },
        (cur) => ({
          ...cur,
          state: 'DEPROVISIONED' as const,
          version: cur.version + 1,
          lastTransition: { from: cur.state, to: 'DEPROVISIONED' as const, at: now, reason: reason.trim() },
          updatedAt: now,
        }),
      );
      if (!res.ok) {
        const current = await principals.get(pk);
        if (!current) {
          throw new IdentityStoreError('PRINCIPAL_NOT_FOUND', `identity "${principalId}" does not exist (fail-closed).`);
        }
        throw new IdentityLifecycleError(current.state, 'DEPROVISIONED');
      }

      await memberships.cas(
        pk,
        (cur) => !!cur && cur.status !== 'REVOKED',
        (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: reason.trim(), updatedAt: now }),
      );

      let roleAssignmentsRevoked = 0;
      const activeRoles = await roles.query({
        where: (row) => row.principalId === principalId && row.tenantId === tenantId && row.status === 'ACTIVE',
      });
      for (const row of activeRoles) {
        const r = await roles.cas(
          row.id,
          (cur) => !!cur && cur.status === 'ACTIVE' && cur.principalId === principalId,
          (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: reason.trim(), updatedAt: now }),
        );
        if (r.ok) roleAssignmentsRevoked += 1;
      }

      let sessionsRevoked = 0;
      const activeSessions = await sessions.query({
        where: (row) => row.principalId === principalId && row.tenantId === tenantId && row.status === 'ACTIVE',
      });
      for (const row of activeSessions) {
        const r = await sessions.cas(
          row.id,
          (cur) => !!cur && cur.status === 'ACTIVE' && cur.principalId === principalId,
          (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: `identity deprovisioned: ${reason.trim()}`, updatedAt: now }),
        );
        if (r.ok) sessionsRevoked += 1;
      }

      let tokensRevoked = 0;
      const activeTokens = await tokens.query({
        where: (row) => row.principalId === principalId && row.tenantId === tenantId && row.status === 'ACTIVE',
      });
      for (const row of activeTokens) {
        const r = await tokens.cas(
          row.id,
          (cur) => !!cur && cur.status === 'ACTIVE' && cur.principalId === principalId,
          (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: `identity deprovisioned: ${reason.trim()}`, updatedAt: now }),
        );
        if (r.ok) tokensRevoked += 1;
      }

      // §8.2.7 / S4.4: delegation cascade — the principal's ACTIVE grants
      // (delegator + delegatee) are REVOKED in this same tenant transaction.
      const delegationsRevoked = await cascadeRevokeDelegationsInTx(
        scope,
        { principalId, tenantId, reason: `identity deprovisioned: ${reason.trim()}` },
        now,
      );

      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'IDENTITY_DEPROVISIONED',
        principalId,
        resource: IDENTITY_PRINCIPALS_COLLECTION,
        decision: 'ALLOW',
        result: 'DEPROVISIONED',
        detail: reason.trim(),
      }));
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'MEMBERSHIP_CHANGED',
        principalId,
        resource: IDENTITY_MEMBERSHIPS_COLLECTION,
        result: 'REVOKED',
        detail: reason.trim(),
      }));
      for (let i = 0; i < roleAssignmentsRevoked; i += 1) {
        await this.appendEventInTx(scope, this.makeEvent({
          at: now,
          tenantId,
          kind: 'ROLE_CHANGED',
          principalId,
          resource: IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
          result: 'REVOKED',
          detail: 'deprovisioning cascade',
        }));
      }
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'ADMIN_ACTION',
        principalId,
        resource: IDENTITY_PRINCIPALS_COLLECTION,
        decision: 'ALLOW',
        result: `deprovision (sessions=${sessionsRevoked}, tokens=${tokensRevoked}, roles=${roleAssignmentsRevoked}, delegations=${delegationsRevoked})`,
        detail: reason.trim(),
      }));

      return { sessionsRevoked, tokensRevoked, roleAssignmentsRevoked, delegationsRevoked };
    });
  }

  // -- recovery ----------------------------------------------------------------

  /**
   * Create a one-shot bound recovery record. Recovery NEVER targets a
   * terminal identity (DEACTIVATED/DEPROVISIONED): a terminal identity cannot
   * be re-enabled by any path (spec §4.2).
   */
  async createRecovery(input: RecoveryCreateInput, now: number): Promise<IdentityRecoveryDoc> {
    if (!isNonBlank(input.principalId) || !isNonBlank(input.method) || !isNonBlank(input.bindingRef) || !isNonBlank(input.requestedBy)) {
      throw new IdentityStoreError('INVALID_RECOVERY', 'createRecovery requires principalId, method, bindingRef, requestedBy (fail-closed).');
    }
    if (typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
      throw new IdentityStoreError('INVALID_RECOVERY', 'createRecovery requires an expiresAt strictly after now (fail-closed).');
    }
    const principal = await this.getPrincipal(input.principalId, input.tenantId);
    if (!principal) {
      throw new IdentityStoreError('PRINCIPAL_NOT_FOUND', `identity "${input.principalId}" does not exist (fail-closed).`);
    }
    if (principal.state === 'DEACTIVATED' || principal.state === 'DEPROVISIONED') {
      throw new IdentityStoreError(
        'RECOVERY_REFUSED_TERMINAL_STATE',
        `identity "${input.principalId}" is ${principal.state}; recovery never re-enables a terminal identity (fail-closed).`,
      );
    }
    const doc: IdentityRecoveryDoc = {
      id: randomUUID(),
      principalId: input.principalId,
      tenantId: input.tenantId,
      method: input.method,
      bindingRef: input.bindingRef,
      oneShot: true,
      expiresAt: input.expiresAt,
      status: 'PENDING',
      requestedBy: input.requestedBy,
      createdAt: now,
      updatedAt: now,
    };
    assertIdentityDocumentShape(doc as unknown as Record<string, unknown>, RECOVERY_FIELDS, 'recovery');
    return this.inTenant(input.tenantId, async (scope) => {
      const recovery = await scope.collection<IdentityRecoveryDoc>(IDENTITY_RECOVERY_COLLECTION);
      const res = await recovery.cas(doc.id, (cur) => cur === undefined, () => ({ ...doc }));
      if (!res.ok) {
        throw new IdentityStoreError('RECOVERY_EXISTS', `recovery record "${doc.id}" already exists (fail-closed).`);
      }
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId: input.tenantId,
        kind: 'ADMIN_ACTION',
        principalId: input.principalId,
        resource: IDENTITY_RECOVERY_COLLECTION,
        authority: { actor: input.requestedBy },
        decision: 'ALLOW',
        result: 'recovery-requested',
        detail: `method=${input.method}`,
      }));
      return { ...(res.doc as IdentityRecoveryDoc) };
    });
  }

  /**
   * Consume a recovery record — CAS one-shot, expiry deny-early (the shared
   * 300 s skew bound), and refused when the principal is terminal (no
   * re-enable). The reset action itself (S5 semantics) runs after this
   * returns; S1 enforces the bound, one-shot, expiring record.
   */
  async consumeRecovery(recoveryId: string, tenantId: string, now: number): Promise<IdentityRecoveryDoc> {
    return this.inTenant(tenantId, async (scope) => {
      const recovery = await scope.collection<IdentityRecoveryDoc>(IDENTITY_RECOVERY_COLLECTION);
      const row = await recovery.get(recoveryId);
      if (!row || row.tenantId !== tenantId) {
        throw new IdentityStoreError('RECOVERY_NOT_FOUND', `recovery record "${recoveryId}" does not exist in this tenant (fail-closed).`);
      }
      if (row.status === 'CONSUMED') {
        throw new IdentityStoreError('RECOVERY_CONSUMED', `recovery record "${recoveryId}" is already consumed; one-shot records are single-use (fail-closed).`);
      }
      if (row.status === 'REVOKED') {
        throw new IdentityStoreError('RECOVERY_REVOKED', `recovery record "${recoveryId}" was revoked (fail-closed).`);
      }
      const skewMs = 300_000; // shared deny-early bound (AUTH_SESSION_CLOCK_SKEW_MS)
      if (now + skewMs >= row.expiresAt) {
        await recovery.cas(
          row.id,
          (cur) => !!cur && cur.status === 'PENDING',
          (cur) => ({ ...cur, status: 'EXPIRED' as const, updatedAt: now }),
        );
        throw new IdentityStoreError('RECOVERY_EXPIRED', `recovery record "${recoveryId}" is expired (fail-closed).`);
      }
      const principal = await this.getPrincipalInTx(scope, row.principalId, tenantId);
      if (principal && (principal.state === 'DEACTIVATED' || principal.state === 'DEPROVISIONED')) {
        throw new IdentityStoreError(
          'RECOVERY_REFUSED_TERMINAL_STATE',
          `identity "${row.principalId}" is ${principal.state}; recovery never re-enables a terminal identity (fail-closed).`,
        );
      }
      const res = await recovery.cas(
        row.id,
        (cur) => !!cur && cur.status === 'PENDING',
        (cur) => ({ ...cur, status: 'CONSUMED' as const, consumedAt: now, updatedAt: now }),
      );
      if (!res.ok) {
        throw new IdentityStoreError('RECOVERY_CONSUMED', `recovery record "${recoveryId}" was consumed concurrently; one-shot records are single-use (fail-closed).`);
      }
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'IDENTITY_RECOVERED',
        principalId: row.principalId,
        resource: IDENTITY_RECOVERY_COLLECTION,
        decision: 'ALLOW',
        result: 'CONSUMED',
        detail: `method=${row.method}`,
      }));
      return { ...(res.doc as IdentityRecoveryDoc) };
    });
  }

  /** Revoke a pending recovery record (idempotent for terminal records). */
  async revokeRecovery(recoveryId: string, tenantId: string, reason: string, now: number): Promise<IdentityRecoveryDoc> {
    this.assertReason(reason, 'revokeRecovery');
    return this.inTenant(tenantId, async (scope) => {
      const recovery = await scope.collection<IdentityRecoveryDoc>(IDENTITY_RECOVERY_COLLECTION);
      const res = await recovery.cas(
        recoveryId,
        (cur) => !!cur && cur.status === 'PENDING',
        (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: reason.trim(), updatedAt: now }),
      );
      if (!res.ok) {
        const current = await recovery.get(recoveryId);
        if (!current || current.tenantId !== tenantId) {
          throw new IdentityStoreError('RECOVERY_NOT_FOUND', `recovery record "${recoveryId}" does not exist in this tenant (fail-closed).`);
        }
        return { ...current };
      }
      return { ...(res.doc as IdentityRecoveryDoc) };
    });
  }

  private async getPrincipalInTx(scope: StorageWriteScope, principalId: string, tenantId: string): Promise<IdentityPrincipalDoc | undefined> {
    const pk = identityPairKey(tenantId, principalId, sha256Hex);
    const principals = await scope.collection<IdentityPrincipalDoc>(IDENTITY_PRINCIPALS_COLLECTION);
    const row = await principals.get(pk);
    return row ? { ...row } : undefined;
  }

  // -- role lifecycle ---------------------------------------------------------

  /**
   * Grant one role to an existing identity (explicit admin operation;
   * durable, audited). Idempotent when an ACTIVE assignment already exists;
   * a previously REVOKED assignment is re-granted as a NEW record (history
   * is never rewritten). `system` is refused (kernel-internal only).
   */
  async grantRoleAssignment(
    principalId: string,
    tenantId: string,
    role: CommercialActorRole,
    grantedBy: string,
    now: number,
    expiresAt?: number,
  ): Promise<IdentityRoleAssignmentDoc> {
    assertIdentityRoles([role], 'grantRoleAssignment');
    if (!isNonBlank(grantedBy)) {
      throw new IdentityStoreError('INVALID_GRANT', 'grantRoleAssignment requires a named grantor (fail-closed).');
    }
    const existing = await this.getPrincipal(principalId, tenantId);
    if (!existing) {
      throw new IdentityStoreError('PRINCIPAL_NOT_FOUND', `identity "${principalId}" does not exist (fail-closed).`);
    }
    if (existing.state === 'DEACTIVATED' || existing.state === 'DEPROVISIONED') {
      throw new IdentityLifecycleError(
        existing.state,
        'ROLE_GRANT',
        'role grants to a terminal (' + existing.state + ') identity are refused — deprovisioning cascades to FUTURE grants (spec §4.4)',
      );
    }
    return this.inTenant(tenantId, async (scope) => {
      const roles = await scope.collection<IdentityRoleAssignmentDoc>(IDENTITY_ROLE_ASSIGNMENTS_COLLECTION);
      const rows = await roles.query({ where: (row) => row.principalId === principalId && row.role === role });
      const active = rows.find((row) => row.status === 'ACTIVE');
      if (active) return { ...active };
      const doc: IdentityRoleAssignmentDoc = {
        id: randomUUID(),
        principalId,
        tenantId,
        role,
        status: 'ACTIVE',
        grantedBy: grantedBy.trim(),
        grantedAt: now,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        updatedAt: now,
      };
      assertIdentityDocumentShape(doc as unknown as Record<string, unknown>, ROLE_ASSIGNMENT_FIELDS, 'roleAssignment');
      const res = await roles.cas(doc.id, (cur) => cur === undefined, () => ({ ...doc }));
      if (!res.ok) {
        throw new IdentityStoreError('GRANT_EXISTS', `role assignment already exists (fail-closed).`);
      }
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'ROLE_CHANGED',
        principalId,
        resource: IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
        authority: { actor: grantedBy.trim() },
        result: 'ACTIVE',
        detail: `role=${role}`,
      }));
      return { ...(res.doc as IdentityRoleAssignmentDoc) };
    });
  }

  /** Revoke one role assignment (explicit; durable, audited, idempotent). */
  async revokeRoleAssignment(assignmentId: string, tenantId: string, reason: string, now: number): Promise<IdentityRoleAssignmentDoc> {
    this.assertReason(reason, 'revokeRoleAssignment');
    return this.inTenant(tenantId, async (scope) => {
      const roles = await scope.collection<IdentityRoleAssignmentDoc>(IDENTITY_ROLE_ASSIGNMENTS_COLLECTION);
      const res = await roles.cas(
        assignmentId,
        (cur) => !!cur && cur.status === 'ACTIVE',
        (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: reason.trim(), updatedAt: now }),
      );
      if (!res.ok) {
        const current = await roles.get(assignmentId);
        if (!current || current.tenantId !== tenantId) {
          throw new IdentityStoreError('ASSIGNMENT_NOT_FOUND', `role assignment "${assignmentId}" does not exist in this tenant (fail-closed).`);
        }
        return { ...current };
      }
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'ROLE_CHANGED',
        principalId: res.doc!.principalId,
        resource: IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
        result: 'REVOKED',
        detail: `role=${res.doc!.role}: ${reason.trim()}`,
      }));
      return { ...(res.doc as IdentityRoleAssignmentDoc) };
    });
  }

  // -- auto-linking (spec §21.1) -------------------------------------------------

  /**
   * Deterministic, idempotent, tenant-safe, rebind-resistant auto-link of a
   * verified static-token principal into the identity core (spec §21.1):
   *   * first link  ⇒ create (ACTIVATED) + membership + role-assignments,
   *                   citing the token import as the enrolling authority;
   *   * repeat link ⇒ one stable relationship, no new records (idempotent);
   *   * ENROLLED/SUSPENDED identity + verified token ⇒ activation /
   *                   re-activation (the verification is the evidence);
   *   * DEACTIVATED/DEPROVISIONED identity ⇒ REFUSED (terminal identities
   *                   are never resurrected by a credential);
   *   * a principalId that already has an identity under ANOTHER tenant ⇒
   *                   REFUSED (no cross-tenant rebind — the uniqueness check
   *                   runs in the same system-scope transaction as the
   *                   creation, so it is race-free).
   */
  async autoLinkTokenPrincipal(
    principalId: string,
    tenantId: string,
    roles: readonly CommercialActorRole[],
    importedBy: string,
    now: number,
  ): Promise<AutoLinkResult> {
    if (!isNonBlank(principalId)) {
      throw new IdentityStoreError('INVALID_AUTOLINK', 'autoLink requires a non-empty principalId (fail-closed).');
    }
    StorageModule.validateTenantId(tenantId);
    assertIdentityRoles(roles, 'autoLink');
    if (!isNonBlank(importedBy)) {
      throw new IdentityStoreError('INVALID_AUTOLINK', 'autoLink requires the importing authority (fail-closed).');
    }
    const pk = identityPairKey(tenantId, principalId, sha256Hex);
    const authority = `auto-link:${importedBy.trim()}`;

    return this.inSystem(async (scope) => {
      const principals = await scope.collection<IdentityPrincipalDoc>(IDENTITY_PRINCIPALS_COLLECTION);
      const memberships = await scope.collection<IdentityMembershipDoc>(IDENTITY_MEMBERSHIPS_COLLECTION);
      const roleStore = await scope.collection<IdentityRoleAssignmentDoc>(IDENTITY_ROLE_ASSIGNMENTS_COLLECTION);

      const existing = await principals.get(pk);
      if (existing) {
        switch (existing.state) {
          case 'ACTIVATED':
            return { created: false, activated: false };
          case 'ENROLLED':
          case 'SUSPENDED': {
            const res = await principals.cas(
              pk,
              (cur) => !!cur && (cur.state === 'ENROLLED' || cur.state === 'SUSPENDED'),
              (cur) => ({
                ...cur,
                state: 'ACTIVATED' as const,
                version: cur.version + 1,
                lastTransition: { from: cur.state, to: 'ACTIVATED' as const, at: now, evidence: `auto-link:${importedBy.trim()}` },
                updatedAt: now,
              }),
            );
            if (!res.ok) {
              const current = await principals.get(pk);
              if (!current) throw new IdentityStoreError('PRINCIPAL_NOT_FOUND', `identity "${principalId}" does not exist (fail-closed).`);
              throw new IdentityLifecycleError(current.state, 'ACTIVATED');
            }
            await memberships.cas(
              pk,
              (cur) => !!cur && cur.status === 'SUSPENDED',
              (cur) => ({ ...cur, status: 'ACTIVE' as const, updatedAt: now }),
            );
            await this.appendEventInTx(scope, this.makeEvent({
              at: now,
              tenantId,
              kind: 'IDENTITY_ACTIVATED',
              principalId,
              resource: IDENTITY_PRINCIPALS_COLLECTION,
              decision: 'ALLOW',
              result: 'ACTIVATED',
              detail: `auto-link from ${importedBy.trim()}`,
            }));
            await this.appendEventInTx(scope, this.makeEvent({
              at: now,
              tenantId,
              kind: 'CREDENTIAL_CHANGED',
              principalId,
              resource: IDENTITY_PRINCIPALS_COLLECTION,
              decision: 'ALLOW',
              result: 'auto-linked',
              detail: `imported-by=${importedBy.trim()}`,
            }));
            return { created: false, activated: true };
          }
          case 'DEACTIVATED':
          case 'DEPROVISIONED':
            throw new IdentityRebindRefusedError(
              `identity "${principalId}" is ${existing.state}; a terminal identity is never resurrected by credential auto-linking (fail-closed)`,
            );
        }
      }

      // Creation path: the cross-tenant uniqueness check runs IN THIS
      // transaction (system scope) — one principalId has exactly one identity.
      const others = await principals.query({ where: (row) => row.principalId === principalId });
      if (others.length > 0) {
        throw new IdentityRebindRefusedError(
          `principal "${principalId}" already has an identity in tenant "${others[0]!.tenantId}"; cross-tenant auto-link rebind refused (fail-closed)`,
        );
      }

      const doc: IdentityPrincipalDoc = {
        id: pk,
        principalId,
        tenantId,
        state: 'ACTIVATED',
        version: 1,
        lastTransition: { from: 'ENROLLED' as const, to: 'ACTIVATED' as const, at: now, evidence: authority },
        createdAt: now,
        updatedAt: now,
      };
      assertIdentityDocumentShape(doc as unknown as Record<string, unknown>, PRINCIPAL_FIELDS, 'principal');
      const inserted = await principals.cas(pk, (cur) => cur === undefined, () => ({ ...doc }));
      if (!inserted.ok) {
        throw new IdentityStoreError('ALREADY_LINKED', `identity "${principalId}" already exists (concurrent link) (fail-closed).`);
      }

      const membership: IdentityMembershipDoc = {
        id: pk,
        principalId,
        tenantId,
        status: 'ACTIVE',
        since: now,
        updatedAt: now,
      };
      assertIdentityDocumentShape(membership as unknown as Record<string, unknown>, MEMBERSHIP_FIELDS, 'membership');
      await memberships.cas(pk, (cur) => cur === undefined, () => ({ ...membership }));

      const seen = new Set<string>();
      for (const role of roles) {
        if (seen.has(role)) continue;
        seen.add(role);
        const assignment: IdentityRoleAssignmentDoc = {
          id: randomUUID(),
          principalId,
          tenantId,
          role,
          status: 'ACTIVE',
          grantedBy: authority,
          grantedAt: now,
          updatedAt: now,
        };
        assertIdentityDocumentShape(assignment as unknown as Record<string, unknown>, ROLE_ASSIGNMENT_FIELDS, 'roleAssignment');
        await roleStore.cas(assignment.id, (cur) => cur === undefined, () => ({ ...assignment }));
      }

      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'IDENTITY_ENROLLED',
        principalId,
        resource: IDENTITY_PRINCIPALS_COLLECTION,
        authority: { actor: authority },
        decision: 'ALLOW',
        result: 'ENROLLED (auto-link)',
      }));
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'IDENTITY_ACTIVATED',
        principalId,
        resource: IDENTITY_PRINCIPALS_COLLECTION,
        authority: { actor: authority },
        decision: 'ALLOW',
        result: 'ACTIVATED (auto-link)',
      }));
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'MEMBERSHIP_CHANGED',
        principalId,
        resource: IDENTITY_MEMBERSHIPS_COLLECTION,
        result: 'ACTIVE',
        detail: 'auto-link',
      }));
      for (const role of seen) {
        await this.appendEventInTx(scope, this.makeEvent({
          at: now,
          tenantId,
          kind: 'ROLE_CHANGED',
          principalId,
          resource: IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
          authority: { actor: authority },
          result: 'ACTIVE',
          detail: `role=${role} (auto-link)`,
        }));
      }
      await this.appendEventInTx(scope, this.makeEvent({
        at: now,
        tenantId,
        kind: 'CREDENTIAL_CHANGED',
        principalId,
        resource: IDENTITY_PRINCIPALS_COLLECTION,
        authority: { actor: authority },
        decision: 'ALLOW',
        result: 'auto-linked',
        detail: `imported-by=${importedBy.trim()}`,
      }));

      return { created: true, activated: true };
    });
  }

  // -- decision-time authority (P2-S1 Phase-B re-read) ----------------------------

  /**
   * The identity-state authority the durable decider consults INSIDE its
   * tenant transaction (spec §24-S1). Reads through the passed scope (one
   * consistent snapshot — never a nested transaction). `undefined` = no
   * identity record exists (pre-P2 passthrough). A malformed row throws
   * (storage failure ⇒ the decider denies, fail-closed).
   */
  asStateAuthority(): IdentityStateAuthority {
    return {
      kind: 'p2-identity-state-authority',
      async lookupInTx(scope: StorageWriteScope, tenantId: string, principalId: string, now: number): Promise<IdentityStateLookup | undefined> {
        const pk = identityPairKey(tenantId, principalId, sha256Hex);
        const principals = await scope.collection<IdentityPrincipalDoc>(IDENTITY_PRINCIPALS_COLLECTION);
        const row = await principals.get(pk);
        if (!row) return undefined;
        if (
          typeof row.principalId !== 'string' || typeof row.tenantId !== 'string' ||
          !isIdentityState(row.state)
        ) {
          throw new IdentityStoreError('MALFORMED_IDENTITY_ROW', `identity row for "${principalId}" is malformed; failing closed`);
        }
        const roleStore = await scope.collection<IdentityRoleAssignmentDoc>(IDENTITY_ROLE_ASSIGNMENTS_COLLECTION);
        const rows = await roleStore.query({
          where: (r) => r.principalId === principalId && r.tenantId === row.tenantId && r.status === 'ACTIVE',
        });
        const activeRoles = rows
          .filter((r) => r.expiresAt === undefined || r.expiresAt > now)
          .map((r) => r.role)
          .filter((r): r is CommercialActorRole => isCommercialActorRole(r));
        return { state: row.state, activeRoles, tenantId: row.tenantId };
      },
    };
  }

  // -- boot canary (P2-INV-03) ----------------------------------------------------

  /**
   * The P2 identity boot canary (spec §14 P2-INV-03): mint + read + deny-path
   * against `identity.*` under the canary tenant `p2-canary`, then sweep.
   * The canary exercises the LIVE durable path; any availability failure
   * (throw) is a boot failure — the canary never "passes" by degrading.
   */
  async runBootCanary(now: number): Promise<{ ok: true; detail: string }> {
    const tenantId = 'p2-canary';
    const principalId = 'p2-identity-canary';
    const authority = this.asStateAuthority();

    // Sweep any leftover canary rows first (idempotent re-boot).
    await this.sweepCanary(tenantId, principalId);

    await this.enroll(
      { principalId, tenantId, roles: ['observer'], enrolledBy: 'p2-boot-canary' },
      now,
    );
    const enrolled = await this.getPrincipal(principalId, tenantId);
    if (!enrolled || enrolled.state !== 'ENROLLED') {
      throw new IdentityStoreError('CANARY_MINT_FAILED', 'boot canary: the minted identity was not readable back as ENROLLED (fail-closed)');
    }

    // Activate (the canary is a DURABLE-PATH health check, not a real
    // authentication: the evidence cites the canary itself) so the deny-path
    // below uses a spec-permitted transition (ACTIVATED → SUSPENDED).
    await this.activate(principalId, tenantId, { method: 'boot-canary', authenticationEventId: 'p2-canary' }, now);

    // Deny-path: suspend ⇒ the decision-time authority reports SUSPENDED
    // (a decision for this principal would DENY IDENTITY_STATE_INACTIVE).
    await this.suspend(principalId, tenantId, 'boot-canary', now);
    const suspendedLookup = await this.lookupViaOwnTx(authority, tenantId, principalId, now);
    if (suspendedLookup?.state !== 'SUSPENDED') {
      throw new IdentityStoreError('CANARY_DENY_PATH_FAILED', 'boot canary: the suspended identity did not render the deny-path state (fail-closed)');
    }

    await this.deactivate(principalId, tenantId, 'boot-canary', now);
    const result = await this.deprovision(principalId, tenantId, 'boot-canary', now);
    const terminal = await this.getPrincipal(principalId, tenantId);
    if (!terminal || terminal.state !== 'DEPROVISIONED') {
      throw new IdentityStoreError('CANARY_TERMINAL_FAILED', 'boot canary: the identity did not reach the terminal DEPROVISIONED state (fail-closed)');
    }

    // GC-clean the canary (documented exception, mirroring the P1 canary).
    await this.sweepCanary(tenantId, principalId);
    return { ok: true, detail: `mint=read=suspended-deny-path=deprovisioned(cascade sessions=${result.sessionsRevoked} tokens=${result.tokensRevoked} roles=${result.roleAssignmentsRevoked} delegations=${result.delegationsRevoked})=swept` };
  }

  private async lookupViaOwnTx(
    authority: IdentityStateAuthority,
    tenantId: string,
    principalId: string,
    now: number,
  ): Promise<IdentityStateLookup | undefined> {
    return this.inTenant(tenantId, (scope) => authority.lookupInTx(scope, tenantId, principalId, now));
  }

  /**
   * Remove the canary tenant's identity rows (boot-canary hygiene only — the
   * one documented deletion path besides jti TTL GC; canary rows never carry
   * real data).
   */
  private async sweepCanary(tenantId: string, principalId: string): Promise<void> {
    await this.inTenant(tenantId, async (scope) => {
      const pk = identityPairKey(tenantId, principalId, sha256Hex);
      for (const [collection, byId] of [
        [IDENTITY_PRINCIPALS_COLLECTION, true],
        [IDENTITY_MEMBERSHIPS_COLLECTION, true],
      ] as const) {
        const col = await scope.collection<IdentityPrincipalDoc>(collection);
        if (byId) {
          await col.delete(pk).catch(() => undefined);
        }
      }
      const roles = await scope.collection<IdentityRoleAssignmentDoc>(IDENTITY_ROLE_ASSIGNMENTS_COLLECTION);
      const roleRows = await roles.query({ where: (row) => row.principalId === principalId });
      for (const row of roleRows) {
        await roles.delete(row.id).catch(() => undefined);
      }
      const recovery = await scope.collection<IdentityRecoveryDoc>(IDENTITY_RECOVERY_COLLECTION);
      const recoveryRows = await recovery.query({ where: (row) => row.principalId === principalId });
      for (const row of recoveryRows) {
        await recovery.delete(row.id).catch(() => undefined);
      }
      const events = await scope.collection<IdentityEventDoc>(IDENTITY_EVENTS_COLLECTION);
      const eventRows = await events.query({ where: (row) => row.principalId === principalId });
      for (const row of eventRows) {
        await events.delete(row.id).catch(() => undefined);
      }
    });
  }
}
