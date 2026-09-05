// F-01 unified durable outbox.
//
// One record type, one publisher API, one replay API for the unified event
// surface. Every record carries the full `EventEnvelope` snapshot, a
// per-tenant CAS-assigned sequence (T-01-I pattern), and a versioned hash
// chain link (`hashVersion: 1`, canonicalized with the shared F-01
// canonicalizer — historical ledger/audit chains keep their own formats and
// verifiers; see dual-verification note in `event-envelope.ts`).
//
// Delivery honesty (constraint 20): this outbox provides AT-LEAST-ONCE
// durable persistence plus IDEMPOTENT processing (deterministic record ids,
// insert-if-absent election, tenant-guarded ack). It does NOT claim
// transport-level exactly-once delivery. Duplicate publishes of the same
// (tenant, channel, eventId) yield one record; duplicate deliveries must be
// deduplicated by consumers via the envelope id / idempotency key.
//
// Sequence honesty: sequences are UNIQUE and ORDERED per tenant. Strict
// contiguity (1..N with no gaps) is NOT guaranteed: when two publishers race
// to publish the same event, the loser discards its reserved sequence rather
// than delivering twice. Integrity verification therefore checks uniqueness,
// ordering, linkage, and hash recomputation — never gap-freedom.
//
// T-05 canonical delivery: this outbox is the ONE authoritative publication
// for the durable delivery worker. Records carry a durable lease
// (owner/token/generation/expiry) claimed by a storage-level CAS, and every
// finalising transition (`ackLeased`, `scheduleRetry`, `deadLetterLeased`,
// `quarantineLeased`, `release`) is a CAS fenced on BOTH the lease token and
// the lease generation inside the same row-locked statement as the write —
// a stale owner (lease expired and re-claimed elsewhere) cannot ack or
// finalise. Lease and delivery fields are outside the hash core.

import { createHash, randomUUID } from 'node:crypto';
import {
  CANONICAL_HASH_VERSION,
  canonicalJson,
  isEventEnvelope,
  sha256Hex,
  type EventEnvelope,
} from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor } from './types.js';

/**
 * Record lifecycle. `LEASED` = claimed by a delivery worker (lease live or
 * expired); `RETRYING` = released with a future `nextAttemptAt`. Terminal:
 * `DELIVERED`, `DEAD_LETTER`, `QUARANTINED`.
 */
export type UnifiedOutboxState = 'PENDING' | 'LEASED' | 'RETRYING' | 'DELIVERED' | 'DEAD_LETTER' | 'QUARANTINED';

/** Terminal states are never re-claimed. */
export const UNIFIED_OUTBOX_TERMINAL_STATES: ReadonlySet<UnifiedOutboxState> = new Set(['DELIVERED', 'DEAD_LETTER', 'QUARANTINED']);

/** One durable unified-outbox record. */
export interface UnifiedOutboxRecord {
  /** Deterministic id: `outbox:<sha256(tenant,channel,eventId)>`. */
  id: string;
  tenantId: string;
  /** Logical channel. Defaults to the envelope event type. */
  channel: string;
  /** Stable event id (the envelope id). */
  eventId: string;
  eventType: string;
  eventVersion: number;
  schemaVersion: number;
  /** Per-tenant unique ordered sequence (CAS-assigned, gaps possible, see above). */
  sequence: number;
  /** Hash-chain link to the actual predecessor record. */
  previousHash: string;
  /** v1 hash over the record core. */
  hash: string;
  /** Hash-scheme version (always CANONICAL_HASH_VERSION for new records). */
  hashVersion: number;
  /** Full envelope snapshot (the replayable payload). */
  envelope: EventEnvelope;
  correlationId: string;
  causationId?: string;
  state: UnifiedOutboxState;
  /** Number of delivery claims issued for this record (counted at claim). */
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  lastError?: string;
  /** T-05 durable lease: process-independent ownership of one delivery attempt. */
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiry?: number;
  /** Monotonic claim counter; part of the fence together with `leaseToken`. Absent on pre-T-05 rows (= 0). */
  leaseGeneration?: number;
  /** Earliest time the record may be (re-)claimed; absent = immediately. */
  nextAttemptAt?: number;
  claimedAt?: number;
}

/**
 * Fence handed to the worker that won a claim. Every finalising transition
 * must present it; the transition is applied only when the durable record
 * still carries the same token AND generation.
 */
export interface UnifiedOutboxLease {
  recordId: string;
  tenantId: string;
  eventId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseGeneration: number;
  leaseExpiry: number;
  attemptCount: number;
}

export interface ClaimUnifiedOutboxOptions {
  /** Stable worker identity (host id / pid) recorded as `leaseOwner`. */
  owner: string;
  now: number;
  /** Lease TTL in ms; expiry makes the record eligible for re-claim by any worker. */
  leaseTtlMs: number;
  /** Bounded batch size (1..100). */
  limit: number;
  /** Restrict to one tenant (a tenant-scoped worker); undefined = all tenants (system worker only). */
  tenantId?: string;
  /** Restrict to event types the worker can deliver; undefined = any type. */
  eventTypes?: readonly string[];
  afterSequence?: number;
}

export interface ClaimedUnifiedOutboxRecord {
  record: UnifiedOutboxRecord;
  lease: UnifiedOutboxLease;
}

/** Bindable collection source (a `StorageWriteScope` or a `StorageModule`). */
export interface UnifiedOutboxCollectionSource {
  collection<T extends { id: string }>(name: string): Promise<ICollection<T>>;
}

/** Per-tenant atomic sequence counter document. */
export interface UnifiedOutboxCounter {
  id: string;
  tenantId: string;
  sequence: number;
}

export interface PublishUnifiedOutboxOptions {
  channel?: string;
  now?: number;
}

export interface ReplayUnifiedOutboxOptions {
  afterSequence?: number;
  eventTypes?: string[];
  channel?: string;
  states?: UnifiedOutboxState[];
  limit?: number;
}

export interface UnifiedOutboxIntegrity {
  tenantId: string;
  valid: boolean;
  entries: number;
  brokenAt?: number;
  reason?: string;
}

export class UnifiedOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiedOutboxError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const UNIFIED_OUTBOX_COLLECTION = 'commercial-control.unified-outbox';
export const UNIFIED_OUTBOX_COUNTER_COLLECTION = 'commercial-control.unified-outbox-seq';

/**
 * Minimal per-tenant async mutex (promise-chain). Serializes a tenant's
 * check-then-act critical sections within this process: idempotency
 * check-then-put, counter create-then-advance, and outbox linkage.
 * Cross-process atomicity still rests on the storage driver's row-lock CAS.
 * Residual shared-driver create-race (two processes first-creating the same
 * absent counter row, where `SELECT ... FOR UPDATE` locks nothing) is
 * documented on `nextSequence`, not hidden — once the row exists, row-lock
 * CAS advances it atomically across processes.
 */
export function createTenantMutex(): {
  runExclusive<T>(tenantId: string, task: () => Promise<T>): Promise<T>;
  /** Acquire the tenant lock explicitly; the returned function releases it exactly once. */
  acquire(tenantId: string): Promise<() => void>;
} {
  const tails = new Map<string, Promise<unknown>>();
  const acquire = async (tenantId: string): Promise<() => void> => {
    const previous = tails.get(tenantId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    tails.set(tenantId, tail);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (tails.get(tenantId) === tail) tails.delete(tenantId);
      release();
    };
  };
  return {
    acquire,
    async runExclusive<T>(tenantId: string, task: () => Promise<T>): Promise<T> {
      const release = await acquire(tenantId);
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * Unified outbox over caller-provided collections. The owning service opens
 * the collections (so this class stays storage-agnostic) and enforces the
 * tenant boundary before delegating.
 */
export class UnifiedOutbox {
  constructor(
    private readonly records: ICollection<UnifiedOutboxRecord>,
    private readonly counters: ICollection<UnifiedOutboxCounter>,
  ) {}

  /**
   * T-05: bind an outbox to a collection source. Passing a `StorageWriteScope`
   * makes `publish` participate in the caller's transaction (state mutation +
   * event + outbox record commit or roll back together).
   */
  static async open(source: UnifiedOutboxCollectionSource): Promise<UnifiedOutbox> {
    return new UnifiedOutbox(
      await source.collection<UnifiedOutboxRecord>(UNIFIED_OUTBOX_COLLECTION),
      await source.collection<UnifiedOutboxCounter>(UNIFIED_OUTBOX_COUNTER_COLLECTION),
    );
  }

  /**
   * Durably publish an envelope. Idempotent: republishing the same
   * (tenant, channel, eventId) returns the existing record without
   * duplicating it. Fails closed on malformed envelopes.
   */
  async publish(envelope: EventEnvelope, options: PublishUnifiedOutboxOptions = {}): Promise<UnifiedOutboxRecord> {
    if (!isEventEnvelope(envelope)) {
      throw new UnifiedOutboxError('Unified outbox publish requires a valid EventEnvelope (fail-closed).');
    }
    const now = options.now ?? Date.now();
    const tenantId = envelope.tenantId;
    assertTenant(tenantId);
    const channel = options.channel?.trim() ? options.channel.trim() : envelope.eventType;
    const id = `outbox:${computeOutboxKey(tenantId, channel, envelope.id)}`;
    const existing = await this.records.get(id);
    if (existing) return copy(existing);

    const sequence = await this.nextSequence(tenantId);
    const previousHash = await this.predecessorHash(tenantId, sequence);
    const draft: Omit<UnifiedOutboxRecord, 'hash'> = {
      id,
      tenantId,
      channel,
      eventId: envelope.id,
      eventType: envelope.eventType,
      eventVersion: envelope.eventVersion,
      schemaVersion: envelope.schemaVersion,
      sequence,
      previousHash,
      hashVersion: CANONICAL_HASH_VERSION,
      envelope: copy(envelope),
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      state: 'PENDING',
      attemptCount: 0,
      leaseGeneration: 0,
      createdAt: now,
      updatedAt: now,
    };
    const record: UnifiedOutboxRecord = { ...draft, hash: hashOutboxRecord({ ...draft, hash: '' }) };
    // Insert-if-absent election: a duplicate-publish loser discards its
    // reserved sequence (documented gap) rather than delivering twice.
    const res = await this.records.cas(id, (current) => current === undefined, () => record);
    if (res.ok) return copy(record);
    const current = await this.records.get(id);
    if (!current) throw new UnifiedOutboxError('Unified outbox election lost and no record found (fail-closed).');
    return copy(current);
  }

  /** Tenant-scoped ordered replay. `tenantId` must be the caller's own tenant. */
  async replay(tenantId: string, options: ReplayUnifiedOutboxOptions = {}): Promise<UnifiedOutboxRecord[]> {
    assertTenant(tenantId);
    const records = await this.records.query({
      where: (record) =>
        record.tenantId === tenantId &&
        (options.afterSequence === undefined || record.sequence > options.afterSequence) &&
        (options.eventTypes === undefined || options.eventTypes.includes(record.eventType)) &&
        (options.channel === undefined || record.channel === options.channel) &&
        (options.states === undefined || options.states.includes(record.state)),
      orderBy: 'sequence',
      order: 'asc',
      limit: options.limit,
    });
    return records.map(copy);
  }

  /**
   * Tenant-guarded administrative ack: marks DELIVERED. Returns false on
   * missing/foreign records. T-05: refused (false) once any worker has
   * claimed the record — from then on only the fenced `ackLeased` applies,
   * so an unfenced path can never overwrite a live owner's outcome.
   */
  async ack(tenantId: string, id: string, now = Date.now()): Promise<boolean> {
    const res = await this.records.cas(
      id,
      (current) => current !== undefined && current.tenantId === tenantId && (current.state === 'DELIVERED' || generationOf(current) === 0),
      (current) => (current.state === 'DELIVERED' ? current : { ...current, state: 'DELIVERED', deliveredAt: now, updatedAt: now, leaseOwner: undefined, leaseToken: undefined, leaseExpiry: undefined, nextAttemptAt: undefined }),
    );
    // Rehash is NOT needed: hash covers the immutable core only (see hashOutboxRecord).
    return res.ok;
  }

  /** Administrative dead-letter (unclaimed records only; see `ack`). Never deletes evidence. */
  async markDeadLetter(tenantId: string, id: string, error: string, now = Date.now()): Promise<boolean> {
    const res = await this.records.cas(
      id,
      (current) => current !== undefined && current.tenantId === tenantId && generationOf(current) === 0,
      (current) => ({ ...current, state: 'DEAD_LETTER', lastError: error, attemptCount: current.attemptCount + 1, updatedAt: now, nextAttemptAt: undefined }),
    );
    return res.ok;
  }

  /**
   * Administrative quarantine of a corrupt record (unclaimed records only;
   * see `ack`). Quarantined records stay replayable for forensics but are
   * excluded from default PENDING replays; they are never auto-redelivered.
   */
  async quarantine(tenantId: string, id: string, reason: string, now = Date.now()): Promise<boolean> {
    const res = await this.records.cas(
      id,
      (current) => current !== undefined && current.tenantId === tenantId && generationOf(current) === 0,
      (current) => ({ ...current, state: 'QUARANTINED', lastError: reason, updatedAt: now, nextAttemptAt: undefined }),
    );
    return res.ok;
  }

  /**
   * T-05 durable claim. Reads a bounded batch of claimable records
   * (PENDING/RETRYING due now, or LEASED with an expired lease) and tries to
   * win each one with a storage-level CAS whose guard re-evaluates
   * claimability under the row lock. Two workers in two processes can never
   * both win the same record. Each win increments `attemptCount` and
   * `leaseGeneration` and issues a fresh random token.
   *
   * Bounded: at most `limit` records are returned; the scan itself is bounded
   * in results (`limit`), not in rows read on the current PostgreSQL driver
   * (documented follow-on).
   */
  async claim(options: ClaimUnifiedOutboxOptions): Promise<ClaimedUnifiedOutboxRecord[]> {
    if (!options.owner.trim()) throw new UnifiedOutboxError('Outbox claim requires a worker owner id (fail-closed).');
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new UnifiedOutboxError('Outbox claim limit must be an integer from 1 to 100.');
    if (!Number.isFinite(options.leaseTtlMs) || options.leaseTtlMs < 1) throw new UnifiedOutboxError('Outbox claim lease TTL must be positive.');
    if (options.tenantId !== undefined) assertTenant(options.tenantId);
    const now = options.now;
    const types = options.eventTypes ? new Set(options.eventTypes) : undefined;
    const candidates = await this.records.query({
      where: (record) =>
        (options.tenantId === undefined || record.tenantId === options.tenantId) &&
        (types === undefined || types.has(record.eventType)) &&
        (options.afterSequence === undefined || record.sequence > options.afterSequence) &&
        isClaimable(record, now),
      orderBy: options.tenantId === undefined ? 'createdAt' : 'sequence',
      order: 'asc',
      limit: options.limit,
    });
    const claimed: ClaimedUnifiedOutboxRecord[] = [];
    for (const candidate of candidates) {
      const token = randomUUID();
      const res = await this.records.cas(
        candidate.id,
        (current) => current !== undefined && current.tenantId === candidate.tenantId && isClaimable(current, now),
        (current) => ({
          ...current,
          state: 'LEASED',
          leaseOwner: options.owner,
          leaseToken: token,
          leaseGeneration: generationOf(current) + 1,
          leaseExpiry: now + options.leaseTtlMs,
          attemptCount: current.attemptCount + 1,
          claimedAt: now,
          nextAttemptAt: undefined,
          updatedAt: now,
        }),
      );
      if (!res.ok || !res.doc) continue; // lost to another worker/process — no write happened
      const record = res.doc;
      claimed.push({
        record: copy(record),
        lease: {
          recordId: record.id,
          tenantId: record.tenantId,
          eventId: record.eventId,
          leaseOwner: options.owner,
          leaseToken: token,
          leaseGeneration: generationOf(record),
          leaseExpiry: now + options.leaseTtlMs,
          attemptCount: record.attemptCount,
        },
      });
    }
    return claimed;
  }

  /** Fenced ack: DELIVERED only if the record still carries this lease (token + generation). */
  async ackLeased(lease: UnifiedOutboxLease, now: number): Promise<boolean> {
    return this.fenced(lease, (current) => ({ ...current, state: 'DELIVERED', deliveredAt: now, lastError: undefined, nextAttemptAt: undefined, updatedAt: now, ...clearedLease() }));
  }

  /** Fenced retry: RETRYING with a bounded `nextAttemptAt`; the lease is released for the next claim. */
  async scheduleRetry(lease: UnifiedOutboxLease, error: string, nextAttemptAt: number, now: number): Promise<boolean> {
    if (!Number.isFinite(nextAttemptAt)) throw new UnifiedOutboxError('Retry requires a finite nextAttemptAt.');
    return this.fenced(lease, (current) => ({ ...current, state: 'RETRYING', lastError: error, nextAttemptAt, updatedAt: now, ...clearedLease() }));
  }

  /** Fenced terminal failure. Evidence is kept; the record is never re-claimed. */
  async deadLetterLeased(lease: UnifiedOutboxLease, error: string, now: number): Promise<boolean> {
    return this.fenced(lease, (current) => ({ ...current, state: 'DEAD_LETTER', lastError: error, nextAttemptAt: undefined, updatedAt: now, ...clearedLease() }));
  }

  /** Fenced quarantine (poison / corrupt / schema-rejected). Never auto-redelivered. */
  async quarantineLeased(lease: UnifiedOutboxLease, reason: string, now: number): Promise<boolean> {
    return this.fenced(lease, (current) => ({ ...current, state: 'QUARANTINED', lastError: reason, nextAttemptAt: undefined, updatedAt: now, ...clearedLease() }));
  }

  /**
   * Fenced release of a claim that made NO delivery attempt (graceful stop
   * mid-batch). The record returns to PENDING immediately and the claim is
   * not counted as an attempt.
   */
  async release(lease: UnifiedOutboxLease, now: number): Promise<boolean> {
    return this.fenced(lease, (current) => ({ ...current, state: 'PENDING', attemptCount: Math.max(0, current.attemptCount - 1), nextAttemptAt: undefined, updatedAt: now, ...clearedLease() }));
  }

  /**
   * The fence: one CAS whose guard compares tenant, token AND generation with
   * the caller's lease under the row lock, in the same statement as the
   * write. Ownership — not the wall clock — decides: an owner whose lease
   * expired but was not re-claimed may still finalise (it is the only process
   * that ran the effect); once another worker re-claimed, the old fence is
   * stale and the write is refused.
   */
  private async fenced(lease: UnifiedOutboxLease, makeNext: (current: UnifiedOutboxRecord) => UnifiedOutboxRecord): Promise<boolean> {
    const res = await this.records.cas(
      lease.recordId,
      (current) =>
        current !== undefined &&
        current.tenantId === lease.tenantId &&
        current.state === 'LEASED' &&
        current.leaseToken === lease.leaseToken &&
        generationOf(current) === lease.leaseGeneration,
      makeNext,
    );
    return res.ok;
  }

  /**
   * Verify per-tenant integrity: sequences strictly increasing and unique,
   * every `previousHash` matches the actual predecessor's `hash`, and every
   * hash recomputes. Gaps are allowed (documented duplicate-race behavior);
   * tampering, deletion, and reordering are detected fail-closed.
   */
  async verifyIntegrity(tenantId: string): Promise<UnifiedOutboxIntegrity> {
    assertTenant(tenantId);
    const records = await this.records.query({
      where: (record) => record.tenantId === tenantId,
      orderBy: 'sequence',
      order: 'asc',
    });
    let previousHash = 'GENESIS';
    let previousSequence = 0;
    const seen = new Set<number>();
    for (const record of records) {
      if (seen.has(record.sequence)) {
        return { tenantId, valid: false, entries: records.length, brokenAt: record.sequence, reason: 'Duplicate outbox sequence.' };
      }
      seen.add(record.sequence);
      if (record.sequence <= previousSequence) {
        return { tenantId, valid: false, entries: records.length, brokenAt: record.sequence, reason: 'Outbox sequence is not ordered.' };
      }
      if (record.previousHash !== previousHash) {
        return { tenantId, valid: false, entries: records.length, brokenAt: record.sequence, reason: 'Outbox previous hash does not match.' };
      }
      if (record.hash !== hashOutboxRecord({ ...record, hash: '' })) {
        return { tenantId, valid: false, entries: records.length, brokenAt: record.sequence, reason: 'Outbox hash does not match its canonical core.' };
      }
      previousHash = record.hash;
      previousSequence = record.sequence;
    }
    return { tenantId, valid: true, entries: records.length };
  }

  /**
   * T-01-I pattern: CAS-advance the per-tenant atomic counter. Bounded at 64
   * rounds so concurrent-publish bursts converge (each round lets at least one
   * writer through); sustained exhaustion still throws fail-closed.
   *
   * The create step preserves an existing row (`current ?? zero`) instead of
   * blindly writing zero: on drivers where compare-and-swap of an ABSENT row
   * cannot lock (e.g. PostgreSQL `SELECT ... FOR UPDATE` locks nothing when
   * the row does not exist), a late-committing create must never clobber a
   * concurrently advanced counter. Callers additionally serialize first-use
   * per tenant in-process (see `createTenantMutex`). Residual risk: two
   * PROCESSES first-creating the same tenant's counter at the same instant
   * can still collide — the same bound the T-01-I ledger init accepts. Once
   * the row exists, row-lock CAS advances it atomically across processes.
   */
  private async nextSequence(tenantId: string): Promise<number> {
    const counterId = `seq:${tenantId}`;
    await this.counters.cas(
      counterId,
      () => true,
      (current) => (current as UnifiedOutboxCounter | undefined) ?? { id: counterId, tenantId, sequence: 0 },
    );
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.counters.get(counterId);
      const observed = current ?? { id: counterId, tenantId, sequence: 0 };
      const next = { id: counterId, tenantId, sequence: observed.sequence + 1 };
      const res = await this.counters.cas(
        counterId,
        (candidate) => (candidate?.sequence ?? 0) === observed.sequence,
        () => next,
      );
      if (res.ok) return next.sequence;
    }
    throw new UnifiedOutboxError('Unified outbox counter CAS exhausted retries.');
  }

  /**
   * Hash of the actual predecessor: the record at `sequence - 1` when present
   * (polling briefly for an in-flight concurrent writer), else the hash of
   * the highest-sequenced record below `sequence` (duplicate-race gap), else
   * GENESIS for the first record.
   */
  private async predecessorHash(tenantId: string, sequence: number): Promise<string> {
    if (sequence > 1) {
      for (let i = 0; i < 8; i += 1) {
        const direct = (
          await this.records.query({
            where: (record) => record.tenantId === tenantId && record.sequence === sequence - 1,
            limit: 1,
          })
        )[0];
        if (direct) return direct.hash;
        await new Promise<void>((resolve) => setTimeout(resolve, 5 * (i + 1)));
      }
      const below = await this.records.query({
        where: (record) => record.tenantId === tenantId && record.sequence < sequence,
        orderBy: 'sequence',
        order: 'desc',
        limit: 1,
      });
      if (below[0]) return below[0].hash;
    }
    return 'GENESIS';
  }
}

/** Immutable core covered by the record hash (mutable delivery state excluded). */
function outboxHashCore(record: UnifiedOutboxRecord): Record<string, unknown> {
  return {
    id: record.id,
    tenantId: record.tenantId,
    channel: record.channel,
    eventId: record.eventId,
    eventType: record.eventType,
    eventVersion: record.eventVersion,
    schemaVersion: record.schemaVersion,
    sequence: record.sequence,
    previousHash: record.previousHash,
    hashVersion: record.hashVersion,
    envelope: record.envelope,
    correlationId: record.correlationId,
    causationId: record.causationId,
    createdAt: record.createdAt,
  };
}

function hashOutboxRecord(record: UnifiedOutboxRecord): string {
  return sha256Hex(canonicalJson(outboxHashCore(record)));
}

/**
 * T-05 read-side verification for the delivery worker: the record hash must
 * recompute, the envelope must still be a valid envelope, and the record's
 * tenant/event identity must match the envelope's (an outbox row can never
 * re-tenant an event). Returns the reason on failure, undefined when sound.
 */
export function verifyOutboxRecordOnRead(record: UnifiedOutboxRecord): string | undefined {
  if (record.hash !== hashOutboxRecord({ ...record, hash: '' })) return 'Outbox record hash does not match its canonical core.';
  if (!isEventEnvelope(record.envelope)) return 'Outbox record envelope is not a valid EventEnvelope.';
  if (record.envelope.tenantId !== record.tenantId) return 'Outbox record tenant does not match its envelope tenant.';
  if (record.envelope.id !== record.eventId) return 'Outbox record event id does not match its envelope id.';
  if (record.envelope.eventType !== record.eventType) return 'Outbox record event type does not match its envelope type.';
  return undefined;
}

function generationOf(record: UnifiedOutboxRecord): number {
  return typeof record.leaseGeneration === 'number' && Number.isFinite(record.leaseGeneration) ? record.leaseGeneration : 0;
}

function clearedLease(): Pick<UnifiedOutboxRecord, 'leaseOwner' | 'leaseToken' | 'leaseExpiry'> {
  return { leaseOwner: undefined, leaseToken: undefined, leaseExpiry: undefined };
}

/** PENDING/RETRYING due now, or LEASED whose lease has expired (crash recovery). Terminal states never. */
export function isClaimable(record: UnifiedOutboxRecord, now: number): boolean {
  if (UNIFIED_OUTBOX_TERMINAL_STATES.has(record.state)) return false;
  if (record.state === 'LEASED') return typeof record.leaseExpiry === 'number' && record.leaseExpiry <= now;
  return record.nextAttemptAt === undefined || record.nextAttemptAt <= now;
}

function computeOutboxKey(tenantId: string, channel: string, eventId: string): string {
  return createHash('sha256').update(`${tenantId}\0${channel}\0${eventId}`).digest('hex').slice(0, 40);
}

function assertTenant(tenantId: string): void {
  if (!tenantId.trim()) throw new UnifiedOutboxError('Unified outbox requires a tenant id (fail-closed).');
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export type { CommercialActor };
