// R2 — S-4/S-5/S-6/S-7 tx-scoped consumption operations.
//
// Every function here takes a TRANSACTION-BOUND collection handle (from
// `SecurityTxCollections`) and runs inside the caller's enforcement
// transaction — the durable decider composes them into one atomic scope.
// Nothing here opens its own transaction, caches across calls, or falls
// back to memory: a store failure throws, and the caller denies.

import { randomUUID } from 'node:crypto';
import { StorageModule, type ICollection } from '@jataqi/storage';
import { sha256Hex } from './canonical.js';
import { SECURITY_CAS_MAX_ATTEMPTS, SecurityStateError, SecurityStateUnavailableError } from './security-state-store.js';
import {
  AuthorizationDeniedError,
  type A01IdempotencyReceipt,
  type A01ImpactLevel,
} from './types.js';

/** S-5 lease TTL (crash-recovery bound; the holder heartbeats mid-flight). */
export const IDEMPOTENCY_LEASE_MS = 300_000;
/** S-5 heartbeat cadence while a claimed side effect runs. */
export const IDEMPOTENCY_HEARTBEAT_MS = 60_000;
/** Fallback rate window when no ACTIVE manifest resolves (deny path accounting). */
export const FALLBACK_RATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// S-4 consumed envelopes
// ---------------------------------------------------------------------------

/** S-4 row: `id = envelopeId → { decisionId, consumedAt, consumedBy }`. */
export interface ConsumedEnvelopeDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly decisionId: string;
  readonly consumedAt: number;
  readonly consumedBy: { readonly principalId: string; readonly runId: string };
  readonly createdAt: number;
  readonly updatedAt: number;
}

const ALLOWED_S4_FIELDS: ReadonlySet<string> = new Set([
  'id', 'tenantId', 'decisionId', 'consumedAt', 'consumedBy', 'createdAt', 'updatedAt',
]);

const FORBIDDEN_CONSUMPTION_FIELD_PATTERN = /(material|secret|token(?!registry)|password|privatekey)/i;

function assertConsumptionShape(doc: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) {
      throw new SecurityStateError(`${context}: unknown field "${key}" would be persisted (closed-schema violation, fail-closed).`);
    }
    if (FORBIDDEN_CONSUMPTION_FIELD_PATTERN.test(key)) {
      throw new SecurityStateError(`${context}: field "${key}" is material-shaped and must never be persisted (fail-closed).`);
    }
  }
}

/**
 * Consume a non-READ envelope exactly once (insert-if-absent in the
 * enforcement tx). Conflict ⇒ REPLAYED_AUTHORIZATION. READ envelopes are
 * never consumed (R1 parity) and return `{ consumed: false }`.
 */
export async function consumeEnvelope(
  consumed: ICollection<ConsumedEnvelopeDoc>,
  input: {
    readonly envelopeId: string;
    readonly decisionId: string;
    readonly tenantId: string;
    readonly principalId: string;
    readonly runId: string;
    readonly impact: A01ImpactLevel;
    readonly now: number;
  },
): Promise<{ consumed: boolean }> {
  if (input.impact === 'READ') return { consumed: false };
  if (typeof input.envelopeId !== 'string' || input.envelopeId.length === 0) {
    throw new SecurityStateError('consumeEnvelope requires an envelopeId (fail-closed).');
  }
  StorageModule.validateTenantId(input.tenantId);
  const doc: ConsumedEnvelopeDoc = {
    id: input.envelopeId,
    tenantId: input.tenantId,
    decisionId: input.decisionId,
    consumedAt: input.now,
    consumedBy: { principalId: input.principalId, runId: input.runId },
    createdAt: input.now,
    updatedAt: input.now,
  };
  assertConsumptionShape(doc as unknown as Record<string, unknown>, ALLOWED_S4_FIELDS, 'consumeEnvelope');
  const res = await consumed.cas(doc.id, (cur) => cur === undefined, () => ({ ...doc }));
  if (!res.ok) {
    throw new AuthorizationDeniedError(['REPLAYED_AUTHORIZATION'], 'this authorization was already consumed (exactly-once enforcement)');
  }
  return { consumed: true };
}

// ---------------------------------------------------------------------------
// S-5 idempotency ledger
// ---------------------------------------------------------------------------

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export interface IdempotencyResultRef {
  readonly decisionId: string;
  readonly envelopeId: string;
  readonly completedAt: number;
}

/** S-5 row: `id = {tenantId}::idem::{sha256(key)} → ledger entry`. */
export interface IdempotencyDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly key: string;
  readonly status: IdempotencyStatus;
  readonly resultRef?: IdempotencyResultRef;
  readonly leaseNonce?: string;
  readonly leaseExpiry?: number;
  readonly attempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const ALLOWED_S5_FIELDS: ReadonlySet<string> = new Set([
  'id', 'tenantId', 'key', 'status', 'resultRef', 'leaseNonce', 'leaseExpiry', 'attempts', 'createdAt', 'updatedAt',
]);

/** Deterministic S-5 id: tenant literal + hash-qualified key (opaque PK; never parsed). */
export function idempotencyId(tenantId: string, key: string): string {
  StorageModule.validateTenantId(tenantId);
  if (typeof key !== 'string' || key.length === 0) {
    throw new SecurityStateError('idempotency key must be a non-empty string (fail-closed).');
  }
  return `${tenantId}::idem::${sha256Hex(`v1:${tenantId}\0${key}`)}`;
}

export type IdempotencyClaim =
  | { readonly claimed: true; readonly leaseNonce: string; readonly reclaimed: boolean }
  | { readonly claimed: false; readonly receipt: A01IdempotencyReceipt };

/**
 * Claim an idempotency key (insert-if-absent IN_PROGRESS + lease) or
 * reclaim it (FAILED / EXPIRED / lease-expired IN_PROGRESS via
 * token-matching CAS that serializes concurrent reclaimers).
 *
 *   * COMPLETED ⇒ `{ claimed: false, receipt }` (caller rolls back its tx
 *     and returns the re-fetched receipt — never a cached object);
 *   * live IN_PROGRESS ⇒ IDEMPOTENCY_CONFLICT;
 *   * lost reclaim race ⇒ IDEMPOTENCY_CONFLICT.
 */
export async function claimIdempotency(
  idem: ICollection<IdempotencyDoc>,
  input: { readonly tenantId: string; readonly key: string; readonly now: number; readonly leaseMs?: number },
): Promise<IdempotencyClaim> {
  const leaseMs = input.leaseMs ?? IDEMPOTENCY_LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new SecurityStateError('idempotency leaseMs must be a positive integer (fail-closed).');
  }
  const id = idempotencyId(input.tenantId, input.key);
  const leaseNonce = randomUUID();
  const fresh: IdempotencyDoc = {
    id,
    tenantId: input.tenantId,
    key: input.key,
    status: 'IN_PROGRESS',
    leaseNonce,
    leaseExpiry: input.now + leaseMs,
    attempts: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  assertConsumptionShape(fresh as unknown as Record<string, unknown>, ALLOWED_S5_FIELDS, 'claimIdempotency');
  const inserted = await idem.cas(id, (cur) => cur === undefined, () => ({ ...fresh }));
  if (inserted.ok) return { claimed: true, leaseNonce, reclaimed: false };

  const current = await idem.get(id);
  if (!current) {
    throw new SecurityStateUnavailableError('idempotency claim lost a first-create race and the row vanished (fail-closed).');
  }
  if (current.tenantId !== input.tenantId) {
    throw new SecurityStateError('cross-tenant idempotency access refused (fail-closed).');
  }
  if (current.status === 'COMPLETED') {
    const ref = current.resultRef;
    if (!ref || typeof ref.decisionId !== 'string' || typeof ref.envelopeId !== 'string' || typeof ref.completedAt !== 'number') {
      throw new SecurityStateUnavailableError('COMPLETED idempotency row has a corrupt resultRef (fail-closed).');
    }
    return {
      claimed: false,
      receipt: { idempotentReplay: true, decisionId: ref.decisionId, envelopeId: ref.envelopeId, completedAt: ref.completedAt },
    };
  }
  if (current.status === 'IN_PROGRESS' && typeof current.leaseExpiry === 'number' && input.now < current.leaseExpiry) {
    throw new AuthorizationDeniedError(['IDEMPOTENCY_CONFLICT'], 'this idempotency key is already being executed (live lease)');
  }
  // FAILED, EXPIRED, or lease-expired IN_PROGRESS ⇒ token-matching CAS
  // reclaim. The observed token serializes concurrent reclaimers: exactly
  // one winner mints the new lease; losers conflict (fail closed).
  const observedToken = current.leaseNonce;
  const observedStatus = current.status;
  const newLeaseNonce = randomUUID();
  const reclaimed = await idem.cas(
    id,
    (cur) => !!cur && cur.status === observedStatus && cur.leaseNonce === observedToken &&
      (cur.status === 'FAILED' || cur.status === 'EXPIRED' ||
        (cur.status === 'IN_PROGRESS' && (typeof cur.leaseExpiry !== 'number' || input.now >= cur.leaseExpiry))),
    (cur) => ({
      ...cur,
      status: 'IN_PROGRESS' as const,
      resultRef: undefined,
      leaseNonce: newLeaseNonce,
      leaseExpiry: input.now + leaseMs,
      attempts: cur.attempts + 1,
      updatedAt: input.now,
    }),
  );
  if (!reclaimed.ok) {
    throw new AuthorizationDeniedError(['IDEMPOTENCY_CONFLICT'], 'lost a concurrent idempotency reclaim race (fail-closed)');
  }
  return { claimed: true, leaseNonce: newLeaseNonce, reclaimed: true };
}

/**
 * Complete a claimed key (Tx-2). The lease-token match proves the completer
 * still owns the key; a lost match means someone else reclaimed it, so
 * completing would clobber a live attempt ⇒ fail closed (no receipt; the
 * caller reports failure honestly).
 */
export async function completeIdempotency(
  idem: ICollection<IdempotencyDoc>,
  input: { readonly tenantId: string; readonly key: string; readonly leaseNonce: string; readonly resultRef: IdempotencyResultRef; readonly now: number },
): Promise<void> {
  const id = idempotencyId(input.tenantId, input.key);
  const res = await idem.cas(
    id,
    (cur) => !!cur && cur.tenantId === input.tenantId && cur.status === 'IN_PROGRESS' && cur.leaseNonce === input.leaseNonce,
    (cur) => ({ ...cur, status: 'COMPLETED' as const, resultRef: { ...input.resultRef }, updatedAt: input.now }),
  );
  if (!res.ok) {
    throw new SecurityStateUnavailableError(
      'idempotency completion lost key ownership (lease mismatch — the key was reclaimed; fail-closed, no receipt).',
    );
  }
}

/** Mark a claimed key FAILED (Tx-2 error path). Same ownership rule as completion. */
export async function failIdempotency(
  idem: ICollection<IdempotencyDoc>,
  input: { readonly tenantId: string; readonly key: string; readonly leaseNonce: string; readonly now: number },
): Promise<void> {
  const id = idempotencyId(input.tenantId, input.key);
  const res = await idem.cas(
    id,
    (cur) => !!cur && cur.tenantId === input.tenantId && cur.status === 'IN_PROGRESS' && cur.leaseNonce === input.leaseNonce,
    (cur) => ({ ...cur, status: 'FAILED' as const, resultRef: undefined, updatedAt: input.now }),
  );
  if (!res.ok) {
    throw new SecurityStateUnavailableError(
      'idempotency failure-marking lost key ownership (lease mismatch — the key was reclaimed; fail-closed).',
    );
  }
}

/**
 * Heartbeat a claimed key mid-flight (best-effort; returns false when the
 * key is no longer ours — the side effect still runs to completion, but no
 * receipt will be written for it).
 */
export async function extendIdempotencyLease(
  idem: ICollection<IdempotencyDoc>,
  input: { readonly tenantId: string; readonly key: string; readonly leaseNonce: string; readonly now: number; readonly leaseMs?: number },
): Promise<boolean> {
  const leaseMs = input.leaseMs ?? IDEMPOTENCY_LEASE_MS;
  const id = idempotencyId(input.tenantId, input.key);
  const res = await idem.cas(
    id,
    (cur) => !!cur && cur.tenantId === input.tenantId && cur.status === 'IN_PROGRESS' && cur.leaseNonce === input.leaseNonce,
    (cur) => ({ ...cur, leaseExpiry: input.now + leaseMs, updatedAt: input.now }),
  );
  return res.ok;
}

// ---------------------------------------------------------------------------
// S-6 fixed-window rate counters
// ---------------------------------------------------------------------------

/** S-6 row: `id = sha256("v1:" + tenant + NUL + principal + NUL + capability + NUL + windowStart)`. */
export interface RateWindowDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly capabilityId: string;
  readonly windowStart: number;
  readonly windowMs: number;
  readonly count: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const ALLOWED_S6_FIELDS: ReadonlySet<string> = new Set([
  'id', 'tenantId', 'principalId', 'capabilityId', 'windowStart', 'windowMs', 'count', 'createdAt', 'updatedAt',
]);

export function rateWindowId(tenantId: string, principalId: string, capabilityId: string, windowStart: number): string {
  StorageModule.validateTenantId(tenantId);
  if (typeof principalId !== 'string' || principalId.length === 0) {
    throw new SecurityStateError('rate window principalId must be non-empty (fail-closed).');
  }
  if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
    throw new SecurityStateError('rate window capabilityId must be non-empty (fail-closed).');
  }
  if (!Number.isInteger(windowStart) || windowStart < 0) {
    throw new SecurityStateError('rate windowStart must be a non-negative integer (fail-closed).');
  }
  return sha256Hex(`v1:${tenantId}\0${principalId}\0${capabilityId}\0${windowStart}`);
}

/**
 * Increment-then-check inside the decision transaction. Returns the
 * post-increment count; the PDP probe is fed `count - 1` (identical
 * semantics to R1: `usage >= max ⇒ RATE_LIMIT_EXCEEDED`). CAS convergence
 * loop (8 attempts); exhaustion ⇒ SECURITY_STATE_UNAVAILABLE (fail
 * closed — never assume zero usage).
 */
export async function incrementRateWindow(
  windows: ICollection<RateWindowDoc>,
  input: { readonly tenantId: string; readonly principalId: string; readonly capabilityId: string; readonly windowMs: number; readonly now: number },
): Promise<number> {
  if (!Number.isInteger(input.windowMs) || input.windowMs <= 0) {
    throw new SecurityStateError('rate windowMs must be a positive integer (fail-closed).');
  }
  const windowStart = Math.floor(input.now / input.windowMs) * input.windowMs;
  const id = rateWindowId(input.tenantId, input.principalId, input.capabilityId, windowStart);
  let lastCount = 0;
  for (let attempt = 1; attempt <= SECURITY_CAS_MAX_ATTEMPTS; attempt += 1) {
    const res = await windows.cas(
      id,
      () => true,
      (cur) => {
        if (cur === undefined) {
          const fresh: RateWindowDoc = {
            id,
            tenantId: input.tenantId,
            principalId: input.principalId,
            capabilityId: input.capabilityId,
            windowStart,
            windowMs: input.windowMs,
            count: 1,
            createdAt: input.now,
            updatedAt: input.now,
          };
          assertConsumptionShape(fresh as unknown as Record<string, unknown>, ALLOWED_S6_FIELDS, 'incrementRateWindow');
          lastCount = 1;
          return fresh;
        }
        if (cur.tenantId !== input.tenantId) {
          throw new SecurityStateError('cross-tenant rate-window access refused (fail-closed).');
        }
        lastCount = cur.count + 1;
        return { ...cur, count: cur.count + 1, updatedAt: input.now };
      },
    );
    if (res.ok) return lastCount;
  }
  throw new SecurityStateUnavailableError(
    `rate-window increment failed to converge after ${SECURITY_CAS_MAX_ATTEMPTS} attempts (fail-closed; never assume zero usage).`,
  );
}

// ---------------------------------------------------------------------------
// S-7 per-run budgets
// ---------------------------------------------------------------------------

/** S-7 row: `id = {tenantId}::{principalId}::{runId}`, ceiling pinned at first consume. */
export interface RunBudgetDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly ceiling: number;
  readonly manifestId: string;
  readonly used: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const ALLOWED_S7_FIELDS: ReadonlySet<string> = new Set([
  'id', 'tenantId', 'principalId', 'runId', 'capabilityId', 'ceiling', 'manifestId', 'used', 'createdAt', 'updatedAt',
]);

export function runBudgetId(tenantId: string, principalId: string, runId: string): string {
  StorageModule.validateTenantId(tenantId);
  if (typeof principalId !== 'string' || principalId.length === 0) {
    throw new SecurityStateError('run budget principalId must be non-empty (fail-closed).');
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new SecurityStateError('run budget runId must be non-empty (fail-closed).');
  }
  return `${tenantId}::${principalId}::${runId}`;
}

/**
 * CAS read-check-increment in the enforcement tx. The ceiling is pinned
 * from the ACTIVE manifest at first consume (stable across mid-run
 * rotations — the frozen semantic). `used + cost > ceiling ⇒
 * BUDGET_EXHAUSTED`. Convergence loop (8 attempts); exhaustion ⇒
 * SECURITY_STATE_UNAVAILABLE.
 */
export async function consumeBudget(
  budgets: ICollection<RunBudgetDoc>,
  input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly runId: string;
    readonly capabilityId: string;
    readonly cost: number;
    readonly ceiling: number;
    readonly manifestId: string;
    readonly now: number;
  },
): Promise<{ used: number; ceiling: number }> {
  if (typeof input.cost !== 'number' || !Number.isFinite(input.cost) || input.cost <= 0) {
    throw new SecurityStateError('budget cost must be a positive finite number (fail-closed).');
  }
  if (typeof input.ceiling !== 'number' || !Number.isFinite(input.ceiling) || input.ceiling <= 0) {
    throw new SecurityStateError('budget ceiling must be a positive finite number (fail-closed).');
  }
  const id = runBudgetId(input.tenantId, input.principalId, input.runId);
  const fresh: RunBudgetDoc = {
    id,
    tenantId: input.tenantId,
    principalId: input.principalId,
    runId: input.runId,
    capabilityId: input.capabilityId,
    ceiling: input.ceiling,
    manifestId: input.manifestId,
    used: input.cost,
    createdAt: input.now,
    updatedAt: input.now,
  };
  if (input.cost > input.ceiling) {
    throw new AuthorizationDeniedError(['BUDGET_EXHAUSTED'], 'invocation cost exceeds the run budget ceiling');
  }
  assertConsumptionShape(fresh as unknown as Record<string, unknown>, ALLOWED_S7_FIELDS, 'consumeBudget');
  const inserted = await budgets.cas(id, (cur) => cur === undefined, () => ({ ...fresh }));
  if (inserted.ok) return { used: input.cost, ceiling: input.ceiling };

  for (let attempt = 1; attempt <= SECURITY_CAS_MAX_ATTEMPTS; attempt += 1) {
    const current = await budgets.get(id);
    if (!current) {
      throw new SecurityStateUnavailableError('run budget row vanished mid-transaction (fail-closed).');
    }
    if (current.tenantId !== input.tenantId) {
      throw new SecurityStateError('cross-tenant run-budget access refused (fail-closed).');
    }
    if (current.used + input.cost > current.ceiling) {
      throw new AuthorizationDeniedError(['BUDGET_EXHAUSTED'], 'run budget would be exceeded');
    }
    const observedUsed = current.used;
    const res = await budgets.cas(
      id,
      (cur) => !!cur && cur.used === observedUsed && cur.used + input.cost <= cur.ceiling,
      (cur) => ({ ...cur, used: cur.used + input.cost, updatedAt: input.now }),
    );
    if (res.ok) return { used: observedUsed + input.cost, ceiling: current.ceiling };
  }
  throw new SecurityStateUnavailableError(
    `run-budget consume failed to converge after ${SECURITY_CAS_MAX_ATTEMPTS} attempts (fail-closed).`,
  );
}
