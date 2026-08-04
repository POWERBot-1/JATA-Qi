// StripeProvider API client tests against a local mock Stripe API.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { StripeProvider, PaymentError } from '../src/index.js';

describe('StripeProvider — API client against a mock server', () => {
  let server: http.Server;
  let base: string;
  let provider: StripeProvider;
  const requests: { method: string; path: string; auth: string | undefined; body: string }[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', auth: req.headers['authorization'], body });
        if (req.url === '/v1/payment_intents' && req.method === 'POST' && body.includes('decline')) {
          res.writeHead(402, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } }));
        } else if (req.url === '/v1/payment_intents' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'pi_test_123', object: 'payment_intent', amount: 5000, currency: 'usd',
            status: 'requires_payment_method', client_secret: 'pi_test_123_secret_xyz',
            description: 'JATA Qi subscription',
          }));
        } else if (req.url?.startsWith('/v1/payment_intents/') && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: req.url.split('/').pop(), object: 'payment_intent', amount: 5000, currency: 'usd', status: 'succeeded', client_secret: 'cs_test' }));
        } else if (req.url === '/v1/refunds' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 're_test_1', object: 'refund', amount: 5000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_test_123' }));
        } else if (req.url === '/v1/payment_intents' && body.includes('decline')) {
          res.writeHead(402, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } }));
        } else {
          res.writeHead(404); res.end('{}');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    provider = new StripeProvider({ secretKey: 'sk_test_mock', apiBase: base, timeoutMs: 3000 });
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('creates a payment intent', async () => {
    requests.length = 0;
    const intent = await provider.createPaymentIntent({ amount: 5000, currency: 'usd', description: 'JATA Qi subscription' });
    assert.equal(intent.id, 'pi_test_123');
    assert.equal(intent.status, 'requires_payment_method');
    assert.equal(intent.clientSecret, 'pi_test_123_secret_xyz');
    // Verify the request used the secret key + form encoding.
    assert.equal(requests[0]!.method, 'POST');
    assert.equal(requests[0]!.auth, 'Bearer sk_test_mock');
    assert.ok(requests[0]!.body.includes('amount=5000'));
    assert.ok(requests[0]!.body.includes('currency=usd'));
  });

  it('retrieves a payment intent by id', async () => {
    const intent = await provider.retrievePaymentIntent('pi_test_456');
    assert.equal(intent.id, 'pi_test_456');
    assert.equal(intent.status, 'succeeded');
  });

  it('issues a refund', async () => {
    const refund = await provider.refund('pi_test_123');
    assert.equal(refund.id, 're_test_1');
    assert.equal(refund.status, 'succeeded');
    assert.equal(refund.paymentIntentId, 'pi_test_123');
  });

  it('surfaces a card decline as a PaymentError with declined=true', async () => {
    await assert.rejects(
      () => provider.createPaymentIntent({ amount: 100, currency: 'usd', description: 'decline' }),
      (e: unknown) => { const err = e as PaymentError; return err.declined === true && err.code === 'card_declined'; },
    );
  });

  it('handles metadata flattening in the form body', async () => {
    requests.length = 0;
    await provider.createPaymentIntent({ amount: 100, currency: 'eur', metadata: { orderId: '42', source: 'web' } });
    assert.ok(requests[0]!.body.includes('metadata%5BorderId%5D=42'));
    assert.ok(requests[0]!.body.includes('metadata%5Bsource%5D=web'));
  });
});
