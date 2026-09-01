import type {
  ActionExecutionContext,
  ActionRollbackContext,
  AdapterExecutionResult,
  AdapterVerificationResult,
} from '@jataqi/autonomous-action-runtime';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';

export type EngineeringTaskStatus =
  | 'DRAFT'
  | 'READY'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'BLOCKED'
  | 'FAILED'
  | 'RETRYING'
  | 'ESCALATED'
  | 'CANCELLED';

export interface EngineeringTask {
  id: string;
  tenantId: string;
  ventureId?: string;
  productId?: string;
  title: string;
  description: string;
  taskType: string;
  dependencies: string[];
  priority: number;
  estimatedComplexity: number;
  requiredCapabilities: string[];
  agentAssignment?: string;
  testRequirements: string[];
  completionCriteria: string[];
  maxAttempts: number;
  attemptCount: number;
  status: EngineeringTaskStatus;
  actionId?: string;
  result?: CodingTaskResult;
  verificationEvidence: CommercialEvidence[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  failureReason?: string;
}

export interface CreateEngineeringTaskInput {
  ventureId?: string;
  productId?: string;
  title: string;
  description: string;
  taskType: string;
  dependencies?: string[];
  priority: number;
  estimatedComplexity: number;
  requiredCapabilities: string[];
  testRequirements: string[];
  completionCriteria: string[];
  maxAttempts?: number;
}

export interface CodingTaskResult {
  summary: string;
  artifactReferences: string[];
  testResults?: Array<{ name: string; passed: boolean; detail?: string }>;
  patchReference?: string;
  reportedAt: number;
}

export interface CodingAgentWorkerContext {
  task: EngineeringTask;
  action: ActionExecutionContext['action'];
  actor: CommercialActor;
  signal: AbortSignal;
}

/** Worker interface only; a real coding provider must be injected by the host. */
export interface CodingAgentWorker {
  id: string;
  tenantId?: string;
  capabilities: string[];
  environment: 'sandbox' | 'controlled';
  maxAttempts?: number;
  defaultTimeoutMs?: number;
  execute(context: CodingAgentWorkerContext): Promise<AdapterExecutionResult & { taskResult?: Omit<CodingTaskResult, 'reportedAt'> }>;
  verify(context: CodingAgentWorkerContext): Promise<AdapterVerificationResult>;
  rollback?(context: ActionRollbackContext): Promise<{ confirmed: boolean; summary?: string }>;
}

export interface RegisteredCodingAgent {
  id: string;
  tenantId: string;
  capabilities: string[];
  environment: 'sandbox' | 'controlled';
  maxAttempts: number;
  defaultTimeoutMs: number;
  rollbackSupported: boolean;
}

export interface ExecuteEngineeringTaskInput {
  decisionId: string;
  idempotencyKey: string;
  /** Defaults to true so the worker is not called until real execution is explicit. */
  dryRun?: boolean;
  rollbackStrategy?: string;
}

export const CodingAgentActionType = 'CODING_TASK_EXECUTE';
