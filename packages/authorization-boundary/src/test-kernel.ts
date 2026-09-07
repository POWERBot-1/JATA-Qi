// R1 §6 — TEST KERNEL WITH A REAL AUTHORIZATION BOUNDARY.
//
// Tests are NOT exempt from the security boundary. This helper does the
// opposite of a bypass: it installs the SAME `AuthorizationBoundaryModule`
// the production composition installs, declares the SAME mandatory kernel
// invariant, and then helps a legitimate test construct LEGITIMATE
// authorization (a real principal, a real capability manifest, a real sealed
// envelope rendered by the real gate).
//
// What this file deliberately does NOT provide:
//   * no TEST_BYPASS_AUTH, no ALLOW_ALL, no env-var switch;
//   * no mock/stub gate that returns ALLOW;
//   * no way to remove, disable, or relax the boundary;
//   * no wildcard capability that authorizes arbitrary operations.
//
// A test that needs unauthorized behaviour asserts DENY. A test that needs
// authorized behaviour mints a scoped manifest and a verified principal and
// lets the real decision point decide.

import { CapabilityManifestRegistry } from './capability-manifests.js';
import type { A01CapabilityManifest, A01PrincipalBinding } from './types.js';

/**
 * Build a NARROW capability manifest for one test. Nothing is wildcarded
 * unless the test explicitly asks for it, and the caller must name the exact
 * (tool, operation) pairs and target systems it intends to exercise.
 */
export function testCapabilityManifest(spec: {
  capabilityId: string;
  version?: string;
  operations: readonly { tool: string; operation: string }[];
  targets: readonly { system: string; resourcePattern?: string }[];
  tenantScopes: readonly string[];
  maxDataClassification?: A01CapabilityManifest['maxDataClassification'];
  maxImpact?: A01CapabilityManifest['maxImpact'];
  requiredCredentialScopes?: readonly string[];
  credentialAudience?: string;
  requiresApproval?: boolean;
  rateLimit?: { windowMs: number; max: number };
  budgetPerRunCostUnits?: number;
  maxLifetimeMs?: number;
  registeredBy?: { principalId: string; tenantId: string };
  policyVersion?: string;
  createdAt?: number;
}): A01CapabilityManifest {
  if (spec.tenantScopes.length === 0) {
    throw new Error(
      'testCapabilityManifest: tenantScopes must be explicit. A test manifest never silently becomes tenant-wildcard.',
    );
  }
  return {
    capabilityId: spec.capabilityId,
    version: spec.version ?? '1',
    allowedOperations: spec.operations.map((entry) => ({ tool: entry.tool, operation: entry.operation })),
    allowedTargets: spec.targets.map((entry) => ({
      system: entry.system,
      ...(entry.resourcePattern !== undefined ? { resourcePattern: entry.resourcePattern } : {}),
    })),
    tenantScopes: [...spec.tenantScopes],
    allowTenantWildcard: false,
    maxDataClassification: spec.maxDataClassification ?? 'INTERNAL',
    maxImpact: spec.maxImpact ?? 'EXTERNAL_SIDE_EFFECT',
    requiredCredentialScopes: spec.requiredCredentialScopes ? [...spec.requiredCredentialScopes] : [],
    ...(spec.credentialAudience !== undefined ? { credentialAudience: spec.credentialAudience } : {}),
    requiresApproval: spec.requiresApproval ?? false,
    rateLimit: spec.rateLimit ?? { windowMs: 60_000, max: 1_000 },
    budgetPerRunCostUnits: spec.budgetPerRunCostUnits ?? 100,
    maxLifetimeMs: spec.maxLifetimeMs ?? 60_000,
    registeredBy: spec.registeredBy ?? { principalId: 'test-operator', tenantId: spec.tenantScopes[0]! },
    policyVersion: spec.policyVersion ?? 'a01-policy-1',
    createdAt: spec.createdAt ?? Date.now(),
  };
}

/** Register a set of narrow manifests on a real registry. */
export function withTestManifests(
  registry: CapabilityManifestRegistry,
  manifests: readonly A01CapabilityManifest[],
): CapabilityManifestRegistry {
  for (const manifest of manifests) registry.register(manifest);
  return registry;
}

/**
 * A LEGITIMATE test principal. This is not a bypass: it is a well-formed
 * verified-principal projection with a recognized authentication method, an
 * explicit tenant, and an authentication event id. The A-01 decision point
 * still evaluates it against a manifest and denies anything out of scope.
 */
export function testPrincipal(spec: {
  id: string;
  tenantId: string;
  roles?: readonly string[];
  /** Defaults to DETERMINISTIC_TEST — an honest label, not a privilege. */
  authenticationMethod?: string;
  authenticationEventId?: string;
}): A01PrincipalBinding {
  return Object.freeze({
    id: spec.id,
    tenantId: spec.tenantId,
    roles: Object.freeze([...(spec.roles ?? [])]),
    authenticationMethod: spec.authenticationMethod ?? 'DETERMINISTIC_TEST',
    authenticationEventId: spec.authenticationEventId ?? `authn-${spec.id}-${spec.tenantId}`,
  });
}
