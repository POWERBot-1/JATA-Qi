// JATA Qi Mobile Reference App — mobile-first controller over the SDK.
//
// A single opinionated controller that wires the platform's mobile surface into
// the exact flows a native TANYA app needs:
//
//   1. Auth + session persistence (login/register/logout, token storage, live
//      session status, silent IdP rotation before expiry).
//   2. Device lifecycle (idempotent registration per push token, heartbeat,
//      unregister) — required before push delivery works.
//   3. Home screen (one-call snapshot, normalized + locally cached).
//   4. Streaming chat (word-by-word chunks over /ws, TANYA fallback personae).
//   5. Offline outbox (compose while offline, flush in batch, retry failures).
//   6. Push feed (live subscription to mobile.push.sent / notification.created
//      / conversation.shared_to over the realtime channel).
//
// The controller is platform-neutral (no React Native imports) — the reference
// app in examples/react-native-app/ layers Expo screens on top of it.

import { JataQiClient, JataQiError } from '@jataqi/sdk';
import { MemoryStorage, storageGet, storageSet, type MobileAppStorage } from './storage.js';
import { OutboxQueue, type OutboxMessage, type OutboxSyncResult } from './outbox.js';

// --- persisted keys ------------------------------------------------------------

const KEY_TOKEN = 'jataqi.token';
const KEY_USERNAME = 'jataqi.username';
const KEY_DEVICE_ID = 'jataqi.deviceId';
const KEY_HOME_CACHE = 'jataqi.home.v1';

// --- types ---------------------------------------------------------------------

export interface MobileAppOptions {
  /** Gateway base URL, e.g. 'https://api.example.com' or 'http://localhost:7400'. */
  baseUrl: string;
  /** KV storage; defaults to MemoryStorage (tests/previews). */
  storage?: MobileAppStorage;
  /** Platform reported to the server ('ios' | 'android'). */
  platform?: 'ios' | 'android';
  /** Push token from the platform push service (FCM/APNs). */
  pushToken?: string;
  deviceName?: string;
  locale?: string;
  /** Pre-authenticated bearer token (resumes a stored session). */
  token?: string;
  username?: string;
  /**
   * IdP client credentials + refresh token for silent session rotation
   * (PKI IdP bridge, RFC 6819 refresh-token rotation). Normally provisioned
   * once per user and kept in the app's secure storage (Keychain/Keystore).
   */
  idp?: { clientId: string; clientSecret: string; refreshToken: string };
}

export interface DeviceInfo {
  id: string;
  platform: string;
  pushToken?: string;
  name?: string;
  locale?: string;
  lastSeenAt: number;
}

export interface HomeState {
  serverTime: number;
  userId: string;
  devices: DeviceInfo[];
  personas: Array<{ id: string; name: string; description: string }>;
  myOrgs: Array<{ id: string; name: string; slug: string; role?: string }>;
  recentConversations: Array<{ id: string; title: string; updatedAt: number; messageCount: number; pinned: boolean; orgId?: string }>;
  sharedWithMeCount: number;
  pendingApprovalCount: number;
  cachedAt: number;
}

export interface SessionStatus {
  authenticated: boolean;
  username?: string;
  remainingMs: number;
  expiresAt?: number;
}

export interface StreamChatOptions {
  personaId?: string;
  conversationId?: string;
  orgId?: string;
  modelRouting?: boolean;
  onChunk?: (chunk: string) => void;
  onStep?: (step: Record<string, unknown>, index: number, total: number) => void;
  onError?: (error: string) => void;
}

export interface StreamChatResult {
  reply: string;
  conversationId: string;
  chunks: string[];
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result?: unknown }>;
  messageCount: number;
}

export interface PushEvent {
  type: string;
  data: Record<string, unknown>;
  ts: number;
}

export interface SyncSummary {
  sent: number;
  remaining: number;
  results: OutboxSyncResult[];
}

/** Topics the reference app listens to for its live push feed. */
export const PUSH_FEED_TOPICS = ['mobile.push.sent', 'notification.created', 'conversation.shared_to'] as const;

// --- controller -----------------------------------------------------------------

export class MobileAppController {
  /** The underlying typed SDK client (exposed for power use). */
  readonly client: JataQiClient;
  /** Local offline outbox queue. */
  readonly outbox: OutboxQueue;

  private readonly storage: MobileAppStorage;
  private readonly platform: 'ios' | 'android';
  private readonly pushToken?: string;
  private readonly deviceName?: string;
  private readonly locale?: string;
  private readonly idp?: { clientId: string; clientSecret: string; refreshToken: string };
  private pushUnsubscribe?: () => void;

  constructor(opts: MobileAppOptions) {
    this.client = new JataQiClient({ baseUrl: opts.baseUrl, token: opts.token });
    this.storage = opts.storage ?? new MemoryStorage();
    this.platform = opts.platform ?? 'ios';
    this.pushToken = opts.pushToken;
    this.deviceName = opts.deviceName;
    this.locale = opts.locale;
    this.idp = opts.idp;
    this.outbox = new OutboxQueue(this.storage);
    if (opts.token) {
      void storageSet(this.storage, KEY_TOKEN, opts.token);
      if (opts.username) void storageSet(this.storage, KEY_USERNAME, opts.username);
    }
  }

  // --- auth ---------------------------------------------------------------------

  async login(username: string, password: string): Promise<{ username: string; expiresAt: number }> {
    const r = await this.client.auth.login(username, password);
    await storageSet(this.storage, KEY_TOKEN, r.token);
    await storageSet(this.storage, KEY_USERNAME, username);
    return { username, expiresAt: r.expiresAt };
  }

  async register(username: string, password: string, roles: string[] = ['developer']): Promise<{ username: string }> {
    await this.client.auth.register(username, password, roles);
    await this.login(username, password);
    return { username };
  }

  async logout(): Promise<void> {
    try {
      if (this.client.getToken()) await this.client.auth.logout();
    } catch {
      // Server may be unreachable (offline logout) — local state still clears.
    }
    this.client.clearToken();
    await this.storage.remove(KEY_TOKEN);
    await this.storage.remove(KEY_USERNAME);
  }

  // --- session ------------------------------------------------------------------

  /** Live session status from /auth/session (no token → unauthenticated). */
  async sessionStatus(): Promise<SessionStatus> {
    const token = await storageGet<string>(this.storage, KEY_TOKEN);
    if (!token) return { authenticated: false, remainingMs: 0 };
    // Make sure the in-memory client carries the persisted token.
    if (!this.client.getToken()) this.client.setToken(token);
    const s = await this.client.auth.session();
    if (!s) return { authenticated: false, remainingMs: 0 };
    const username = (await storageGet<string>(this.storage, KEY_USERNAME)) ?? s.username;
    return { authenticated: true, username, remainingMs: s.remainingMs, expiresAt: s.expiresAt };
  }

  /**
   * Silent session rotation: refresh the platform session through the PKI IdP
   * bridge before it expires (RFC 6819 refresh-token rotation, mirrors the web
   * console's rotate-on-401 flow). Requires IdP credentials (`opts.idp`,
   * normally provisioned once per user into secure storage). Returns
   * `rotated: false` (never throws) when they are absent or the server has no
   * matching client — the app then falls back to interactive login.
   */
  async rotateIfExpiring(minRemainingMs = 60_000): Promise<{ rotated: boolean; remainingMs?: number; reason?: string }> {
    const status = await this.sessionStatus();
    if (!status.authenticated) return { rotated: false, reason: 'unauthenticated' };
    if (status.remainingMs > minRemainingMs) return { rotated: false, reason: 'session-fresh' };
    if (!this.idp) return { rotated: false, reason: 'no-idp-credentials' };
    try {
      const r = await this.client.pki.rotate(this.idp.refreshToken, this.idp.clientId, this.idp.clientSecret);
      if (r.session?.token) {
        this.client.setToken(r.session.token);
        await storageSet(this.storage, KEY_TOKEN, r.session.token);
        const s = await this.client.auth.session();
        return { rotated: true, remainingMs: s?.remainingMs ?? 0 };
      }
      return { rotated: false, reason: r.reason ?? 'no-rotated-session' };
    } catch (err) {
      return { rotated: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Force a silent rotation attempt now (Settings → "Refresh session"). */
  async rotateNow(): Promise<{ rotated: boolean; remainingMs?: number; reason?: string }> {
    return this.rotateIfExpiring(Number.MAX_SAFE_INTEGER);
  }

  // --- device -------------------------------------------------------------------

  /** Register (or refresh) this device — idempotent per push token. */
  async registerDevice(): Promise<DeviceInfo> {
    const r = await this.client.mobile.registerDevice(this.platform, {
      pushToken: this.pushToken,
      name: this.deviceName,
      locale: this.locale,
    });
    await storageSet(this.storage, KEY_DEVICE_ID, r.device.id);
    return r.device;
  }

  /** Re-register with the current token → refreshes lastSeenAt server-side. */
  async heartbeat(): Promise<DeviceInfo> {
    return this.registerDevice();
  }

  async listDevices(): Promise<{ devices: DeviceInfo[]; count: number }> {
    return this.client.mobile.listDevices();
  }

  async unregisterDevice(deviceId?: string): Promise<{ removed: boolean }> {
    const id = deviceId ?? (await storageGet<string>(this.storage, KEY_DEVICE_ID));
    if (!id) return { removed: false };
    const r = await this.client.mobile.unregisterDevice(id);
    if (r.removed) await this.storage.remove(KEY_DEVICE_ID);
    return r;
  }

  // --- home ---------------------------------------------------------------------

  /**
   * Load the home screen. `refresh: true` hits the server and refreshes the
   * local cache; otherwise the cached snapshot is returned when available.
   */
  async loadHome(refresh = false): Promise<HomeState> {
    if (!refresh) {
      const cached = await storageGet<HomeState>(this.storage, KEY_HOME_CACHE);
      if (cached) return cached;
    }
    const snap = await this.client.mobile.snapshot();
    const home: HomeState = {
      serverTime: snap.serverTime,
      userId: snap.userId,
      devices: snap.devices as DeviceInfo[],
      personas: snap.personas,
      myOrgs: snap.myOrgs,
      recentConversations: snap.recentConversations,
      sharedWithMeCount: snap.sharedWithMeCount,
      pendingApprovalCount: snap.pendingApprovalCount,
      cachedAt: Date.now(),
    };
    await storageSet(this.storage, KEY_HOME_CACHE, home);
    return home;
  }

  // --- chat ---------------------------------------------------------------------

  async listConversations(opts: { orgId?: string; limit?: number } = {}): Promise<{ conversations: Array<{ id: string; title: string; updatedAt: number; pinned: boolean; messageCount: number; persona?: string }>; total: number }> {
    return this.client.tanya.listConversations(opts);
  }

  async getConversation(id: string): Promise<{ id: string; title: string; messages: Array<{ id: string; role: string; content: string; createdAt: number; toolCalls?: unknown[] }>; orgId?: string }> {
    return this.client.tanya.getConversation(id);
  }

  /**
   * Stream a conversational turn through the persona agent. Every chunk is
   * delivered to `onChunk` (and accumulated into the result) so the UI can
   * render a live typing bubble. Falls back to the HTTP chat endpoint when the
   * WebSocket handshake fails.
   */
  async streamMessage(message: string, opts: StreamChatOptions = {}): Promise<StreamChatResult> {
    const chunks: string[] = [];
    const onChunk = (c: string): void => {
      chunks.push(c);
      opts.onChunk?.(c);
    };
    try {
      const done = await this.client.streaming.tanyaChat(message, {
        persona: opts.personaId,
        conversationId: opts.conversationId,
        orgId: opts.orgId,
        modelRouting: opts.modelRouting,
        onChunk,
        onStep: opts.onStep,
        onError: opts.onError,
      });
      return {
        reply: chunks.join(''),
        conversationId: String(done.conversationId ?? ''),
        chunks,
        toolCalls: (done.toolCalls as Array<{ name: string; input: Record<string, unknown>; result?: unknown }>) ?? [],
        messageCount: Number(done.messageCount ?? 0),
      };
    } catch (err) {
      // WebSocket unavailable (flaky mobile networks) → HTTP fallback.
      const r = await this.client.tanya.chat(message, {
        persona: opts.personaId,
        conversationId: opts.conversationId,
        orgId: opts.orgId,
        modelRouting: opts.modelRouting,
      });
      onChunk(r.reply);
      return {
        reply: r.reply,
        conversationId: r.conversationId,
        chunks,
        toolCalls: r.toolCalls,
        messageCount: r.messageCount,
      };
    }
  }

  // --- outbox -------------------------------------------------------------------

  /** Compose offline: queues locally, returns the stored item. */
  async enqueueMessage(message: string, opts: { conversationId?: string; persona?: string; orgId?: string; id?: string } = {}): Promise<{ queued: boolean; item: OutboxMessage }> {
    return this.outbox.enqueue(
      { message, conversationId: opts.conversationId, persona: opts.persona, orgId: opts.orgId },
      opts.id,
    );
  }

  async pendingMessages(): Promise<OutboxMessage[]> {
    return this.outbox.list();
  }

  /** Flush the queue through the server-side outbox; sent items are removed. */
  async syncOutbox(): Promise<SyncSummary> {
    const pending = await this.outbox.list();
    if (pending.length === 0) return { sent: 0, remaining: 0, results: [] };
    const r = await this.client.mobile.syncOutbox(pending.map((m) => ({
      id: m.id,
      message: m.message,
      ...(m.conversationId ? { conversationId: m.conversationId } : {}),
      ...(m.persona ? { persona: m.persona } : {}),
      ...(m.orgId ? { orgId: m.orgId } : {}),
    })));
    await this.outbox.applyResults(r.results);
    return { sent: r.results.filter((x) => x.status === 'sent').length, remaining: await this.outbox.count(), results: r.results };
  }

  // --- push feed ----------------------------------------------------------------

  /**
   * Subscribe to the live push feed (mobile.push.sent, notification.created,
   * conversation.shared_to). Returns an unsubscribe function. Safe to call
   * multiple times — the previous subscription is dropped first.
   */
  subscribePush(handler: (ev: PushEvent) => void): () => void {
    this.pushUnsubscribe?.();
    const unsub = this.client.streaming.subscribe([...PUSH_FEED_TOPICS], (ev) => {
      handler({ type: ev.type, data: (ev.data ?? {}) as Record<string, unknown>, ts: ev.ts });
    });
    this.pushUnsubscribe = unsub;
    return unsub;
  }

  /** Close the underlying streaming socket. */
  close(): void {
    this.pushUnsubscribe?.();
    this.pushUnsubscribe = undefined;
    this.client.streaming.close();
  }
}

export { JataQiError };
