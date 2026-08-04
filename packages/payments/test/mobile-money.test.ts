// Payment provider adapter tests — M-Pesa, Flutterwave, Pesapal, Airtel, PayPal.
// Each test runs against a mock HTTP server (no real API calls).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  MpesaProvider, FlutterwaveProvider, PesapalProvider, AirtelProvider, PayPalProvider,
} from '../src/index.js';
import type { PaymentProvider } from '../src/index.js';

/** Create a mock HTTP server that returns canned responses per path/method. */
function mockServer(routes: Array<{ method: string; pathMatch: RegExp; status?: number; body: Record<string, unknown> }>): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        for (const route of routes) {
          if (req.method === route.method && route.pathMatch.test(req.url ?? '')) {
            res.writeHead(route.status ?? 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(route.body));
            return;
          }
        }
        res.writeHead(404); res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port });
    });
  });
}

describe('MpesaProvider — STK Push + status + refund + webhook', () => {
  let server: Server; let port: number; let provider: MpesaProvider;

  before(async () => {
    const mock = await mockServer([
      { method: 'GET', pathMatch: /generate/, body: { access_token: 'test-token', expires_in: 3600 } },
      { method: 'POST', pathMatch: /stkpush\/v1\/processrequest/, body: { ResponseCode: '0', ResponseDescription: 'Success', MerchantRequestID: 'MR-1', CheckoutRequestID: 'CR-1' } },
      { method: 'POST', pathMatch: /stkpushquery/, body: { ResponseCode: '0', ResultCode: '0', ResultDesc: 'Approved' } },
      { method: 'POST', pathMatch: /reversal/, body: { OriginatorConversationID: 'OC-1', ResponseCode: '0' } },
    ]);
    server = mock.server; port = mock.port;
    provider = new MpesaProvider({ consumerKey: 'ck', consumerSecret: 'cs', shortCode: '174379', passkey: 'pk', apiBase: `http://127.0.0.1:${port}` });
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('creates a payment intent via STK Push', async () => {
    const intent = await provider.createPaymentIntent({ amount: 10000, currency: 'KES', metadata: { phone: '254712345678' }, description: 'Test' });
    assert.equal(intent.status, 'requires_action');
    assert.equal(intent.id, 'CR-1');
  });

  it('retrieves payment intent status (succeeded)', async () => {
    const intent = await provider.retrievePaymentIntent('CR-1');
    assert.equal(intent.status, 'succeeded');
  });

  it('processes a refund (reversal)', async () => {
    const refund = await provider.refund('CR-1', 5000);
    assert.equal(refund.status, 'pending');
    assert.equal(refund.paymentIntentId, 'CR-1');
  });

  it('parses webhook callback', async () => {
    const payload = JSON.stringify({ Body: { stkCallback: { ResultCode: '0', CheckoutRequestID: 'CR-1', CallbackMetadata: { Item: [{ Name: 'Amount', Value: 100 }] } } } });
    const event = await provider.constructWebhookEvent(payload, '', '');
    assert.equal(event.type, 'payment_intent.succeeded');
  });
});

describe('FlutterwaveProvider — init + verify + refund + webhook', () => {
  let server: Server; let port: number; let provider: FlutterwaveProvider;

  before(async () => {
    const mock = await mockServer([
      { method: 'POST', pathMatch: /\/v3\/payments$/, body: { status: 'success', data: { link: 'https://checkout.flw.com/ref123', tx_ref: 'jq-1' } } },
      { method: 'GET', pathMatch: /verify/, body: { status: 'success', data: { status: 'successful', amount: 100, currency: 'NGN' } } },
      { method: 'POST', pathMatch: /refund/, body: { status: 'success', data: { id: 42 } } },
    ]);
    server = mock.server; port = mock.port;
    provider = new FlutterwaveProvider({ secretKey: 'sk', apiBase: `http://127.0.0.1:${port}` });
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('initializes a payment', async () => {
    const intent = await provider.createPaymentIntent({ amount: 10000, currency: 'NGN', description: 'Test' });
    assert.equal(intent.status, 'requires_action');
    assert.ok(intent.clientSecret);
  });

  it('verifies a transaction', async () => {
    const intent = await provider.retrievePaymentIntent('jq-1');
    assert.equal(intent.status, 'succeeded');
  });

  it('processes a refund', async () => {
    const refund = await provider.refund('jq-1', 5000);
    assert.ok(refund.id);
  });
});

describe('PesapalProvider — order + status + token', () => {
  let server: Server; let port: number; let provider: PesapalProvider;

  before(async () => {
    const mock = await mockServer([
      { method: 'POST', pathMatch: /RequestToken/, body: { token: 'pt', error: null } },
      { method: 'POST', pathMatch: /SubmitOrder/, body: { status: '200', order_tracking_id: 'ot-1', redirect_url: 'https://pay.pesapal.com/ot-1' } },
      { method: 'GET', pathMatch: /GetTransactionStatus/, body: { status_code: 1, amount: 50, currency: 'KES' } },
    ]);
    server = mock.server; port = mock.port;
    provider = new PesapalProvider({ consumerKey: 'ck', consumerSecret: 'cs', apiBase: `http://127.0.0.1:${port}` });
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('submits an order', async () => {
    const intent = await provider.createPaymentIntent({ amount: 5000, currency: 'KES', description: 'Order' });
    assert.equal(intent.status, 'requires_action');
    assert.ok(intent.clientSecret);
  });

  it('gets transaction status (succeeded)', async () => {
    const intent = await provider.retrievePaymentIntent('ot-1');
    assert.equal(intent.status, 'succeeded');
  });
});

describe('AirtelProvider — collect + status + token', () => {
  let server: Server; let port: number; let provider: AirtelProvider;

  before(async () => {
    const mock = await mockServer([
      { method: 'POST', pathMatch: /oauth2\/token/, body: { access_token: 'at', expires_in: 3600 } },
      { method: 'POST', pathMatch: /payments\/$/, body: { status: { success: true, code: '201' }, data: { id: 'tx-1' } } },
      { method: 'GET', pathMatch: /payments\/tx-1/, body: { data: { transaction: { status: 'TS', amount: 50 }, currency: 'KES' } } },
    ]);
    server = mock.server; port = mock.port;
    provider = new AirtelProvider({ clientId: 'ci', clientSecret: 'cs', apiBase: `http://127.0.0.1:${port}` });
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('creates a collection request', async () => {
    const intent = await provider.createPaymentIntent({ amount: 5000, currency: 'KES', metadata: { phone: '254712345678' }, description: 'Airtel' });
    assert.equal(intent.status, 'requires_action');
  });

  it('gets transaction status', async () => {
    const intent = await provider.retrievePaymentIntent('tx-1');
    assert.equal(intent.status, 'succeeded');
  });
});

describe('PayPalProvider — order + capture + refund + token', () => {
  let server: Server; let port: number; let provider: PayPalProvider;

  before(async () => {
    const mock = await mockServer([
      { method: 'POST', pathMatch: /oauth2\/token/, body: { access_token: 'pt', expires_in: 3600 } },
      { method: 'POST', pathMatch: /checkout\/orders$/, body: { id: 'ORDER-1', status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal.com/approve' }] } },
      { method: 'GET', pathMatch: /orders\/ORDER-1/, body: { id: 'ORDER-1', status: 'COMPLETED', purchase_units: [{ amount: { currency_code: 'USD', value: '50.00' } }] } },
      { method: 'POST', pathMatch: /refund/, body: { id: 'REF-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '50.00' } } },
    ]);
    server = mock.server; port = mock.port;
    provider = new PayPalProvider({ clientId: 'ci', clientSecret: 'cs', apiBase: `http://127.0.0.1:${port}` });
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('creates an order', async () => {
    const intent = await provider.createPaymentIntent({ amount: 5000, currency: 'USD', description: 'PayPal test' });
    assert.equal(intent.status, 'requires_action');
    assert.ok(intent.clientSecret.includes('paypal.com'));
  });

  it('retrieves order status (COMPLETED)', async () => {
    const intent = await provider.retrievePaymentIntent('ORDER-1');
    assert.equal(intent.status, 'succeeded');
  });

  it('processes a refund', async () => {
    const refund = await provider.refund('ORDER-1', 5000);
    assert.equal(refund.status, 'succeeded');
  });
});
