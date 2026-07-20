import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import {
  AgentRuntimeModule,
  Agent,
  ToolRegistry,
  EchoLLM,
  ScriptedLLM,
  knowledgeSearchTool,
} from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function bootKernel() {
  const k = createTestKernel({ configDefaults: { vector: { model: 'hash', metric: 'cosine', hashDim: 64 } } });
  k.register(new StorageModule());
  k.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  k.register(new KnowledgeService());
  k.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  k.register(new AgentRuntimeModule());
  return k;
}

describe('ToolRegistry', () => {
  it('registers, lists, validates, and calls tools', async () => {
    const r = new ToolRegistry();
    r.register({
      name: 'add',
      description: 'add two numbers',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      async execute(input: any) { return input.a + input.b; },
    });
    assert.equal(r.has('add'), true);
    assert.equal(r.list().length, 1);
    const res = await r.call('add', { a: 2, b: 3 }, { runId: 'r', logger: { info() {}, debug() {}, error() {} }, metadata: {} });
    assert.equal(res.output, 5);
    assert.equal(res.error, undefined);
    // Missing required field returns error.
    const bad = await r.call('add', { a: 1 }, { runId: 'r', logger: { info() {}, debug() {}, error() {} }, metadata: {} });
    assert.ok(bad.error);
    assert.rejects(() => r.call('missing', {}, { runId: 'r', logger: { info() {}, debug() {}, error() {} }, metadata: {} }));
  });

  it('prevents duplicate registrations', () => {
    const r = new ToolRegistry();
    const tool = { name: 'x', description: '', inputSchema: { type: 'object', properties: {} }, async execute() { return null; } };
    r.register(tool);
    assert.throws(() => r.register(tool), /already registered/);
  });
});

describe('Agent', () => {
  it('returns an immediate answer when the LLM returns no tool calls', async () => {
    const agent = new Agent({ llm: new EchoLLM(), tools: [] });
    const res = await agent.run({ message: 'hello' });
    assert.ok(res.answer.includes('Echo: hello'));
    assert.equal(res.finishedReason, 'answer');
    assert.equal(res.iterations, 1);
    assert.equal(res.toolCalls.length, 0);
  });

  it('runs a tool call and feeds the result back to the LLM', async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ id: 'tc1', name: 'echo', input: { text: 'hi' } }] },
      { text: 'final answer: hi' },
    ]);
    const agent = new Agent({
      llm,
      tools: [{
        name: 'echo',
        description: 'echo input',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        async execute(input: any) { return { echo: input.text }; },
      }],
    });
    const res = await agent.run({ message: 'please echo hi' });
    assert.equal(res.finishedReason, 'answer');
    assert.ok(res.answer.includes('final answer'));
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0]!.tool, 'echo');
  });

  it('stops after maxIterations', async () => {
    // Always asks for a tool call; never answers.
    const llm = new ScriptedLLM(Array.from({ length: 20 }, () => ({
      toolCalls: [{ id: 'x', name: 'ping', input: {} }],
    })));
    const agent = new Agent({
      llm,
      maxIterations: 3,
      tools: [{
        name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} },
        async execute() { return 'pong'; },
      }],
    });
    const res = await agent.run({ message: 'ping forever' });
    assert.equal(res.finishedReason, 'max_iterations');
    assert.equal(res.iterations, 3);
  });

  it('supports cancellation via AbortSignal', async () => {
    const controller = new AbortController();
    const llm = new ScriptedLLM([{ toolCalls: [{ id: '1', name: 'wait', input: {} }] }]);
    const agent = new Agent({
      llm,
      maxIterations: 5,
      tools: [{
        name: 'wait', description: '', inputSchema: { type: 'object', properties: {} },
        async execute(_i, ctx) {
          return new Promise((resolve) => {
            const t = setTimeout(() => resolve('waited'), 2000);
            ctx.signal?.addEventListener('abort', () => { clearTimeout(t); resolve('cancelled'); });
          });
        },
      }],
    });
    setTimeout(() => controller.abort(), 50);
    const res = await agent.run({ message: 'go', signal: controller.signal, maxIterations: 5 });
    assert.equal(res.finishedReason, 'cancelled');
  });
});

describe('AgentRuntimeModule (kernel integration)', () => {
  let kernel: Kernel;
  beforeEach(async () => { kernel = bootKernel(); await kernel.boot(); });

  it('boots with default main agent and built-in tools', () => {
    const mod = kernel.getModule<AgentRuntimeModule>('agent-runtime');
    const main = mod.getAgent('main');
    assert.ok(main);
    const tools = main.getTools().map((t) => t.name);
    assert.ok(tools.includes('knowledge.search'));
    assert.ok(tools.includes('graph.traverse'));
    assert.ok(tools.includes('graph.findEntity'));
    assert.ok(tools.includes('graph.retrieve'));
  });

  it('runs end-to-end with knowledge search tool using the EchoLLM (no tools called, answer returned)', async () => {
    const mod = kernel.getModule<AgentRuntimeModule>('agent-runtime');
    const res = await mod.run('what is JATA Qi?');
    assert.ok(res.answer.includes('Echo: what is JATA Qi?'));
    assert.equal(res.finishedReason, 'answer');
  });

  it('supports creating additional agents', () => {
    const mod = kernel.getModule<AgentRuntimeModule>('agent-runtime');
    const a = mod.createAgent('helper', { description: 'helper agent' });
    assert.equal(a.name, 'helper');
    assert.throws(() => mod.createAgent('helper'));
  });

  it('knowledge.search tool hits the knowledge service', async () => {
    const svc = kernel.getModule<KnowledgeService>('knowledge');
    await svc.ingestText('JATA Qi is a modular AI operating system.');
    const tool = knowledgeSearchTool(() => svc);
    const out = await tool.execute({ query: 'JATA Qi', topK: 1 }, { runId: 'x', logger: { info() {}, debug() {}, error() {} }, metadata: {} });
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 1);
    assert.ok((out as any)[0].text.includes('JATA Qi'));
  });
});
