// Stripe webhook signature verification tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { StripeProvider } from '../src/index.js';
import { PaymentError } from '../src/index.js';

function signWebhook(payload: string, secret: string, timestamp: number): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

describe('Stripe webhook verification', () => {
  const provider = new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_test' });
  const secret = 'whsec_test';
  const validPayload = JSON.stringify({
    id: 'evt_123', type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'pi_123', amount: 500, status: 'succeeded' } },
  });

  it('accepts a validly-signed webhook', async () => {
    const header = signWebhook(validPayload, secret, Math.floor(Date.now() / 1000));
    const event = await provider.constructWebhookEvent(validPayload, header, secret);
    assert.equal(event.type, 'payment_intent.succeeded');
    assert.equal(event.id, 'evt_123');
  });

  it('rejects a tampered signature', async () => {
    const header = signWebhook(validPayload, secret, Math.floor(Date.now() / 1000));
    const tampered = header.slice(0, -4) + '0000';
    await assert.rejects(() => provider.constructWebhookEvent(validPayload, tampered, secret), (e: unknown) => e instanceof PaymentError);
  });

  it('rejects an expired timestamp (> 5 min)', async () => {
    const old = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const header = signWebhook(validPayload, secret, old);
    await assert.rejects(
      () => provider.constructWebhookEvent(validPayload, header, secret),
      (e: unknown) => (e as PaymentError).code === 'timestamp_too_far',
    );
  });

  it('rejects a missing v1 signature component', async () => {
    await assert.rejects(
      () => provider.constructWebhookEvent(validPayload, 't=123', secret),
      (e: unknown) => (e as PaymentError).code === 'invalid_signature',
    );
  });

  it('rejects a wrong secret', async () => {
    const header = signWebhook(validPayload, 'wrong_secret', Math.floor(Date.now() / 1000));
    await assert.rejects(() => provider.constructWebhookEvent(validPayload, header, secret), PaymentError);
  });
});
