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

import { createHash } from 'node:crypto';
import {
  CANONICAL_HASH_VERSION,
  canonicalJson,
  isEventEnvelope,
  sha256Hex,
  type EventEnvelope,
} from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor } from './types.js';

export type UnifiedOutboxState = 'PENDING' | 'DELIVERED' | 'DEAD_LETTER' | 'QUARANTINED';

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
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  lastError?: string;
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
} {
  const tails = new Map<string, Promise<unknown>>();
  return {
    runExclusive<T>(tenantId: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(tenantId) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      tails.set(tenantId, tail);
      return previous
        .catch(() => undefined)
        .then(task)
        .finally(() => {
          if (tails.get(tenantId) === tail) tails.delete(tenantId);
          release();
        });
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

  /** Tenant-guarded ack: marks DELIVERED. Returns false on missing/foreign records. */
  async ack(tenantId: string, id: string, now = Date.now()): Promise<boolean> {
    const current = await this.records.get(id);
    if (!current || current.tenantId !== tenantId) return false;
    if (current.state === 'DELIVERED') return true;
    const updated: UnifiedOutboxRecord = {
      ...current,
      state: 'DELIVERED',
      deliveredAt: now,
      updatedAt: now,
    };
    // Rehash is NOT needed: hash covers the immutable core only (see hashOutboxRecord).
    await this.records.put(updated);
    return true;
  }

  /** Record a terminal delivery failure without deleting the evidence. */
  async markDeadLetter(tenantId: string, id: string, error: string, now = Date.now()): Promise<boolean> {
    const current = await this.records.get(id);
    if (!current || current.tenantId !== tenantId) return false;
    await this.records.put({
      ...current,
      state: 'DEAD_LETTER',
      lastError: error,
      attemptCount: current.attemptCount + 1,
      updatedAt: now,
    });
    return true;
  }

  /**
   * Quarantine a corrupt record (e.g. envelope fails validation on read).
   * Quarantined records stay replayable for forensics but are excluded from
   * default PENDING replays; they are never auto-redelivered.
   */
  async quarantine(tenantId: string, id: string, reason: string, now = Date.now()): Promise<boolean> {
    const current = await this.records.get(id);
    if (!current || current.tenantId !== tenantId) return false;
    await this.records.put({
      ...current,
      state: 'QUARANTINED',
      lastError: reason,
      updatedAt: now,
    });
    return true;
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
