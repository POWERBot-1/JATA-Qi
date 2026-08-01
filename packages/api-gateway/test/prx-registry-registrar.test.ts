// PRX gateway integration tests — Registry (Part A) + Registrar (Part B).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, EchoLLM } from '@jataqi/agent-runtime';
import { QiLModule } from '@jataqi/qil';
import { SecurityModule } from '@jataqi/security';
import { OrchestratorModule } from '@jataqi/orchestrator';
import { MetricsModule } from '@jataqi/metrics';
import { RegistryModule } from '@jataqi/registry';
import { RegistrarModule } from '@jataqi/registrar';
import { ApiGatewayModule, type GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

interface GW { kernel: Kernel; handle: GatewayHandle; base: string }

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
  kernel.register(new RegistryModule({ serve: false }));
  kernel.register(new RegistrarModule());
  const gateway = new ApiGatewayModule();
  kernel.register(gateway);
  await kernel.boot();
  const handle = await gateway.listen({ port: 0 });
  return { kernel, handle, base: `http://127.0.0.1:${handle.port}` };
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
  return { status: res.status, body: parsed };
}

describe('PRX — registry + registrar gateway endpoints', () => {
  let gw: GW;
  let adminToken: string;

  before(async () => {
    gw = await boot();
    const login = await req('POST', `${gw.base}/auth/login`, { username: 'admin', password: 'admin' });
    adminToken = (login.body as { token: string }).token;
    // Provision a TLD + an accredited registrar (admin-gated).
    await req('POST', `${gw.base}/registry/tld`, { tld: '.jq' }, adminToken);
    await req('POST', `${gw.base}/registry/registrar`, { tld: '.jq', id: 'reg-1', name: 'Registrar 1', password: 'pw' }, adminToken);
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('lists the provisioned TLD', async () => {
    const r = await req('GET', `${gw.base}/registry/tlds`, undefined, adminToken);
    assert.equal(r.status, 200);
    assert.ok((r.body as { tlds: string[] }).tlds.includes('.jq'));
  });

  it('lists the mirrored registrar', async () => {
    const r = await req('GET', `${gw.base}/registrar/list`, undefined, adminToken);
    assert.ok((r.body as { registrars: { id: string }[] }).registrars.some((x) => x.id === 'reg-1'));
  });

  it('searches availability through the registrar', async () => {
    const r = await req('POST', `${gw.base}/registrar/search`, { registrarId: 'reg-1', names: ['mybrand.jq', 'taken.jq'] }, adminToken);
    assert.equal(r.status, 200);
    const results = (r.body as { results: { name: string; available: boolean }[] }).results;
    assert.ok(results[0]!.available);
  });

  it('registers a domain end-to-end', async () => {
    const r = await req('POST', `${gw.base}/registrar/register`, { registrarId: 'reg-1', name: 'mybrand.jq', periodYears: 2 }, adminToken);
    assert.equal(r.status, 201);
    assert.equal((r.body as { order: { status: string } }).order.status, 'completed');
  });

  it('RDAP returns the registered domain', async () => {
    const r = await req('GET', `${gw.base}/registry/rdap?name=mybrand.jq`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { ldhName: string }).ldhName, 'mybrand.jq');
  });

  it('RDAP reports 404 for an unknown name', async () => {
    const r = await req('GET', `${gw.base}/registry/rdap?name=nope.jq`);
    assert.equal(r.status, 404);
  });

  it('builds a signed escrow deposit', async () => {
    const r = await req('POST', `${gw.base}/registry/escrow`, { tld: '.jq' }, adminToken);
    assert.equal(r.status, 200);
    assert.equal((r.body as { deposit: { contentsHash: string } }).deposit.contentsHash.length, 64);
  });

  it('reports registry counts', async () => {
    const r = await req('GET', `${gw.base}/registry/report`, undefined, adminToken);
    assert.equal(r.status, 200);
    assert.ok((r.body as { report: { domains: number }[] }).report[0]!.domains >= 1);
  });

  it('renews a registered domain', async () => {
    const r = await req('POST', `${gw.base}/registrar/renew`, { registrarId: 'reg-1', name: 'mybrand.jq', registrantId: 'x', periodYears: 1 }, adminToken);
    assert.equal(r.status, 200);
  });
});
