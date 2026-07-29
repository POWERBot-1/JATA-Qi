import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PoliciesModule, evaluate } from '../src/index.js';
import type { Policy } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('policy engine (pure)', () => {
  const policies: Policy[] = [
    { id: 'p1', name: 'allow tools', effect: 'allow', match: { action: 'tool.invoke' }, priority: 1, status: 'active', createdAt: 0 },
    { id: 'p2', name: 'high risk needs approval', effect: 'require_approval', match: { riskMin: 4 }, priority: 5, status: 'active', createdAt: 0 },
    { id: 'p3', name: 'deny refunds', effect: 'deny', match: { action: 'commerce.refund' }, priority: 10, status: 'active', createdAt: 0 },
  ];

  it('deny wins over approval/allow', () => {
    const d = evaluate(policies, { action: 'commerce.refund', risk: 5 });
    assert.equal(d.effect, 'deny');
  });
  it('require_approval when risk high but not denied', () => {
    const d = evaluate(policies, { action: 'tool.invoke', risk: 4 });
    assert.equal(d.effect, 'require_approval');
  });
  it('allow for ordinary actions', () => {
    const d = evaluate(policies, { action: 'tool.invoke', risk: 1 });
    assert.equal(d.effect, 'allow');
  });
  it('defaults to allow when nothing matches', () => {
    const d = evaluate(policies, { action: 'something.else' });
    assert.equal(d.effect, 'allow');
  });
});

describe('PoliciesModule (kernel integration)', () => {
  let kernel: Kernel;
  let p: PoliciesModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new PoliciesModule({
      seedPolicies: [
        { name: 'govern refunds', effect: 'require_approval', match: { action: 'commerce.refund' }, priority: 5, status: 'active' },
      ],
      seedControls: [
        { framework: 'GDPR', requirement: 'data subject export', control: 'SAR export endpoint', status: 'implemented', evidence: ['/privacy/sar'] },
        { framework: 'SOC2', requirement: 'access reviews', control: 'quarterly review', status: 'planned', evidence: [] },
      ],
    }));
    await kernel.boot();
    p = kernel.getModule<PoliciesModule>('policies');
  });

  it('seeds policies and controls', async () => {
    assert.ok((await p.listPolicies()).length >= 1);
    assert.ok((await p.listControls('GDPR')).length >= 1);
  });

  it('decides governance effects and audits denials', async () => {
    await p.createPolicy({ name: 'block prod deploy', effect: 'deny', match: { action: 'deploy', resource: 'prod' }, priority: 10, status: 'active' });
    let denied = false;
    kernel.bus.on('policy.decision.deny', () => { denied = true; });
    const d = await p.decide({ action: 'deploy', resource: 'prod' });
    assert.equal(d.effect, 'deny');
    assert.equal(denied, true);
  });

  it('summarizes compliance coverage by framework', async () => {
    const s = await p.complianceSummary();
    assert.equal(s.GDPR!.implemented, 1);
    assert.equal(s.SOC2!.planned, 1);
  });

  it('toggles policy status', async () => {
    const pol = (await p.listPolicies())[0]!;
    await p.setPolicyStatus(pol.id, 'disabled');
    assert.equal((await p.getPolicy(pol.id))!.status, 'disabled');
  });
});
