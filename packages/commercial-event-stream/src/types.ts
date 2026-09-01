import type { CommercialEvent } from '@jataqi/commercial-control-plane';

export type EventDeliveryState = 'PENDING' | 'DELIVERED' | 'RETRYING' | 'DEAD_LETTER' | 'SCHEMA_REJECTED';

export interface CommercialEventContract {
  eventType: string;
  eventVersion: number;
  schemaVersion: number;
  validate(event: CommercialEvent): string[];
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
