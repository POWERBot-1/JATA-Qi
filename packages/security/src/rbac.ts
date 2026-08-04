// Role-based access control. A Principal holds roles; each role maps to a set of
// permission strings. Permission matching supports the "*" wildcard and
// "<resource>:<action>" segments, e.g. "knowledge:read" is granted by "knowledge:*"
// or "*".

import type { Principal } from './types.js';

export class RolePolicy {
  private roles = new Map<string, Set<string>>();

  constructor(initial: Record<string, string[]> = {}) {
    for (const [name, perms] of Object.entries(initial)) {
      this.roles.set(name, new Set(perms));
    }
  }

  /** Define or replace a role's permission set. */
  setRole(name: string, permissions: string[]): void {
    this.roles.set(name, new Set(permissions));
  }

  getRole(name: string): Set<string> | undefined {
    return this.roles.get(name);
  }

  /** All permissions granted to a principal across its roles. */
  permissionsFor(principal: Principal): Set<string> {
    const out = new Set<string>();
    for (const role of principal.roles) {
      const perms = this.roles.get(role);
      if (perms) for (const p of perms) out.add(p);
    }
    return out;
  }

  /**
   * Returns true if the principal is granted `required`.
   * Matching rules (most specific first):
   *   - exact match
   *   - "*" (global wildcard)
   *   - "<segment>:*" (e.g. "knowledge:*" grants "knowledge:read")
   */
  authorize(principal: Principal, required: string): boolean {
    const perms = this.permissionsFor(principal);
    if (perms.has('*')) return true;
    if (perms.has(required)) return true;
    const ns = required.split(':')[0];
    if (ns && perms.has(`${ns}:*`)) return true;
    return false;
  }
}

/** True if the principal satisfies ALL of the required permissions. */
export function checkAll(policy: RolePolicy, principal: Principal, required: string[]): boolean {
  return required.every((p) => policy.authorize(principal, p));
}
