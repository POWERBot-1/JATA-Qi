// Native unified-loop driver (W22 C-1).
//
// This is JATA Qi owning its cognitive/execution loop. It advances through the
// canonical stage state machine, invokes governed capabilities through the
// registry, maintains tenant-bound working state, records an immutable audit
// trace, and fails closed on any governance boundary or error. It does NOT
// reason itself and does NOT grant authority — all authority is delegated to
// the commercial control plane.

import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import type { CommercialActor } from '@jataqi/commercial-control-plane';

import { CapabilityRegistry } from './capability-registry.js';
import { buildDefaultCapabilities } from './capability-adapters.js';
import { LOOP_STAGES, LoopStateMachine, GOVERNANCE_GATE_STAGES } from './state-machine.js';
import {
  UnifiedLoopError,
  UnifiedLoopEvents,
  type CapabilityResult,
  type CognitiveRecord,
  type GovernedCapability,
  type LoopAuditEvent,
  type LoopOutcome,
  type LoopRunResult,
  type LoopStage,
  type LoopTask,
  type LoopWorkingState,
  type StageTraceEntry,
  type StageStatus,
} from './types.js';

export interface RunLoopOptions {
  /** Deterministic clock; defaults to Date.now. Inject for reproducible tests. */
  now?: () => number;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Override capability set (defaults to the full governed engine set). */
  capabilities?: GovernedCapability[];
  /** Correlation id; defaults to a fresh id per run. */
  correlationId?: string;
}

const EXECUTION_PATH_STAGES: ReadonlySet<LoopStage> = new Set<LoopStage>([
  'CAPABILITY_SELECTION',
  'PLAN',
  'VERIFY_PLAN',
  'AUTHORIZE',
  'EXECUTE',
  'OBSERVE_RESULT',
  'VERIFY_RESULT',
  'RECONCILE',
]);

export class UnifiedLoopService {
  constructor(private readonly kernel: KernelApi) {}

  private registry(extra?: GovernedCapability[]): CapabilityRegistry {
    const registry = new CapabilityRegistry();
    for (const cap of extra ?? buildDefaultCapabilities()) registry.register(cap);
    return registry;
  }

  /** Execute a complete governed loop for one task/actor. */
  async runLoop(actor: CommercialActor, task: LoopTask, options: RunLoopOptions = {}): Promise<LoopRunResult> {
    if (!actor || !actor.id.trim() || !actor.tenantId.trim() || actor.roles.length === 0) {
      throw new UnifiedLoopError('A tenant-bound actor with roles is required to run the loop.');
    }
    if (!task.objective.trim()) throw new UnifiedLoopError('A loop task objective is required.');

    const now = options.now ?? Date.now;
    const loopId = randomUUID();
    const correlationId = options.correlationId ?? `loop:${loopId}`;
    const startedAt = now();
    const registry = this.registry(options.capabilities);

    const state: LoopWorkingState = {
      tenantId: actor.tenantId,
      stageOutputs: {},
    };

    const trace: StageTraceEntry[] = [];
    const records: CognitiveRecord[] = [];
    const sm = new LoopStateMachine();

    // Governance latches: once a gate holds, execution-side stages are skipped
    // (fail-closed); reasoning/audit stages still complete to record why.
    let governanceHeld = false;
    let holdReason = '';

    const emit = (stage: LoopStage, status: StageStatus, summary: string): void => {
      const event: LoopAuditEvent = { loopId, correlationId, tenantId: actor.tenantId, stage, status, at: now(), summary };
      void this.kernel.bus.emit(status === 'BOUNDARY_HELD' ? UnifiedLoopEvents.BoundaryHeld : UnifiedLoopEvents.StageCompleted, event);
    };

    try {
      let stage = sm.start();
      let index = 0;
      // Drive every canonical stage exactly once, in order.
      while (true) {
        const stageStarted = now();
        const cap = registry.get(stage);

        // Decide whether this stage is skipped because a governance boundary
        // was already held (execution path must not proceed).
        const onExecutionPath = EXECUTION_PATH_STAGES.has(stage);
        const skipBecauseGateHeld = governanceHeld && onExecutionPath;
        // Action-only stages with no proposed action are not applicable.
        const actionStage = stage === 'POLICY' || stage === 'SAFETY' || stage === 'AUTHORITY' ||
          stage === 'HUMAN_OR_REGULATORY_GATE' || onExecutionPath;
        const skipBecauseNoAction = !task.proposedAction && (onExecutionPath);

        let status: StageStatus;
        let summary = '';
        let reason: string | undefined;
        let result: CapabilityResult | undefined;

        if (skipBecauseGateHeld || skipBecauseNoAction) {
          status = 'SKIPPED';
          reason = skipBecauseGateHeld ? `Skipped after governance boundary held: ${holdReason}` : 'No external action proposed; execution path not applicable.';
          summary = reason;
        } else if (!cap) {
          // No governed capability for this stage: represent the boundary
          // explicitly rather than fabricating functionality.
          status = actionStage && task.proposedAction ? 'FAILED' : 'SKIPPED';
          reason = actionStage && task.proposedAction
            ? `Required governed capability for ${stage} is not registered (fail-closed).`
            : `No governed capability registered for ${stage}; boundary represented, not fabricated.`;
          summary = reason;
          if (status === 'FAILED') throw new UnifiedLoopError(reason);
        } else {
          try {
            result = await registry.invoke(cap, {
              loopId,
              actor,
              correlationId,
              now,
              task,
              state,
              signal: options.signal ?? new AbortController().signal,
              // Attach the live kernel (non-enumerable) so adapters resolve engines.
              ...({ __kernel: this.kernel } as object),
            } as CapabilityInvocationContextShim);
            status = result.boundaryHeld ? 'BOUNDARY_HELD' : 'COMPLETED';
            summary = result.summary;
            if (result.records) records.push(...result.records);
            if (result.outputs) state.stageOutputs[stage] = result.outputs;

            if (result.boundaryHeld) {
              // Governance gates and execution/verification boundaries latch the
              // execution path fail-closed. Cognitive contradiction detection is
              // advisory and does not by itself halt the loop.
              const latch =
                GOVERNANCE_GATE_STAGES.has(stage) ||
                stage === 'EXECUTE' ||
                stage === 'PLAN' ||
                stage === 'CAPABILITY_SELECTION';
              if (latch) {
                governanceHeld = true;
                holdReason = `${stage}: ${result.summary}`;
              }
            }
          } catch (err) {
            status = 'FAILED';
            summary = `Capability ${cap.capabilityId} failed: ${(err as Error).message}`;
            trace.push({
              index, stage, status, capabilityId: cap.capabilityId,
              startedAt: stageStarted, endedAt: now(), summary,
              correlationId, tenantId: actor.tenantId, error: (err as Error).message,
            });
            emit(stage, 'FAILED', summary);
            throw err;
          }
        }

        sm.validateStatus(status);
        trace.push({
          index,
          stage,
          status,
          capabilityId: cap?.capabilityId,
          startedAt: stageStarted,
          endedAt: now(),
          summary,
          correlationId,
          tenantId: actor.tenantId,
          reason,
        });
        emit(stage, status, summary);

        if (sm.isFinished) break;
        stage = sm.next();
        index += 1;
      }

      const endedAt = now();
      const outcome = deriveOutcome(state, task, governanceHeld);
      const continuation = task.continuation === 'SLEEP' ? 'SLEEP' : 'TERMINATE';
      const result: LoopRunResult = {
        loopId,
        correlationId,
        tenantId: actor.tenantId,
        outcome,
        trace,
        stageOutputs: { ...state.stageOutputs },
        records,
        finalStage: trace[trace.length - 1]!.stage,
        startedAt,
        endedAt,
        continuation,
      };
      void this.kernel.bus.emit(UnifiedLoopEvents.LoopCompleted, {
        loopId, correlationId, tenantId: actor.tenantId, outcome, at: endedAt, stages: trace.length,
      } as LoopCompletedEvent);
      return result;
    } catch (err) {
      const endedAt = now();
      const failed: LoopRunResult = {
        loopId,
        correlationId,
        tenantId: actor.tenantId,
        outcome: 'FAILED_CLOSED',
        trace,
        stageOutputs: { ...state.stageOutputs },
        records,
        finalStage: sm.currentStage ?? 'WAKE',
        startedAt,
        endedAt,
        continuation: 'TERMINATE',
        failureReason: (err as Error).message,
      };
      void this.kernel.bus.emit(UnifiedLoopEvents.LoopFailed, {
        loopId, correlationId, tenantId: actor.tenantId, at: endedAt, error: (err as Error).message,
      } as LoopFailedEvent);
      return failed;
    }
  }
}

type CapabilityInvocationContextShim = Parameters<GovernedCapability['invoke']>[0];

interface LoopCompletedEvent {
  loopId: string;
  correlationId: string;
  tenantId: string;
  outcome: LoopOutcome;
  at: number;
  stages: number;
}
interface LoopFailedEvent {
  loopId: string;
  correlationId: string;
  tenantId: string;
  at: number;
  error: string;
}

function deriveOutcome(state: LoopWorkingState, task: LoopTask, governanceHeld: boolean): LoopOutcome {
  if (task.continuation === 'SLEEP' && !governanceHeld) return 'SLEEP_PENDING';
  if (!task.proposedAction) return 'COMPLETED_DRY_RUN'; // reasoning-only path
  const auth = state.stageOutputs['AUTHORIZE'] as Record<string, unknown> | undefined;
  const verify = state.stageOutputs['VERIFY_RESULT'] as Record<string, unknown> | undefined;
  const gate = state.stageOutputs['HUMAN_OR_REGULATORY_GATE'] as Record<string, unknown> | undefined;
  // Explicit policy DENY is a hard denial (distinct from a gate that waits).
  if (auth?.outcome === 'DENY') return 'DENIED';
  // A required human/regulatory gate that cannot be satisfied in-loop is a gate hold.
  if (gate?.gateRequired === true) return 'HELD_AT_GATE';
  if (governanceHeld || auth?.allowed !== true) return 'HELD_AT_GATE';
  if (verify?.verified === true) return 'COMPLETED_VERIFIED';
  if (verify?.dryRun === true) return 'COMPLETED_DRY_RUN';
  return 'FAILED_CLOSED';
}
