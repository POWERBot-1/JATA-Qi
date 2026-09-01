import type {
  ActionExecutionContext,
  ActionRollbackContext,
  AdapterExecutionResult,
  AdapterVerificationResult,
} from '@jataqi/autonomous-action-runtime';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';

export const DeploymentActionType = 'DEPLOYMENT_EXECUTE';

export type DeploymentEnvironment = 'development' | 'test' | 'sandbox' | 'staging' | 'controlled_production' | 'production';

export type DeploymentState =
  | 'PLANNED'
  | 'APPROVAL_REQUIRED'
  | 'QUEUED'
  | 'DEPLOYING'
  | 'VERIFYING'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'FAILED'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK'
  | 'BLOCKED'
  | 'CANCELLED';

export interface DeploymentHealthCheck {
  name: string;
  required: boolean;
  passed: boolean;
  detail?: string;
  observedAt: number;
}

export interface DeploymentRecord {
  id: string;
  tenantId: string;
  ventureId?: string;
  productId: string;
  releaseVersion: string;
  artifactReference: string;
  targetSystem: string;
  environment: DeploymentEnvironment;
  rollbackTarget?: string;
  requiredHealthChecks: string[];
  validationEvidence: CommercialEvidence[];
  actionId?: string;
  state: DeploymentState;
  attemptCount: number;
  healthChecks: DeploymentHealthCheck[];
  verificationEvidence: CommercialEvidence[];
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
  deployedAt?: number;
  verifiedAt?: number;
  rolledBackAt?: number;
}

export interface CreateDeploymentInput {
  ventureId?: string;
  productId: string;
  releaseVersion: string;
  artifactReference: string;
  targetSystem: string;
  environment: DeploymentEnvironment;
  rollbackTarget?: string;
  requiredHealthChecks: string[];
  validationEvidence: CommercialEvidence[];
}

export interface DeploymentAdapterContext {
  deployment: DeploymentRecord;
  action: ActionExecutionContext['action'];
  actor: CommercialActor;
  signal: AbortSignal;
}

export interface DeploymentVerificationResult extends AdapterVerificationResult {
  healthChecks: DeploymentHealthCheck[];
  observedReleaseVersion?: string;
}

/** Injected deployment provider; no cloud or VPS client is bundled. */
export interface DeploymentAdapter {
  id: string;
  tenantId?: string;
  targetSystem: string;
  environments: DeploymentEnvironment[];
  maxAttempts?: number;
  defaultTimeoutMs?: number;
  productionEnabled?: boolean;
  deploy(context: DeploymentAdapterContext): Promise<AdapterExecutionResult>;
  verify(context: DeploymentAdapterContext): Promise<DeploymentVerificationResult>;
  rollback?(context: ActionRollbackContext): Promise<{ confirmed: boolean; summary?: string }>;
}

export interface RegisteredDeploymentAdapter {
  id: string;
  tenantId: string;
  targetSystem: string;
  environments: DeploymentEnvironment[];
  maxAttempts: number;
  defaultTimeoutMs: number;
  productionEnabled: boolean;
  rollbackSupported: boolean;
}

export interface ExecuteDeploymentInput {
  decisionId: string;
  idempotencyKey: string;
  dryRun?: boolean;
}
