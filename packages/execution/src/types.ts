// Types for Universal Execution Layer, Plan-Execute-Verify-Rollback, and Human Governance

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type WorkflowStatus =
  | 'PLANNED'
  | 'CHECKPOINTED'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'VERIFICATION_FAILED'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK'
  | 'COMPLETED'
  | 'REQUIRES_HUMAN_APPROVAL'
  | 'ABORTED';

export interface ToolDefinition {
  name: string;
  capability: string;
  inputSchema: unknown;
  outputSchema: unknown;
  permissions: string[];
  riskLevel: RiskLevel;
  authRequired: boolean;
  rateLimitPerMin?: number;
  timeoutMs?: number;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface WorkflowStep {
  stepId: string;
  toolName: string;
  input: Record<string, unknown>;
  compensatingAction?: {
    toolName: string;
    input: Record<string, unknown>;
  };
}

export interface ExecutionPlan {
  planId: string;
  mission: string;
  steps: WorkflowStep[];
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

export interface WorkflowCheckpoint {
  checkpointId: string;
  planId: string;
  stateSnapshot: Record<string, unknown>;
  timestamp: string;
}

export interface SandboxEnvironment {
  sandboxId: string;
  cpuLimitCores: number;
  memoryLimitMb: number;
  timeoutMs: number;
  allowOutboundNetwork: boolean;
  activeFiles: Map<string, string>;
}
