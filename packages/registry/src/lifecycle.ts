// Domain lifecycle state machine — ICANN grace-period model (RFC 5731 statuses
// + Auto-Renew Grace / Redemption Grace / Pending Delete). Phases are derived
// from expiry dates and status sets so the registry-of-record is always
// consistent.

import type { DomainObject, DomainPhase, DomainStatus } from './types.js';

/** Grace-period durations (ms), per ICANN consensus policy defaults. */
export const GracePeriods = {
  /** Auto-Renew Grace Period (ARGP): 45 days after expiry. */
  autoRenew: 45 * 86400_000,
  /** Redemption Grace Period (RGP): 30 days after ARGP ends. */
  redemption: 30 * 86400_000,
  /** Pending Delete: 5 days after RGP ends before release. */
  pendingDelete: 5 * 86400_000,
};

const MS_PER_YEAR = 365 * 86400_000;

/** Add N years (365-day years) to an epoch-ms timestamp. */
export function addYears(epoch: number, years: number): number {
  return epoch + years * MS_PER_YEAR;
}

/** Whether a domain is currently within its registration term. */
export function isLive(domain: DomainObject, now = Date.now()): boolean {
  return domain.expiresAt > now;
}

/**
 * Recompute the lifecycle phase from the expiry date, status set, and grace
 * periods. The phase is authoritative — clients must not set it directly.
 */
export function recomputePhase(domain: DomainObject, now = Date.now()): DomainPhase {
  const statuses = domain.statuses;
  if (statuses.has('pendingDelete')) return 'pending-delete';
  if (domain.restoreRequestedAt && statuses.has('pendingUpdate')) return 'pending-restore';
  if (domain.expiresAt > now) return 'active';
  // Expired — walk the grace timeline.
  const sinceExpiry = now - domain.expiresAt;
  if (sinceExpiry <= GracePeriods.autoRenew) return 'auto-renew-grace';
  if (sinceExpiry <= GracePeriods.autoRenew + GracePeriods.redemption) return 'redemption-grace';
  if (sinceExpiry <= GracePeriods.autoRenew + GracePeriods.redemption + GracePeriods.pendingDelete) return 'pending-delete';
  return 'released';
}

/** Apply the recomputed phase to a domain in place and return it. */
export function refreshPhase(domain: DomainObject, now = Date.now()): DomainObject {
  domain.phase = recomputePhase(domain, now);
  domain.updatedAt = now;
  return domain;
}

/**
 * Transition: renew a domain by `periodYears`, extending the expiry from its
 * current expiry (or now, whichever is later). Refuses renewal of prohibited
 * domains.
 */
export function renew(domain: DomainObject, periodYears: number, now = Date.now()): DomainObject {
  if (domain.statuses.has('clientRenewProhibited') || domain.statuses.has('serverRenewProhibited')) {
    throw new LifecycleError(`renew prohibited for ${domain.name}`);
  }
  if (domain.phase === 'pending-delete' || domain.phase === 'released') {
    throw new LifecycleError(`cannot renew ${domain.name} in ${domain.phase}`);
  }
  const base = Math.max(domain.expiresAt, now);
  domain.expiresAt = addYears(base, periodYears);
  refreshPhase(domain, now);
  return domain;
}

/**
 * Transition: restore a domain from redemption-grace (RGP). The restore resets
 * the expiry by one year and clears the restore request.
 */
export function restore(domain: DomainObject, now = Date.now()): DomainObject {
  if (domain.phase !== 'redemption-grace' && domain.phase !== 'auto-renew-grace') {
    throw new LifecycleError(`restore requires grace phase, ${domain.name} is ${domain.phase}`);
  }
  domain.expiresAt = addYears(Math.max(domain.expiresAt, now), 1);
  domain.restoreRequestedAt = undefined;
  domain.statuses.delete('pendingUpdate');
  domain.statuses.delete('pendingDelete');
  refreshPhase(domain, now);
  return domain;
}

/** Transition: soft-delete — move to redemption grace (explicit delete). */
export function softDelete(domain: DomainObject, now = Date.now()): DomainObject {
  if (domain.statuses.has('clientDeleteProhibited') || domain.statuses.has('serverDeleteProhibited')) {
    throw new LifecycleError(`delete prohibited for ${domain.name}`);
  }
  // Immediately expire into redemption grace.
  if (domain.expiresAt > now) domain.expiresAt = now - GracePeriods.autoRenew - 1;
  domain.restoreRequestedAt = undefined;
  refreshPhase(domain, now);
  return domain;
}

export class LifecycleError extends Error {
  constructor(message: string) { super(message); this.name = 'LifecycleError'; }
}

export { MS_PER_YEAR };
export type { DomainStatus };
