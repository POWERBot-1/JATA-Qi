// R1/D2 — KERNEL-INTERNAL WORKER AUTHORITY.
//
// A number of in-repo services are kernel-internal workers: payments, billing
// settlement, autonomous deployment, autonomous test-repair, the copilot task
// graph, GitHub execution, the infrastructure state registry, and the unified
// loop. They drive the action runtime on behalf of the platform itself, and
// before R1 they drove it with NO principal at all — which the boundary could
// neither evaluate nor attribute.
//
// D2 says: do not exempt these paths. Give them a VERIFIED, EXPLICIT, SCOPED,
// AUDITABLE service identity instead, and keep them subject to the same
// boundary. This helper does exactly that and nothing more:
//
//   * it mints a `kernel:internal-execution` principal from the process's
//     `KernelInternalIdentity` (unforgeable outside the process);
//   * it registers a capability manifest that is NARROW BY CONSTRUCTION —
//     bound to one tool (the worker's adapter id), an explicit closed list of
//     operations, and an explicit list of target systems;
//   * it returns `undefined` when no boundary is installed, so the caller
//     passes no authorization and the action runtime DENIES (fail-closed).
//
// What it deliberately does NOT do:
//   * it does not grant a wildcard operation, tool, or target;
//   * it does not raise the classification/impact ceiling above what the
//     worker declares;
//   * it does not skip, short-circuit, or pre-approve any gate check. The
//     A-01 decision point still evaluates every request in full, and a
//     request outside the registered manifest is denied exactly as it would
//     be for a human principal.
//
// Tenancy: a platform worker legitimately acts for many tenants (the payments
// service settles for every tenant on the instance), so these manifests set
// `allowTenantWildcard` DELIBERATELY. That is a documented, reviewable,
// system-scope flag on a capability that is already pinned to one tool and a
// closed operation list — it is not a general tenancy escape, and the tenant
// binding on each individual decision still comes from the durable action
// record rather than from caller-supplied metadata.

import type { KernelApi } from '@jataqi/core-kernel';
import type { AuthorizationGate } from './gate.js';
import { AUTHORIZATION_GATE_TOKEN } from './module.js';
import {
  KERNEL_INTERNAL_IDENTITY_TOKEN,
  KernelInternalIdentity,
  type KernelInternalPrincipal,
} from './kernel-principal.js';
import type { A01DataClassification, A01ImpactLevel } from './types.js';

export interface KernelWorkerCapabilitySpec {
  /**
   * Capability id for this worker. Must be namespaced to the worker, e.g.
   * `kernel.worker.payments`.
   */
  readonly capabilityId: string;
  readonly capabilityVersion?: string;
  /** The worker's action-runtime adapter id. Exactly one tool, never a wildcard. */
  readonly tool: string;
  /** The closed list of operations (action types) this worker may drive. */
  readonly operations: readonly string[];
  /** The closed list of target systems, with optional resource patterns. */
  readonly targets: readonly { readonly system: string; readonly resourcePattern?: string }[];
  readonly maxDataClassification?: A01DataClassification;
  readonly maxImpact?: A01ImpactLevel;
  readonly budgetPerRunCostUnits?: number;
  readonly rateLimit?: { readonly windowMs: number; readonly max: number };
  readonly maxLifetimeMs?: number;
  readonly description?: string;
}

/**
 * The authorization inputs a kernel-internal worker passes to
 * `ActionRuntimeService.execute()`. Shaped to match `ActionRuntimeAuthorization`
 * without importing it (that would invert the dependency graph).
 */
export interface KernelWorkerAuthorization {
  readonly principal: KernelInternalPrincipal;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly dataClassification: A01DataClassification;
}

/**
 * Establish scoped kernel-internal authority for one worker.
 *
 * Returns `undefined` when the composition installed no boundary. The caller
 * MUST then pass no authorization, and the action runtime denies the
 * execution — absence of the boundary is never permission.
 */
export function establishKernelWorkerAuthority(
  kernel: KernelApi,
  spec: KernelWorkerCapabilitySpec,
): KernelWorkerAuthorization | undefined {
  if (!kernel.container.has(AUTHORIZATION_GATE_TOKEN) || !kernel.container.has(KERNEL_INTERNAL_IDENTITY_TOKEN)) {
    return undefined;
  }
  const gate = kernel.container.resolveSync<AuthorizationGate>(AUTHORIZATION_GATE_TOKEN);
  const identity = kernel.container.resolveSync<KernelInternalIdentity>(KERNEL_INTERNAL_IDENTITY_TOKEN);
  if (!gate || !(identity instanceof KernelInternalIdentity)) return undefined;

  if (spec.operations.length === 0) {
    throw new Error(
      `establishKernelWorkerAuthority("${spec.capabilityId}"): the operation list must be explicit and non-empty. A kernel worker never receives an open-ended grant.`,
    );
  }
  if (spec.targets.length === 0) {
    throw new Error(
      `establishKernelWorkerAuthority("${spec.capabilityId}"): the target list must be explicit and non-empty.`,
    );
  }

  const version = spec.capabilityVersion ?? '1';
  const principal = identity.mint('kernel:internal-execution');
  // Defence in depth: the identity we just used must verify against the
  // process authority for the exact scope we asked for.
  if (!identity.verify(principal, 'kernel:internal-execution')) {
    throw new Error(
      `establishKernelWorkerAuthority("${spec.capabilityId}"): the minted kernel principal failed verification (fail-closed).`,
    );
  }

  if (!gate.manifestsRegistry.get(spec.capabilityId, version)) {
    gate.manifestsRegistry.register({
      capabilityId: spec.capabilityId,
      version,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      allowedOperations: spec.operations.map((operation) => ({ tool: spec.tool, operation })),
      allowedTargets: spec.targets.map((target) => ({
        system: target.system,
        ...(target.resourcePattern !== undefined ? { resourcePattern: target.resourcePattern } : {}),
      })),
      // Deliberate, documented system scope for a platform worker capability
      // that is already pinned to one tool and a closed operation list.
      tenantScopes: [],
      allowTenantWildcard: true,
      maxDataClassification: spec.maxDataClassification ?? 'INTERNAL',
      maxImpact: spec.maxImpact ?? 'EXTERNAL_SIDE_EFFECT',
      requiredCredentialScopes: [],
      requiresApproval: false,
      rateLimit: spec.rateLimit ?? { windowMs: 60_000, max: 10_000 },
      budgetPerRunCostUnits: spec.budgetPerRunCostUnits ?? 10_000,
      maxLifetimeMs: spec.maxLifetimeMs ?? 60_000,
      registeredBy: { principalId: principal.id, tenantId: principal.tenantId },
      policyVersion: 'a01-kernel-worker-1',
      createdAt: Date.now(),
    });
  }

  return {
    principal,
    capabilityId: spec.capabilityId,
    capabilityVersion: version,
    dataClassification: spec.maxDataClassification ?? 'INTERNAL',
  };
}
