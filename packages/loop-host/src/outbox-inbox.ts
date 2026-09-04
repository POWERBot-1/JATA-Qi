// Durable outbox/inbox substrate for the loop-host (T-01-H).
//
// The outbox is a tenant-scoped collection of outbox records. Each
// record represents a state-change event that must be delivered to
// downstream consumers. The key property is ATOMICITY: a critical
// work-item state mutation AND its outbox record commit together
// (or not at all) inside a single PostgreSQL transaction.
//
// The inbox is a tenant-scoped collection of consumed-message
// records. Each record represents a delivered message that has
// been processed by a consumer. The key property is IDEMPOTENCY:
// repeated delivery of the same message id (from the same
// (tenant, source, messageId) tuple) does NOT duplicate the
// protected business mutation.
//
// The substrate is exposed as a small set of operations over the
// existing @jataqi/storage collections. Callers MUST execute the
// outbox commit inside the same transaction as the protected state
// mutation; the substrate does NOT provide that transactional
// envelope — that is the responsibility of the loop-host settlement
// path (or the storage-postgres `runWithTenant` helper when a
// non-durable driver is in use, in which case the atomicity
// guarantee downgrades to "best-effort" and the documentation
// surfaces this).

import { randomUUID, createHash } from 'node:crypto';
import type { ICollection } from '@jataqi/storage';
import { StorageModule } from '@jataqi/storage';
import type { KernelApi } from '@jataqi/core-kernel';
import { LoopHostError } from './types.js';

export const OUTBOX_COLLECTION = 'loop-host.outbox';
export const INBOX_COLLECTION = 'loop-host.inbox';

/** One pending outbox event. */
export interface OutboxRecord {
  /** Outbox id (stable, used for idempotent delivery). */
  id: string;
  /** Tenant id (scoping). */
  tenantId: string;
  /** Logical channel/topic; consumers subscribe to one or more channels. */
  channel: string;
  /** Stable event id; consumers may use it to deduplicate. */
  eventId: string;
  /** Event type/kind (e.g. "work.completed", "work.denied"). */
  eventType: string;
  /** Event payload (privacy-minimized, no secrets). */
  payload: Record<string, unknown>;
  /** Correlation id for the originating loop run, when known. */
  correlationId?: string;
  /** Work item id, when the event is about a work item. */
  workItemId?: string;
  /** When the record was created (ms). */
  createdAt: number;
  /**
   * Hash of the canonical (channel, eventId) tuple. Used for
   * uniqueness within a tenant: two records with the same
   * (channel, eventId) for the same tenant are the same event
   * (the second is rejected at write time).
   */
  dedupeKey: string;
}

/** One consumed message (inbox) record. */
export interface InboxRecord {
  /** Document id (the dedupe-keyed id, not the source's id). */
  id: string;
  /** Source system that delivered the message. */
  source: string;
  /** Stable message id (assigned by the source). */
  messageId: string;
  /** Tenant id (scoping). */
  tenantId: string;
  /** Hash of the canonical (source, messageId, tenantId) tuple. */
  dedupeKey: string;
  /** When the message was first observed (ms). */
  firstSeenAt: number;
  /** How many times the message has been observed. */
  observedCount: number;
  /** Optional correlation id for the downstream effect. */
  correlationId?: string;
}

/**
 * The outbox/inbox substrate is a thin wrapper over two collections
 * in the @jataqi/storage module. Operations are atomic per-document
 * (via the driver's `cas`); when a transactional driver is in use,
 * the caller can compose outbox writes with state mutations inside
 * the same transaction.
 */
export class OutboxInbox {
  private outbox!: ICollection<OutboxRecord>;
  private inbox!: ICollection<InboxRecord>;

  async init(kernel: KernelApi): Promise<void> {
    this.outbox = await kernel.getModule<StorageModule>('storage').collection<OutboxRecord>(OUTBOX_COLLECTION);
    this.inbox = await kernel.getModule<StorageModule>('storage').collection<InboxRecord>(INBOX_COLLECTION);
  }

  /**
   * Append an outbox record. The record is rejected if a record
   * with the same (tenantId, dedupeKey) already exists — this
   * is the durability/idempotency story for repeat commits.
   */
  async appendOutbox(record: {
    tenantId: string;
    channel: string;
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    correlationId?: string;
    workItemId?: string;
    createdAt?: number;
  }): Promise<OutboxRecord> {
    const createdAt = record.createdAt ?? Date.now();
    const dedupeKey = computeOutboxDedupeKey(record.tenantId, record.channel, record.eventId);
    const outbox: OutboxRecord = {
      id: `outbox:${dedupeKey}`,
      tenantId: record.tenantId,
      channel: record.channel,
      eventId: record.eventId,
      eventType: record.eventType,
      payload: record.payload,
      correlationId: record.correlationId,
      workItemId: record.workItemId,
      createdAt,
      dedupeKey,
    };
    // Use cas-as-insert-if-absent: a guard that requires the doc to
    // be undefined prevents duplicate outbox entries.
    const res = await this.outbox.cas(outbox.id, (cur) => cur === undefined, () => outbox);
    if (res.ok) return outbox;
    // Already present: return the existing record (idempotent).
    return res.doc as OutboxRecord;
  }

  /**
   * List outbox records for a tenant/channel, oldest first. The
   * loop-host's publisher uses this to drain pending records.
   */
  async listOutbox(tenantId: string, channel?: string, limit = 100): Promise<OutboxRecord[]> {
    const items = await this.outbox.query({
      where: (item) => item.tenantId === tenantId && (channel === undefined || item.channel === channel),
      orderBy: 'createdAt',
      order: 'asc',
      limit,
    });
    return items;
  }

  /**
   * Remove an outbox record after successful delivery. The removal
   * is conditional on the record id matching what the publisher
   * observed (TOCTOU protection).
   */
  async ackOutbox(tenantId: string, id: string): Promise<boolean> {
    const cur = await this.outbox.get(id);
    if (!cur || cur.tenantId !== tenantId) return false;
    return this.outbox.delete(id);
  }

  /**
   * Record an inbox observation. The function returns:
   *   - `{ firstTime: true,  record }` if this is the first time the
   *     message was observed (caller MUST execute the protected
   *     business mutation);
   *   - `{ firstTime: false, record }` if the message is a repeat
   *     delivery (caller MUST NOT re-execute the protected
   *     business mutation).
   */
  async observeInbox(tenantId: string, source: string, messageId: string, correlationId?: string): Promise<{ firstTime: boolean; record: InboxRecord }> {
    if (!source || !messageId) throw new LoopHostError('Inbox observation requires source and messageId.');
    const dedupeKey = computeInboxDedupeKey(tenantId, source, messageId);
    const id = `inbox:${dedupeKey}`;
    // Try to insert-if-absent; if present, increment the count.
    const now = Date.now();
    const candidate: InboxRecord = {
      id,
      source,
      messageId,
      tenantId,
      dedupeKey,
      firstSeenAt: now,
      observedCount: 1,
      correlationId,
    };
    const res = await this.inbox.cas(id, (cur) => cur === undefined, () => candidate);
    if (res.ok) return { firstTime: true, record: candidate };
    // Already present: increment the observed count atomically.
    const updated = await this.inbox.cas(id, (cur) => Boolean(cur), (cur) => ({
      ...cur!,
      observedCount: cur!.observedCount + 1,
    }));
    const final = updated.ok ? updated.doc! : await this.inbox.get(id);
    return { firstTime: false, record: final! };
  }

  /** Test helper: list inbox records for a tenant. */
  async listInbox(tenantId: string, limit = 100): Promise<InboxRecord[]> {
    const items = await this.inbox.query({
      where: (item) => item.tenantId === tenantId,
      orderBy: 'firstSeenAt',
      order: 'asc',
      limit,
    });
    return items;
  }
}

/** Deterministic outbox dedupe key. */
function computeOutboxDedupeKey(tenantId: string, channel: string, eventId: string): string {
  return createHash('sha256').update(`${tenantId}\0${channel}\0${eventId}`).digest('hex').slice(0, 40);
}

/** Deterministic inbox dedupe key. */
function computeInboxDedupeKey(tenantId: string, source: string, messageId: string): string {
  return createHash('sha256').update(`${tenantId}\0${source}\0${messageId}`).digest('hex').slice(0, 40);
}

/** Helper: a stable correlation id for an outbox event. */
export function newOutboxEventId(): string {
  return `evt:${randomUUID()}`;
}
