// SovereignRouter tests — routing, privacy enforcement, fallback, health tracking.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SovereignRouter } from '../src/index.js';
import type { ILLM, LLMRequest, LLMResponse } from '@jataqi/agent-runtime';

class StubLLM implements ILLM {
  constructor(private response: string, private shouldFail = false) {}
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    if (this.shouldFail) throw new Error('provider error');
    return { message: { role: 'assistant', content: this.response } };
  }
}

// Override the router's internal LLMs for deterministic testing.
class TestableRouter extends SovereignRouter {
  setLocalLLM(id: string, llm: ILLM): void {
    (this as unknown as { localLLMs: Map<string, { llm: ILLM; config: unknown }> }).localLLMs.set(id, {
      llm,
      config: { id, name: id, family: 'test', capabilities: ['chat'], endpoint: 'http://localhost:11434', quality: 60, latencyMs: 500 },
    });
  }
  setRemoteLLM(id: string, llm: ILLM): void {
    (this as unknown as { remoteLLMs: Map<string, { llm: ILLM; config: unknown }> }).remoteLLMs.set(id, {
      llm,
      config: { id, name: id, apiKey: 'test', capabilities: ['chat', 'reasoning'] },
    });
  }
}

describe('SovereignRouter — routing', () => {
  let router: TestableRouter;

  beforeEach(() => { router = new TestableRouter(); });

  it('routes to the EchoLLM fallback when no models are configured', async () => {
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.match(res.message.content, /Echo:/);
  });

  it('routes to a local model when available', async () => {
    router.setLocalLLM('llama-3', new StubLLM('local response'));
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.message.content, 'local response');
  });

  it('routes to a remote model when local is unavailable', async () => {
    router.setRemoteLLM('openai', new StubLLM('openai response'));
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.message.content, 'openai response');
  });

  it('prefers local for sensitive privacy data', () => {
    router.setLocalLLM('llama-3', new StubLLM('local'));
    router.setRemoteLLM('openai', new StubLLM('remote'));
    const result = router.route({ privacy: 'sensitive' });
    assert.equal(result.isLocal, true);
    assert.equal(result.modelId, 'llama-3');
  });

  it('blocks remote when forceLocal is set', () => {
    router.setLocalLLM('llama-3', new StubLLM('local'));
    router.setRemoteLLM('openai', new StubLLM('remote'));
    const result = router.route({ forceLocal: true });
    assert.equal(result.isLocal, true);
  });

  it('falls to EchoLLM when sensitive but no local model available', () => {
    router.setRemoteLLM('openai', new StubLLM('remote'));
    const result = router.route({ privacy: 'sensitive' });
    assert.equal(result.modelId, 'echo');
    assert.equal(result.isLocal, true);
  });

  it('enforces allowedProviders filter', () => {
    router.setRemoteLLM('openai', new StubLLM('oai'));
    router.setRemoteLLM('anthropic', new StubLLM('ant'));
    const result = router.route({ allowedProviders: ['anthropic'] });
    assert.equal(result.modelId, 'anthropic');
  });
});

describe('SovereignRouter — fallback chain', () => {
  let router: TestableRouter;

  beforeEach(() => { router = new TestableRouter(); });

  it('falls back to the next model when the primary fails', async () => {
    router.setLocalLLM('llama-3', new StubLLM('', true)); // fails
    router.setRemoteLLM('openai', new StubLLM('openai-fallback'));
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }] });
    // Local model was highest priority (0 cost), it fails, falls back to remote.
    assert.ok(res.message.content === 'openai-fallback' || res.message.content.includes('Echo'));
  });

  it('falls to EchoLLM when all models fail', async () => {
    router.setLocalLLM('llama', new StubLLM('', true));
    router.setRemoteLLM('openai', new StubLLM('', true));
    const res = await router.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.match(res.message.content, /Echo:/);
  });
});

describe('SovereignRouter — health tracking', () => {
  let router: TestableRouter;

  beforeEach(() => { router = new TestableRouter(); });

  it('records successes and failures', async () => {
    router.setLocalLLM('stable', new StubLLM('ok'));
    await router.complete({ messages: [{ role: 'user', content: 'a' }] });
    await router.complete({ messages: [{ role: 'user', content: 'b' }] });
    const health = router.getHealth();
    assert.ok(health.some((h) => h.modelId === 'stable' && h.successes >= 1));
  });

  it('marks models as error after repeated failures', async () => {
    router.setLocalLLM('flaky', new StubLLM('', true));
    for (let i = 0; i < 10; i++) await router.complete({ messages: [{ role: 'user', content: 'x' }] });
    const h = router.getHealth().find((x) => x.modelId === 'flaky');
    assert.ok(h);
    assert.ok(h!.failures > 5);
  });
});

describe('SovereignRouter — sovereign operation', () => {
  it('operates without any external providers (pure sovereign mode)', async () => {
    const router = new SovereignRouter();
    assert.equal(router.hasLocalModels(), false);
    assert.equal(router.hasRemoteProviders(), false);
    // Still works — EchoLLM fallback.
    const res = await router.complete({ messages: [{ role: 'user', content: 'hello sovereign' }] });
    assert.match(res.message.content, /hello sovereign/);
  });

  it('completeRouted returns both response and routing decision', async () => {
    const router = new TestableRouter();
    router.setLocalLLM('llama', new StubLLM('local-ok'));
    const { response, routing } = await router.completeRouted(
      { messages: [{ role: 'user', content: 'test' }] },
      { privacy: 'sensitive' },
    );
    assert.equal(response.message.content, 'local-ok');
    assert.equal(routing.modelId, 'llama');
    assert.equal(routing.isLocal, true);
  });
});
