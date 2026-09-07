// Durable, privacy-safe authorization provenance sinks.
//
// Records are privacy-safe BY CONSTRUCTION: they reference credentials
// (id/audience/scopes) and approvals (id) but never carry secret material,
// raw tokens, prompts, or tool I/O. The storage sink additionally refuses to
// persist any record that would contain a field the schema does not expect,
// so a future code change cannot smuggle a secret into durable provenance.

import type { ICollection } from '@jataqi/storage';
import type { A01AuditRecord, A01AuditSink, A01AuthorizationEnvelope } from './types.js';

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
  // R2 S-10 extensions: durable citations on DECISION/CONSUMED rows.
  'manifestId',
  'manifestDigest',
  'sessionEventId',
  'sessionStatus',
  'securityStoreTxId',
  // R2 S-10 credential-lifecycle rows (CREDENTIAL_ISSUED/REVOKED).
  'credentialId',
  'audience',
  'scopes',
  'issuedBy',
  'issuedAt',
  'expiresAt',
  'revokedAt',
  'revocationReason',
  'recordedAt',
  // R2 S-10 retention/GC batch rows (GC_BATCH).
  'collection',
  'deletedCount',
  'markedExpiredCount',
  'maintenanceBy',
  'startedAt',
  'completedAt',
]);

/**
 * R2: the closed S-10 field set, shared by the sink AND the in-transaction
 * receipt writers (single source of truth — a field allowed in one channel
 * is allowed in both, and nothing else is persistable in either).
 */
export function assertAllowedAuditShape(record: Record<string, unknown>, context: string): void {
  for (const key of Object.keys(record)) {
    if (!ALLOWED_AUDIT_FIELDS.has(key)) {
      throw new Error(`${context}: unknown field "${key}" would be persisted (privacy-safe schema violation)`);
    }
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`${context}: audit row requires a non-empty string id`);
  }
}

/**
 * Durable sink backed by a storage collection. Every decision lands in
 * durable state (or the write throws, which the gate converts to a
 * fail-closed DENY with AUDIT_UNAVAILABLE).
 */
export class StorageAuditSink implements A01AuditSink {
  constructor(private readonly collection: Pick<ICollection, 'put'>) {}

  async record(record: A01AuditRecord): Promise<void> {
    // Defense in depth: reject anything outside the closed field set.
    assertAllowedAuditShape(record as unknown as Record<string, unknown>, 'authorization audit');
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

/**
 * Build the DECISION audit record for a sealed envelope. Shared by the R1
 * sync path and the R2 durable path (single implementation — no drift).
 * R2 durable citations are copied from the envelope when present.
 */
export function buildDecisionAuditRecord(envelope: A01AuthorizationEnvelope): A01AuditRecord {
  return {
    id: `decision-${envelope.decision.decisionId}`,
    kind: 'DECISION',
    principalId: envelope.principal.id,
    tenantId: envelope.tenantId,
    agentId: envelope.agent.agentId,
    runId: envelope.run.runId,
    correlationId: envelope.provenance.correlationId,
    ...(envelope.provenance.causationId ? { causationId: envelope.provenance.causationId } : {}),
    capabilityId: envelope.capability.capabilityId,
    capabilityVersion: envelope.capability.capabilityVersion,
    tool: envelope.tool,
    operation: envelope.operation,
    targetSystem: envelope.target.system,
    ...(envelope.target.resource ? { targetResource: envelope.target.resource } : {}),
    dataClassification: envelope.dataClassification,
    impact: envelope.impact,
    decision: envelope.decision.decision,
    reasonCodes: [...envelope.decision.reasonCodes],
    policyVersion: envelope.decision.policyVersion,
    ...(envelope.approval ? { approvalReference: envelope.approval.approvalId } : {}),
    ...(envelope.credential
      ? { credentialReference: { credentialId: envelope.credential.credentialId, audience: envelope.credential.audience, scopes: [...envelope.credential.scopes] } }
      : {}),
    envelopeId: envelope.envelopeId,
    ...(envelope.provenance.idempotencyKey ? { idempotencyKey: envelope.provenance.idempotencyKey } : {}),
    decidedAt: envelope.decision.decidedAt,
    ...(envelope.manifestId !== undefined ? { manifestId: envelope.manifestId } : {}),
    ...(envelope.manifestDigest !== undefined ? { manifestDigest: envelope.manifestDigest } : {}),
    ...(envelope.sessionEventId !== undefined ? { sessionEventId: envelope.sessionEventId } : {}),
    ...(envelope.sessionStatus !== undefined ? { sessionStatus: envelope.sessionStatus } : {}),
    ...(envelope.securityStoreTxId !== undefined ? { securityStoreTxId: envelope.securityStoreTxId } : {}),
  };
}

/**
 * Build the CONSUMED audit record for a sealed envelope. Shared by the R1
 * sync path and the R2 durable path (single implementation — no drift).
 */
export function buildConsumedAuditRecord(
  envelope: A01AuthorizationEnvelope,
  options: {
    readonly consumedAt: number;
    readonly sideEffectInvoked: boolean;
    readonly detail: string;
    readonly idempotentReplay?: boolean;
    readonly securityStoreTxId?: string;
  },
): A01AuditRecord {
  return {
    id: `consumed-${envelope.envelopeId}-${options.detail}`,
    kind: 'CONSUMED',
    principalId: envelope.principal.id,
    tenantId: envelope.tenantId,
    agentId: envelope.agent.agentId,
    runId: envelope.run.runId,
    correlationId: envelope.provenance.correlationId,
    ...(envelope.provenance.causationId ? { causationId: envelope.provenance.causationId } : {}),
    capabilityId: envelope.capability.capabilityId,
    capabilityVersion: envelope.capability.capabilityVersion,
    tool: envelope.tool,
    operation: envelope.operation,
    targetSystem: envelope.target.system,
    ...(envelope.target.resource ? { targetResource: envelope.target.resource } : {}),
    dataClassification: envelope.dataClassification,
    impact: envelope.impact,
    decision: envelope.decision.decision,
    reasonCodes: [...envelope.decision.reasonCodes],
    policyVersion: envelope.decision.policyVersion,
    ...(envelope.approval ? { approvalReference: envelope.approval.approvalId } : {}),
    ...(envelope.credential
      ? { credentialReference: { credentialId: envelope.credential.credentialId, audience: envelope.credential.audience, scopes: [...envelope.credential.scopes] } }
      : {}),
    envelopeId: envelope.envelopeId,
    ...(envelope.provenance.idempotencyKey ? { idempotencyKey: envelope.provenance.idempotencyKey } : {}),
    decidedAt: envelope.decision.decidedAt,
    consumedAt: options.consumedAt,
    sideEffectInvoked: options.sideEffectInvoked,
    ...(options.idempotentReplay !== undefined ? { idempotentReplay: options.idempotentReplay } : {}),
    ...(envelope.manifestId !== undefined ? { manifestId: envelope.manifestId } : {}),
    ...(envelope.manifestDigest !== undefined ? { manifestDigest: envelope.manifestDigest } : {}),
    ...(envelope.sessionEventId !== undefined ? { sessionEventId: envelope.sessionEventId } : {}),
    ...(envelope.sessionStatus !== undefined ? { sessionStatus: envelope.sessionStatus } : {}),
    ...(options.securityStoreTxId !== undefined ? { securityStoreTxId: options.securityStoreTxId } : {}),
  };
}
