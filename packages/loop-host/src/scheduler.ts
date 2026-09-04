// Scheduler eligibility policy (pure functions, deterministic).
//
// The scheduler decides only WHEN eligible work may be dispatched. It never
// decides what the system should think or do, and it performs no dispatch
// itself — dispatch stays with the host service behind the lease boundary.

import type { HostedWorkItem } from './types.js';

/** Work that may be leased and dispatched right now. */
export function isDispatchEligible(item: HostedWorkItem, now: number): boolean {
  if (item.status !== 'QUEUED' && item.status !== 'SLEEPING') return false;
  if (item.availableAt > now) return false;
  if (item.leaseExpiry !== undefined && item.leaseExpiry > now) return false;
  if (item.leaseToken !== undefined) return false;
  return true;
}

/** In-flight work whose lease has expired and may be safely reclaimed. */
export function isReclaimable(item: HostedWorkItem, now: number): boolean {
  if (item.status !== 'LEASED' && item.status !== 'DISPATCHED') return false;
  if (item.leaseExpiry === undefined) return false;
  return item.leaseExpiry <= now;
}

/** Milliseconds until the next parked item becomes due (undefined when none parked). */
export function nextWakeInMs(items: readonly HostedWorkItem[], now: number): number | undefined {
  let next: number | undefined;
  for (const item of items) {
    if (item.status !== 'QUEUED' && item.status !== 'SLEEPING') continue;
    const delta = item.availableAt - now;
    if (delta <= 0) return 0;
    if (next === undefined || delta < next) next = delta;
  }
  return next;
}
