import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { CommunicationModule } from '../src/index.js';
import type { Channel, SendResult } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function mockChannel(type: 'email' | 'sms', ok = true): Channel {
  return {
    id: `mock-${type}`, type,
    async send(): Promise<SendResult> { return ok ? { ok: true, messageId: 'mock-' + Date.now() } : { ok: false, error: 'rejected' }; },
  };
}

describe('CommunicationModule', () => {
  let kernel: Kernel;
  let comm: CommunicationModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new CommunicationModule());
    await kernel.boot();
    comm = kernel.getModule<CommunicationModule>('communication');
  });

  it('sends via a registered channel adapter', async () => {
    comm.registerChannel(mockChannel('email'));
    const msg = await comm.send({ to: 'user@example.com', channel: 'email', subject: 'Test', body: 'Hello' });
    assert.equal(msg.status, 'sent');
    assert.ok(msg.providerMessageId);
  });

  it('sends via SMS channel', async () => {
    comm.registerChannel(mockChannel('sms'));
    const msg = await comm.send({ to: '+254700000000', channel: 'sms', body: 'Your code is 1234' });
    assert.equal(msg.status, 'sent');
  });

  it('creates and uses templates with variable interpolation', async () => {
    const tpl = await comm.createTemplate({
      name: 'welcome', channel: 'email', subject: 'Welcome {{name}}',
      body: 'Hi {{name}}, your account is ready.', variables: ['name'],
    });
    comm.registerChannel(mockChannel('email'));
    const msg = await comm.send({ to: 'x@y.com', templateId: tpl.id, variables: { name: 'Alice' } });
    assert.equal(msg.status, 'sent');
    assert.equal(msg.subject, 'Welcome Alice');
    assert.match(msg.body, /Hi Alice/);
  });

  it('fails gracefully when no adapter is registered', async () => {
    await assert.rejects(() => comm.send({ to: 'x@y.com', channel: 'email', body: 'hi' }), /no channel adapter/);
    const msgs = await comm.listMessages('x@y.com');
    assert.equal(msgs[0]!.status, 'failed');
  });

  it('records provider failures', async () => {
    comm.registerChannel(mockChannel('email', false));
    const msg = await comm.send({ to: 'x@y.com', channel: 'email', body: 'hi' });
    assert.equal(msg.status, 'failed');
    assert.ok(msg.error);
  });

  it('lists messages filtered by recipient and channel', async () => {
    comm.registerChannel(mockChannel('email'));
    comm.registerChannel(mockChannel('sms'));
    await comm.send({ to: 'a@b.com', channel: 'email', body: '1' });
    await comm.send({ to: 'a@b.com', channel: 'sms', body: '2' });
    await comm.send({ to: 'c@d.com', channel: 'email', body: '3' });
    assert.equal((await comm.listMessages('a@b.com')).length, 2);
    assert.equal((await comm.listMessages(undefined, 'sms')).length, 1);
  });

  it('lists available channels', async () => {
    comm.registerChannel(mockChannel('email'));
    comm.registerChannel(mockChannel('sms'));
    assert.ok(comm.listChannels().includes('email'));
    assert.ok(comm.listChannels().includes('sms'));
  });

  it('emits sent and failed events', async () => {
    let sent = 0; let failed = 0;
    kernel.bus.on('comm.message.sent', () => { sent++; });
    kernel.bus.on('comm.message.failed', () => { failed++; });
    comm.registerChannel(mockChannel('email', true));
    comm.registerChannel(mockChannel('sms', false));
    await comm.send({ to: 'a@b.com', channel: 'email', body: 'ok' });
    await comm.send({ to: '+254', channel: 'sms', body: 'bad' }).catch(() => {});
    assert.equal(sent, 1);
    assert.ok(failed >= 1);
  });
});
