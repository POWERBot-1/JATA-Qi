// Types for Universal Prompt-to-Payment Layer (UPPL v1.0)

export type PaymentIntentStatus =
  | 'DRAFT'
  | 'VALIDATED'
  | 'REQUIRES_AUTHORIZATION'
  | 'AUTHORIZED'
  | 'ROUTING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'DISPUTED';

export type VerificationState =
  | 'VERIFIED_SUCCESS'
  | 'VERIFIED_FAILURE'
  | 'PENDING_VERIFICATION'
  | 'REQUIRES_RECONCILIATION';

export interface PaymentIntent {
  paymentIntentId: string;
  tenantId: string;
  payerId: string;
  payee: { type: 'PERSON' | 'MERCHANT' | 'BUSINESS'; identifier: string; name?: string };
  amount: number;
  currency: string;
  purpose: string;
  metadata?: Record<string, unknown>;
  preferredPaymentMethod?: string;
  allowedPaymentMethods?: string[];
  status: PaymentIntentStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentQuote {
  requestedAmount: number;
  requestedCurrency: string;
  selectedMethod: string;
  provider: string;
  providerFee: number;
  fxFee: number;
  totalDebit: number;
  expectedRecipientAmount: number;
  estimatedSettlementTimeMs: number;
  quoteExpiry: string;
}

export interface UniversalReceipt {
  receiptId: string;
  paymentId: string;
  payer: string;
  payee: string;
  amount: number;
  currency: string;
  purpose: string;
  paymentMethod: string;
  provider: string;
  providerReference: string;
  status: PaymentIntentStatus;
  transactionTime: string;
  fees: number;
  verificationStatus: VerificationState;
  auditReference: string;
}

export interface LedgerRecord {
  ledgerId: string;
  paymentIntentId: string;
  providerTransactionId: string;
  payer: string;
  payee: string;
  amount: number;
  currency: string;
  fees: number;
  netAmount: number;
  provider: string;
  paymentMethod: string;
  status: PaymentIntentStatus;
  verificationStatus: VerificationState;
  timestamp: string;
  idempotencyKey: string;
  auditHash: string;
}

export interface IPaymentProvider {
  providerId: string;
  createPayment(intent: PaymentIntent): Promise<{ providerTransactionId: string; status: PaymentIntentStatus }>;
  executePayment(providerTransactionId: string): Promise<{ success: boolean; reference: string; fees: number }>;
  verifyPayment(providerTransactionId: string): Promise<VerificationState>;
  refundPayment(providerTransactionId: string, amount?: number): Promise<boolean>;
}

export interface PaymentAuthorityRule {
  userId: string;
  agentId?: string;
  maxPerTransaction: number;
  maxDaily: number;
  allowedCurrencies: string[];
  allowedCategories?: string[];
  requiresApprovalAbove: number;
}
