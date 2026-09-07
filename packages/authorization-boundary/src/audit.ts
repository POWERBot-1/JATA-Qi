// Durable, privacy-safe authorization provenance sinks.
//
// Records are privacy-safe BY CONSTRUCTION: they reference credentials
// (id/audience/scopes) and approvals (id) but never carry secret material,
// raw tokens, prompts, or tool I/O. The storage sink additionally refuses to
// persist any record that would contain a field the schema does not expect,
// so a future code change cannot smuggle a secret into durable provenance.

import type { ICollection } from '@jataqi/storage';
import type { A01AuditRecord, A01AuditSink } from './types.js';

/** In-memory sink for tests and diagnostics. */
export class InMemoryAuditSink implements A01AuditSink {
  readonly records: A01AuditRecord[] = [];
  record(record: A01AuditRecord): void {
    this.records.push(record);
  }
  decisions(): A01AuditRecord[] {
    return this.records.filter((record) => record.kind === 'DECISION');
  }
  consumed(): A01AuditRecord[] {
    return this.records.filter((record) => record.kind === 'CONSUMED');
  }
  clear(): void {
    this.records.length = 0;
  }
}

const ALLOWED_AUDIT_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'kind',
  'principalId',
  'tenantId',
  'agentId',
  'runId',
  'correlationId',
  'causationId',
  'capabilityId',
  'capabilityVersion',
  'tool',
  'operation',
  'targetSystem',
  'targetResource',
  'dataClassification',
  'impact',
  'decision',
  'reasonCodes',
  'policyVersion',
  'approvalReference',
  'credentialReference',
  'envelopeId',
  'idempotencyKey',
  'decidedAt',
  'consumedAt',
  'sideEffectInvoked',
  'idempotentReplay',
]);

/**
 * Durable sink backed by a storage collection. Every decision lands in
 * durable state (or the write throws, which the gate converts to a
 * fail-closed DENY with AUDIT_UNAVAILABLE).
 */
export class StorageAuditSink implements A01AuditSink {
  constructor(private readonly collection: Pick<ICollection, 'put'>) {}

  async record(record: A01AuditRecord): Promise<void> {
    // Defense in depth: reject anything outside the closed field set.
    for (const key of Object.keys(record)) {
      if (!ALLOWED_AUDIT_FIELDS.has(key)) {
        throw new Error(`authorization audit: unknown field "${key}" would be persisted (privacy-safe schema violation)`);
      }
    }
    const reference = record.credentialReference;
    if (reference && typeof reference.credentialId !== 'string') {
      throw new Error('authorization audit: credentialReference.credentialId must be a string');
    }
    await this.collection.put(record as unknown as { id: string });
  }
}

/** Fan-out sink: every record goes to every child sink. */
export class CompositeAuditSink implements A01AuditSink {
  constructor(private readonly sinks: readonly A01AuditSink[]) {}

  async record(record: A01AuditRecord): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.record(record)));
  }
}
