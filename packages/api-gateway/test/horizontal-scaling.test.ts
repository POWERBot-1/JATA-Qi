// PR5 — Horizontal scaling test: proves the gateway is horizontally scalable by
// showing that two independent instances, backed by the SAME durable storage,
// share authentication state. A session created on instance A is valid on
// instance B (and vice-versa), because sessions (PR4) and users/org data are
// persisted to the shared storage layer rather than held in process memory.

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
import { ReadinessModule } from '@jataqi/readiness';
import { OrganizationsModule } from '@jataqi/organizations';
import { NotificationsModule } from '@jataqi/notifications';
import { PolicyGovernanceModule } from '@jataqi/policy-governance';
import { DisasterRecoveryModule } from '@jataqi/disaster-recovery';
import { ApiGatewayModule } from '../src/index.js';
import type { GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

interface Instance { kernel: Kernel; gateway: ApiGatewayModule; handle: GatewayHandle; base: string; }

/** Boot a gateway instance backed by a SHARED SQLite database (WAL mode enables
 * live, concurrent shared reads/writes across instances — the production
 * horizontal-scaling topology). */
async function bootInstance(dbPath: string): Promise<Instance> {
  const kernel = createTestKernel();
  kernel.register(new StorageModule({ driver: 'sqlite', fsRoot: dbPath }));
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
  kernel.register(new QiLModule());
  kernel.register(new SecurityModule());
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
  return { status: res.status, body: parsed };
}

describe('horizontal scaling — shared-state across instances', () => {
  let tmpDir: string;
  let a: Instance;
  let b: Instance;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jataqi-hpa-'));
    const dbPath = path.join(tmpDir, 'jataqi.db');
    a = await bootInstance(dbPath);
    b = await bootInstance(dbPath);
  });
  after(async () => {
    await a.handle.close(); await a.kernel.shutdown();
    await b.handle.close(); await b.kernel.shutdown();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('registers a user on instance A', async () => {
    const r = await req('POST', `${a.base}/auth/register`, { username: 'scale', password: 'pw', roles: ['developer'] });
    assert.equal(r.status, 201);
  });

  it('logs in on instance A, obtaining a token', async () => {
    const r = await req('POST', `${a.base}/auth/login`, { username: 'scale', password: 'pw' });
    assert.equal(r.status, 200);
    assert.ok((r.body as { token: string }).token);
  });

  it('a token issued by A is authenticated by instance B (shared session store)', async () => {
    const login = await req('POST', `${a.base}/auth/login`, { username: 'scale', password: 'pw' });
    const token = (login.body as { token: string }).token;
    // Instance B has never seen this token in memory — it must resolve it from
    // the shared persisted session store.
    const whoami = await req('GET', `${b.base}/whoami`, undefined, token);
    assert.equal(whoami.status, 200);
    assert.equal((whoami.body as { principal: { username: string } }).principal.username, 'scale');
  });

  it('an API key created on A authorizes a request on B', async () => {
    const login = await req('POST', `${a.base}/auth/login`, { username: 'scale', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const key = await req('POST', `${a.base}/auth/apikey`, { name: 'ci' }, token);
    const secret = (key.body as { secret: string }).secret;
    // Use the API key on instance B.
    const res = await fetch(`${b.base}/whoami`, { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { principal: { username: string } };
    assert.equal(body.principal.username, 'scale');
  });

  it('org tenant data written on A is visible on B (shared tenant storage)', async () => {
    const login = await req('POST', `${a.base}/auth/login`, { username: 'scale', password: 'pw' });
    const token = (login.body as { token: string }).token;
    const org = await req('POST', `${a.base}/orgs`, { name: 'Scaled' }, token);
    const orgId = (org.body as { organization: { id: string } }).organization.id;
    await req('POST', `${a.base}/org/data`, { orgId, action: 'set', id: 'k', value: 'shared' }, token);
    // Read it back from instance B.
    const read = await req('GET', `${b.base}/org/data?orgId=${orgId}&id=k`, undefined, token);
    assert.equal(read.status, 200);
    assert.equal((read.body as { value: string }).value, 'shared');
  });

  it('revoking a session on A invalidates it on B', async () => {
    const login = await req('POST', `${a.base}/auth/login`, { username: 'scale', password: 'pw' });
    const token = (login.body as { token: string }).token;
    // Confirm it works on B first.
    assert.equal((await req('GET', `${b.base}/whoami`, undefined, token)).status, 200);
    // Revoke on A.
    await req('POST', `${a.base}/session/revoke`, { token }, token);
    // Now B must reject it (shared session store reflects the deletion).
    assert.equal((await req('GET', `${b.base}/whoami`, undefined, token)).status, 401);
  });

  it('both instances report ready (readiness probe) for a load balancer', async () => {
    assert.equal((await req('GET', `${a.base}/readyz`)).status, 200);
    assert.equal((await req('GET', `${b.base}/readyz`)).status, 200);
  });
});
