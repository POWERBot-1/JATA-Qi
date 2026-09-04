// Tenant-scoped durable work queue with lease ownership and bounded retries.
//
// Leases live *inside* the work record (no cross-collection transaction is
// available from the storage abstraction), so every mutation is a single
// collection put. Ownership is proven by an unguessable lease token: only the
// holder that presents the current token may settle, release, or fail the
// record. Expired leases may be reclaimed; active leases cannot be taken.

import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import {
  InvalidWorkTransitionError,
  LeaseConflictError,
  LoopHostError,
  StaleLeaseError,
  TenantIsolationError,
  type DispatchFailureClass,
  type EnqueueWorkInput,
  type HostedWorkItem,
  type HostedWorkStatus,
  type WorkSettlement,
} from './types.js';

export const WORK_COLLECTION = 'loop-host.work-items';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertActor(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || actor.roles.length === 0) {
    throw new LoopHostError('A tenant-bound actor with roles is required.');
  }
}

function assertCanAccess(actor: CommercialActor, tenantId: string): void {
  if (actor.tenantId !== tenantId && !actor.roles.includes('global_admin')) {
    throw new TenantIsolationError('Cross-tenant queue access is not authorized.');
  }
}

function normalizeAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(value) || value < 1 || value > 25) {
    throw new LoopHostError('maxAttempts must be an integer between 1 and 25.');
  }
  return value;
}

function normalizeDelay(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000) {
    throw new LoopHostError(`${field} must be between 0 and 3600000 ms.`);
  }
  return Math.floor(value);
}

/** Exponential backoff with full-jitter ceiling removed for determinism (tests inject now). */
export function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export class WorkQueue {
  private items!: ICollection<HostedWorkItem>;

  async init(kernel: KernelApi): Promise<void> {
    this.items = await kernel.getModule<StorageModule>('storage').collection<HostedWorkItem>(WORK_COLLECTION);
  }

  /**
   * Enqueue work. Idempotent: the same tenant + idempotency key returns the
   * existing record without creating a duplicate.
   */
  async enqueue(actor: CommercialActor, input: EnqueueWorkInput, now?: number): Promise<HostedWorkItem> {
    assertActor(actor);
    if (!input.task || !input.task.objective.trim()) throw new LoopHostError('A loop task objective is required.');
    const at = now ?? Date.now();
    const key = input.idempotencyKey?.trim() ? input.idempotencyKey.trim() : `work:${randomUUID()}`;
    const existing = (
      await this.items.query({
        where: (item) => item.tenantId === actor.tenantId && item.idempotencyKey === key,
        limit: 1,
      })
    )[0];
    if (existing) return copy(existing);
    const item: HostedWorkItem = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      correlationId: input.correlationId?.trim() ? input.correlationId.trim() : `host:${randomUUID()}`,
      idempotencyKey: key,
      task: copy(input.task),
      actor: { id: actor.id, tenantId: actor.tenantId, roles: [...actor.roles] },
      status: 'QUEUED',
      attemptCount: 0,
      maxAttempts: normalizeAttempts(input.maxAttempts),
      baseDelayMs: normalizeDelay(input.baseDelayMs, DEFAULT_BASE_DELAY_MS, 'baseDelayMs'),
      maxDelayMs: normalizeDelay(input.maxDelayMs, DEFAULT_MAX_DELAY_MS, 'maxDelayMs'),
      createdAt: at,
      updatedAt: at,
      availableAt: input.availableAt ?? at,
      checkpointSequence: 0,
    };
    await this.items.put(item);
    return copy(item);
  }

  /** Raw read without actor scoping (host-internal paths re-check tenancy at the boundary). */
  async getInternal(id: string): Promise<HostedWorkItem | undefined> {
    const item = await this.items.get(id);
    return item ? copy(item) : undefined;
  }

  async get(actor: CommercialActor, id: string): Promise<HostedWorkItem | undefined> {
    assertActor(actor);
    const item = await this.items.get(id);
    if (!item) return undefined;
    assertCanAccess(actor, item.tenantId);
    return copy(item);
  }

  async list(actor: CommercialActor, opts: { status?: HostedWorkStatus; limit?: number } = {}): Promise<HostedWorkItem[]> {
    assertActor(actor);
    const items = await this.items.query({
      where: (item) =>
        (item.tenantId === actor.tenantId || actor.roles.includes('global_admin')) &&
        (opts.status === undefined || item.status === opts.status),
      orderBy: 'createdAt',
      order: 'asc',
      limit: opts.limit,
    });
    return items.map(copy);
  }

  /** Items eligible for dispatch at `now` (due queue/sleep records, no active lease). */
  async due(now: number, limit: number): Promise<HostedWorkItem[]> {
    const items = await this.items.query({
      where: (item) =>
        (item.status === 'QUEUED' || item.status === 'SLEEPING') &&
        item.availableAt <= now &&
        (item.leaseExpiry === undefined || item.leaseExpiry <= now),
      orderBy: 'availableAt',
      order: 'asc',
      limit,
    });
    return items.map(copy);
  }

  /** Records holding an expired lease (crash/recovery candidates). */
  async withExpiredLease(now: number): Promise<HostedWorkItem[]> {
    const items = await this.items.query({
      where: (item) =>
        (item.status === 'LEASED' || item.status === 'DISPATCHED') &&
        item.leaseExpiry !== undefined &&
        item.leaseExpiry <= now,
    });
    return items.map(copy);
  }

  /**
   * Acquire the exclusive lease. Fails when the record is not acquirable or
   * an active lease is held — active leases can never be double-executed.
   */
  async acquireLease(id: string, owner: string, ttlMs: number, now: number): Promise<{ item: HostedWorkItem; token: string }> {
    if (!owner.trim()) throw new LoopHostError('A lease owner identity is required.');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 3_600_000) throw new LoopHostError('Lease TTL must be between 1 and 3600000 ms.');
    const item = await this.items.get(id);
    if (!item) throw new LoopHostError(`Work item "${id}" was not found.`);
    if (item.status === 'LEASED' || item.status === 'DISPATCHED') {
      // An in-flight record is never re-leased here: active holders keep
      // exclusivity and expired holders go through reclaim/recover instead.
      throw new LeaseConflictError(
        `Work item "${id}" is already leased by ${item.leaseOwner ?? 'an unknown holder'}; use reclaim/recover, never a second lease.`,
      );
    }
    if (item.status !== 'QUEUED' && item.status !== 'SLEEPING') {
      throw new InvalidWorkTransitionError(`Work item "${id}" cannot be leased from status ${item.status}.`);
    }
    if (item.availableAt > now) {
      throw new InvalidWorkTransitionError(`Work item "${id}" is not yet eligible for dispatch.`);
    }
    if (item.leaseToken !== undefined && item.leaseExpiry !== undefined && item.leaseExpiry > now) {
      throw new LeaseConflictError(`Work item "${id}" is already leased until ${item.leaseExpiry}.`);
    }
    const token = randomUUID();
    const leased: HostedWorkItem = {
      ...copy(item),
      status: 'LEASED',
      leaseOwner: owner,
      leaseToken: token,
      leaseExpiry: now + Math.floor(ttlMs),
      updatedAt: now,
    };
    await this.items.put(leased);
    return { item: copy(leased), token };
  }

  private async requireLeaseHolder(id: string, token: string): Promise<HostedWorkItem> {
    const item = await this.items.get(id);
    if (!item) throw new LoopHostError(`Work item "${id}" was not found.`);
    if (!item.leaseToken || item.leaseToken !== token) {
      throw new StaleLeaseError(`Lease token for work item "${id}" is stale or unknown; the record was not modified.`);
    }
    return item;
  }

  /** Release a live lease back to QUEUED (operator path; never modifies terminal records). */
  async releaseLease(id: string, token: string, now: number): Promise<HostedWorkItem> {
    const item = await this.requireLeaseHolder(id, token);
    if (item.status !== 'LEASED') {
      throw new InvalidWorkTransitionError(`Work item "${id}" cannot be released from status ${item.status}.`);
    }
    const released: HostedWorkItem = {
      ...copy(item),
      status: 'QUEUED',
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiry: undefined,
      updatedAt: now,
    };
    await this.items.put(released);
    return copy(released);
  }

  /**
   * Reclaim an expired lease. Only safely reclaimable work (expired lease) is
   * touched; active leases throw instead of being stolen.
   */
  async reclaimExpired(id: string, now: number): Promise<HostedWorkItem> {
    const item = await this.items.get(id);
    if (!item) throw new LoopHostError(`Work item "${id}" was not found.`);
    if (item.status !== 'LEASED' && item.status !== 'DISPATCHED') {
      throw new InvalidWorkTransitionError(`Work item "${id}" holds no lease to reclaim (status ${item.status}).`);
    }
    if (item.leaseExpiry === undefined || item.leaseExpiry > now) {
      throw new LeaseConflictError(`Lease for work item "${id}" is still active; reclaim refused.`);
    }
    const reclaimed: HostedWorkItem = {
      ...copy(item),
      status: 'QUEUED',
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiry: undefined,
      lastError: `Lease expired at ${item.leaseExpiry}; reclaimed for safe redispatch.`,
      updatedAt: now,
    };
    await this.items.put(reclaimed);
    return copy(reclaimed);
  }

  /** Mark the leased record as handed to the unified loop (attempt counted). */
  async markDispatched(id: string, token: string, checkpointId: string, now: number): Promise<HostedWorkItem> {
    const item = await this.requireLeaseHolder(id, token);
    if (item.status !== 'LEASED') {
      throw new InvalidWorkTransitionError(`Work item "${id}" cannot be dispatched from status ${item.status}.`);
    }
    const dispatched: HostedWorkItem = {
      ...copy(item),
      status: 'DISPATCHED',
      attemptCount: item.attemptCount + 1,
      checkpointId,
      checkpointSequence: item.checkpointSequence + 1,
      updatedAt: now,
    };
    await this.items.put(dispatched);
    return copy(dispatched);
  }

  /**
   * Record the loop-reported terminal settlement. The host records the
   * outcome; it never grants verification. Idempotent for replayed delivery
   * of the same loop run.
   */
  async settleTerminal(id: string, token: string, settlement: WorkSettlement, checkpointId: string, now: number): Promise<HostedWorkItem> {
    const current = await this.items.get(id);
    if (!current) throw new LoopHostError(`Work item "${id}" was not found.`);
    if (current.status === 'COMPLETED' || current.status === 'HELD' || current.status === 'DENIED' || current.status === 'DLQ') {
      // Idempotent replay: the same loop run may be delivered twice (retry,
      // restart); the lease is already cleared, so the token is not required.
      if (current.loopId === settlement.loopId) return copy(current);
      throw new InvalidWorkTransitionError(`Work item "${id}" is already terminal; a different settlement was refused.`);
    }
    const item = await this.requireLeaseHolder(id, token);
    if (item.status !== 'DISPATCHED') {
      throw new InvalidWorkTransitionError(`Work item "${id}" cannot settle from status ${item.status}.`);
    }
    const settled: HostedWorkItem = {
      ...copy(item),
      status: settlement.status,
      loopId: settlement.loopId,
      loopOutcome: settlement.loopOutcome,
      checkpointId,
      checkpointSequence: item.checkpointSequence + 1,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiry: undefined,
      settledAt: now,
      updatedAt: now,
    };
    await this.items.put(settled);
    return copy(settled);
  }

  /**
   * Record a dispatch failure. Transient/timeout failures requeue with
   * bounded exponential backoff while attempts remain; anything else (or an
   * exhausted budget) moves the record to DLQ. Denials and holds never reach
   * this path — retry must never convert a denial into an authorization.
   */
  async recordFailure(
    id: string,
    token: string,
    failureClass: DispatchFailureClass,
    reason: string,
    now: number,
  ): Promise<HostedWorkItem> {
    const item = await this.requireLeaseHolder(id, token);
    if (item.status !== 'DISPATCHED' && item.status !== 'LEASED') {
      throw new InvalidWorkTransitionError(`Work item "${id}" cannot record failure from status ${item.status}.`);
    }
    if (failureClass === 'PERMANENT' || failureClass === 'CHECKPOINT_CORRUPT' || item.attemptCount >= item.maxAttempts) {
      const dead: HostedWorkItem = {
        ...copy(item),
        status: 'DLQ',
        dlqReason: reason,
        lastError: reason,
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiry: undefined,
        updatedAt: now,
      };
      await this.items.put(dead);
      return copy(dead);
    }
    const delay = computeBackoffMs(item.attemptCount, item.baseDelayMs, item.maxDelayMs);
    const requeued: HostedWorkItem = {
      ...copy(item),
      status: 'QUEUED',
      lastError: reason,
      availableAt: now + delay,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiry: undefined,
      updatedAt: now,
    };
    await this.items.put(requeued);
    return copy(requeued);
  }

  /** Park the record until `availableAt` (SLEEP_PENDING outcome path). */
  async parkSleeping(id: string, token: string, availableAt: number, loopId: string, now: number): Promise<HostedWorkItem> {
    const item = await this.requireLeaseHolder(id, token);
    if (item.status !== 'DISPATCHED') {
      throw new InvalidWorkTransitionError(`Work item "${id}" cannot sleep from status ${item.status}.`);
    }
    const sleeping: HostedWorkItem = {
      ...copy(item),
      status: 'SLEEPING',
      availableAt,
      loopId,
      loopOutcome: 'SLEEP_PENDING',
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiry: undefined,
      updatedAt: now,
    };
    await this.items.put(sleeping);
    return copy(sleeping);
  }

  /**
   * Explicit operator resume of a HELD or SLEEPING record. The next dispatch
   * re-runs the *whole* governed loop (policy/gates re-evaluated); nothing is
   * inherited. Terminal DENIED/COMPLETED/DLQ records are never resumable.
   */
  async resumeWork(actor: CommercialActor, id: string, now: number): Promise<HostedWorkItem> {
    assertActor(actor);
    const item = await this.items.get(id);
    if (!item) throw new LoopHostError(`Work item "${id}" was not found.`);
    assertCanAccess(actor, item.tenantId);
    if (item.status !== 'HELD' && item.status !== 'SLEEPING') {
      throw new InvalidWorkTransitionError(`Work item "${id}" cannot resume from status ${item.status}.`);
    }
    if (item.leaseToken !== undefined) {
      throw new LeaseConflictError(`Work item "${id}" is still leased; resume refused.`);
    }
    const resumed: HostedWorkItem = {
      ...copy(item),
      status: 'QUEUED',
      availableAt: now,
      lastError: undefined,
      updatedAt: now,
    };
    await this.items.put(resumed);
    return copy(resumed);
  }

  /** System quarantine for unrecoverable records (e.g. corrupt checkpoints). No token required. */
  async quarantine(id: string, reason: string, now: number): Promise<HostedWorkItem> {
    const item = await this.items.get(id);
    if (!item) throw new LoopHostError(`Work item "${id}" was not found.`);
    if (item.status === 'COMPLETED' || item.status === 'DENIED') {
      throw new InvalidWorkTransitionError(`Work item "${id}" is terminal and cannot be quarantined.`);
    }
    const dead: HostedWorkItem = {
      ...copy(item),
      status: 'DLQ',
      dlqReason: reason,
      lastError: reason,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiry: undefined,
      updatedAt: now,
    };
    await this.items.put(dead);
    return copy(dead);
  }
}
