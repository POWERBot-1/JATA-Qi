// Deterministic loop state machine.
//
// Encodes the canonical stage order and the legal status transitions. The
// driver may only advance one stage at a time, in order. A stage may COMPLETE,
// SKIP (boundary explicitly represented), or HOLD a boundary. It must never
// jump over order-dependent governance (PLAN cannot reach EXECUTE without
// AUTHORIZE; AUTHORITY cannot bypass POLICY; OUTCOME requires verification).

import { InvalidTransitionError, type LoopStage, type StageStatus } from './types.js';

/** Canonical stage order (index = position). */
export const LOOP_STAGES: readonly LoopStage[] = [
  'WAKE',
  'OBSERVE',
  'INGEST',
  'NORMALIZE',
  'IDENTIFY',
  'ESTABLISH_CONTEXT',
  'ASSESS_WORLD_STATE',
  'RETRIEVE_KNOWLEDGE',
  'RETRIEVE_MEMORY',
  'BUILD_OR_UPDATE_WORLD_MODEL',
  'GENERATE_HYPOTHESES',
  'CAUSAL_ANALYSIS',
  'PROBABILISTIC_ASSESSMENT',
  'TEMPORAL_REASONING',
  'MULTI_AGENT_DELIBERATION',
  'META_REASONING',
  'CONTRADICTION_DETECTION',
  'UNCERTAINTY_ASSESSMENT',
  'POLICY',
  'SAFETY',
  'AUTHORITY',
  'HUMAN_OR_REGULATORY_GATE',
  'AUTHORIZE',
  'CAPABILITY_SELECTION',
  'PLAN',
  'VERIFY_PLAN',
  'EXECUTE',
  'OBSERVE_RESULT',
  'VERIFY_RESULT',
  'RECONCILE',
  'UPDATE_STATE',
  'AUDIT',
  'OUTCOME',
  'CONTINUE_OR_SLEEP',
] as const;

const STAGE_INDEX = new Map<LoopStage, number>(LOOP_STAGES.map((stage, index) => [stage, index]));

/** Legal per-stage outcomes. Anything else is rejected. */
const LEGAL_STATUS: ReadonlySet<StageStatus> = new Set<StageStatus>([
  'COMPLETED',
  'BOUNDARY_HELD',
  'SKIPPED',
  'FAILED',
]);

/**
 * Stages that, when they HOLD a governance boundary, force the loop down the
 * fail-closed path (no execution may follow). Execution-side stages are simply
 * not entered; the loop proceeds directly to AUDIT/OUTCOME with the boundary
 * recorded.
 */
export const GOVERNANCE_GATE_STAGES: ReadonlySet<LoopStage> = new Set<LoopStage>([
  'POLICY',
  'SAFETY',
  'AUTHORITY',
  'HUMAN_OR_REGULATORY_GATE',
  'AUTHORIZE',
  'VERIFY_PLAN',
  'VERIFY_RESULT',
]);

/**
 * Stages that must not be SKIPPED when the task proposes an external action —
 * skipping them would bypass governance. (Reasoning stages may legitimately
 * SKIP when a capability/engine is absent; the boundary is then recorded.)
 */
export const MANDATORY_FOR_ACTION: ReadonlySet<LoopStage> = new Set<LoopStage>([
  'POLICY',
  'SAFETY',
  'AUTHORITY',
  'AUTHORIZE',
  'VERIFY_RESULT',
  'AUDIT',
  'OUTCOME',
]);

export class LoopStateMachine {
  private cursor = -1;
  private current: LoopStage | undefined;
  private readonly executed: LoopStage[] = [];

  /** Enter the first stage (WAKE). */
  start(): LoopStage {
    if (this.cursor !== -1) throw new InvalidTransitionError('(none)', 'WAKE');
    return this.advance('WAKE');
  }

  /** Enter the next stage in canonical order. */
  next(): LoopStage {
    const nextIndex = this.cursor + 1;
    const nextStage = LOOP_STAGES[nextIndex];
    if (!nextStage) throw new InvalidTransitionError(this.current ?? '(none)', '(end)');
    return this.advance(nextStage);
  }

  private advance(stage: LoopStage): LoopStage {
    const expectedIndex = STAGE_INDEX.get(stage)!;
    if (expectedIndex !== this.cursor + 1) {
      throw new InvalidTransitionError(this.current ?? '(none)', stage);
    }
    this.cursor = expectedIndex;
    this.current = stage;
    this.executed.push(stage);
    return stage;
  }

  /** Validate the status reported for the current stage. */
  validateStatus(status: StageStatus): void {
    if (!LEGAL_STATUS.has(status)) {
      throw new InvalidTransitionError(this.current ?? '(none)', `status:${status}`);
    }
  }

  get currentStage(): LoopStage | undefined {
    return this.current;
  }

  get stageIndex(): number {
    return this.cursor;
  }

  get executedStages(): readonly LoopStage[] {
    return this.executed;
  }

  get isFinished(): boolean {
    return this.cursor >= LOOP_STAGES.length - 1;
  }

  /** Index helper used by tests/audit. */
  static indexOf(stage: LoopStage): number {
    return STAGE_INDEX.get(stage) ?? -1;
  }
}
