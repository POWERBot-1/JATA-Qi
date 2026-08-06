// JATA Qi Mobile Reference App — offline outbox queue.
//
// The queue is the mobile-first complement of the server-side outbox
// (`MobileModule.syncOutbox`): messages composed while offline are held in
// local storage, deduplicated by id, and flushed in one batch when connectivity
// returns. The controller maps server results back onto the queue (sent items
// are removed, failed items stay queued for the next sync).

import { storageGet, storageSet, type MobileAppStorage } from './storage.js';

export interface OutboxMessage {
  id: string;
  message: string;
  conversationId?: string;
  persona?: string;
  orgId?: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface OutboxEnqueueInput {
  message: string;
  conversationId?: string;
  persona?: string;
  orgId?: string;
}

export interface OutboxSyncResult {
  messageId: string;
  status: string;
  conversationId?: string;
  reply?: string;
  error?: string;
}

const DEFAULT_KEY = 'jataqi.outbox.v1';

export class OutboxQueue {
  private readonly storage: MobileAppStorage;
  private readonly key: string;

  constructor(storage: MobileAppStorage, key = DEFAULT_KEY) {
    this.storage = storage;
    this.key = key;
  }

  private async load(): Promise<OutboxMessage[]> {
    return (await storageGet<OutboxMessage[]>(this.storage, this.key)) ?? [];
  }

  private async save(items: OutboxMessage[]): Promise<void> {
    await storageSet(this.storage, this.key, items);
  }

  /** List queued messages, oldest first. */
  async list(): Promise<OutboxMessage[]> {
    const items = await this.load();
    return [...items].sort((a, b) => a.createdAt - b.createdAt);
  }

  async count(): Promise<number> {
    return (await this.load()).length;
  }

  /**
   * Enqueue a message. Duplicate ids are rejected (returns `queued: false`) and
   * empty messages are rejected with an error — both protect the server-side
   * sync contract (`message` and `id` are required there too).
   */
  async enqueue(input: OutboxEnqueueInput, id?: string): Promise<{ queued: boolean; item: OutboxMessage }> {
    if (!input.message || input.message.trim().length === 0) {
      throw new Error('outbox: message is required');
    }
    const messageId = id ?? `om-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const items = await this.load();
    if (items.some((m) => m.id === messageId)) {
      return { queued: false, item: items.find((m) => m.id === messageId)! };
    }
    const item: OutboxMessage = {
      id: messageId,
      message: input.message,
      conversationId: input.conversationId,
      persona: input.persona,
      orgId: input.orgId,
      createdAt: Date.now(),
      attempts: 0,
    };
    items.push(item);
    await this.save(items);
    return { queued: true, item };
  }

  /** Remove a message from the queue (e.g. after a successful sync). */
  async remove(id: string): Promise<boolean> {
    const items = await this.load();
    const next = items.filter((m) => m.id !== id);
    if (next.length === items.length) return false;
    await this.save(next);
    return true;
  }

  /** Mark a message as failed (kept for the next retry, attempts incremented). */
  async markFailed(id: string, error: string): Promise<void> {
    const items = await this.load();
    const item = items.find((m) => m.id === id);
    if (!item) return;
    item.attempts += 1;
    item.lastError = error;
    await this.save(items);
  }

  /** Drop every queued message. */
  async clear(): Promise<number> {
    const items = await this.load();
    const n = items.length;
    if (n > 0) await this.save([]);
    return n;
  }

  /** Apply server sync results: 'sent' → remove, anything else → mark failed. */
  async applyResults(results: OutboxSyncResult[]): Promise<{ sent: number; remaining: number }> {
    for (const r of results) {
      if (r.status === 'sent') {
        await this.remove(r.messageId);
      } else {
        await this.markFailed(r.messageId, r.error ?? `sync failed (${r.status})`);
      }
    }
    return { sent: results.filter((r) => r.status === 'sent').length, remaining: await this.count() };
  }
}
