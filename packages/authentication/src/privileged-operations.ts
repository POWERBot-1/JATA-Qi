// P2-S3 — the privileged-operation register (spec §9.3, §24-S3).
//
// The register is DATA IN CODE: the authoritative mapping from every
// enumerated privileged operation (PO-1…PO-15, verified §1.6) to its
// operation class, required plane role, scope, step-up requirement,
// approval requirement, and enforcement site. It is the single source the
// privilege stage consults to decide "is this operation privileged, and
// what elevation does it require?".
//
// Rule (§9.3): no privileged operation may silently rely on ambient
// authority. Every register entry names its required identity/role/scope/
// step-up/approval/audit/revocation/emergency behavior. A privileged
// operation NOT in the register is an implementation defect — an ad-hoc
// privileged check outside the register fails adversarial case A-13, and a
// register/config mismatch is a boot failure (P2-INV-10).

import { PrivilegeStoreError } from './privilege-types.js';
import type { PrivilegeOperationClass, PrivilegeRole, PrivilegeScope } from './privilege-types.js';
import {
  DEFAULT_STEP_UP_MAX_AGE_MS,
  isPrivilegeOperationClass,
  RECOGNIZED_PRIVILEGE_OPERATION_CLASSES,
} from './privilege-types.js';

export interface PrivilegedOperationEntry {
  /** Canonical, stable operation id (the register key). */
  readonly operationId: string;
  /** The register provenance (§1.6 enumeration, e.g. 'PO-1'). */
  readonly po: string;
  /** The operation class (one of the four standing classes). */
  readonly opClass: PrivilegeOperationClass;
  /** Elevation scope the operation requires. */
  readonly scope: PrivilegeScope;
  /** Whether a fresh step-up is required to hold the elevation. */
  readonly stepUpRequired: boolean;
  /** Step-up recency window (ms) when `stepUpRequired`. */
  readonly stepUpMaxAgeMs: number;
  /** Whether the operation additionally requires a digest-bound approval. */
  readonly approvalRequired: boolean;
  /** The service/method that enforces the operation (audit RESOURCE + migration trace). */
  readonly site: string;
  /** Optional A-01 (tool, operation) surface binding for pipeline classification. */
  readonly a01?: { readonly tool: string; readonly operation: string };
}

/** The required plane role for an operation class (standing role == class). */
export function requiredPlaneRole(opClass: PrivilegeOperationClass): PrivilegeRole {
  return opClass;
}

/**
 * The closed privileged-operation register. Faithful to §9.3: the standing
 * classes map 1:1 to their plane role; `break-glass` is the emergency path
 * (a role that can cover any class, activated per-use — §9.4, S6) and is NOT
 * a standing register class here.
 *
 * PO-1…PO-8 are the migrated ad-hoc role checks (§1.6); PO-9…PO-15 are the
 * already-governed/kernel-scoped mechanisms, registered for completeness so
 * that the register is the single authority (§9.3 rule).
 */
export const PRIVILEGED_OPERATION_REGISTER: readonly PrivilegedOperationEntry[] = Object.freeze([
  // -- tenant-admin (per-tenant administration) ---------------------------------
  { operationId: 'billing.plan.create', po: 'PO-1', opClass: 'tenant-admin', scope: 'tenant', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'billing-service.createPlan', a01: { tool: 'billing', operation: 'plan.create' } },
  { operationId: 'billing.invoice.admin', po: 'PO-1', opClass: 'tenant-admin', scope: 'tenant', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'billing-service.createInvoice' },

  // -- operator (operational plane) ----------------------------------------------
  { operationId: 'billing.subscription.create', po: 'PO-2', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'billing-service.createSubscription' },
  { operationId: 'billing.subscription.cancel', po: 'PO-2', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'billing-service.cancelSubscription' },
  { operationId: 'billing.invoice.create', po: 'PO-2', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'billing-service.createInvoice' },
  { operationId: 'billing.invoice.payment.create', po: 'PO-2', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'billing-service.createInvoicePayment' },
  { operationId: 'deployment.create', po: 'PO-4', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'deployment-service.createDeployment' },
  { operationId: 'deployment.queue', po: 'PO-4', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'deployment-service.queueDeployment' },
  { operationId: 'deployment.execute', po: 'PO-4', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'deployment-service.executeDeployment' },
  { operationId: 'deployment.verify', po: 'PO-4', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'deployment-service.verifyDeployment' },
  { operationId: 'deployment.rollback', po: 'PO-4', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'deployment-service.rollbackDeployment' },
  { operationId: 'deployment.adapter.register', po: 'PO-4', opClass: 'tenant-admin', scope: 'tenant', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'deployment-service.registerAdapter (tenant)' },
  { operationId: 'venture-factory.venture.create', po: 'PO-5', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'venture-factory-service.createVenture' },
  { operationId: 'venture-factory.venture.transition', po: 'PO-5', opClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'venture-factory-service.transition' },
  { operationId: 'kernel.maintenance', po: 'PO-14', opClass: 'operator', scope: 'platform', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'kernel-principal (kernel:maintenance)' },
  { operationId: 'security.retention-gc', po: 'PO-15', opClass: 'operator', scope: 'platform', stepUpRequired: false, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'security-state-store (kernel:maintenance)' },

  // -- platform-admin (platform-wide administration; approval required) ----------
  { operationId: 'billing.cross-tenant.read', po: 'PO-3', opClass: 'platform-admin', scope: 'platform', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'billing-service (canRead cross-tenant)', a01: { tool: 'billing', operation: 'read.cross-tenant' } },
  { operationId: 'causal-engine.cross-tenant.read', po: 'PO-8', opClass: 'platform-admin', scope: 'platform', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'causal-engine-service (canRead cross-tenant)' },
  { operationId: 'venture-factory.cross-tenant.read', po: 'PO-5', opClass: 'platform-admin', scope: 'platform', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'venture-factory-service (canRead cross-tenant)' },
  { operationId: 'deployment.adapter.register.cross-tenant', po: 'PO-4', opClass: 'platform-admin', scope: 'platform', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'deployment-service.registerAdapter (cross-tenant)' },
  { operationId: 'capability-fabric.capability.register', po: 'PO-6', opClass: 'platform-admin', scope: 'platform', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'capability-fabric-service (registry changes)' },
  { operationId: 'capability-fabric.engine.register', po: 'PO-6', opClass: 'platform-admin', scope: 'platform', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'capability-fabric-service (registry changes)' },
  { operationId: 'capability-fabric.audit.verify.cross-tenant', po: 'PO-7', opClass: 'platform-admin', scope: 'platform', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'capability-fabric-service.verifyTenantCapabilityAudit' },
  { operationId: 'operator.console.global-admin', po: 'PO-13', opClass: 'platform-admin', scope: 'platform', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'cli/host-inspect (global_admin opt-in)' },

  // -- security-admin -------------------------------------------------------------
  { operationId: 'authorization.approval.grant', po: 'PO-9', opClass: 'security-admin', scope: 'tenant', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'authorization-boundary (S-1 approvals)' },
  { operationId: 'authentication.token.import', po: 'PO-10', opClass: 'security-admin', scope: 'tenant', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'authentication/token-registry (S-9 import)' },
  { operationId: 'authentication.session.revoke', po: 'PO-11', opClass: 'security-admin', scope: 'tenant', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'authentication-event-store (S-8 revoke)' },
  { operationId: 'authorization.manifest.rotate', po: 'PO-12', opClass: 'security-admin', scope: 'platform', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'authorization-boundary (manifest rotation)' },
  { operationId: 'identity.enroll', po: 'P2-S1', opClass: 'security-admin', scope: 'tenant', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: false, site: 'authentication/identity-store.enroll', a01: { tool: 'identity', operation: 'enroll' } },
  { operationId: 'identity.deprovision', po: 'P2-S1', opClass: 'security-admin', scope: 'tenant', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'authentication/identity-store.deprovision' },
  { operationId: 'privilege.elevation.grant', po: 'P2-S3', opClass: 'security-admin', scope: 'tenant', stepUpRequired: true, stepUpMaxAgeMs: DEFAULT_STEP_UP_MAX_AGE_MS, approvalRequired: true, site: 'authentication/privilege-store.grantElevation' },
]);

/** The PO identifiers the register must cover (completeness — PO-1…PO-8). */
export const REQUIRED_PO_COVERAGE: readonly string[] = Object.freeze([
  'PO-1', 'PO-2', 'PO-3', 'PO-4', 'PO-5', 'PO-6', 'PO-7', 'PO-8',
]);

/** Resolve the register entry for a canonical operation id (undefined = not privileged). */
export function resolvePrivilegeRequirement(operationId: string): PrivilegedOperationEntry | undefined {
  if (typeof operationId !== 'string' || operationId.trim().length === 0) return undefined;
  return PRIVILEGED_OPERATION_REGISTER.find((entry) => entry.operationId === operationId);
}

/** Classify an A-01 (tool, operation) request against the register (undefined = not privileged). */
export function classifyPrivilegedA01(tool: string, operation: string): PrivilegedOperationEntry | undefined {
  if (typeof tool !== 'string' || typeof operation !== 'string') return undefined;
  return PRIVILEGED_OPERATION_REGISTER.find(
    (entry) => entry.a01 !== undefined && entry.a01.tool === tool && entry.a01.operation === operation,
  );
}

/**
 * P2-INV-10 support: assert the register is internally consistent and covers
 * every mandated PO entry. A mismatch (duplicate id, unknown class, missing
 * PO coverage) is a boot failure — the register is the binding authority.
 */
export function assertRegisterIntegrity(): { readonly ok: true; readonly count: number } {
  const seenIds = new Set<string>();
  const seenA01 = new Set<string>();
  for (const entry of PRIVILEGED_OPERATION_REGISTER) {
    if (typeof entry.operationId !== 'string' || entry.operationId.trim().length === 0) {
      throw new PrivilegeStoreError('REGISTER_INVALID', 'privileged-operation register: blank operationId (fail-closed).');
    }
    if (seenIds.has(entry.operationId)) {
      throw new PrivilegeStoreError('REGISTER_DUPLICATE', `privileged-operation register: duplicate operationId "${entry.operationId}" (fail-closed).`);
    }
    seenIds.add(entry.operationId);
    if (!isPrivilegeOperationClass(entry.opClass)) {
      throw new PrivilegeStoreError('REGISTER_INVALID', `privileged-operation register: "${entry.operationId}" has an unrecognized operation class (fail-closed).`);
    }
    if (entry.scope !== 'tenant' && entry.scope !== 'platform') {
      throw new PrivilegeStoreError('REGISTER_INVALID', `privileged-operation register: "${entry.operationId}" has an unrecognized scope (fail-closed).`);
    }
    if (!Number.isFinite(entry.stepUpMaxAgeMs) || entry.stepUpMaxAgeMs <= 0) {
      throw new PrivilegeStoreError('REGISTER_INVALID', `privileged-operation register: "${entry.operationId}" has an invalid step-up window (fail-closed).`);
    }
    if (entry.a01) {
      const key = `${entry.a01.tool}\u0000${entry.a01.operation}`;
      if (seenA01.has(key)) {
        throw new PrivilegeStoreError('REGISTER_DUPLICATE', `privileged-operation register: duplicate A-01 binding for "${entry.a01.tool}/${entry.a01.operation}" (fail-closed).`);
      }
      seenA01.add(key);
    }
  }
  const covered = new Set(PRIVILEGED_OPERATION_REGISTER.map((entry) => entry.po));
  const missing = REQUIRED_PO_COVERAGE.filter((po) => !covered.has(po));
  if (missing.length > 0) {
    throw new PrivilegeStoreError(
      'REGISTER_INCOMPLETE',
      `privileged-operation register: missing mandated coverage for ${missing.join(', ')} (fail-closed).`,
    );
  }
  return { ok: true, count: PRIVILEGED_OPERATION_REGISTER.length };
}

/** The recognized operation classes (re-exported for the invariant surface). */
export const RECOGNIZED_OPERATION_CLASSES = RECOGNIZED_PRIVILEGE_OPERATION_CLASSES;
