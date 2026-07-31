// Payment provider interfaces — provider-agnostic types for payment processing.

export interface PaymentIntentCreate {
  amount: number;          // smallest currency unit (cents)
  currency: string;        // ISO 4217 (usd, eur, kes...)
  description?: string;
  customerId?: string;
  metadata?: Record<string, string>;
  receiptEmail?: string;
}

export interface PaymentIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  currency: string;
  status: PaymentIntentStatus;
  clientSecret: string;
  description?: string;
  metadata?: Record<string, string>;
}

export type PaymentIntentStatus =
  | 'requires_payment_method' | 'requires_confirmation' | 'requires_action'
  | 'processing' | 'succeeded' | 'canceled' | 'requires_capture';

export interface Refund {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  paymentIntentId?: string;
  status: 'succeeded' | 'pending' | 'failed' | 'canceled';
}

export interface WebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  created: number;
}

export interface PaymentProvider {
  readonly id: string;
  createPaymentIntent(req: PaymentIntentCreate): Promise<PaymentIntent>;
  retrievePaymentIntent(id: string): Promise<PaymentIntent>;
  refund(paymentIntentId: string, amount?: number): Promise<Refund>;
  constructWebhookEvent(payload: string, signature: string, secret: string): Promise<WebhookEvent>;
}

export class PaymentError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly declined: boolean;
  constructor(message: string, code: string, statusCode: number, declined = false) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.statusCode = statusCode;
    this.declined = declined;
  }
}
