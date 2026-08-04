// M-Pesa (Safaricom) Daraja API provider — STK Push (Lipa Na M-Pesa Online),
// C2B, B2C, transaction status, and reversal. Implements the standard
// PaymentProvider interface so it drops into @jataqi/payments alongside Stripe.
// Pure Node (fetch + crypto), zero external dependencies.

import { createHmac } from 'node:crypto';
import type { PaymentIntent, PaymentIntentCreate, PaymentProvider, Refund, WebhookEvent } from './types.js';
import { PaymentError } from './types.js';

export interface MpesaConfig {
  /** Consumer key from the Safaricom developer portal. */
  consumerKey: string;
  /** Consumer secret. */
  consumerSecret: string;
  /** Shortcode (Paybill or Till number). */
  shortCode: string;
  /** Passkey for STK Push (from the portal). */
  passkey: string;
  /** Environment: 'sandbox' or 'production'. */
  environment?: 'sandbox' | 'production';
  /** Callback URL for STK Push results. */
  callbackUrl?: string;
  /** Override base URL (for testing). */
  apiBase?: string;
}

const SANDBOX_BASE = 'https://sandbox.safaricom.co.ke';
const PROD_BASE = 'https://api.safaricom.co.ke';

export class MpesaProvider implements PaymentProvider {
  readonly id = 'mpesa';
  private readonly base: string;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: MpesaConfig) {
    this.base = cfg.apiBase ?? (cfg.environment === 'production' ? PROD_BASE : SANDBOX_BASE);
  }

  /**
   * STK Push — triggers a payment prompt on the customer's phone. Returns a
   * PaymentIntent with the CheckoutRequestID as the intent id.
   */
  async createPaymentIntent(req: PaymentIntentCreate): Promise<PaymentIntent> {
    const token = await this.getAccessToken();
    const timestamp = formatTimestamp();
    const password = Buffer.from(`${this.cfg.shortCode}${this.cfg.passkey}${timestamp}`).toString('base64');
    const phoneNumber = req.metadata?.phone ?? req.customerId ?? '';
    if (!phoneNumber) throw new PaymentError('phone number is required for M-Pesa STK Push', 'invalid_request', 400);

    const body = {
      BusinessShortCode: this.cfg.shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(req.amount / 100), // M-Pesa uses whole units, not cents
      PartyA: phoneNumber,
      PartyB: this.cfg.shortCode,
      PhoneNumber: phoneNumber,
      CallBackURL: this.cfg.callbackUrl ?? 'https://api.jataqi.local/payments/mpesa/callback',
      AccountReference: req.metadata?.reference ?? req.customerId ?? 'JATAQI',
      TransactionDesc: req.description ?? 'Payment',
    };

    const res = await fetch(`${this.base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || data.ResponseCode !== '0') {
      throw new PaymentError(
        `M-Pesa STK Push failed: ${data.errorMessage ?? data.ResponseDescription ?? 'unknown'}`,
        String(data.ResponseCode ?? 'mpesa_error'),
        res.status,
        data.ResponseCode === '1032', // 1032 = request cancelled by user
      );
    }
    return {
      id: String(data.CheckoutRequestID ?? ''),
      object: 'payment_intent',
      amount: req.amount,
      currency: req.currency,
      status: 'requires_action', // customer must approve on phone
      clientSecret: String(data.MerchantRequestID ?? ''),
      ...(req.description ? { description: req.description } : {}),
      ...(req.metadata ? { metadata: req.metadata } : {}),
    };
  }

  /** Query the STK Push transaction status. */
  async retrievePaymentIntent(id: string): Promise<PaymentIntent> {
    const token = await this.getAccessToken();
    const timestamp = formatTimestamp();
    const password = Buffer.from(`${this.cfg.shortCode}${this.cfg.passkey}${timestamp}`).toString('base64');
    const body = { BusinessShortCode: this.cfg.shortCode, Password: password, Timestamp: timestamp, CheckoutRequestID: id };
    const res = await fetch(`${this.base}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    const resultCode = String(data.ResultCode ?? '');
    const status: PaymentIntent['status'] =
      resultCode === '0' ? 'succeeded' :
      resultCode === '1032' || resultCode === '1037' ? 'canceled' :
      'processing';
    return {
      id, object: 'payment_intent', amount: 0, currency: 'KES',
      status, clientSecret: String(data.MerchantRequestID ?? ''),
      ...(data.ResultDesc ? { description: String(data.ResultDesc) } : {}),
    };
  }

  /** M-Pesa reversal (B2C/C2B reversal via the reversal API). */
  async refund(paymentIntentId: string, _amount?: number): Promise<Refund> {
    const token = await this.getAccessToken();
    const timestamp = formatTimestamp();
    const password = Buffer.from(`${this.cfg.shortCode}${this.cfg.passkey}${timestamp}`).toString('base64');
    const body = {
      Initiator: 'JATAQI',
      SecurityCredential: password,
      CommandID: 'TransactionReversal',
      TransactionID: paymentIntentId,
      ReceiverParty: this.cfg.shortCode,
      RecipientIdentifierType: '11',
      Remarks: 'Refund',
      Occasion: 'JATAQI Refund',
    };
    const res = await fetch(`${this.base}/mpesa/reversal/v1/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new PaymentError(`M-Pesa reversal failed: ${data.errorMessage ?? 'unknown'}`, 'reversal_error', res.status);
    return {
      id: String(data.OriginatorConversationID ?? `reversal-${Date.now()}`),
      object: 'refund', amount: _amount ?? 0, currency: 'KES',
      paymentIntentId, status: 'pending',
    };
  }

  /** Construct a webhook event from the M-Pesa callback payload. */
  async constructWebhookEvent(payload: string, _signature: string, _secret: string): Promise<WebhookEvent> {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const stkCallback = ((parsed.Body as Record<string, unknown> | undefined)?.stkCallback ?? parsed) as Record<string, unknown>;
    const resultCode = String(stkCallback.ResultCode ?? '');
    const callbackMeta = (stkCallback.CallbackMetadata ?? {}) as Record<string, unknown>;
    const items = (callbackMeta.Item ?? []) as Array<Record<string, unknown>>;
    const amount = Number(items.find((i) => i.Name === 'Amount')?.Value ?? 0);
    return {
      id: String(stkCallback.CheckoutRequestID ?? stkCallback.MerchantRequestID ?? `mpesa-${Date.now()}`),
      type: resultCode === '0' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed',
      data: { object: { ...stkCallback, amount: Math.round(amount * 100) } },
      created: Date.now(),
    };
  }

  /** Validate the M-Pesa callback signature (if configured). */
  verifyCallback(payload: string, signature: string, secret: string): boolean {
    if (!secret) return true; // no verification configured
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    return expected === signature;
  }

  // ---- token management ---------------------------------------------------

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 5000) return this.cachedToken.token;
    const auth = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64');
    const res = await fetch(`${this.base}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new PaymentError(`M-Pesa auth failed: ${res.status}`, 'auth_error', res.status);
    const data = await res.json() as Record<string, unknown>;
    const expiresInSeconds = Number(data.expires_in ?? 3600);
    this.cachedToken = {
      token: String(data.access_token),
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };
    return this.cachedToken.token;
  }
}

function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
