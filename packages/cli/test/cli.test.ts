import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJataQi } from '../src/bootstrap.js';
import { AgentRuntimeModule } from '@jataqi/agent-runtime';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { SecurityModule } from '@jataqi/security';
import { OrchestratorModule } from '@jataqi/orchestrator';
import { QiLModule } from '@jataqi/qil';
import { MetricsModule } from '@jataqi/metrics';
import { SimulationModule } from '@jataqi/simulation';
import { TeamCoordinatorModule } from '@jataqi/teams';
import { PluginManagerModule } from '@jataqi/plugins';
import { ModelRegistryModule } from '@jataqi/model-registry';
import { SchedulerModule } from '@jataqi/scheduler';
import { ApiGatewayModule } from '@jataqi/api-gateway';

describe('createJataQi bootstrap', () => {
  it('boots the full stack and exposes all modules', async () => {
    const qi = await createJataQi();
    assert.equal(qi.kernel.isBooted(), true);
    assert.ok(qi.kernel.getModule<AgentRuntimeModule>('agent-runtime'));
    assert.ok(qi.kernel.getModule<KnowledgeService>('knowledge'));
    assert.ok(qi.kernel.getModule<KnowledgeGraphModule>('knowledge-graph'));
    assert.ok(qi.kernel.getModule<QiLModule>('qil'));
    assert.ok(qi.kernel.getModule<SecurityModule>('security'));
    assert.ok(qi.kernel.getModule<OrchestratorModule>('orchestrator'));
    assert.ok(qi.kernel.getModule<MetricsModule>('metrics'));
    assert.ok(qi.kernel.getModule<SimulationModule>('simulation'));
    assert.ok(qi.kernel.getModule<TeamCoordinatorModule>('teams'));
    assert.ok(qi.kernel.getModule<PluginManagerModule>('plugins'));
    assert.ok(qi.kernel.getModule<ModelRegistryModule>('model-registry'));
    assert.ok(qi.kernel.getModule<SchedulerModule>('scheduler'));
    assert.ok(qi.kernel.getModule<ApiGatewayModule>('api-gateway'));
    assert.ok(qi.gateway, 'bootstrap should expose the gateway handle');
    await qi.shutdown();
    assert.equal(qi.kernel.isBooted(), false);
  });

  it('runs a simple question against the default agent', async () => {
    const qi = await createJataQi();
    const agents = qi.kernel.getModule<AgentRuntimeModule>('agent-runtime');
    const res = await agents.run('hello world');
    assert.ok(res.answer.includes('hello world'));
    assert.equal(res.finishedReason, 'answer');
    await qi.shutdown();
  });

  it('ingests text, extracts entities, and retrieves', async () => {
    const qi = await createJataQi();
    const ks = qi.kernel.getModule<KnowledgeService>('knowledge');
    const g = qi.kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
    const doc = await ks.ingestText('Alice founded Acme Corp. Bob works at Acme Corp.', { chunkSize: 500 });
    for (const cid of doc.chunkIds) {
      const c = await ks.getChunk(cid);
      if (c) {
        const r = g.extractFromText(c.text, { chunkId: cid, documentId: doc.id });
        for (const t of r.triples) g.linkMention(cid, t.object, 0.7, doc.id);
      }
    }
    const stats = g.stats();
    assert.ok(stats.entities >= 2, `expected entities, got ${stats.entities}`);
    assert.ok(stats.triples >= 1, `expected triples, got ${stats.triples}`);
    await qi.shutdown();
  });

  it('seeds a bootstrap admin and runs a full QiL workflow through the orchestrator', async () => {
    const qi = await createJataQi({
      security: { bootstrapAdmin: { username: 'root', password: 'toor' } },
    });
    const sec = qi.kernel.getModule<SecurityModule>('security');
    const orch = qi.kernel.getModule<OrchestratorModule>('orchestrator');
    const ks = qi.kernel.getModule<KnowledgeService>('knowledge');
    await ks.ingestText('Acme Corp revenue grew 12% in Q3.');

    const login = await sec.login('root', 'toor');
    assert.equal(login.ok, true);

    const result = await orch.runObjective('Analyze Acme revenue', { principal: login.principal });
    assert.equal(result.status, 'completed');
    assert.ok(result.auditRecordId, 'workflow should produce an audit record');

    await qi.shutdown();
  });

  it('starts the gateway on an ephemeral port and answers /health', async () => {
    const qi = await createJataQi();
    const handle = await qi.gateway!.listen({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    const body = (await res.json()) as { status: string };
    assert.equal(res.status, 200);
    assert.equal(body.status, 'healthy');
    await handle.close();
    await qi.shutdown();
  });
});

