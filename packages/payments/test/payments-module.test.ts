// PaymentsModule kernel integration tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { PaymentsModule, StripeProvider } from '../src/index.js';

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
