// TANYA AI tests — conversational product layer over conversations +
// agent runtime + PKI IdP identity bridge.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { ConversationsModule } from '@jataqi/conversations';
import { AgentRuntimeModule, EchoLLM } from '@jataqi/agent-runtime';
import type { ILLM, ChatMessage, LLMRequest, LLMResponse } from '@jataqi/agent-runtime';
import { PkiModule } from '@jataqi/pki';
import { SecurityModule } from '@jataqi/security';
import { OrganizationsModule } from '@jataqi/organizations';
import { TanyaModule } from '../src/index.js';
import type { TanyaChatResult } from '../src/index.js';

/** Recording LLM — records the messages it sees and replies deterministically. */
class RecordingLLM implements ILLM {
  seen: ChatMessage[][] = [];
  constructor(private script: Array<{ text?: string; toolCalls?: { id: string; name: string; input: Record<string, unknown> }[] }> = []) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.seen.push(req.messages.map((m) => ({ ...m })));
    const next = this.script.shift();
    if (next?.text) {
      return { message: { role: 'assistant', content: next.text } };
    }
    if (next?.toolCalls?.length) {
      return { message: { role: 'assistant', content: '', toolCalls: next.toolCalls } };
    }
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    return { message: { role: 'assistant', content: `A: ${lastUser?.content ?? ''}` } };
  }
}

/** Boot a kernel with the TANYA stack (storage + conversations + agents + pki). */
async function bootTanya(opts: { llm?: ILLM; withPki?: boolean; withAgents?: boolean } = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  kernel.register(new ConversationsModule());
  kernel.register(new SecurityModule({ bootstrapAdmin: { username: 'admin', password: 'admin' } }));
  kernel.register(new OrganizationsModule());
  if (opts.withPki !== false) {
    kernel.register(new PkiModule({ issuer: 'https://id.jataqi.local' }));
  }
  if (opts.withAgents !== false) {
    kernel.register(new AgentRuntimeModule({ llm: opts.llm ?? new EchoLLM() }));
  }
  kernel.register(new TanyaModule());
  await kernel.boot();
  return kernel;
}

describe('TANYA AI conversational product layer', () => {
  it('chat creates a conversation, runs the agent, and persists both messages', async () => {
    const kernel = await bootTanya();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const result = await tanya.chat({ userId: 'u1', message: 'Hello TANYA' });
      assert.ok(result.conversationId);
      assert.equal(result.persona, 'main');
      assert.match(result.reply, /Hello TANYA/); // EchoLLM echoes
      assert.equal(result.finishedReason, 'answer');
      assert.equal(result.messageCount, 2);

      const conv = await tanya.getConversation(result.conversationId);
      assert.equal(conv!.userId, 'u1');
      assert.equal(conv!.messages.length, 2);
      assert.equal(conv!.messages[0]!.role, 'user');
      assert.equal(conv!.messages[1]!.role, 'assistant');
      assert.ok(conv!.systemPrompt, 'conversation carries the persona system prompt');
    } finally {
      await kernel.shutdown();
    }
  });

  it('chat continues an existing conversation and feeds history to the model', async () => {
    const llm = new RecordingLLM();
    const kernel = await bootTanya({ llm });
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const first = await tanya.chat({ userId: 'u1', message: 'What is my balance?' });
      const second = await tanya.chat({ userId: 'u1', conversationId: first.conversationId, message: 'And my wallet?' });

      assert.equal(second.conversationId, first.conversationId);
      assert.equal(second.messageCount, 4);

      // The second run must have seen the first turn (user + assistant) as history.
      const seen = llm.seen[llm.seen.length - 1]!;
      const historyRoles = seen.slice(1, -1).map((m) => m.role);
      assert.deepEqual(historyRoles, ['user', 'assistant']);
      assert.equal(seen[1]!.content, 'What is my balance?');
      assert.match(seen[2]!.content, /balance/);
      // ...and the current user message is last.
      assert.equal(seen[seen.length - 1]!.content, 'And my wallet?');
      // System prompt is present.
      assert.equal(seen[0]!.role, 'system');
    } finally {
      await kernel.shutdown();
    }
  });

  it('persists tool calls from agent runs into the conversation', async () => {
    const llm = new RecordingLLM([
      { toolCalls: [{ id: 't1', name: 'platform.search', input: { query: 'harambee' } }] },
      { text: 'Here is what I found.' },
    ]);
    const kernel = await bootTanya({ llm });
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const result = await tanya.chat({ userId: 'u1', message: 'Search the platform' }) as TanyaChatResult;
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.toolCalls[0]!.name, 'platform.search');
      assert.equal(result.reply, 'Here is what I found.');

      const conv = await tanya.getConversation(result.conversationId);
      const assistantMsg = conv!.messages.find((m) => m.role === 'assistant')!;
      assert.equal(assistantMsg.toolCalls?.length, 1);
      assert.equal(assistantMsg.toolCalls![0]!.name, 'platform.search');
    } finally {
      await kernel.shutdown();
    }
  });

  it('enforces conversation ownership and validates input', async () => {
    const kernel = await bootTanya();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const result = await tanya.chat({ userId: 'u1', message: 'mine' });

      await assert.rejects(tanya.chat({ userId: 'u2', conversationId: result.conversationId, message: 'hijack' }), /not belong/);
      await assert.rejects(tanya.chat({ userId: 'u1', conversationId: 'nope', message: 'x' }), /not found/);
      await assert.rejects(tanya.chat({ userId: 'u1', message: '   ' }), /message is required/);
    } finally {
      await kernel.shutdown();
    }
  });

  it('registerPersona materializes a named agent and chat routes to it', async () => {
    const llm = new RecordingLLM([{ text: 'Support reply.' }]);
    const kernel = await bootTanya({ llm });
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const persona = tanya.registerPersona({
        id: 'support',
        name: 'Support',
        description: 'Support specialist',
        systemPrompt: 'You are a support specialist. Be empathetic.',
      });
      assert.equal(persona.agentName, 'tanya-support');

      const agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
      const agent = agents.getAgent('tanya-support');
      assert.ok(agent, 'persona agent materialized');

      const result = await tanya.chat({ userId: 'u1', persona: 'support', message: 'My order is late' });
      assert.equal(result.persona, 'support');
      assert.equal(result.agent, 'tanya-support');
      assert.equal(result.reply, 'Support reply.');

      // The materialized agent carries the persona's system prompt.
      const seen = llm.seen[llm.seen.length - 1]!;
      assert.match(seen[0]!.content, /support specialist/);

      assert.throws(() => tanya.registerPersona({ id: 'support', systemPrompt: 'dup' }), /already exists/);
      assert.equal(tanya.listPersonas().length, 2);
    } finally {
      await kernel.shutdown();
    }
  });

  it('identify resolves IdP access tokens via the PKI bridge', async () => {
    const kernel = await bootTanya({ withPki: true });
    try {
      const pki = kernel.getModule<PkiModule>('pki');
      const tanya = kernel.getModule<TanyaModule>('tanya');
      assert.equal(tanya.registerIdentity({ sub: 'u1', name: 'Alice', email: 'alice@jataqi.local' }), true);

      const client = pki.registerIdpClient({ name: 'tanya-test', redirectUris: ['https://app.jataqi.local/cb'] });
      const auth = pki.idpAuthorize({ clientId: client.clientId, redirectUri: 'https://app.jataqi.local/cb', scope: 'openid profile', userId: 'u1' });
      const tokens = pki.idpToken({ code: auth.code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: 'https://app.jataqi.local/cb' });

      const identity = tanya.identify(tokens.access_token);
      assert.equal(identity!.sub, 'u1');
      assert.equal(identity!.name, 'Alice');
      assert.equal(identity!.email, 'alice@jataqi.local');

      assert.equal(tanya.identify('bogus-token'), undefined);
    } finally {
      await kernel.shutdown();
    }
  });

  it('stats aggregates conversations and messages per user', async () => {
    const kernel = await bootTanya();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      await tanya.chat({ userId: 'u1', message: 'one' });
      await tanya.chat({ userId: 'u1', message: 'two' });
      await tanya.chat({ userId: 'u2', message: 'other' });

      const s1 = await tanya.stats('u1');
      assert.equal(s1.conversations, 2);
      assert.equal(s1.messages, 4);
      assert.equal(s1.personas, 1);

      const s2 = await tanya.stats('u2');
      assert.equal(s2.conversations, 1);
    } finally {
      await kernel.shutdown();
    }
  });

  it('listConversations / getConversation / deleteConversation passthroughs', async () => {
    const kernel = await bootTanya();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const a = await tanya.chat({ userId: 'u1', message: 'alpha' });
      const b = await tanya.chat({ userId: 'u1', message: 'beta' });

      const listed = await tanya.listConversations('u1', { search: 'beta' });
      assert.equal(listed.total, 1);
      assert.equal(listed.conversations[0]!.id, b.conversationId);

      assert.ok(await tanya.getConversation(a.conversationId));
      assert.equal(await tanya.deleteConversation(a.conversationId), true);
      assert.equal(await tanya.getConversation(a.conversationId), undefined);
      assert.equal(await tanya.deleteConversation(a.conversationId), false);
    } finally {
      await kernel.shutdown();
    }
  });

  it('degrades gracefully when the agent runtime is absent', async () => {
    const kernel = await bootTanya({ withAgents: false });
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      await assert.rejects(tanya.chat({ userId: 'u1', message: 'hi' }), /agent-runtime module not registered/);
      // Conversations still work without the agent runtime.
      const listed = await tanya.listConversations('u1');
      assert.equal(listed.total, 0);
      assert.equal(tanya.identify('bogus'), undefined);
    } finally {
      await kernel.shutdown();
    }
  });

  it('streams the reply in word chunks through onChunk (exact reassembly)', async () => {
    const kernel = await bootTanya();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const chunks: string[] = [];
      const result = await tanya.chat({ userId: 'u1', message: 'Stream me this answer', onChunk: (c) => { chunks.push(c); } });
      assert.ok(chunks.length > 1, 'multiple chunks for a multi-word reply');
      assert.equal(chunks.join(''), result.reply, 'chunks reassemble to the exact reply');
    } finally {
      await kernel.shutdown();
    }
  });

  it('a throwing onChunk callback never fails the chat', async () => {
    const kernel = await bootTanya();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const result = await tanya.chat({
        userId: 'u1', message: 'robust streaming',
        onChunk: () => { throw new Error('client disconnected'); },
      });
      assert.ok(result.reply);
      assert.equal(result.messageCount, 2);
    } finally {
      await kernel.shutdown();
    }
  });

  it('emits tanya.chat.completed bus events with conversation context', async () => {
    const kernel = await bootTanya();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const events: Record<string, unknown>[] = [];
      const unsub = kernel.bus.on('tanya.chat.completed', (e: Record<string, unknown>) => { events.push(e); });
      const result = await tanya.chat({ userId: 'u1', message: 'event please' });
      assert.equal(events.length, 1);
      assert.equal(events[0]!.conversationId, result.conversationId);
      assert.equal(events[0]!.userId, 'u1');
      assert.equal(events[0]!.persona, 'main');
      unsub();
    } finally {
      await kernel.shutdown();
    }
  });

  it('caps history fed to the agent at maxHistory turns', async () => {
    const llm = new RecordingLLM();
    const kernel = await bootTanya({ llm });
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      // Three prior turns, then ask with maxHistory 2 → only the last two turns
      // (user+assistant pairs) plus the current message reach the model.
      let convId: string | undefined;
      for (let i = 0; i < 3; i++) {
        const r = await tanya.chat({ userId: 'u1', conversationId: convId, message: `turn ${i}` });
        convId = r.conversationId;
      }
      await tanya.chat({ userId: 'u1', conversationId: convId, message: 'final', maxHistory: 2 });
      const seen = llm.seen[llm.seen.length - 1]!;
      // system + history(4 messages = 2 turns) + current user message.
      assert.equal(seen.length, 6);
      assert.equal(seen[1]!.content, 'turn 1');
      assert.equal(seen[5]!.content, 'final');
      assert.equal(seen[0]!.role, 'system');
    } finally {
      await kernel.shutdown();
    }
  });

  it('idpRefresh and rotateSession passthroughs (deep IdP integration)', async () => {
    const kernel = await bootTanya({ withPki: true });
    try {
      const pki = kernel.getModule<PkiModule>('pki');
      const tanya = kernel.getModule<TanyaModule>('tanya');
      assert.equal(tanya.registerIdentity({ sub: 'ext-u', name: 'Ext', preferred_username: 'ext', roles: ['analyst'] }), true);

      const client = pki.registerIdpClient({ name: 'tanya-idp', redirectUris: ['https://app.jataqi.local/cb'] });
      const auth = pki.idpAuthorize({ clientId: client.clientId, redirectUri: 'https://app.jataqi.local/cb', scope: 'openid profile', userId: 'ext-u' });
      const tokens = pki.idpToken({ code: auth.code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: 'https://app.jataqi.local/cb' });

      // idpRefresh passthrough (rotates the refresh token).
      const refreshed = tanya.idpRefresh({ refreshToken: tokens.refresh_token!, clientId: client.clientId, clientSecret: client.clientSecret });
      assert.ok(refreshed?.access_token);
      assert.ok(refreshed?.refresh_token, 'rotated refresh token returned');

      // rotateSession passthrough — mints a platform session (uses the
      // rotated refresh token; the original was revoked by the refresh).
      const rotated = await tanya.rotateSession({ refreshToken: refreshed!.refresh_token!, clientId: client.clientId, clientSecret: client.clientSecret });
      assert.equal(rotated.ok, true);
      assert.equal(rotated.principal?.username, 'ext');
      assert.deepEqual(rotated.principal?.roles, ['analyst']);
      assert.ok(rotated.session?.token);

      // Invalid → graceful failure.
      const bad = await tanya.rotateSession({ refreshToken: 'bogus', clientId: client.clientId, clientSecret: client.clientSecret });
      assert.equal(bad.ok, false);
      assert.equal(tanya.idpRefresh({ refreshToken: 'bogus', clientId: client.clientId, clientSecret: client.clientSecret }), undefined);
    } finally {
      await kernel.shutdown();
    }
  });

  it('idpRefresh/rotateSession degrade without the pki module', async () => {
    const kernel = await bootTanya({ withPki: false, withAgents: false });
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      assert.equal(tanya.idpRefresh({ refreshToken: 'x', clientId: 'c', clientSecret: 's' }), undefined);
      const rotated = await tanya.rotateSession({ refreshToken: 'x', clientId: 'c', clientSecret: 's' });
      assert.equal(rotated.ok, false);
      assert.match(rotated.reason ?? '', /pki module not registered/);
    } finally {
      await kernel.shutdown();
    }
  });

  it('scopes conversations to an organization (create + continue + mismatch)', async () => {
    const kernel = await bootTanya();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const result = await tanya.chat({ userId: 'u1', message: 'org hello', orgId: 'org-acme' });
      const conv = await tanya.getConversation(result.conversationId);
      assert.equal(conv!.orgId, 'org-acme');

      // Continuing within the same org works.
      const cont = await tanya.chat({ userId: 'u1', conversationId: result.conversationId, message: 'more', orgId: 'org-acme' });
      assert.equal(cont.conversationId, result.conversationId);

      // Continuing with a mismatched org is rejected.
      await assert.rejects(
        tanya.chat({ userId: 'u1', conversationId: result.conversationId, message: 'x', orgId: 'org-other' }),
        /does not belong to this organization/,
      );

      // Org filter in listConversations.
      const listed = await tanya.listConversations('u1', { orgId: 'org-acme' });
      assert.equal(listed.total, 1);
      const other = await tanya.listConversations('u1', { orgId: 'org-other' });
      assert.equal(other.total, 0);
    } finally {
      await kernel.shutdown();
    }
  });

  it('shares conversations with a platform user (ownership enforced)', async () => {
    const kernel = await bootTanya();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const result = await tanya.chat({ userId: 'owner', message: 'share me' });

      const share = await tanya.shareWith(result.conversationId, 'owner', 'recipient');
      assert.equal(share.recipientUserId, 'recipient');
      assert.equal(share.conversationId, result.conversationId);

      // Recipient sees it; others don't.
      const inbox = await tanya.sharedWithMe('recipient');
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0]!.id, result.conversationId);
      assert.equal((await tanya.sharedWithMe('stranger')).length, 0);

      // Ownership enforced: a non-owner cannot share.
      await assert.rejects(tanya.shareWith(result.conversationId, 'hacker', 'x'), /does not belong to this user/);
      await assert.rejects(tanya.shareWith('nope', 'owner', 'x'), /not found/);

      // Owner view of grants + unshare.
      const grants = await tanya.sharesFor(result.conversationId, 'owner');
      assert.equal(grants.length, 1);
      assert.equal(await tanya.unshareFrom(result.conversationId, 'owner', 'recipient'), true);
      assert.equal((await tanya.sharedWithMe('recipient')).length, 0);
      await assert.rejects(tanya.sharesFor(result.conversationId, 'stranger'), /not owned/);
    } finally {
      await kernel.shutdown();
    }
  });

  it('shares through the IdP identity bridge (email resolution)', async () => {
    const kernel = await bootTanya({ withPki: true });
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      // Recipient registers an IdP identity (console linking registers
      // sub = platform userId + email/preferred_username).
      assert.equal(tanya.registerIdentity({ sub: 'recipient-user-id', email: 'recipient@jataqi.local', preferred_username: 'recipient' }), true);

      const result = await tanya.chat({ userId: 'owner', message: 'bridge share' });
      const share = await tanya.shareWithIdpIdentity(result.conversationId, 'owner', { email: 'Recipient@Jataqi.Local' });
      assert.equal(share.recipientUserId, 'recipient-user-id');
      assert.equal(share.via, 'email');

      // The resolved recipient can list it.
      const inbox = await tanya.sharedWithMe('recipient-user-id');
      assert.equal(inbox.length, 1);

      // Unknown IdP identity → clear error.
      await assert.rejects(tanya.shareWithIdpIdentity(result.conversationId, 'owner', { email: 'nobody@jataqi.local' }), /no platform user found/);

      // Sub-based resolution also works (console flow uses sub = userId).
      assert.deepEqual(tanya.resolveIdpIdentity({ sub: 'recipient-user-id' }), { userId: 'recipient-user-id', via: 'sub' });
    } finally {
      await kernel.shutdown();
    }
  });

  it('org directory: owners see all, members only their own, non-members denied', async () => {
    const kernel = await bootTanya();
    try {
      const orgs = kernel.getModule<OrganizationsModule>('organizations');
      const tanya = kernel.getModule<TanyaModule>('tanya');

      const org = await orgs.createOrganization('DirOrg', 'owner-id', 'dirorg');
      await orgs.addMember(org.id, 'member-id', 'member');

      // Owner + member create org-scoped conversations.
      await tanya.chat({ userId: 'owner-id', message: 'owner chat', orgId: org.id });
      await tanya.chat({ userId: 'member-id', message: 'member chat', orgId: org.id });

      // Owner (auto owner role) sees everything.
      const ownerView = await tanya.orgConversations(org.id, 'owner-id');
      assert.equal(ownerView.length, 2);
      // Member sees only their own.
      const memberView = await tanya.orgConversations(org.id, 'member-id');
      assert.equal(memberView.length, 1);
      assert.equal(memberView[0]!.userId, 'member-id');
      // Non-member denied.
      await assert.rejects(tanya.orgConversations(org.id, 'stranger'), /not a member/);
      // adminOnly requires owner/admin.
      await assert.rejects(tanya.orgConversations(org.id, 'member-id', { adminOnly: true }), /owner or admin role required/);
      const ownerAdmin = await tanya.orgConversations(org.id, 'owner-id', { adminOnly: true });
      assert.equal(ownerAdmin.length, 2);

      // memberRole helper.
      assert.equal(await tanya.memberRole(org.id, 'owner-id'), 'owner');
      assert.equal(await tanya.memberRole(org.id, 'member-id'), 'member');
      assert.equal(await tanya.memberRole(org.id, 'stranger'), undefined);
    } finally {
      await kernel.shutdown();
    }
  });

  it('modelRouting routes turns through the model runtime when present', async () => {
    // Fresh kernel with a stub model-runtime registered BEFORE TanyaModule so
    // the module resolves it at init.
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    kernel.register(new ConversationsModule());
    kernel.register(new SecurityModule({ bootstrapAdmin: { username: 'admin', password: 'admin' } }));
    const stub = {
      id: 'model-runtime',
      tags: [] as string[],
      dependsOn: [] as string[],
      calls: 0,
      async init() {},
      async start() {},
      async stop() {},
      async complete(req: { messages: Array<{ role: string; content: string }> }) {
        this.calls++;
        return { message: { content: `MODEL:${req.messages[req.messages.length - 1]!.content}` } };
      },
    };
    kernel.register(stub as never);
    kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
    kernel.register(new TanyaModule());
    await kernel.boot();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');

      // Agent path (default) still works.
      const agentChat = await tanya.chat({ userId: 'u1', message: 'agent path' });
      assert.equal(agentChat.reply.startsWith('Echo:'), true, 'agent path unchanged');

      // Model-router path.
      const routed = await tanya.chat({ userId: 'u1', message: 'router path', modelRouting: true });
      assert.equal(routed.reply, 'MODEL:router path');
      assert.equal(routed.toolCalls.length, 0, 'no tool calls on the router path');
      assert.equal((stub as unknown as { calls: number }).calls, 1);
    } finally {
      await kernel.shutdown();
    }

    // modelRouting without the module present → falls back to the agent.
    const k2 = await bootTanya();
    try {
      const tanya2 = k2.getModule<TanyaModule>('tanya');
      const fallback = await tanya2.chat({ userId: 'u1', message: 'fallback', modelRouting: true });
      assert.equal(fallback.reply.startsWith('Echo:'), true, 'falls back to the agent');
    } finally {
      await k2.shutdown();
    }
  });

  it('records conversational turns into the Digital Memory Engine when present', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    kernel.register(new ConversationsModule());
    kernel.register(new SecurityModule({ bootstrapAdmin: { username: 'admin', password: 'admin' } }));
    kernel.register(new OrganizationsModule());
    const { DigitalMemoryModule } = await import('@jataqi/memory');
    kernel.register(new DigitalMemoryModule());
    kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
    kernel.register(new TanyaModule());
    await kernel.boot();
    try {
      const tanya = kernel.getModule<TanyaModule>('tanya');
      const memory = kernel.getModule('memory') as unknown as { query: (q: { category?: string; limit?: number }) => Array<{ category: string; summary: string; data?: Record<string, unknown> }> };

      await tanya.chat({ userId: 'u1', message: 'Remember this conversation', orgId: 'mem-org' });
      await tanya.chat({ userId: 'u1', message: 'And this follow-up' });

      const events = memory.query({ category: 'tanya_chat' });
      assert.ok(events.length >= 2, 'each turn recorded');
      assert.ok(events.some((e) => e.summary.includes('Remember this conversation')));
      assert.ok(events.some((e) => e.summary.includes('And this follow-up')));
      const withOrg = events.find((e) => e.data?.orgId === 'mem-org');
      assert.ok(withOrg, 'orgId captured in memory data');
      assert.ok(events.some((e) => e.data?.conversationId), 'conversationId captured');
    } finally {
      await kernel.shutdown();
    }
  });
});
