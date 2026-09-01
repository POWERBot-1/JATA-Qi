import type {
  CommercialAction,
  CommercialActor,
  CommercialEvidence,
  MonetaryValue,
  PlanCommercialActionInput,
  ResourceRequirement,
} from '@jataqi/commercial-control-plane';

export type ActionRuntimeEnvironment = 'sandbox' | 'production';

export interface ActionExecutionContext {
  action: CommercialAction;
  actor: CommercialActor;
  attempt: number;
  signal: AbortSignal;
}

export interface AdapterExecutionResult {
  reportedSuccess: boolean;
  summary?: string;
  externalResponse?: Record<string, unknown>;
  internalState?: Record<string, unknown>;
  resourceConsumption?: ResourceRequirement[];
  financialCost?: MonetaryValue;
}

export interface AdapterVerificationResult {
  verified: boolean;
  evidence: CommercialEvidence[];
  summary?: string;
  externalState?: Record<string, unknown>;
}

export interface ActionRollbackContext {
  action: CommercialAction;
  actor: CommercialActor;
  signal: AbortSignal;
}

/**
 * External execution adapters are explicit capabilities. The runtime never
 * synthesizes credentials, assumes a provider capability, or falls back to an
 * unregistered adapter.
 */
export interface ActionExecutionAdapter {
  id: string;
  targetSystem: string;
  actionTypes: string[];
  environment: ActionRuntimeEnvironment;
  maxAttempts?: number;
  defaultTimeoutMs?: number;
  execute(context: ActionExecutionContext): Promise<AdapterExecutionResult>;
  verify(context: ActionExecutionContext): Promise<AdapterVerificationResult>;
  rollback?(context: ActionRollbackContext): Promise<{ confirmed: boolean; summary?: string }>;
}

export interface RegisteredActionAdapter {
  id: string;
  targetSystem: string;
  actionTypes: string[];
  environment: ActionRuntimeEnvironment;
  maxAttempts: number;
  defaultTimeoutMs: number;
  rollbackSupported: boolean;
}

export interface RuntimePlanInput extends PlanCommercialActionInput {}

export interface RuntimeExecutionOptions {
  /** Bounded at five attempts regardless of caller input. */
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface RuntimeExecutionResult {
  action: CommercialAction;
  adapterId?: string;
  attempts: number;
  executedExternally: boolean;
}
