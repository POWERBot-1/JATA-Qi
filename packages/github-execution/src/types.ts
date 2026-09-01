import type {
  ActionExecutionContext,
  ActionRollbackContext,
  AdapterExecutionResult,
  AdapterVerificationResult,
  RuntimeExecutionOptions,
  RuntimePlanInput,
} from '@jataqi/autonomous-action-runtime';
import type { CommercialActor, CommercialEvidence, ConnectorCapability, ConnectorHealth } from '@jataqi/commercial-control-plane';

export type GitHubActionType =
  | 'GITHUB_REPOSITORY_INSPECT'
  | 'GITHUB_REPOSITORY_CREATE'
  | 'GITHUB_BRANCH_CREATE'
  | 'GITHUB_ISSUE_CREATE'
  | 'GITHUB_TASK_CREATE'
  | 'GITHUB_PULL_REQUEST_CREATE'
  | 'GITHUB_PULL_REQUEST_UPDATE'
  | 'GITHUB_CODE_CHANGE'
  | 'GITHUB_REVIEW_REQUEST'
  | 'GITHUB_TEST_RUN'
  | 'GITHUB_CI_RUN'
  | 'GITHUB_RELEASE_CREATE'
  | 'GITHUB_DEPLOYMENT_TRIGGER'
  | 'GITHUB_ROLLBACK';

export type GitHubExecutionStatus =
  | 'UNCONFIGURED'
  | 'BLOCKED_CREDENTIALS'
  | 'BLOCKED_PERMISSION'
  | 'READY_FOR_APPROVAL'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'LIVE_VERIFIED';

export interface GitHubExecutionClient {
  /** Client implementation owns authentication; raw tokens never enter this package API. */
  connect?(context: { tenantId: string; credentialReference?: string; signal: AbortSignal }): Promise<void>;
  authenticate?(context: { tenantId: string; credentialReference?: string; signal: AbortSignal }): Promise<void>;
  health(context: { tenantId: string; signal: AbortSignal }): Promise<{ health: ConnectorHealth; reason?: string; observedAt: number }>;
  capabilities(context: { tenantId: string; signal: AbortSignal }): Promise<ConnectorCapability>;
  execute(context: ActionExecutionContext): Promise<AdapterExecutionResult>;
  verify(context: ActionExecutionContext): Promise<AdapterVerificationResult>;
  rollback?(context: ActionRollbackContext): Promise<{ confirmed: boolean; summary?: string }>;
  disconnect?(context: { tenantId: string; credentialReference?: string; signal: AbortSignal }): Promise<void>;
}

export interface ConfigureGitHubExecutionInput {
  tenantId?: string;
  /** Secret-manager key only, such as secret://github/org-app; never a token. */
  credentialReference?: string;
  environment?: 'sandbox' | 'production';
  client?: GitHubExecutionClient;
  supportedActions?: GitHubActionType[];
  requiredPermissions?: string[];
  productionEnabled?: boolean;
}

export interface GitHubExecutionConnection {
  id: string;
  /** Ephemeral registry record used by commercial decisions as connectorId. */
  connectorRegistrationId?: string;
  tenantId: string;
  environment: 'sandbox' | 'production';
  credentialReference?: string;
  status: GitHubExecutionStatus;
  connectorHealth: ConnectorHealth;
  supportedActions: GitHubActionType[];
  requiredPermissions: string[];
  productionEnabled: boolean;
  lastCheckedAt?: number;
  liveVerifiedAt?: number;
  verificationEvidence?: CommercialEvidence[];
  reason?: string;
}

export interface GitHubExecutionPlanInput extends Omit<RuntimePlanInput, 'targetSystem'> {
  connectionId: string;
}

export interface GitHubExecutionRunOptions extends RuntimeExecutionOptions {
  /** A verified production connection is required for real production execution. */
  requireLiveVerification?: boolean;
}

export interface GitHubExecutionResult {
  actionId: string;
  status: GitHubExecutionStatus;
  executedExternally: boolean;
  executionState: string;
}

export const GitHubActions = Object.freeze({
  RepositoryInspect: 'GITHUB_REPOSITORY_INSPECT' as GitHubActionType,
  RepositoryCreate: 'GITHUB_REPOSITORY_CREATE' as GitHubActionType,
  BranchCreate: 'GITHUB_BRANCH_CREATE' as GitHubActionType,
  IssueCreate: 'GITHUB_ISSUE_CREATE' as GitHubActionType,
  TaskCreate: 'GITHUB_TASK_CREATE' as GitHubActionType,
  PullRequestCreate: 'GITHUB_PULL_REQUEST_CREATE' as GitHubActionType,
  PullRequestUpdate: 'GITHUB_PULL_REQUEST_UPDATE' as GitHubActionType,
  CodeChange: 'GITHUB_CODE_CHANGE' as GitHubActionType,
  ReviewRequest: 'GITHUB_REVIEW_REQUEST' as GitHubActionType,
  TestRun: 'GITHUB_TEST_RUN' as GitHubActionType,
  CiRun: 'GITHUB_CI_RUN' as GitHubActionType,
  ReleaseCreate: 'GITHUB_RELEASE_CREATE' as GitHubActionType,
  DeploymentTrigger: 'GITHUB_DEPLOYMENT_TRIGGER' as GitHubActionType,
  Rollback: 'GITHUB_ROLLBACK' as GitHubActionType,
});

export const DefaultGitHubActions: readonly GitHubActionType[] = Object.freeze(Object.values(GitHubActions));
