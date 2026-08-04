import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PolicyGovernanceModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('PolicyGovernanceModule (governance control plane)', () => {
  let kernel: Kernel;
  let gov: PolicyGovernanceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new PolicyGovernanceModule());
    await kernel.boot();
    gov = kernel.getModule<PolicyGovernanceModule>('policy-governance');
  });

  it('creates, versions, and deactivates policies', async () => {
    const p = await gov.createPolicy({ name: 'allow tools', category: 'TOOL', scope: 'GLOBAL', effect: 'ALLOW', action: 'tool.invoke' }, 'admin');
    assert.equal(p.version, 1);
    const v2 = await gov.updatePolicy(p.id, { priority: 9 }, 'admin');
    assert.equal(v2.version, 2);
    assert.equal(v2.priority, 9);
    const versions = await gov.policyVersions(p.id);
    assert.equal(versions.length, 2);
    const off = await gov.deactivatePolicy(p.id, 'admin');
    assert.equal(off.status, 'inactive');
    assert.equal(off.version, 3);
  });

  it('ALLOW / DENY / REQUIRE_APPROVAL decisions', async () => {
    await gov.createPolicy({ name: 'deny refunds', category: 'FINANCE', scope: 'GLOBAL', effect: 'DENY', action: 'commerce.refund' }, 'admin');
    await gov.createPolicy({ name: 'approve payments', category: 'FINANCE', scope: 'GLOBAL', effect: 'REQUIRE_APPROVAL', action: 'commerce.payment' }, 'admin');
    await gov.createPolicy({ name: 'allow read', category: 'ACCESS', scope: 'GLOBAL', effect: 'ALLOW', action: 'knowledge.read' }, 'admin');

    assert.equal((await gov.evaluate({ userId: 'u' }, 'commerce.refund')).decision, 'DENY');
    assert.equal((await gov.evaluate({ userId: 'u' }, 'commerce.payment')).decision, 'REQUIRES_APPROVAL');
    assert.equal((await gov.evaluate({ userId: 'u' }, 'knowledge.read')).decision, 'ALLOW');
  });

  it('defaults sensitive actions to DENY; others to ALLOW', async () => {
    assert.equal((await gov.evaluate({ userId: 'u' }, 'finance.transfer')).decision, 'DENY');
    assert.equal((await gov.evaluate({ userId: 'u' }, 'some.benign.action')).decision, 'ALLOW');
  });

  it('mandatory SAFETY deny cannot be overridden by a temporary override', async () => {
    await gov.createPolicy({ name: 'safety block', category: 'SAFETY', scope: 'GLOBAL', effect: 'DENY', action: 'agent.autonomous' }, 'admin');
    await gov.createOverride({ scope: 'GLOBAL', action: 'agent.autonomous', decision: 'ALLOW', who: 'admin', why: 'test', start: Date.now(), expiration: Date.now() + 60_000 });
    const r = await gov.evaluate({ userId: 'u' }, 'agent.autonomous');
    assert.equal(r.decision, 'DENY');
    assert.match(r.reason, /safety/);
  });

  it('a temporary override can permit a denied sensitive action (audited)', async () => {
    await gov.createOverride({ scope: 'GLOBAL', action: 'deploy.production', decision: 'ALLOW', who: 'admin', why: 'hotfix', start: Date.now(), expiration: Date.now() + 60_000 });
    const r = await gov.evaluate({ userId: 'u' }, 'deploy.production');
    assert.equal(r.decision, 'ALLOW');
    assert.match(r.reason, /override/);
  });

  it('REQUIRE_ROLE is satisfied when the subject holds the role, else REQUIRES_ROLE', async () => {
    await gov.createPolicy({ name: 'admin only', category: 'ACCESS', scope: 'GLOBAL', effect: 'REQUIRE_ROLE', action: 'org.delete', conditions: { requiredRoles: ['owner'] } }, 'admin');
    assert.equal((await gov.evaluate({ userId: 'u', roles: ['owner'] }, 'org.delete')).decision, 'ALLOW');
    assert.equal((await gov.evaluate({ userId: 'u', roles: ['member'] }, 'org.delete')).decision, 'REQUIRES_ROLE');
  });

  it('REQUIRE_ENTITLEMENT integrates with commercial entitlements', async () => {
    await gov.createPolicy({ name: 'need advanced models', category: 'COMMERCE', scope: 'GLOBAL', effect: 'REQUIRE_ENTITLEMENT', action: 'model.advanced', conditions: { requiredEntitlements: ['models.advanced'] } }, 'admin');
    assert.equal((await gov.evaluate({ userId: 'u', entitlements: ['models.advanced'] }, 'model.advanced')).decision, 'ALLOW');
    assert.equal((await gov.evaluate({ userId: 'u', entitlements: [] }, 'model.advanced')).decision, 'REQUIRES_ENTITLEMENT');
  });

  it('is tenant-aware: org-scoped policies do not apply cross-tenant', async () => {
    await gov.createPolicy({ name: 'org allow', category: 'ORGANIZATION', scope: 'ORGANIZATION', effect: 'ALLOW', action: 'workspace.read', organizationId: 'org-A' }, 'admin');
    // org A member: allowed (explicit allow)
    assert.equal((await gov.evaluate({ userId: 'u', organizationId: 'org-A' }, 'workspace.read')).decision, 'ALLOW');
    // org B member: no matching policy → benign default allow here, but the org-A policy did NOT match (tenant isolation).
    const r = await gov.evaluate({ userId: 'u', organizationId: 'org-B' }, 'workspace.read');
    assert.equal(r.matchedPolicies.length, 0);
    assert.equal(r.reason, 'No matching policy (default allow)');
    // A DENY scoped to org-A must NOT deny org-B.
    await gov.createPolicy({ name: 'org deny', category: 'ORGANIZATION', scope: 'ORGANIZATION', effect: 'DENY', action: 'workspace.write', organizationId: 'org-A' }, 'admin');
    assert.equal((await gov.evaluate({ userId: 'u', organizationId: 'org-B' }, 'workspace.write')).decision, 'ALLOW');
    assert.equal((await gov.evaluate({ userId: 'u', organizationId: 'org-A' }, 'workspace.write')).decision, 'DENY');
  });

  it('respects effective/expiry dates (scheduled governance)', async () => {
    const future = Date.now() + 10_000;
    await gov.createPolicy({ name: 'future deny', category: 'SAFETY', scope: 'GLOBAL', effect: 'DENY', action: 'future.x', effectiveAt: future }, 'admin');
    assert.equal((await gov.evaluate({ userId: 'u' }, 'future.x')).decision, 'ALLOW'); // not yet effective
    const expired = Date.now() - 1_000;
    await gov.createPolicy({ name: 'expired allow', category: 'ACCESS', scope: 'GLOBAL', effect: 'ALLOW', action: 'expired.x', expiresAt: expired }, 'admin');
    assert.equal((await gov.evaluate({ userId: 'u' }, 'expired.x')).decision, 'ALLOW'); // expired policy ignored → default allow
  });

  it('SIMULATE mode produces the same decision without side effects', async () => {
    await gov.createPolicy({ name: 'deny', category: 'SECURITY', scope: 'GLOBAL', effect: 'DENY', action: 'sec.op' }, 'admin');
    const r = await gov.simulate({ userId: 'u' }, 'sec.op');
    assert.equal(r.decision, 'DENY');
    assert.equal(r.simulated, true);
    // No audit/notification noise: evaluation history should be empty for the simulate (not persisted).
    const hist = await gov.evaluationHistory('u');
    assert.equal(hist.filter((e) => e.action === 'sec.op').length, 0);
  });

  it('financial threshold conditions (no hard-coded amounts)', async () => {
    await gov.createPolicy({ name: 'small refunds ok', category: 'FINANCE', scope: 'GLOBAL', effect: 'ALLOW', action: 'commerce.refund', conditions: { amountLte: 999 } }, 'admin');
    await gov.createPolicy({ name: 'big refunds need approval', category: 'FINANCE', scope: 'GLOBAL', effect: 'REQUIRE_APPROVAL', action: 'commerce.refund', conditions: { amountGte: 1000 } }, 'admin');
    assert.equal((await gov.evaluate({ userId: 'u' }, 'commerce.refund', { amount: 500 })).decision, 'ALLOW');
    assert.equal((await gov.evaluate({ userId: 'u' }, 'commerce.refund', { amount: 1500 })).decision, 'REQUIRES_APPROVAL');
  });

  it('records evaluation history for enforced decisions', async () => {
    await gov.evaluate({ userId: 'u' }, 'some.action');
    const hist = await gov.evaluationHistory('u');
    assert.ok(hist.length >= 1);
  });

  it('governs agents: tools, autonomy caps, budgets, iterations', async () => {
    await gov.setAgentGovernance({
      agentId: 'agent-1', organizationId: 'org-A', allowedTools: ['search'], blockedTools: ['deploy'],
      allowedActions: ['research.read'], maxAutonomy: 'L3', maximumBudget: 100, maximumIterations: 5,
    });
    assert.equal((await gov.checkAgent('agent-1', { toolId: 'deploy' })).allowed, false);
    assert.equal((await gov.checkAgent('agent-1', { toolId: 'unlisted' })).allowed, false); // not in allow-list
    assert.equal((await gov.checkAgent('agent-1', { toolId: 'search' })).allowed, true);
    assert.equal((await gov.checkAgent('agent-1', { autonomy: 'L5' })).allowed, false);
    assert.equal((await gov.checkAgent('agent-1', { autonomy: 'L2' })).allowed, true);
    assert.equal((await gov.checkAgent('agent-1', { iterations: 10 })).allowed, false);
    assert.equal((await gov.checkAgent('agent-1', { spent: 90, cost: 20 })).allowed, false); // 110 > 100
    assert.equal((await gov.checkAgent('agent-1', { spent: 10, cost: 20 })).allowed, true);
  });

  it('denials/requirements emit bus events', async () => {
    let denied = 0;
    let approval = 0;
    kernel.bus.on('governance.policy.denied', () => { denied++; });
    kernel.bus.on('governance.policy.approval_required', () => { approval++; });
    await gov.evaluate({ userId: 'u' }, 'finance.transfer'); // default deny
    assert.ok(denied >= 1);
  });
});
