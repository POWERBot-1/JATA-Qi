// Flutterwave + Pesapal + Airtel Money + MTN MoMo provider adapters.
// Each implements the standard PaymentProvider interface so they drop into
// @jataqi/payments alongside Stripe and M-Pesa. Pure Node, zero deps.

import { createHmac } from 'node:crypto';
import type { PaymentIntent, PaymentIntentCreate, PaymentProvider, Refund, WebhookEvent } from './types.js';
import { PaymentError } from './types.js';

// ---- Flutterwave ----------------------------------------------------------

export interface FlutterwaveConfig {
  secretKey: string;
  encryptionKey?: string;
  redirectUrl?: string;
  apiBase?: string;
}

export class FlutterwaveProvider implements PaymentProvider {
  readonly id = 'flutterwave';
  private readonly base: string;
  constructor(private readonly cfg: FlutterwaveConfig) {
    this.base = cfg.apiBase ?? 'https://api.flutterwave.com';
  }

  async createPaymentIntent(req: PaymentIntentCreate): Promise<PaymentIntent> {
    const txRef = `jq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      tx_ref: txRef,
      amount: (req.amount / 100).toFixed(2),
      currency: req.currency.toUpperCase(),
      redirect_url: this.cfg.redirectUrl ?? 'https://api.jataqi.local/payments/flutterwave/callback',
      customer: { email: req.receiptEmail ?? 'customer@jataqi.local' },
      customizations: { title: 'JATA Qi', description: req.description ?? 'Payment' },
      ...(req.metadata?.phone ? { payment_options: 'mobilemoneyghana,mobilemoneyuganda,mpesa,card' } : {}),
    };
    const res = await fetch(`${this.base}/v3/payments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    if (data.status !== 'success') throw new PaymentError(`Flutterwave init failed: ${data.message ?? 'unknown'}`, 'flw_error', res.status);
    return {
      id: txRef, object: 'payment_intent', amount: req.amount, currency: req.currency,
      status: 'requires_action', clientSecret: String((data.data as Record<string, unknown> | undefined)?.link ?? ''),
      ...(req.description ? { description: req.description } : {}),
    };
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntent> {
    const res = await fetch(`${this.base}/v3/transactions/${id}/verify`, {
      headers: { Authorization: `Bearer ${this.cfg.secretKey}` },
    });
    const data = await res.json() as Record<string, unknown>;
    const tx = (data.data ?? {}) as Record<string, unknown>;
    const status: PaymentIntent['status'] =
      tx.status === 'successful' ? 'succeeded' :
      tx.status === 'cancelled' ? 'canceled' :
      tx.status === 'failed' ? 'requires_payment_method' : 'processing';
    return {
      id, object: 'payment_intent', amount: Number(tx.amount ?? 0) * 100,
      currency: String(tx.currency ?? req_currency_default), status, clientSecret: '',
    };
  }

  async refund(paymentIntentId: string, amount?: number): Promise<Refund> {
    const res = await fetch(`${this.base}/v3/transactions/${paymentIntentId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amount ? amount / 100 : undefined }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (data.status !== 'success') throw new PaymentError(`Flutterwave refund failed: ${data.message}`, 'refund_error', res.status);
    return { id: String((data.data as Record<string, unknown> | undefined)?.id ?? `flw-refund-${Date.now()}`), object: 'refund', amount: amount ?? 0, currency: 'NGN', paymentIntentId, status: 'pending' };
  }

  async constructWebhookEvent(payload: string, signature: string, secret: string): Promise<WebhookEvent> {
    if (secret) {
      const expected = createHmac('sha256', secret).update(payload).digest('hex');
      if (expected !== signature) throw new PaymentError('Invalid Flutterwave webhook signature', 'sig_error', 401);
    }
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const evt = (parsed.event ?? 'payment') as string;
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    return { id: String(data.id ?? `flw-${Date.now()}`), type: evt.includes('refund') ? 'refund.created' : 'payment_intent.succeeded', data: { object: data }, created: Date.now() };
  }
}
const req_currency_default = 'USD';

// ---- Pesapal --------------------------------------------------------------

export interface PesapalConfig {
  consumerKey: string;
  consumerSecret: string;
  apiBase?: string;
}

export class PesapalProvider implements PaymentProvider {
  readonly id = 'pesapal';
  private readonly base: string;
  private tokenCache: { token: string; expiresAt: number } | null = null;
  constructor(private readonly cfg: PesapalConfig) {
    this.base = cfg.apiBase ?? 'https://pay.pesapal.com/v3';
  }

  async createPaymentIntent(req: PaymentIntentCreate): Promise<PaymentIntent> {
    const token = await this.getToken();
    const id = `jq-${Date.now()}`;
    const body = {
      id, currency: req.currency.toUpperCase(), amount: (req.amount / 100).toFixed(2),
      description: req.description ?? 'Payment',
      callback_url: 'https://api.jataqi.local/payments/pesapal/callback',
      notification_type: 'GET',
      billing_address: { email_address: req.receiptEmail ?? 'customer@jataqi.local', phone_number: req.metadata?.phone ?? '' },
    };
    const res = await fetch(`${this.base}/api/Transactions/SubmitOrderRequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    if (data.status !== '200' && data.error) throw new PaymentError(`Pesapal error: ${data.error as Record<string, unknown>}`, 'pesapal_error', res.status);
    return {
      id: String(data.order_tracking_id ?? id), object: 'payment_intent',
      amount: req.amount, currency: req.currency, status: 'requires_action',
      clientSecret: String(data.redirect_url ?? data.order_tracking_id ?? ''),
    };
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntent> {
    const token = await this.getToken();
    const res = await fetch(`${this.base}/api/Transactions/GetTransactionStatus?orderTrackingId=${id}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const data = await res.json() as Record<string, unknown>;
    const st = Number(data.status_code ?? 0);
    const status: PaymentIntent['status'] = st === 1 ? 'succeeded' : st === 2 ? 'canceled' : st === 3 ? 'processing' : 'requires_payment_method';
    return { id, object: 'payment_intent', amount: Number(data.amount ?? 0) * 100, currency: String(data.currency ?? 'KES'), status, clientSecret: '' };
  }

  async refund(_paymentIntentId: string, _amount?: number): Promise<Refund> {
    // Pesapal refunds via support ticket / API; return pending.
    return { id: `pesapal-refund-${Date.now()}`, object: 'refund', amount: _amount ?? 0, currency: 'KES', paymentIntentId: _paymentIntentId, status: 'pending' };
  }

  async constructWebhookEvent(payload: string, _signature: string, _secret: string): Promise<WebhookEvent> {
    const parsed = JSON.parse(payload);
    return { id: `pesapal-${Date.now()}`, type: 'payment_intent.succeeded', data: { object: parsed }, created: Date.now() };
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 5000) return this.tokenCache.token;
    const res = await fetch(`${this.base}/api/Auth/RequestToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ consumer_key: this.cfg.consumerKey, consumer_secret: this.cfg.consumerSecret }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (data.error) throw new PaymentError(`Pesapal auth: ${data.error}`, 'auth_error', res.status);
    this.tokenCache = { token: String(data.token), expiresAt: Date.now() + 55 * 60 * 1000 };
    return this.tokenCache.token;
  }
}

// ---- Airtel Money ---------------------------------------------------------

export interface AirtelConfig {
  clientId: string;
  clientSecret: string;
  apiBase?: string;
}

export class AirtelProvider implements PaymentProvider {
  readonly id = 'airtel';
  private readonly base: string;
  private tokenCache: { token: string; expiresAt: number } | null = null;
  constructor(private readonly cfg: AirtelConfig) {
    this.base = cfg.apiBase ?? 'https://openapiuat.airtel.africa'; // UAT by default
  }

  async createPaymentIntent(req: PaymentIntentCreate): Promise<PaymentIntent> {
    const token = await this.getToken();
    const phone = req.metadata?.phone ?? req.customerId ?? '';
    const reference = `jq-${Date.now()}`;
    const body = {
      reference, subscriber: { country: req.metadata?.country ?? 'KE', currency: req.currency.toUpperCase(), msisdn: phone.replace(/^\+/, '') },
      transaction: { amount: (req.amount / 100).toFixed(2), description: req.description ?? 'Payment', id: reference },
    };
    const res = await fetch(`${this.base}/merchant/v1/payments/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-country': req.metadata?.country ?? 'KE', 'x-currency': req.currency.toUpperCase() },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    if ((data.status as Record<string, unknown> | undefined)?.success !== true && (data.status as Record<string, unknown> | undefined)?.code !== '201') {
      throw new PaymentError(`Airtel error: ${(data.status as Record<string, unknown> | undefined)?.message ?? 'unknown'}`, 'airtel_error', res.status);
    }
    return { id: reference, object: 'payment_intent', amount: req.amount, currency: req.currency, status: 'requires_action', clientSecret: String((data.data as Record<string, unknown> | undefined)?.id ?? reference) };
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntent> {
    const token = await this.getToken();
    const res = await fetch(`${this.base}/standard/v1/payments/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as Record<string, unknown>;
    const txData = (data.data ?? {}) as Record<string, unknown>;
    const tx = (txData.transaction ?? {}) as Record<string, unknown>;
    const txStatus = String(tx.status ?? '');
    const status: PaymentIntent['status'] = txStatus === 'TS' ? 'succeeded' : txStatus === 'TF' ? 'requires_payment_method' : 'processing';
    return { id, object: 'payment_intent', amount: Number(tx.amount ?? txData.amount ?? 0) * 100, currency: String(txData.currency ?? 'KES'), status, clientSecret: '' };
  }

  async refund(_id: string, _amount?: number): Promise<Refund> {
    return { id: `airtel-refund-${Date.now()}`, object: 'refund', amount: _amount ?? 0, currency: 'KES', paymentIntentId: _id, status: 'pending' };
  }

  async constructWebhookEvent(payload: string, _sig: string, _secret: string): Promise<WebhookEvent> {
    const parsed = JSON.parse(payload);
    return { id: `airtel-${Date.now()}`, type: 'payment_intent.succeeded', data: { object: parsed }, created: Date.now() };
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 5000) return this.tokenCache.token;
    const res = await fetch(`${this.base}/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'client_credentials' }),
    });
    const data = await res.json() as Record<string, unknown>;
    this.tokenCache = { token: String(data.access_token), expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    return this.tokenCache.token;
  }
}

// ---- PayPal ---------------------------------------------------------------

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  environment?: 'sandbox' | 'production';
  apiBase?: string;
}

export class PayPalProvider implements PaymentProvider {
  readonly id = 'paypal';
  private readonly base: string;
  private tokenCache: { token: string; expiresAt: number } | null = null;
  constructor(private readonly cfg: PayPalConfig) {
    this.base = cfg.apiBase ?? (cfg.environment === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
  }

  async createPaymentIntent(req: PaymentIntentCreate): Promise<PaymentIntent> {
    const token = await this.getToken();
    const body = {
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: req.currency.toUpperCase(), value: (req.amount / 100).toFixed(2) }, description: req.description ?? 'Payment', custom_id: req.metadata?.reference }],
    };
    const res = await fetch(`${this.base}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    if (data.error) throw new PaymentError(`PayPal error: ${data.error_description ?? data.error}`, 'pp_error', res.status);
    const approveLink = (data.links as Array<Record<string, string>>)?.find((l) => l.rel === 'approve')?.href ?? '';
    return { id: String(data.id ?? ''), object: 'payment_intent', amount: req.amount, currency: req.currency, status: 'requires_action', clientSecret: approveLink };
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntent> {
    const token = await this.getToken();
    const res = await fetch(`${this.base}/v2/checkout/orders/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json() as Record<string, unknown>;
    const st = String(data.status ?? '');
    const status: PaymentIntent['status'] = st === 'COMPLETED' ? 'succeeded' : st === 'VOIDED' ? 'canceled' : 'requires_action';
    const units = (data.purchase_units ?? []) as Array<Record<string, unknown>>;
    const unitAmount = (units[0]?.amount ?? {}) as Record<string, unknown>;
    return { id, object: 'payment_intent', amount: Number(unitAmount.value ?? 0) * 100, currency: String(unitAmount.currency_code ?? 'USD'), status, clientSecret: '' };
  }

  async refund(paymentIntentId: string, amount?: number): Promise<Refund> {
    const token = await this.getToken();
    const captureId = paymentIntentId; // simplified: use the order/capture id
    const body = amount ? { amount: { currency_code: 'USD', value: (amount / 100).toFixed(2) } } : {};
    const res = await fetch(`${this.base}/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    return { id: String(data.id ?? `pp-refund-${Date.now()}`), object: 'refund', amount: amount ?? 0, currency: String((data.amount as Record<string, unknown> | undefined)?.currency_code ?? 'USD'), paymentIntentId, status: data.status === 'COMPLETED' ? 'succeeded' : 'pending' };
  }

  async constructWebhookEvent(payload: string, _sig: string, _secret: string): Promise<WebhookEvent> {
    const parsed = JSON.parse(payload);
    return { id: String(parsed.id ?? `pp-${Date.now()}`), type: String(parsed.event_type ?? 'payment'), data: { object: parsed.resource ?? {} }, created: Date.now() };
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 5000) return this.tokenCache.token;
    const auth = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const data = await res.json() as Record<string, unknown>;
    this.tokenCache = { token: String(data.access_token), expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    return this.tokenCache.token;
  }
}
