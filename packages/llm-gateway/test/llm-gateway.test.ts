import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { EchoLLM } from '@jataqi/agent-runtime';
import { LLMGatewayModule, MockLLM, mockProvider, openaiProvider } from '../src/index.js';
import type { ILLM, LLMRequest, LLMResponse } from '@jataqi/agent-runtime';
import type { Kernel } from '@jataqi/core-kernel';

// A failing LLM that always throws.
class FailingLLM implements ILLM {
  readonly id = 'failing';
  async complete(): Promise<LLMResponse> { throw new Error('provider unavailable'); }
}

// A slow LLM that succeeds after a delay.
class SlowLLM implements ILLM {
  readonly id = 'slow';
  async complete(req: LLMRequest): Promise<LLMResponse> {
    await new Promise(r => setTimeout(r, 10));
    return { message: { role: 'assistant', content: 'slow response' } };
  }
}

describe('LLMGatewayModule', () => {
  let kernel: Kernel;
  let gw: LLMGatewayModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new LLMGatewayModule());
    await kernel.boot();
    gw = kernel.getModule<LLMGatewayModule>('llm-gateway');
  });

  // --- fallback to EchoLLM --------------------------------------------------

  it('uses EchoLLM when no providers are registered', async () => {
    const res = await gw.complete({ messages: [{ role: 'user', content: 'hello' }] });
    assert.match(res.message.content, /Echo: hello/);
  });

  // --- single provider ------------------------------------------------------

  it('routes to a registered provider', async () => {
    gw.registerProvider({
      id: 'mock-1', name: 'Mock', llm: new MockLLM(),
      tier: 'primary', priority: 1, inputCostPer1k: 0.001, outputCostPer1k: 0.002,
    });
    const res = await gw.complete({ messages: [{ role: 'user', content: 'What is JATA Qi?' }] });
    assert.ok(res.message.content.length > 10);
    assert.match(res.message.content, /understand|analysis|approach/i);

    // Stats should reflect the invocation.
    const stats = gw.getStats();
    assert.equal(stats.totalInvocations, 1);
    assert.equal(stats.successful, 1);
    assert.ok(stats.totalTokensUsed > 0);
    assert.ok(stats.totalCost > 0);
  });

  // --- fallback chain -------------------------------------------------------

  it('falls back when the primary provider fails', async () => {
    gw.registerProvider({
      id: 'fail-1', name: 'Failing', llm: new FailingLLM(),
      tier: 'primary', priority: 1,
    });
    gw.registerProvider({
      id: 'mock-backup', name: 'Mock Backup', llm: new MockLLM(),
      tier: 'fallback', priority: 1,
    });
    const res = await gw.complete({ messages: [{ role: 'user', content: 'hello' }] });
    assert.ok(res.message.content.length > 0);

    const stats = gw.getStats();
    assert.equal(stats.totalInvocations, 2); // 1 fail + 1 success
    assert.equal(stats.successful, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.fallbacksTriggered, 1);
  });

  it('uses EchoLLM as last resort when all providers fail', async () => {
    gw.registerProvider({ id: 'fail-1', name: 'Failing', llm: new FailingLLM(), tier: 'primary', priority: 1 });
    gw.registerProvider({ id: 'fail-2', name: 'Failing 2', llm: new FailingLLM(), tier: 'fallback', priority: 1 });
    const res = await gw.complete({ messages: [{ role: 'user', content: 'last resort test' }] });
    assert.match(res.message.content, /Echo: last resort test/);
  });

  // --- provider management --------------------------------------------------

  it('lists registered providers', () => {
    gw.registerProvider({ id: 'a', name: 'A', llm: new MockLLM(), tier: 'primary', priority: 1 });
    gw.registerProvider({ id: 'b', name: 'B', llm: new MockLLM(), tier: 'fallback', priority: 2 });
    const list = gw.listProviders();
    assert.equal(list.length, 2);
  });

  it('unregisters providers', () => {
    gw.registerProvider({ id: 'x', name: 'X', llm: new MockLLM(), tier: 'primary', priority: 1 });
    assert.equal(gw.unregisterProvider('x'), true);
    assert.equal(gw.listProviders().length, 0);
  });

  it('marks providers as degraded after 3 consecutive failures', async () => {
    gw.registerProvider({ id: 'fail-degrade', name: 'F', llm: new FailingLLM(), tier: 'primary', priority: 1 });
    // Trigger 3 failures.
    for (let i = 0; i < 3; i++) {
      await gw.complete({ messages: [{ role: 'user', content: 'x' }] });
    }
    const list = gw.listProviders();
    assert.equal(list[0]!.status, 'degraded');
  });

  it('selects the highest-priority active primary', () => {
    gw.registerProvider({ id: 'p1', name: 'P1', llm: new MockLLM(), tier: 'primary', priority: 5 });
    gw.registerProvider({ id: 'p2', name: 'P2', llm: new MockLLM(), tier: 'primary', priority: 1 });
    const def = gw.getDefaultProvider();
    assert.equal(def!.id, 'p2');
  });

  it('skips unavailable providers', () => {
    gw.registerProvider({ id: 'p1', name: 'P1', llm: new MockLLM(), tier: 'primary', priority: 1 });
    gw.registerProvider({ id: 'p2', name: 'P2', llm: new MockLLM(), tier: 'fallback', priority: 1 });
    gw.setStatus('p1', 'unavailable');
    const def = gw.getDefaultProvider();
    assert.equal(def!.id, 'p2');
  });

  // --- cost/latency tracking ------------------------------------------------

  it('tracks token usage from provider responses', async () => {
    gw.registerProvider(mockProvider({ model: 'mock-tracked' }));
    await gw.complete({ messages: [{ role: 'user', content: 'hello world this is a test' }] });
    const invs = gw.getRecentInvocations(1);
    assert.equal(invs.length, 1);
    assert.ok(invs[0]!.promptTokens > 0);
    assert.ok(invs[0]!.completionTokens > 0);
    assert.ok(invs[0]!.latencyMs >= 0);
  });

  it('calculates costs from token counts and price config', async () => {
    gw.registerProvider({
      id: 'priced', name: 'Priced', llm: new MockLLM(),
      tier: 'primary', priority: 1, inputCostPer1k: 0.01, outputCostPer1k: 0.03,
    });
    await gw.complete({ messages: [{ role: 'user', content: 'test pricing' }] });
    const inv = gw.getRecentInvocations(1)[0]!;
    assert.ok(inv.inputCost > 0);
    assert.ok(inv.outputCost > 0);
    assert.equal(inv.totalCost, inv.inputCost + inv.outputCost);
  });

  it('reports per-provider stats', async () => {
    gw.registerProvider({ id: 'a', name: 'A', llm: new MockLLM(), tier: 'primary', priority: 1, inputCostPer1k: 0.01 });
    gw.registerProvider({ id: 'b', name: 'B', llm: new MockLLM('mock-b'), tier: 'fallback', priority: 1 });
    await gw.complete({ messages: [{ role: 'user', content: 'test 1' }] });
    await gw.complete({ messages: [{ role: 'user', content: 'test 2' }] });
    const stats = gw.getStats();
    assert.ok(stats.byProvider.a);
    assert.equal(stats.byProvider.a.invocations, 2);
    assert.equal(stats.byProvider.a.successRate, 1);
  });

  // --- events ---------------------------------------------------------------

  it('emits invocation lifecycle events', async () => {
    let completed = 0; let failed = 0;
    kernel.bus.on('llm.invocation.completed', () => { completed++; });
    kernel.bus.on('llm.invocation.failed', () => { failed++; });
    gw.registerProvider({ id: 'mock-evt', name: 'M', llm: new MockLLM(), tier: 'primary', priority: 1 });
    await gw.complete({ messages: [{ role: 'user', content: 'event test' }] });
    assert.equal(completed, 1);

    gw.registerProvider({ id: 'fail-evt', name: 'F', llm: new FailingLLM(), tier: 'primary', priority: 0 });
    await gw.complete({ messages: [{ role: 'user', content: 'fail event' }] });
    assert.ok(failed >= 1);
  });

  it('emits fallback events', async () => {
    let fallbacks = 0;
    kernel.bus.on('llm.fallback.triggered', () => { fallbacks++; });
    gw.registerProvider({ id: 'f', name: 'F', llm: new FailingLLM(), tier: 'primary', priority: 1 });
    gw.registerProvider({ id: 'm', name: 'M', llm: new MockLLM(), tier: 'fallback', priority: 1 });
    await gw.complete({ messages: [{ role: 'user', content: 'fallback event' }] });
    assert.ok(fallbacks >= 1);
  });

  // --- MockLLM behavior -----------------------------------------------------

  it('MockLLM computes arithmetic', async () => {
    const mock = new MockLLM();
    const res = await mock.complete({ messages: [{ role: 'user', content: '2 + 3' }] });
    assert.match(res.message.content, /5/);
  });

  it('MockLLM greets', async () => {
    const mock = new MockLLM();
    const res = await mock.complete({ messages: [{ role: 'user', content: 'hello' }] });
    assert.match(res.message.content, /Hello.*JATA Qi/i);
  });

  it('MockLLM is deterministic (same input = same output)', async () => {
    const a = new MockLLM('test', 42);
    const b = new MockLLM('test', 42);
    const ra = await a.complete({ messages: [{ role: 'user', content: 'deterministic test' }] });
    const rb = await b.complete({ messages: [{ role: 'user', content: 'deterministic test' }] });
    assert.equal(ra.message.content, rb.message.content);
  });

  // --- ILLM compatibility ---------------------------------------------------

  it('implements ILLM interface (drop-in for AgentRuntimeModule)', async () => {
    const illm: ILLM = gw; // LLMGatewayModule implements ILLM
    gw.registerProvider({ id: 'mock-illm', name: 'M', llm: new MockLLM(), tier: 'primary', priority: 1 });
    const res = await illm.complete({ messages: [{ role: 'user', content: 'ILLM compat' }] });
    assert.ok(res.message.role === 'assistant');
    assert.ok(res.message.content.length > 0);
  });

  // --- provider factories ---------------------------------------------------

  it('openaiProvider creates a properly configured provider', () => {
    const p = openaiProvider({ model: 'gpt-4o-mini', apiKey: 'test-key' });
    assert.equal(p.id, 'openai:gpt-4o-mini');
    assert.equal(p.tier, 'primary');
    assert.ok(p.inputCostPer1k! > 0);
    assert.ok(p.maxContextTokens! > 0);
  });

  it('mockProvider creates a zero-cost provider', () => {
    const p = mockProvider();
    assert.equal(p.inputCostPer1k, 0);
    assert.equal(p.outputCostPer1k, 0);
    assert.equal(p.tier, 'fallback');
  });
});
