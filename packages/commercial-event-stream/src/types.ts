import type { CommercialEvent } from '@jataqi/commercial-control-plane';

export type EventDeliveryState = 'PENDING' | 'DELIVERED' | 'RETRYING' | 'DEAD_LETTER' | 'SCHEMA_REJECTED';

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

export interface CommercialEventHandler {
  id: string;
  eventTypes: string[];
  maxAttempts?: number;
  handle(event: CommercialEvent): Promise<void>;
}

export interface EventDeliveryRecord {
  id: string;
  tenantId: string;
  eventId: string;
  eventType: string;
  eventSequence: number;
  handlerId: string;
  state: EventDeliveryState;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  deliveredAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PumpCommercialEventsOptions {
  afterSequence?: number;
  limit?: number;
  now?: number;
}

export interface PumpCommercialEventsResult {
  examined: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  schemaRejected: number;
  skipped: number;
}

export const CommercialEventStreamEvents = Object.freeze({
  Delivered: 'commercial.event.delivery.delivered',
  Retrying: 'commercial.event.delivery.retrying',
  DeadLettered: 'commercial.event.delivery.dead_lettered',
  SchemaRejected: 'commercial.event.delivery.schema_rejected',
} as const);
