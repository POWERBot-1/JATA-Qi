import type {
  ActionExecutionContext,
  ActionRollbackContext,
  AdapterExecutionResult,
  AdapterVerificationResult,
} from '@jataqi/autonomous-action-runtime';
import type { CommercialActor, CommercialEvidence, FxConversion, FxSource, MonetaryValue } from '@jataqi/commercial-control-plane';

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

/* ------------------------------------------------------------------------- *
 * T-09 — per-currency wallet (internal balances, no PSP, no external money)
 * ------------------------------------------------------------------------- */

/**
 * A wallet account holds exactly ONE currency for ONE owner reference inside
 * ONE tenant. Currency is part of the account identity, so balances of
 * different currencies can never be mixed into one number: there is no such
 * thing as "the balance" of an owner, only the balance of an
 * (owner, currency) pair.
 */
export interface WalletAccount {
  /** Deterministic id derived from (tenantId, ownerReference, currency). */
  id: string;
  tenantId: string;
  /** Tenant-bound owner/customer reference; never an instrument or PSP token. */
  ownerReference: string;
  /** Normalized ISO-4217 alpha-3 currency (upper-cased). One per account. */
  currency: string;
  /**
   * T-09 additive metadata: the minor-unit scale of `currency` when the
   * account was created (JPY/KRW/CLP 0, BHD/KWD/OMR 3, default 2). Recorded
   * on the row so an auditor can see the scale that produced `minorUnits`
   * without recomputing it from the currency table.
   */
  scale: number;
  /** Canonical balance, quantized at `scale`. */
  balance: MonetaryValue;
  /**
   * Exact balance in minor units as a decimal string (JSON-safe bigint). This
   * is the authoritative value for every comparison and movement.
   */
  minorUnits: string;
  status: WalletStatus;
  createdAt: number;
  updatedAt: number;
  /** Monotonic per-account mutation counter (CAS-protected). */
  version: number;
}

export type WalletStatus = 'ACTIVE' | 'FROZEN';

/** What happened to a balance. Conversions produce one debit and one credit entry. */
export type WalletEntryKind = 'CREDIT' | 'DEBIT' | 'CONVERSION_DEBIT' | 'CONVERSION_CREDIT';

/** Append-only, idempotent wallet movement record. */
export interface WalletLedgerEntry {
  /** Deterministic id derived from (walletId, idempotencyKey, leg). */
  id: string;
  tenantId: string;
  walletId: string;
  ownerReference: string;
  currency: string;
  scale: number;
  kind: WalletEntryKind;
  /** Absolute movement amount, quantized at the currency scale. */
  amount: MonetaryValue;
  /** Exact movement in minor units (decimal string); negative for debits. */
  minorUnits: string;
  balanceAfter: MonetaryValue;
  balanceMinorAfter: string;
  /** Caller-supplied replay-stable key; one movement per (wallet, key, leg). */
  idempotencyKey: string;
  /** True when this entry was returned by a replay rather than newly written. */
  replayed?: boolean;
  reason?: string;
  /** Present on both legs of a conversion; ties them together. */
  conversionId?: string;
  /** Present on conversion legs: the exact rate and rounding that produced them. */
  fx?: WalletFxRecord;
  createdAt: number;
}

/** Audit record of the injected FX conversion behind a wallet conversion. */
export interface WalletFxRecord {
  from: string;
  to: string;
  rate: number;
  sourceScale: number;
  targetScale: number;
  sourceMinorUnits: string;
  targetMinorUnits: string;
  rounding: 'half-up';
  providerId: string;
}

/** Read view of one (owner, currency) balance. */
export interface WalletBalance {
  tenantId: string;
  ownerReference: string;
  currency: string;
  scale: number;
  balance: MonetaryValue;
  minorUnits: string;
  /** False when no account exists yet: the balance is a genuine zero, not a stored row. */
  exists: boolean;
  status?: WalletStatus;
  walletId?: string;
  version?: number;
  updatedAt?: number;
}

export interface WalletDepositInput {
  ownerReference: string;
  amount: MonetaryValue;
  /**
   * Optional explicit account currency. When present it MUST equal
   * `amount.currency`; a disagreement is a currency mismatch and fails closed
   * before any read or write (no implicit conversion).
   */
  currency?: string;
  /** Replay-stable key: one credit per (wallet, key). */
  idempotencyKey: string;
  reason?: string;
}

export interface WalletWithdrawalInput {
  ownerReference: string;
  amount: MonetaryValue;
  /**
   * Optional explicit account currency. When present it MUST equal
   * `amount.currency`; a disagreement is a currency mismatch and fails closed
   * (insufficient-balance and mismatch refusals are distinct errors).
   */
  currency?: string;
  /** Replay-stable key: one debit per (wallet, key). */
  idempotencyKey: string;
  reason?: string;
}

export interface WalletConversionInput {
  ownerReference: string;
  /** Amount to debit, in the SOURCE currency. */
  source: MonetaryValue;
  /** Currency to credit. Must differ from the source currency. */
  targetCurrency: string;
  /**
   * Optional explicit source account currency. When present it MUST equal
   * `source.currency`; a disagreement fails closed before any FX lookup,
   * read, or write (no implicit conversion).
   */
  currency?: string;
  /**
   * Injected FX source (provider object or bare resolver). There is no
   * bundled rate table, no network call, and no PSP: without an injected
   * source a conversion fails closed.
   */
  fx: FxSource;
  idempotencyKey: string;
  reason?: string;
}

export interface WalletMovementResult {
  wallet: WalletAccount;
  entry: WalletLedgerEntry;
  balance: WalletBalance;
}

export interface WalletConversionResult {
  conversionId: string;
  rate: number;
  source: MonetaryValue;
  converted: MonetaryValue;
  debit: WalletLedgerEntry;
  credit: WalletLedgerEntry;
  sourceWallet: WalletAccount;
  targetWallet: WalletAccount;
  fx: FxConversion;
}

export const PaymentEvents = Object.freeze({
  IntentCreated: 'payment.intent.created',
  PaymentQueued: 'payment.queued',
  PaymentReported: 'payment.reported',
  PaymentVerified: 'payment.verified',
  PaymentFailed: 'payment.failed',
  RefundVerified: 'payment.refund.verified',
  ReservationReleaseFailed: 'payments.reservation.release.failed',
  ReservationReleased: 'payments.reservation.released',
} as const);

/** T-09 wallet events. Keys are replay-stable per (wallet, idempotency key, leg). */
export const WalletEvents = Object.freeze({
  Credited: 'wallet.credited',
  Debited: 'wallet.debited',
  WithdrawalRejected: 'wallet.withdrawal.rejected',
  ConversionCompleted: 'wallet.conversion.completed',
  StatusChanged: 'wallet.status.changed',
} as const);
