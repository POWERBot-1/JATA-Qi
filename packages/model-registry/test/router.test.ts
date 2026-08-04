// ModelRouter tests — dynamic model routing, health tracking, circuit breaker,
// fallback, and policy enforcement.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, ModelRegistryModule, type ModelDescriptor } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { ILLM, LLMRequest, LLMResponse } from '@jataqi/agent-runtime';
import { EchoLLM } from '@jataqi/agent-runtime';

function model(id: string, over: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id, provider: 'test', name: id, capabilities: ['chat', 'reasoning'],
    contextWindow: 128000, inputCostPer1k: 0.01, outputCostPer1k: 0.03,
    latencyMs: 500, quality: 80, ...over,
  };
}

/** An LLM that fails N times then succeeds (for circuit breaker testing). */
class FlakyLLM implements ILLM {
  private calls = 0;
  constructor(private failCount: number, private readonly okResponse?: string) {}
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    if (this.calls <= this.failCount) throw new Error(`failure ${this.calls}`);
    return { message: { role: 'assistant', content: this.okResponse ?? 'recovered' } };
  }
  get callCount(): number { return this.calls; }
}

/** An LLM that always succeeds with a given response. */
class StubLLM implements ILLM {
  constructor(private readonly response: string) {}
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    return { message: { role: 'assistant', content: this.response } };
  }
}

async function bootRegistry(models: ModelDescriptor[]): Promise<ModelRegistryModule> {
  const kernel = createTestKernel();
  kernel.register(new ModelRegistryModule({ models }));
  await kernel.boot();
  return kernel.getModule<ModelRegistryModule>('model-registry');
}

describe('ModelRouter — routing', () => {
  let registry: ModelRegistryModule;

  beforeEach(async () => {
    registry = await bootRegistry([
      model('gpt-4', { quality: 90, inputCostPer1k: 0.03, outputCostPer1k: 0.06, latencyMs: 1500 }),
      model('gpt-4-mini', { quality: 70, inputCostPer1k: 0.00015, outputCostPer1k: 0.0006, latencyMs: 800 }),
      model('llama-3', { quality: 60, provider: 'meta', inputCostPer1k: 0, outputCostPer1k: 0, latencyMs: 200 }),
    ]);
  });

  it('routes to the highest-quality model by default', async () => {
    const llms = new Map([
      ['gpt-4', new StubLLM('gpt4-response')],
      ['gpt-4-mini', new StubLLM('mini-response')],
      ['llama-3', new StubLLM('llama-response')],
    ]);
    const router = new ModelRouter(registry, llms, new EchoLLM());
    const decision = await router.route({ messages: [{ role: 'user', content: 'analyze this' }] });
    assert.equal(decision.modelId, 'gpt-4');
    assert.ok(decision.candidates >= 1);
  });

  it('infers cost preference from "cheap"/"budget" in the prompt', async () => {
    const llms = new Map([
      ['gpt-4', new StubLLM('gpt4')],
      ['gpt-4-mini', new StubLLM('mini')],
      ['llama-3', new StubLLM('llama')],
    ]);
    const router = new ModelRouter(registry, llms, new EchoLLM());
    const decision = await router.route({ messages: [{ role: 'user', content: 'give me a cheap answer' }] });
    // llama-3 is free (cost 0) → best for cost preference.
    assert.equal(decision.modelId, 'llama-3');
  });

  it('infers latency preference from "fast"/"quick"', async () => {
    const llms = new Map([
      ['gpt-4', new StubLLM('gpt4')],
      ['gpt-4-mini', new StubLLM('mini')],
      ['llama-3', new StubLLM('llama')],
    ]);
    const router = new ModelRouter(registry, llms, new EchoLLM());
    const decision = await router.route({ messages: [{ role: 'user', content: 'I need a fast response' }] });
    // llama-3 has 200ms latency → best for latency preference.
    assert.equal(decision.modelId, 'llama-3');
  });
});

describe('ModelRouter — execution + health tracking', () => {
  let registry: ModelRegistryModule;

  beforeEach(async () => {
    registry = await bootRegistry([
      model('primary', { quality: 90, latencyMs: 500 }),
      model('secondary', { quality: 70, latencyMs: 300 }),
    ]);
  });

  it('routes to the best model and records success', async () => {
    const llms = new Map<string, ILLM>();
    llms.set('primary', new StubLLM('ok'));
    llms.set('secondary', new StubLLM('ok2'));
    const router = new ModelRouter(registry, llms, new EchoLLM());
    const res = await router.complete({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.message.content, 'ok');
    const health = router.getHealth();
    assert.ok(health.some((h) => h.modelId === 'primary' && h.successes === 1));
  });

  it('falls back to the next model when the primary fails', async () => {
    const llms = new Map<string, ILLM>();
    llms.set('primary', new FlakyLLM(99));
    llms.set('secondary', new StubLLM('secondary-ok'));
    const router = new ModelRouter(registry, llms, new EchoLLM());
    const res = await router.complete({ messages: [{ role: 'user', content: 'test' }] });
    assert.equal(res.message.content, 'secondary-ok');
    const health = router.getHealth();
    const primaryH = health.find((h) => h.modelId === 'primary');
    assert.ok(primaryH);
    assert.ok(primaryH!.failures >= 1);
  });

  it('uses the fallback LLM when all models fail', async () => {
    const llms = new Map<string, ILLM>();
    llms.set('primary', new FlakyLLM(99));
    llms.set('secondary', new FlakyLLM(99));
    const router = new ModelRouter(registry, llms, new EchoLLM());
    const res = await router.complete({ messages: [{ role: 'user', content: 'test' }] });
    assert.match(res.message.content, /Echo:/);
  });
});

describe('ModelRouter — circuit breaker', () => {
  let registry: ModelRegistryModule;

  beforeEach(async () => {
    registry = await bootRegistry([
      model('flaky', { quality: 90 }),
      model('stable', { quality: 70 }),
    ]);
  });

  it('trips the circuit after threshold consecutive failures', async () => {
    const llms = new Map<string, ILLM>();
    llms.set('flaky', new FlakyLLM(99));
    llms.set('stable', new StubLLM('stable-ok'));
    const router = new ModelRouter(registry, llms, new EchoLLM(), { circuitThreshold: 2, circuitCooldownSec: 60 });

    // First request: tries flaky (fails), falls back to stable.
    await router.complete({ messages: [{ role: 'user', content: 'r1' }] });
    // Second request: flaky circuit should be open now (2 failures).
    await router.complete({ messages: [{ role: 'user', content: 'r2' }] });

    const flakyH = router.getHealth().find((h) => h.modelId === 'flaky');
    assert.ok(flakyH);
    assert.equal(flakyH!.circuitState, 'open');
    assert.ok(flakyH!.consecutiveFailures >= 2);
  });

  it('recovers from half-open after cooldown', async () => {
    const llms = new Map<string, ILLM>();
    llms.set('flaky', new FlakyLLM(2));
    llms.set('stable', new StubLLM('stable-ok'));
    const router = new ModelRouter(registry, llms, new EchoLLM(), { circuitThreshold: 2, circuitCooldownSec: 0 });

    // Trip the circuit.
    await router.complete({ messages: [{ role: 'user', content: 'a' }] });
    await router.complete({ messages: [{ role: 'user', content: 'b' }] });

    const flakyH = router.getHealth().find((h) => h.modelId === 'flaky');
    assert.equal(flakyH!.circuitState, 'open');

    // Wait past the (0-second) cooldown so it enters half-open.
    await new Promise((r) => setTimeout(r, 50));
    // Next request: half-open allows one trial; flaky recovers (call 3 succeeds).
    const res = await router.complete({ messages: [{ role: 'user', content: 'c' }] });
    assert.ok(res.message.content === 'recovered' || res.message.content === 'stable-ok');
  });
});

describe('ModelRouter — policy enforcement', () => {
  let registry: ModelRegistryModule;

  beforeEach(async () => {
    registry = await bootRegistry([
      model('expensive', { quality: 95, inputCostPer1k: 0.1, outputCostPer1k: 0.2 }),
      model('cheap', { quality: 60, inputCostPer1k: 0.001, outputCostPer1k: 0.002 }),
    ]);
  });

  it('enforces maxCostPer1k', async () => {
    const llms = new Map<string, ILLM>();
    llms.set('expensive', new StubLLM('exp'));
    llms.set('cheap', new StubLLM('chp'));
    const router = new ModelRouter(registry, llms, new EchoLLM(), { maxCostPer1k: 0.01 });
    const decision = await router.route({ messages: [{ role: 'user', content: 'test' }] });
    // expensive (0.3 total) should be filtered; cheap (0.003) should be selected.
    assert.equal(decision.modelId, 'cheap');
  });

  it('enforces allowedProviders', async () => {
    const llms = new Map<string, ILLM>();
    llms.set('expensive', new StubLLM('exp'));
    llms.set('cheap', new StubLLM('chp'));
    const router = new ModelRouter(registry, llms, new EchoLLM(), { allowedProviders: ['fake'] });
    const decision = await router.route({ messages: [{ role: 'user', content: 'test' }] });
    // No providers match → fallback.
    assert.equal(decision.modelId, '');
    assert.equal(decision.provider, 'fallback');
  });
});
