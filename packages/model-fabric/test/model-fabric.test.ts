// Unit tests for @jataqi/model-fabric

import test from 'node:test';
import assert from 'node:assert';
import { ModelRegistry } from '../src/registry.js';
import { ModelFabric } from '../src/fabric.js';
import { DynamicModelRouter } from '../src/router.js';
import { EnsembleReasoningFabric } from '../src/ensemble.js';
import { EchoLLM, ScriptedLLM } from '@jataqi/agent-runtime';

test('ModelRegistry registers, selects optimal model, and tracks telemetry', () => {
  const registry = new ModelRegistry();
  registry.register({
    id: 'gpt-4o',
    provider: 'openai',
    name: 'GPT-4o',
    tier: 'frontier-proprietary',
    modalities: ['text', 'code', 'reasoning'],
    contextWindow: 128000,
    costPerPromptTokenUsd: 0.000005,
    costPerCompletionTokenUsd: 0.000015,
    avgLatencyMs: 300,
    reliabilityScore: 0.99,
    enabled: true,
  });

  registry.register({
    id: 'llama-3-local',
    provider: 'ollama',
    name: 'Llama 3 Local',
    tier: 'local',
    modalities: ['text', 'code'],
    contextWindow: 8192,
    costPerPromptTokenUsd: 0,
    costPerCompletionTokenUsd: 0,
    avgLatencyMs: 150,
    reliabilityScore: 0.95,
    enabled: true,
  });

  const optimal = registry.selectOptimalModel({ taskType: 'coding', difficulty: 5 });
  assert.strictEqual(typeof optimal, 'string');

  registry.recordExecution('gpt-4o', 250, true);
  const m = registry.get('gpt-4o');
  assert.ok(m);
  assert.strictEqual(m.avgLatencyMs, 250);
});

test('ModelFabric executes with automatic fallback', async () => {
  const registry = new ModelRegistry();
  registry.register({
    id: 'failing-model',
    provider: 'mock',
    name: 'Failing Model',
    tier: 'fast',
    modalities: ['text'],
    contextWindow: 4096,
    costPerPromptTokenUsd: 0,
    costPerCompletionTokenUsd: 0,
    avgLatencyMs: 100,
    reliabilityScore: 0.5,
    enabled: true,
  });
  registry.register({
    id: 'echo-fallback',
    provider: 'mock',
    name: 'Echo Fallback',
    tier: 'fast',
    modalities: ['text'],
    contextWindow: 4096,
    costPerPromptTokenUsd: 0,
    costPerCompletionTokenUsd: 0,
    avgLatencyMs: 50,
    reliabilityScore: 0.99,
    enabled: true,
  });

  const fabric = new ModelFabric(registry);
  // register failing provider
  fabric.registerProvider('failing-model', {
    async complete() {
      throw new Error('API down');
    },
  });
  // register working echo provider
  fabric.registerProvider('echo-fallback', new EchoLLM());

  const res = await fabric.executeWithFallback('failing-model', ['echo-fallback'], {
    messages: [{ role: 'user', content: 'Hello fabric' }],
  });

  assert.strictEqual(res.modelId, 'echo-fallback');
  assert.strictEqual(res.content, 'Echo: Hello fabric');
});

test('DynamicModelRouter classifies, routes, and executes with verification', async () => {
  const registry = new ModelRegistry();
  registry.register({
    id: 'model-a',
    provider: 'mock',
    name: 'Model A',
    tier: 'frontier-proprietary',
    modalities: ['text', 'code'],
    contextWindow: 32000,
    costPerPromptTokenUsd: 0.00001,
    costPerCompletionTokenUsd: 0.00002,
    avgLatencyMs: 200,
    reliabilityScore: 0.98,
    enabled: true,
  });

  const fabric = new ModelFabric(registry);
  fabric.registerProvider('model-a', new EchoLLM());

  const router = new DynamicModelRouter(registry, fabric);
  const profile = router.classify('Write typescript code for quicksort');
  assert.strictEqual(profile.taskType, 'coding');

  const decision = router.route(profile);
  assert.strictEqual(decision.selectedModelId, 'model-a');

  const res = await router.executeWithVerification('Write typescript code for quicksort', {});
  assert.strictEqual(res.modelId, 'model-a');
  assert.ok(res.content.includes('Echo:'));
});

test('EnsembleReasoningFabric performs multi-model candidate generation and consensus', async () => {
  const registry = new ModelRegistry();
  registry.register({
    id: 'model-1',
    provider: 'mock',
    name: 'Model 1',
    tier: 'frontier-proprietary',
    modalities: ['text'],
    contextWindow: 32000,
    costPerPromptTokenUsd: 0.00001,
    costPerCompletionTokenUsd: 0.00002,
    avgLatencyMs: 200,
    reliabilityScore: 0.98,
    enabled: true,
  });
  registry.register({
    id: 'model-2',
    provider: 'mock',
    name: 'Model 2',
    tier: 'frontier-open-weight',
    modalities: ['text'],
    contextWindow: 32000,
    costPerPromptTokenUsd: 0.000005,
    costPerCompletionTokenUsd: 0.00001,
    avgLatencyMs: 150,
    reliabilityScore: 0.96,
    enabled: true,
  });

  const fabric = new ModelFabric(registry);
  fabric.registerProvider('model-1', new EchoLLM());
  fabric.registerProvider('model-2', new ScriptedLLM([{ text: 'Echo: What is artificial intelligence?' }]));

  const ensemble = new EnsembleReasoningFabric(registry, fabric);
  const result = await ensemble.evaluateEnsemble('What is artificial intelligence?', {});

  assert.strictEqual(result.candidates.length, 2);
  assert.ok(result.consensusAchieved);
  assert.ok(result.confidenceScore > 0.8);
  assert.ok(result.synthesis.includes('[Ensemble Consensus Synthesis]'));
});
