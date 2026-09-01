import type {
  ActionExecutionContext,
  ActionRollbackContext,
  AdapterExecutionResult,
  AdapterVerificationResult,
} from '@jataqi/autonomous-action-runtime';
import type { CommercialActor, CommercialEvidence, MonetaryValue } from '@jataqi/commercial-control-plane';

export const PaymentCreateActionType = 'PAYMENT_CREATE';
export const PaymentRefundActionType = 'PAYMENT_REFUND';

export type PaymentOperation = 'CREATE_PAYMENT' | 'REFUND_PAYMENT';
export type PaymentStatus =
  | 'DRAFT'
  | 'SIMULATED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'REQUIRES_ACTION'
  | 'SUCCEEDED_UNVERIFIED'
  | 'VERIFIED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUND_QUEUED'
  | 'REFUND_PROCESSING'
  | 'REFUND_UNVERIFIED'
  | 'REFUNDED'
  | 'BLOCKED';

export type ProviderPaymentStatus = 'PENDING' | 'REQUIRES_ACTION' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED' | 'UNKNOWN';

export interface PaymentIntent {
  id: string;
  tenantId: string;
  ventureId?: string;
  productId?: string;
  campaignId?: string;
  customerReference: string;
  invoiceId?: string;
  purpose: string;
  amount: MonetaryValue;
  providerId: string;
  providerCustomerReference?: string;
  idempotencyKey: string;
  status: PaymentStatus;
  createActionId?: string;
  refundActionId?: string;
  refundAmount?: MonetaryValue;
  providerReference?: string;
  verificationEvidence: CommercialEvidence[];
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
  verifiedAt?: number;
  refundedAt?: number;
}

export interface CreatePaymentIntentInput {
  ventureId?: string;
  productId?: string;
  campaignId?: string;
  /** A tenant-bound provider/customer reference; do not store card/mobile-money instrument details. */
  customerReference: string;
  invoiceId?: string;
  purpose: string;
  amount: MonetaryValue;
  providerId: string;
  providerCustomerReference?: string;
  idempotencyKey: string;
}

export interface PaymentProviderContext {
  payment: PaymentIntent;
  operation: PaymentOperation;
  action: ActionExecutionContext['action'];
  actor: CommercialActor;
  signal: AbortSignal;
}

export interface PaymentProviderResult extends AdapterExecutionResult {
  providerReference?: string;
  providerStatus: ProviderPaymentStatus;
}

export interface PaymentVerificationResult extends AdapterVerificationResult {
  providerStatus: ProviderPaymentStatus;
  providerReference?: string;
  observedAmount?: MonetaryValue;
}

/** Provider is injected by the host; credential reference is opaque and secret-manager owned. */
export interface PaymentProvider {
  id: string;
  tenantId?: string;
  credentialReference?: string;
  currencies: string[];
  supportsRefunds: boolean;
  environment: 'sandbox' | 'production';
  maxAttempts?: number;
  defaultTimeoutMs?: number;
  productionEnabled?: boolean;
  createPayment(context: PaymentProviderContext): Promise<PaymentProviderResult>;
  verifyPayment(context: PaymentProviderContext): Promise<PaymentVerificationResult>;
  refundPayment?(context: PaymentProviderContext): Promise<PaymentProviderResult>;
  rollback?(context: ActionRollbackContext): Promise<{ confirmed: boolean; summary?: string }>;
}

export interface RegisteredPaymentProvider {
  id: string;
  tenantId: string;
  currencies: string[];
  supportsRefunds: boolean;
  environment: 'sandbox' | 'production';
  productionEnabled: boolean;
  maxAttempts: number;
  defaultTimeoutMs: number;
  credentialReference?: string;
}

export interface ExecutePaymentInput {
  decisionId: string;
  idempotencyKey: string;
  dryRun?: boolean;
}

export interface RequestRefundInput {
  amount?: MonetaryValue;
  reason: string;
  decisionId: string;
  idempotencyKey: string;
  dryRun?: boolean;
}

export const PaymentEvents = Object.freeze({
  IntentCreated: 'payment.intent.created',
  PaymentQueued: 'payment.queued',
  PaymentReported: 'payment.reported',
  PaymentVerified: 'payment.verified',
  PaymentFailed: 'payment.failed',
  RefundVerified: 'payment.refund.verified',
} as const);
