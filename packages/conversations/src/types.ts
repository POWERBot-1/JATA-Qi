// Conversation types — persistent chat history with folders, pins, search, sharing.

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  /** Model that generated this message (assistant only). */
  model?: string;
  /** Tool calls made during this message. */
  toolCalls?: { name: string; input: Record<string, unknown>; result?: unknown }[];
  /** Token usage for this message. */
  usage?: { promptTokens: number; completionTokens: number };
  /** Edited content (message editing support). */
  editedAt?: number;
  /** Regenerated from a previous message. */
  regeneratedFrom?: string;
}

export interface Conversation {
  id: string;
  title: string;
  userId: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** Folder for organization. */
  folderId?: string;
  /** Pinned to top. */
  pinned?: boolean;
  /** Archived (hidden from default list). */
  archived?: boolean;
  /** Temporary (not persisted after session end). */
  temporary?: boolean;
  /** Shared with a public link. */
  sharedId?: string;
  /** Custom system instructions. */
  systemPrompt?: string;
  /** Model preference for this conversation. */
  modelPreference?: string;
  /** Reasoning mode (standard/deep-research). */
  mode?: 'standard' | 'reasoning' | 'deep-research';
  /** Tags for search. */
  tags?: string[];
}

export interface Folder {
  id: string;
  name: string;
  userId: string;
  color?: string;
  createdAt: number;
}

export interface ConversationShare {
  id: string;
  conversationId: string;
  createdAt: number;
  expiresAt?: number;
}

export const ConversationEvents = Object.freeze({
  ConversationCreated: 'conversation.created',
  MessageAdded: 'conversation.message.added',
  ConversationDeleted: 'conversation.deleted',
  ConversationShared: 'conversation.shared',
  ConversationPinned: 'conversation.pinned',
} as const);
