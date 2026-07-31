// MessagingModule kernel integration tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { MessagingModule, SendGridProvider, TwilioProvider, AfricasTalkingProvider } from '../src/index.js';

describe('MessagingModule (kernel)', () => {
  it('registers providers from config', async () => {
    const kernel = createTestKernel();
    kernel.register(new MessagingModule({
      sendgrid: { apiKey: 'SG.x' },
      twilio: { accountSid: 'AC1', authToken: 't', fromNumber: '+1' },
      africasTalking: { apiKey: 'at1', username: 'sandbox' },
    }));
    await kernel.boot();
    const mod = kernel.getModule<MessagingModule>('messaging');
    assert.ok(mod.getEmailProvider('sendgrid') instanceof SendGridProvider);
    assert.ok(mod.getSmsProvider('twilio') instanceof TwilioProvider);
    assert.ok(mod.getSmsProvider('africas-talking') instanceof AfricasTalkingProvider);
    // Default getter returns the first configured.
    assert.ok(mod.getEmailProvider());
    assert.ok(mod.getSmsProvider());
    await kernel.shutdown();
  });

  it('boots without providers (graceful)', async () => {
    const kernel = createTestKernel();
    kernel.register(new MessagingModule());
    await kernel.boot();
    const mod = kernel.getModule<MessagingModule>('messaging');
    assert.equal(mod.getEmailProvider(), undefined);
    assert.equal(mod.getSmsProvider(), undefined);
    await kernel.shutdown();
  });
});
