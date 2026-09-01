import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor } from '@jataqi/commercial-control-plane';
import {
  ReproducibilityEvents,
  type RecordReproducibilityInput,
  type ReplicationAttempt,
  type ReproducibilityRecord,
  type VerifyReproducibilityInput,
  type VersionedReference,
} from './types.js';

const RECORDS_COLLECTION = 'reproducibility.records';
const ATTEMPTS_COLLECTION = 'reproducibility.attempts';

export class ReproducibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReproducibilityError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Records reproducibility metadata and compares supplied re-execution metadata
 * and output hashes. It never executes code, accesses a dataset, or asserts an
 * experiment has been physically replicated.
 */
export class ReproducibilityService {
  private api!: KernelApi;
  private records!: ICollection<ReproducibilityRecord>;
  private attempts!: ICollection<ReplicationAttempt>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.records = await storage.collection<ReproducibilityRecord>(RECORDS_COLLECTION);
    this.attempts = await storage.collection<ReplicationAttempt>(ATTEMPTS_COLLECTION);
  }

  async record(actor: CommercialActor, input: RecordReproducibilityInput): Promise<ReproducibilityRecord> {
    assertActor(actor);
    validateInput(input);
    const now = Date.now();
    const record: ReproducibilityRecord = {
      id: randomUUID(), tenantId: actor.tenantId, projectId: input.projectId, kind: input.kind,
      datasetReferences: copy(sortedReferences(input.datasetReferences)), algorithm: copy(input.algorithm), environment: copy(input.environment),
      parameters: copy(input.parameters), deterministic: input.deterministic, randomSeed: input.randomSeed,
      inputFingerprint: fingerprint(input), outputHash: hash(input.output), benchmarkReference: input.benchmarkReference,
      status: reproducibilityStatus(input.deterministic, input.randomSeed), provenance: copy(input.provenance), createdAt: now, updatedAt: now,
    };
    await this.records.put(record);
    await this.api.bus.emit(ReproducibilityEvents.Recorded, { recordId: record.id, tenantId: record.tenantId, status: record.status, inputFingerprint: record.inputFingerprint, outputHash: record.outputHash });
    return copy(record);
  }

  /** Compare a supplied re-execution record against the immutable run fingerprint/output hash. */
  async verify(actor: CommercialActor, recordId: string, input: VerifyReproducibilityInput): Promise<ReplicationAttempt> {
    assertActor(actor);
    validateInput(input);
    const record = await this.requireRecord(actor, recordId);
    const inputFingerprint = fingerprint(input);
    const outputHash = hash(input.output);
    let status: ReplicationAttempt['status'];
    let reason: string | undefined;
    if (record.status === 'INCOMPLETE' || reproducibilityStatus(input.deterministic, input.randomSeed) === 'INCOMPLETE') {
      status = 'INCOMPLETE';
      reason = 'Deterministic execution or a recorded random seed is required for a reproducibility claim.';
    } else if (inputFingerprint !== record.inputFingerprint) {
      status = 'MISMATCH';
      reason = 'Dataset, algorithm, environment, parameters, determinism, or seed fingerprint differs from the recorded run.';
    } else if (outputHash !== record.outputHash) {
      status = 'MISMATCH';
      reason = 'Output hash differs from the recorded run.';
    } else {
      status = 'REPRODUCIBLE';
    }
    const attempt: ReplicationAttempt = {
      id: randomUUID(), tenantId: record.tenantId, recordId: record.id, inputFingerprint, outputHash, status, reason,
      provenance: copy(input.provenance), createdAt: Date.now(),
    };
    await this.attempts.put(attempt);
    await this.records.put({ ...record, status, updatedAt: attempt.createdAt });
    await this.api.bus.emit(status === 'REPRODUCIBLE' ? ReproducibilityEvents.Verified : ReproducibilityEvents.Mismatch, { recordId: record.id, attemptId: attempt.id, status, reason });
    return copy(attempt);
  }

  async getRecord(actor: CommercialActor, recordId: string): Promise<ReproducibilityRecord | undefined> {
    const record = await this.records.get(recordId);
    return record && canRead(actor, record.tenantId) ? copy(record) : undefined;
  }

  async listAttempts(actor: CommercialActor, recordId: string): Promise<ReplicationAttempt[]> {
    await this.requireRecord(actor, recordId);
    return (await this.attempts.query({ where: (attempt) => attempt.recordId === recordId, orderBy: 'createdAt', order: 'asc' })).map(copy);
  }

  private async requireRecord(actor: CommercialActor, recordId: string): Promise<ReproducibilityRecord> {
    const record = await this.getRecord(actor, recordId);
    if (!record) throw new ReproducibilityError('Reproducibility record not found.');
    return record;
  }
}

function validateInput(input: RecordReproducibilityInput | VerifyReproducibilityInput): void {
  if (!input.datasetReferences.length || !input.algorithm.id.trim() || !input.algorithm.version.trim() || !input.environment.id.trim() || !input.environment.version.trim() || !input.provenance.source.trim()) throw new ReproducibilityError('Dataset, algorithm, environment, and provenance version references are required.');
  for (const reference of [...input.datasetReferences, input.algorithm, input.environment]) validateReference(reference);
  if (!input.deterministic && !input.randomSeed?.trim()) {
    // This remains a valid record but cannot be declared reproducible.
  }
}
function validateReference(reference: VersionedReference): void { if (!reference.id.trim() || !reference.version.trim()) throw new ReproducibilityError('Versioned references require id and version.'); }
function reproducibilityStatus(deterministic: boolean, randomSeed: string | undefined): ReproducibilityRecord['status'] { return deterministic || Boolean(randomSeed?.trim()) ? 'RECORDED' : 'INCOMPLETE'; }
function fingerprint(input: Pick<RecordReproducibilityInput, 'datasetReferences' | 'algorithm' | 'environment' | 'parameters' | 'deterministic' | 'randomSeed'>): string {
  return hash({ datasetReferences: sortedReferences(input.datasetReferences), algorithm: input.algorithm, environment: input.environment, parameters: input.parameters, deterministic: input.deterministic, randomSeed: input.randomSeed });
}
function sortedReferences(references: readonly VersionedReference[]): VersionedReference[] { return [...references].map(copy).sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version)); }
function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function stable(value: unknown): string { if (value === undefined) return 'null'; if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`; }
function assertActor(actor: CommercialActor): void { if (!actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new ReproducibilityError('A tenant-bound actor is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
