// R1/D2 — verified, explicit, scoped kernel-internal service identity.
//
// Some legitimate kernel-internal operations (bootstrap wiring, maintenance
// sweeps, self-verification, internal execution of already-authorized work)
// have no human or API caller to attribute authority to. Before R1 those
// paths simply ran with no principal at all, which is indistinguishable from
// an unauthorized caller — so the boundary could not deny them and could not
// audit them.
//
// This module introduces an explicit service principal instead:
//
//   * it is MINTED ONLY by the composition root, from a per-process secret
//     that is generated in-process and never leaves it;
//   * every minted principal carries a verifiable authenticationEventId
//     (HMAC over the identity + scope + issuance), so a forged
//     KERNEL_INTERNAL principal fails verification;
//   * it is CAPABILITY-SCOPED: a principal is minted for exactly one of the
//     declared kernel scopes and carries no other authority;
//   * it is NOT a bypass: it is an ordinary principal to the A-01 decision
//     point, which still requires a capability manifest, an allowed
//     operation, an in-scope target, classification/impact ceilings, budget,
//     rate, replay and audit. A kernel principal with no matching manifest is
//     denied exactly like anyone else;
//   * every use is auditable — the audit record carries the principal id and
//     the authentication event id.
//
// There is no wildcard kernel scope. `kernel:*` does not exist.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { A01PrincipalBinding } from './types.js';

/**
 * The closed set of kernel-internal authority scopes. Each is a narrow role,
 * NOT a god-mode grant. Adding a scope is a deliberate, reviewable change.
 */
export const KERNEL_INTERNAL_SCOPES = Object.freeze([
  /** Composition-root wiring performed during boot. */
  'kernel:bootstrap',
  /** Scheduled internal upkeep (compaction, expiry sweeps, reconciliation of internal state). */
  'kernel:maintenance',
  /** Read-only self-verification and invariant probing. */
  'kernel:verification',
  /**
   * Execution of internal, non-external work that a kernel worker performs on
   * behalf of already-authorized upstream work. It does NOT authorize any
   * external side effect: external impact still needs its own capability.
   */
  'kernel:internal-execution',
] as const);

export type KernelInternalScope = (typeof KERNEL_INTERNAL_SCOPES)[number];

export function isKernelInternalScope(value: unknown): value is KernelInternalScope {
  return typeof value === 'string' && (KERNEL_INTERNAL_SCOPES as readonly string[]).includes(value);
}

/** Reserved tenant for kernel-internal service identity. Never a customer tenant. */
export const KERNEL_INTERNAL_TENANT = 'system';

/** The stable principal id prefix for kernel-internal service identity. */
export const KERNEL_INTERNAL_PRINCIPAL_PREFIX = 'kernel-internal';

export interface KernelInternalPrincipal extends A01PrincipalBinding {
  readonly authenticationMethod: 'KERNEL_INTERNAL';
  /** Exactly one narrow kernel scope. */
  readonly roles: readonly [KernelInternalScope];
}

interface IssuedRecord {
  readonly scope: KernelInternalScope;
  readonly principalId: string;
  readonly issuedAt: number;
}

/**
 * Mints and verifies kernel-internal service principals for ONE process.
 *
 * The signing secret is generated in-process at construction and is never
 * read from configuration or the environment: there is no way for an external
 * actor (or a test fixture, or an env var) to obtain the ability to forge a
 * kernel principal. A principal minted by one authority never verifies
 * against another.
 */
export class KernelInternalIdentity {
  private readonly secret: Buffer;
  private readonly authorityId: string;
  private readonly issued = new Map<string, IssuedRecord>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.secret = randomBytes(32);
    this.authorityId = randomUUID();
    this.now = options.now ?? ((): number => Date.now());
  }

  /** Opaque identifier of this process's kernel identity authority (audit only). */
  get id(): string {
    return this.authorityId;
  }

  private sign(principalId: string, scope: KernelInternalScope, issuedAt: number): string {
    return createHmac('sha256', this.secret)
      .update(`${this.authorityId}\n${principalId}\n${scope}\n${issuedAt}`)
      .digest('hex');
  }

  /**
   * Mint a principal bound to exactly one kernel scope. An unrecognized scope
   * throws — a kernel principal is never minted for an undeclared authority.
   */
  mint(scope: KernelInternalScope): KernelInternalPrincipal {
    if (!isKernelInternalScope(scope)) {
      throw new Error(
        `KernelInternalIdentity: "${String(scope)}" is not a declared kernel-internal scope. ` +
          `Declared scopes: ${KERNEL_INTERNAL_SCOPES.join(', ')}. There is no wildcard scope.`,
      );
    }
    const issuedAt = this.now();
    const principalId = `${KERNEL_INTERNAL_PRINCIPAL_PREFIX}:${scope}:${randomUUID()}`;
    const authenticationEventId = `kie-${this.sign(principalId, scope, issuedAt)}`;
    this.issued.set(authenticationEventId, { scope, principalId, issuedAt });
    return Object.freeze({
      id: principalId,
      tenantId: KERNEL_INTERNAL_TENANT,
      roles: Object.freeze([scope]) as readonly [KernelInternalScope],
      authenticationMethod: 'KERNEL_INTERNAL',
      authenticationEventId,
    });
  }

  /**
   * Verify that a principal was actually minted by THIS authority for the
   * scope it claims. A forged, copied-with-edits, or foreign principal fails.
   */
  verify(principal: unknown, expectedScope?: KernelInternalScope): boolean {
    if (!principal || typeof principal !== 'object') return false;
    const p = principal as Partial<A01PrincipalBinding>;
    if (p.authenticationMethod !== 'KERNEL_INTERNAL') return false;
    if (typeof p.id !== 'string' || typeof p.authenticationEventId !== 'string') return false;
    if (p.tenantId !== KERNEL_INTERNAL_TENANT) return false;
    const roles = Array.isArray(p.roles) ? p.roles : [];
    if (roles.length !== 1 || !isKernelInternalScope(roles[0])) return false;
    const scope = roles[0];
    if (expectedScope !== undefined && scope !== expectedScope) return false;

    const record = this.issued.get(p.authenticationEventId);
    if (!record) return false;
    if (record.principalId !== p.id || record.scope !== scope) return false;

    const expectedTag = `kie-${this.sign(record.principalId, record.scope, record.issuedAt)}`;
    const a = Buffer.from(expectedTag);
    const b = Buffer.from(p.authenticationEventId);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Revoke a minted principal (e.g. when a worker is retired). */
  revoke(principal: KernelInternalPrincipal): boolean {
    return this.issued.delete(principal.authenticationEventId);
  }
}

export const KERNEL_INTERNAL_IDENTITY_TOKEN = 'authorization.kernel-identity';
