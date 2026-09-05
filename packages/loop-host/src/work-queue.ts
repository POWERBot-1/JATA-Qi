// Tenant-scoped durable work queue with lease ownership and bounded retries.
//
// Every guarded state transition runs as a single-document atomic
// compare-and-swap (`ICollection.cas`) so that it is concurrency-safe even
// across multiple workers/processes on a database-backed driver: the backend
// (PostgreSQL row lock for @jataqi/storage-postgres, per-document lock for the
// memory/filesystem drivers) serializes the read-guard-write of each
// transition. Ownership is proven by an unguessable lease token: only the
// holder that presents the current token may settle, release, renew, or fail
// the record. Expired leases may be reclaimed; active leases cannot be taken.

import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import type { AuthenticatedPrincipal } from '@jataqi/authentication';
import {
  AUTHORITY_HELD_REASONS,
  InvalidWorkTransitionError,
  LeaseConflictError,
  LoopHostError,
  PrincipalAuthorityError,
  StaleLeaseError,
  TenantIsolationError,
  type AuthorityHoldReason,
  type DispatchFailureClass,
  type EnqueueWorkInput,
  type HostedWorkItem,
  type HostedWorkStatus,
  type WorkSettlement,
} from './types.js';
import { assertActorDerivedFromPrincipal, freezePrincipalSnapshot } from './principal-snapshot.js';

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

/** Deterministic work-item id from tenant + idempotency key (concurrency-safe dedup). */
function deterministicIdFor(tenantId: string, key: string): string {
  return `work:${createHash('sha256').update(`tenant:${tenantId}\0key:${key}`).digest('hex').slice(0, 40)}`;
}

/**
 * T-02: authority-held records (pre-dispatch PRINCIPAL_* holds) can never
 * resume into execution through operator resume — their authority evidence
 * is absent, stale, or invalid, and resume must not launder that. The
 * operator path is a fresh authenticated enqueue of the work.
 */
function assertResumableHold(item: HostedWorkItem): void {
  if (item.heldReason !== undefined && AUTHORITY_HELD_REASONS.has(item.heldReason)) {
    throw new PrincipalAuthorityError(
      `Work item "${item.id}" is held for authority (${item.heldReason}); operator resume cannot release it — submit a fresh authenticated enqueue instead.`,
    );
  }
}

export class WorkQueue {
  private items!: ICollection<HostedWorkItem>;

  async init(kernel: KernelApi): Promise<void> {
    this.items = await kernel.getModule<StorageModule>('storage').collection<HostedWorkItem>(WORK_COLLECTION);
  }

  /**
   * Run one guarded state transition as a single atomic compare-and-swap.
   * Typed errors raised by `guard` propagate unchanged; a plain `false` from
   * `guard` (a lost concurrent race with no more specific condition) becomes a
   * LeaseConflictError and no write is applied.
   */
  private async transition(
    id: string,
    guard: (current: HostedWorkItem | undefined) => boolean,
    makeNext: (current: HostedWorkItem) => HostedWorkItem,
  ): Promise<HostedWorkItem> {
    const res = await this.items.cas(id, guard, makeNext);
    if (!res.ok) {
      throw new LeaseConflictError(
        `Work item "${id}" transition lost a concurrent race (state changed since read); no write was applied.`,
      );
    }
    return copy(res.doc as HostedWorkItem);
  }

  /** Reusable lease-holder precondition guard that throws StaleLeaseError. */
  private leaseHolderGuard(id: string, token: string): (cur: HostedWorkItem | undefined) => boolean {
    return (cur) => {
      if (!cur) throw new LoopHostError(`Work item "${id}" was not found.`);
      if (!cur.leaseToken || cur.leaseToken !== token) {
        throw new StaleLeaseError(`Lease token for work item "${id}" is stale or unknown; the record was not modified.`);
      }
      return true;
    };
  }

  /**
   * T-02 authenticated enqueue. The caller MUST present an authenticated
   * principal (T-01 boundary); the actor MUST be derivable from it (same
   * id/tenant, narrowed-or-equal roles). The queue embeds an immutable
   * principal snapshot on the record — dispatch executes under that
   * snapshot, never under a caller-supplied actor. Unsigned, malformed,
   * or mismatched authority fails closed here, before any write.
   *
   * Idempotent: the same tenant + idempotency key returns the existing
   * record unchanged (first-writer-wins: a re-enqueue presents its own
   * principal for validation but can never override persisted authority).
   *
   * The queue enforces STRUCTURAL authority (presence/shape/derivation).
   * Clock policy (freshness horizon, test-method admission) is enforced
   * by the service layer, which owns configuration.
   */
  async enqueue(
    actor: CommercialActor,
    input: EnqueueWorkInput,
    principal: AuthenticatedPrincipal,
    now?: number,
  ): Promise<HostedWorkItem> {
    assertActor(actor);
    if (!input.task || !input.task.objective.trim()) throw new LoopHostError('A loop task objective is required.');
    if (!principal || typeof principal !== 'object') {
      throw new PrincipalAuthorityError('Authenticated enqueue requires an authenticated principal (fail-closed).');
    }
    // Validate (and freeze) before any storage access: unsigned callers
    // learn nothing, and no orphaned or half-authorized record can form.
    const snapshot = freezePrincipalSnapshot(principal);
    assertActorDerivedFromPrincipal(actor, principal);
    const at = now ?? Date.now();
    const callerKey = input.idempotencyKey?.trim();
    const key = callerKey ? callerKey : `work:${randomUUID()}`;

    // Back-compatible idempotency: if a record already exists for this
    // tenant+key (created earlier under any id), return it unchanged.
    if (callerKey) {
      const existing = (
        await this.items.query({
          where: (item) => item.tenantId === actor.tenantId && item.idempotencyKey === callerKey,
          limit: 1,
        })
      )[0];
      if (existing) return copy(existing);
    }

    // Concurrency-safe create. A caller-supplied idempotency key maps to a
    // deterministic id so that two concurrent enqueues of the same key can
    // never produce two distinct records — the compare-and-swap is insert-if-
    // absent and the loser returns the winner's record.
    const id = callerKey ? deterministicIdFor(actor.tenantId, callerKey) : randomUUID();
    const item: HostedWorkItem = {
      id,
      tenantId: actor.tenantId,
      correlationId: input.correlationId?.trim() ? input.correlationId.trim() : `host:${randomUUID()}`,
      idempotencyKey: key,
      task: copy(input.task),
      actor: { id: actor.id, tenantId: actor.tenantId, roles: [...actor.roles] },
      principal: copy(snapshot),
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
    const res = await this.items.cas(id, (cur) => cur === undefined, () => item);
    if (res.ok) return copy(res.doc as HostedWorkItem);
    // A concurrent enqueue won with the same deterministic id — return its
    // record (idempotent) rather than creating a duplicate.
    return copy(res.doc as HostedWorkItem);
  }

  /**
   * Renew a live lease (same holder only). Fails closed for any stale holder.
   * Not wired into the current fixed-TTL host flow but available for bounded
   * long-running dispatches and exercised by tests.
   */
  async renewLease(id: string, token: string, ttlMs: number, now: number): Promise<HostedWorkItem> {
    if (!token.trim()) throw new LoopHostError('A lease token is required to renew.');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 3_600_000) throw new LoopHostError('Lease TTL must be between 1 and 3600000 ms.');
    const res = await this.items.cas(
      id,
      (cur) => {
        if (!cur) throw new LoopHostError(`Work item "${id}" was not found.`);
        if (!cur.leaseToken || cur.leaseToken !== token) {
          throw new StaleLeaseError(`Work item "${id}" is not held by the presented lease token; renewal refused (no write applied).`);
        }
        if (cur.status !== 'LEASED' && cur.status !== 'DISPATCHED') {
          throw new InvalidWorkTransitionError(`Work item "${id}" cannot renew from status ${cur.status}.`);
        }
        return true;
      },
      (cur) => ({ ...copy(cur), leaseExpiry: now + Math.floor(ttlMs), updatedAt: now }),
    );
    if (!res.ok) throw new LeaseConflictError(`Work item "${id}" lease renewal lost a concurrent race; no write applied.`);
    return copy(res.doc as HostedWorkItem);
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
    const token = randomUUID();
    const leased = await this.transition(
      id,
      (cur) => {
        if (!cur) throw new LoopHostError(`Work item "${id}" was not found.`);
        if (cur.status === 'LEASED' || cur.status === 'DISPATCHED') {
          throw new LeaseConflictError(
            `Work item "${id}" is already leased by ${cur.leaseOwner ?? 'an unknown holder'}; use reclaim/recover, never a second lease.`,
          );
        }
        if (cur.status !== 'QUEUED' && cur.status !== 'SLEEPING') {
          throw new InvalidWorkTransitionError(`Work item "${id}" cannot be leased from status ${cur.status}.`);
        }
        if (cur.availableAt > now) {
          throw new InvalidWorkTransitionError(`Work item "${id}" is not yet eligible for dispatch.`);
        }
        if (cur.leaseToken !== undefined && cur.leaseExpiry !== undefined && cur.leaseExpiry > now) {
          throw new LeaseConflictError(`Work item "${id}" is already leased until ${cur.leaseExpiry}.`);
        }
        return true;
      },
      (cur) => ({
        ...cur,
        status: 'LEASED',
        leaseOwner: owner,
        leaseToken: token,
        leaseExpiry: now + Math.floor(ttlMs),
        updatedAt: now,
      }),
    );
    return { item: copy(leased), token };
  }

  /** Release a live lease back to QUEUED (operator path; never modifies terminal records). */
  async releaseLease(id: string, token: string, now: number): Promise<HostedWorkItem> {
    const holder = this.leaseHolderGuard(id, token);
    const released = await this.transition(
      id,
      (cur) => {
        holder(cur);
        if (cur!.status !== 'LEASED') {
          throw new InvalidWorkTransitionError(`Work item "${id}" cannot be released from status ${cur!.status}.`);
        }
        return true;
      },
      (cur) => ({
        ...cur,
        status: 'QUEUED',
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiry: undefined,
        updatedAt: now,
      }),
    );
    return copy(released);
  }

  /**
   * Reclaim an expired lease. Only safely reclaimable work (expired lease) is
   * touched; active leases throw instead of being stolen.
   */
  async reclaimExpired(id: string, now: number): Promise<HostedWorkItem> {
    const reclaimed = await this.transition(
      id,
      (cur) => {
        if (!cur) throw new LoopHostError(`Work item "${id}" was not found.`);
        if (cur.status !== 'LEASED' && cur.status !== 'DISPATCHED') {
          throw new InvalidWorkTransitionError(`Work item "${id}" holds no lease to reclaim (status ${cur.status}).`);
        }
        if (cur.leaseExpiry === undefined || cur.leaseExpiry > now) {
          throw new LeaseConflictError(`Lease for work item "${id}" is still active; reclaim refused.`);
        }
        return true;
      },
      (cur) => ({
        ...cur,
        status: 'QUEUED',
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiry: undefined,
        lastError: `Lease expired at ${cur.leaseExpiry}; reclaimed for safe redispatch.`,
        updatedAt: now,
      }),
    );
    return copy(reclaimed);
  }

  /** Mark the leased record as handed to the unified loop (attempt counted). */
  async markDispatched(id: string, token: string, checkpointId: string, now: number): Promise<HostedWorkItem> {
    const holder = this.leaseHolderGuard(id, token);
    const dispatched = await this.transition(
      id,
      (cur) => {
        holder(cur);
        if (cur!.status !== 'LEASED') {
          throw new InvalidWorkTransitionError(`Work item "${id}" cannot be dispatched from status ${cur!.status}.`);
        }
        return true;
      },
      (cur) => ({
        ...cur,
        status: 'DISPATCHED',
        attemptCount: cur.attemptCount + 1,
        checkpointId,
        checkpointSequence: cur.checkpointSequence + 1,
        updatedAt: now,
      }),
    );
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
    const holder = this.leaseHolderGuard(id, token);
    const settled = await this.transition(
      id,
      (cur) => {
        holder(cur);
        if (cur!.status !== 'DISPATCHED') {
          throw new InvalidWorkTransitionError(`Work item "${id}" cannot settle from status ${cur!.status}.`);
        }
        return true;
      },
      (cur) => ({
        ...cur,
        status: settlement.status,
        loopId: settlement.loopId,
        loopOutcome: settlement.loopOutcome,
        checkpointId,
        checkpointSequence: cur.checkpointSequence + 1,
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiry: undefined,
        settledAt: now,
        updatedAt: now,
      }),
    );
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
    const holder = this.leaseHolderGuard(id, token);
    const failed = await this.transition(
      id,
      (cur) => {
        holder(cur);
        if (cur!.status !== 'DISPATCHED' && cur!.status !== 'LEASED') {
          throw new InvalidWorkTransitionError(`Work item "${id}" cannot record failure from status ${cur!.status}.`);
        }
        return true;
      },
      (cur) => {
        if (failureClass === 'PERMANENT' || failureClass === 'CHECKPOINT_CORRUPT' || cur.attemptCount >= cur.maxAttempts) {
          return {
            ...cur,
            status: 'DLQ',
            dlqReason: reason,
            lastError: reason,
            leaseOwner: undefined,
            leaseToken: undefined,
            leaseExpiry: undefined,
            updatedAt: now,
          } as HostedWorkItem;
        }
        const delay = computeBackoffMs(cur.attemptCount, cur.baseDelayMs, cur.maxDelayMs);
        return {
          ...cur,
          status: 'QUEUED',
          lastError: reason,
          availableAt: now + delay,
          leaseOwner: undefined,
          leaseToken: undefined,
          leaseExpiry: undefined,
          updatedAt: now,
        } as HostedWorkItem;
      },
    );
    return copy(failed);
  }

  /**
   * T-02 authority hold: quarantine a leased record that failed
   * pre-dispatch authority validation. Requires the live lease token
   * (ownership boundary); consumes no attempt (no dispatch occurred);
   * records the deterministic hold reason for operators and audit.
   * Authority-held records resume ONLY via fresh authenticated enqueue —
   * operator resume refuses them (see `resumeWork`).
   */
  async holdForAuthority(
    id: string,
    token: string,
    reason: AuthorityHoldReason,
    detail: string,
    now: number,
  ): Promise<HostedWorkItem> {
    if (!token.trim()) throw new LoopHostError('A lease token is required to hold.');
    if (!detail.trim()) throw new LoopHostError('An authority-hold detail is required.');
    const holder = this.leaseHolderGuard(id, token);
    const held = await this.transition(
      id,
      (cur) => {
        holder(cur);
        if (cur!.status !== 'LEASED') {
          throw new InvalidWorkTransitionError(`Work item "${id}" cannot be authority-held from status ${cur!.status}.`);
        }
        return true;
      },
      (cur) => ({
        ...cur,
        status: 'HELD',
        heldReason: reason,
        lastError: detail,
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiry: undefined,
        updatedAt: now,
      }),
    );
    return copy(held);
  }

  /** Park the record until `availableAt` (SLEEP_PENDING outcome path). */
  async parkSleeping(id: string, token: string, availableAt: number, loopId: string, now: number): Promise<HostedWorkItem> {
    const holder = this.leaseHolderGuard(id, token);
    const sleeping = await this.transition(
      id,
      (cur) => {
        holder(cur);
        if (cur!.status !== 'DISPATCHED') {
          throw new InvalidWorkTransitionError(`Work item "${id}" cannot sleep from status ${cur!.status}.`);
        }
        return true;
      },
      (cur) => ({
        ...cur,
        status: 'SLEEPING',
        availableAt,
        loopId,
        loopOutcome: 'SLEEP_PENDING',
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiry: undefined,
        updatedAt: now,
      }),
    );
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
    assertResumableHold(item);
    const resumed = await this.transition(
      id,
      (cur) => {
        if (!cur) throw new LoopHostError(`Work item "${id}" was not found.`);
        assertCanAccess(actor, cur.tenantId);
        assertResumableHold(cur);
        if (cur.status !== 'HELD' && cur.status !== 'SLEEPING') {
          throw new InvalidWorkTransitionError(`Work item "${id}" cannot resume from status ${cur.status}.`);
        }
        if (cur.leaseToken !== undefined) {
          throw new LeaseConflictError(`Work item "${id}" is still leased; resume refused.`);
        }
        return true;
      },
      (cur) => ({
        ...cur,
        status: 'QUEUED',
        availableAt: now,
        lastError: undefined,
        updatedAt: now,
      }),
    );
    return copy(resumed);
  }

  /** System quarantine for unrecoverable records (e.g. corrupt checkpoints). No token required. */
  async quarantine(id: string, reason: string, now: number): Promise<HostedWorkItem> {
    const dead = await this.transition(
      id,
      (cur) => {
        if (!cur) throw new LoopHostError(`Work item "${id}" was not found.`);
        if (cur.status === 'COMPLETED' || cur.status === 'DENIED') {
          throw new InvalidWorkTransitionError(`Work item "${id}" is terminal and cannot be quarantined.`);
        }
        return true;
      },
      (cur) => ({
        ...cur,
        status: 'DLQ',
        dlqReason: reason,
        lastError: reason,
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiry: undefined,
        updatedAt: now,
      }),
    );
    return copy(dead);
  }
}
