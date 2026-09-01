import type {
  ActionExecutionContext,
  ActionRollbackContext,
  AdapterExecutionResult,
  AdapterVerificationResult,
} from '@jataqi/autonomous-action-runtime';
import type { ConnectorCapability, ConnectorHealth } from '@jataqi/commercial-control-plane';

/** Secret values are never accepted by connector contracts; use a provider-managed reference. */
export interface ConnectorContext {
  tenantId: string;
  environment: 'sandbox' | 'production';
  credentialReference?: string;
  signal: AbortSignal;
}

export interface ConnectorHealthReport {
  health: ConnectorHealth;
  reason?: string;
  observedAt: number;
}

export interface ExternalConnector extends ConnectorCapability {
  id: string;
  tenantId?: string;
  targetSystem: string;
  environment: 'sandbox' | 'production';
  maxAttempts?: number;
  defaultTimeoutMs?: number;
  /** Credential identifier in a secret manager, never a credential value. */
  credentialReference?: string;
  connect?(context: ConnectorContext): Promise<void>;
  authenticate?(context: ConnectorContext): Promise<void>;
  health(context: ConnectorContext): Promise<ConnectorHealthReport>;
  capabilities(context: ConnectorContext): Promise<ConnectorCapability>;
  execute(context: ActionExecutionContext): Promise<AdapterExecutionResult>;
  verify(context: ActionExecutionContext): Promise<AdapterVerificationResult>;
  rollback?(context: ActionRollbackContext): Promise<{ confirmed: boolean; summary?: string }>;
  disconnect?(context: ConnectorContext): Promise<void>;
}

export interface ConnectorRegistration {
  id: string;
  providerId: string;
  providerType: string;
  targetSystem: string;
  tenantId: string;
  environment: 'sandbox' | 'production';
  health: ConnectorHealth;
  supportedActions: string[];
  rollbackSupported: boolean;
  credentialReference?: string;
  connected: boolean;
  lastVerifiedAt?: number;
}

export interface ConnectorActivationResult {
  registration: ConnectorRegistration;
  capability: ConnectorCapability;
  health: ConnectorHealthReport;
}

export interface ConnectorContractReport {
  connectorId: string;
  capabilityDeclared: boolean;
  healthChecked: boolean;
  actionContractReady: boolean;
  rollbackContractReady: boolean;
  credentialReferencePresent: boolean;
  status: 'READY' | 'BLOCKED';
  reasons: string[];
}
