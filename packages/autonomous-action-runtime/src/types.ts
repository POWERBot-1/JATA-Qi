import type {
  CommercialAction,
  CommercialActor,
  CommercialEvidence,
  MonetaryValue,
  PlanCommercialActionInput,
  ResourceRequirement,
} from '@jataqi/commercial-control-plane';

export type ActionRuntimeEnvironment = 'sandbox' | 'production';

import type {
  A01ApprovalBinding,
  A01AuthorizationEnvelope,
  A01CredentialBinding,
  A01DataClassification,
  A01PrincipalBinding,
  ScopedCredential,
} from '@jataqi/authorization-boundary';

/**
 * A-01: the authoritative context handed to an adapter at execution time.
 * The `credential` is a scoped, bound credential resolved by the broker at
 * the enforcement point; the adapter consumes it for its external call and
 * never requests or holds raw secret material of its own.
 */
export interface ActionExecutionContextAuthorization {
  readonly envelope: A01AuthorizationEnvelope;
  readonly credential?: ScopedCredential;
}

export interface ActionExecutionContext {
  action: CommercialAction;
  actor: CommercialActor;
  attempt: number;
  signal: AbortSignal;
  /** A-01: present when the execution went through the authorization boundary. */
  authorization?: ActionExecutionContextAuthorization;
}

/**
 * A-01: verified-identity and authorization inputs for one execution.
 * `principal` MUST come from a server-verified identity (T-01/T-02), never
 * from the caller. When the composition installs an authorization gate and a
 * verified principal is absent, the execution fails closed (no external I/O).
 */
export interface ActionRuntimeAuthorization {
  readonly principal?: A01PrincipalBinding;
  readonly capabilityId?: string;
  readonly capabilityVersion?: string;
  readonly dataClassification?: A01DataClassification;
  readonly approval?: A01ApprovalBinding;
  readonly credential?: A01CredentialBinding;
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
  /** A-01: verified identity + authorization inputs for the external execution. */
  authorization?: ActionRuntimeAuthorization;
}

export interface RuntimeExecutionResult {
  action: CommercialAction;
  adapterId?: string;
  attempts: number;
  executedExternally: boolean;
}
