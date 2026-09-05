// T-05 canonical durable delivery worker.
//
// The ONE production delivery path: it claims records from the Control
// Plane's unified durable outbox (storage-level CAS lease with owner / token /
// generation / expiry), runs each registered handler behind a durable
// per-(event, handler) inbox record (the subscriber idempotency boundary),
// and finalises with transitions fenced on the lease. The legacy `events`
// collection is a replay/compatibility view — never a delivery source.
//
// Delivery honesty: AT-LEAST-ONCE with idempotent handling. A crash after a
// handler effect but before the durable ack re-delivers after lease expiry;
// handlers must be idempotent (all in-repo handlers are). Exactly-once is
// NOT claimed.

import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { emitPlainEnveloped } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import {
  CommercialControlPlaneModule,
  CommercialControlPlaneEvents,
  commercialEventFromEnvelope,
  verifyOutboxRecordOnRead,
  type UnifiedOutbox,
  type UnifiedOutboxLease,
  type UnifiedOutboxRecord,
} from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialEvent } from '@jataqi/commercial-control-plane';
import {
  CommercialEventStreamEvents,
  type AcceptedEventVersion,
  type CommercialEventContract,
  type CommercialEventHandler,
  type EventDeliveryRecord,
  type PumpCommercialEventsOptions,
  type PumpCommercialEventsResult,
  type ResolvedEventContract,
  type SchemaCompatibilityPolicy,
} from './types.js';

export const DELIVERIES_COLLECTION = 'commercial-event-stream.deliveries';
const MAX_ATTEMPTS = 10;
const DEFAULT_BATCH = 25;
const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

export interface CommercialEventStreamConfig {
  now?: () => number;
  /** Stable worker identity (host id / pid). Default `worker:<uuid>`. */
  workerId?: string;
  /** Default lease TTL for claims (ms). */
  leaseTtlMs?: number;
  /** Default bounded batch per pump (1..100). */
  batchSize?: number;
  /**
   * Post-commit wake-up: when a commercial event is recorded in THIS
   * process, immediately pump the publishing tenant for the event types a
   * registered handler consumes. The bus payload is only a hint; the worker
   * re-reads the durable record. Default true. Cross-process wake-up is the
   * host's periodic pump.
   */
  wakeOnPublish?: boolean;
}

export class CommercialEventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialEventStreamError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface RegisteredHandler {
  handler: CommercialEventHandler;
  maxAttempts: number;
  accepts: AcceptedEventVersion[];
}

type InboxOutcome = 'DELIVERED' | 'RETRYING' | 'DEAD_LETTER' | 'SCHEMA_REJECTED' | 'SKIPPED' | 'FENCE_REJECTED';

/**
 * Explicit durable delivery worker over the Control Plane's unified outbox.
 * Contracts/handlers are code capabilities and therefore are registered at
 * runtime; delivery state is durable and replayable through storage.
 */
export class CommercialEventStreamService {
  private deliveries!: ICollection<EventDeliveryRecord>;
  private controlPlane!: CommercialControlPlaneService;
  private outbox!: UnifiedOutbox;
  private api!: KernelApi;
  private readonly contracts = new Map<string, CommercialEventContract>();
  private readonly handlers = new Map<string, RegisteredHandler>();
  /** F-01e: per-event-type compatibility policy (default `exact`). */
  private readonly compatibilityPolicies = new Map<string, SchemaCompatibilityPolicy>();
  private readonly clock: () => number;
  private readonly workerId: string;
  private readonly defaultLeaseTtlMs: number;
  private readonly defaultBatch: number;
  private readonly wakeOnPublish: boolean;
  private unsubscribeWake?: () => void;
  private stopping = false;
  /** In-process serialisation of passes (the durable CAS is the correctness boundary; this only avoids self-contention). */
  private pumpChain: Promise<unknown> = Promise.resolve();
  /** Passes currently executing in this process (0 or 1; >0 means a wake arrived from inside a handler effect). */
  private activePasses = 0;
  private draining = false;
  /** Tenants with a committed event awaiting an in-process delivery pass. */
  private readonly wakeQueue = new Set<string>();

  constructor(config: CommercialEventStreamConfig = {}) {
    this.clock = config.now ?? (() => Date.now());
    this.workerId = config.workerId?.trim() || `worker:${randomUUID()}`;
    this.defaultLeaseTtlMs = normalizeLeaseTtl(config.leaseTtlMs);
    this.defaultBatch = normalizeBatch(config.batchSize);
    this.wakeOnPublish = config.wakeOnPublish ?? true;
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.deliveries = await kernel.getModule<StorageModule>('storage').collection<EventDeliveryRecord>(DELIVERIES_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    this.outbox = this.controlPlane.getUnifiedOutbox();
  }

  /**
   * Subscribe the in-process post-commit wake-up (idempotent).
   *
   * The wake-up is a latency optimisation over the durable outbox, not a
   * delivery path of its own: the bus envelope only names the tenant, and
   * the pass re-reads and re-verifies the durable record before any handler
   * runs. A wake arriving from OUTSIDE a pass drains the cascade before the
   * publisher's `publishEvent` resolves (so a caller observes settled
   * downstream effects, as the volatile bus used to provide); a wake from
   * INSIDE a handler effect only enqueues its tenant — the running pass
   * drains it afterwards, so nested publishes can never deadlock on the
   * pass chain.
   */
  start(): void {
    this.stopping = false;
    if (!this.wakeOnPublish || this.unsubscribeWake) return;
    this.unsubscribeWake = this.api.bus.onEnveloped(CommercialControlPlaneEvents.EventRecorded, async (_topic, envelope) => {
      if (!envelope.tenantId || !envelope.eventType || this.stopping) return;
      if (!this.handlersFor(envelope.eventType).length) return;
      this.wakeQueue.add(envelope.tenantId);
      if (this.activePasses === 0) await this.drainWakes();
    });
  }

  /** Graceful stop: no new claims; an in-flight pump finishes its current record. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribeWake?.();
    this.unsubscribeWake = undefined;
    this.wakeQueue.clear();
    await this.pumpChain.catch(() => undefined);
  }

  getWorkerId(): string {
    return this.workerId;
  }

  registerContract(actor: CommercialActor, contract: CommercialEventContract): void {
    assertAdministrator(actor);
    if (!contract.eventType.trim() || !Number.isInteger(contract.eventVersion) || contract.eventVersion < 1 || !Number.isInteger(contract.schemaVersion) || contract.schemaVersion < 1) {
      throw new CommercialEventStreamError('Event contract type, event version, and schema version are required.');
    }
    this.contracts.set(contractKey(contract.eventType, contract.eventVersion, contract.schemaVersion), contract);
  }

  /**
   * F-01e: set the schema-compatibility policy for an event type.
   * Administrator-only; unknown policies are rejected fail-closed.
   */
  setCompatibilityPolicy(actor: CommercialActor, eventType: string, policy: SchemaCompatibilityPolicy): void {
    assertAdministrator(actor);
    if (!eventType.trim()) throw new CommercialEventStreamError('Event type is required.');
    if (policy !== 'exact' && policy !== 'fallback-previous-schema') {
      throw new CommercialEventStreamError(`Unknown schema compatibility policy "${policy}" (fail-closed).`);
    }
    this.compatibilityPolicies.set(eventType, policy);
  }

  getCompatibilityPolicy(eventType: string): SchemaCompatibilityPolicy {
    return this.compatibilityPolicies.get(eventType) ?? 'exact';
  }

  /**
   * F-01e: resolve the validating contract for a versioned event. Exact match
   * wins; under `fallback-previous-schema` the highest lower-schema contract
   * for the same (eventType, eventVersion) applies. Returns undefined when no
   * contract applies.
   */
  resolveContract(eventType: string, eventVersion: number, schemaVersion: number): ResolvedEventContract | undefined {
    const exact = this.contracts.get(contractKey(eventType, eventVersion, schemaVersion));
    if (exact) return { contract: exact, fallback: false };
    if (this.getCompatibilityPolicy(eventType) !== 'fallback-previous-schema') return undefined;
    let best: CommercialEventContract | undefined;
    for (const candidate of this.contracts.values()) {
      if (candidate.eventType !== eventType || candidate.eventVersion !== eventVersion) continue;
      if (candidate.schemaVersion >= schemaVersion) continue;
      if (!best || candidate.schemaVersion > best.schemaVersion) best = candidate;
    }
    return best ? { contract: best, fallback: true } : undefined;
  }

  /** True when any contract is registered for the event type (contracts then govern acceptance). */
  hasContractFor(eventType: string): boolean {
    for (const contract of this.contracts.values()) if (contract.eventType === eventType) return true;
    return false;
  }

  /**
   * Register a durable handler. Handlers are code capabilities: the id keys
   * the durable inbox and MUST stay stable across restarts and deploys.
   * Registration is administrator/system only.
   */
  registerHandler(actor: CommercialActor, handler: CommercialEventHandler): void {
    assertRegistrar(actor);
    if (!handler.id.trim() || !handler.eventTypes.length || handler.eventTypes.some((eventType) => !eventType.trim())) throw new CommercialEventStreamError('Event handler id and event types are required.');
    const maxAttempts = normalizedAttempts(handler.maxAttempts);
    const accepts = normalizeAccepts(handler.accepts);
    if (this.handlers.has(handler.id)) throw new CommercialEventStreamError(`Event handler "${handler.id}" is already registered.`);
    this.handlers.set(handler.id, { handler, maxAttempts, accepts });
  }

  unregisterHandler(actor: CommercialActor, handlerId: string): boolean {
    assertRegistrar(actor);
    return this.handlers.delete(handlerId);
  }

  listHandlerIds(): string[] {
    return [...this.allHandlers().keys()].sort();
  }

  /** Event types at least one registered handler consumes. */
  handledEventTypes(): string[] {
    const types = new Set<string>();
    for (const entry of this.allHandlers().values()) for (const type of entry.handler.eventTypes) types.add(type);
    return [...types].sort();
  }

  /**
   * One bounded delivery pass. Explicit by design so a host schedules it in
   * a controlled worker environment; the in-process wake-up calls it too.
   *
   * Tenant boundary: an operator pumps ONLY its own tenant. `allTenants`
   * (a system worker) requires the `system` or `global_admin` role.
   */
  async pump(actor: CommercialActor, options: PumpCommercialEventsOptions = {}): Promise<PumpCommercialEventsResult> {
    assertManager(actor);
    if (options.allTenants && !isSystemScope(actor)) {
      throw new CommercialEventStreamError('Cross-tenant delivery requires the system or global_admin role (fail-closed).');
    }
    const result = await this.runPass(actor, options);
    // Handler effects published during this pass enqueued their tenants;
    // settle the cascade before returning unless we are nested inside a
    // pass, whose own drain continues afterwards.
    if (this.activePasses === 0) await this.drainWakes();
    return result;
  }

  private runPass(actor: CommercialActor, options: PumpCommercialEventsOptions): Promise<PumpCommercialEventsResult> {
    const run = this.pumpChain.catch(() => undefined).then(() => this.pumpOnce(actor, options));
    this.pumpChain = run;
    return run;
  }

  private async drainWakes(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.wakeQueue.size > 0 && !this.stopping) {
        const tenants = [...this.wakeQueue];
        this.wakeQueue.clear();
        for (const tenantId of tenants) {
          const actor: CommercialActor = { id: 'commercial-event-stream-system', tenantId, roles: ['system'] };
          let result: PumpCommercialEventsResult;
          do {
            try {
              result = await this.runPass(actor, {});
            } catch (error) {
              this.api.logger.warn(`commercial-event-stream wake-up pass failed for tenant ${tenantId} (fail-closed; records stay durable for the next pass): ${errorMessage(error)}`);
              break;
            }
          } while (result.examined >= this.defaultBatch && !this.stopping);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async pumpOnce(actor: CommercialActor, options: PumpCommercialEventsOptions): Promise<PumpCommercialEventsResult> {
    this.activePasses += 1;
    try {
      return await this.pass(actor, options);
    } finally {
      this.activePasses -= 1;
    }
  }

  private async pass(actor: CommercialActor, options: PumpCommercialEventsOptions): Promise<PumpCommercialEventsResult> {
    const now = options.now ?? this.clock();
    const result: PumpCommercialEventsResult = { examined: 0, delivered: 0, retried: 0, deadLettered: 0, schemaRejected: 0, skipped: 0, quarantined: 0, released: 0, fenceRejected: 0 };
    const eventTypes = this.handledEventTypes();
    if (eventTypes.length === 0 || this.stopping) return result;
    const owner = options.owner?.trim() || this.workerId;
    const claimed = await this.outbox.claim({
      owner,
      now,
      leaseTtlMs: normalizeLeaseTtl(options.leaseTtlMs ?? this.defaultLeaseTtlMs),
      limit: normalizeBatch(options.limit ?? this.defaultBatch),
      tenantId: options.allTenants ? undefined : actor.tenantId,
      eventTypes,
      afterSequence: options.afterSequence,
    });
    for (const { record, lease } of claimed) {
      result.examined += 1;
      if (this.stopping) {
        // Graceful stop mid-batch: give the claim back without an attempt.
        const released = await this.outbox.release(lease, this.clock());
        if (released) {
          result.released += 1;
          await this.telemetry(record, CommercialEventStreamEvents.Released, `${record.id}:${lease.leaseGeneration}`, { attempt: lease.attemptCount });
        } else result.fenceRejected += 1;
        continue;
      }
      await this.deliverClaimed(record, lease, now, result);
    }
    return result;
  }

  /** Deliver one claimed outbox record to every handler for its type, then finalise the record under the fence. */
  private async deliverClaimed(record: UnifiedOutboxRecord, lease: UnifiedOutboxLease, now: number, result: PumpCommercialEventsResult): Promise<void> {
    await this.telemetry(record, CommercialEventStreamEvents.Claimed, `${record.id}:${lease.leaseGeneration}`, { attempt: lease.attemptCount, owner: lease.leaseOwner, generation: lease.leaseGeneration });
    const corruption = verifyOutboxRecordOnRead(record);
    if (corruption) {
      const quarantined = await this.outbox.quarantineLeased(lease, corruption, this.clock());
      if (quarantined) {
        result.quarantined += 1;
        await this.telemetry(record, CommercialEventStreamEvents.Quarantined, `${record.id}:${lease.leaseGeneration}`, { reason: corruption });
      } else result.fenceRejected += 1;
      return;
    }
    const event = commercialEventFromEnvelope(record.envelope);
    const handlers = this.handlersFor(event.eventType);
    const outcomes: InboxOutcome[] = [];
    for (const entry of handlers) {
      const outcome = await this.deliverToHandler(event, record, lease, entry, now, result);
      outcomes.push(outcome);
      if (outcome === 'FENCE_REJECTED') break;
    }
    if (outcomes.includes('FENCE_REJECTED')) {
      // The durable state now belongs to another owner; write nothing more.
      return;
    }
    // Aggregate the per-handler inbox states into the record's state.
    const inbox = await this.inboxRowsFor(record.eventId, handlers.map((entry) => entry.handler.id));
    const states = new Set(inbox.map((row) => row.state));
    const finishedAt = this.clock();
    if (states.has('RETRYING') || states.has('CLAIMED') || states.has('PENDING')) {
      const dueAt = Math.min(...inbox.filter((row) => row.state === 'RETRYING').map((row) => row.nextAttemptAt ?? finishedAt), finishedAt + MAX_BACKOFF_MS);
      const error = inbox.find((row) => row.state === 'RETRYING')?.lastError ?? 'Handler retry pending.';
      if (!(await this.outbox.scheduleRetry(lease, error, Number.isFinite(dueAt) ? dueAt : finishedAt + backoffMs(lease.attemptCount), finishedAt))) result.fenceRejected += 1;
      return;
    }
    if (states.has('DEAD_LETTER')) {
      const error = inbox.find((row) => row.state === 'DEAD_LETTER')?.lastError ?? 'Handler exhausted its attempts.';
      if (!(await this.outbox.deadLetterLeased(lease, error, finishedAt))) result.fenceRejected += 1;
      return;
    }
    if (states.has('SCHEMA_REJECTED') && !states.has('DELIVERED')) {
      const reason = inbox.find((row) => row.state === 'SCHEMA_REJECTED')?.lastError ?? 'Schema rejected.';
      if (!(await this.outbox.quarantineLeased(lease, reason, finishedAt))) result.fenceRejected += 1;
      return;
    }
    if (!(await this.outbox.ackLeased(lease, finishedAt))) result.fenceRejected += 1;
  }

  /**
   * One handler attempt behind the durable inbox: claim/dedupe → schema
   * gate → effect → durable settle. Every inbox write is a CAS fenced on the
   * outbox lease generation, so a stale owner cannot settle a newer attempt.
   */
  private async deliverToHandler(event: CommercialEvent, record: UnifiedOutboxRecord, lease: UnifiedOutboxLease, entry: RegisteredHandler, now: number, result: PumpCommercialEventsResult): Promise<InboxOutcome> {
    const handler = entry.handler;
    const id = inboxIdFor(event.id, handler.id);
    const claimAt = now;
    // Claim: create or take over the inbox row for this lease generation.
    const claim = await this.deliveries.cas(
      id,
      (current) => current === undefined || (!isTerminalInbox(current.state) && (current.nextAttemptAt === undefined || current.nextAttemptAt <= now) && (current.leaseGeneration ?? 0) < lease.leaseGeneration),
      (current) => {
        const base: EventDeliveryRecord = current ?? {
          id, tenantId: record.tenantId, eventId: event.id, eventType: event.eventType, eventSequence: event.sequence, handlerId: handler.id,
          state: 'CLAIMED', attemptCount: 0, maxAttempts: entry.maxAttempts, createdAt: claimAt, updatedAt: claimAt, outboxRecordId: record.id,
        };
        return { ...base, state: 'CLAIMED', attemptCount: base.attemptCount + 1, maxAttempts: entry.maxAttempts, leaseOwner: lease.leaseOwner, leaseGeneration: lease.leaseGeneration, claimedAt: claimAt, lastAttemptAt: claimAt, nextAttemptAt: undefined, updatedAt: claimAt, outboxRecordId: record.id };
      },
    );
    if (!claim.ok) {
      const current = claim.doc;
      if (current && (current.leaseGeneration ?? 0) > lease.leaseGeneration) {
        result.fenceRejected += 1;
        await this.telemetry(record, CommercialEventStreamEvents.FenceRejected, `${id}:${lease.leaseGeneration}`, { handlerId: handler.id, ownedBy: current.leaseOwner, generation: current.leaseGeneration });
        return 'FENCE_REJECTED';
      }
      // Terminal already (delivered by a previous attempt) or not yet due.
      result.skipped += 1;
      return 'SKIPPED';
    }
    const claimed = claim.doc as EventDeliveryRecord;
    const settle = (patch: Partial<EventDeliveryRecord>): Promise<boolean> => this.settleInbox(id, lease, patch);

    // Schema gate (F-01e): contract when registered, else declared acceptance.
    const schemaError = this.schemaGate(event, entry);
    if (schemaError) {
      if (!(await settle({ state: 'SCHEMA_REJECTED', lastError: schemaError, nextAttemptAt: undefined }))) { result.fenceRejected += 1; return 'FENCE_REJECTED'; }
      result.schemaRejected += 1;
      await this.telemetry(record, CommercialEventStreamEvents.SchemaRejected, `${id}:${claimed.attemptCount}`, { handlerId: handler.id, error: schemaError });
      return 'SCHEMA_REJECTED';
    }
    try {
      await handler.handle(copy(event));
    } catch (error) {
      const message = errorMessage(error);
      const exhausted = claimed.attemptCount >= claimed.maxAttempts;
      const nextAttemptAt = exhausted ? undefined : now + backoffMs(claimed.attemptCount);
      if (!(await settle({ state: exhausted ? 'DEAD_LETTER' : 'RETRYING', lastError: message, nextAttemptAt }))) { result.fenceRejected += 1; return 'FENCE_REJECTED'; }
      if (exhausted) {
        result.deadLettered += 1;
        await this.telemetry(record, CommercialEventStreamEvents.DeadLettered, `${id}:${claimed.attemptCount}`, { handlerId: handler.id, attempts: claimed.attemptCount, error: message });
        return 'DEAD_LETTER';
      }
      result.retried += 1;
      await this.telemetry(record, CommercialEventStreamEvents.Retrying, `${id}:${claimed.attemptCount}`, { handlerId: handler.id, attempts: claimed.attemptCount, nextAttemptAt, error: message });
      return 'RETRYING';
    }
    if (!(await settle({ state: 'DELIVERED', deliveredAt: this.clock(), lastError: undefined, nextAttemptAt: undefined }))) { result.fenceRejected += 1; return 'FENCE_REJECTED'; }
    result.delivered += 1;
    await this.telemetry(record, CommercialEventStreamEvents.Delivered, `${id}:${claimed.attemptCount}`, { handlerId: handler.id, attempts: claimed.attemptCount });
    return 'DELIVERED';
  }

  /** Fenced inbox settle: applies only while the row still belongs to this lease generation. */
  private async settleInbox(id: string, lease: UnifiedOutboxLease, patch: Partial<EventDeliveryRecord>): Promise<boolean> {
    const res = await this.deliveries.cas(
      id,
      (current) => current !== undefined && current.state === 'CLAIMED' && current.leaseGeneration === lease.leaseGeneration && current.leaseOwner === lease.leaseOwner,
      (current) => ({ ...current, ...patch, updatedAt: this.clock() }),
    );
    return res.ok;
  }

  private schemaGate(event: CommercialEvent, entry: RegisteredHandler): string | undefined {
    if (this.hasContractFor(event.eventType)) {
      const resolved = this.resolveContract(event.eventType, event.eventVersion, event.schemaVersion);
      if (!resolved) return `No registered contract for ${event.eventType}@${event.eventVersion}/schema-${event.schemaVersion}.`;
      const errors = resolved.contract.validate(event);
      return errors.length > 0 ? errors.join(' ') : undefined;
    }
    const accepted = entry.accepts.some((version) => version.eventVersion === event.eventVersion && version.schemaVersion === event.schemaVersion);
    return accepted ? undefined : `Handler ${entry.handler.id} does not accept ${event.eventType}@${event.eventVersion}/schema-${event.schemaVersion} (no contract registered).`;
  }

  async listDeliveries(actor: CommercialActor): Promise<EventDeliveryRecord[]> {
    return (await this.deliveries.query({ where: (delivery) => canRead(actor, delivery.tenantId), orderBy: 'eventSequence', order: 'asc' })).map(copy);
  }

  async listDeadLetters(actor: CommercialActor): Promise<EventDeliveryRecord[]> {
    return (await this.deliveries.query({ where: (delivery) => canRead(actor, delivery.tenantId) && (delivery.state === 'DEAD_LETTER' || delivery.state === 'SCHEMA_REJECTED'), orderBy: 'updatedAt', order: 'asc' })).map(copy);
  }

  /** Read-only inbox row for one (event, handler) — used by operator inspection and tests. */
  async getDelivery(actor: CommercialActor, eventId: string, handlerId: string): Promise<EventDeliveryRecord | undefined> {
    const row = await this.deliveries.get(inboxIdFor(eventId, handlerId));
    return row && canRead(actor, row.tenantId) ? copy(row) : undefined;
  }

  /**
   * Registered handlers for a type: the worker's own registrations plus every
   * durable subscriber declared on the control plane (billing, revenue
   * ledger, commercial memory, …). Control-plane declarations are adopted
   * dynamically so a consumer module registered after this one still
   * receives durable delivery; ids must be unique across both sets.
   */
  private handlersFor(eventType: string): RegisteredHandler[] {
    return [...this.allHandlers().values()].filter((entry) => entry.handler.eventTypes.includes(eventType)).sort((a, b) => a.handler.id.localeCompare(b.handler.id));
  }

  private allHandlers(): Map<string, RegisteredHandler> {
    const merged = new Map<string, RegisteredHandler>(this.handlers);
    for (const declared of this.controlPlane.listDurableHandlers()) {
      if (merged.has(declared.id)) {
        if (merged.get(declared.id)!.handler !== declared) {
          this.api.logger.warn(`commercial-event-stream: duplicate durable handler id "${declared.id}" ignored (fail-closed; first registration wins).`);
        }
        continue;
      }
      merged.set(declared.id, { handler: declared, maxAttempts: normalizedAttempts(declared.maxAttempts), accepts: normalizeAccepts(declared.accepts) });
    }
    return merged;
  }

  private async inboxRowsFor(eventId: string, handlerIds: readonly string[]): Promise<EventDeliveryRecord[]> {
    const rows: EventDeliveryRecord[] = [];
    for (const handlerId of handlerIds) {
      const row = await this.deliveries.get(inboxIdFor(eventId, handlerId));
      if (row) rows.push(row);
    }
    return rows;
  }

  /**
   * Privacy-minimised delivery telemetry: an in-process enveloped signal
   * (ids, attempts, owner, generation — never handler payloads) under the
   * RECORD's tenant, never the pump operator's. The durable evidence is the
   * outbox + inbox rows themselves; telemetry is deliberately NOT written
   * back into the outbox so the worker can never amplify or feed itself.
   */
  private async telemetry(record: UnifiedOutboxRecord, topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await emitPlainEnveloped(this.api.bus, topic, {
        outboxRecordId: record.id, eventId: record.eventId, tenantId: record.tenantId, sourceEventType: record.eventType, sequence: record.sequence,
        workerId: this.workerId, at: this.clock(), key, ...payload,
      }, { source: 'commercial-event-stream', tenantId: record.tenantId, correlationId: record.correlationId, causationId: record.eventId, idempotencyKey: `${topic}:${key}` });
    } catch (error) {
      this.api.logger.warn(`commercial-event-stream telemetry ${topic} failed: ${errorMessage(error)}`);
    }
  }
}

export function inboxIdFor(eventId: string, handlerId: string): string { return `${eventId}:${handlerId}`; }
/** Bounded exponential backoff: min(60s, 1s · 2^(attempt-1)). Exported for tests. */
export function backoffMs(attempt: number): number { return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempt - 1)); }
function isTerminalInbox(state: EventDeliveryRecord['state']): boolean { return state === 'DELIVERED' || state === 'DEAD_LETTER' || state === 'SCHEMA_REJECTED'; }
function contractKey(type: string, eventVersion: number, schemaVersion: number): string { return `${type}:${eventVersion}:${schemaVersion}`; }
function normalizedAttempts(value: number | undefined): number { const attempts = value ?? 3; if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new CommercialEventStreamError(`Handler max attempts must be an integer from 1 to ${MAX_ATTEMPTS}.`); return attempts; }
function normalizeAccepts(value: AcceptedEventVersion[] | undefined): AcceptedEventVersion[] {
  const accepts = value ?? [{ eventVersion: 1, schemaVersion: 1 }];
  if (!accepts.length || accepts.some((entry) => !Number.isInteger(entry.eventVersion) || entry.eventVersion < 1 || !Number.isInteger(entry.schemaVersion) || entry.schemaVersion < 1)) {
    throw new CommercialEventStreamError('Handler accepted versions must be positive integer (eventVersion, schemaVersion) pairs.');
  }
  return accepts.map((entry) => ({ eventVersion: entry.eventVersion, schemaVersion: entry.schemaVersion }));
}
function normalizeLeaseTtl(value: number | undefined): number { const ttl = value ?? DEFAULT_LEASE_TTL_MS; if (!Number.isFinite(ttl) || ttl < 1 || ttl > 3_600_000) throw new CommercialEventStreamError('Lease TTL must be between 1 and 3600000 ms.'); return Math.floor(ttl); }
function normalizeBatch(value: number | undefined): number { const batch = value ?? DEFAULT_BATCH; if (!Number.isInteger(batch) || batch < 1 || batch > 100) throw new CommercialEventStreamError('Pump batch limit must be an integer from 1 to 100.'); return batch; }
function assertAdministrator(actor: CommercialActor): void { if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new CommercialEventStreamError('Commercial administrator role is required.'); }
function assertRegistrar(actor: CommercialActor): void { if (!actor.roles.some((role) => ['admin', 'global_admin', 'system'].includes(role))) throw new CommercialEventStreamError('Commercial administrator or system role is required.'); }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new CommercialEventStreamError('Commercial operator role is required.'); }
function isSystemScope(actor: CommercialActor): boolean { return actor.roles.includes('system') || actor.roles.includes('global_admin'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function copy<T>(value: T): T { return structuredClone(value); }
