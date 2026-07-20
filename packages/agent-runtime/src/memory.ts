// Session memory — persistent message history for a conversation.

import type { ChatMessage } from './llm.js';

export interface ISessionMemory {
  append(message: ChatMessage): Promise<void>;
  all(): Promise<ChatMessage[]>;
  /** Return up to `limit` most recent messages. */
  tail(limit: number): Promise<ChatMessage[]>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

export class InMemorySessionMemory implements ISessionMemory {
  private messages: ChatMessage[] = [];
  async append(m: ChatMessage): Promise<void> { this.messages.push(m); }
  async all(): Promise<ChatMessage[]> { return [...this.messages]; }
  async tail(limit: number): Promise<ChatMessage[]> { return this.messages.slice(-limit); }
  async clear(): Promise<void> { this.messages = []; }
  async size(): Promise<number> { return this.messages.length; }
}

/**
 * Conversation manager — maintains one named session per conversation id.
 */
export class ConversationManager {
  private sessions = new Map<string, ISessionMemory>();

  get(id: string, factory?: () => ISessionMemory): ISessionMemory {
    let s = this.sessions.get(id);
    if (!s) {
      s = factory ? factory() : new InMemorySessionMemory();
      this.sessions.set(id, s);
    }
    return s;
  }

  async delete(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    await s.clear();
    this.sessions.delete(id);
    return true;
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }
}
