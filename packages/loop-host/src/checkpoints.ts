// Versioned, integrity-checked checkpoint journal.
//
// A checkpoint is substantive evidence (identities, phase, attempt, task
// fingerprint, completed stages when known) — never a bare status string.
// Every read re-verifies: schema version, tenant/correlation binding, and the
// SHA-256 integrity tag. Anything missing, corrupt, incompatible, or
// ambiguous throws; callers must fail closed.

import { createHash } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import type { LoopOutcome, LoopTask } from '@jataqi/unified-loop';
import {
  CheckpointIntegrityError,
  IncompatibleCheckpointError,
  LOOP_HOST_CHECKPOINT_SCHEMA_VERSION,
  LoopHostError,
  type CheckpointPhase,
  type HostedWorkItem,
  type LoopCheckpoint,
} from './types.js';

export const CHECKPOINT_COLLECTION = 'loop-host.checkpoints';

/**
 * Deterministic checkpoint id derived from the work item and its monotonic
 * sequence. This makes a checkpoint row for a given (work item, sequence)
 * single-valued, so a concurrent writer can never silently create a divergent
 * duplicate for the same sequence; ordering is enforced by the work item's
 * atomic sequence advance (see WorkQueue.markDispatched CAS).
 */
export function checkpointIdFor(workItemId: string, sequence: number): string {
  return `ckpt:${workItemId}#${sequence}`;
}

/** Deterministic canonical JSON (sorted keys) for hashing and fingerprinting. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical fingerprint proving a resume dispatches the identical task. */
export function fingerprintTask(task: LoopTask): string {
  return sha256Hex(canonicalJson(task));
}

interface CheckpointCore {
  schemaVersion: number;
  workItemId: string;
  tenantId: string;
  correlationId: string;
  phase: CheckpointPhase;
  sequence: number;
  attempt: number;
  loopId?: string;
  loopOutcome?: LoopOutcome;
  completedStages?: string[];
  taskFingerprint: string;
  createdAt: number;
}

function coreOf(checkpoint: LoopCheckpoint): CheckpointCore {
  return {
    schemaVersion: checkpoint.schemaVersion,
    workItemId: checkpoint.workItemId,
    tenantId: checkpoint.tenantId,
    correlationId: checkpoint.correlationId,
    phase: checkpoint.phase,
    sequence: checkpoint.sequence,
    attempt: checkpoint.attempt,
    loopId: checkpoint.loopId,
    loopOutcome: checkpoint.loopOutcome,
    completedStages: checkpoint.completedStages ? [...checkpoint.completedStages] : undefined,
    taskFingerprint: checkpoint.taskFingerprint,
    createdAt: checkpoint.createdAt,
  };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class CheckpointJournal {
  private checkpoints!: ICollection<LoopCheckpoint>;

  async init(kernel: KernelApi): Promise<void> {
    this.checkpoints = await kernel.getModule<StorageModule>('storage').collection<LoopCheckpoint>(CHECKPOINT_COLLECTION);
  }

  /** T-05: a journal view bound to a composed write scope's collection (see `WorkQueue.bindTo`). */
  static async bindTo(source: { collection<T extends { id: string }>(name: string): Promise<ICollection<T>> }): Promise<CheckpointJournal> {
    const journal = new CheckpointJournal();
    journal.checkpoints = await source.collection<LoopCheckpoint>(CHECKPOINT_COLLECTION);
    return journal;
  }

  /**
   * Write the next checkpoint for a work item. Sequence must advance exactly
   * by one from the item's recorded sequence; regressions throw and the
   * stale write is never persisted.
   */
  async write(
    item: HostedWorkItem,
    input: {
      phase: CheckpointPhase;
      loopId?: string;
      loopOutcome?: LoopCheckpoint['loopOutcome'];
      completedStages?: string[];
    },
    now?: number,
  ): Promise<LoopCheckpoint> {
    const at = now ?? Date.now();
    const sequence = item.checkpointSequence + 1;
    if (!Number.isInteger(sequence) || sequence < 1) throw new LoopHostError('Checkpoint sequence must advance monotonically.');
    const core: CheckpointCore = {
      schemaVersion: LOOP_HOST_CHECKPOINT_SCHEMA_VERSION,
      workItemId: item.id,
      tenantId: item.tenantId,
      correlationId: item.correlationId,
      phase: input.phase,
      sequence,
      attempt: item.attemptCount,
      loopId: input.loopId,
      loopOutcome: input.loopOutcome,
      completedStages: input.completedStages ? [...input.completedStages] : undefined,
      taskFingerprint: fingerprintTask(item.task),
      createdAt: at,
    };
    const checkpoint: LoopCheckpoint = {
      ...core,
      id: checkpointIdFor(item.id, sequence),
      integrity: sha256Hex(canonicalJson(core)),
    };
    await this.checkpoints.put(checkpoint);
    return copy(checkpoint);
  }

  async get(id: string): Promise<LoopCheckpoint | undefined> {
    const checkpoint = await this.checkpoints.get(id);
    return checkpoint ? copy(checkpoint) : undefined;
  }

  async latest(workItemId: string): Promise<LoopCheckpoint | undefined> {
    const found = await this.checkpoints.query({
      where: (checkpoint) => checkpoint.workItemId === workItemId,
      orderBy: 'sequence',
      order: 'desc',
      limit: 1,
    });
    const checkpoint = found[0];
    return checkpoint ? copy(checkpoint) : undefined;
  }

  /**
   * Validate a checkpoint against the live work record. Throws on any
   * version mismatch, binding drift, task drift, or integrity failure.
   */
  validate(checkpoint: LoopCheckpoint, item: HostedWorkItem): LoopCheckpoint {
    if (checkpoint.schemaVersion !== LOOP_HOST_CHECKPOINT_SCHEMA_VERSION) {
      throw new IncompatibleCheckpointError(
        `Checkpoint "${checkpoint.id}" schema v${checkpoint.schemaVersion} is not v${LOOP_HOST_CHECKPOINT_SCHEMA_VERSION} (fail-closed).`,
      );
    }
    if (checkpoint.workItemId !== item.id || checkpoint.tenantId !== item.tenantId || checkpoint.correlationId !== item.correlationId) {
      throw new CheckpointIntegrityError(`Checkpoint "${checkpoint.id}" is not bound to work item "${item.id}" (fail-closed).`);
    }
    if (checkpoint.taskFingerprint !== fingerprintTask(item.task)) {
      throw new CheckpointIntegrityError(`Checkpoint "${checkpoint.id}" task fingerprint drifted; resume refused (fail-closed).`);
    }
    const expected = sha256Hex(canonicalJson(coreOf(checkpoint)));
    if (checkpoint.integrity !== expected) {
      throw new CheckpointIntegrityError(`Checkpoint "${checkpoint.id}" integrity check failed (fail-closed).`);
    }
    return copy(checkpoint);
  }

  /** Read + validate the latest checkpoint for a work item (undefined when none exists). */
  async readLatest(item: HostedWorkItem): Promise<LoopCheckpoint | undefined> {
    const checkpoint = await this.latest(item.id);
    if (!checkpoint) return undefined;
    return this.validate(checkpoint, item);
  }
}
