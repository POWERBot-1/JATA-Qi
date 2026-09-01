import type {
  ActionExecutionContext,
  ActionRollbackContext,
  AdapterExecutionResult,
  AdapterVerificationResult,
} from '@jataqi/autonomous-action-runtime';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';

export const TestRepairActionType = 'TEST_REPAIR_RUN';

export type TestRepairState =
  | 'DRAFT'
  | 'QUEUED'
  | 'BUILDING'
  | 'TESTING'
  | 'VERIFYING'
  | 'PASSED'
  | 'FAILED'
  | 'DIAGNOSING'
  | 'PATCH_PROPOSED'
  | 'PATCH_TESTING'
  | 'SECURITY_CHECKING'
  | 'REGRESSION_CHECKING'
  | 'VERIFIED'
  | 'ESCALATED'
  | 'CANCELLED';

/** A profile identifier, not a shell command. Runner implementations own allowlists. */
export interface TestExecutionRequest {
  profile: string;
  target: string;
  requiredChecks: string[];
  timeoutMs?: number;
}

export interface TestCheckResult {
  name: string;
  passed: boolean;
  detail?: string;
  artifactReference?: string;
}

export interface TestRepairResult {
  summary: string;
  build: TestCheckResult[];
  tests: TestCheckResult[];
  security: TestCheckResult[];
  regression: TestCheckResult[];
  artifactReferences: string[];
  completedAt: number;
}

export interface RepairDiagnostic {
  id: string;
  category: 'BUILD' | 'TEST' | 'SECURITY' | 'REGRESSION' | 'INFRASTRUCTURE' | 'UNKNOWN';
  summary: string;
  evidence: CommercialEvidence[];
  createdAt: number;
}

export interface RepairProposal {
  id: string;
  runId: string;
  patchReference: string;
  summary: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  testPlan: string[];
  requiresApproval: boolean;
  createdBy: string;
  createdAt: number;
  appliedAt?: number;
}

export interface TestRepairRun {
  id: string;
  tenantId: string;
  ventureId?: string;
  productId?: string;
  taskId?: string;
  workerId?: string;
  request: TestExecutionRequest;
  maxAttempts: number;
  attemptCount: number;
  actionId?: string;
  state: TestRepairState;
  result?: TestRepairResult;
  diagnostics: RepairDiagnostic[];
  proposals: RepairProposal[];
  verificationEvidence: CommercialEvidence[];
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CreateTestRepairRunInput {
  ventureId?: string;
  productId?: string;
  taskId?: string;
  request: TestExecutionRequest;
  maxAttempts?: number;
}

export interface TestRepairWorkerContext {
  run: TestRepairRun;
  action: ActionExecutionContext['action'];
  actor: CommercialActor;
  signal: AbortSignal;
}

/** Injected sandbox runner. It cannot execute raw shell input supplied by a model. */
export interface TestRepairWorker {
  id: string;
  tenantId?: string;
  profiles: string[];
  environment: 'sandbox' | 'controlled';
  maxAttempts?: number;
  defaultTimeoutMs?: number;
  execute(context: TestRepairWorkerContext): Promise<AdapterExecutionResult & { testRepairResult?: Omit<TestRepairResult, 'completedAt'> }>;
  verify(context: TestRepairWorkerContext): Promise<AdapterVerificationResult>;
  rollback?(context: ActionRollbackContext): Promise<{ confirmed: boolean; summary?: string }>;
}

export interface RegisteredTestRepairWorker {
  id: string;
  tenantId: string;
  profiles: string[];
  environment: 'sandbox' | 'controlled';
  maxAttempts: number;
  defaultTimeoutMs: number;
}

export interface StartTestRepairRunInput {
  decisionId: string;
  idempotencyKey: string;
  dryRun?: boolean;
}

export interface CreateRepairProposalInput {
  patchReference: string;
  summary: string;
  risk: RepairProposal['risk'];
  testPlan: string[];
  requiresApproval?: boolean;
  evidence: CommercialEvidence[];
}
