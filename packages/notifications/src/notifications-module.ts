// NotificationsModule — multi-channel notification engine with an in-app inbox,
// per-recipient preferences, and simple per-type rate limiting. Delivery channels
// (webhook/email/sms) are pluggable adapters; in-app is built-in.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection, INamespace } from '@jataqi/storage';
import { NotificationEvents } from './types.js';
import type { DeliveryResult, Notification, NotificationChannel, NotificationPayload, Preferences, Priority } from './types.js';

const COL_INBOX = 'notifications.inbox';
const NS_PREFS = 'notifications.preferences';

interface RateBucket {
  count: number;
  resetAt: number;
}

export interface NotificationsConfig {
  /** Max notifications per recipient+type within the window (default 20). */
  rateLimitPerWindow?: number;
  /** Rate-limit window in ms (default 60s). */
  rateWindowMs?: number;
  /** Default channels when no preference is set (default ['inapp']). */
  defaultChannels?: Notification['channels'];
}

export class NotificationsModule implements IModule {
  readonly id = 'notifications';
  readonly tags = ['core', 'notifications'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private inbox!: ICollection<Notification>;
  private prefs!: INamespace;
  private readonly channels = new Map<string, NotificationChannel>();
  private readonly rate = new Map<string, RateBucket>();
  private readonly cfg: Required<NotificationsConfig>;

  constructor(cfg: NotificationsConfig = {}) {
    this.cfg = {
      rateLimitPerWindow: cfg.rateLimitPerWindow ?? 20,
      rateWindowMs: cfg.rateWindowMs ?? 60_000,
      defaultChannels: cfg.defaultChannels ?? ['inapp'],
    };
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
      namespace: (n: string) => Promise<INamespace>;
    };
    this.inbox = await storage.collection<Notification>(COL_INBOX);
    this.prefs = await storage.namespace(NS_PREFS);
    // Built-in in-app channel (stores to the inbox).
    this.registerChannel({
      id: 'inapp', type: 'inapp',
      async send() { return { channel: 'inapp', ok: true }; },
    });
    kernel.container.registerValue('notifications', this);
    kernel.logger.info('notifications module initialized');
  }

  async start(kernel: KernelApi): Promise<void> {
    // Event-driven notifications: surface commercial/lifecycle events to the
    // affected recipient. (Payload shapes are guarded; missing fields are skipped.)
    const recipientOf = (p: Record<string, unknown>): string | undefined =>
      (typeof p.customerId === 'string' && p.customerId) || (typeof p.userId === 'string' && p.userId) || undefined;
    const wire = (event: string, type: string, title: string): void => {
      kernel.bus.on(event, async (payload: Record<string, unknown>) => {
        const recipient = recipientOf(payload);
        if (recipient) await this.notify(recipient, { type, title, priority: 'normal', data: payload });
      });
    };
    wire('commerce.subscription.created', 'subscription', 'Your subscription started');
    wire('commerce.subscription.cancelled', 'subscription', 'Your subscription was cancelled');
    wire('commerce.usage.threshold', 'usage', 'You are approaching your usage limit');
    wire('commerce.credit.low', 'credits', 'Your credit balance is low');
    wire('commerce.payment.recorded', 'billing', 'A payment was recorded on your account');
    wire('tool.approval.requested', 'approval', 'A tool action needs your approval');
  }
  async stop(_kernel: KernelApi): Promise<void> { this.channels.clear(); }

  // --- channels ------------------------------------------------------------

  registerChannel(channel: NotificationChannel): void {
    this.channels.set(channel.id, channel);
  }

  // --- preferences ---------------------------------------------------------

  async setPreferences(recipientId: string, prefs: Preferences): Promise<Preferences> {
    await this.prefs.set(recipientId, prefs);
    return prefs;
  }
  async getPreferences(recipientId: string): Promise<Preferences> {
    return (await this.prefs.get<Preferences>(recipientId)) ?? {};
  }

  // --- notify --------------------------------------------------------------

  /** Create + deliver a notification, honoring preferences and rate limits. */
  async notify(recipientId: string, payload: NotificationPayload): Promise<{ notification: Notification; deliveries: DeliveryResult[]; rateLimited: boolean }> {
    if (!this.allowRate(recipientId, payload.type)) {
      return { notification: { id: randomUUID(), recipientId, type: payload.type, title: payload.title, priority: (payload.priority ?? 'normal') as Priority, channels: [], read: false, createdAt: Date.now() }, deliveries: [], rateLimited: true };
    }
    const pref = (await this.getPreferences(recipientId))[payload.type];
    const enabled = pref?.enabled !== false; // absent => enabled
    if (!enabled) {
      return { notification: { id: randomUUID(), recipientId, type: payload.type, title: payload.title, priority: (payload.priority ?? 'normal') as Priority, channels: [], read: false, createdAt: Date.now() }, deliveries: [], rateLimited: false };
    }
    const channelIds = pref?.channels?.length ? pref.channels : this.cfg.defaultChannels;
    const notification: Notification = {
      id: randomUUID(),
      recipientId,
      type: payload.type,
      title: payload.title,
      ...(payload.body !== undefined ? { body: payload.body } : {}),
      priority: payload.priority ?? 'normal',
      ...(payload.data !== undefined ? { data: payload.data } : {}),
      channels: [],
      read: false,
      createdAt: Date.now(),
    };
    // Store in inbox (in-app) regardless of channel set, then dispatch to selected channels.
    await this.inbox.put(notification);
    // Payload carries title/body so consumers (e.g. the mobile push bridge)
    // can forward the in-app notification to push devices without another lookup.
    await this.api.bus.emit(NotificationEvents.NotificationCreated, { id: notification.id, recipientId, type: payload.type, title: payload.title, ...(payload.body !== undefined ? { body: payload.body } : {}) });

    const deliveries: DeliveryResult[] = [];
    for (const id of channelIds) {
      const channel = this.channels.get(id);
      if (!channel) continue;
      try {
        const res = await channel.send(notification);
        deliveries.push(res);
        notification.channels.push(id);
        if (!res.ok) await this.api.bus.emit(NotificationEvents.DeliveryFailed, { channel: id, recipientId });
      } catch (err) {
        deliveries.push({ channel: id, ok: false, error: (err as Error).message });
      }
    }
    await this.inbox.put(notification);
    return { notification, deliveries, rateLimited: false };
  }

  // --- inbox ---------------------------------------------------------------

  async list(recipientId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
    let items = (await this.inbox.all()).filter((n) => n.recipientId === recipientId);
    if (opts.unreadOnly) items = items.filter((n) => !n.read);
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items.slice(0, opts.limit ?? 100);
  }

  async markRead(id: string): Promise<Notification | undefined> {
    const n = await this.inbox.get(id);
    if (!n) return undefined;
    const updated: Notification = { ...n, read: true };
    await this.inbox.put(updated);
    return updated;
  }

  async markAllRead(recipientId: string): Promise<number> {
    const items = (await this.inbox.all()).filter((n) => n.recipientId === recipientId && !n.read);
    for (const n of items) await this.inbox.put({ ...n, read: true });
    return items.length;
  }

  async unreadCount(recipientId: string): Promise<number> {
    return (await this.inbox.all()).filter((n) => n.recipientId === recipientId && !n.read).length;
  }

  // --- rate limiting -------------------------------------------------------

  private allowRate(recipientId: string, type: string): boolean {
    const key = `${recipientId}:${type}`;
    const now = Date.now();
    let bucket = this.rate.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.cfg.rateWindowMs };
      this.rate.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.cfg.rateLimitPerWindow;
  }
}
