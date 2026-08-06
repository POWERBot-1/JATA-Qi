// TanyaModule — TANYA AI, the JATA Qi conversational product layer.
//
// Thin composition over the platform primitives (nothing is re-implemented):
//   - @jataqi/conversations  — persistent conversation history, folders, search
//   - @jataqi/agent-runtime  — the ReAct agent that actually answers, with the
//     full platform tool surface (knowledge, fx, mobility, cloud, ...)
//   - @jataqi/pki            — Identity Provider bridge (identify / register
//     users from IdP access tokens, OIDC-lite)
//
// TANYA adds the product-level glue: named personas (materialized as agents
// with dedicated system prompts), tool-call-aware history persisted into
// conversations, and identity resolution. All components are optional and
// degrade gracefully on partial kernels.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ConversationsModule, ListOptions } from '@jataqi/conversations';
import type { Conversation } from '@jataqi/conversations';
import type { AgentRuntimeModule, AgentRunResult } from '@jataqi/agent-runtime';
import type { PkiModule } from '@jataqi/pki';
import type { OrganizationsModule } from '@jataqi/organizations';

export interface TanyaPersona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Agent name materialized on the agent runtime. */
  agentName: string;
}

export const TanyaEvents = Object.freeze({
  ChatCompleted: 'tanya.chat.completed',
} as const);

export interface TanyaChatInput {
  /** Owner of the conversation (from the session principal). */
  userId: string;
  message: string;
  /** Continue an existing conversation (must belong to the user). */
  conversationId?: string;
  /** Persona id (default 'main'). */
  persona?: string;
  /** Title used when a new conversation is created (defaults to a snippet). */
  title?: string;
  /** How many prior turns to feed the agent as context (default 20). */
  maxHistory?: number;
  /** Organization scope (multi-user TANYA): new conversations get orgId; continuing an existing conversation requires a matching orgId. */
  orgId?: string;
  /**
   * Optional streaming callback: receives the assistant reply in word chunks
   * as it is produced (WebSocket clients render these progressively).
   * Streaming is best-effort — a throwing callback never fails the chat.
   */
  onChunk?: (chunk: string) => void | Promise<void>;
}

export interface TanyaChatResult {
  conversationId: string;
  userId: string;
  persona: string;
  agent: string;
  reply: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result?: unknown }>;
  finishedReason: AgentRunResult['finishedReason'];
  error?: string;
  messageCount: number;
}

export interface TanyaIdentity {
  sub: string;
  name?: string;
  email?: string;
  preferred_username?: string;
}

/** Default persona: the TANYA assistant itself. */
const DEFAULT_PERSONA: TanyaPersona = Object.freeze({
  id: 'main',
  name: 'TANYA',
  description: 'JATA Qi conversational assistant — answers from platform knowledge, tools, and models.',
  systemPrompt: 'You are TANYA, the JATA Qi conversational AI assistant. Be concise, accurate, and helpful. Use the platform tools when they help answer the user.',
  agentName: 'tanya-main',
});

/** Derive a short conversation title from the first message. */
function autoTitle(message: string): string {
  const clean = message.trim().replace(/\s+/g, ' ');
  return clean.length <= 48 ? clean : `${clean.slice(0, 48)}…`;
}

export class TanyaModule implements IModule {
  readonly id = 'tanya';
  readonly tags = ['product', 'ai', 'conversational'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private conversations?: ConversationsModule;
  private agents?: AgentRuntimeModule;
  private pki?: PkiModule;
  private organizations?: OrganizationsModule;
  private personas = new Map<string, TanyaPersona>([[DEFAULT_PERSONA.id, DEFAULT_PERSONA]]);
  /** IdP identity bridge index: email/preferred_username → platform userId (sub). */
  private idpIdentities = new Map<string, { userId: string; via: 'email' | 'sub' }>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.conversations = this.tryModule<ConversationsModule>('conversations');
    this.agents = this.tryModule<AgentRuntimeModule>('agent-runtime');
    this.pki = this.tryModule<PkiModule>('pki');
    this.organizations = this.tryModule<OrganizationsModule>('organizations');
    kernel.container.registerValue('tanya', this);
    kernel.logger.info('tanya module initialized (TANYA AI conversational product layer)');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { this.personas.clear(); }

  // ---- personas -----------------------------------------------------------

  /** Register a named TANYA persona; materializes as an agent on the runtime. */
  registerPersona(input: { id: string; name?: string; description?: string; systemPrompt: string }): TanyaPersona {
    if (!input.id || !input.systemPrompt) throw new Error('id and systemPrompt are required');
    if (this.personas.has(input.id)) throw new Error(`persona ${input.id} already exists`);
    const persona: TanyaPersona = {
      id: input.id,
      name: input.name ?? input.id,
      description: input.description ?? '',
      systemPrompt: input.systemPrompt,
      agentName: `tanya-${input.id}`,
    };
    this.personas.set(input.id, persona);
    this.materializeAgent(persona);
    return persona;
  }

  listPersonas(): TanyaPersona[] {
    return [...this.personas.values()];
  }

  getPersona(id: string): TanyaPersona | undefined {
    return this.personas.get(id);
  }

  // ---- identity (PKI IdP bridge) ------------------------------------------

  /** Resolve an IdP access token to a TANYA identity. */
  identify(accessToken: string): TanyaIdentity | undefined {
    if (!this.pki) return undefined;
    const info = this.pki.idpUserinfo(accessToken);
    if (!info) return undefined;
    return {
      sub: info.sub,
      name: typeof info.name === 'string' ? info.name : undefined,
      email: typeof info.email === 'string' ? info.email : undefined,
      preferred_username: typeof info.preferred_username === 'string' ? info.preferred_username : undefined,
    };
  }

  /** Register or update an identity profile on the IdP. */
  registerIdentity(user: { sub: string; name?: string; email?: string; preferred_username?: string; roles?: string[] }): boolean {
    if (!this.pki || !user.sub) return false;
    this.pki.idp.upsertUser(user.sub, {
      name: user.name,
      email: user.email,
      preferred_username: user.preferred_username,
      ...(Array.isArray(user.roles) ? { roles: user.roles } : {}),
    });
    // Index IdP identities → platform userId for the sharing bridge.
    if (user.email) this.idpIdentities.set(user.email.toLowerCase(), { userId: user.sub, via: 'email' });
    if (user.preferred_username) this.idpIdentities.set(user.preferred_username.toLowerCase(), { userId: user.sub, via: 'email' });
    return true;
  }

  /** Resolve an IdP identity (email or sub) to a platform userId. */
  resolveIdpIdentity(identity: { email?: string; sub?: string }): { userId: string; via: 'email' | 'sub' } | undefined {
    if (identity.email) {
      const hit = this.idpIdentities.get(identity.email.toLowerCase());
      if (hit) return hit;
    }
    if (identity.sub) {
      const hit = this.idpIdentities.get(identity.sub.toLowerCase());
      if (hit) return hit;
      // The IdP sub IS the platform userId in the console linking flow —
      // accept it directly when it was registered through the IdP bridge.
      for (const entry of this.idpIdentities.values()) {
        if (entry.userId === identity.sub) return { userId: identity.sub, via: 'sub' };
      }
    }
    return undefined;
  }

  /** OIDC refresh_token grant via the PKI IdP (deep IdP integration). */
  idpRefresh(input: { refreshToken: string; clientId: string; clientSecret: string }): { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token?: string; scope?: string } | undefined {
    if (!this.pki) return undefined;
    try {
      return this.pki.idpRefresh(input);
    } catch {
      return undefined;
    }
  }

  /**
   * One-call session rotation: refreshes the IdP access token and mints a
   * fresh platform session (TANYA-level passthrough of PkiModule.rotateSession).
   */
  async rotateSession(input: { refreshToken: string; clientId: string; clientSecret: string; remoteAddress?: string }): Promise<{
    ok: boolean;
    reason?: string;
    idpTokens?: { access_token: string; expires_in: number; scope?: string };
    session?: { token: string; userId: string; username: string; expiresAt: number };
    principal?: { userId: string; username: string; roles: string[] };
  }> {
    if (!this.pki) return { ok: false, reason: 'pki module not registered on this kernel' };
    return this.pki.rotateSession(input);
  }

  // ---- chat ----------------------------------------------------------------

  /**
   * Run one conversational turn: persists the user message, runs the persona
   * agent with recent history + system prompt, persists the assistant reply
   * with tool-call details, and returns the result.
   */
  async chat(input: TanyaChatInput): Promise<TanyaChatResult> {
    if (!input.message || !input.message.trim()) throw new Error('message is required');
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    if (!this.agents) throw new Error('agent-runtime module not registered on this kernel');

    const persona = this.personas.get(input.persona ?? 'main') ?? this.personas.get('main')!;
    this.materializeAgent(persona);

    let conv: Conversation | undefined;
    if (input.conversationId) {
      conv = await this.conversations.get(input.conversationId);
      if (!conv) throw new Error(`conversation ${input.conversationId} not found`);
      if (conv.userId !== input.userId) throw new Error('conversation does not belong to this user');
      if (input.orgId && conv.orgId !== input.orgId) throw new Error('conversation does not belong to this organization');
    } else {
      conv = await this.conversations.create(input.userId, {
        title: input.title ?? autoTitle(input.message),
        systemPrompt: persona.systemPrompt,
        tags: ['tanya', persona.id],
        ...(input.orgId ? { orgId: input.orgId } : {}),
      });
    }

    await this.conversations.addMessage(conv.id, 'user', input.message);

    const maxHistory = input.maxHistory ?? 20;
    // A turn = user + assistant message pair, so cap at 2× the turn count;
    // the extra +1 excludes the user message we just added at the tail.
    const history = conv.messages
      .slice(-(maxHistory * 2 + 1), -1)
      .map((m) => ({ role: m.role, content: m.content }));

    const result = await this.agents.run(input.message, {
      agent: persona.agentName,
      systemPrompt: conv.systemPrompt ?? persona.systemPrompt,
      history,
      metadata: { product: 'tanya', persona: persona.id, conversationId: conv.id, userId: input.userId },
    });

    const reply = result.answer ?? (result.error ? `(error) ${result.error}` : '');
    const toolCalls = result.toolCalls.map((tc) => ({
      name: tc.tool,
      input: (tc.input ?? {}) as Record<string, unknown>,
      result: tc.error ? { error: tc.error } : tc.output,
    }));

    // Stream the reply in word chunks when a callback is provided (WS clients).
    if (input.onChunk) {
      try {
        const words = reply.split(/(\s+)/); // keep whitespace so chunks reassemble exactly
        for (const word of words) await input.onChunk(word);
      } catch { /* streaming is best-effort; never fail the chat */ }
    }

    const message = await this.conversations.addMessage(conv.id, 'assistant', reply, {
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
    void message;

    await this.api.bus.emit(TanyaEvents.ChatCompleted, {
      conversationId: conv.id, userId: input.userId, persona: persona.id, messageCount: (await this.conversations.get(conv.id))?.messages.length ?? 0,
    });

    return {
      conversationId: conv.id,
      userId: input.userId,
      persona: persona.id,
      agent: persona.agentName,
      reply,
      toolCalls,
      finishedReason: result.finishedReason,
      ...(result.error ? { error: result.error } : {}),
      messageCount: (await this.conversations.get(conv.id))?.messages.length ?? 0,
    };
  }

  // ---- conversation passthroughs (thin, read-mostly) ------------------------

  async listConversations(userId: string, opts: ListOptions = {}): Promise<{ conversations: Conversation[]; total: number }> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    return this.conversations.list(userId, opts);
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    return this.conversations.get(id);
  }

  async deleteConversation(id: string): Promise<boolean> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    return this.conversations.delete(id);
  }

  // ---- multi-user sharing (via the IdP identity bridge) ---------------------

  /**
   * Share a conversation with a platform user. The owner must own the
   * conversation (ownership enforcement). Returns the share grant.
   */
  async shareWith(conversationId: string, ownerId: string, recipientUserId: string, opts: { expiresInDays?: number } = {}): Promise<{ id: string; conversationId: string; recipientUserId: string; expiresAt?: number }> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    const conv = await this.conversations.get(conversationId);
    if (!conv) throw new Error(`conversation ${conversationId} not found`);
    if (conv.userId !== ownerId) throw new Error('conversation does not belong to this user');
    const share = await this.conversations.shareTo(conversationId, recipientUserId, { ...opts, sharedBy: ownerId });
    return { id: share.id, conversationId: share.conversationId, recipientUserId: share.recipientUserId!, ...(share.expiresAt ? { expiresAt: share.expiresAt } : {}) };
  }

  /**
   * Share through the IdP identity bridge: the recipient is identified by
   * their IdP identity (email or sub), which TANYA resolves to a platform
   * userId via identities registered through the PKI IdP bridge.
   */
  async shareWithIdpIdentity(conversationId: string, ownerId: string, identity: { email?: string; sub?: string }, opts: { expiresInDays?: number } = {}): Promise<{ id: string; conversationId: string; recipientUserId: string; via: 'email' | 'sub'; expiresAt?: number }> {
    const resolved = this.resolveIdpIdentity(identity);
    if (!resolved) throw new Error('no platform user found for the given IdP identity');
    const share = await this.shareWith(conversationId, ownerId, resolved.userId, opts);
    return { ...share, via: resolved.via };
  }

  /**
   * Org directory for members: conversation list for an org. Requires the
   * caller to be an org member (org module) OR the conversation owner —
   * admins/owners see the whole org, regular members only their own.
   */
  async orgConversations(orgId: string, callerUserId: string, opts: { adminOnly?: boolean } = {}): Promise<Array<{ id: string; title: string; userId: string; messageCount: number; updatedAt: number; archived: boolean }>> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    const role = await this.memberRole(orgId, callerUserId);
    if (!role) throw new Error('you are not a member of this organization');
    if (opts.adminOnly && role !== 'owner' && role !== 'admin') throw new Error('owner or admin role required');
    const all = await this.conversations.listByOrg(orgId);
    if (role === 'owner' || role === 'admin') return all;
    return all.filter((c) => c.userId === callerUserId);
  }

  /** Org membership role of a user (undefined when not a member). */
  async memberRole(orgId: string, userId: string): Promise<'owner' | 'admin' | 'member' | undefined> {
    if (!this.organizations) return undefined;
    try {
      const membership = await this.organizations.getMembership(orgId, userId);
      return membership?.role === 'guest' ? undefined : membership?.role;
    } catch {
      return undefined;
    }
  }

  /** Conversations shared TO a user (multi-user inbox). */
  async sharedWithMe(userId: string): Promise<Array<{ id: string; title: string; ownerId: string; updatedAt: number; sharedBy?: string }>> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    const convs = await this.conversations.listSharedWith(userId);
    return convs.map((c) => ({ id: c.id, title: c.title, ownerId: c.userId, updatedAt: c.updatedAt }));
  }

  /** All share grants of a conversation (owner view). */
  async sharesFor(conversationId: string, ownerId: string): Promise<Array<{ id: string; recipientUserId?: string; createdAt: number; expiresAt?: number }>> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    const conv = await this.conversations.get(conversationId);
    if (!conv || conv.userId !== ownerId) throw new Error('conversation not found or not owned by this user');
    return (await this.conversations.sharesFor(conversationId)).map((s) => ({ id: s.id, ...(s.recipientUserId ? { recipientUserId: s.recipientUserId } : {}), createdAt: s.createdAt, ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}) }));
  }

  /** Delete expired share grants platform-wide (housekeeping). */
  async pruneExpiredShares(): Promise<number> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    return this.conversations.pruneExpiredShares();
  }

  /** Remove a recipient-scoped share (owner only). */
  async unshareFrom(conversationId: string, ownerId: string, recipientUserId: string): Promise<boolean> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    const conv = await this.conversations.get(conversationId);
    if (!conv || conv.userId !== ownerId) throw new Error('conversation not found or not owned by this user');
    return this.conversations.unshareFrom(conversationId, recipientUserId);
  }

  // ---- stats ---------------------------------------------------------------

  /** Per-user conversation statistics (thin product view). */
  async stats(userId: string): Promise<{ conversations: number; messages: number; personas: number }> {
    if (!this.conversations) throw new Error('conversations module not registered on this kernel');
    const { conversations } = await this.conversations.list(userId, { limit: 10_000 });
    const messages = conversations.reduce((n, c) => n + c.messages.length, 0);
    return { conversations: conversations.length, messages, personas: this.personas.size };
  }

  // ---- internals -----------------------------------------------------------

  private materializeAgent(persona: TanyaPersona): void {
    if (!this.agents) return;
    try {
      this.agents.getAgent(persona.agentName);
    } catch {
      // Not materialized yet — create it with the persona prompt + tools.
      this.agents.createAgent(persona.agentName, { systemPrompt: persona.systemPrompt });
    }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try {
      return this.api.getModule<T>(id);
    } catch {
      return undefined;
    }
  }
}

/** Run id used for event correlation (exported for tooling). */
export function tanyaRunId(): string {
  return randomUUID();
}
