// MobileAppController tests — TANYA Mobile Reference App.
//
// Unit: outbox queue semantics + file storage roundtrip.
// Integration: the controller against a real gateway (CLI bootstrap), covering
// auth persistence, device lifecycle, home snapshot, streaming chat, offline
// outbox flush, live push feed (all three topics), and silent session rotation.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { JataQiClient } from '@jataqi/sdk';
import { MobileAppController, OutboxQueue, MemoryStorage, JsonFileStorage } from '../src/index.js';
import type { PushEvent } from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- unit: outbox queue + storage --------------------------------------------------

describe('OutboxQueue (offline queue semantics)', () => {
  it('enqueues, validates, dedupes, and lists oldest-first', async () => {
    const q = new OutboxQueue(new MemoryStorage());
    const a = await q.enqueue({ message: 'first' }, 'm1');
    assert.equal(a.queued, true);
    await q.enqueue({ message: 'second' }, 'm2');
    const dup = await q.enqueue({ message: 'first again' }, 'm1');
    assert.equal(dup.queued, false, 'duplicate id rejected');
    await assert.rejects(q.enqueue({ message: '' }), /message is required/);
    const list = await q.list();
    assert.deepEqual(list.map((m) => m.id), ['m1', 'm2']);
    assert.equal(await q.count(), 2);
  });

  it('applies server results: sent → removed, failed → kept with attempts', async () => {
    const q = new OutboxQueue(new MemoryStorage());
    await q.enqueue({ message: 'ok' }, 'ok1');
    await q.enqueue({ message: 'bad' }, 'bad1');
    const r = await q.applyResults([
      { messageId: 'ok1', status: 'sent', conversationId: 'c1', reply: 'done' },
      { messageId: 'bad1', status: 'failed', error: 'tanya module not registered' },
    ]);
    assert.equal(r.sent, 1);
    assert.equal(r.remaining, 1);
    const [kept] = await q.list();
    assert.equal(kept.id, 'bad1');
    assert.equal(kept.attempts, 1);
    assert.match(kept.lastError ?? '', /not registered/);
    await q.clear();
    assert.equal(await q.count(), 0);
  });

  it('JsonFileStorage roundtrips and removes atomically', async () => {
    const file = path.join(os.tmpdir(), `jataqi-mobile-app-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const s = new JsonFileStorage(file);
    await s.set('a', '1');
    await s.set('b', JSON.stringify({ x: 1 }));
    const s2 = new JsonFileStorage(file);
    assert.equal(await s2.get('a'), '1');
    assert.deepEqual(JSON.parse((await s2.get('b'))!), { x: 1 });
    await s2.remove('a');
    assert.equal(await s2.get('a'), null);
    assert.equal(await s2.get('b'), JSON.stringify({ x: 1 }));
  });
});

// --- integration: controller against a real gateway -----------------------------------

describe('MobileAppController (TANYA Mobile Reference App vs real server)', () => {
  let qi: Awaited<ReturnType<CreateJataQi>>;
  let admin: JataQiClient;
  let port: number;
  let closeHandle: () => Promise<void>;
  let app: MobileAppController;
  let appUserId: string;

  before(async () => {
    const bootstrapPath = new URL('../../../cli/dist/src/bootstrap.js', import.meta.url).href;
    const mod = await import(bootstrapPath) as unknown as { createJataQi: CreateJataQi };
    qi = await mod.createJataQi({ security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    const handle = await qi.gateway!.listen({ port: 0 });
    port = handle.port;
    closeHandle = handle.close;
    admin = new JataQiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await admin.auth.login('admin', 'admin');
  });

  after(async () => {
    app?.close();
    if (closeHandle) await closeHandle();
    if (qi) await qi.shutdown();
  });

  it('logs in through the controller and persists the session across instances', async () => {
    const storage = new MemoryStorage();
    app = new MobileAppController({ baseUrl: `http://127.0.0.1:${port}`, storage });
    await app.register('app-user', 'pw123', ['developer']);
    const s = await app.sessionStatus();
    assert.equal(s.authenticated, true);
    assert.equal(s.username, 'app-user');
    assert.ok(s.remainingMs > 0);
    appUserId = (await app.client.auth.whoami()).principal.userId;

    // A fresh controller with the same storage resumes the session.
    const resumed = new MobileAppController({ baseUrl: `http://127.0.0.1:${port}`, storage });
    const s2 = await resumed.sessionStatus();
    assert.equal(s2.authenticated, true);
    assert.equal(s2.username, 'app-user');
    assert.equal((await resumed.client.auth.whoami()).principal.username, 'app-user');
    resumed.close();
  });

  it('registers a device idempotently, heartbeats, and lists devices', async () => {
    const device = await app.registerDevice();
    assert.equal(device.platform, 'ios');
    assert.equal(device.pushToken, undefined);
    assert.ok(device.lastSeenAt > 0);
    const again = await app.heartbeat();
    assert.equal(again.id, device.id, 'same device refreshed');
    const list = await app.listDevices();
    assert.equal(list.count, 1);
    assert.equal(list.devices[0].id, device.id);
  });

  it('loads a home snapshot and serves it from the local cache', async () => {
    const home = await app.loadHome(true);
    assert.equal(home.userId, appUserId);
    assert.ok(home.personas.length >= 1);
    assert.ok(home.myOrgs.length >= 0);
    assert.ok(home.cachedAt > 0);
    const cached = await app.loadHome(false);
    assert.equal(cached.cachedAt, home.cachedAt, 'cache hit');
  });

  it('streams a TANYA chat word-by-word over /ws and accumulates chunks', async () => {
    const chunks: string[] = [];
    const r = await app.streamMessage('hello from the mobile app', { onChunk: (c) => chunks.push(c) });
    assert.ok(r.reply.length > 0);
    assert.equal(chunks.join(''), r.reply, 'chunks reconstruct the reply');
    assert.ok(r.conversationId.length > 0);
    assert.ok(r.messageCount >= 1);
  });

  it('streams chat scoped to a persona and org', async () => {
    const personas = await app.client.tanya.personas();
    const personaId = personas.personas[0].id;
    const orgs = await app.client.org.mine();
    const orgId = orgs.organizations[0]?.id;
    const r = await app.streamMessage('scoped turn', { personaId, ...(orgId ? { orgId } : {}) });
    assert.ok(r.reply.length > 0);
  });

  it('queues messages offline, flushes them through the outbox, and clears the queue', async () => {
    const e1 = await app.enqueueMessage('offline message one', { id: 'off-1' });
    const e2 = await app.enqueueMessage('offline message two', { id: 'off-2' });
    assert.equal(e1.queued, true);
    assert.equal(e2.queued, true);
    assert.equal(await app.pendingMessages().then((m) => m.length), 2);

    const sync = await app.syncOutbox();
    assert.equal(sync.sent, 2);
    assert.equal(sync.remaining, 0);
    assert.ok(sync.results.every((r) => r.status === 'sent'));
    assert.ok(sync.results.every((r) => (r.reply ?? '').length > 0), 'server replies included');
    assert.equal(await app.pendingMessages().then((m) => m.length), 0);
  });

  it('keeps failed outbox items queued for the next sync', async () => {
    // Inject a server-invalid item (empty message) directly into the queue.
    const storage = (app as unknown as { storage: MemoryStorage }).storage;
    await storage.set('jataqi.outbox.v1', JSON.stringify([{ id: 'bad-1', message: '', createdAt: Date.now(), attempts: 0 }]));
    const sync = await app.syncOutbox();
    assert.ok(sync.results.some((r) => r.status === 'failed'), 'server rejects empty message');
    assert.equal(sync.remaining, 1);
    const pending = await app.pendingMessages();
    assert.equal(pending[0].id, 'bad-1');
    assert.equal(pending[0].attempts, 1);
    await (app as unknown as { outbox: OutboxQueue }).outbox.clear();
  });

  it('subscribes to the live push feed and receives mobile.push.sent', async () => {
    const events: PushEvent[] = [];
    const unsub = app.subscribePush((ev) => events.push(ev));
    await sleep(250);
    await admin.mobile.emitPush(appUserId, 'Bridge event', 'Delivered through the feed', { event: 'demo.feed' });
    await sleep(400);
    unsub();
    const hit = events.find((e) => e.type === 'mobile.push.sent');
    assert.ok(hit, `mobile.push.sent received (got ${events.map((e) => e.type).join(',')})`);
    assert.equal(hit!.data.userId, appUserId);
    assert.equal(hit!.data.event, 'demo.feed');
  });

  it('receives conversation.shared_to and notification.created on the feed', async () => {
    const events: PushEvent[] = [];
    const unsub = app.subscribePush((ev) => events.push(ev));
    await sleep(250);

    // Admin shares a conversation with the app user.
    const conv = await admin.tanya.chat('share this conversation');
    await admin.tanya.share(conv.conversationId, { recipientUserId: appUserId });
    // Admin posts an in-app notification (broadcast to all feed subscribers).
    await admin.notifications.send('info', 'Hello from admin', 'An in-app notification');

    await sleep(500);
    unsub();
    assert.ok(events.some((e) => e.type === 'conversation.shared_to' && e.data.recipientUserId === appUserId), 'conversation.shared_to received');
    assert.ok(events.some((e) => e.type === 'notification.created'), 'notification.created received');
  });

  it('rotates silently only with IdP credentials; never throws otherwise', async () => {
    // Fresh session → no rotation needed.
    const fresh = await app.rotateIfExpiring(Number.MAX_SAFE_INTEGER);
    assert.equal(fresh.rotated, false);
    assert.equal(fresh.reason, 'no-idp-credentials');
    // Below threshold with bogus credentials → server rejects, gracefully reported.
    const bogus = new MobileAppController({
      baseUrl: `http://127.0.0.1:${port}`,
      idp: { clientId: 'missing-client', clientSecret: 'nope', refreshToken: 'stale' },
    });
    await bogus.login('app-user', 'pw123');
    const r = await bogus.rotateIfExpiring(Number.MAX_SAFE_INTEGER);
    assert.equal(r.rotated, false);
    assert.ok((r.reason ?? '').length > 0, 'reason reported');
    bogus.close();
  });

  it('unregisters the device and logs out (session cleared)', async () => {
    const removed = await app.unregisterDevice();
    assert.equal(removed.removed, true);
    assert.equal((await app.listDevices()).count, 0);
    await app.logout();
    const s = await app.sessionStatus();
    assert.equal(s.authenticated, false);
  });
});
