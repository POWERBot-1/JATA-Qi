// PaymentsModule kernel integration tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { PaymentsModule, StripeProvider, MpesaProvider } from '../src/index.js';

describe('PaymentsModule (kernel)', () => {
  it('registers a Stripe provider from config', async () => {
    const kernel = createTestKernel();
    kernel.register(new PaymentsModule({ stripe: { secretKey: 'sk_test_x' } }));
    await kernel.boot();
    const mod = kernel.getModule<PaymentsModule>('payments');
    assert.ok(mod.stripe);
    assert.equal(mod.stripe!.id, 'stripe');
    assert.ok(mod.getProvider('stripe') instanceof StripeProvider);
    await kernel.shutdown();
  });

  it('boots without a provider (graceful)', async () => {
    const kernel = createTestKernel();
    kernel.register(new PaymentsModule());
    await kernel.boot();
    const mod = kernel.getModule<PaymentsModule>('payments');
    assert.equal(mod.stripe, undefined);
    await kernel.shutdown();
  });
});

describe('PaymentsModule — M-Pesa provider + pending-intent registry', () => {
  it('registers an M-Pesa provider from config (sandbox default)', async () => {
    const kernel = createTestKernel();
    kernel.register(new PaymentsModule({
      mpesa: { consumerKey: 'ck', consumerSecret: 'cs', shortCode: '174379', passkey: 'pk' },
    }));
    await kernel.boot();
    const mod = kernel.getModule<PaymentsModule>('payments');
    assert.ok(mod.mpesa);
    assert.equal(mod.mpesa!.id, 'mpesa');
    assert.ok(mod.getProvider('mpesa') instanceof MpesaProvider);
    assert.equal(mod.stripe, undefined, 'stripe absent when not configured');
    await kernel.shutdown();
  });

  it('registers both providers when both are configured', async () => {
    const kernel = createTestKernel();
    kernel.register(new PaymentsModule({
      stripe: { secretKey: 'sk_test_x' },
      mpesa: { consumerKey: 'ck', consumerSecret: 'cs', shortCode: '174379', passkey: 'pk', environment: 'production' },
    }));
    await kernel.boot();
    const mod = kernel.getModule<PaymentsModule>('payments');
    assert.ok(mod.stripe && mod.mpesa);
    await kernel.shutdown();
  });

  it('pending-intent registry attributes and consumes intent ids once', async () => {
    const kernel = createTestKernel();
    kernel.register(new PaymentsModule({ mpesa: { consumerKey: 'k', consumerSecret: 's', shortCode: '174379', passkey: 'p' } }));
    await kernel.boot();
    const mod = kernel.getModule<PaymentsModule>('payments');
    mod.recordPendingIntent('ws_CO_123', { customerId: 'cust_7', amount: 5000, currency: 'KES' });
    assert.equal(mod.pendingIntentCount, 1);
    const meta = mod.resolvePendingIntent('ws_CO_123');
    assert.deepEqual(meta, { customerId: 'cust_7', amount: 5000, currency: 'KES' });
    assert.equal(mod.pendingIntentCount, 0, 'attribution is single-use');
    assert.equal(mod.resolvePendingIntent('ws_CO_123'), undefined, 'unknown ids resolve to undefined');
    await kernel.shutdown();
  });

  it('ignores empty intent ids in the registry', async () => {
    const kernel = createTestKernel();
    kernel.register(new PaymentsModule());
    await kernel.boot();
    const mod = kernel.getModule<PaymentsModule>('payments');
    mod.recordPendingIntent('', { customerId: 'c', amount: 1, currency: 'KES' });
    assert.equal(mod.pendingIntentCount, 0);
    await kernel.shutdown();
  });
});
