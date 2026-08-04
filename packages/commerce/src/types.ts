// JATA Qi Commerce — domain types. Everything is configurable data, not
// hard-coded logic: products, editions, plans, prices, entitlements, cycles,
// currencies and commission rates are all admin-defined.

export type BillingCycle =
  | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'
  | 'SEMIANNUAL' | 'ANNUAL' | 'BIENNIAL' | 'CUSTOM' | 'ONE_TIME' | 'LIFETIME';

export type PricingModel =
  | 'FREE' | 'FLAT_RATE' | 'PER_USER' | 'PER_SEAT' | 'PER_ORGANIZATION'
  | 'USAGE_BASED' | 'TIERED' | 'VOLUME' | 'HYBRID' | 'CONTRACT' | 'NEGOTIATED'
  | 'REVENUE_SHARE' | 'COMMISSION' | 'ONE_TIME' | 'LIFETIME';

export type SubscriptionStatus =
  | 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'GRACE_PERIOD' | 'PAUSED'
  | 'CANCELLED' | 'EXPIRED' | 'SUSPENDED' | 'REACTIVATED';

export type Edition =
  | 'COMMUNITY' | 'FREE' | 'PERSONAL' | 'STUDENT' | 'PROFESSIONAL' | 'DEVELOPER'
  | 'TEAM' | 'BUSINESS' | 'ENTERPRISE' | 'EDUCATION' | 'RESEARCH' | 'GOVERNMENT'
  | 'HEALTHCARE' | 'PRIVATE' | 'ON_PREMISE' | 'HYBRID' | 'OEM' | 'WHITE_LABEL' | string;

export type DeploymentModel =
  | 'SAAS' | 'PUBLIC_CLOUD' | 'PRIVATE_CLOUD' | 'HYBRID_CLOUD' | 'ON_PREMISE'
  | 'AIR_GAPPED' | 'EDGE' | 'DOCKER' | 'KUBERNETES' | 'VM' | 'API_ONLY' | 'EMBEDDED';

/** Monetary value — amount + currency. Never silently converted. */
export interface Money {
  amount: number;
  currency: string; // ISO 4217
}

/**
 * Entitlements for a plan/package: feature key -> limit. A boolean `true` means
 * "enabled, unmetered". A number is a per-period quota. The sentinel
 * `UNLIMITED` means no limit.
 */
export const UNLIMITED = Number.POSITIVE_INFINITY;
export type EntitlementValue = boolean | number;
export type Entitlements = Record<string, EntitlementValue>;

export interface Product {
  id: string;
  name: string;
  slug: string;
  family: string;
  description?: string;
  category?: string;
  version: string;
  status: 'ACTIVE' | 'RETIRED' | 'DRAFT';
  availablePlans: string[]; // plan ids/slugs
  deployments: DeploymentModel[];
  licenseModel?: PricingModel;
  createdAt: number;
}

export interface Plan {
  id: string;
  name: string;
  slug: string;
  productFamily: string;
  edition: Edition;
  pricingModel: PricingModel;
  /** Price by currency. The customer is charged in the currency they select. */
  prices: Record<string, Money>;
  billingCycle: BillingCycle;
  entitlements: Entitlements;
  /** Optional trial offered by this plan. */
  trial?: { days: number; conversionTargetSlug?: string };
  status: 'ACTIVE' | 'RETIRED';
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface Subscription {
  id: string;
  customerId: string;
  organizationId?: string;
  planId: string;
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  currency: string;
  price: Money;
  seats?: number;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  autoRenew: boolean;
  trialEnd?: number;
  cancelAtPeriodEnd?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UsageEvent {
  id: string;
  customerId: string;
  metric: string;
  qty: number;
  period: string; // YYYY-MM
  ts: number;
}

export interface CreditBatch {
  id: string;
  customerId: string;
  source: string;
  amount: number;
  remaining: number;
  expiresAt?: number;
  createdAt: number;
}

export interface License {
  id: string;
  customerId: string;
  productId: string;
  edition: Edition;
  features: string[];
  deployment: DeploymentModel;
  validFrom: number;
  validUntil?: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdAt: number;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: Money;
  total: Money;
}
export interface Invoice {
  id: string;
  customerId: string;
  lines: InvoiceLine[];
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
  status: 'DRAFT' | 'ISSUED' | 'PAID' | 'OVERDUE' | 'VOID' | 'REFUNDED';
  issueDate: number;
  dueDate?: number;
  periodStart?: number;
  periodEnd?: number;
}

export interface PaymentResult {
  ok: boolean;
  reference?: string;
  error?: string;
}

/** A payment provider adapter. Real providers plug in here; none are wired by default. */
export interface PaymentProvider {
  readonly id: string;
  charge(amount: Money, reference: string): Promise<PaymentResult>;
  refund(reference: string, amount?: Money): Promise<PaymentResult>;
}

export interface PaymentRecord {
  id: string;
  customerId: string;
  reference: string;
  amount: Money;
  status: 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  provider: string;
  invoiceId?: string;
  ts: number;
}

export interface MarketplaceItem {
  id: string;
  name: string;
  sellerId: string;
  price: Money;
  /** Platform commission percentage (0..100). Seller receives the rest. */
  platformCommissionPct: number;
  pricingModel: PricingModel;
  status: 'LISTED' | 'UNLISTED';
}
export interface MarketplaceOrder {
  id: string;
  itemId: string;
  buyerId: string;
  sellerId: string;
  price: Money;
  platformShare: Money;
  sellerShare: Money;
  status: 'COMPLETED' | 'REFUNDED';
  createdAt: number;
}
export interface Payout {
  id: string;
  payeeId: string;
  amount: Money;
  reason: string;
  orderId?: string;
  status: 'SCHEDULED' | 'PAID';
  createdAt: number;
}

export interface EntitlementOverride {
  id: string;
  customerId: string;
  feature: string;
  quota: number;
  reason: string;
  adminId: string;
  expiresAt?: number;
  createdAt: number;
}

export const CommerceEvents = Object.freeze({
  SubscriptionCreated: 'commerce.subscription.created',
  SubscriptionUpgraded: 'commerce.subscription.upgraded',
  SubscriptionCancelled: 'commerce.subscription.cancelled',
  PaymentRecorded: 'commerce.payment.recorded',
  RefundIssued: 'commerce.refund.issued',
  UsageThresholdReached: 'commerce.usage.threshold',
  CreditLow: 'commerce.credit.low',
  MarketplacePurchase: 'commerce.marketplace.purchase',
  EntitlementOverridden: 'commerce.entitlement.override',
} as const);
