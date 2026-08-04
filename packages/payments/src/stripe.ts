// StripeProvider — a production-grade Stripe API client using the global fetch
// (built into Node 18+). Implements payment intents, refunds, and webhook
// signature verification. Zero external dependencies.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentIntent, PaymentIntentCreate, Refund, WebhookEvent, PaymentProvider } from './types.js';
import { PaymentError } from './types.js';

export interface StripeConfig {
  /** Stripe secret key (sk_live_... or sk_test_...). */
  secretKey: string;
  /** Webhook signing secret (whsec_...). */
  webhookSecret?: string;
  /** Stripe API base URL (default https://api.stripe.com). Override for tests. */
  apiBase?: string;
  /** API version header (default 2024-06-20). */
  apiVersion?: string;
  /** Request timeout ms (default 30000). */
  timeoutMs?: number;
}

const STRIPE_API_BASE = 'https://api.stripe.com';
const STRIPE_API_VERSION = '2024-06-20';
const WEBHOOK_TOLERANCE_SEC = 300;

export class StripeProvider implements PaymentProvider {
  readonly id = 'stripe';
  private readonly base: string;
  private readonly version: string;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: StripeConfig) {
    this.base = cfg.apiBase ?? STRIPE_API_BASE;
    this.version = cfg.apiVersion ?? STRIPE_API_VERSION;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  async createPaymentIntent(req: PaymentIntentCreate): Promise<PaymentIntent> {
    const form = encodeForm({
      amount: String(req.amount),
      currency: req.currency,
      'payment_intent_data[description]': req.description,
      'payment_intent_data[receipt_email]': req.receiptEmail,
      customer: req.customerId,
      'metadata[source]': 'jataqi',
      ...flattenMetadata(req.metadata),
    });
    return mapIntent(await this.request<Record<string, unknown>>('POST', '/v1/payment_intents', form));
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntent> {
    return mapIntent(await this.request<Record<string, unknown>>('GET', `/v1/payment_intents/${id}`));
  }

  async refund(paymentIntentId: string, amount?: number): Promise<Refund> {
    const form = encodeForm({ payment_intent: paymentIntentId, ...(amount !== undefined ? { amount: String(amount) } : {}) });
    return mapRefund(await this.request<Record<string, unknown>>('POST', '/v1/refunds', form));
  }

  async constructWebhookEvent(payload: string, signatureHeader: string, secret: string): Promise<WebhookEvent> {
    const sig = parseSignatureHeader(signatureHeader);
    if (!sig.t || !sig.v1 || sig.v1.length === 0) throw new PaymentError('invalid signature header', 'invalid_signature', 400);

    const age = Math.floor(Date.now() / 1000) - Number(sig.t);
    if (Math.abs(age) > WEBHOOK_TOLERANCE_SEC) throw new PaymentError('webhook timestamp outside tolerance', 'timestamp_too_far', 400);

    const expected = createHmac('sha256', secret).update(`${sig.t}.${payload}`).digest('hex');
    if (!constantTimeEqual(expected, sig.v1)) throw new PaymentError('signature mismatch', 'signature_mismatch', 400);

    return JSON.parse(payload) as WebhookEvent;
  }

  private async request<T>(method: string, path: string, body?: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'stripe-version': this.version,
        },
        ...(body ? { body } : {}),
        signal: controller.signal,
      });
      const json = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        const err = (json as { error?: { message?: string; code?: string; type?: string } }).error;
        throw new PaymentError(err?.message ?? 'stripe error', err?.code ?? 'stripe_error', res.status, err?.type === 'card_error');
      }
      return json as unknown as T;
    } catch (err) {
      if (err instanceof PaymentError) throw err;
      throw new PaymentError((err as Error).message ?? 'network error', 'network_error', 0);
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- helpers -----------------------------------------------------------------

function encodeForm(fields: Record<string, string | undefined>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
    .join('&');
}

function flattenMetadata(meta?: Record<string, string>): Record<string, string> {
  if (!meta) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) out[`metadata[${k}]`] = v;
  return out;
}

function parseSignatureHeader(header: string): { t?: string; v1?: string } {
  const out: { t?: string; v1?: string } = {};
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=');
    if (k === 't') out.t = v;
    if (k === 'v1') out.v1 = v;
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// --- response mappers (snake_case → camelCase) -------------------------------

function mapIntent(raw: Record<string, unknown>): PaymentIntent {
  return {
    id: raw.id as string,
    object: 'payment_intent',
    amount: raw.amount as number,
    currency: raw.currency as string,
    status: raw.status as PaymentIntent['status'],
    clientSecret: raw.client_secret as string,
    ...(raw.description ? { description: raw.description as string } : {}),
    ...(raw.metadata ? { metadata: raw.metadata as Record<string, string> } : {}),
  };
}

function mapRefund(raw: Record<string, unknown>): Refund {
  return {
    id: raw.id as string,
    object: 'refund',
    amount: raw.amount as number,
    currency: raw.currency as string,
    status: raw.status as Refund['status'],
    ...(raw.payment_intent ? { paymentIntentId: raw.payment_intent as string } : {}),
  };
}
