import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, EchoLLM } from '@jataqi/agent-runtime';
import { SecurityModule } from '@jataqi/security';
import { QiLModule } from '@jataqi/qil';
import { OrchestratorModule } from '@jataqi/orchestrator';
import { MetricsModule } from '@jataqi/metrics';
import { SimulationModule } from '@jataqi/simulation';
import { TeamCoordinatorModule } from '@jataqi/teams';
import { PluginManagerModule } from '@jataqi/plugins';
import { ModelRegistryModule } from '@jataqi/model-registry';
import { SchedulerModule } from '@jataqi/scheduler';
import { ApiGatewayModule } from '../src/index.js';
import type { GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

async function jsonRequest(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

describe('ApiGatewayModule (HTTP vertical slice)', () => {
  let kernel: Kernel;
  let gateway: ApiGatewayModule;
  let handle: GatewayHandle;
  let base: string;
  let knowledge: KnowledgeService;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
    kernel.register(new QiLModule());
    kernel.register(new SecurityModule({ bootstrapAdmin: { username: 'admin', password: 'admin' } }));
    kernel.register(new OrchestratorModule());
    kernel.register(new MetricsModule());
    kernel.register(new SimulationModule());
    kernel.register(new TeamCoordinatorModule());
    kernel.register(new PluginManagerModule());
    kernel.register(new ModelRegistryModule({ models: [
      { id: 'm1', provider: 'acme', name: 'M1', capabilities: ['chat', 'reasoning'], quality: 90, inputCostPer1k: 1, outputCostPer1k: 2, latencyMs: 1000 },
      { id: 'm2', provider: 'acme', name: 'M2', capabilities: ['chat'], quality: 50, inputCostPer1k: 0.1, outputCostPer1k: 0.1, latencyMs: 200 },
    ] }));
    kernel.register(new SchedulerModule());
    gateway = new ApiGatewayModule();
    kernel.register(gateway);
    await kernel.boot();

    knowledge = kernel.getModule<KnowledgeService>('knowledge');
    await knowledge.ingestText('JATA Qi is a modular AI operating system.');
    await knowledge.ingestText('Q3 revenue grew 12% year over year.');

    handle = await gateway.listen({ port: 0 });
    base = `http://127.0.0.1:${handle.port}`;
  });

  after(async () => {
    await handle.close();
    await kernel.shutdown();
  });

  it('GET /health reports healthy and booted', async () => {
    const { status, body } = await jsonRequest('GET', `${base}/health`);
    assert.equal(status, 200);
    const b = body as { status: string; booted: boolean; modules: string[] };
    assert.equal(b.status, 'healthy');
    assert.equal(b.booted, true);
    assert.ok(b.modules.includes('orchestrator'));
  });

  it('registers and logs in a developer, returning a bearer token', async () => {
    const reg = await jsonRequest('POST', `${base}/auth/register`, { username: 'alice', password: 'pw', roles: ['developer'] });
    assert.equal(reg.status, 201);
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    assert.equal(login.status, 200);
    const b = login.body as { token: string; principal: { username: string } };
    assert.ok(b.token);
    assert.equal(b.principal.username, 'alice');
  });

  it('rejects /qil without a token (401)', async () => {
    const { status } = await jsonRequest('POST', `${base}/qil`, { program: 'MISSION "x" { REPORT }' });
    assert.equal(status, 401);
  });

  it('denies a guest the qil:run permission (403)', async () => {
    await jsonRequest('POST', `${base}/auth/register`, { username: 'guest1', password: 'pw', roles: ['guest'] });
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'guest1', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const { status, body } = await jsonRequest('POST', `${base}/qil`, { program: 'MISSION "x" { REPORT }' }, token);
    assert.equal(status, 403);
    assert.match((body as { error: string }).error, /permission denied/);
  });

  it('runs the full Alpha slice: objective -> workflow -> agent -> report -> audit', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;

    const { status, body } = await jsonRequest(
      'POST',
      `${base}/objective`,
      { objective: 'Analyze revenue growth' },
      token,
    );
    assert.equal(status, 200);
    const result = (body as { result: { status: string; finalReport: string; auditRecordId?: string; steps: unknown[] } }).result;
    assert.equal(result.status, 'completed');
    assert.ok(result.finalReport.length > 0);
    assert.ok(result.auditRecordId, 'execution must produce an audit record');

    // The audit ledger records the run.
    const audit = await jsonRequest('GET', `${base}/audit?action=orchestrator.run`, undefined, token);
    assert.equal(audit.status, 200);
    const records = (audit.body as { records: { action: string }[] }).records;
    assert.ok(records.some((r) => r.action === 'orchestrator.run'));
  });

  it('accepts a QiL program via POST /qil', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const { status, body } = await jsonRequest(
      'POST',
      `${base}/qil`,
      { program: 'MISSION "demo" { RETRIEVE "revenue" REASON "summarize" REPORT }' },
      token,
    );
    assert.equal(status, 200);
    const result = (body as { result: { status: string; steps: { kind: string }[] } }).result;
    assert.equal(result.status, 'completed');
    assert.equal(result.steps[0]!.kind, 'retrieve');
  });

  it('passes a message to the agent via POST /ask', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const { status, body } = await jsonRequest('POST', `${base}/ask`, { message: 'hello there' }, token);
    assert.equal(status, 200);
    assert.ok(typeof (body as { answer: string }).answer === 'string');
  });

  it('returns stats via GET /stats', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const { status, body } = await jsonRequest('GET', `${base}/stats`, undefined, token);
    assert.equal(status, 200);
    assert.ok((body as { knowledge: { documents: number } }).knowledge.documents >= 2);
  });

  it('returns the principal via GET /whoami', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const { status, body } = await jsonRequest('GET', `${base}/whoami`, undefined, token);
    assert.equal(status, 200);
    assert.equal((body as { principal: { username: string } }).principal.username, 'alice');
  });

  it('exposes Prometheus metrics via GET /metrics', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    // generate some traffic first
    await jsonRequest('GET', `${base}/health`);
    const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /jataqi_requests_total/);
  });

  it('runs a Monte-Carlo simulation via POST /simulate', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const { status, body } = await jsonRequest(
      'POST',
      `${base}/simulate`,
      {
        name: 'profit',
        inputs: { revenue: { kind: 'uniform', min: 80, max: 120 } },
        formula: 'revenue - 100',
        trials: 5000,
        seed: 1,
        targets: [0],
      },
      token,
    );
    assert.equal(status, 200);
    const result = (body as { result: { stats: { mean: number }; probabilities?: Record<string, number>; caveat: string } }).result;
    assert.ok(Math.abs(result.stats.mean - 0) < 2);
    assert.ok(result.probabilities && Math.abs(result.probabilities['0']! - 0.5) < 0.06);
    assert.match(result.caveat, /Modeled scenario/i);
  });

  it('coordinates an ad-hoc team via POST /team', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const { status, body } = await jsonRequest(
      'POST',
      `${base}/team`,
      { objective: 'review the plan', members: ['m1', 'm2', 'm3'], mode: 'parallel' },
      token,
    );
    assert.equal(status, 200);
    const result = (body as { result: { mode: string; contributions: unknown[]; synthesis: string } }).result;
    assert.equal(result.mode, 'parallel');
    assert.equal(result.contributions.length, 3);
    assert.ok(result.synthesis.length > 0);
  });

  it('lists and toggles plugins via /plugins', async () => {
    const plugins = kernel.getModule<PluginManagerModule>('plugins');
    await plugins.install({ id: 'demo-plugin', version: '1.2.0', capabilities: ['tool'] });

    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'admin', password: 'admin' });
    const token = (login.body as { token: string }).token;

    const list = await jsonRequest('GET', `${base}/plugins`, undefined, token);
    assert.equal(list.status, 200);
    assert.ok((list.body as { plugins: { id: string }[] }).plugins.some((p) => p.id === 'demo-plugin'));

    const disable = await jsonRequest('POST', `${base}/plugins`, { id: 'demo-plugin', action: 'disable' }, token);
    assert.equal(disable.status, 200);
    assert.equal((disable.body as { plugin: { enabled: boolean } }).plugin.enabled, false);
  });

  it('lists models and selects the best by preference', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const list = await jsonRequest('GET', `${base}/models`, undefined, token);
    assert.equal(list.status, 200);
    assert.ok((list.body as { models: unknown[] }).models.length >= 2);

    const sel = await jsonRequest('POST', `${base}/models/select`, { capabilities: ['chat'], prefer: 'quality' }, token);
    assert.equal(sel.status, 200);
    assert.equal((sel.body as { selection: { model: { id: string } } }).selection.model.id, 'm1'); // highest quality
  });

  it('reports scheduler stats', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const res = await jsonRequest('GET', `${base}/scheduler/stats`, undefined, token);
    assert.equal(res.status, 200);
    assert.ok((res.body as { stats: { targets: unknown[] } }).stats.targets.length >= 1);
  });
});
