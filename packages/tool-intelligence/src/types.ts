// JATA Qi Universal AI Tool Intelligence Layer — types.
//
// A standardized representation of any AI capability (model, tool, agent
// framework, connector) so JATA Qi can discover, register, evaluate, route,
// approve, invoke, fall back from, and govern tools uniformly — including
// tools it does not yet know about (status UNKNOWN_DISCOVERED).

export type ToolStatus =
  | 'DISCOVERED'
  | 'VERIFIED'
  | 'CONNECTED'
  | 'TESTING'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'DEPRECATED'
  | 'RETIRED'
  | 'BLOCKED'
  | 'UNKNOWN';

/** Risk classes R0..R5 (tool directive #18). */
export type RiskClass = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export type PrivacyClass = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

export type Protocol =
  | 'REST' | 'GraphQL' | 'WebSocket' | 'gRPC' | 'Webhook' | 'SSE'
  | 'CLI' | 'SDK' | 'MCP' | 'function' | 'local' | string;

/** A registered Tool Entity (tool directive #1). */
export interface ToolEntity {
  id: string;
  canonicalName: string;
  displayName: string;
  provider: string;
  version: string;
  category: string;
  capabilities: string[];
  modality?: string[];
  protocol: Protocol;
  riskClass: RiskClass;
  privacyClass: PrivacyClass;
  status: ToolStatus;
  endpoint?: string;
  authMethod?: string;
  /** 0..100 aggregate evaluation score (higher is better). */
  evaluationScore?: number;
  /** 0..100 reliability score. */
  reliabilityScore?: number;
  replacementCandidates?: string[];
  lastVerified?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/** A pluggable adapter that actually talks to a tool (tool directive #7). */
export interface ToolAdapter {
  readonly id: string;
  healthCheck?(): Promise<boolean>;
  capabilities(): string[];
  estimateCost?(input: unknown): number;
  validateInput?(input: unknown): string | undefined;
  validateOutput?(output: unknown): string | undefined;
  invoke(input: unknown, ctx: InvocationContext): Promise<unknown>;
}

export interface InvocationContext {
  toolId: string;
  principal?: { userId: string; username: string; roles: string[] };
  requestId: string;
}

export interface InvocationResult {
  requestId: string;
  toolId: string;
  status: 'success' | 'failure' | 'denied' | 'pending_approval';
  output?: unknown;
  error?: string;
  cost?: number;
  durationMs: number;
  auditRecordId?: string;
  /** Governance decision recorded by the mandatory pre-execution gate. */
  governance?: { decision: string; evaluationId?: string };
}

export type ApprovalDecision = 'approved' | 'denied';

export interface ApprovalRequest {
  id: string;
  toolId: string;
  principalId: string;
  action: string;
  reason?: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  expiresAt: number;
}

export interface ToolEvaluation {
  toolId: string;
  metric: string; // e.g. 'accuracy' | 'latency_ms' | 'cost_per_call' | 'failure_rate'
  value: number;
  ts: number;
}

export const ToolEvents = Object.freeze({
  ToolRegistered: 'tool.registered',
  ToolInvoked: 'tool.invoked',
  ToolFailed: 'tool.failed',
  ToolDeprecated: 'tool.deprecated',
  ApprovalRequested: 'tool.approval.requested',
  ApprovalDecided: 'tool.approval.decided',
} as const);

/** Risk classes that require human approval before invocation (tool directive #10/#18). */
export const APPROVAL_REQUIRED_CLASSES: ReadonlySet<RiskClass> = new Set(['R4', 'R5']);
