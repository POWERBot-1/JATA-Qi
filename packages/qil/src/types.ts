// QiL (Quantum Intelligence Language) — type definitions.
//
// QiL is the declarative orchestration language of JATA Qi (see Step 2 of the
// JATA AI specification). A QiL program expresses goals, agents, resources and a
// sequence of orchestration actions; it does not describe imperative steps. The
// compiler lowers a parsed program into an ExecutionPlan (a DAG of steps) that
// the orchestrator runtime interprets.

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

export type TokenType =
  | 'KEYWORD' // MISSION, GOAL, RETRIEVE, ... (all-uppercase identifiers)
  | 'IDENT' // agent names, object names, property keys
  | 'STRING' // "..." or '...'
  | 'NUMBER' // 42, 3.14
  | 'BOOLEAN' // true / false
  | 'ARROW' // ->  (used to express dependencies: RETRIEVE "x" -> ANALYZE)
  | 'LBRACE' // {
  | 'RBRACE' // }
  | 'COLON' // :
  | 'EQUALS' // =
  | 'COMMA' // ,
  | 'NEWLINE' // \n (mostly insignificant; emitted for diagnostics)
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

/** A coerced literal value for statement properties. */
export type Literal = string | number | boolean;

/**
 * A single QiL statement, e.g.:
 *   MISSION "Analyze the business" {
 *     GOAL "Identify risks"
 *     AGENT research
 *     RETRIEVE knowledge "revenue"
 *     REASON
 *     REPORT
 *   }
 */
export interface QiLStatement {
  /** The statement keyword (e.g. MISSION, AGENT, RETRIEVE). Always uppercase. */
  readonly keyword: string;
  /**
   * Optional subject identifier. For AGENT/TEAM this is the agent/team name;
   * for action statements it may name a core object (knowledge, model, ...).
   */
  readonly subject?: string;
  /** Optional string argument (the "what" of the statement). */
  readonly argument?: string;
  /** Named properties: key -> coerced literal. */
  readonly properties: Record<string, Literal>;
  /** Nested statements inside a `{ }` block. */
  readonly children: QiLStatement[];
  /** Source location (1-based) for diagnostics. */
  readonly line: number;
  readonly col: number;
}

export interface QiLProgram {
  readonly statements: QiLStatement[];
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Execution plan (lowered representation consumed by the orchestrator)
// ---------------------------------------------------------------------------

/**
 * The category of work a plan step represents. Each maps to a runtime action
 * in the orchestrator (retrieval, reasoning, reporting, ...).
 */
export type StepKind =
  | 'observe'
  | 'retrieve'
  | 'learn'
  | 'reason'
  | 'plan'
  | 'simulate'
  | 'synthesize'
  | 'analyze'
  | 'verify'
  | 'optimize'
  | 'execute'
  | 'report'
  | 'audit'
  | 'deploy'
  | 'stop';

/** A node in the execution DAG. */
export interface PlanStep {
  readonly id: string;
  readonly kind: StepKind;
  /** Original QiL keyword (e.g. RETRIEVE) for traceability/audit. */
  readonly keyword: string;
  /** Human-readable label (argument or subject). */
  readonly label?: string;
  /** String argument, if any. */
  readonly argument?: string;
  /** Named agent/team that should perform the step, if declared. */
  readonly agent?: string;
  /** Object referenced (e.g. "knowledge", "model"), if any. */
  readonly object?: string;
  /** IDs of steps that must complete before this one (DAG edges). */
  readonly dependsOn: string[];
  /** Properties propagated from the source statement. */
  readonly properties: Record<string, Literal>;
  /** Source line in the QiL program. */
  readonly line: number;
}

/** A compiled QiL program: a dependency graph plus declared objectives/agents. */
export interface ExecutionPlan {
  readonly id: string;
  readonly mission?: string;
  readonly goals: string[];
  readonly agents: string[];
  readonly teams: string[];
  readonly models: string[];
  readonly datasets: string[];
  readonly steps: PlanStep[];
  /** Source text the plan was compiled from. */
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  line?: number;
  col?: number;
}

/** Result of parsing/compiling QiL source. */
export interface QiLCompileResult {
  readonly ok: boolean;
  readonly diagnostics: Diagnostic[];
  readonly program?: QiLProgram;
  readonly plan?: ExecutionPlan;
}

// ---------------------------------------------------------------------------
// Keyword registry (derived from the Step 2 specification)
// ---------------------------------------------------------------------------

/** Structural statements — define objectives and group children. */
export const STRUCTURAL_KEYWORDS = ['MISSION', 'GOAL'] as const;

/** Declaration statements — name agents, teams, models, datasets. */
export const DECLARATION_KEYWORDS = ['AGENT', 'TEAM', 'MODEL', 'DATASET'] as const;

/**
 * Action statements — each lowers to a plan step. The mapping here is the
 * canonical keyword -> StepKind lowering used by the compiler.
 */
export const ACTION_KEYWORDS = {
  OBSERVE: 'observe',
  RETRIEVE: 'retrieve',
  LEARN: 'learn',
  REASON: 'reason',
  PLAN: 'plan',
  SIMULATE: 'simulate',
  SYNTHESIZE: 'synthesize',
  ANALYZE: 'analyze',
  VERIFY: 'verify',
  OPTIMIZE: 'optimize',
  EXECUTE: 'execute',
  REPORT: 'report',
  AUDIT: 'audit',
  DEPLOY: 'deploy',
  STOP: 'stop',
} as const;

export const ALL_KEYWORDS = new Set<string>([
  ...STRUCTURAL_KEYWORDS,
  ...DECLARATION_KEYWORDS,
  ...Object.keys(ACTION_KEYWORDS),
]);

/** Events emitted by the QiL module on the kernel bus. */
export const QiLEvents = Object.freeze({
  ProgramCompiled: 'qil.program.compiled',
  PlanCompiled: 'qil.plan.compiled',
  CompileError: 'qil.compile.error',
} as const);
