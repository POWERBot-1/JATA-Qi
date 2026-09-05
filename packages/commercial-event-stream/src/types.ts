import type { CommercialEvent } from '@jataqi/commercial-control-plane';

/**
 * Durable inbox (per handler, per event) states.
 *
 * `PENDING` is retained for pre-T-05 rows; new rows are created as `CLAIMED`
 * by the delivery worker. `CLAIMED` is an attempt in flight (or a crashed
 * attempt whose outbox lease will expire). Terminal: `DELIVERED`,
 * `DEAD_LETTER`, `SCHEMA_REJECTED`.
 */
export type EventDeliveryState = 'PENDING' | 'CLAIMED' | 'DELIVERED' | 'RETRYING' | 'DEAD_LETTER' | 'SCHEMA_REJECTED';

export interface CommercialEventContract {
  eventType: string;
  eventVersion: number;
  schemaVersion: number;
  validate(event: CommercialEvent): string[];
}

/**
 * F-01e schema-compatibility policy per event type.
 *
 * `exact` (default): only an exactly matching
 * (eventType, eventVersion, schemaVersion) contract validates; anything else
 * is SCHEMA_REJECTED fail-closed.
 *
 * `fallback-previous-schema`: when no exact contract exists, the highest
 * registered contract with the same (eventType, eventVersion) and a LOWER
 * schemaVersion validates instead. This is an explicit, admin-registered
 * opt-in for additive schema evolution — never implicit.
 */
export type SchemaCompatibilityPolicy = 'exact' | 'fallback-previous-schema';

/** Result of registry contract resolution. */
export interface ResolvedEventContract {
  contract: CommercialEventContract;
  /** True when resolution used the fallback policy rather than an exact match. */
  fallback: boolean;
}

/** A (eventVersion, schemaVersion) pair a handler declares it can consume. */
export interface AcceptedEventVersion {
  eventVersion: number;
  schemaVersion: number;
}

export interface CommercialEventHandler {
  /** Stable id: it keys the durable inbox, so it must not change across deploys. */
  id: string;
  eventTypes: string[];
  maxAttempts?: number;
  /**
   * Versions this handler accepts when NO contract is registered for the
   * event type. Default `[{ eventVersion: 1, schemaVersion: 1 }]`. Anything
   * outside the list (and without a resolving contract) is SCHEMA_REJECTED
   * fail-closed — a handler never silently receives a shape it did not
   * declare.
   */
  accepts?: AcceptedEventVersion[];
  handle(event: CommercialEvent): Promise<void>;
}

/** One durable inbox record: the idempotency boundary for (event, handler). */
export interface EventDeliveryRecord {
  /** `${eventId}:${handlerId}` — stable across restarts, replays and processes. */
  id: string;
  tenantId: string;
  eventId: string;
  eventType: string;
  eventSequence: number;
  handlerId: string;
  state: EventDeliveryState;
  /** Attempts are counted at CLAIM so a crashing handler is bounded by maxAttempts. */
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  deliveredAt?: number;
  createdAt: number;
  updatedAt: number;
  /** T-05 fence copied from the outbox claim that owns this attempt. */
  leaseOwner?: string;
  leaseGeneration?: number;
  claimedAt?: number;
  lastAttemptAt?: number;
  /** Outbox record this inbox row was created from (forensics / replay). */
  outboxRecordId?: string;
}

export interface PumpCommercialEventsOptions {
  afterSequence?: number;
  /** Bounded batch (1..100). Default 25. */
  limit?: number;
  now?: number;
  /** Lease TTL for this pump's claims (ms). Default 30 000. */
  leaseTtlMs?: number;
  /**
   * Deliver every tenant's records (a system worker). Requires the `system`
   * or `global_admin` role; a plain operator only ever pumps its own tenant.
   */
  allTenants?: boolean;
  /** Stable worker identity recorded as the lease owner. Default: service worker id. */
  owner?: string;
}

export interface PumpCommercialEventsResult {
  /** Outbox records claimed by this pump. */
  examined: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  schemaRejected: number;
  /** Inbox rows skipped because already terminal or not yet due. */
  skipped: number;
  /** Outbox records quarantined on read (corrupt / tenant mismatch / poison). */
  quarantined: number;
  /** Claims released without an attempt (graceful stop). */
  released: number;
  /** Fenced writes refused because the lease was no longer ours. */
  fenceRejected: number;
}

export const CommercialEventStreamEvents = Object.freeze({
  Claimed: 'commercial.event.delivery.claimed',
  Delivered: 'commercial.event.delivery.delivered',
  Retrying: 'commercial.event.delivery.retrying',
  DeadLettered: 'commercial.event.delivery.dead_lettered',
  SchemaRejected: 'commercial.event.delivery.schema_rejected',
  Quarantined: 'commercial.event.delivery.quarantined',
  Released: 'commercial.event.delivery.released',
  FenceRejected: 'commercial.event.delivery.fence_rejected',
} as const);
