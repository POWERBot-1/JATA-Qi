import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection, StorageWriteScope } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type {
  CommercialActor,
  CommercialControlPlaneService,
  CommercialEvent,
  CommercialEvidence,
  CommercialProvenance,
  EvidenceStatus,
} from '@jataqi/commercial-control-plane';
import {
  CommercialMemoryEvents,
  type AttributionLink,
  type AttributionNode,
  type CommercialMemoryQuery,
  type CommercialMemoryRecord,
  type RecordAttributionLinkInput,
  type RecordCommercialMemoryInput,
  type RecordDecisionOutcomeInput,
} from './types.js';

const RECORDS_COLLECTION = 'commercial-memory.records';
const NODES_COLLECTION = 'commercial-memory.attribution-nodes';
const LINKS_COLLECTION = 'commercial-memory.attribution-links';
/**
 * Per-tenant atomic sequence counters for memory records (T-06): CAS-advanced
 * INSIDE the same composed write as the record (control-plane CAS-counter
 * pattern). A rollback of the record rolls back the allocation too, so
 * per-tenant sequences stay contiguous and concurrent writers can never
 * observe the same pre-state; cross-process safety rests on the row-lock CAS.
 */
const RECORDS_SEQ_COLLECTION = 'commercial-memory.records-seq';

/** Per-tenant atomic sequence counter document (T-06). */
interface MemorySequenceCounter {
  id: string;
  tenantId: string;
  sequence: number;
}
/** T-05 durable inbox handler id — stable across restarts/deploys (keys the inbox). */
export const COMMERCIAL_MEMORY_DURABLE_HANDLER_ID = 'commercial-memory.raw-event-capture';
const CAUSAL_EVIDENCE_STATUSES = new Set<EvidenceStatus>(['MEASURED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED']);

export class CommercialMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialMemoryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Tenant-isolated commercial institutional memory. The existing general
 * knowledge graph is deliberately not reused because it does not yet expose a
 * tenant isolation boundary suitable for commercial/customer data.
 */
export class CommercialMemoryService {
  private records!: ICollection<CommercialMemoryRecord>;
  private seqCounters!: ICollection<MemorySequenceCounter>;
  private nodes!: ICollection<AttributionNode>;
  private links!: ICollection<AttributionLink>;
  private controlPlane!: CommercialControlPlaneService;
  private readonly unsubscribers: Array<() => void> = [];
  private storage!: StorageModule;

  async init(kernel: KernelApi): Promise<void> {
    const storage = kernel.getModule<StorageModule>('storage');
    this.storage = storage;
    this.records = await storage.collection<CommercialMemoryRecord>(RECORDS_COLLECTION);
    this.seqCounters = await storage.collection<MemorySequenceCounter>(RECORDS_SEQ_COLLECTION);
    this.nodes = await storage.collection<AttributionNode>(NODES_COLLECTION);
    this.links = await storage.collection<AttributionLink>(LINKS_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();

    // T-05 durable cutover: raw-event capture is a durable subscriber of the
    // canonical unified-outbox worker (inbox-deduplicated, at-least-once);
    // the effect is additionally idempotent on `event:<id>`.
    this.unsubscribers.push(this.controlPlane.registerDurableHandler({
      id: COMMERCIAL_MEMORY_DURABLE_HANDLER_ID,
      eventTypes: observedCommercialEvents(),
      maxAttempts: 3,
      handle: (event) => this.captureCommercialEvent(event),
    }));
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  async record(actor: CommercialActor, input: RecordCommercialMemoryInput): Promise<CommercialMemoryRecord> {
    assertManager(actor);
    validateMemoryInput(input);
    // T-06: memory record + sequence allocation + event commit as ONE
    // composed write under the actor's tenant.
    return this.storage.atomically(async (scope) => {
      const records = await scope.collection<CommercialMemoryRecord>(RECORDS_COLLECTION);
      const counters = await scope.collection<MemorySequenceCounter>(RECORDS_SEQ_COLLECTION);
      const record = await this.append({
        tenantId: actor.tenantId,
        ...copy(input),
        tags: [...(input.tags ?? [])],
        privacyClassification: input.privacyClassification ?? 'INTERNAL',
        reusable: input.reusable ?? false,
      }, records, counters);
      await this.emit(actor, CommercialMemoryEvents.Recorded, record, { recordId: record.id, kind: record.kind, productId: record.productId, decisionId: record.decisionId, actionId: record.actionId }, scope);
      return copy(record);
    }, { tenantId: actor.tenantId });
  }

  /** Store the expectation/actual discrepancy and a reusable learning record. */
  async recordDecisionOutcome(actor: CommercialActor, input: RecordDecisionOutcomeInput): Promise<{ outcome: CommercialMemoryRecord; learning: CommercialMemoryRecord; links: AttributionLink[] }> {
    assertManager(actor);
    if (!input.decisionId.trim() || !input.productId.trim() || !input.conclusion.trim() || !input.learning.trim() || !input.evidence.length) {
      throw new CommercialMemoryError('Decision outcome requires decision, product, conclusion, learning, and evidence.');
    }
    validateMetric(input.expected);
    validateObservation(input.actual);
    const discrepancy = input.actual.value - input.expected.value;
    const outcome = await this.record(actor, {
      kind: 'OUTCOME', productId: input.productId, campaignId: input.campaignId, channel: input.channel, decisionId: input.decisionId, actionId: input.actionId,
      title: `Outcome for decision ${input.decisionId}`,
      summary: `${input.conclusion} Expected ${input.expected.metric}=${input.expected.value}; observed ${input.actual.value}; discrepancy=${discrepancy}.`,
      tags: ['outcome', input.actual.metric], expected: input.expected, actual: input.actual, evidence: input.evidence,
      confidence: averageConfidence(input.evidence), provenance: input.evidence[0]!.provenance, reusable: true,
    });
    const learning = await this.record(actor, {
      kind: 'LEARNING', productId: input.productId, campaignId: input.campaignId, channel: input.channel, decisionId: input.decisionId, actionId: input.actionId,
      title: `Learning from decision ${input.decisionId}`,
      summary: input.learning, tags: ['learning', input.actual.metric], expected: input.expected, actual: input.actual,
      evidence: input.evidence, confidence: averageConfidence(input.evidence), provenance: input.evidence[0]!.provenance, reusable: true,
    });
    const links: AttributionLink[] = [];
    links.push(await this.recordAttribution(actor, {
      from: { type: 'DECISION', entityId: input.decisionId, productId: input.productId, campaignId: input.campaignId },
      to: { type: 'OUTCOME', entityId: outcome.id, productId: input.productId, campaignId: input.campaignId },
      relation: input.relation ?? 'CORRELATION_SIGNAL', confidence: averageConfidence(input.evidence), causalMethod: input.causalMethod,
      evidence: input.evidence, provenance: input.evidence[0]!.provenance,
    }));
    if (input.actionId) {
      links.push(await this.recordAttribution(actor, {
        from: { type: 'ACTION', entityId: input.actionId, productId: input.productId, campaignId: input.campaignId },
        to: { type: 'OUTCOME', entityId: outcome.id, productId: input.productId, campaignId: input.campaignId },
        relation: 'CORRELATION_SIGNAL', confidence: averageConfidence(input.evidence), evidence: input.evidence, provenance: input.evidence[0]!.provenance,
      }));
    }
    await this.emit(actor, CommercialMemoryEvents.LearningRecorded, learning, { learningId: learning.id, outcomeId: outcome.id, decisionId: input.decisionId, discrepancy });
    return { outcome, learning, links };
  }

  /**
   * Correlation and causal evidence are different first-class relations.
   * A causal relation requires an explicit method and independently credible evidence.
   */
  async recordAttribution(actor: CommercialActor, input: RecordAttributionLinkInput): Promise<AttributionLink> {
    assertManager(actor);
    if (!input.evidence.length || !input.provenance.source.trim()) throw new CommercialMemoryError('Attribution link evidence and provenance are required.');
    assertScore(input.confidence, 'Attribution confidence');
    if (input.relation === 'CAUSAL_EVIDENCE') {
      const sourceCount = new Set(input.evidence.map((item) => item.source)).size;
      if (!input.causalMethod?.trim() || sourceCount < 2 || input.evidence.some((item) => !CAUSAL_EVIDENCE_STATUSES.has(item.status))) {
        throw new CommercialMemoryError('Causal evidence requires an explicit method and at least two measured/demonstrated/repeated/verified evidence sources.');
      }
    }
    if (input.relation === 'CAUSAL_HYPOTHESIS' && !input.causalMethod?.trim()) {
      throw new CommercialMemoryError('A causal hypothesis requires an explicit causal method or rationale.');
    }
    const from = await this.getOrCreateNode(actor, input.from);
    const to = await this.getOrCreateNode(actor, input.to);
    const existing = (await this.links.query({ where: (link) => link.tenantId === actor.tenantId && link.fromNodeId === from.id && link.toNodeId === to.id && link.relation === input.relation && link.causalMethod === input.causalMethod, limit: 1 }))[0];
    if (existing) return copy(existing);
    const link: AttributionLink = {
      id: randomUUID(), tenantId: actor.tenantId, fromNodeId: from.id, toNodeId: to.id, relation: input.relation,
      confidence: input.confidence, causalMethod: input.causalMethod, evidence: copy(input.evidence), provenance: copy(input.provenance), createdAt: Date.now(),
    };
    await this.links.put(link);
    await this.controlPlane.publishEvent(actor, {
      eventType: CommercialMemoryEvents.AttributionLinked, source: 'commercial-memory', entityId: link.id, correlationId: link.id,
      payload: { linkId: link.id, relation: link.relation, fromNodeId: link.fromNodeId, toNodeId: link.toNodeId },
      provenance: link.provenance, privacyClassification: 'INTERNAL', idempotencyKey: `attribution:${link.id}`,
    });
    return copy(link);
  }

  async query(actor: CommercialActor, query: CommercialMemoryQuery = {}): Promise<CommercialMemoryRecord[]> {
    const records = await this.records.query({
      where: (record) => record.tenantId === actor.tenantId &&
        (query.kind === undefined || record.kind === query.kind) &&
        (query.productId === undefined || record.productId === query.productId) &&
        (query.campaignId === undefined || record.campaignId === query.campaignId) &&
        (query.channel === undefined || record.channel === query.channel) &&
        (!query.reusableOnly || record.reusable) &&
        (query.tags === undefined || query.tags.every((tag) => record.tags.includes(tag))),
      orderBy: 'sequence', order: 'desc', limit: query.limit,
    });
    return records.map(copy);
  }

  async listAttribution(actor: CommercialActor): Promise<AttributionLink[]> {
    return (await this.links.query({ where: (link) => link.tenantId === actor.tenantId, orderBy: 'createdAt', order: 'asc' })).map(copy);
  }

  async verifyIntegrity(actor: CommercialActor, tenantId = actor.tenantId): Promise<{ valid: boolean; records: number; brokenAt?: number; reason?: string }> {
    if (tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new CommercialMemoryError('Cross-tenant integrity verification is not authorized.');
    const records = await this.records.query({ where: (record) => record.tenantId === tenantId, orderBy: 'sequence', order: 'asc' });
    let previousHash = 'GENESIS';
    let sequence = 0;
    for (const record of records) {
      if (record.sequence !== sequence + 1) return { valid: false, records: records.length, brokenAt: record.sequence, reason: 'Memory sequence is discontinuous.' };
      if (record.previousHash !== previousHash) return { valid: false, records: records.length, brokenAt: record.sequence, reason: 'Memory hash chain is discontinuous.' };
      if (record.hash !== hashRecord({ ...record, hash: '' })) return { valid: false, records: records.length, brokenAt: record.sequence, reason: 'Memory record hash does not match its canonical payload.' };
      previousHash = record.hash;
      sequence = record.sequence;
    }
    return { valid: true, records: records.length };
  }

  /** Durable handler effect: memory record + `commercial.memory.recorded` commit as ONE composed write (T-05). */
  private async captureCommercialEvent(event: CommercialEvent): Promise<void> {
    if (!event?.id || !event.tenantId || !event.eventType) return;
    const id = `event:${event.id}`;
    await this.storage.atomically(async (scope) => {
      const records = await scope.collection<CommercialMemoryRecord>(RECORDS_COLLECTION);
      const counters = await scope.collection<MemorySequenceCounter>(RECORDS_SEQ_COLLECTION);
      if (await records.get(id)) return; // idempotent redelivery
      const evidence: CommercialEvidence = {
        id: `event-evidence:${event.id}`, status: 'OBSERVED', source: event.source, observedAt: event.timestamp, confidence: 100,
        summary: `Observed versioned commercial event ${event.eventType}.`, provenance: copy(event.provenance), privacyClassification: event.privacyClassification,
      };
      const record = await this.append({
        id, tenantId: event.tenantId, kind: 'RAW_EVENT', title: event.eventType, summary: JSON.stringify(event.payload), tags: ['event', event.eventType],
        evidence: [evidence], confidence: 100, provenance: copy(event.provenance), privacyClassification: event.privacyClassification, reusable: false,
      }, records, counters);
      const actor: CommercialActor = { id: 'commercial-memory-system', tenantId: event.tenantId, roles: ['system'] };
      await this.emit(actor, CommercialMemoryEvents.Recorded, record, { recordId: record.id, kind: record.kind, sourceEventId: event.id }, scope);
    }, { tenantId: event.tenantId });
  }

  private async getOrCreateNode(actor: CommercialActor, input: RecordAttributionLinkInput['from']): Promise<AttributionNode> {
    const id = `${actor.tenantId}:${input.type}:${input.entityId}`;
    const existing = await this.nodes.get(id);
    if (existing) return existing;
    const node: AttributionNode = { id, tenantId: actor.tenantId, type: input.type, entityId: input.entityId, productId: input.productId, campaignId: input.campaignId, createdAt: Date.now() };
    await this.nodes.put(node);
    return node;
  }

  /**
   * Append with T-06 CAS sequence allocation (control-plane CAS-counter
   * pattern): the per-tenant counter is advanced atomically (row-lock CAS,
   * 64-round convergence) in the SAME transaction/scope as the record write,
   * and the predecessor hash is read after the advance (the row lock orders
   * this writer after every concurrently committed writer, keeping the hash
   * chain continuous). Callers must pass the scope-bound collections inside
   * one composed write.
   */
  private async append(
    input: Omit<CommercialMemoryRecord, 'id' | 'sequence' | 'previousHash' | 'hash' | 'createdAt'> & { id?: string; createdAt?: number },
    records: ICollection<CommercialMemoryRecord>,
    counters: ICollection<MemorySequenceCounter>,
  ): Promise<CommercialMemoryRecord> {
    const sequence = await this.nextSequence(input.tenantId, counters);
    const previous = (await records.query({ where: (record) => record.tenantId === input.tenantId && record.sequence < sequence, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
    const draft: Omit<CommercialMemoryRecord, 'hash'> = {
      ...input,
      id: input.id ?? randomUUID(),
      sequence,
      previousHash: previous?.hash ?? 'GENESIS',
      createdAt: input.createdAt ?? Date.now(),
    };
    const record: CommercialMemoryRecord = { ...draft, hash: hashRecord({ ...draft, hash: '' }) };
    await records.put(record);
    return record;
  }

  /** CAS-advance the per-tenant atomic sequence counter (bounded 64 rounds). */
  private async nextSequence(tenantId: string, counters: ICollection<MemorySequenceCounter>): Promise<number> {
    const counterId = `seq:${tenantId}`;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await counters.get(counterId);
      const observed = current ?? { id: counterId, tenantId, sequence: 0 };
      const next: MemorySequenceCounter = { id: counterId, tenantId, sequence: observed.sequence + 1 };
      const res = await counters.cas(
        counterId,
        (candidate) => (candidate?.sequence ?? 0) === observed.sequence,
        () => next,
      );
      if (res.ok) return next.sequence;
      // Lost a create/advance race (first-create election or another writer):
      // re-read and retry. On PostgreSQL the loser's INSERT was refused
      // (ON CONFLICT DO NOTHING) rather than overwriting the winner.
    }
    throw new CommercialMemoryError('Commercial memory sequence counter CAS exhausted retries.');
  }

  private async emit(actor: CommercialActor, eventType: string, record: CommercialMemoryRecord, payload: Record<string, unknown>, scope?: StorageWriteScope): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'commercial-memory', collectedAt: now, correlationId: record.id, causationId: record.provenance.causationId };
    await this.controlPlane.publishEvent(
      actor,
      { eventType, source: 'commercial-memory', entityId: record.id, correlationId: record.id, causationId: record.provenance.causationId, payload, provenance, privacyClassification: record.privacyClassification, idempotencyKey: `${eventType}:${record.id}` },
      scope ? { scope } : {},
    );
  }
}

function observedCommercialEvents(): string[] {
  return [
    'commercial.decision.proposed', 'commercial.decision.authorized', 'commercial.action.verified', 'commercial.action.failed',
    'payment.verified', 'payment.refund.verified', 'billing.invoice.paid', 'billing.invoice.refunded',
    'revenue.recorded', 'revenue.reversed', 'revenue.cost.recorded', 'reconciliation.completed',
    'commercial.analytics.snapshot.calculated', 'opportunity.scored', 'opportunity.recommendation', 'portfolio.assessed',
    'visibility.asset.distributed', 'distribution.published', 'distribution.failed',
  ];
}

function validateMemoryInput(input: RecordCommercialMemoryInput): void {
  if (!input.title.trim() || !input.summary.trim() || !input.evidence.length || !input.provenance.source.trim()) throw new CommercialMemoryError('Memory title, summary, evidence, and provenance are required.');
  assertScore(input.confidence, 'Memory confidence');
  if (input.expected) validateMetric(input.expected);
  if (input.actual) validateObservation(input.actual);
}
function validateMetric(metric: NonNullable<RecordCommercialMemoryInput['expected']>): void { if (!metric.metric.trim() || !metric.unit.trim() || !metric.method.trim() || !Number.isFinite(metric.value)) throw new CommercialMemoryError('Expected metric requires name, finite value, unit, and method.'); }
function validateObservation(metric: NonNullable<RecordCommercialMemoryInput['actual']>): void { validateMetric(metric); if (!Number.isFinite(metric.observedAt) || metric.observedAt <= 0) throw new CommercialMemoryError('Observed metric requires a valid timestamp.'); }
function averageConfidence(evidence: readonly CommercialEvidence[]): number { return evidence.length ? Math.round((evidence.reduce((sum, item) => sum + item.confidence, 0) / evidence.length) * 100) / 100 : 0; }
function assertScore(value: number, name: string): void { if (!Number.isFinite(value) || value < 0 || value > 100) throw new CommercialMemoryError(`${name} must be from 0 to 100.`); }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new CommercialMemoryError('Commercial operator role is required.'); }
function hashRecord(record: CommercialMemoryRecord): string { return createHash('sha256').update(stable(record)).digest('hex'); }
function stable(value: unknown): string { if (value === undefined) return 'null'; if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`; }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
