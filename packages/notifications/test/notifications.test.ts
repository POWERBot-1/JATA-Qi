import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { NotificationsModule } from '../src/index.js';
import type { DeliveryResult, NotificationChannel } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function captureChannel(id: string, log: DeliveryResult[]): NotificationChannel {
  return {
    id, type: 'webhook',
    async send(n) { log.push({ channel: id, ok: true, error: n.id }); return { channel: id, ok: true }; },
  };
}

describe('NotificationsModule (kernel integration)', () => {
  let kernel: Kernel;
  let n: NotificationsModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new NotificationsModule({ rateLimitPerWindow: 3, rateWindowMs: 60_000 }));
    await kernel.boot();
    n = kernel.getModule<NotificationsModule>('notifications');
  });

  it('stores notifications in the in-app inbox and delivers', async () => {
    const { notification, deliveries } = await n.notify('u1', { type: 'system', title: 'Welcome', body: 'hi' });
    assert.equal(notification.recipientId, 'u1');
    assert.ok(notification.channels.includes('inapp'));
    assert.ok(deliveries.some((d) => d.channel === 'inapp' && d.ok));
    const list = await n.list('u1');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.read, false);
  });

  it('delivers to extra registered channels', async () => {
    const delivered: DeliveryResult[] = [];
    n.registerChannel(captureChannel('hook', delivered));
    await n.setPreferences('u2', { alert: { enabled: true, channels: ['inapp', 'hook'] } });
    const { deliveries } = await n.notify('u2', { type: 'alert', title: 'X' });
    assert.ok(deliveries.some((d) => d.channel === 'hook' && d.ok));
    assert.equal(delivered.length, 1);
  });

  it('respects disabled preferences', async () => {
    await n.setPreferences('u3', { marketing: { enabled: false, channels: ['inapp'] } });
    const { deliveries } = await n.notify('u3', { type: 'marketing', title: 'Ad' });
    assert.equal(deliveries.length, 0);
    // Still not delivered, but a notification record was not stored either.
    assert.equal((await n.list('u3')).length, 0);
  });

  it('rate-limits repeated notifications of the same type', async () => {
    let limited = 0;
    for (let i = 0; i < 6; i++) {
      const r = await n.notify('u4', { type: 'spammy', title: 'x' });
      if (r.rateLimited) limited++;
    }
    assert.equal(limited, 3); // 3 allowed, then 3 rate-limited
  });

  it('marks read / unread counts', async () => {
    await n.notify('u5', { type: 'a', title: '1' });
    await n.notify('u5', { type: 'b', title: '2' });
    assert.equal(await n.unreadCount('u5'), 2);
    const marked = await n.markAllRead('u5');
    assert.equal(marked, 2);
    assert.equal(await n.unreadCount('u5'), 0);
  });

  it('isolates inboxes per recipient (tenant-style)', async () => {
    await n.notify('u6', { type: 'a', title: 'mine' });
    await n.notify('u7', { type: 'a', title: 'theirs' });
    assert.equal((await n.list('u6')).length, 1);
    assert.equal((await n.list('u7')).length, 1);
  });
});
