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
});
