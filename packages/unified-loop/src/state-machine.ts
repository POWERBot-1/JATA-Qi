// Deterministic loop state machine.
//
// Encodes the canonical stage order and the legal status transitions. The
// driver may only advance one stage at a time, in order. A stage may COMPLETE,
// SKIP (boundary explicitly represented), or HOLD a boundary. It must never
// jump over order-dependent governance (PLAN cannot reach EXECUTE without
// AUTHORIZE; AUTHORITY cannot bypass POLICY; OUTCOME requires verification).

import { InvalidTransitionError, type LoopStage, type StageStatus } from './types.js';

/** Canonical stage order (index = position). T-01 hardens AUTHORIZE to
 *  precede capability selection, plan, and execution: a plan can never
 *  authorize itself. */
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
 * Stages that MUST run (not SKIPPED, not absent) when a task proposes an
 * external action. T-01 makes this an actual runtime invariant: a custom
 * capability set cannot bypass any of these stages. AUDIT and OUTCOME always
 * run (they are required even for reasoning-only loops so the audit trail
 * and outcome are recorded). The other entries are required only when an
 * external action is proposed.
 *
 * Stages that the loop may legitimately SKIP for a pure-reasoning task
 * (no proposed action) are NOT in this set. The set is the minimum
 * required for an action-capable loop; a missing entry fails the action
 * closed.
 */
export const MANDATORY_FOR_ACTION: ReadonlySet<LoopStage> = new Set<LoopStage>([
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
]);

/** Stages that always run (action or reasoning-only) so the audit trail
 *  and outcome are recorded. */
export const ALWAYS_MANDATORY: ReadonlySet<LoopStage> = new Set<LoopStage>([
  'AUDIT',
  'OUTCOME',
  'CONTINUE_OR_SLEEP',
]);

/** Result of a mandatory-stage audit. */
export interface MandatoryStageAudit {
  ok: boolean;
  /** Stages that the loop ran but reported SKIPPED. */
  skippedMandatory: readonly LoopStage[];
  /** Stages that the loop did not enter at all (no capability registered). */
  missingMandatory: readonly LoopStage[];
  /** Stages that ran but did not reach COMPLETED. */
  notCompleted: readonly LoopStage[];
}

/**
 * T-01 runtime invariant: a stage trace is checked for mandatory-stage
 * compliance. A trace that skips or omits a mandatory stage is an
 * invariant violation; the caller MUST fail closed (the loop driver
 * converts this into FAILED_CLOSED and refuses to report success).
 *
 * A SKIPPED mandatory stage is tolerated when the skip reason is
 * "after governance boundary held" (the loop correctly refuses to
 * proceed past a held gate). It is NOT tolerated when the skip reason
 * is anything else (e.g. "no governed capability registered") — that
 * would let a misconfigured capability set bypass governance.
 *
 * `trace` is the loop run's ordered stage trace. `registeredStages` is the
 * set of stages the driver had a registered capability for (used to
 * distinguish "skipped" from "missing").
 */
export function auditMandatoryStages(
  trace: readonly { stage: LoopStage; status: string; reason?: string }[],
  required: ReadonlySet<LoopStage>,
  registeredStages: ReadonlySet<LoopStage>,
): MandatoryStageAudit {
  const skippedMandatory: LoopStage[] = [];
  const missingMandatory: LoopStage[] = [];
  const notCompleted: LoopStage[] = [];
  // Identify whether a governance gate held in the trace. If so, the
  // SKIPPED statuses on later stages are an EXPECTED consequence of
  // fail-closed, not a violation.
  const governanceHeld = trace.some(
    (t) => t.status === 'BOUNDARY_HELD' && GOVERNANCE_GATE_STAGES.has(t.stage),
  );
  for (const stage of required) {
    const entry = trace.find((t) => t.stage === stage);
    if (!entry) {
      // Stage not entered at all → must be missing (not registered).
      missingMandatory.push(stage);
      continue;
    }
    if (entry.status === 'SKIPPED') {
      // A skip is acceptable when (a) governance held, OR (b) the
      // skip reason explicitly says the stage was not applicable
      // because no action was proposed AND the stage is action-only.
      // Always-mandatory stages (AUDIT, OUTCOME, CONTINUE_OR_SLEEP)
      // are NEVER tolerated as SKIPPED — they must run regardless.
      const isAlwaysMandatory = ALWAYS_MANDATORY.has(stage);
      const isActionPath = stage === 'POLICY' || stage === 'SAFETY' || stage === 'AUTHORITY' ||
        stage === 'HUMAN_OR_REGULATORY_GATE' || EXECUTION_PATH_STAGES.has(stage);
      const skipIsGovernance = governanceHeld && (entry.reason ?? '').toLowerCase().includes('governance boundary held');
      const skipIsNoAction = isActionPath && (entry.reason ?? '').toLowerCase().includes('no external action proposed');
      if (isAlwaysMandatory) {
        skippedMandatory.push(stage);
      } else if (!skipIsGovernance && !skipIsNoAction) {
        skippedMandatory.push(stage);
      }
      continue;
    }
    if (entry.status !== 'COMPLETED' && entry.status !== 'BOUNDARY_HELD') {
      // A mandatory stage that ran but failed (FAILED, or anything other
      // than COMPLETED/BOUNDARY_HELD) is also a violation.
      notCompleted.push(stage);
    }
  }
  // For "missing" detection, also check the registeredStages set: a stage
  // can be present in the trace and skipped (registered but SKIPPED) OR
  // absent from the trace (never registered). Both are violations for a
  // mandatory stage; the distinction is purely diagnostic.
  void registeredStages;
  const ok = skippedMandatory.length === 0 && missingMandatory.length === 0 && notCompleted.length === 0;
  return { ok, skippedMandatory, missingMandatory, notCompleted };
}

/** Execution-path stages (T-01). Mirrors the unified-loop service's
 *  EXECUTION_PATH_STAGES for audit-time checks. */
const EXECUTION_PATH_STAGES: ReadonlySet<LoopStage> = new Set<LoopStage>([
  'CAPABILITY_SELECTION',
  'PLAN',
  'VERIFY_PLAN',
  'EXECUTE',
  'OBSERVE_RESULT',
  'VERIFY_RESULT',
  'RECONCILE',
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
