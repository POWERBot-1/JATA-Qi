import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialEvent, CommercialProvenance } from '@jataqi/commercial-control-plane';
import {
  CommercialEventStreamEvents,
  type CommercialEventContract,
  type CommercialEventHandler,
  type EventDeliveryRecord,
  type PumpCommercialEventsOptions,
  type PumpCommercialEventsResult,
} from './types.js';

const DELIVERIES_COLLECTION = 'commercial-event-stream.deliveries';
const MAX_ATTEMPTS = 10;

export interface CommercialEventStreamConfig {
  now?: () => number;
}

export class CommercialEventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialEventStreamError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Explicit durable delivery engine over the Control Plane's event outbox.
 * Contracts/handlers are code capabilities and therefore are registered at
 * runtime; delivery state is durable and replayable through storage.
 */
export class CommercialEventStreamService {
  private deliveries!: ICollection<EventDeliveryRecord>;
  private controlPlane!: CommercialControlPlaneService;
  private readonly contracts = new Map<string, CommercialEventContract>();
  private readonly handlers = new Map<string, CommercialEventHandler>();
  private readonly clock: () => number;

  constructor(config: CommercialEventStreamConfig = {}) {
    this.clock = config.now ?? (() => Date.now());
  }

  async init(kernel: KernelApi): Promise<void> {
    this.deliveries = await kernel.getModule<StorageModule>('storage').collection<EventDeliveryRecord>(DELIVERIES_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  registerContract(actor: CommercialActor, contract: CommercialEventContract): void {
    assertAdministrator(actor);
    if (!contract.eventType.trim() || !Number.isInteger(contract.eventVersion) || contract.eventVersion < 1 || !Number.isInteger(contract.schemaVersion) || contract.schemaVersion < 1) {
      throw new CommercialEventStreamError('Event contract type, event version, and schema version are required.');
    }
    this.contracts.set(contractKey(contract.eventType, contract.eventVersion, contract.schemaVersion), contract);
  }

  registerHandler(actor: CommercialActor, handler: CommercialEventHandler): void {
    assertAdministrator(actor);
    if (!handler.id.trim() || !handler.eventTypes.length || handler.eventTypes.some((eventType) => !eventType.trim())) throw new CommercialEventStreamError('Event handler id and event types are required.');
    normalizedAttempts(handler.maxAttempts);
    if (this.handlers.has(handler.id)) throw new CommercialEventStreamError(`Event handler "${handler.id}" is already registered.`);
    this.handlers.set(handler.id, handler);
  }

  unregisterHandler(actor: CommercialActor, handlerId: string): boolean {
    assertAdministrator(actor);
    return this.handlers.delete(handlerId);
  }

  /**
   * Deliver stored, versioned events in sequence order. This is deliberately an
   * explicit call so a host can schedule it in a controlled worker environment.
   */
  async pump(actor: CommercialActor, options: PumpCommercialEventsOptions = {}): Promise<PumpCommercialEventsResult> {
    assertManager(actor);
    const now = options.now ?? this.clock();
    const events = await this.controlPlane.replayEvents(actor, { afterSequence: options.afterSequence, limit: options.limit });
    const result: PumpCommercialEventsResult = { examined: 0, delivered: 0, retried: 0, deadLettered: 0, schemaRejected: 0, skipped: 0 };
    for (const event of events) {
      result.examined++;
      const handlers = [...this.handlers.values()].filter((handler) => handler.eventTypes.includes(event.eventType)).sort((a, b) => a.id.localeCompare(b.id));
      if (handlers.length === 0) {
        result.skipped++;
        continue;
      }
      for (const handler of handlers) {
        const delivery = await this.deliveryFor(event, handler, now);
        if (delivery.state === 'DELIVERED' || delivery.state === 'DEAD_LETTER' || delivery.state === 'SCHEMA_REJECTED') {
          result.skipped++;
          continue;
        }
        if (delivery.nextAttemptAt !== undefined && delivery.nextAttemptAt > now) {
          result.skipped++;
          continue;
        }
        const contract = this.contracts.get(contractKey(event.eventType, event.eventVersion, event.schemaVersion));
        if (!contract) {
          await this.saveDelivery(delivery, { state: 'SCHEMA_REJECTED', lastError: `No registered contract for ${event.eventType}@${event.eventVersion}/schema-${event.schemaVersion}.`, nextAttemptAt: undefined });
          result.schemaRejected++;
          await this.emit(actor, CommercialEventStreamEvents.SchemaRejected, delivery, { eventId: event.id, handlerId: handler.id });
          continue;
        }
        const errors = contract.validate(event);
        if (errors.length > 0) {
          await this.saveDelivery(delivery, { state: 'SCHEMA_REJECTED', lastError: errors.join(' '), nextAttemptAt: undefined });
          result.schemaRejected++;
          await this.emit(actor, CommercialEventStreamEvents.SchemaRejected, delivery, { eventId: event.id, handlerId: handler.id, errors });
          continue;
        }
        try {
          await handler.handle(copy(event));
          const delivered = await this.saveDelivery(delivery, { state: 'DELIVERED', attemptCount: delivery.attemptCount + 1, deliveredAt: now, lastError: undefined, nextAttemptAt: undefined });
          result.delivered++;
          await this.emit(actor, CommercialEventStreamEvents.Delivered, delivered, { eventId: event.id, handlerId: handler.id, attempts: delivered.attemptCount });
        } catch (error) {
          const attempts = delivery.attemptCount + 1;
          const maxAttempts = delivery.maxAttempts;
          const state = attempts >= maxAttempts ? 'DEAD_LETTER' : 'RETRYING';
          const updated = await this.saveDelivery(delivery, {
            state,
            attemptCount: attempts,
            lastError: errorMessage(error),
            nextAttemptAt: state === 'RETRYING' ? now + retryDelayMs(attempts) : undefined,
          });
          if (state === 'DEAD_LETTER') {
            result.deadLettered++;
            await this.emit(actor, CommercialEventStreamEvents.DeadLettered, updated, { eventId: event.id, handlerId: handler.id, attempts, error: updated.lastError });
          } else {
            result.retried++;
            await this.emit(actor, CommercialEventStreamEvents.Retrying, updated, { eventId: event.id, handlerId: handler.id, attempts, nextAttemptAt: updated.nextAttemptAt, error: updated.lastError });
          }
        }
      }
    }
    return result;
  }

  async listDeliveries(actor: CommercialActor): Promise<EventDeliveryRecord[]> {
    return (await this.deliveries.query({ where: (delivery) => canRead(actor, delivery.tenantId), orderBy: 'eventSequence', order: 'asc' })).map(copy);
  }

  async listDeadLetters(actor: CommercialActor): Promise<EventDeliveryRecord[]> {
    return (await this.deliveries.query({ where: (delivery) => canRead(actor, delivery.tenantId) && (delivery.state === 'DEAD_LETTER' || delivery.state === 'SCHEMA_REJECTED'), orderBy: 'updatedAt', order: 'asc' })).map(copy);
  }

  private async deliveryFor(event: CommercialEvent, handler: CommercialEventHandler, now: number): Promise<EventDeliveryRecord> {
    const id = `${event.id}:${handler.id}`;
    const existing = await this.deliveries.get(id);
    if (existing) return existing;
    const delivery: EventDeliveryRecord = {
      id, tenantId: event.tenantId, eventId: event.id, eventType: event.eventType, eventSequence: event.sequence, handlerId: handler.id,
      state: 'PENDING', attemptCount: 0, maxAttempts: normalizedAttempts(handler.maxAttempts), createdAt: now, updatedAt: now,
    };
    await this.deliveries.put(delivery);
    return delivery;
  }

  private async saveDelivery(delivery: EventDeliveryRecord, patch: Partial<EventDeliveryRecord>): Promise<EventDeliveryRecord> {
    const updated: EventDeliveryRecord = { ...delivery, ...patch, updatedAt: this.clock() };
    await this.deliveries.put(updated);
    return updated;
  }

  private async emit(actor: CommercialActor, eventType: string, delivery: EventDeliveryRecord, payload: Record<string, unknown>): Promise<void> {
    const now = this.clock();
    const provenance: CommercialProvenance = { source: 'commercial-event-stream', collectedAt: now, correlationId: delivery.eventId, causationId: delivery.eventId };
    await this.controlPlane.publishEvent(actor, { eventType, source: 'commercial-event-stream', entityId: delivery.id, correlationId: delivery.eventId, causationId: delivery.eventId, payload, provenance, privacyClassification: 'INTERNAL', idempotencyKey: `${eventType}:${delivery.id}:${delivery.attemptCount}` });
  }
}

function contractKey(type: string, eventVersion: number, schemaVersion: number): string { return `${type}:${eventVersion}:${schemaVersion}`; }
function retryDelayMs(attempt: number): number { return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1)); }
function normalizedAttempts(value: number | undefined): number { const attempts = value ?? 3; if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new CommercialEventStreamError(`Handler max attempts must be an integer from 1 to ${MAX_ATTEMPTS}.`); return attempts; }
function assertAdministrator(actor: CommercialActor): void { if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new CommercialEventStreamError('Commercial administrator role is required.'); }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new CommercialEventStreamError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function copy<T>(value: T): T { return structuredClone(value); }
