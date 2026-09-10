// P2-S4 — the durable Delegation + Policy store (spec §8, §13, §24-S4).
//
// The delegation store is the ONLY writer of `identity.delegations` and the
// authoritative source for "does this delegatee hold a valid, scoped grant
// for this operation?". It is built on the same transactional PostgreSQL
// substrate as S-8/S-9, S1, and S3:
//
//   * non-transactional drivers refused at open (delegation is never
//     process-local or in-memory authority);
//   * tenant-scoped grants in tenant transactions (RLS-bound);
//   * platform-scoped grants under `DELEGATION_PLATFORM_TENANT` via explicit,
//     enumerated, counted system-scope transactions (INV-15 pattern);
//   * CAS-guarded transitions (ACTIVE ⇒ CONSUMED/REVOKED; counted decrement);
//   * insert-once ids; closed schema + material-shaped-field refusal;
//   * every grant/revoke/use emits a durable `identity.events` record in the
//     same transaction (DELEGATION_GRANTED / DELEGATION_REVOKED /
//     DELEGATION_USED / DELEGATION_DENIED — an audit-write failure fails the
//     operation; no unaudited delegation exists).
//
// Grant-time authorization (defense-in-depth): the caller resolves the
// delegator's LIVE manifest scope and passes it as `delegatorEvidence`; the
// store asserts the requested grant is a SUBSET (never wider). The
// authoritative check is the decision-time chain re-verification against the
// live manifest (A-16) in the authorization boundary.

import { randomUUID } from 'node:crypto';
import { StorageModule, type SecurityCollectionSource, type StorageWriteScope } from '@jataqi/storage';
import {
  assertDelegationDocumentShape,
  DELEGATIONS_COLLECTION,
  DELEGATION_PLATFORM_TENANT,
  isDelegationChainDepthAllowed,
  isDelegationExpired,
  MAX_DELEGATION_LIFETIME_MS,
  DelegationStoreError,
  assessDelegationRow,
  delegationTargetScopeWithin,
  type DelegationAssessment,
  type DelegationApprovalBinding,
  type DelegationDoc,
  type DelegationPeek,
  type DelegationRequirement,
  type DelegationStateAuthority,
  type DelegationStatus,
  type GrantDelegationInput,
  type RevokeDelegationInput,
} from './delegation-types.js';
import { assertIdentityDocumentShape, IDENTITY_EVENTS_COLLECTION, type IdentityEventDoc } from './identity-types.js';

const DELEGATION_FIELDS = new Set([
  'id', 'delegatorPrincipalId', 'delegateePrincipalId', 'tenantId', 'scope', 'capability',
  'actions', 'targetScope', 'constraints', 'chainDepth', 'chain', 'grantedBy', 'approval',
  'oneShot', 'useCount', 'expiresAt', 'status', 'createdAt', 'updatedAt', 'consumedAt',
  'revokedAt', 'revocationReason',
]);

const IDENTITY_EVENT_FIELDS = new Set([
  'id', 'at', 'tenantId', 'kind', 'principalId', 'resource', 'authority', 'decision', 'result',
  'detail', 'correlationId',
]);

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertNoWildcardOperation(value: string, context: string): void {
  if (value.includes('*')) {
    throw new DelegationStoreError('WILDCARD_REFUSED', `${context}: wildcard operations are refused (no grant-all; fail-closed).`);
  }
}

function assertValidActions(actions: readonly unknown[], context: string): asserts actions is readonly { tool: string; operation: string }[] {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new DelegationStoreError('INVALID_INPUT', `${context}: actions must be a non-empty array (fail-closed).`);
  }
  for (const action of actions) {
    const a = action as { tool?: unknown; operation?: unknown };
    if (!isNonBlank(a.tool) || !isNonBlank(a.operation)) {
      throw new DelegationStoreError('INVALID_INPUT', `${context}: every action needs a non-blank tool and operation (fail-closed).`);
    }
    assertNoWildcardOperation(a.operation, context);
  }
}

function assertValidTargetScope(targets: readonly unknown[], context: string): asserts targets is readonly { system: string; resourcePattern?: string }[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new DelegationStoreError('INVALID_INPUT', `${context}: targetScope must be a non-empty array (fail-closed).`);
  }
  for (const target of targets) {
    const t = target as { system?: unknown; resourcePattern?: unknown };
    if (!isNonBlank(t.system)) {
      throw new DelegationStoreError('INVALID_INPUT', `${context}: every target needs a non-blank system (fail-closed).`);
    }
    if (t.resourcePattern !== undefined && typeof t.resourcePattern !== 'string') {
      throw new DelegationStoreError('INVALID_INPUT', `${context}: resourcePattern must be a string (fail-closed).`);
    }
  }
}

function assertValidApproval(approval: DelegationApprovalBinding | undefined, context: string): void {
  if (approval === undefined) return;
  if (
    !isNonBlank(approval.approvalId) ||
    !isNonBlank(approval.approverId) ||
    !Number.isFinite(approval.approvedAt) ||
    !Number.isFinite(approval.expiresAt) ||
    !isNonBlank(approval.approvedActionDigest)
  ) {
    throw new DelegationStoreError('INVALID_INPUT', `${context}: the approval binding is malformed (fail-closed).`);
  }
  if (approval.approvedAt >= approval.expiresAt) {
    throw new DelegationStoreError('INVALID_INPUT', `${context}: the approval binding is already expired (fail-closed).`);
  }
}

function assertValidGrant(input: GrantDelegationInput, now: number): void {
  if (!isNonBlank(input.delegatorPrincipalId)) throw new DelegationStoreError('INVALID_INPUT', 'delegatorPrincipalId is required (fail-closed).');
  if (!isNonBlank(input.delegateePrincipalId)) throw new DelegationStoreError('INVALID_INPUT', 'delegateePrincipalId is required (fail-closed).');
  if (input.delegateePrincipalId === input.delegatorPrincipalId) {
    throw new DelegationStoreError(
      'SELF_DELEGATION_REFUSED',
      'a principal cannot delegate to itself (recursion/chain guard; fail-closed).',
    );
  }
  if (input.scope === 'tenant' && !isNonBlank(input.tenantId)) {
    throw new DelegationStoreError('INVALID_INPUT', 'tenant-scoped delegation requires a tenantId (fail-closed).');
  }
  if (input.scope !== 'tenant' && input.scope !== 'platform') {
    throw new DelegationStoreError('INVALID_INPUT', `"${String(input.scope)}" is not a recognized delegation scope (fail-closed).`);
  }
  if (!isNonBlank(input.capability.capabilityId) || !isNonBlank(input.capability.capabilityVersion)) {
    throw new DelegationStoreError('INVALID_INPUT', 'capabilityId and capabilityVersion are required (fail-closed).');
  }
  assertValidActions(input.actions, 'grant');
  assertValidTargetScope(input.targetScope, 'grant');
  const maxAgeMs = input.constraints?.maxAgeMs;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > MAX_DELEGATION_LIFETIME_MS) {
    throw new DelegationStoreError(
      'INVALID_LIFETIME',
      `delegation maxAgeMs must be within (0, ${MAX_DELEGATION_LIFETIME_MS}] ms (fail-closed).`,
    );
  }
  if (!isDelegationChainDepthAllowed(input.chainDepth)) {
    throw new DelegationStoreError('CHAIN_DEPTH_EXCEEDED', `chainDepth ${input.chainDepth} exceeds the allowed bound (≤ ${'2'}); fail-closed.`);
  }
  if (!Array.isArray(input.chain) || input.chain.length === 0) {
    throw new DelegationStoreError('INVALID_INPUT', 'the grant chain must cite the delegator\'s authority evidence (non-empty; fail-closed).');
  }
  if (input.chain.some((entry) => !isNonBlank(entry))) {
    throw new DelegationStoreError('INVALID_INPUT', 'the grant chain contains a blank evidence entry (fail-closed).');
  }
  if (!isNonBlank(input.grantedBy.principalId) || !isNonBlank(input.grantedBy.authenticationEventId)) {
    throw new DelegationStoreError('INVALID_INPUT', 'grantedBy principalId and authenticationEventId are required (fail-closed).');
  }
  assertValidApproval(input.approval, 'grant');
  // One-shot vs counted usage.
  if (input.oneShot === true) {
    if (input.useCount !== undefined) {
      throw new DelegationStoreError('INVALID_INPUT', 'a one-shot grant cannot also carry a useCount (fail-closed).');
    }
  } else if (!Number.isInteger(input.useCount) || (input.useCount ?? 0) <= 0) {
    throw new DelegationStoreError('INVALID_INPUT', 'a counted grant requires a positive integer useCount (fail-closed).');
  }
  // Platform scope requires the fully-audited platform path (recorded
  // platform elevation + bound approval) — spec §8.2.2.
  if (input.scope === 'platform') {
    if (!isNonBlank(input.grantedBy.platformElevationId)) {
      throw new DelegationStoreError(
        'PLATFORM_SCOPE_REQUIRED',
        'a platform-scoped grant must record the delegator\'s platform-plane elevation at grant time (fail-closed).',
      );
    }
    if (input.approval === undefined) {
      throw new DelegationStoreError(
        'APPROVAL_REQUIRED',
        'a platform-scoped grant requires a bound digest approval (fail-closed).',
      );
    }
  }
  // Delegator authority (defense-in-depth): the grant must be a SUBSET of the
  // delegator's verified live-manifest scope. The authoritative re-check is
  // the decision-time chain re-verification.
  const evidence = input.delegatorEvidence;
  if (!isNonBlank(evidence.manifestDigest)) {
    throw new DelegationStoreError('INVALID_INPUT', 'delegatorEvidence.manifestDigest is required (fail-closed).');
  }
  for (const action of input.actions) {
    if (!evidence.actions.some((a) => a.tool === action.tool && a.operation === action.operation)) {
      throw new DelegationStoreError(
        'DELEGATOR_AUTHORITY_EXCEEDED',
        `the grant covers ${action.tool}/${action.operation}, which the delegator does not hold (fail-closed).`,
      );
    }
  }
  for (const target of input.targetScope) {
    if (!delegationTargetScopeWithin(target, evidence.targets)) {
      throw new DelegationStoreError(
        'DELEGATOR_AUTHORITY_EXCEEDED',
        `the grant target scope exceeds the delegator's manifest targets (fail-closed).`,
      );
    }
  }
  if (input.constraints.classificationCeiling !== undefined && evidence.classificationCeiling !== input.constraints.classificationCeiling) {
    const ceiling = input.constraints.classificationCeiling;
    const live = evidence.classificationCeiling;
    const ranks: Record<string, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 };
    if ((ranks[ceiling] ?? 0) > (ranks[live] ?? 0)) {
      throw new DelegationStoreError('DELEGATOR_AUTHORITY_EXCEEDED', 'the grant classification ceiling exceeds the delegator\'s manifest (fail-closed).');
    }
  }
  if (input.constraints.impactCeiling !== undefined) {
    const ranks: Record<string, number> = { READ: 0, REVERSIBLE_WRITE: 1, CONSEQUENTIAL_WRITE: 2, EXTERNAL_SIDE_EFFECT: 3 };
    if ((ranks[input.constraints.impactCeiling] ?? 0) > (ranks[evidence.impactCeiling] ?? 0)) {
      throw new DelegationStoreError('DELEGATOR_AUTHORITY_EXCEEDED', 'the grant impact ceiling exceeds the delegator\'s manifest (fail-closed).');
    }
  }
  if (evidence.requiresApproval && input.approval === undefined) {
    throw new DelegationStoreError('APPROVAL_REQUIRED', 'the delegator\'s capability requires an approval; the grant must bind one (fail-closed).');
  }
  void now;
}

function buildDelegation(input: GrantDelegationInput, id: string, now: number): DelegationDoc {
  const tenantId = input.scope === 'tenant' ? input.tenantId : DELEGATION_PLATFORM_TENANT;
  return {
    id,
    delegatorPrincipalId: input.delegatorPrincipalId,
    delegateePrincipalId: input.delegateePrincipalId,
    tenantId,
    scope: input.scope,
    capability: { capabilityId: input.capability.capabilityId, capabilityVersion: input.capability.capabilityVersion },
    actions: [...input.actions],
    targetScope: [...input.targetScope],
    constraints: {
      maxAgeMs: input.constraints.maxAgeMs,
      ...(input.constraints.classificationCeiling !== undefined ? { classificationCeiling: input.constraints.classificationCeiling } : {}),
      ...(input.constraints.impactCeiling !== undefined ? { impactCeiling: input.constraints.impactCeiling } : {}),
      ...(input.constraints.budgetCeiling !== undefined ? { budgetCeiling: input.constraints.budgetCeiling } : {}),
    },
    chainDepth: input.chainDepth,
    chain: [...input.chain],
    grantedBy: {
      principalId: input.grantedBy.principalId,
      authenticationEventId: input.grantedBy.authenticationEventId,
      ...(input.grantedBy.stepUpEventId !== undefined ? { stepUpEventId: input.grantedBy.stepUpEventId } : {}),
      ...(input.grantedBy.platformElevationId !== undefined ? { platformElevationId: input.grantedBy.platformElevationId } : {}),
    },
    ...(input.approval !== undefined ? { approval: { ...input.approval } } : {}),
    oneShot: input.oneShot,
    ...(input.oneShot === false ? { useCount: input.useCount } : {}),
    expiresAt: now + input.constraints.maxAgeMs,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * P2-S4 delegation repository. Fail-closed throughout: a non-transactional
 * source is refused at open, a forbidden grant is refused, every mutation is
 * CAS-guarded and audited in the same transaction, and a decision-time read
 * re-verifies against the LIVE manifest (chain integrity).
 */
export class DelegationStore {
  private constructor(private readonly source: SecurityCollectionSource) {}

  static async open(source: SecurityCollectionSource): Promise<DelegationStore> {
    if (!source.supportsTransactions()) {
      throw new DelegationStoreError(
        'NON_TRANSACTIONAL_SOURCE',
        'DelegationStore requires a transactional storage driver (PostgreSQL); a non-transactional store is never authoritative delegation state (fail-closed).',
      );
    }
    const store = new DelegationStore(source);
    const driver = source.getDriver();
    if (typeof driver.ensureIndex === 'function') {
      await driver.ensureIndex(DELEGATIONS_COLLECTION, { name: 'by_delegatee', keys: ['delegateePrincipalId'], includeTenant: true });
    }
    return store;
  }

  // -- scope helpers ---------------------------------------------------------

  private async inTenant<T>(tenantId: string, fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    StorageModule.validateTenantId(tenantId);
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) throw new DelegationStoreError('NON_ATOMIC', 'delegation write requires an atomic transaction (fail-closed).');
      return fn(scope);
    }, { tenantId });
  }

  private async inSystem<T>(fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) throw new DelegationStoreError('NON_ATOMIC', 'platform delegation operation requires an atomic transaction (fail-closed).');
      return fn(scope);
    });
  }

  // -- events ----------------------------------------------------------------

  private async appendEventInTx(scope: StorageWriteScope, event: IdentityEventDoc): Promise<void> {
    assertIdentityDocumentShape(event as unknown as Record<string, unknown>, IDENTITY_EVENT_FIELDS, 'identityEvent');
    const events = await scope.collection<IdentityEventDoc>(IDENTITY_EVENTS_COLLECTION);
    const res = await events.cas(event.id, (cur) => cur === undefined, () => ({ ...event }));
    if (!res.ok) {
      throw new DelegationStoreError('EVENT_ALREADY_RECORDED', `identity event "${event.id}" is already recorded (fail-closed).`);
    }
  }

  private delegationEvent(
    kind: 'DELEGATION_GRANTED' | 'DELEGATION_REVOKED' | 'DELEGATION_USED' | 'DELEGATION_DENIED',
    doc: DelegationDoc,
    actor: string,
    result: string,
    correlationId: string | undefined,
    detail: string,
  ): IdentityEventDoc {
    return {
      id: randomUUID(),
      at: doc.updatedAt,
      tenantId: doc.tenantId,
      kind,
      principalId: doc.delegateePrincipalId,
      resource: DELEGATIONS_COLLECTION,
      authority: { actor },
      decision: kind === 'DELEGATION_DENIED' ? 'DENY' : 'ALLOW',
      result,
      detail,
      ...(correlationId ? { correlationId } : {}),
    };
  }

  // -- authority surface ------------------------------------------------------

  /** The delegation-state authority the durable A-01 decider consults. */
  asStateAuthority(): DelegationStateAuthority {
    return {
      kind: 'p2-delegation-state-authority',
      peek: async (delegationId: string): Promise<DelegationPeek | undefined> => {
        return this.inSystem(async (scope) => {
          const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
          const row = await grants.get(delegationId);
          if (!row) return undefined;
          return { scope: row.scope, tenantId: row.tenantId };
        });
      },
      assessInTx: async (scope: StorageWriteScope, requirement: DelegationRequirement, now: number): Promise<DelegationAssessment> => {
        const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
        const row = await grants.get(requirement.delegationId);
        if (!row) {
          return { verdict: 'UNKNOWN_GRANT', delegationId: requirement.delegationId, detail: 'no grant is visible to the request tenant scope' };
        }
        assertDelegationDocumentShape(row as unknown as Record<string, unknown>, DELEGATION_FIELDS, 'delegation');
        return assessDelegationRow(row, requirement, now);
      },
      assessPlatform: async (requirement: DelegationRequirement, now: number): Promise<DelegationAssessment> => {
        return this.inSystem(async (scope) => {
          const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
          const row = await grants.get(requirement.delegationId);
          if (!row) {
            return { verdict: 'UNKNOWN_GRANT', delegationId: requirement.delegationId, detail: 'no such grant exists' };
          }
          assertDelegationDocumentShape(row as unknown as Record<string, unknown>, DELEGATION_FIELDS, 'delegation');
          return assessDelegationRow(row, requirement, now);
        });
      },
      consumeInTx: async (scope: StorageWriteScope, delegationId: string, now: number): Promise<DelegationDoc> => {
        const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
        const result = await grants.cas(
          delegationId,
          (cur) => cur !== undefined && cur.status === 'ACTIVE',
          (cur) => {
            if (cur.oneShot) {
              return { ...cur, status: 'CONSUMED' as const, consumedAt: now, updatedAt: now };
            }
            const remaining = (cur.useCount ?? 1) - 1;
            return remaining <= 0
              ? { ...cur, status: 'CONSUMED' as const, useCount: 0, consumedAt: now, updatedAt: now }
              : { ...cur, useCount: remaining, updatedAt: now };
          },
        );
        if (!result.ok || result.doc === undefined) {
          const current = await grants.get(delegationId);
          if (!current) {
            throw new DelegationStoreError('UNKNOWN_GRANT', `delegation "${delegationId}" does not exist (fail-closed).`);
          }
          throw new DelegationStoreError(
            current.status === 'REVOKED' ? 'REVOKED' : current.status === 'CONSUMED' ? 'CONSUMED' : 'EXPIRED',
            `delegation "${delegationId}" is not consumable (status ${current.status}; fail-closed).`,
          );
        }
        return result.doc;
      },
      consumePlatform: async (delegationId: string, now: number): Promise<DelegationDoc> => {
        return this.inSystem(async (scope) => {
          const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
          const result = await grants.cas(
            delegationId,
            (cur) => cur !== undefined && cur.status === 'ACTIVE',
            (cur) => {
              if (cur.oneShot) {
                return { ...cur, status: 'CONSUMED' as const, consumedAt: now, updatedAt: now };
              }
              const remaining = (cur.useCount ?? 1) - 1;
              return remaining <= 0
                ? { ...cur, status: 'CONSUMED' as const, useCount: 0, consumedAt: now, updatedAt: now }
                : { ...cur, useCount: remaining, updatedAt: now };
            },
          );
          if (!result.ok || result.doc === undefined) {
            const current = await grants.get(delegationId);
            if (!current) {
              throw new DelegationStoreError('UNKNOWN_GRANT', `delegation "${delegationId}" does not exist (fail-closed).`);
            }
            throw new DelegationStoreError(
              current.status === 'REVOKED' ? 'REVOKED' : current.status === 'CONSUMED' ? 'CONSUMED' : 'EXPIRED',
              `delegation "${delegationId}" is not consumable (status ${current.status}; fail-closed).`,
            );
          }
          return result.doc;
        });
      },
    };
  }

  // -- grant / revoke ---------------------------------------------------------

  /** Grant a delegation (validated + subset-checked + audited in one tx). */
  async grantDelegation(input: GrantDelegationInput, now: number): Promise<DelegationDoc> {
    assertValidGrant(input, now);
    const id = randomUUID();
    const doc = buildDelegation(input, id, now);
    assertDelegationDocumentShape(doc as unknown as Record<string, unknown>, DELEGATION_FIELDS, 'delegation');
    const write = async (scope: StorageWriteScope): Promise<DelegationDoc> => {
      const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
      const res = await grants.cas(id, (cur) => cur === undefined, () => ({ ...doc }));
      if (!res.ok) {
        throw new DelegationStoreError('DELEGATION_ID_CONFLICT', `delegation id "${id}" already exists (fail-closed).`);
      }
      const event = this.delegationEvent(
        'DELEGATION_GRANTED',
        doc,
        input.grantedBy.principalId,
        'granted',
        input.correlationId,
        `delegatee=${doc.delegateePrincipalId};capability=${doc.capability.capabilityId}@${doc.capability.capabilityVersion};scope=${doc.scope};depth=${doc.chainDepth};expiresAt=${doc.expiresAt}`,
      );
      await this.appendEventInTx(scope, event);
      return doc;
    };
    return input.scope === 'tenant' ? this.inTenant(input.tenantId, write) : this.inSystem(write);
  }

  /** Revoke a delegation (CAS-guarded, idempotent, reason-mandatory, audited). */
  async revokeDelegation(input: RevokeDelegationInput, now: number): Promise<{ readonly delegationId: string; readonly status: DelegationStatus }> {
    if (!isNonBlank(input.delegationId)) throw new DelegationStoreError('INVALID_INPUT', 'revocation delegationId is required (fail-closed).');
    if (!isNonBlank(input.reason)) throw new DelegationStoreError('INVALID_INPUT', 'revocation reason is mandatory and non-blank (fail-closed).');
    if (!isNonBlank(input.revokedBy)) throw new DelegationStoreError('INVALID_INPUT', 'revokedBy (acting authority) is required (fail-closed).');
    const doRevoke = async (scope: StorageWriteScope): Promise<{ readonly delegationId: string; readonly status: DelegationStatus }> => {
      const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
      const res = await grants.cas(
        input.delegationId,
        (cur) => cur !== undefined && cur.status === 'ACTIVE',
        (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: input.reason.trim(), updatedAt: now }),
      );
      if (res.ok && res.doc) {
        const doc = res.doc;
        const event = this.delegationEvent(
          'DELEGATION_REVOKED',
          doc,
          input.revokedBy,
          'revoked',
          input.correlationId,
          `reason=${doc.revocationReason ?? ''}`,
        );
        await this.appendEventInTx(scope, event);
        return { delegationId: input.delegationId, status: 'REVOKED' };
      }
      const current = await grants.get(input.delegationId);
      if (current && (current.status === 'REVOKED' || current.status === 'EXPIRED' || current.status === 'CONSUMED')) {
        return { delegationId: input.delegationId, status: current.status };
      }
      throw new DelegationStoreError('DELEGATION_NOT_FOUND', `delegation "${input.delegationId}" was not found (fail-closed).`);
    };
    if (input.scope === 'tenant') {
      if (!isNonBlank(input.tenantId)) throw new DelegationStoreError('INVALID_INPUT', 'tenant-scoped revocation requires a tenantId (fail-closed).');
      return this.inTenant(input.tenantId, doRevoke);
    }
    return this.inSystem(doRevoke);
  }

  /** Mark ACTIVE grants past their window as EXPIRED (deny-early derived at read; hygiene only). */
  async sweepExpired(tenantId: string, now: number): Promise<number> {
    return this.inTenant(tenantId, async (scope) => {
      const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
      const rows = await grants.query({ where: (g) => g.status === 'ACTIVE' });
      let swept = 0;
      for (const row of rows) {
        assertDelegationDocumentShape(row as unknown as Record<string, unknown>, DELEGATION_FIELDS, 'delegation');
        if (isDelegationExpired(row.expiresAt, now)) {
          const res = await grants.cas(
            row.id,
            (cur) => cur !== undefined && cur.status === 'ACTIVE' && isDelegationExpired(cur.expiresAt, now),
            (cur) => ({ ...cur, status: 'EXPIRED' as const, updatedAt: now }),
          );
          if (res.ok) swept += 1;
        }
      }
      return swept;
    });
  }

  /** Read one grant in tenant scope (client-facing; RLS-bound). */
  async getDelegation(tenantId: string, delegationId: string): Promise<DelegationDoc | undefined> {
    return this.inTenant(tenantId, async (scope) => {
      const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
      const row = await grants.get(delegationId);
      if (row) {
        assertDelegationDocumentShape(row as unknown as Record<string, unknown>, DELEGATION_FIELDS, 'delegation');
      }
      return row;
    });
  }

  /** List grants for a delegatee in tenant scope (client-facing; RLS-bound). */
  async listDelegations(tenantId: string, delegateePrincipalId: string): Promise<readonly DelegationDoc[]> {
    return this.inTenant(tenantId, async (scope) => {
      const grants = await scope.collection<DelegationDoc>(DELEGATIONS_COLLECTION);
      const rows = await grants.query({ where: (g) => g.delegateePrincipalId === delegateePrincipalId });
      for (const row of rows) {
        assertDelegationDocumentShape(row as unknown as Record<string, unknown>, DELEGATION_FIELDS, 'delegation');
      }
      return rows;
    });
  }
}
