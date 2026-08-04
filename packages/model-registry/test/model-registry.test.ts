import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { ModelRegistryModule } from '../src/index.js';
import { select, filter, score } from '../src/index.js';
import type { ModelDescriptor } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

const MODELS: ModelDescriptor[] = [
  { id: 'cheap', provider: 'acme', name: 'Cheap', capabilities: ['chat'], inputCostPer1k: 0.01, outputCostPer1k: 0.02, latencyMs: 800, quality: 60 },
  { id: 'fast', provider: 'acme', name: 'Fast', capabilities: ['chat'], inputCostPer1k: 0.1, outputCostPer1k: 0.1, latencyMs: 120, quality: 70 },
  { id: 'smart', provider: 'acme', name: 'Smart', capabilities: ['chat', 'reasoning'], inputCostPer1k: 1, outputCostPer1k: 2, latencyMs: 1500, quality: 95, contextWindow: 128000 },
  { id: 'eye', provider: 'visionco', name: 'Eye', capabilities: ['chat', 'vision'], quality: 80 },
];

describe('selector', () => {
  it('filters by required capabilities', () => {
    assert.equal(filter(MODELS, { capabilities: ['reasoning'] }).length, 1);
    assert.equal(filter(MODELS, { capabilities: ['vision'] }).length, 1);
    assert.equal(filter(MODELS, { capabilities: ['chat'] }).length, 4);
  });

  it('filters by provider and min context window', () => {
    assert.equal(filter(MODELS, { providers: ['visionco'] }).length, 1);
    assert.equal(filter(MODELS, { minContextWindow: 100000 }).length, 1);
  });

  it('scores along the requested preference', () => {
    // cost: cheaper => higher score
    assert.ok((score(MODELS[0]!, 'cost') ?? 0) > (score(MODELS[2]!, 'cost') ?? 0));
    // latency: faster => higher score
    assert.ok((score(MODELS[1]!, 'latency') ?? 0) > (score(MODELS[2]!, 'latency') ?? 0));
    // quality: higher quality => higher score
    assert.ok((score(MODELS[2]!, 'quality') ?? 0) > (score(MODELS[0]!, 'quality') ?? 0));
  });

  it('selects the cheapest when prefer=cost', () => {
    const r = select(MODELS, { capabilities: ['chat'], prefer: 'cost' });
    assert.equal(r.model?.id, 'cheap');
  });

  it('selects the fastest when prefer=latency', () => {
    const r = select(MODELS, { capabilities: ['chat'], prefer: 'latency' });
    assert.equal(r.model?.id, 'fast');
  });

  it('selects the highest quality when prefer=quality', () => {
    const r = select(MODELS, { capabilities: ['chat'], prefer: 'quality' });
    assert.equal(r.model?.id, 'smart');
  });

  it('returns no model when constraints cannot be met', () => {
    const r = select(MODELS, { capabilities: ['nonexistent'] });
    assert.equal(r.model, undefined);
    assert.equal(r.candidates, 0);
  });
});

describe('ModelRegistryModule (kernel integration)', () => {
  let kernel: Kernel;
  let reg: ModelRegistryModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new ModelRegistryModule({ models: MODELS }));
    await kernel.boot();
    reg = kernel.getModule<ModelRegistryModule>('model-registry');
  });

  it('registers and lists models', () => {
    assert.equal(reg.list().length, 4);
    assert.equal(reg.byCapability('vision').length, 1);
  });

  it('selects and emits an event', async () => {
    let fired = false;
    kernel.bus.on('model.selected', () => { fired = true; });
    const r = await reg.select({ capabilities: ['reasoning'], prefer: 'quality' });
    assert.equal(r.model?.id, 'smart');
    assert.equal(fired, true);
  });

  it('unregisters a model', () => {
    assert.equal(reg.unregister('eye'), true);
    assert.equal(reg.get('eye'), undefined);
    assert.equal(reg.list().length, 3);
  });
});
