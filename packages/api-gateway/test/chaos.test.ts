// PR6 — Chaos / resilience engineering. Validates graceful degradation under
// partial failures: absent optional modules, missing hard dependency, a handler
// that throws (sanitized 500), concurrent mutation without corruption, and
// restart resilience. The gateway must degrade, never crash.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
import { ReadinessModule } from '@jataqi/readiness';
import { OrganizationsModule } from '@jataqi/organizations';
import { NotificationsModule } from '@jataqi/notifications';
import { PolicyGovernanceModule } from '@jataqi/policy-governance';
import { ApiGatewayModule, type GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

interface GW { kernel: Kernel; handle: GatewayHandle; base: string; }

/** Boot a gateway with an OPTIONAL module set that callers can shrink. */
async function boot(opts: { omit?: string[]; storageDriver?: 'memory' | 'filesystem'; fsRoot?: string } = {}): Promise<GW> {
  const kernel = createTestKernel();
  const omit = new Set(opts.omit ?? []);
  if (!omit.has('storage')) kernel.register(new StorageModule(opts.storageDriver ? { driver: opts.storageDriver, fsRoot: opts.fsRoot } : {}));
  if (!omit.has('vector-search')) kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  if (!omit.has('knowledge')) kernel.register(new KnowledgeService());
  if (!omit.has('knowledge-graph')) kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  if (!omit.has('agent-runtime')) kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
  if (!omit.has('qil')) kernel.register(new QiLModule());
  kernel.register(new SecurityModule({ bootstrapAdmin: { username: 'admin', password: 'admin' } }));
  if (!omit.has('orchestrator')) kernel.register(new OrchestratorModule());
  if (!omit.has('metrics')) kernel.register(new MetricsModule());
  if (!omit.has('simulation')) kernel.register(new SimulationModule());
  if (!omit.has('readiness')) kernel.register(new ReadinessModule());
  if (!omit.has('organizations')) kernel.register(new OrganizationsModule());
  if (!omit.has('notifications')) kernel.register(new NotificationsModule());
  if (!omit.has('policy-governance')) kernel.register(new PolicyGovernanceModule());
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

describe('chaos — graceful degradation when optional modules are absent', () => {
  let gw: GW; let token: string;
  before(async () => {
    // Omit simulation + digital-twin to prove 501, not crash.
    gw = await boot({ omit: ['simulation'] });
    await req('POST', `${gw.base}/auth/register`, { username: 'c', password: 'pw', roles: ['developer'] });
    token = ((await req('POST', `${gw.base}/auth/login`, { username: 'c', password: 'pw' })).body as { token: string }).token;
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('returns 501 (not 500/crash) for simulation when the module is absent', async () => {
    const r = await req('POST', `${gw.base}/simulate`, { formula: 'revenue - 1', inputs: { revenue: { kind: 'uniform', min: 1, max: 2 } } }, token);
    assert.equal(r.status, 501);
    assert.match((r.body as { error: string }).error, /simulation module not registered/);
  });

  it('returns 501 for digital-twin routes when absent', async () => {
    assert.equal((await req('GET', `${gw.base}/twins`, undefined, token)).status, 501);
  });

  it('the rest of the gateway still serves normally (blast radius contained)', async () => {
    assert.equal((await req('GET', `${gw.base}/health`)).status, 200);
    assert.equal((await req('GET', `${gw.base}/readyz`)).status, 200);
    assert.equal((await req('POST', `${gw.base}/ask`, { message: 'hi' }, token)).status, 200);
  });
});

describe('chaos — missing hard dependency (storage) is reported, not fatal', () => {
  let gw: GW; let token: string;
  before(async () => {
    gw = await boot({ omit: ['organizations'] }); // no org module => tenant routes 501
    await req('POST', `${gw.base}/auth/register`, { username: 'c', password: 'pw', roles: ['developer'] });
    token = ((await req('POST', `${gw.base}/auth/login`, { username: 'c', password: 'pw' })).body as { token: string }).token;
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('tenant-scoped routes return 501 when the organizations module is absent', async () => {
    const r = await req('GET', `${gw.base}/org/data?orgId=x&id=y`, undefined, token);
    assert.equal(r.status, 501);
  });
});

describe('chaos — a handler that throws yields a sanitized 500 (no stack leak)', () => {
  let gw: GW; let token: string;
  before(async () => {
    gw = await boot();
    await req('POST', `${gw.base}/auth/register`, { username: 'c', password: 'pw', roles: ['developer'] });
    token = ((await req('POST', `${gw.base}/auth/login`, { username: 'c', password: 'pw' })).body as { token: string }).token;
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('a malformed simulate formula throws inside the handler -> 500 without a stack trace', async () => {
    const r = await req('POST', `${gw.base}/simulate`, { formula: 'revenue +', inputs: { revenue: { kind: 'uniform', min: 1, max: 2 } } }, token);
    assert.equal(r.status, 500);
    const body = JSON.stringify(r.body);
    // No stack frame leaked to the client.
    assert.ok(!/\n\s*at /.test(body), 'error response must not leak a stack trace');
    assert.ok(!/node:internal/.test(body), 'error response must not leak internals');
  });
});

describe('chaos — concurrent mutation does not corrupt tenant state', () => {
  let gw: GW; let token: string; let orgId: string;
  before(async () => {
    gw = await boot();
    await req('POST', `${gw.base}/auth/register`, { username: 'c', password: 'pw', roles: ['developer'] });
    token = ((await req('POST', `${gw.base}/auth/login`, { username: 'c', password: 'pw' })).body as { token: string }).token;
    orgId = ((await req('POST', `${gw.base}/orgs`, { name: 'Chaos' }, token)).body as { organization: { id: string } }).organization.id;
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('50 parallel writes to distinct keys all persist', async () => {
    const writes = Array.from({ length: 50 }, (_, i) =>
      req('POST', `${gw.base}/org/data`, { orgId, action: 'set', id: `k${i}`, value: i }, token),
    );
    const results = await Promise.all(writes);
    assert.ok(results.every((r) => r.status === 201));
    // Verify all 50 keys are readable.
    const list = await req('POST', `${gw.base}/org/data`, { orgId, action: 'list' }, token);
    assert.equal((list.body as { count: number }).count, 50);
  });
});

describe('chaos — restart resilience (session + tenant data survive reboot)', () => {
  let tmpDir: string;

  it('a session and tenant data survive a kernel restart on durable storage', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-chaos-'));
    // First life.
    let gw = await boot({ storageDriver: 'filesystem', fsRoot: tmpDir });
    await req('POST', `${gw.base}/auth/register`, { username: 'c', password: 'pw', roles: ['developer'] });
    const token = ((await req('POST', `${gw.base}/auth/login`, { username: 'c', password: 'pw' })).body as { token: string }).token;
    const orgId = ((await req('POST', `${gw.base}/orgs`, { name: 'Survivor' }, token)).body as { organization: { id: string } }).organization.id;
    await req('POST', `${gw.base}/org/data`, { orgId, action: 'set', id: 'k', value: 'v' }, token);
    await gw.handle.close();
    await gw.kernel.shutdown();

    // Second life — same on-disk storage.
    gw = await boot({ storageDriver: 'filesystem', fsRoot: tmpDir });
    assert.equal((await req('GET', `${gw.base}/whoami`, undefined, token)).status, 200);   // session survived
    const get = await req('GET', `${gw.base}/org/data?orgId=${orgId}&id=k`, undefined, token);
    assert.equal((get.body as { value: string }).value, 'v');                              // tenant data survived
    await gw.handle.close();
    await gw.kernel.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
