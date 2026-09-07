// R1 — kernel-level mandatory security invariants.
//
// The kernel cannot import the authorization boundary (that would invert the
// dependency graph), but it CAN own the invariant that a composition which
// declares itself security-critical must satisfy before it is allowed to
// reach the started state.
//
// A composition declares a mandatory security invariant by calling
// `kernel.requireSecurityInvariant(...)`. Every declared invariant is
// evaluated at the END of the init phase (all modules initialized, before any
// module is started). A failing invariant aborts boot deterministically: no
// module ever reaches `start`, so no protected surface can serve traffic in a
// composition whose authorization boundary is missing, uninitialized, or
// substituted.
//
// Invariants are:
//   * append-only — a declared invariant can never be removed or relaxed;
//   * non-overridable — declaring the same id twice is a hard error, so a
//     later registration cannot shadow an earlier stricter one;
//   * evaluated on EVERY boot, including re-boots.
//
// There is deliberately no flag, environment variable, or configuration path
// that disables an invariant. An authorization boundary that can be disabled
// is not authoritative.

import type { KernelApi } from './types.js';

export interface SecurityInvariant {
  /** Stable identifier, e.g. 'a01.authorization-boundary.mandatory'. */
  readonly id: string;
  /** Human-readable statement of what must be true. */
  readonly description: string;
  /**
   * Evaluate the invariant against the fully-initialized kernel. Return
   * `true` when satisfied; return a string (or `false`) to fail boot. Any
   * thrown error is also a failure — an invariant that cannot be evaluated
   * has NOT been satisfied (fail closed).
   */
  check(kernel: KernelApi): boolean | string | Promise<boolean | string>;
}

export class SecurityInvariantViolation extends Error {
  readonly invariantId: string;
  readonly detail: string;

  constructor(invariantId: string, description: string, detail: string) {
    super(
      `Kernel: MANDATORY SECURITY INVARIANT VIOLATED [${invariantId}] — ${description}. ${detail} ` +
        'Boot aborted (fail-closed): no module was started.',
    );
    this.name = 'SecurityInvariantViolation';
    this.invariantId = invariantId;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SecurityInvariantRegistry {
  private readonly invariants = new Map<string, SecurityInvariant>();

  /** Declare a mandatory invariant. Redeclaration is rejected, not merged. */
  require(invariant: SecurityInvariant): void {
    if (!invariant?.id || typeof invariant.check !== 'function') {
      throw new Error('Kernel: a security invariant requires an id and a check() function.');
    }
    if (this.invariants.has(invariant.id)) {
      throw new Error(
        `Kernel: security invariant "${invariant.id}" is already declared and cannot be redeclared. ` +
          'Shadowing a declared invariant would allow a weaker check to replace a stronger one.',
      );
    }
    this.invariants.set(invariant.id, invariant);
  }

  list(): readonly SecurityInvariant[] {
    return [...this.invariants.values()];
  }

  has(id: string): boolean {
    return this.invariants.has(id);
  }

  /** Evaluate every invariant. Throws `SecurityInvariantViolation` on the first failure. */
  async assertAll(kernel: KernelApi): Promise<void> {
    for (const invariant of this.invariants.values()) {
      let outcome: boolean | string;
      try {
        outcome = await invariant.check(kernel);
      } catch (error) {
        throw new SecurityInvariantViolation(
          invariant.id,
          invariant.description,
          `The invariant check threw and therefore did not pass: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      if (outcome !== true) {
        throw new SecurityInvariantViolation(
          invariant.id,
          invariant.description,
          typeof outcome === 'string' ? outcome : 'The invariant check returned false.',
        );
      }
    }
  }
}
