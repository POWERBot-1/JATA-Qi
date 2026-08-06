// MobileModule — TANYA Mobile Native gateway surface.
//
// A thin kernel module that gives native iOS/Android apps a first-class API:
//   - push-device registration (FCM / APNs tokens) with lifecycle
//   - deterministic push-notification payload builders (APNs + FCM shapes)
//   - offline outbox sync — messages queued while offline are replayed
//     through the TANYA conversational layer on reconnect
//   - one-call home-screen snapshot (personas, orgs, recent conversations,
//     shared-with-me count, pending-approval count) so the native app can
//     render its launch screen with a single request
//
// Everything is best-effort over optional platform modules (tanya,
// conversations, organizations, tool-intelligence) — the module degrades
// gracefully on partial kernels.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';

const COL_DEVICES = 'mobile.devices';
const COL_OUTBOX = 'mobile.outbox';

export interface MobileDevice {
  id: string;
  userId: string;
  platform: 'ios' | 'android';
  pushToken?: string;
  name?: string;
  locale?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface RegisterDeviceInput {
  platform: 'ios' | 'android';
  pushToken?: string;
  name?: string;
  locale?: string;
}

export interface PushNotificationInput {
  title: string;
  body: string;
  event?: string;
  data?: Record<string, unknown>;
}

export interface PushPayload {
  apns: Record<string, unknown>;
  fcm: Record<string, unknown>;
}

export interface OutboxMessageInput {
  id: string;
  message: string;
  conversationId?: string;
  persona?: string;
  orgId?: string;
}

export interface OutboxResult {
  messageId: string;
  status: 'sent' | 'failed';
  conversationId?: string;
  reply?: string;
  error?: string;
}

export interface MobileSnapshot {
  serverTime: number;
  userId: string;
  devices: MobileDevice[];
  personas: Array<{ id: string; name: string; description: string }>;
  myOrgs: Array<{ id: string; name: string; slug: string; role?: string }>;
  recentConversations: Array<{ id: string; title: string; updatedAt: number; messageCount: number; pinned: boolean; orgId?: string }>;
  sharedWithMeCount: number;
  pendingApprovalCount: number;
}

export const MobileEvents = Object.freeze({
  DeviceRegistered: 'mobile.device.registered',
  DeviceRemoved: 'mobile.device.removed',
  PushSent: 'mobile.push.sent',
  OutboxSynced: 'mobile.outbox.synced',
} as const);

export class MobileModule implements IModule {
  readonly id = 'mobile';
  readonly tags = ['core', 'mobile', 'product'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private devices!: ICollection<MobileDevice>;
  private outbox!: ICollection<{ id: string; userId: string; message: string; conversationId?: string; persona?: string; orgId?: string; queuedAt: number }>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.devices = await storage.collection<MobileDevice>(COL_DEVICES);
    this.outbox = await storage.collection<{ id: string; userId: string; message: string; conversationId?: string; persona?: string; orgId?: string; queuedAt: number }>(COL_OUTBOX);
    kernel.container.registerValue('mobile', this);
    kernel.logger.info('mobile module initialized (TANYA Mobile Native)');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- devices -------------------------------------------------------------

  async registerDevice(userId: string, input: RegisterDeviceInput): Promise<MobileDevice> {
    if (input.platform !== 'ios' && input.platform !== 'android') throw new Error('platform must be "ios" or "android"');
    const now = Date.now();
    // Idempotent per user+token: refresh the existing device instead of duplicating.
    const existing = (await this.devices.all()).find((d) => d.userId === userId && d.pushToken === input.pushToken);
    if (existing) {
      const refreshed: MobileDevice = {
        ...existing,
        platform: input.platform,
        name: input.name ?? existing.name,
        locale: input.locale ?? existing.locale,
        lastSeenAt: now,
      };
      await this.devices.put(refreshed);
      return refreshed;
    }
    const device: MobileDevice = {
      id: randomUUID(),
      userId,
      platform: input.platform,
      ...(input.pushToken ? { pushToken: input.pushToken } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      createdAt: now,
      lastSeenAt: now,
    };
    await this.devices.put(device);
    await this.api.bus.emit(MobileEvents.DeviceRegistered, { deviceId: device.id, userId, platform: device.platform });
    return device;
  }

  async listDevices(userId: string): Promise<MobileDevice[]> {
    const all = await this.devices.all();
    return all.filter((d) => d.userId === userId).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  async unregisterDevice(userId: string, deviceId: string): Promise<boolean> {
    const device = await this.devices.get(deviceId);
    if (!device || device.userId !== userId) return false;
    await this.devices.delete(deviceId);
    await this.api.bus.emit(MobileEvents.DeviceRemoved, { deviceId, userId });
    return true;
  }

  // ---- push notifications ---------------------------------------------------

  /** Deterministic APNs + FCM payload shapes for a push notification. */
  buildPushPayload(input: PushNotificationInput): PushPayload {
    const data: Record<string, unknown> = { ...(input.data ?? {}) };
    if (input.event) data.event = input.event;
    return {
      apns: {
        aps: {
          alert: { title: input.title, body: input.body },
          sound: 'default',
          'content-available': 1,
          ...(input.event ? { event: input.event } : {}),
        },
        data,
      },
      fcm: {
        notification: { title: input.title, body: input.body },
        data,
        priority: 'high',
      },
    };
  }

  /** Send a push notification to every device of a user. Returns the count. */
  async notifyUser(userId: string, input: PushNotificationInput): Promise<{ delivered: number; payloads: PushPayload[] }> {
    const devices = await this.listDevices(userId);
    const payloads = devices.map(() => this.buildPushPayload(input));
    if (devices.length > 0) {
      await this.api.bus.emit(MobileEvents.PushSent, { userId, event: input.event, devices: devices.length });
    }
    return { delivered: devices.length, payloads };
  }

  // ---- offline outbox -------------------------------------------------------

  /**
   * Replay messages queued by a native client while offline. Each message is
   * routed through the TANYA conversational layer (best-effort; when tanya is
   * absent the message is stored for retry and reported failed).
   */
  async syncOutbox(userId: string, messages: OutboxMessageInput[]): Promise<{ results: OutboxResult[]; storedForRetry: number }> {
    const tanya = this.tryTanya();
    const results: OutboxResult[] = [];
    let storedForRetry = 0;
    for (const m of messages) {
      if (!m.id || !m.message) {
        results.push({ messageId: m.id ?? randomUUID(), status: 'failed', error: 'message and id are required' });
        continue;
      }
      if (!tanya) {
        await this.storeForRetry(userId, m);
        storedForRetry++;
        results.push({ messageId: m.id, status: 'failed', error: 'tanya module not registered — stored for retry' });
        continue;
      }
      try {
        const result = await tanya.chat({
          userId,
          message: m.message,
          ...(m.conversationId ? { conversationId: m.conversationId } : {}),
          ...(m.persona ? { persona: m.persona } : {}),
          ...(m.orgId ? { orgId: m.orgId } : {}),
        });
        results.push({ messageId: m.id, status: 'sent', conversationId: result.conversationId, reply: result.reply });
      } catch (e) {
        await this.storeForRetry(userId, m);
        storedForRetry++;
        results.push({ messageId: m.id, status: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (results.length > 0) {
      await this.api.bus.emit(MobileEvents.OutboxSynced, { userId, total: results.length, sent: results.filter((r) => r.status === 'sent').length });
    }
    return { results, storedForRetry };
  }

  /** Retry previously stored outbox messages; clears the successful ones. */
  async retryOutbox(userId: string): Promise<{ results: OutboxResult[]; remaining: number }> {
    const pending = (await this.outbox.all()).filter((o) => o.userId === userId);
    const results = await this.syncOutbox(userId, pending.map((o) => ({ id: o.id, message: o.message, ...(o.conversationId ? { conversationId: o.conversationId } : {}), ...(o.persona ? { persona: o.persona } : {}), ...(o.orgId ? { orgId: o.orgId } : {}) })));
    // Clear stored messages that went through.
    for (const r of results.results) {
      if (r.status === 'sent') await this.outbox.delete(r.messageId).catch(() => false);
    }
    const remaining = (await this.outbox.all()).filter((o) => o.userId === userId).length;
    return { results: results.results, remaining };
  }

  // ---- home-screen snapshot --------------------------------------------------

  /** One-call bootstrap for a native app's launch screen (best-effort). */
  async snapshot(userId: string): Promise<MobileSnapshot> {
    const devices = await this.listDevices(userId);
    const tanya = this.tryTanya();
    const conversations = this.tryConversations();
    const organizations = this.tryOrganizations();
    const toolIntel = this.tryToolIntelligence();

    const personas: MobileSnapshot['personas'] = tanya
      ? tanya.listPersonas().map((p: { id: string; name: string; description: string }) => ({ id: p.id, name: p.name, description: p.description }))
      : [];

    const myOrgs: MobileSnapshot['myOrgs'] = [];
    if (organizations) {
      try {
        const orgs = await organizations.organizationsForUser(userId);
        for (const o of orgs) {
          let role: string | undefined;
          try {
            const membership = await organizations.getMembership(o.id, userId);
            role = membership?.role;
          } catch { /* role optional */ }
          myOrgs.push({ id: o.id, name: o.name, slug: o.slug, ...(role ? { role } : {}) });
        }
      } catch { /* orgs best-effort */ }
    }

    const recentConversations: MobileSnapshot['recentConversations'] = [];
    if (conversations) {
      try {
        const listed = await conversations.list(userId, { limit: 10 });
        for (const c of listed.conversations) {
          recentConversations.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length, pinned: c.pinned ?? false, ...(c.orgId ? { orgId: c.orgId } : {}) });
        }
      } catch { /* conversations best-effort */ }
    }

    let sharedWithMeCount = 0;
    if (conversations) {
      try {
        sharedWithMeCount = (await conversations.listSharedWith(userId)).length;
      } catch { /* best-effort */ }
    }

    let pendingApprovalCount = 0;
    if (toolIntel) {
      try {
        pendingApprovalCount = toolIntel.listPendingApprovals().length;
      } catch { /* best-effort */ }
    }

    return {
      serverTime: Date.now(),
      userId,
      devices,
      personas,
      myOrgs,
      recentConversations,
      sharedWithMeCount,
      pendingApprovalCount,
    };
  }

  // ---- internals -----------------------------------------------------------

  private async storeForRetry(userId: string, m: OutboxMessageInput): Promise<void> {
    try {
      await this.outbox.put({ id: m.id, userId, message: m.message, ...(m.conversationId ? { conversationId: m.conversationId } : {}), ...(m.persona ? { persona: m.persona } : {}), ...(m.orgId ? { orgId: m.orgId } : {}), queuedAt: Date.now() });
    } catch { /* storage best-effort */ }
  }

  private tryTanya(): { chat(input: { userId: string; message: string; conversationId?: string; persona?: string; orgId?: string }): Promise<{ conversationId: string; reply: string }>; listPersonas(): Array<{ id: string; name: string; description: string }> } | undefined {
    try { return this.api.getModule('tanya') as never; } catch { return undefined; }
  }

  private tryConversations(): { list(userId: string, opts: { limit?: number }): Promise<{ conversations: Array<{ id: string; title: string; updatedAt: number; messages: unknown[]; pinned?: boolean; orgId?: string }> }>; listSharedWith(userId: string): Promise<unknown[]> } | undefined {
    try { return this.api.getModule('conversations') as never; } catch { return undefined; }
  }

  private tryOrganizations(): { organizationsForUser(userId: string): Promise<Array<{ id: string; name: string; slug: string }>>; getMembership(orgId: string, userId: string): Promise<{ role: string } | undefined> } | undefined {
    try { return this.api.getModule('organizations') as never; } catch { return undefined; }
  }

  private tryToolIntelligence(): { listPendingApprovals(): Array<unknown> } | undefined {
    try { return this.api.getModule('tool-intelligence') as never; } catch { return undefined; }
  }
}
