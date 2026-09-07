// Explicit capability manifests: registration, validation, and the
// monotonic-narrowing rule for new versions.
//
// A manifest is the ONLY declaration of what a capability may do. It is
// validated strictly at registration (malicious/over-privileged manifests are
// rejected), immutable once registered, and a newer version may only NARROW
// the previous one: adding operations, widening tenant or resource scope,
// introducing a tenant wildcard, raising classification/impact ceilings,
// dropping the approval requirement, or raising rate/budget limits is a
// registration error.

import { deepFreeze } from './canonical.js';
import type { A01CapabilityManifest } from './types.js';
import {
  A01_CLASSIFICATION_ORDER,
  A01_IMPACT_ORDER,
  isA01DataClassification,
  isA01ImpactLevel,
  ManifestRejectedError,
} from './types.js';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Strict manifest shape validation. Exported for the R2 durable manifest
 * repository, which validates on write AND re-validates rows on read
 * (defense in depth: a corrupt durable row fails closed, never authorizes).
 */
export function validateManifestShape(manifest: A01CapabilityManifest): void {
  if (!isNonBlankString(manifest.capabilityId)) {
    throw new ManifestRejectedError('manifest: capabilityId is required (non-blank string)');
  }
  if (!isNonBlankString(manifest.version)) {
    throw new ManifestRejectedError('manifest: version is required (non-blank string)');
  }
  if (!Array.isArray(manifest.allowedOperations)) {
    throw new ManifestRejectedError('manifest: allowedOperations must be an explicit list');
  }
  if (manifest.allowedOperations.length === 0) {
    throw new ManifestRejectedError('manifest: an empty operation allow-list grants nothing and is rejected — register nothing instead');
  }
  for (const entry of manifest.allowedOperations) {
    if (!entry || typeof entry !== 'object') {
      throw new ManifestRejectedError('manifest: allowedOperations entries must be objects');
    }
    if (!isNonBlankString(entry.tool) || !isNonBlankString(entry.operation)) {
      throw new ManifestRejectedError('manifest: every allowed operation needs a non-blank tool and operation');
    }
    // Tool wildcards do not exist: an operation is always bound to an exact tool.
    if (entry.tool.includes('*') || entry.operation.includes('*')) {
      throw new ManifestRejectedError('manifest: wildcard tool/operation entries are not permitted (explicit allow only)');
    }
  }
  if (!Array.isArray(manifest.allowedTargets)) {
    throw new ManifestRejectedError('manifest: allowedTargets must be an explicit list');
  }
  if (manifest.allowedTargets.length === 0) {
    throw new ManifestRejectedError('manifest: an empty target allow-list grants nothing and is rejected');
  }
  for (const entry of manifest.allowedTargets) {
    if (!entry || typeof entry !== 'object' || !isNonBlankString(entry.system)) {
      throw new ManifestRejectedError('manifest: every allowed target needs a non-blank system');
    }
  }
  const hasTenantScope = Array.isArray(manifest.tenantScopes) && manifest.tenantScopes.length > 0;
  if (hasTenantScope) {
    for (const tenant of manifest.tenantScopes) {
      if (!isNonBlankString(tenant)) {
        throw new ManifestRejectedError('manifest: tenant scopes must be non-blank strings');
      }
    }
  } else if (!manifest.allowTenantWildcard) {
    throw new ManifestRejectedError('manifest: tenantScopes is empty and allowTenantWildcard is false — scope is ambiguous, refusing');
  }
  if (!isA01DataClassification(manifest.maxDataClassification)) {
    throw new ManifestRejectedError('manifest: maxDataClassification must be a recognized classification');
  }
  if (!isA01ImpactLevel(manifest.maxImpact)) {
    throw new ManifestRejectedError('manifest: maxImpact must be a recognized impact level');
  }
  if (!Array.isArray(manifest.requiredCredentialScopes)) {
    throw new ManifestRejectedError('manifest: requiredCredentialScopes must be a list');
  }
  for (const scope of manifest.requiredCredentialScopes) {
    if (!isNonBlankString(scope)) {
      throw new ManifestRejectedError('manifest: credential scopes must be non-blank strings');
    }
  }
  if (manifest.credentialAudience !== undefined && !isNonBlankString(manifest.credentialAudience)) {
    throw new ManifestRejectedError('manifest: credentialAudience must be a non-blank string');
  }
  if (manifest.credentialAudience !== undefined && manifest.requiredCredentialScopes.length === 0) {
    throw new ManifestRejectedError('manifest: credentialAudience is declared without required credential scopes');
  }
  if (typeof manifest.requiresApproval !== 'boolean') {
    throw new ManifestRejectedError('manifest: requiresApproval must be a boolean');
  }
  const rate = manifest.rateLimit;
  if (!rate || !Number.isFinite(rate.windowMs) || rate.windowMs <= 0 || !Number.isInteger(rate.max) || rate.max <= 0) {
    throw new ManifestRejectedError('manifest: rateLimit needs a positive windowMs and a positive integer max');
  }
  if (!Number.isFinite(manifest.budgetPerRunCostUnits) || manifest.budgetPerRunCostUnits <= 0) {
    throw new ManifestRejectedError('manifest: budgetPerRunCostUnits must be a positive number');
  }
  if (!Number.isFinite(manifest.maxLifetimeMs) || manifest.maxLifetimeMs <= 0) {
    throw new ManifestRejectedError('manifest: maxLifetimeMs must be a positive number');
  }
  if (!manifest.registeredBy || !isNonBlankString(manifest.registeredBy.principalId) || !isNonBlankString(manifest.registeredBy.tenantId)) {
    throw new ManifestRejectedError('manifest: registeredBy principalId and tenantId are required');
  }
  if (!isNonBlankString(manifest.policyVersion)) {
    throw new ManifestRejectedError('manifest: policyVersion is required');
  }
  if (typeof manifest.createdAt !== 'number' || !Number.isFinite(manifest.createdAt)) {
    throw new ManifestRejectedError('manifest: createdAt must be a finite number');
  }
}

function opKey(entry: { tool: string; operation: string }): string {
  return `${entry.tool}::${entry.operation}`;
}

function targetKey(entry: { system: string; resourcePattern?: string }): string {
  return `${entry.system}::${entry.resourcePattern ?? ''}`;
}

/** Whether `newManifest` narrows `previous` (never widens). Exported for the R2 durable manifest repository, which runs the IDENTICAL check inside the registration transaction. */
export function isNarrowing(previous: A01CapabilityManifest, next: A01CapabilityManifest): { ok: boolean; violation?: string } {
  const prevOps = new Set(previous.allowedOperations.map(opKey));
  for (const entry of next.allowedOperations) {
    if (!prevOps.has(opKey(entry))) {
      return { ok: false, violation: `adds operation ${opKey(entry)} (runtime permission addition is not permitted)` };
    }
  }
  const prevTargets = new Set(previous.allowedTargets.map(targetKey));
  for (const entry of next.allowedTargets) {
    if (!prevTargets.has(targetKey(entry))) {
      return { ok: false, violation: `widens target scope to ${targetKey(entry)}` };
    }
  }
  const prevTenants = new Set(previous.tenantScopes);
  if (previous.allowTenantWildcard) {
    // A wildcard-scoped capability may narrow to an explicit tenant list, or
    // stay wildcard; it may never drop scope silently (empty + false is
    // rejected by shape validation).
    if (!next.allowTenantWildcard && next.tenantScopes.length === 0) {
      return { ok: false, violation: 'drops all tenant scope without declaring it (ambiguous)' };
    }
  } else {
    if (next.allowTenantWildcard) {
      return { ok: false, violation: 'introduces a tenant wildcard (scope widening)' };
    }
    for (const tenant of next.tenantScopes) {
      if (!prevTenants.has(tenant)) {
        return { ok: false, violation: `widens tenant scope to "${tenant}"` };
      }
    }
  }
  if (A01_CLASSIFICATION_ORDER[next.maxDataClassification] > A01_CLASSIFICATION_ORDER[previous.maxDataClassification]) {
    return { ok: false, violation: 'raises the data classification ceiling' };
  }
  if (A01_IMPACT_ORDER[next.maxImpact] > A01_IMPACT_ORDER[previous.maxImpact]) {
    return { ok: false, violation: 'raises the impact ceiling' };
  }
  if (previous.requiresApproval && !next.requiresApproval) {
    return { ok: false, violation: 'drops the approval requirement' };
  }
  const missingScopes = previous.requiredCredentialScopes.filter(
    (scope) => !next.requiredCredentialScopes.includes(scope),
  );
  if (missingScopes.length > 0) {
    return { ok: false, violation: `drops required credential scope(s): ${missingScopes.join(', ')}` };
  }
  if (next.rateLimit.max > previous.rateLimit.max) {
    return { ok: false, violation: 'raises the rate limit' };
  }
  if (next.rateLimit.windowMs > previous.rateLimit.windowMs) {
    return { ok: false, violation: 'widens the rate window' };
  }
  if (next.budgetPerRunCostUnits > previous.budgetPerRunCostUnits) {
    return { ok: false, violation: 'raises the run budget' };
  }
  if (next.maxLifetimeMs > previous.maxLifetimeMs) {
    return { ok: false, violation: 'extends the authorization lifetime' };
  }
  return { ok: true };
}

/**
 * The explicit capability manifest registry. Registration is the only way a
 * capability gains authority; there is no runtime grant path.
 */
export class CapabilityManifestRegistry {
  private readonly manifests = new Map<string, Map<string, A01CapabilityManifest>>();

  /**
   * Register one immutable manifest version. `asVersion` must be greater
   * than any existing version for the same capability and may only narrow
   * the latest registered version.
   */
  register(manifest: A01CapabilityManifest): void {
    validateManifestShape(manifest);
    const byVersion = this.manifests.get(manifest.capabilityId) ?? new Map<string, A01CapabilityManifest>();
    if (byVersion.has(manifest.version)) {
      throw new ManifestRejectedError(
        `manifest "${manifest.capabilityId}" version "${manifest.version}" is already registered — a version is immutable and cannot be re-registered`,
      );
    }
    const previous = this.latest(manifest.capabilityId);
    if (previous) {
      const check = isNarrowing(previous, manifest);
      if (!check.ok) {
        throw new ManifestRejectedError(
          `manifest "${manifest.capabilityId}" v${manifest.version} rejected: ${check.violation} — new versions may only narrow`,
        );
      }
    }
    byVersion.set(manifest.version, deepFreeze({ ...manifest }));
    this.manifests.set(manifest.capabilityId, byVersion);
  }

  get(capabilityId: string, version: string): A01CapabilityManifest | undefined {
    return this.manifests.get(capabilityId)?.get(version);
  }

  latest(capabilityId: string): A01CapabilityManifest | undefined {
    const byVersion = this.manifests.get(capabilityId);
    if (!byVersion) return undefined;
    let best: A01CapabilityManifest | undefined;
    for (const manifest of byVersion.values()) {
      if (!best || compareVersion(manifest.version, best.version) > 0) best = manifest;
    }
    return best;
  }

  has(capabilityId: string): boolean {
    return this.manifests.has(capabilityId);
  }

  /** List capability ids (diagnostics; never grants anything). */
  listCapabilityIds(): string[] {
    return [...this.manifests.keys()].sort();
  }
}

/** Numeric-aware version compare ("2" > "10" is false, "10" > "9" is true). */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((part) => parseInt(part, 10));
  const pb = b.split('.').map((part) => parseInt(part, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const vb = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Match a concrete target resource against a manifest pattern. Patterns are
 * exact match unless they contain `*`, which matches any sequence within a
 * segment-delimited resource. An undefined resource only matches entries
 * without a resourcePattern.
 */
export function targetMatches(
  pattern: { readonly system: string; readonly resourcePattern?: string } | undefined,
  system: string,
  resource: string | undefined,
): boolean {
  if (!pattern) return false;
  if (pattern.system !== system) return false;
  if (pattern.resourcePattern === undefined) return resource === undefined;
  if (resource === undefined) return false;
  if (!pattern.resourcePattern.includes('*')) return pattern.resourcePattern === resource;
  const regex = new RegExp(
    `^${pattern.resourcePattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return regex.test(resource);
}
