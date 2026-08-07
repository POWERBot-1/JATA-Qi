// MpesaProvider (Safaricom Daraja) API client tests against a local mock
// Daraja API: OAuth token, STK Push, status query, reversal, webhook event
// construction, and the operator-side callback HMAC verification.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { MpesaProvider, PaymentError } from '../src/index.js';

describe('MpesaProvider — Daraja API client against a mock server', () => {
  let server: http.Server;
  let base: string;
  let provider: MpesaProvider;
  const calls: { method: string; path: string; auth: string | undefined; body: string }[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls.push({ method: req.method ?? 'GET', path: req.url ?? '/', auth: req.headers['authorization'], body });
        const json = (code: number, obj: Record<string, unknown>) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.url === '/oauth/v1/generate?grant_type=client_credentials') {
          json(200, { access_token: 'tok_abc123', expires_in: 3599 });
        } else if (req.url === '/mpesa/stkpush/v1/processrequest') {
          if (body.includes('"Amount":99')) {
            // Cancelled by the user before approving.
            json(200, { ResponseCode: '1032', ResponseDescription: 'Request cancelled by user', CustomerMessage: 'Request cancelled by user' });
          } else {
            json(200, {
              ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'Success',
              CheckoutRequestID: 'ws_CO_26082024123456789012345678', MerchantRequestID: '29115-34620561-1',
            });
          }
        } else if (req.url === '/mpesa/stkpushquery/v1/query') {
          const ok = body.includes('ws_CO_26082024123456789012345678');
          json(200, {
            ResponseCode: '0', ResponseDescription: 'The service request has been processed successfully',
            MerchantRequestID: '29115-34620561-1',
            CheckoutRequestID: 'ws_CO_26082024123456789012345678',
            ResultCode: ok ? 0 : 1032,
            ResultDesc: ok ? 'The service request is processed successfully.' : 'Request cancelled by user',
          });
        } else if (req.url === '/mpesa/reversal/v1/request') {
          json(200, { OriginatorConversationID: '29470-34478933-1', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' });
        } else {
          json(404, {});
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    provider = new MpesaProvider({
      consumerKey: 'ck_test', consumerSecret: 'cs_test', shortCode: '174379', passkey: 'pk_test',
      environment: 'sandbox', callbackUrl: 'https://api.example.com/payments/webhook/mpesa', apiBase: base,
    });
  });

  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('STK Push returns a requires_action intent with CheckoutRequestID', async () => {
    calls.length = 0;
    const intent = await provider.createPaymentIntent({
      amount: 5000, currency: 'KES', customerId: 'cust_1', description: 'JATA Qi subscription',
      metadata: { phone: '254712345678', reference: 'cust_1' },
    });
    assert.equal(intent.status, 'requires_action');
    assert.equal(intent.id, 'ws_CO_26082024123456789012345678');
    assert.equal(intent.amount, 5000);
    assert.equal(intent.currency, 'KES');
    // Auth header must be the OAuth bearer token.
    const stk = calls.find((c) => c.path.includes('/stkpush/v1/processrequest'));
    assert.ok(stk, 'STK push request recorded');
    assert.equal(stk!.auth, 'Bearer tok_abc123');
    assert.ok(stk!.body.includes('"BusinessShortCode":"174379"'));
    assert.ok(stk!.body.includes('"Amount":50'), 'minor units → whole units for M-Pesa');
    assert.ok(stk!.body.includes('"PhoneNumber":"254712345678"'));
  });

  it('caches the OAuth token (no second token fetch)', async () => {
    calls.length = 0;
    const fresh = new MpesaProvider({
      consumerKey: 'ck_test', consumerSecret: 'cs_test', shortCode: '174379', passkey: 'pk_test',
      environment: 'sandbox', apiBase: base,
    });
    await fresh.createPaymentIntent({ amount: 100, currency: 'KES', customerId: 'c', metadata: { phone: '254700000000' } });
    await fresh.createPaymentIntent({ amount: 200, currency: 'KES', customerId: 'c', metadata: { phone: '254700000000' } });
    const tokenCalls = calls.filter((c) => c.path.includes('/oauth/v1/generate'));
    assert.equal(tokenCalls.length, 1, 'token fetched exactly once across intents');
  });

  it('surfaces a user-cancelled prompt as a declined PaymentError (1032)', async () => {
    await assert.rejects(
      () => provider.createPaymentIntent({ amount: 9900, currency: 'KES', customerId: 'c', metadata: { phone: '254700000000' } }),
      (e: unknown) => e instanceof PaymentError && (e as PaymentError).declined === true && (e as PaymentError).code === '1032',
    );
  });

  it('status query maps ResultCode 0 → succeeded', async () => {
    const intent = await provider.retrievePaymentIntent('ws_CO_26082024123456789012345678');
    assert.equal(intent.status, 'succeeded');
    assert.equal(intent.currency, 'KES');
  });

  it('status query maps ResultCode 1032 → canceled', async () => {
    // Mock returns 1032 when the query body carries no explicit ResultCode.
    const intent = await provider.retrievePaymentIntent('ws_CO_unknown');
    assert.equal(intent.status, 'canceled');
  });

  it('reversal returns a pending refund', async () => {
    const refund = await provider.refund('RKTQWE123');
    assert.equal(refund.status, 'pending');
    assert.ok(refund.id.length > 0);
    assert.equal(refund.paymentIntentId, 'RKTQWE123');
  });
});

describe('MpesaProvider — webhook event construction + callback HMAC', () => {
  const provider = new MpesaProvider({ consumerKey: 'k', consumerSecret: 's', shortCode: '174379', passkey: 'p' });
  const secret = 'mpesa_webhook_secret_test';

  const succeededPayload = JSON.stringify({
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_26082024123456789012345678',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 50 },
            { Name: 'MpesaReceiptNumber', Value: 'RKTQWE123' },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ],
        },
      },
    },
  });

  it('constructs payment_intent.succeeded from a successful STK callback', async () => {
    const event = await provider.constructWebhookEvent(succeededPayload, '', '');
    assert.equal(event.type, 'payment_intent.succeeded');
    assert.equal(event.id, 'ws_CO_26082024123456789012345678');
    assert.equal(event.data.object.amount, 5000, 'whole units → minor units (KES*100)');
    assert.equal(event.data.object.MpesaReceiptNumber, 'RKTQWE123');
  });

  it('constructs payment_intent.payment_failed for a non-zero ResultCode', async () => {
    const failed = JSON.stringify({
      Body: { stkCallback: { CheckoutRequestID: 'ws_CO_fail', ResultCode: 1032, ResultDesc: 'User cancelled' } },
    });
    const event = await provider.constructWebhookEvent(failed, '', '');
    assert.equal(event.type, 'payment_intent.payment_failed');
    assert.equal(event.id, 'ws_CO_fail');
  });

  it('verifyCallback accepts a valid HMAC over the exact payload', () => {
    const sig = createHmac('sha256', secret).update(succeededPayload).digest('hex');
    assert.equal(provider.verifyCallback(succeededPayload, sig, secret), true);
  });

  it('verifyCallback rejects a tampered payload/signature', () => {
    const sig = createHmac('sha256', secret).update(succeededPayload).digest('hex');
    assert.equal(provider.verifyCallback(succeededPayload + 'x', sig, secret), false);
    assert.equal(provider.verifyCallback(succeededPayload, sig.slice(0, -4) + '0000', secret), false);
    assert.equal(provider.verifyCallback(succeededPayload, sig, 'wrong-secret'), false);
  });

  it('verifyCallback passes through when no secret is configured', () => {
    assert.equal(provider.verifyCallback(succeededPayload, 'anything', ''), true);
  });
});
