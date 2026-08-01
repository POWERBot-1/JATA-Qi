// PRX gateway integration tests — accreditation (Part L) + DNS (Part D) endpoints.

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
import { AccreditationModule } from '@jataqi/accreditation';
import { DnsModule } from '@jataqi/dns';
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
  kernel.register(new AccreditationModule({ mode: 'DEVELOPMENT' }));
  kernel.register(new DnsModule({ serve: false }));
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

describe('PRX — accreditation + DNS gateway endpoints', () => {
  let gw: GW;
  let adminToken: string;

  before(async () => {
    gw = await boot();
    const login = await req('POST', `${gw.base}/auth/login`, { username: 'admin', password: 'admin' });
    adminToken = (login.body as { token: string }).token;
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  // --- accreditation (Part L) ---

  it('GET /accreditation/status reports DEVELOPMENT mode and honest false claims', async () => {
    const r = await req('GET', `${gw.base}/accreditation/status`);
    assert.equal(r.status, 200);
    const b = r.body as { mode: string; claims: Record<string, boolean>; ledgerIntact: boolean };
    assert.equal(b.mode, 'DEVELOPMENT');
    assert.equal(b.claims.accreditedRegistry, false);
    assert.equal(b.claims.publicCertificateAuthority, false);
    assert.equal(b.ledgerIntact, true);
  });

  it('GET /accreditation/domains lists the service classes', async () => {
    const r = await req('GET', `${gw.base}/accreditation/domains`);
    const b = r.body as { domains: { id: string }[] };
    const ids = b.domains.map((d) => d.id);
    assert.ok(ids.includes('tld-registry'));
    assert.ok(ids.includes('ca-root'));
  });

  it('GET /accreditation/verify-claim denies an unaccredited claim', async () => {
    const r = await req('GET', `${gw.base}/accreditation/verify-claim?claim=JATA%20Qi%20is%20an%20accredited%20registrar`);
    const b = r.body as { honest: boolean };
    assert.equal(b.honest, false);
  });

  it('POST /accreditation/mode transitions to ACCREDITED_PRODUCTION (admin)', async () => {
    const r = await req('POST', `${gw.base}/accreditation/mode`, { mode: 'PRIVATE_INFRASTRUCTURE' }, adminToken);
    assert.equal(r.status, 200);
    assert.equal((r.body as { mode: string }).mode, 'PRIVATE_INFRASTRUCTURE');
  });

  it('records a grant, activates it, then the gate backs a claim', async () => {
    await req('POST', `${gw.base}/accreditation/mode`, { mode: 'ACCREDITED_PRODUCTION' }, adminToken);
    const g = await req('POST', `${gw.base}/accreditation/grant`, {
      domain: 'tld-registry', issuedBy: 'ICANN', scope: '.jq',
      validFrom: Date.now() - 1000, validUntil: Date.now() + 1e9, evidence: ['ICANN-RA-001'],
    }, adminToken);
    assert.equal(g.status, 201);
    const grant = (g.body as { grant: { id: string } }).grant;
    const act = await req('POST', `${gw.base}/accreditation/grant/status`, { id: grant.id, status: 'ACTIVE' }, adminToken);
    assert.equal(act.status, 200);
    // Now the registry claim should be honest.
    const claim = await req('GET', `${gw.base}/accreditation/verify-claim?claim=JATA%20Qi%20is%20an%20accredited%20registry%20operator`);
    assert.equal((claim.body as { honest: boolean }).honest, true);
  });

  it('GET /accreditation/ledger returns a verifiable chain', async () => {
    const r = await req('GET', `${gw.base}/accreditation/ledger`, undefined, adminToken);
    const b = r.body as { entries: unknown[]; intact: boolean };
    assert.ok(b.entries.length > 0);
    assert.equal(b.intact, true);
  });

  // --- DNS (Part D) ---

  it('POST /dns/zone creates a zone', async () => {
    const r = await req('POST', `${gw.base}/dns/zone`, { origin: 'example.com.' }, adminToken);
    assert.equal(r.status, 201);
    assert.equal((r.body as { origin: string }).origin, 'example.com.');
  });

  it('POST /dns/records adds records and bumps the serial', async () => {
    const r = await req('POST', `${gw.base}/dns/records`, {
      origin: 'example.com.',
      records: [{ name: 'www.example.com.', type: 1, ttl: 300, data: { type: 'A', address: '192.0.2.10' } }],
    }, adminToken);
    assert.equal(r.status, 200);
    assert.ok((r.body as { serial: number }).serial >= 1);
  });

  it('GET /dns/resolve answers from the authoritative store', async () => {
    const r = await req('GET', `${gw.base}/dns/resolve?name=www.example.com.&type=A`, undefined, adminToken);
    assert.equal(r.status, 200);
    const b = r.body as { source: string; answers: { data: { address: string } }[] };
    assert.equal(b.source, 'authoritative');
    assert.equal(b.answers[0]!.data.address, '192.0.2.10');
  });

  it('POST /dns/sign signs a zone and returns the DS', async () => {
    const r = await req('POST', `${gw.base}/dns/sign`, { origin: 'example.com.' }, adminToken);
    assert.equal(r.status, 200);
    const b = r.body as { ds: { data: { digest: string } } };
    assert.equal(b.ds.data.digest.length, 64);
  });

  it('GET /dns/rdap returns active RDAP for a known name', async () => {
    const r = await req('GET', `${gw.base}/dns/rdap?name=www.example.com.`);
    assert.equal(r.status, 200);
    const b = r.body as { status: string[] };
    assert.ok(b.status.includes('active'));
  });

  it('GET /dns/rdap returns 404 for an unknown zone', async () => {
    const r = await req('GET', `${gw.base}/dns/rdap?name=nothing.test.`);
    assert.equal(r.status, 404);
  });

  it('GET /dns/zones lists the managed zones', async () => {
    const r = await req('GET', `${gw.base}/dns/zones`, undefined, adminToken);
    assert.equal(r.status, 200);
    const b = r.body as { zones: { origin: string }[] };
    assert.ok(b.zones.some((z) => z.origin === 'example.com.'));
  });
});
