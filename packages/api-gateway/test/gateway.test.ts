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
import { RoboticsModule } from '@jataqi/robotics';
import { DigitalTwinModule } from '@jataqi/digital-twin';
import { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import { ReadinessModule } from '@jataqi/readiness';
import { ProvenanceModule, provisionRoot } from '@jataqi/provenance';
import { CommerceModule } from '@jataqi/commerce';
import { OrganizationsModule } from '@jataqi/organizations';
import { NotificationsModule } from '@jataqi/notifications';
import { PoliciesModule } from '@jataqi/policies';
import { FeatureFlagsModule } from '@jataqi/feature-flags';
import { PrivacyModule } from '@jataqi/privacy';
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
    kernel.register(new RoboticsModule());
    kernel.register(new DigitalTwinModule());
    kernel.register(new ToolIntelligenceModule());
    kernel.register(new ReadinessModule());
    const prov = provisionRoot();
    kernel.register(new ProvenanceModule({ manifest: prov.manifest, privateKey: prov.privateKeyDerB64 }));
    kernel.register(new CommerceModule());
    kernel.register(new OrganizationsModule());
    kernel.register(new NotificationsModule());
    kernel.register(new PoliciesModule());
    kernel.register(new FeatureFlagsModule());
    kernel.register(new PrivacyModule());
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

  it('GET / returns a self-describing route index', async () => {
    const { status, body } = await jsonRequest('GET', `${base}/`);
    assert.equal(status, 200);
    const b = body as { name: string; endpoints: { method: string; path: string }[] };
    assert.equal(b.name, 'JATA Qi API');
    assert.ok(b.endpoints.some((e) => e.path === '/health'));
  });

  it('GET /openapi.json returns an OpenAPI 3.0 document with all paths', async () => {
    const { status, body } = await jsonRequest('GET', `${base}/openapi.json`);
    assert.equal(status, 200);
    const b = body as { openapi: string; paths: Record<string, unknown> };
    assert.equal(b.openapi, '3.0.3');
    assert.ok(b.paths['/health']);
    assert.ok(b.paths['/qil']);
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

  it('computes statistics and regression', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const stats = await jsonRequest('POST', `${base}/compute/stats`, { values: [1, 2, 3, 4] }, token);
    assert.equal(stats.status, 200);
    assert.equal((stats.body as { stats: { mean: number } }).stats.mean, 2.5);
    const reg = await jsonRequest('POST', `${base}/compute/regression`, { x: [1, 2, 3], y: [2, 4, 6] }, token);
    assert.equal(reg.status, 200);
    assert.ok(Math.abs((reg.body as { fit: { slope: number; r2: number } }).fit.slope - 2) < 1e-9);
  });

  it('manages robotic devices and missions', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;

    const created = await jsonRequest('POST', `${base}/devices`, { name: 'Scout', kind: 'drone', capabilities: ['scan'] }, token);
    assert.equal(created.status, 201);
    const deviceId = (created.body as { device: { id: string } }).device.id;

    const listed = await jsonRequest('GET', `${base}/devices`, undefined, token);
    assert.equal(listed.status, 200);
    assert.ok((listed.body as { devices: unknown[] }).devices.length >= 1);

    const mission = await jsonRequest('POST', `${base}/missions`, { action: 'assign', deviceId, objective: 'survey zone A' }, token);
    assert.equal(mission.status, 201);
    const missionId = (mission.body as { mission: { id: string; status: string } }).mission.id;
    assert.equal((mission.body as { mission: { status: string } }).mission.status, 'active');

    const done = await jsonRequest('POST', `${base}/missions`, { action: 'complete', id: missionId, result: 'surveyed' }, token);
    assert.equal((done.body as { mission: { status: string } }).mission.status, 'completed');
  });

  it('recommends a compute target by profile', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const res = await jsonRequest('POST', `${base}/scheduler/route`, { kind: 'simulation', requireGpu: true }, token);
    assert.equal(res.status, 200);
    assert.ok(typeof (res.body as { target: string }).target === 'string');
  });

  it('creates and projects a digital twin', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const created = await jsonRequest('POST', `${base}/twins`, { name: 'Acct', type: 'finance', state: { balance: 1000 } }, token);
    assert.equal(created.status, 201);
    const id = (created.body as { twin: { id: string } }).twin.id;
    const proj = await jsonRequest('POST', `${base}/twin`, { id, action: 'project', steps: 3, rules: [{ key: 'balance', from: [{ key: 'balance', factor: 1.05 }] }] }, token);
    assert.equal(proj.status, 200);
    assert.equal((proj.body as { trajectory: number[] }).trajectory.length, 4);
  });

  it('exposes an honest readiness matrix (public)', async () => {
    const list = await jsonRequest('GET', `${base}/readiness`);
    assert.equal(list.status, 200);
    assert.ok((list.body as { capabilities: unknown[] }).capabilities.length > 10);
    const summary = await jsonRequest('GET', `${base}/readiness/summary`);
    assert.match((summary.body as { overall: string }).overall, /NOT production-ready/);
  });

  it('registers and invokes a tool through the Universal Tool layer', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const reg = await jsonRequest('POST', `${base}/tools`, { canonicalName: 'upper', provider: 'test', version: '1.0.0', category: 'util', capabilities: ['uppercase'], protocol: 'function', riskClass: 'R0', status: 'ACTIVE' }, token);
    assert.equal(reg.status, 201);
    const toolId = (reg.body as { tool: { id: string } }).tool.id;
    // No adapter bound -> invoke fails gracefully.
    const failed = await jsonRequest('POST', `${base}/tool/invoke`, { id: toolId, input: { x: 1 } }, token);
    assert.equal(failed.status, 500);
  });

  it('exposes the creator identity and verifies provenance', async () => {
    const info = await jsonRequest('GET', `${base}/identity`);
    assert.equal(info.status, 200);
    const body = info.body as { creator: { display_name: string }; self: { who_created_you: string }; public_key: string };
    assert.equal(body.creator.display_name, 'GITANYA K');
    assert.equal(body.self.who_created_you, 'GITANYA K');
    assert.ok(body.public_key); // public key exposed, but never the private key
    assert.doesNotMatch(JSON.stringify(body), /private/i);

    const verify = await jsonRequest('GET', `${base}/identity/verify`);
    assert.equal(verify.status, 200);
    assert.equal((verify.body as { valid: boolean }).valid, true);
  });

  it('runs the commercial flow: plans, subscribe, entitlement check', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const plans = await jsonRequest('GET', `${base}/commerce/plans`, undefined, token);
    assert.equal(plans.status, 200);
    assert.ok((plans.body as { plans: unknown[] }).plans.length >= 10);
    const sub = await jsonRequest('POST', `${base}/commerce/subscribe`, { planSlug: 'free' }, token);
    assert.equal(sub.status, 201);
    const check = await jsonRequest('GET', `${base}/commerce/check?feature=ai.requests`, undefined, token);
    assert.equal(check.status, 200);
    assert.equal((check.body as { decision: { allowed: boolean } }).decision.allowed, true);
    const analytics = await jsonRequest('GET', `${base}/commerce/analytics`, undefined, token);
    assert.equal(analytics.status, 200);
    assert.ok((analytics.body as { totalSubscriptions: number }).totalSubscriptions >= 1);
  });

  it('creates an organization and manages membership', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const created = await jsonRequest('POST', `${base}/orgs`, { name: 'Acme Inc' }, token);
    assert.equal(created.status, 201);
    const org = (created.body as { organization: { id: string; ownerId: string } }).organization;
    const members = await jsonRequest('GET', `${base}/org/members?id=${org.id}`, undefined, token);
    assert.equal(members.status, 200);
    const list = (members.body as { members: { userId: string; role: string }[] }).members;
    assert.ok(list.some((m) => m.userId === org.ownerId && m.role === 'owner'));
  });

  it('sends and lists notifications', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const sent = await jsonRequest('POST', `${base}/notify`, { type: 'system', title: 'Hello', body: 'world' }, token);
    assert.equal(sent.status, 201);
    const list = await jsonRequest('GET', `${base}/notifications`, undefined, token);
    assert.equal(list.status, 200);
    assert.ok((list.body as { notifications: unknown[] }).notifications.length >= 1);
  });

  it('evaluates governance policies and manages feature flags + privacy', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    // Policy evaluate (default allow).
    const dec = await jsonRequest('POST', `${base}/policy/evaluate`, { action: 'something' }, token);
    assert.equal(dec.status, 200);
    assert.equal((dec.body as { decision: { effect: string } }).decision.effect, 'allow');
    // Feature flag set + check.
    await jsonRequest('POST', `${base}/flag`, { key: 'new-ui', enabled: true, rolloutPct: 100 }, token);
    const fc = await jsonRequest('GET', `${base}/flag/check?key=new-ui`, undefined, token);
    assert.equal((fc.body as { enabled: boolean }).enabled, true);
    // Privacy: create SAR for self.
    const sar = await jsonRequest('POST', `${base}/privacy/sar`, { type: 'export' }, token);
    assert.equal(sar.status, 201);
    assert.ok((sar.body as { sar: { id: string } }).sar.id);
  });

  it('records and retrieves workflow history', async () => {
    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'alice', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const ran = await jsonRequest('POST', `${base}/objective`, { objective: 'history test' }, token);
    const id = (ran.body as { result: { id: string } }).result.id;

    const list = await jsonRequest('GET', `${base}/workflows`, undefined, token);
    assert.equal(list.status, 200);
    assert.ok((list.body as { runs: { id: string }[] }).runs.some((r) => r.id === id));

    const one = await jsonRequest('GET', `${base}/workflow?id=${id}`, undefined, token);
    assert.equal(one.status, 200);
    assert.equal((one.body as { run: { id: string } }).run.id, id);

    const missing = await jsonRequest('GET', `${base}/workflow?id=does-not-exist`, undefined, token);
    assert.equal(missing.status, 404);
  });
});
