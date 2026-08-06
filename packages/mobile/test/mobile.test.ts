// MobileModule tests — TANYA Mobile Native surface: device lifecycle,
// push payloads, offline outbox sync, and home-screen snapshots.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { ConversationsModule } from '@jataqi/conversations';
import { SecurityModule } from '@jataqi/security';
import { OrganizationsModule } from '@jataqi/organizations';
import { AgentRuntimeModule, EchoLLM } from '@jataqi/agent-runtime';
import { TanyaModule } from '@jataqi/tanya';
import { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import { MobileModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

async function bootMobile(opts: { withTanya?: boolean } = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  kernel.register(new ConversationsModule());
  kernel.register(new SecurityModule({ bootstrapAdmin: { username: 'admin', password: 'admin' } }));
  kernel.register(new OrganizationsModule());
  kernel.register(new ToolIntelligenceModule());
  if (opts.withTanya !== false) {
    kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
    kernel.register(new TanyaModule());
  }
  kernel.register(new MobileModule());
  await kernel.boot();
  return kernel;
}

describe('MobileModule — TANYA Mobile Native', () => {
  let kernel: Kernel;
  let mobile: MobileModule;

  beforeEach(async () => {
    kernel = await bootMobile();
    mobile = kernel.getModule<MobileModule>('mobile');
  });

  afterEach(async () => { await kernel.shutdown(); });

  it('registers devices idempotently per token, lists, and unregisters', async () => {
    const device = await mobile.registerDevice('u1', { platform: 'ios', pushToken: 'apns-token-1', name: 'iPhone', locale: 'en' });
    assert.equal(device.platform, 'ios');
    assert.equal(device.pushToken, 'apns-token-1');
    assert.ok(device.lastSeenAt > 0);

    // Same token again → same device id (refresh, no duplicate).
    const again = await mobile.registerDevice('u1', { platform: 'ios', pushToken: 'apns-token-1', name: 'iPhone 15', locale: 'en' });
    assert.equal(again.id, device.id);
    assert.equal(again.name, 'iPhone 15', 'device refreshed');

    // Different token → second device.
    const android = await mobile.registerDevice('u1', { platform: 'android', pushToken: 'fcm-token-1' });
    assert.notEqual(android.id, device.id);

    // Other user's devices are isolated.
    const other = await mobile.registerDevice('u2', { platform: 'android', pushToken: 'fcm-token-2' });
    assert.equal((await mobile.listDevices('u1')).length, 2);
    assert.equal((await mobile.listDevices('u2')).length, 1);

    // Unregister.
    assert.equal(await mobile.unregisterDevice('u1', android.id), true);
    assert.equal((await mobile.listDevices('u1')).length, 1);
    // Cross-user unregister is a no-op.
    assert.equal(await mobile.unregisterDevice('u2', device.id), false);

    // Invalid platform rejected.
    await assert.rejects(mobile.registerDevice('u1', { platform: 'nope' as never }), /platform/);
    void other;
  });

  it('builds deterministic APNs + FCM push payloads', async () => {
    const payload = mobile.buildPushPayload({ title: 'New reply', body: 'TANYA replied', event: 'tanya.reply', data: { conversationId: 'c1' } });
    assert.deepEqual(payload.apns.aps, {
      alert: { title: 'New reply', body: 'TANYA replied' },
      sound: 'default',
      'content-available': 1,
      event: 'tanya.reply',
    });
    assert.deepEqual(payload.apns.data, { conversationId: 'c1', event: 'tanya.reply' });
    assert.deepEqual(payload.fcm.notification, { title: 'New reply', body: 'TANYA replied' });
    assert.deepEqual(payload.fcm.data, { conversationId: 'c1', event: 'tanya.reply' });
    assert.equal(payload.fcm.priority, 'high');

    // Deterministic: identical input → identical output.
    assert.deepEqual(mobile.buildPushPayload({ title: 'New reply', body: 'TANYA replied', event: 'tanya.reply', data: { conversationId: 'c1' } }), payload);
  });

  it('notifyUser delivers payloads to every device of the user', async () => {
    await mobile.registerDevice('u1', { platform: 'ios', pushToken: 't1' });
    await mobile.registerDevice('u1', { platform: 'android', pushToken: 't2' });
    const result = await mobile.notifyUser('u1', { title: 'Hi', body: 'There' });
    assert.equal(result.delivered, 2);
    assert.equal(result.payloads.length, 2);
    assert.equal((result.payloads[0]!.fcm.notification as { title: string }).title, 'Hi');
    // No devices → zero delivered.
    assert.equal((await mobile.notifyUser('nobody', { title: 'x', body: 'y' })).delivered, 0);
  });

  it('syncs the offline outbox through TANYA and stores failures for retry', async () => {
    const results = await mobile.syncOutbox('u1', [
      { id: 'm1', message: 'Hello from offline' },
      { id: 'm2', message: 'Follow-up', orgId: 'org-1' },
    ]);
    assert.equal(results.results.length, 2);
    for (const r of results.results) {
      assert.equal(r.status, 'sent');
      assert.ok(r.conversationId);
      assert.match(r.reply ?? '', /Hello from offline|Follow-up/);
    }
    assert.equal(results.storedForRetry, 0);

    // Retry with nothing stored → empty.
    const retry = await mobile.retryOutbox('u1');
    assert.equal(retry.results.length, 0);
    assert.equal(retry.remaining, 0);
  });

  it('stores outbox messages when tanya is absent and retries later', async () => {
    const k2 = await bootMobile({ withTanya: false });
    try {
      const m2 = k2.getModule<MobileModule>('mobile');
      const result = await m2.syncOutbox('u1', [{ id: 'm1', message: 'queued offline' }]);
      assert.equal(result.results[0]!.status, 'failed');
      assert.match(result.results[0]!.error ?? '', /stored for retry/);
      assert.equal(result.storedForRetry, 1);

      // Retry still fails without tanya; message remains.
      const retry = await m2.retryOutbox('u1');
      assert.equal(retry.remaining, 1);

      // Invalid input rejected.
      const bad = await m2.syncOutbox('u1', [{ id: '', message: '' }]);
      assert.equal(bad.results[0]!.status, 'failed');
    } finally {
      await k2.shutdown();
    }
  });

  it('produces a home-screen snapshot across optional modules', async () => {
    // Seed data: org + membership, a conversation, a pending approval, a device.
    const orgs = kernel.getModule<OrganizationsModule>('organizations');
    const org = await orgs.createOrganization('Acme Mobile', 'u1', 'acme-mobile'); // owner auto-member

    const tanya = kernel.getModule<TanyaModule>('tanya');
    await tanya.chat({ userId: 'u1', message: 'mobile snapshot chat', orgId: org.id });
    await mobile.registerDevice('u1', { platform: 'android', pushToken: 'fcm-1', name: 'Pixel' });

    // A pending approval (tool-intelligence R4 tool).
    const tools = kernel.getModule<ToolIntelligenceModule>('tool-intelligence');
    const tool = await tools.register({ canonicalName: 'mobile-r4', provider: 'p', version: '1', category: 'c', capabilities: ['x'], protocol: 'function', riskClass: 'R4', status: 'ACTIVE' });
    tools.requestApproval(tool.id, 'u1', 'invoke');

    const snapshot = await mobile.snapshot('u1');
    assert.ok(snapshot.serverTime > 0);
    assert.equal(snapshot.userId, 'u1');
    assert.equal(snapshot.devices.length, 1);
    assert.equal(snapshot.devices[0]!.name, 'Pixel');
    assert.equal(snapshot.personas.length, 1); // default main persona
    assert.equal(snapshot.personas[0]!.id, 'main');
    assert.equal(snapshot.myOrgs.length, 1);
    assert.equal(snapshot.myOrgs[0]!.id, org.id);
    assert.equal(snapshot.myOrgs[0]!.role, 'owner'); // creator is auto-owner
    assert.ok(snapshot.recentConversations.length >= 1);
    assert.equal(snapshot.recentConversations[0]!.orgId, org.id);
    assert.equal(snapshot.pendingApprovalCount, 1);
    assert.equal(snapshot.sharedWithMeCount, 0);
  });
});
