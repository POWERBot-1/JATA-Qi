// ConversationsModule — persistent conversation management with folders, pins,
// search, sharing, export, message editing, and regeneration tracking.
// Backed by the storage layer (persists across restarts).

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { ConversationEvents } from './types.js';
import type { Conversation, ConversationShare, Folder, Message, MessageRole } from './types.js';

const COL_CONVERSATIONS = 'conversations.all';
const COL_FOLDERS = 'conversations.folders';
const COL_SHARES = 'conversations.shares';

export interface ListOptions {
  folderId?: string;
  pinned?: boolean;
  archived?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
  /** Organization scope filter (multi-user TANYA). */
  orgId?: string;
}

export class ConversationsModule implements IModule {
  readonly id = 'conversations';
  readonly tags = ['core', 'conversations'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private conversations!: ICollection<Conversation>;
  private folders!: ICollection<Folder>;
  private shares!: ICollection<ConversationShare>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.conversations = await storage.collection<Conversation>(COL_CONVERSATIONS);
    this.folders = await storage.collection<Folder>(COL_FOLDERS);
    this.shares = await storage.collection<ConversationShare>(COL_SHARES);
    kernel.container.registerValue('conversations', this);
    kernel.logger.info('conversations module initialized');
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  // --- conversations --------------------------------------------------------

  async create(userId: string, opts: { title?: string; systemPrompt?: string; modelPreference?: string; mode?: Conversation['mode']; folderId?: string; temporary?: boolean; tags?: string[]; orgId?: string } = {}): Promise<Conversation> {
    const now = Date.now();
    const conv: Conversation = {
      id: randomUUID(),
      title: opts.title ?? 'New Conversation',
      userId,
      messages: [],
      createdAt: now,
      updatedAt: now,
      ...(opts.folderId ? { folderId: opts.folderId } : {}),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.modelPreference ? { modelPreference: opts.modelPreference } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.temporary ? { temporary: true } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
    };
    await this.conversations.put(conv);
    await this.api.bus.emit(ConversationEvents.ConversationCreated, { id: conv.id, userId, ...(opts.orgId ? { orgId: opts.orgId } : {}) });
    return conv;
  }

  async get(id: string): Promise<Conversation | undefined> {
    return this.conversations.get(id);
  }

  async list(userId: string, opts: ListOptions = {}): Promise<{ conversations: Conversation[]; total: number }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const all = (await this.conversations.all()).filter((c) => c.userId === userId);
    let filtered = all;
    if (opts.folderId) filtered = filtered.filter((c) => c.folderId === opts.folderId);
    if (opts.orgId) filtered = filtered.filter((c) => c.orgId === opts.orgId);
    if (opts.pinned !== undefined) filtered = filtered.filter((c) => (c.pinned ?? false) === opts.pinned);
    if (opts.archived !== undefined) filtered = filtered.filter((c) => (c.archived ?? false) === opts.archived);
    else filtered = filtered.filter((c) => !c.archived); // hide archived by default
    if (opts.search) {
      const q = opts.search.toLowerCase();
      filtered = filtered.filter((c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q)) ||
        (c.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    }
    // Sort: pinned first, then by updatedAt desc.
    filtered.sort((a, b) => {
      if ((b.pinned ?? false) !== (a.pinned ?? false)) return (b.pinned ?? false) ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
    return {
      conversations: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  }

  async delete(id: string): Promise<boolean> {
    const removed = await this.conversations.delete(id);
    if (removed) await this.api.bus.emit(ConversationEvents.ConversationDeleted, { id });
    return removed;
  }

  async rename(id: string, title: string): Promise<Conversation | undefined> {
    const conv = await this.conversations.get(id);
    if (!conv) return undefined;
    conv.title = title;
    conv.updatedAt = Date.now();
    await this.conversations.put(conv);
    return conv;
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const conv = await this.conversations.get(id);
    if (!conv) return;
    conv.pinned = pinned;
    await this.conversations.put(conv);
    await this.api.bus.emit(ConversationEvents.ConversationPinned, { id, pinned });
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    const conv = await this.conversations.get(id);
    if (!conv) return;
    conv.archived = archived;
    await this.conversations.put(conv);
  }

  async moveToFolder(id: string, folderId: string | undefined): Promise<void> {
    const conv = await this.conversations.get(id);
    if (!conv) return;
    conv.folderId = folderId;
    conv.updatedAt = Date.now();
    await this.conversations.put(conv);
  }

  async setMode(id: string, mode: Conversation['mode']): Promise<void> {
    const conv = await this.conversations.get(id);
    if (!conv) return;
    conv.mode = mode;
    await this.conversations.put(conv);
  }

  async setSystemPrompt(id: string, prompt: string | undefined): Promise<void> {
    const conv = await this.conversations.get(id);
    if (!conv) return;
    conv.systemPrompt = prompt;
    await this.conversations.put(conv);
  }

  // --- messages -------------------------------------------------------------

  async addMessage(conversationId: string, role: MessageRole, content: string, opts: { model?: string; usage?: Message['usage']; toolCalls?: Message['toolCalls'] } = {}): Promise<Message> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) throw new Error(`conversations: "${conversationId}" not found`);
    const msg: Message = {
      id: randomUUID(),
      role, content,
      createdAt: Date.now(),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.usage ? { usage: opts.usage } : {}),
      ...(opts.toolCalls ? { toolCalls: opts.toolCalls } : {}),
    };
    conv.messages.push(msg);
    conv.updatedAt = Date.now();
    // Auto-title from first user message.
    if (conv.title === 'New Conversation' && role === 'user') {
      conv.title = content.slice(0, 60) + (content.length > 60 ? '...' : '');
    }
    await this.conversations.put(conv);
    await this.api.bus.emit(ConversationEvents.MessageAdded, { conversationId, messageId: msg.id, role });
    return msg;
  }

  async editMessage(conversationId: string, messageId: string, content: string): Promise<Message | undefined> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) return undefined;
    const msg = conv.messages.find((m) => m.id === messageId);
    if (!msg) return undefined;
    msg.content = content;
    msg.editedAt = Date.now();
    conv.updatedAt = Date.now();
    await this.conversations.put(conv);
    return msg;
  }

  async deleteMessagesAfter(conversationId: string, messageId: string): Promise<number> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) return 0;
    const idx = conv.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return 0;
    const removed = conv.messages.splice(idx + 1); // remove everything after
    conv.updatedAt = Date.now();
    await this.conversations.put(conv);
    return removed.length;
  }

  // --- folders --------------------------------------------------------------

  async createFolder(userId: string, name: string, color?: string): Promise<Folder> {
    const folder: Folder = { id: randomUUID(), name, userId, ...(color ? { color } : {}), createdAt: Date.now() };
    await this.folders.put(folder);
    return folder;
  }

  async listFolders(userId: string): Promise<Folder[]> {
    return (await this.folders.all()).filter((f) => f.userId === userId);
  }

  async deleteFolder(id: string): Promise<boolean> {
    // Move conversations in this folder to root.
    const all = await this.conversations.all();
    for (const c of all) {
      if (c.folderId === id) { c.folderId = undefined; await this.conversations.put(c); }
    }
    return this.folders.delete(id);
  }

  // --- sharing --------------------------------------------------------------

  async share(conversationId: string, expiresInDays?: number): Promise<string> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) throw new Error(`conversations: "${conversationId}" not found`);
    const shareId = randomUUID();
    conv.sharedId = shareId;
    await this.conversations.put(conv);
    await this.api.bus.emit(ConversationEvents.ConversationShared, { conversationId, shareId });
    return shareId;
  }

  async getByShareId(shareId: string): Promise<Conversation | undefined> {
    const all = await this.conversations.all();
    return all.find((c) => c.sharedId === shareId);
  }

  async unshare(conversationId: string): Promise<void> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) return;
    conv.sharedId = undefined;
    await this.conversations.put(conv);
  }

  // --- recipient-scoped sharing (multi-user) -------------------------------

  /**
   * Share a conversation with a specific recipient (multi-user TANYA). The
   * share is a persistent grant the recipient can list via listSharedWith.
   * Idempotent per recipient; returns the share record.
   */
  async shareTo(conversationId: string, recipientUserId: string, opts: { expiresInDays?: number; sharedBy?: string } = {}): Promise<ConversationShare> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) throw new Error(`conversations: "${conversationId}" not found`);
    if (!recipientUserId) throw new Error('conversations: recipientUserId is required');
    const now = Date.now();
    const all = await this.shares.all();
    const existing = all.find((s) => s.conversationId === conversationId && s.recipientUserId === recipientUserId);
    if (existing) {
      // Refresh the grant (new expiry window).
      existing.expiresAt = opts.expiresInDays ? now + opts.expiresInDays * 86_400_000 : undefined;
      existing.sharedBy = opts.sharedBy ?? existing.sharedBy;
      await this.shares.put(existing);
      return existing;
    }
    const share: ConversationShare = {
      id: randomUUID(),
      conversationId,
      recipientUserId,
      createdAt: now,
      ...(opts.expiresInDays ? { expiresAt: now + opts.expiresInDays * 86_400_000 } : {}),
      ...(opts.sharedBy ? { sharedBy: opts.sharedBy } : {}),
    };
    await this.shares.put(share);
    await this.api.bus.emit(ConversationEvents.ConversationSharedTo, { conversationId, recipientUserId, shareId: share.id });
    return share;
  }

  /** Remove a recipient-scoped share grant. */
  async unshareFrom(conversationId: string, recipientUserId: string): Promise<boolean> {
    const all = await this.shares.all();
    const share = all.find((s) => s.conversationId === conversationId && s.recipientUserId === recipientUserId);
    if (!share) return false;
    await this.shares.delete(share.id);
    await this.api.bus.emit(ConversationEvents.ConversationUnsharedFrom, { conversationId, recipientUserId });
    return true;
  }

  /** All share grants of a conversation (public + recipient-scoped). */
  async sharesFor(conversationId: string): Promise<ConversationShare[]> {
    const all = await this.shares.all();
    return all.filter((s) => s.conversationId === conversationId);
  }

  /**
   * Org-scoped directory for admins/owners: every conversation in an org
   * with its owner, message count, and last-updated time. Used by the
   * multi-tenant admin surface (org lead sees the org's activity).
   */
  async listByOrg(orgId: string): Promise<Array<{ id: string; title: string; userId: string; messageCount: number; updatedAt: number; archived: boolean }>> {
    const all = await this.conversations.all();
    return all
      .filter((c) => c.orgId === orgId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, userId: c.userId, messageCount: c.messages.length, updatedAt: c.updatedAt, archived: c.archived ?? false }));
  }

  /** Conversations shared TO a user (not expired, not archived). */
  async listSharedWith(userId: string): Promise<Conversation[]> {
    const now = Date.now();
    const shares = (await this.shares.all()).filter((s) => s.recipientUserId === userId && (!s.expiresAt || s.expiresAt > now));
    const convs = await this.conversations.all();
    const out: Conversation[] = [];
    for (const s of shares) {
      const conv = convs.find((c) => c.id === s.conversationId);
      if (conv && !conv.archived) out.push(conv);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  /** Delete expired share grants (housekeeping). Returns the count removed. */
  async pruneExpiredShares(): Promise<number> {
    const now = Date.now();
    const all = await this.shares.all();
    let removed = 0;
    for (const s of all) {
      if (s.expiresAt && s.expiresAt <= now) {
        await this.shares.delete(s.id);
        removed++;
      }
    }
    if (removed > 0) {
      await this.api.bus.emit('conversation.share.expired', { removed });
    }
    return removed;
  }

  // --- export ---------------------------------------------------------------

  async export(conversationId: string, format: 'json' | 'markdown' | 'text' = 'json'): Promise<string> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) throw new Error(`conversations: "${conversationId}" not found`);
    switch (format) {
      case 'markdown':
        return `# ${conv.title}\n\n${conv.messages.map((m) => `**${m.role}**: ${m.content}`).join('\n\n')}`;
      case 'text':
        return conv.messages.map((m) => `[${m.role}] ${m.content}`).join('\n');
      case 'json':
      default:
        return JSON.stringify(conv, null, 2);
    }
  }

  // --- stats ----------------------------------------------------------------

  async stats(userId: string): Promise<{ totalConversations: number; totalMessages: number; pinnedCount: number }> {
    const all = (await this.conversations.all()).filter((c) => c.userId === userId);
    return {
      totalConversations: all.length,
      totalMessages: all.reduce((sum, c) => sum + c.messages.length, 0),
      pinnedCount: all.filter((c) => c.pinned).length,
    };
  }
}
