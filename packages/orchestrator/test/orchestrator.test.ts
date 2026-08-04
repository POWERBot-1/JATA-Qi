import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, EchoLLM } from '@jataqi/agent-runtime';
import { SecurityModule } from '@jataqi/security';
import { PolicyGovernanceModule } from '@jataqi/policy-governance';
import { QiLModule, compileSource } from '@jataqi/qil';
import { OrchestratorModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

function bootKernel() {
  const k = createTestKernel();
  k.register(new StorageModule());
  k.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  k.register(new KnowledgeService());
  k.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  k.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
  k.register(new QiLModule());
  k.register(new SecurityModule());
  k.register(new OrchestratorModule());
  return k;
}

describe('OrchestratorModule (kernel integration)', () => {
  let kernel: Kernel;
  let orch: OrchestratorModule;
  let knowledge: KnowledgeService;

  beforeEach(async () => {
    kernel = bootKernel();
    await kernel.boot();
    orch = kernel.getModule<OrchestratorModule>('orchestrator');
    knowledge = kernel.getModule<KnowledgeService>('knowledge');
    await knowledge.ingestText('JATA Qi is a modular AI operating system with a kernel and agents.');
    await knowledge.ingestText('Revenue grew 12% in Q3 driven by enterprise contracts.');
  });

  it('executes a compiled plan end-to-end (retrieve -> reason -> report)', async () => {
    const r = compileSource(`MISSION "Analyze revenue"
RETRIEVE knowledge "revenue Q3"
REASON "summarize findings"
REPORT`);
    assert.equal(r.ok, true);
    const result = await orch.execute(r.plan!, {});
    assert.equal(result.status, 'completed');
    assert.equal(result.steps.length, 3);
    assert.equal(result.steps[0]!.kind, 'retrieve');
    assert.ok((result.steps[0]!.output as { hits: number }).hits >= 1);
    assert.equal(result.steps[1]!.kind, 'reason');
    assert.equal(result.steps[2]!.kind, 'report');
    assert.ok(result.finalReport.length > 0);
    assert.ok(result.retrieved.length >= 1);
  });

  it('writes an audit record when security is present', async () => {
    const result = await orch.runObjective('what is JATA Qi?', { principal: { userId: 'u1', username: 'alice', roles: ['developer'] } });
    assert.ok(result.auditRecordId);
    const sec = kernel.getModule<SecurityModule>('security');
    const rec = await sec.getAuditLog().get(result.auditRecordId!);
    assert.equal(rec?.action, 'orchestrator.run');
    assert.equal(rec?.actor, 'u1');
  });

  it('respects a STOP step by halting the workflow', async () => {
    const r = compileSource(`REASON "do something"
STOP
REASON "should not run"`);
    const result = await orch.execute(r.plan!, {});
    assert.equal(result.status, 'stopped');
    assert.equal(result.steps.length, 3);
    assert.equal(result.steps[2]!.status, 'skipped');
  });

  it('runSource compiles and executes QiL text', async () => {
    const result = await orch.runSource('MISSION "demo" { RETRIEVE "revenue" REPORT }');
    assert.equal(result.status, 'completed');
    assert.equal(result.mission, 'demo');
  });

  it('runObjective builds a plan from free text', async () => {
    const result = await orch.runObjective('Analyze my business');
    assert.equal(result.status, 'completed');
    assert.equal(result.mission, 'Analyze my business');
    assert.ok(result.finalReport.length > 0);
  });

  it('detects cyclic dependency graphs', async () => {
    const r = compileSource('REASON "x"');
    assert.ok(r.plan);
    // Inject a cycle manually.
    const plan = {
      ...r.plan!,
      steps: [
        { ...r.plan!.steps[0]!, id: 'a', dependsOn: ['b'] },
        { ...r.plan!.steps[0]!, id: 'b', dependsOn: ['a'] },
      ],
    };
    await assert.rejects(() => orch.execute(plan, {}), /cyclic dependency/);
  });

  it('emits lifecycle events on the bus', async () => {
    let started = 0;
    let completed = 0;
    kernel.bus.on('orchestrator.execution.started', () => { started++; });
    kernel.bus.on('orchestrator.execution.completed', () => { completed++; });
    await orch.runObjective('test mission');
    assert.equal(started, 1);
    assert.equal(completed, 1);
  });

  it('persists runs to durable storage and supports history queries', async () => {
    const r1 = await orch.runObjective('first objective');
    const r2 = await orch.runObjective('second objective');

    const got = await orch.getRun(r1.id);
    assert.ok(got);
    assert.equal(got!.mission, 'first objective');

    const list = await orch.listRuns();
    assert.equal(list.length, 2);
    // newest first
    assert.equal(list[0]!.id, r2.id);
  });
});

describe('Orchestrator — mandatory governance enforcement', () => {
  let kernel: Kernel;
  let orch: OrchestratorModule;
  let gov: PolicyGovernanceModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
    kernel.register(new QiLModule());
    kernel.register(new PolicyGovernanceModule());
    kernel.register(new OrchestratorModule());
    await kernel.boot();
    orch = kernel.getModule<OrchestratorModule>('orchestrator');
    gov = kernel.getModule<PolicyGovernanceModule>('policy-governance');
    await kernel.getModule<KnowledgeService>('knowledge').ingestText('JATA Qi is a modular AI operating system.');
  });
  afterEach(async () => { await kernel.shutdown(); });

  it('passes every step through the governance gate (default allow → completed)', async () => {
    const result = await orch.runObjective('summarize');
    assert.equal(result.status, 'completed');
    // Every executed step recorded a governance decision.
    assert.ok(result.steps.every((s) => s.governance && s.governance.decision === 'ALLOW'));
  });

  it('blocks a step whose action governance denies (agent.run)', async () => {
    await gov.createPolicy({ name: 'deny agent run', category: 'AI', scope: 'GLOBAL', effect: 'DENY', action: 'agent.run' }, 'admin');
    const result = await orch.runObjective('summarize');
    const reason = result.steps.find((s) => s.kind === 'reason')!;
    assert.equal(reason.status, 'error');
    assert.match(reason.error!, /governance DENY/);
    assert.equal(reason.governance!.decision, 'DENY');
    // Benign steps still executed through the gate.
    const retrieve = result.steps.find((s) => s.kind === 'retrieve')!;
    assert.equal(retrieve.status, 'success');
    assert.equal(retrieve.governance!.decision, 'ALLOW');
  });

  it('blocks deploy steps (sensitive default-deny even without an explicit policy)', async () => {
    const r = compileSource('DEPLOY "release"');
    assert.ok(r.ok && r.plan);
    const result = await orch.execute(r.plan!, {});
    const deploy = result.steps.find((s) => s.kind === 'deploy')!;
    assert.equal(deploy.status, 'error');
    assert.match(deploy.error!, /governance DENY/);
  });
});
