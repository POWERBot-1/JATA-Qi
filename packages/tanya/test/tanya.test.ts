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
});
