import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, EchoLLM } from '@jataqi/agent-runtime';
import { SecurityModule } from '@jataqi/security';
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
});
