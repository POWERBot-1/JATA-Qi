import type { MonetaryValue } from '@jataqi/commercial-control-plane';

export type BillingCycle = 'MONTHLY' | 'ANNUAL' | 'ONE_TIME';
export type SubscriptionStatus = 'PENDING_PAYMENT' | 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'SUSPENDED' | 'EXPIRED';
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PAYMENT_PENDING' | 'PAID' | 'OVERDUE' | 'VOID' | 'REFUNDED';

export interface BillingPlan {
  id: string;
  tenantId: string;
  productId: string;
  name: string;
  price: MonetaryValue;
  cycle: BillingCycle;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBillingPlanInput {
  productId: string;
  name: string;
  price: MonetaryValue;
  cycle: BillingCycle;
}

export interface Subscription {
  id: string;
  tenantId: string;
  productId: string;
  planId: string;
  customerReference: string;
  status: SubscriptionStatus;
  trialEndsAt?: number;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  createdAt: number;
  updatedAt: number;
  cancelledAt?: number;
}

export interface CreateSubscriptionInput {
  productId: string;
  planId: string;
  customerReference: string;
  trialDays?: number;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: MonetaryValue;
  total: MonetaryValue;
}

export interface Invoice {
  id: string;
  tenantId: string;
  subscriptionId?: string;
  productId: string;
  customerReference: string;
  lines: InvoiceLine[];
  total: MonetaryValue;
  status: InvoiceStatus;
  issuedAt: number;
  dueAt?: number;
  paymentId?: string;
  providerReference?: string;
  paidAt?: number;
  refundedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateInvoiceInput {
  subscriptionId?: string;
  productId: string;
  customerReference: string;
  lines: InvoiceLine[];
  dueAt?: number;
}

export interface CreateInvoicePaymentInput {
  providerId: string;
  providerCustomerReference?: string;
  idempotencyKey: string;
}

export const BillingEvents = Object.freeze({
  PlanCreated: 'billing.plan.created',
  SubscriptionCreated: 'subscription.created',
  InvoiceIssued: 'billing.invoice.issued',
  InvoicePaid: 'billing.invoice.paid',
  InvoiceRefunded: 'billing.invoice.refunded',
  SubscriptionActivated: 'subscription.activated',
  SubscriptionCancelled: 'subscription.cancelled',
} as const);
