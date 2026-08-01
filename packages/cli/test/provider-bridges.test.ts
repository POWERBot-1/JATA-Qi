// Provider bridge tests — email/SMS channels and Stripe payment adapter.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailChannel, createSmsChannel, createStripePaymentProvider } from '../src/provider-bridges.js';

// Stub providers for deterministic testing.
const stubEmail = {
  id: 'sendgrid',
  async send(msg: { to: string; from: string; subject: string; text: string }) {
    if (msg.to === 'fail@example.com') throw new Error('sendgrid error');
    return { status: 'queued' as const, providerId: 'sendgrid', messageId: 'sg_123' };
  },
};

const stubSms = {
  id: 'twilio',
  async send(msg: { to: string; body: string }) {
    if (msg.to === '+0000') throw new Error('twilio error');
    return { status: 'queued' as const, providerId: 'twilio', messageId: 'SM_1' };
  },
};

const stubStripe = {
  async createPaymentIntent(req: { amount: number; currency: string }) {
    if (req.amount < 0) throw new Error('invalid amount');
    return { id: 'pi_test_1', status: 'requires_payment_method', clientSecret: 'cs_test' };
  },
};

// Notification shape matching the real interface.
function notif(recipientId: string, title: string, body?: string) {
  return { id: 'n1', recipientId, type: 'system', title, priority: 'normal' as const, channels: ['email'], read: false, createdAt: Date.now(), ...(body ? { body } : {}) };
}

describe('Email notification channel', () => {
  it('delivers to a resolved email address', async () => {
    const ch = createEmailChannel(stubEmail as never, (id) => id === 'u1' ? 'alice@example.com' : undefined);
    const result = await ch.send(notif('u1', 'Welcome', 'Hello!') as never);
    assert.equal(result.channel, 'email');
    assert.equal(result.ok, true);
  });

  it('fails gracefully when no address is resolved', async () => {
    const ch = createEmailChannel(stubEmail as never, () => undefined);
    const result = await ch.send(notif('unknown', 'Test') as never);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /no email/);
  });

  it('handles provider errors', async () => {
    const ch = createEmailChannel(stubEmail as never, () => 'fail@example.com');
    const result = await ch.send(notif('u1', 'Test') as never);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /sendgrid/);
  });
});

describe('SMS notification channel', () => {
  it('delivers to a resolved phone number', async () => {
    const ch = createSmsChannel(stubSms as never, (id) => id === 'u1' ? '+1234567890' : undefined);
    const result = await ch.send(notif('u1', 'Code: 1234') as never);
    assert.equal(result.channel, 'sms');
    assert.equal(result.ok, true);
  });

  it('fails when no phone is resolved', async () => {
    const ch = createSmsChannel(stubSms as never, () => undefined);
    const result = await ch.send(notif('u1', 'Test') as never);
    assert.equal(result.ok, false);
  });
});

describe('Stripe payment provider bridge', () => {
  it('charges via createPaymentIntent', async () => {
    const provider = createStripePaymentProvider(stubStripe);
    assert.equal(provider.id, 'stripe');
    const result = await provider.charge({ amount: 5000, currency: 'usd' }, 'ref_1');
    assert.equal(result.ok, true);
    assert.equal(result.reference, 'pi_test_1');
  });

  it('handles errors from Stripe', async () => {
    const provider = createStripePaymentProvider(stubStripe);
    const result = await provider.charge({ amount: -1, currency: 'usd' }, 'ref_bad');
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  it('refund returns ok', async () => {
    const provider = createStripePaymentProvider(stubStripe);
    const result = await provider.refund('pi_test_1');
    assert.equal(result.ok, true);
  });
});
