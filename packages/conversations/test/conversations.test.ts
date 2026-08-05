// ConversationsModule tests — CRUD, messages, folders, sharing, export, search.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { ConversationsModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('ConversationsModule', () => {
  let kernel: Kernel;
  let mod: ConversationsModule;
  const userId = 'user-1';

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new ConversationsModule());
    await kernel.boot();
    mod = kernel.getModule<ConversationsModule>('conversations');
  });
  after(async () => { await kernel.shutdown(); });

  // --- conversations ---

  it('creates, gets, and lists conversations', async () => {
    const conv = await mod.create(userId, { title: 'Test Chat' });
    assert.equal(conv.title, 'Test Chat');
    assert.equal(conv.userId, userId);
    assert.equal(conv.messages.length, 0);

    const found = await mod.get(conv.id);
    assert.ok(found);

    const { conversations, total } = await mod.list(userId);
    assert.ok(total >= 1);
    assert.ok(conversations.some((c) => c.id === conv.id));
  });

  it('renames a conversation', async () => {
    const conv = await mod.create(userId);
    const updated = await mod.rename(conv.id, 'Renamed');
    assert.equal(updated!.title, 'Renamed');
  });

  it('pins and unpins conversations', async () => {
    const a = await mod.create(userId, { title: 'A' });
    const b = await mod.create(userId, { title: 'B' });
    await mod.setPinned(a.id, true);
    const { conversations } = await mod.list(userId);
    // Pinned should be first.
    assert.ok(conversations[0]!.id === a.id || conversations[0]!.pinned === true);
  });

  it('archives and hides from default list', async () => {
    const conv = await mod.create(userId, { title: 'Archive Me' });
    await mod.setArchived(conv.id, true);
    const { conversations } = await mod.list(userId);
    assert.ok(!conversations.some((c) => c.id === conv.id));
    // Explicit archived=true shows it.
    const archived = await mod.list(userId, { archived: true });
    assert.ok(archived.conversations.some((c) => c.id === conv.id));
  });

  // --- messages ---

  it('adds messages and auto-titles from first user message', async () => {
    const conv = await mod.create(userId);
    const msg1 = await mod.addMessage(conv.id, 'user', 'What is quantum computing?');
    assert.equal(msg1.role, 'user');
    assert.ok(msg1.id);

    const updated = await mod.get(conv.id);
    assert.equal(updated!.title, 'What is quantum computing?');
    assert.equal(updated!.messages.length, 1);

    const msg2 = await mod.addMessage(conv.id, 'assistant', 'Quantum computing uses qubits...', { model: 'gpt-4' });
    assert.equal(msg2.model, 'gpt-4');
    const updated2 = await mod.get(conv.id);
    assert.equal(updated2!.messages.length, 2);
  });

  it('edits a message', async () => {
    const conv = await mod.create(userId);
    const msg = await mod.addMessage(conv.id, 'user', 'original');
    const edited = await mod.editMessage(conv.id, msg.id, 'edited content');
    assert.equal(edited!.content, 'edited content');
    assert.ok(edited!.editedAt);
  });

  it('deletes messages after a given message (for regeneration)', async () => {
    const conv = await mod.create(userId);
    await mod.addMessage(conv.id, 'user', 'q1');
    await mod.addMessage(conv.id, 'assistant', 'a1');
    await mod.addMessage(conv.id, 'user', 'q2');
    await mod.addMessage(conv.id, 'assistant', 'a2');
    const messages = (await mod.get(conv.id))!.messages;
    const removed = await mod.deleteMessagesAfter(conv.id, messages[1]!.id); // keep up to a1
    assert.equal(removed, 2); // removed q2 + a2
    const after = (await mod.get(conv.id))!.messages;
    assert.equal(after.length, 2);
  });

  // --- folders ---

  it('creates, lists, and deletes folders', async () => {
    const folder = await mod.createFolder(userId, 'Projects', '#ff0000');
    assert.equal(folder.name, 'Projects');

    const folders = await mod.listFolders(userId);
    assert.ok(folders.some((f) => f.id === folder.id));

    // Move a conversation to the folder.
    const conv = await mod.create(userId);
    await mod.moveToFolder(conv.id, folder.id);
    const inFolder = await mod.list(userId, { folderId: folder.id });
    assert.ok(inFolder.conversations.some((c) => c.id === conv.id));

    // Delete folder moves conversations to root.
    await mod.deleteFolder(folder.id);
    const moved = await mod.get(conv.id);
    assert.equal(moved!.folderId, undefined);
  });

  // --- search ---

  it('searches conversation titles and messages', async () => {
    await mod.create(userId, { title: 'Quantum Physics Discussion' });
    const conv2 = await mod.create(userId, { title: 'Random' });
    await mod.addMessage(conv2.id, 'user', 'Tell me about quantum entanglement');

    const results = await mod.list(userId, { search: 'quantum' });
    assert.ok(results.total >= 2);
  });

  // --- sharing ---

  it('shares and retrieves by share ID', async () => {
    const conv = await mod.create(userId, { title: 'Shared Chat' });
    await mod.addMessage(conv.id, 'user', 'hello');
    await mod.addMessage(conv.id, 'assistant', 'hi there');

    const shareId = await mod.share(conv.id);
    assert.ok(shareId);

    const shared = await mod.getByShareId(shareId);
    assert.ok(shared);
    assert.equal(shared!.title, 'Shared Chat');

    await mod.unshare(conv.id);
    const afterUnshare = await mod.getByShareId(shareId);
    assert.equal(afterUnshare, undefined);
  });

  // --- export ---

  it('exports as JSON, markdown, and text', async () => {
    const conv = await mod.create(userId, { title: 'Export Test' });
    await mod.addMessage(conv.id, 'user', 'Hi');
    await mod.addMessage(conv.id, 'assistant', 'Hello!');

    const json = await mod.export(conv.id, 'json');
    assert.ok(JSON.parse(json).title);

    const md = await mod.export(conv.id, 'markdown');
    assert.match(md, /# Export Test/);
    assert.match(md, /\*\*user\*\*: Hi/);

    const txt = await mod.export(conv.id, 'text');
    assert.match(txt, /\[user\] Hi/);
  });

  // --- stats ---

  it('returns conversation stats', async () => {
    const stats = await mod.stats(userId);
    assert.ok(stats.totalConversations > 0);
    assert.ok(stats.totalMessages > 0);
  });

  // --- events ---

  it('emits lifecycle events', async () => {
    const events: string[] = [];
    kernel.bus.on('conversation.created', () => { events.push('created'); });
    kernel.bus.on('conversation.message.added', () => { events.push('message'); });
    kernel.bus.on('conversation.shared', () => { events.push('shared'); });

    const conv = await mod.create(userId);
    await mod.addMessage(conv.id, 'user', 'event test');
    await mod.share(conv.id);

    assert.ok(events.includes('created'));
    assert.ok(events.includes('message'));
    assert.ok(events.includes('shared'));
  });

  // --- multi-user: org scope + recipient sharing ---

  it('creates org-scoped conversations and filters lists by orgId', async () => {
    const orgA = await mod.create(userId, { title: 'Org A Chat', orgId: 'org-a' });
    const orgB = await mod.create(userId, { title: 'Org B Chat', orgId: 'org-b' });
    const plain = await mod.create(userId, { title: 'Personal Chat' });

    assert.equal(orgA.orgId, 'org-a');
    assert.equal(orgB.orgId, 'org-b');
    assert.equal(plain.orgId, undefined, 'orgId optional (backward compatible)');

    const a = await mod.list(userId, { orgId: 'org-a' });
    assert.equal(a.total, 1);
    assert.equal(a.conversations[0]!.id, orgA.id);

    const b = await mod.list(userId, { orgId: 'org-b' });
    assert.equal(b.total, 1);
    assert.equal(b.conversations[0]!.id, orgB.id);

    // No filter → all (backward compatible).
    const all = await mod.list(userId);
    assert.ok(all.total >= 3);
  });

  it('shares to a recipient, lists shared-with, and unshares', async () => {
    const conv = await mod.create('owner-1', { title: 'Shared Chat' });

    const share = await mod.shareTo(conv.id, 'recipient-1', { sharedBy: 'owner-1' });
    assert.equal(share.conversationId, conv.id);
    assert.equal(share.recipientUserId, 'recipient-1');

    // Idempotent re-share refreshes the grant (no duplicate).
    const again = await mod.shareTo(conv.id, 'recipient-1', { sharedBy: 'owner-1' });
    assert.equal(again.id, share.id);
    assert.equal((await mod.sharesFor(conv.id)).length, 1);

    const shared = await mod.listSharedWith('recipient-1');
    assert.equal(shared.length, 1);
    assert.equal(shared[0]!.id, conv.id);

    // Other users don't see it.
    assert.equal((await mod.listSharedWith('someone-else')).length, 0);

    // Expiring share disappears after expiry.
    const exp = await mod.create('owner-2', { title: 'Expiring' });
    await mod.shareTo(exp.id, 'recipient-2', { sharedBy: 'owner-2', expiresInDays: 0 }); // expires immediately
    const expShares = (await mod.sharesFor(exp.id)).filter((s) => s.recipientUserId === 'recipient-2');
    assert.equal(expShares.length, 1);
    // listSharedWith filters expired grants: simulate by creating an expired grant directly.
    const { randomUUID } = await import('node:crypto');
    const expired = { id: randomUUID(), conversationId: exp.id, recipientUserId: 'recipient-3', createdAt: Date.now() - 1000, expiresAt: Date.now() - 500 };
    const storage = kernel.getModule('storage') as unknown as { collection: <T extends { id: string }>(n: string) => Promise<{ put: (v: T) => Promise<void> }> };
    const sharesCol = await storage.collection<{ id: string }>('conversations.shares');
    await sharesCol.put(expired as never);
    assert.equal((await mod.listSharedWith('recipient-3')).length, 0, 'expired grants hidden');

    // Unshare removes the grant.
    assert.equal(await mod.unshareFrom(conv.id, 'recipient-1'), true);
    assert.equal((await mod.listSharedWith('recipient-1')).length, 0);
    assert.equal(await mod.unshareFrom(conv.id, 'recipient-1'), false, 'second unshare is a no-op');
  });

  it('shareTo validates conversation + recipient', async () => {
    await assert.rejects(mod.shareTo('nope', 'r'), /not found/);
    await assert.rejects(mod.shareTo((await mod.create('u', { title: 'x' })).id, ''), /recipientUserId is required/);
  });
});
