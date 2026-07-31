// PR5 — Observability tests: enhanced gateway metrics (request-duration histogram,
// in-flight gauge) and Kubernetes liveness/readiness probes.

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
import { ReadinessModule } from '@jataqi/readiness';
import { OrganizationsModule } from '@jataqi/organizations';
import { NotificationsModule } from '@jataqi/notifications';
import { PolicyGovernanceModule } from '@jataqi/policy-governance';
import { DisasterRecoveryModule } from '@jataqi/disaster-recovery';
import { ApiGatewayModule } from '../src/index.js';
import type { GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

interface BootedGateway { kernel: Kernel; gateway: ApiGatewayModule; handle: GatewayHandle; base: string; }

async function boot(): Promise<BootedGateway> {
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
  kernel.register(new QiLModule());
  kernel.register(new SecurityModule({ bootstrapAdmin: { username: 'admin', password: 'admin' } }));
  kernel.register(new OrchestratorModule());
  kernel.register(new MetricsModule());
  kernel.register(new ReadinessModule());
  kernel.register(new OrganizationsModule());
  kernel.register(new NotificationsModule());
  kernel.register(new PolicyGovernanceModule());
  kernel.register(new DisasterRecoveryModule());
  const gateway = new ApiGatewayModule();
  kernel.register(gateway);
  await kernel.boot();
  const handle = await gateway.listen({ port: 0 });
  return { kernel, gateway, handle, base: `http://127.0.0.1:${handle.port}` };
}

async function req(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { status: res.status, body: parsed, text };
}

describe('observability — Kubernetes probes', () => {
  let gw: BootedGateway;
  before(async () => { gw = await boot(); });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('GET /livez returns 200 when booted', async () => {
    const r = await req('GET', `${gw.base}/livez`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, 'alive');
  });

  it('GET /readyz returns 200 with dependency checks', async () => {
    const r = await req('GET', `${gw.base}/readyz`);
    assert.equal(r.status, 200);
    const checks = (r.body as { status: string; checks: Record<string, boolean> }).checks;
    assert.equal(checks.booted, true);
    assert.equal(checks.storage, true);
    assert.equal(checks.security, true);
  });

  it('GET /readyz also works under the /v1 prefix', async () => {
    const r = await req('GET', `${gw.base}/v1/readyz`);
    assert.equal(r.status, 200);
  });
});

describe('observability — gateway metrics', () => {
  let gw: BootedGateway;
  before(async () => { gw = await boot(); });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('records request count, duration histogram, and in-flight gauge', async () => {
    // Register + login to get a token, then generate traffic.
    await req('POST', `${gw.base}/auth/register`, { username: 'obs', password: 'pw', roles: ['developer'] });
    const login = await req('POST', `${gw.base}/auth/login`, { username: 'obs', password: 'pw' });
    const token = (login.body as { token: string }).token;
    // Generate several requests (incl. a 404 and an authenticated call).
    await req('GET', `${gw.base}/health`);
    await req('GET', `${gw.base}/does-not-exist`);
    await req('GET', `${gw.base}/whoami`, undefined, token);

    const res = await fetch(`${gw.base}/metrics`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const text = await res.text();
    // Request counter with route labels.
    assert.ok(text.includes('jataqi_requests_total{'), 'request counter emitted');
    assert.ok(text.includes('path="/health"'), '/health recorded with a path label');
    assert.ok(text.includes('status="404"'), '404 recorded with a status label');
    // Request-duration histogram (buckets + _count + _sum).
    assert.ok(text.includes('# TYPE jataqi_request_duration_ms histogram'), 'duration histogram declared');
    assert.ok(text.includes('jataqi_request_duration_ms_bucket{le="+Inf"'), 'duration histogram emits a +Inf bucket');
    assert.ok(text.includes('jataqi_request_duration_ms_count'), 'duration histogram emits _count');
    assert.ok(text.includes('jataqi_request_duration_ms_sum'), 'duration histogram emits _sum');
    // In-flight gauge is declared even if currently 0.
    assert.ok(text.includes('# TYPE jataqi_requests_in_flight gauge'), 'in-flight gauge declared');
  });

  it('the in-flight gauge returns to 0 after requests complete', async () => {
    await req('GET', `${gw.base}/health`);
    await req('GET', `${gw.base}/health`);
    const mod = gw.kernel.getModule<MetricsModule>('metrics');
    // All requests are done (awaited) so in-flight must be 0.
    assert.equal(mod.requestsInFlight.get(), 0);
    // And at least one duration series was recorded (observations carry labels).
    assert.ok(mod.requestDuration.samples().length >= 1);
  });
});
