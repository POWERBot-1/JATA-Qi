// Native unified cognitive/execution loop — type definitions.
//
// W22 (C-1): this is the in-repo orchestrator. It drives JATA Qi's *existing*
// engines through a governed capability boundary; it is NOT a new intelligence
// engine and it performs no reasoning of its own. All cognitive/authority work
// is delegated to the registered capability fabric and commercial control plane.

import type { CommercialActor, CommercialProvenance } from '@jataqi/commercial-control-plane';

/**
 * Canonical loop stages, in mandated order. The driver transitions through
 * these explicitly; skipping an order-dependent stage (e.g. PLAN→EXECUTE)
 * fails closed.
 */
export type LoopStage =
  | 'WAKE'
  | 'OBSERVE'
  | 'INGEST'
  | 'NORMALIZE'
  | 'IDENTIFY'
  | 'ESTABLISH_CONTEXT'
  | 'ASSESS_WORLD_STATE'
  | 'RETRIEVE_KNOWLEDGE'
  | 'RETRIEVE_MEMORY'
  | 'BUILD_OR_UPDATE_WORLD_MODEL'
  | 'GENERATE_HYPOTHESES'
  | 'CAUSAL_ANALYSIS'
  | 'PROBABILISTIC_ASSESSMENT'
  | 'TEMPORAL_REASONING'
  | 'MULTI_AGENT_DELIBERATION'
  | 'META_REASONING'
  | 'CONTRADICTION_DETECTION'
  | 'UNCERTAINTY_ASSESSMENT'
  | 'POLICY'
  | 'SAFETY'
  | 'AUTHORITY'
  | 'HUMAN_OR_REGULATORY_GATE'
  | 'CAPABILITY_SELECTION'
  | 'PLAN'
  | 'VERIFY_PLAN'
  | 'AUTHORIZE'
  | 'EXECUTE'
  | 'OBSERVE_RESULT'
  | 'VERIFY_RESULT'
  | 'RECONCILE'
  | 'UPDATE_STATE'
  | 'AUDIT'
  | 'OUTCOME'
  | 'CONTINUE_OR_SLEEP';

/** Terminal disposition of a single stage execution. */
export type StageStatus =
  | 'ENTERED'
  | 'COMPLETED'
  | 'BOUNDARY_HELD' // stage ran and explicitly refused/escalated (fail-closed gate fired)
  | 'SKIPPED' // not applicable to this task; boundary represented, not fabricated
  | 'FAILED'; // error; loop halts fail-closed

/** Side-effect classification for a governed capability. */
export type SideEffectClass =
  | 'NONE' // pure read / compute / state record inside the fabric
  | 'SANDBOX' // may invoke a registered sandbox adapter
  | 'PRODUCTION'; // would touch external/production systems (never auto-run)

/** What the capability needs from the authority layer before it may run. */
export type AuthorityRequirement =
  | 'NONE' // internal, tenant-scoped, no external effect
  | 'POLICY_ONLY' // governed decision but no external execution
  | 'AUTHORIZED_ACTION'; // external action: decision + authorization + adapter required

/** Classification of the discrete cognitive records the loop maintains. */
export type CognitiveRecordKind =
  | 'BELIEF'
  | 'INTENT'
  | 'PLAN'
  | 'DECISION'
  | 'AUTHORIZATION'
  | 'ACTION'
  | 'RESULT';

/**
 * A governed capability contract. Every operation the loop can invoke is
 * declared up-front with its governance metadata. The loop never reaches into
 * a package's internals — it only calls `invoke` through the registry, after
 * checking grants/authority.
 */
export interface GovernedCapability {
  /** Stable capability identity, e.g. 'unified-loop.world-model'. */
  readonly capabilityId: string;
  /** Operation identity, e.g. 'build-world-model'. */
  readonly operation: string;
  /** Loop stage this capability serves. */
  readonly stage: LoopStage;
  readonly sideEffect: SideEffectClass;
  readonly authority: AuthorityRequirement;
  /** Required capability grants (a future capability-fabric integration point). */
  readonly requiredGrants: readonly string[];
  /** Hard timeout for the operation (ms); enforced by the loop. */
  readonly timeoutMs: number;
  /**
   * Execute the capability against the live loop context. Implementations call
   * existing JATA Qi engines. May return structured outputs that later stages
   * read. Must throw to fail; must never fabricate a result.
   */
  invoke(ctx: CapabilityInvocationContext): Promise<CapabilityResult>;
}

/** Context handed to a capability at invocation time. */
export interface CapabilityInvocationContext {
  readonly loopId: string;
  readonly actor: CommercialActor;
  readonly correlationId: string;
  /** Deterministic clock (ms). */
  now(): number;
  /** Task input supplied at WAKE. */
  readonly task: LoopTask;
  /** Mutable, tenant-bound working state for the current loop run. */
  readonly state: LoopWorkingState;
  signal: AbortSignal;
}

/** Structured result of a capability invocation. */
export interface CapabilityResult {
  /** Machine-readable summary of what happened (privacy-minimized). */
  summary: string;
  /** Records to append to the typed cognitive ledger. */
  records?: CognitiveRecord[];
  /** Free-form structured artifacts for later stages / the audit trace. */
  outputs?: Record<string, unknown>;
  /**
   * Set true when the capability intentionally held a boundary (e.g. denied,
   * required approval, could not verify). Drives fail-closed decisions.
   */
  boundaryHeld?: boolean;
}

/** A typed cognitive/execution ledger record (provenance-bearing). */
export interface CognitiveRecord {
  kind: CognitiveRecordKind;
  summary: string;
  /** Engine/system that produced the record. */
  source: string;
  /** External correlation/identifier in the underlying engine, when applicable. */
  externalRef?: string;
  provenance: CommercialProvenance;
  at: number;
}

/** Input to a loop run. */
export interface LoopTask {
  /** What the loop is asked to reason toward / do. */
  objective: string;
  /** Text observations to ingest at OBSERVE/INGEST (deterministic fixture). */
  observations?: string[];
  /** Natural-language knowledge query for RETRIEVE_KNOWLEDGE. */
  knowledgeQuery?: string;
  /**
   * A proposed external action, when the task intends execution. Omit for a
   * pure reasoning task (the loop will then reach POLICY and hold the boundary).
   */
  proposedAction?: ProposedAction;
  /**
   * Optional guarded identity boundary: when explicitly supplied, WAKE may
   * read/verify it through permanence-fabric. The loop never creates or issues
   * identity material and never calls signer-dependent APIs.
   */
  identityId?: string;
  /** Desired continuation policy; default TERMINATE. */
  continuation?: 'TERMINATE' | 'SLEEP';
}

/** A candidate external action the loop may plan/authorize/execute. */
export interface ProposedAction {
  actionType: string;
  targetSystem: string;
  targetResource?: string;
  parameters?: Record<string, unknown>;
  /** Risk/compliance/evidence scores used by the policy engine (0..100 style). */
  riskScore: number;
  complianceScore: number;
  evidenceStrength: number;
  /** Requested autonomy level 1..3 (3 = highest delegable authority). */
  authorizationLevel: number;
  /**
   * Explicitly require the human/regulatory gate (regardless of autonomy
   * level). High autonomy (>=3) always implies a gate. Never satisfied by the
   * loop itself.
   */
  gateRequired?: boolean;
  /** Product/venture context for the commercial decision. */
  productId: string;
  ventureId?: string;
  /** When true, run an actual (sandbox) action; when false/omitted dry-run. */
  executeForReal?: boolean;
}

/** Mutable, tenant-bound working state carried through a single loop run. */
export interface LoopWorkingState {
  tenantId: string;
  cognitiveStateId?: string;
  worldModelId?: string;
  causalModelId?: string;
  timelineId?: string;
  hypothesisSessionId?: string;
  deliberationId?: string;
  knowledgeHits?: number;
  decisionId?: string;
  authorizationId?: string;
  actionId?: string;
  verificationPassed?: boolean;
  reconciled?: boolean;
  /** Latest stage outputs keyed by stage name. */
  stageOutputs: Partial<Record<LoopStage, Record<string, unknown>>>;
}

/** One immutable stage entry in the audit trace. */
export interface StageTraceEntry {
  index: number;
  stage: LoopStage;
  status: StageStatus;
  capabilityId?: string;
  startedAt: number;
  endedAt: number;
  /** Privacy-minimized summary; never raw secrets or large content. */
  summary: string;
  correlationId: string;
  tenantId: string;
  /** Boundary/denial reason when status is BOUNDARY_HELD or FAILED. */
  reason?: string;
  error?: string;
}

/** Loop-level audit event (published on the kernel bus). */
export interface LoopAuditEvent {
  loopId: string;
  correlationId: string;
  tenantId: string;
  stage: LoopStage;
  status: StageStatus;
  at: number;
  summary: string;
}

export const UnifiedLoopEvents = Object.freeze({
  StageEntered: 'unified.loop.stage.entered',
  StageCompleted: 'unified.loop.stage.completed',
  LoopCompleted: 'unified.loop.completed',
  LoopFailed: 'unified.loop.failed',
  BoundaryHeld: 'unified.loop.boundary_held',
} as const);

/** Final disposition of a loop run. */
export type LoopOutcome =
  | 'COMPLETED_VERIFIED'
  | 'COMPLETED_DRY_RUN'
  | 'HELD_AT_GATE'
  | 'DENIED'
  | 'FAILED_CLOSED'
  | 'SLEEP_PENDING';

export interface LoopRunResult {
  loopId: string;
  correlationId: string;
  tenantId: string;
  outcome: LoopOutcome;
  /** Ordered stage trace (the reconstructable audit record). */
  trace: StageTraceEntry[];
  /**
   * Privacy-minimized structured outputs per stage (for audit/tests). Only
   * bounded summaries and identifiers are stored — no raw content or secrets.
   */
  stageOutputs: Partial<Record<LoopStage, Record<string, unknown>>>;
  /** Typed cognitive ledger (belief/intent/plan/decision/authorization/action/result). */
  records: CognitiveRecord[];
  finalStage: LoopStage;
  startedAt: number;
  endedAt: number;
  /** Continuation directive for CONTINUE_OR_SLEEP. */
  continuation: 'TERMINATE' | 'SLEEP';
  failureReason?: string;
}

export class UnifiedLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiedLoopError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised for an illegal stage transition — always fail-closed. */
export class InvalidTransitionError extends UnifiedLoopError {
  constructor(from: string, to: string) {
    super(`Invalid loop transition: ${from} → ${to}. The loop fails closed.`);
    this.name = 'InvalidTransitionError';
  }
}
