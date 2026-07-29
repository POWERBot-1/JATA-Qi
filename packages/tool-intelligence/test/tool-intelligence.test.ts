import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { ToolIntelligenceModule } from '../src/index.js';
import type { ToolAdapter, ToolEntity } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function echoAdapter(id: string, capabilities: string[], opts: { fail?: boolean; cost?: number } = {}): ToolAdapter {
  return {
    id,
    capabilities: () => capabilities,
    estimateCost: () => opts.cost ?? 1,
    validateInput: (input) => (input && typeof input === 'object' ? undefined : 'input must be an object'),
    async invoke(input) {
      if (opts.fail) throw new Error('adapter failure');
      return { echo: input };
    },
  };
}

describe('ToolIntelligenceModule (kernel integration)', () => {
  let kernel: Kernel;
  let ti: ToolIntelligenceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new ToolIntelligenceModule());
    await kernel.boot();
    ti = kernel.getModule<ToolIntelligenceModule>('tool-intelligence');
  });

  it('registers, lists, and filters tools by capability', async () => {
    await ti.register({ canonicalName: 'imagegen-a', provider: 'acme', version: '1.0.0', category: 'image', capabilities: ['text-to-image'], protocol: 'REST', riskClass: 'R1' });
    await ti.register({ canonicalName: 'whisper', provider: 'acme', version: '2.0.0', category: 'audio', capabilities: ['speech-to-text'], protocol: 'REST', riskClass: 'R0' });
    assert.equal((await ti.list()).length, 2);
    assert.equal((await ti.byCapability('text-to-image')).length, 1);
  });

  it('invokes a low-risk tool via its adapter and audits when security is present', async () => {
    const tool = await ti.register({ canonicalName: 'echo', provider: 'jataqi', version: '1.0.0', category: 'util', capabilities: ['echo'], protocol: 'function', riskClass: 'R0', status: 'ACTIVE' });
    ti.registerAdapter(echoAdapter(tool.id, ['echo']));
    const res = await ti.invoke(tool.id, { msg: 'hi' }, { userId: 'u', username: 'ada', roles: ['developer'] });
    assert.equal(res.status, 'success');
    assert.deepEqual((res.output as { echo: { msg: string } }).echo, { msg: 'hi' });
    assert.equal(res.cost, 1);
  });

  it('gates high-risk (R4/R5) tools behind human approval', async () => {
    const tool = await ti.register({ canonicalName: 'payment', provider: 'bank', version: '1.0.0', category: 'finance', capabilities: ['send-payment'], protocol: 'REST', riskClass: 'R4', status: 'ACTIVE' });
    ti.registerAdapter(echoAdapter(tool.id, ['send-payment']));

    // Without approval -> pending_approval.
    const blocked = await ti.invoke(tool.id, { amount: 100 });
    assert.equal(blocked.status, 'pending_approval');

    // Request + grant approval, then invoke.
    const req = ti.requestApproval(tool.id, 'ada', 'send-payment', 'pay invoice');
    assert.equal(req.status, 'pending');
    const decision = ti.decideApproval(req.id, 'approved', 'admin');
    assert.equal(decision.status, 'approved');
    const res = await ti.invoke(tool.id, { amount: 100 }, { userId: 'u', username: 'ada', roles: ['developer'] }, req.id);
    assert.equal(res.status, 'success');
  });

  it('falls back to the next tool when the primary fails, ranked by suitability', async () => {
    const primary = await ti.register({ canonicalName: 'stt-a', provider: 'acme', version: '1', category: 'audio', capabilities: ['speech-to-text'], protocol: 'REST', riskClass: 'R1', status: 'ACTIVE' });
    const secondary = await ti.register({ canonicalName: 'stt-b', provider: 'other', version: '1', category: 'audio', capabilities: ['speech-to-text'], protocol: 'REST', riskClass: 'R1', status: 'ACTIVE' });
    await ti.recordEvaluation(primary.id, 'quality', 70);
    await ti.recordEvaluation(secondary.id, 'quality', 90); // secondary ranks higher
    ti.registerAdapter(echoAdapter(primary.id, ['speech-to-text'], { fail: true }));
    ti.registerAdapter(echoAdapter(secondary.id, ['speech-to-text']));

    const res = await ti.invokeWithFallback('speech-to-text', { clip: 'x' });
    assert.equal(res.status, 'success');
    assert.equal(res.toolId, secondary.id); // primary failed, secondary (higher score) succeeded
  });

  it('never auto-invokes high-risk tools during fallback', async () => {
    const risky = await ti.register({ canonicalName: 'deploy', provider: 'ops', version: '1', category: 'devops', capabilities: ['deploy'], protocol: 'REST', riskClass: 'R5', status: 'ACTIVE' });
    ti.registerAdapter(echoAdapter(risky.id, ['deploy']));
    const res = await ti.invokeWithFallback('deploy', { env: 'prod' });
    assert.equal(res.status, 'failure'); // no low-risk tool available
  });

  it('records evaluations and updates scores', async () => {
    const t = await ti.register({ canonicalName: 'm', provider: 'p', version: '1', category: 'x', capabilities: ['c'], protocol: 'REST', riskClass: 'R0', status: 'ACTIVE' });
    await ti.recordEvaluation(t.id, 'quality', 88);
    await ti.recordEvaluation(t.id, 'reliability', 95);
    const after = await ti.get(t.id);
    assert.equal(after!.evaluationScore, 88);
    assert.equal(after!.reliabilityScore, 95);
  });

  it('deprecates a tool and emits an event', async () => {
    let deprecated = false;
    kernel.bus.on('tool.deprecated', () => { deprecated = true; });
    const t = await ti.register({ canonicalName: 'old', provider: 'p', version: '1', category: 'x', capabilities: ['c'], protocol: 'REST', riskClass: 'R0', status: 'ACTIVE' });
    const after = await ti.setStatus(t.id, 'DEPRECATED');
    assert.equal(after.status, 'DEPRECATED');
    assert.equal(deprecated, true);
  });

  it('ranks tools for a capability best-first', async () => {
    const a = await ti.register({ canonicalName: 'a', provider: 'p', version: '1', category: 'x', capabilities: ['c'], protocol: 'REST', riskClass: 'R0', status: 'ACTIVE' });
    const b = await ti.register({ canonicalName: 'b', provider: 'p', version: '1', category: 'x', capabilities: ['c'], protocol: 'REST', riskClass: 'R0', status: 'ACTIVE' });
    await ti.recordEvaluation(a.id, 'quality', 60);
    await ti.recordEvaluation(b.id, 'quality', 95);
    const ranked = await ti.rankForCapability('c');
    assert.equal((ranked[0] as ToolEntity).id, b.id);
  });
});
