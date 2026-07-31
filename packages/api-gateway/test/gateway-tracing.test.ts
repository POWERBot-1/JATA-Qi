// PR9 — gateway distributed-tracing integration: the gateway records an OTel
// server span per request (http attributes + status), and honors an incoming
// W3C traceparent as the parent context.

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
import { TracingModule } from '@jataqi/tracing';
import { ApiGatewayModule, type GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

interface GW { kernel: Kernel; handle: GatewayHandle; base: string; tracing: TracingModule }
async function boot(): Promise<GW> {
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
  const tracing = new TracingModule({ exporter: 'memory', sampler: 'always_on', serviceName: 'gateway-test' });
  kernel.register(tracing);
  const gateway = new ApiGatewayModule();
  kernel.register(gateway);
  await kernel.boot();
  const handle = await gateway.listen({ port: 0 });
  return { kernel, handle, base: `http://127.0.0.1:${handle.port}`, tracing };
}

describe('gateway — OpenTelemetry tracing (PR9)', () => {
  let gw: GW;
  before(async () => { gw = await boot(); });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('records a server span per request with http attributes + status', async () => {
    await (await fetch(`${gw.base}/health`)).text();
    await (await fetch(`${gw.base}/does-not-exist`)).text();
    await gw.tracing.provider.forceFlush();
    const spans = gw.tracing.getFinishedSpans();
    const health = spans.find((s) => s.name === 'HTTP GET /health');
    assert.ok(health, 'server span recorded for /health');
    assert.equal(health!.kind, 'server');
    assert.equal(health!.attributes['http.method'], 'GET');
    assert.equal(health!.attributes['http.route'], '/health');
    assert.equal(health!.attributes['http.status_code'], 200);
    assert.equal(health!.status.code, 'ok');
    assert.equal(health!.resource['service.name'], 'gateway-test');

    const notFound = spans.find((s) => s.name === 'HTTP GET /does-not-exist');
    assert.ok(notFound);
    assert.equal(notFound!.attributes['http.status_code'], 404);
    assert.equal(notFound!.status.code, 'ok'); // 4xx is not an error span
  });

  it('honors an incoming W3C traceparent (child span inherits the trace)', async () => {
    const incomingTraceId = '0af7651916cd43dd8448eb211c80319c';
    const incomingSpanId = '0000000000000abc';
    await (await fetch(`${gw.base}/whoami`, { headers: { traceparent: `00-${incomingTraceId}-${incomingSpanId}-01` } })).text();
    await gw.tracing.provider.forceFlush();
    const span = gw.tracing.getFinishedSpans().reverse().find((s) => s.name === 'HTTP GET /whoami');
    assert.ok(span);
    assert.equal(span!.context.traceId, incomingTraceId); // inherited the caller's trace
    assert.equal(span!.parentSpanId, incomingSpanId);     // linked to the caller's span
    assert.notEqual(span!.context.spanId, incomingSpanId);
  });

  it('does not break the request when tracing is absent (backward compatible)', async () => {
    // A second gateway with NO TracingModule still serves normally.
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
    kernel.register(new QiLModule());
    kernel.register(new SecurityModule());
    kernel.register(new OrchestratorModule());
    kernel.register(new ApiGatewayModule());
    await kernel.boot();
    const gw2 = kernel.getModule<ApiGatewayModule>('api-gateway');
    const h = await gw2.listen({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${h.port}/health`);
    assert.equal(res.status, 200);
    await h.close();
    await kernel.shutdown();
  });
});
