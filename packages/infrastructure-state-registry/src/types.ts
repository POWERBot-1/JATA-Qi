import type {
  ActionExecutionContext,
  ActionRollbackContext,
  AdapterExecutionResult,
  AdapterVerificationResult,
} from '@jataqi/autonomous-action-runtime';
import type { CommercialActor, CommercialEvidence, MonetaryValue } from '@jataqi/commercial-control-plane';

export const InfrastructureProvisionActionType = 'INFRASTRUCTURE_PROVISION';

export type InfrastructureResourceType =
  | 'VPS'
  | 'CLOUD_COMPUTE'
  | 'CONTAINER'
  | 'DATABASE'
  | 'CACHE'
  | 'NETWORK'
  | 'FIREWALL'
  | 'REVERSE_PROXY'
  | 'DNS_RECORD'
  | 'TLS_CERTIFICATE'
  | 'BACKUP'
  | 'MONITORING'
  | 'STORAGE'
  | 'QUEUE';

export type InfrastructureState =
  | 'PLANNED'
  | 'APPROVAL_REQUIRED'
  | 'QUEUED'
  | 'PROVISIONING'
  | 'VERIFYING'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'FAILED'
  | 'BLOCKED'
  | 'RECONCILIATION_REQUIRED'
  | 'DECOMMISSIONING'
  | 'RETIRED';

export type ResourceHealth = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'UNREACHABLE';
export type DriftState = 'UNKNOWN' | 'IN_SYNC' | 'DRIFT_DETECTED' | 'RECONCILIATION_REQUIRED' | 'RECONCILED';

export interface InfrastructureResource {
  id: string;
  tenantId: string;
  ventureId?: string;
  productId?: string;
  resourceType: InfrastructureResourceType;
  provider: string;
  region?: string;
  environment: 'sandbox' | 'staging' | 'production';
  owner: string;
  dependencyIds: string[];
  credentialReference?: string;
  expectedState: Record<string, unknown>;
  observedState?: Record<string, unknown>;
  status: InfrastructureState;
  health: ResourceHealth;
  driftState: DriftState;
  estimatedCost?: MonetaryValue;
  actualCost?: MonetaryValue;
  adapterId?: string;
  actionId?: string;
  validationEvidence: CommercialEvidence[];
  verificationEvidence: CommercialEvidence[];
  lastVerifiedAt?: number;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateInfrastructureResourceInput {
  ventureId?: string;
  productId?: string;
  resourceType: InfrastructureResourceType;
  provider: string;
  region?: string;
  environment: 'sandbox' | 'staging' | 'production';
  owner: string;
  dependencyIds?: string[];
  credentialReference?: string;
  expectedState: Record<string, unknown>;
  estimatedCost?: MonetaryValue;
  validationEvidence: CommercialEvidence[];
}

export interface InfrastructureVerificationResult extends AdapterVerificationResult {
  health: ResourceHealth;
  observedState: Record<string, unknown>;
  actualCost?: MonetaryValue;
}

export interface InfrastructureAdapterContext {
  resource: InfrastructureResource;
  action: ActionExecutionContext['action'];
  actor: CommercialActor;
  signal: AbortSignal;
}

/** Injected provider adapter. It receives credential references, never credential values. */
export interface InfrastructureAdapter {
  id: string;
  tenantId?: string;
  provider: string;
  resourceTypes: InfrastructureResourceType[];
  environments: Array<'sandbox' | 'staging' | 'production'>;
  maxAttempts?: number;
  defaultTimeoutMs?: number;
  productionEnabled?: boolean;
  provision(context: InfrastructureAdapterContext): Promise<AdapterExecutionResult>;
  verify(context: InfrastructureAdapterContext): Promise<InfrastructureVerificationResult>;
  rollback?(context: ActionRollbackContext): Promise<{ confirmed: boolean; summary?: string }>;
}

export interface RegisteredInfrastructureAdapter {
  id: string;
  tenantId: string;
  provider: string;
  resourceTypes: InfrastructureResourceType[];
  environments: Array<'sandbox' | 'staging' | 'production'>;
  productionEnabled: boolean;
  maxAttempts: number;
  defaultTimeoutMs: number;
  rollbackSupported: boolean;
}

export interface ExecuteInfrastructureResourceInput {
  decisionId: string;
  idempotencyKey: string;
  dryRun?: boolean;
}

export interface RecordObservedStateInput {
  observedState: Record<string, unknown>;
  health: ResourceHealth;
  evidence: CommercialEvidence[];
  actualCost?: MonetaryValue;
}
