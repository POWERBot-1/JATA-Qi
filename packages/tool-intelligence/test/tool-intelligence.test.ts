import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { ToolIntelligenceModule } from '../src/index.js';
import { PolicyGovernanceModule } from '@jataqi/policy-governance';
import { MetricsModule } from '@jataqi/metrics';
import type { ToolAdapter, ToolEntity } from '../src/index.js';
import { AGENT_TOOL_CATALOG, AGENT_TOOL_NAMES, APPROVAL_GATED_AGENT_TOOLS } from '../src/index.js';
import type { AgentToolDescriptor } from '../src/index.js';
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

describe('Tool-intelligence — mandatory governance enforcement', () => {
  let kernel: Kernel;
  let ti: ToolIntelligenceModule;
  let gov: PolicyGovernanceModule;
  let metrics: MetricsModule;
  let toolId: string;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new MetricsModule());
    kernel.register(new PolicyGovernanceModule());
    kernel.register(new ToolIntelligenceModule());
    await kernel.boot();
    ti = kernel.getModule<ToolIntelligenceModule>('tool-intelligence');
    gov = kernel.getModule<PolicyGovernanceModule>('policy-governance');
    metrics = kernel.getModule<MetricsModule>('metrics');
    const tool = await ti.register({ canonicalName: 'echo', provider: 'jataqi', version: '1.0.0', category: 'util', capabilities: ['echo'], protocol: 'function', riskClass: 'R0', status: 'ACTIVE' });
    toolId = tool.id;
    ti.registerAdapter(echoAdapter(toolId, ['echo']));
  });
  afterEach(async () => { await kernel.shutdown(); });

  it('allows invocation through the gate when governance permits', async () => {
    const res = await ti.invoke(toolId, { msg: 'hi' }, { userId: 'u', username: 'ada', roles: ['developer'] });
    assert.equal(res.status, 'success');
    assert.ok(res.governance && res.governance.decision === 'ALLOW');
  });

  it('denies invocation when governance denies tool.invoke', async () => {
    await gov.createPolicy({ name: 'deny all tools', category: 'TOOL', scope: 'GLOBAL', effect: 'DENY', action: 'tool.invoke' }, 'admin');
    const res = await ti.invoke(toolId, { msg: 'hi' }, { userId: 'u', username: 'ada', roles: ['developer'] });
    assert.equal(res.status, 'denied');
    assert.match(res.error!, /governance DENY/);
    assert.equal(res.governance!.decision, 'DENY');
  });

  it('surfaces a governance approval requirement as pending_approval', async () => {
    await gov.createPolicy({ name: 'approve tools', category: 'TOOL', scope: 'GLOBAL', effect: 'REQUIRE_APPROVAL', action: 'tool.invoke' }, 'admin');
    const res = await ti.invoke(toolId, { msg: 'hi' }, { userId: 'u', username: 'ada', roles: ['developer'] });
    assert.equal(res.status, 'pending_approval');
    assert.match(res.error!, /REQUIRES_APPROVAL/);
  });

  it('counts every governance decision in observability metrics', async () => {
    await ti.invoke(toolId, { msg: 'a' }); // ALLOW
    await gov.createPolicy({ name: 'deny', category: 'TOOL', scope: 'GLOBAL', effect: 'DENY', action: 'tool.invoke' }, 'admin');
    await ti.invoke(toolId, { msg: 'b' }); // DENY
    const allowed = metrics.registry.counter('jataqi_governance_decisions_total').get({ decision: 'ALLOW' });
    const denied = metrics.registry.counter('jataqi_governance_decisions_total').get({ decision: 'DENY' });
    assert.ok(allowed >= 1, `allowed=${allowed}`);
    assert.ok(denied >= 1, `denied=${denied}`);
  });

  it('fallback skips a governance-denied tool and still records the decision', async () => {
    await gov.createPolicy({ name: 'deny', category: 'TOOL', scope: 'GLOBAL', effect: 'DENY', action: 'tool.invoke' }, 'admin');
    const res = await ti.invokeWithFallback('echo', { msg: 'x' });
    // The only tool is denied → fallback reports failure.
    assert.equal(res.status, 'failure');
  });
});

describe('Agent tool governance catalog (37 default + 2 compute agent tools)', () => {
  it('classifies all 39 catalogued agent tools with valid risk/privacy classes', () => {
    assert.equal(AGENT_TOOL_NAMES.length, 39);
    assert.equal(AGENT_TOOL_CATALOG.length, 39);
    const names = new Set(AGENT_TOOL_NAMES);
    for (const entry of AGENT_TOOL_CATALOG) {
      assert.ok(names.has(entry.name), `duplicate or unknown catalog entry ${entry.name}`);
      assert.match(entry.riskClass, /^R[0-5]$/);
      assert.ok(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].includes(entry.privacyClass));
      assert.ok(entry.capabilities.length > 0, `capabilities for ${entry.name}`);
      assert.ok(entry.rationale.length > 10, `rationale for ${entry.name}`);
    }
  });

  it('gates exactly the high-risk tools behind human approval (R4)', () => {
    // Financial/infrastructure actions require approval; everything else runs freely.
    assert.deepEqual([...APPROVAL_GATED_AGENT_TOOLS].sort(), ['cloud.autoscale', 'cloud.provision', 'mobility.dispatch']);
    const r4 = AGENT_TOOL_CATALOG.filter((e) => e.riskClass === 'R4' || e.riskClass === 'R5');
    assert.equal(r4.length, 3);
    for (const entry of r4) assert.ok(APPROVAL_GATED_AGENT_TOOLS.includes(entry.name));
  });

  it('covers the full agent tool surface (core + intelligence + compute)', () => {
    for (const name of [
      'knowledge.search', 'graph.traverse', 'graph.findEntity', 'graph.retrieve', 'vector.search',
      'fx.rate', 'fx.convert', 'mobility.dispatch', 'mobility.vehicles',
      'logistics.track', 'logistics.shipments', 'agriculture.stats', 'agriculture.harvests',
      'circular.stats', 'circular.collections', 'energy.stats', 'energy.readings',
      'border.screen', 'border.crossings', 'restaurants.menu', 'restaurants.orders',
      'marketplace.listings', 'platform.search', 'wallet.balance', 'crypto.balance',
      'cloud.instances', 'cloud.provision', 'cloud.autoscale',
      'cdn.zones', 'cdn.lookup', 'cdn.purge',
      'email.domains', 'email.send', 'email.inbox',
      'ipam.blocks', 'ipam.announcements', 'ipam.stats',
      'compute.stats', 'compute.regression',
    ]) {
      assert.ok(AGENT_TOOL_NAMES.includes(name), `catalog missing ${name}`);
    }
  });
});

describe('syncAgentTools — governance registry sync from agent tool descriptors', () => {
  let kernel: Kernel;
  let ti: ToolIntelligenceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new ToolIntelligenceModule());
    await kernel.boot();
    ti = kernel.getModule<ToolIntelligenceModule>('tool-intelligence');
  });

  afterEach(async () => { await kernel.shutdown(); });

  function stubTools(names: string[]): AgentToolDescriptor[] {
    return names.map((name) => ({
      name,
      description: `stub ${name}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async execute(input: unknown) { return { name, input }; },
    }));
  }

  it('syncs descriptors into ACTIVE entities with catalog risk classes and binds adapters', async () => {
    const result = await ti.syncAgentTools(stubTools(['fx.rate', 'cloud.provision', 'email.send']));
    assert.equal(result.created, 3);
    assert.equal(result.updated, 0);

    const fx = await ti.get((await ti.list()).find((t) => t.canonicalName === 'fx.rate')!.id);
    assert.equal(fx!.riskClass, 'R0');
    assert.equal(fx!.privacyClass, 'PUBLIC');
    assert.equal(fx!.status, 'ACTIVE');
    assert.equal(fx!.metadata?.agentTool, true);

    const provision = (await ti.list()).find((t) => t.canonicalName === 'cloud.provision')!;
    assert.equal(provision.riskClass, 'R4');

    // Re-sync updates instead of duplicating.
    const again = await ti.syncAgentTools(stubTools(['fx.rate']));
    assert.equal(again.created, 0);
    assert.equal(again.updated, 1);
    assert.equal((await ti.list()).length, 3);
    assert.equal((await ti.listAgentTools()).length, 3);
  });

  it('invokes a synced R0 tool end-to-end through the pipeline', async () => {
    await ti.syncAgentTools(stubTools(['fx.rate']));
    const entity = (await ti.list())[0]!;
    const result = await ti.invoke(entity.id, { pair: 'USD/KES' });
    assert.equal(result.status, 'success');
    assert.deepEqual(result.output, { name: 'fx.rate', input: { pair: 'USD/KES' } });
  });

  it('gates synced R4 tools behind human approval (invoke → pending_approval)', async () => {
    await ti.syncAgentTools(stubTools(['cloud.provision']));
    const entity = (await ti.list())[0]!;

    const blocked = await ti.invoke(entity.id, { name: 'web-1' });
    assert.equal(blocked.status, 'pending_approval');
    assert.match(blocked.error!, /requires human approval/);

    // Request + approve, then invoke succeeds.
    const req = ti.requestApproval(entity.id, 'u1', 'invoke', 'provision web server');
    ti.decideApproval(req.id, 'approved', 'admin');
    const ok = await ti.invoke(entity.id, { name: 'web-1' }, undefined, req.id);
    assert.equal(ok.status, 'success');
    assert.deepEqual(ok.output, { name: 'cloud.provision', input: { name: 'web-1' } });
  });

  it('validates required input fields from the tool schema', async () => {
    await ti.syncAgentTools([{
      name: 'email.send',
      description: 'send mail',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['from', 'to', 'subject', 'body'] },
      async execute(input: unknown) { return { ok: true, input }; },
    }]);
    const entity = (await ti.list())[0]!;
    await assert.rejects(ti.invoke(entity.id, { from: 'a@b.co' }), /missing required field "to"/);
  });

  it('registers unknown tools conservatively (R3 / INTERNAL) so nothing runs ungoverned', async () => {
    await ti.syncAgentTools(stubTools(['mystery.tool']));
    const entity = (await ti.list())[0]!;
    assert.equal(entity.riskClass, 'R3');
    assert.equal(entity.privacyClass, 'INTERNAL');
    assert.equal(entity.status, 'ACTIVE');
  });
});

describe('Tool governance observability (metrics + governanceStats)', () => {
  let kernel: Kernel;
  let ti: ToolIntelligenceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new MetricsModule());
    kernel.register(new ToolIntelligenceModule());
    await kernel.boot();
    ti = kernel.getModule<ToolIntelligenceModule>('tool-intelligence');
  });

  afterEach(async () => { await kernel.shutdown(); });

  it('emits invocation + approval metrics and aggregates governanceStats', async () => {
    // R0 tool — auto-invokes.
    const r0 = await ti.register({ canonicalName: 'echo-safe', provider: 'jataqi', version: '1.0.0', category: 'util', capabilities: ['echo'], protocol: 'function', riskClass: 'R0', status: 'ACTIVE' });
    ti.registerAdapter({ id: r0.id, capabilities: () => ['echo'], async invoke(input) { return { echo: input }; } });
    // R4 tool — approval-gated.
    const r4 = await ti.register({ canonicalName: 'provision', provider: 'jataqi', version: '1.0.0', category: 'cloud', capabilities: ['provision'], protocol: 'function', riskClass: 'R4', status: 'ACTIVE' });
    ti.registerAdapter({ id: r4.id, capabilities: () => ['provision'], async invoke(input) { return { ok: true }; } });

    // R0 success.
    const ok = await ti.invoke(r0.id, { a: 1 });
    assert.equal(ok.status, 'success');
    // R4 pending (no approval yet).
    const gated = await ti.invoke(r4.id, { b: 2 });
    assert.equal(gated.status, 'pending_approval');
    // Approval flow.
    const req = ti.requestApproval(r4.id, 'u1', 'invoke', 'provision');
    ti.decideApproval(req.id, 'approved', 'admin');
    const ok4 = await ti.invoke(r4.id, { b: 3 }, undefined, req.id);
    assert.equal(ok4.status, 'success');

    const metrics = kernel.getModule<MetricsModule>('metrics');
    const samples = metrics.snapshot();

    const invTotal = samples.find((s) => s.name === 'jataqi_tool_invocations_total' && !s.labels?.risk);
    // aggregate by label
    const invR0 = samples.filter((s) => s.name === 'jataqi_tool_invocations_total' && s.labels?.risk === 'R0');
    const invR4 = samples.filter((s) => s.name === 'jataqi_tool_invocations_total' && s.labels?.risk === 'R4');
    assert.equal(invR0.reduce((n, s) => n + s.value, 0), 1);
    assert.equal(invR4.reduce((n, s) => n + s.value, 0), 2); // pending + success
    const pendingSeries = samples.find((s) => s.name === 'jataqi_tool_invocations_total' && s.labels?.status === 'pending_approval');
    assert.ok(pendingSeries && pendingSeries.value >= 1);
    assert.ok(invTotal === undefined || invTotal.value >= 0);

    const approvals = samples.filter((s) => s.name === 'jataqi_tool_approval_requests_total');
    assert.equal(approvals.reduce((n, s) => n + s.value, 0), 2); // requested + approved
    assert.equal(samples.find((s) => s.name === 'jataqi_tool_pending_approvals')?.value, 0);

    const durSeries = samples.find((s) => s.name === 'jataqi_tool_invocation_duration_ms');
    assert.ok(durSeries, 'duration histogram present');

    // governanceStats aggregation.
    const stats = await ti.governanceStats();
    assert.equal(stats.tools.total, 2);
    assert.equal(stats.tools.approvalGated, 1);
    assert.equal(stats.tools.byRisk.R0, 1);
    assert.equal(stats.tools.byRisk.R4, 1);
    assert.equal(stats.approvals.requested, 1); // one request created
    assert.equal(stats.approvals.approved, 1);
    assert.equal(stats.approvals.pending, 0);
    assert.equal(stats.invocations.total, 3);
    assert.equal(stats.invocations.byStatus.success, 2);
    assert.equal(stats.invocations.byStatus.pending_approval, 1);
    assert.equal(stats.invocations.byRisk.R4, 2);
    assert.ok(typeof stats.avgDurationMs === 'number');
  });

  it('governanceStats works without the metrics module (graceful degradation)', async () => {
    const kernel2 = createTestKernel();
    kernel2.register(new StorageModule());
    kernel2.register(new ToolIntelligenceModule());
    await kernel2.boot();
    try {
      const ti2 = kernel2.getModule<ToolIntelligenceModule>('tool-intelligence');
      await ti2.register({ canonicalName: 'x', provider: 'jataqi', version: '1.0.0', category: 'c', capabilities: ['x'], protocol: 'function', riskClass: 'R2', status: 'ACTIVE' });
      const stats = await ti2.governanceStats();
      assert.equal(stats.tools.total, 1);
      assert.equal(stats.tools.byRisk.R2, 1);
      assert.equal(stats.invocations.total, 0);
      assert.equal(stats.avgDurationMs, undefined);
    } finally {
      await kernel2.shutdown();
    }
  });

  it('records governance gate decisions when policy-governance denies', async () => {
    await govBoot();
    async function govBoot() {
      const k = createTestKernel();
      k.register(new StorageModule());
      k.register(new MetricsModule());
      k.register(new PolicyGovernanceModule());
      k.register(new ToolIntelligenceModule());
      await k.boot();
      const mod = k.getModule<ToolIntelligenceModule>('tool-intelligence');
      const tool = await mod.register({ canonicalName: 'denied-tool', provider: 'jataqi', version: '1.0.0', category: 'c', capabilities: ['x'], protocol: 'function', riskClass: 'R0', status: 'ACTIVE' });
      mod.registerAdapter({ id: tool.id, capabilities: () => ['x'], async invoke(input) { return input; } });
      const gov = k.getModule<PolicyGovernanceModule>('policy-governance');
      await gov.createPolicy({ name: 'deny-tools', category: 'TOOL', scope: 'GLOBAL', effect: 'DENY', action: 'tool.invoke' }, 'admin');
      const res = await mod.invoke(tool.id, { a: 1 });
      assert.equal(res.status, 'denied');
      const metrics = k.getModule<MetricsModule>('metrics');
      const decisions = metrics.snapshot().filter((s) => s.name === 'jataqi_tool_governance_decisions_total');
      assert.equal(decisions.reduce((n, s) => n + s.value, 0), 1);
      assert.equal(decisions.find((s) => s.labels?.decision === 'DENY')?.value, 1);
      const stats = await mod.governanceStats();
      assert.equal(stats.decisions.byDecision.DENY, 1);
      assert.equal(stats.invocations.byStatus.denied, 1);
      await k.shutdown();
    }
  });
});

describe('Approval workflow — history + filters', () => {
  let kernel: Kernel;
  let ti: ToolIntelligenceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new ToolIntelligenceModule());
    await kernel.boot();
    ti = kernel.getModule<ToolIntelligenceModule>('tool-intelligence');
  });

  afterEach(async () => { await kernel.shutdown(); });

  it('tracks the full request history with status filters, newest first', async () => {
    const t1 = await ti.register({ canonicalName: 'a', provider: 'p', version: '1', category: 'c', capabilities: ['a'], protocol: 'function', riskClass: 'R4', status: 'ACTIVE' });
    const t2 = await ti.register({ canonicalName: 'b', provider: 'p', version: '1', category: 'c', capabilities: ['b'], protocol: 'function', riskClass: 'R4', status: 'ACTIVE' });

    const r1 = ti.requestApproval(t1.id, 'u1', 'invoke', 'first');
    ti.decideApproval(r1.id, 'approved', 'admin');
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt for ordering
    const r2 = ti.requestApproval(t2.id, 'u2', 'invoke', 'second');
    ti.decideApproval(r2.id, 'denied', 'admin');
    await new Promise((r) => setTimeout(r, 5));
    const r3 = ti.requestApproval(t1.id, 'u3', 'invoke', 'third'); // stays pending

    const all = ti.listApprovals();
    assert.equal(all.length, 3);
    assert.equal(all[0]!.id, r3.id, 'newest first');
    assert.equal(all[2]!.id, r1.id);

    assert.equal(ti.listApprovals('pending').length, 1);
    assert.equal(ti.listApprovals('approved').length, 1);
    assert.equal(ti.listApprovals('denied').length, 1);
    assert.equal(ti.listApprovals('expired').length, 0);
    assert.equal(ti.listPendingApprovals().length, 1);
  });
});
