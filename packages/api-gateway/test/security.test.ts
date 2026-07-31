// PR6 — Security penetration tests. HTTP-level adversarial tests against the
// gateway: auth bypass, token forgery, RBAC escalation, tenant-isolation bypass,
// revoked-token reuse, oversized/malformed bodies, CORS origin spoofing, rate
// limiting, injection, and security headers. Validates the PR4 hardening holds.

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
import { ApiGatewayModule, type GatewayOptions, type GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

interface GW { kernel: Kernel; handle: GatewayHandle; base: string; }
async function boot(opts: GatewayOptions = {}): Promise<GW> {
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
  const gateway = new ApiGatewayModule(opts);
  kernel.register(gateway);
  await kernel.boot();
  const handle = await gateway.listen({ port: 0 });
  return { kernel, handle, base: `http://127.0.0.1:${handle.port}` };
}
async function req(method: string, url: string, body?: unknown, token?: string, headers: Record<string, string> = {}, rawBody?: string) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { status: res.status, body: parsed, headers: res.headers };
}

describe('security — authentication & authorization', () => {
  let gw: GW; let devToken: string; let guestToken: string;
  before(async () => {
    gw = await boot();
    await req('POST', `${gw.base}/auth/register`, { username: 'dev', password: 'pw', roles: ['developer'] });
    await req('POST', `${gw.base}/auth/register`, { username: 'guest', password: 'pw', roles: ['guest'] });
    devToken = ((await req('POST', `${gw.base}/auth/login`, { username: 'dev', password: 'pw' })).body as { token: string }).token;
    guestToken = ((await req('POST', `${gw.base}/auth/login`, { username: 'guest', password: 'pw' })).body as { token: string }).token;
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('rejects protected routes with no token (401)', async () => {
    assert.equal((await req('POST', `${gw.base}/qil`, { program: 'MISSION "x" { REPORT }' })).status, 401);
    assert.equal((await req('GET', `${gw.base}/audit`)).status, 401);
    assert.equal((await req('GET', `${gw.base}/whoami`)).status, 401);
  });

  it('rejects forged / garbage tokens (401)', async () => {
    assert.equal((await req('GET', `${gw.base}/whoami`, undefined, 'totally-fake-token')).status, 401);
    assert.equal((await req('GET', `${gw.base}/whoami`, undefined, '0'.repeat(64))).status, 401);
    assert.equal((await req('GET', `${gw.base}/whoami`, undefined, 'jqk_not_a_real_key')).status, 401);
    assert.equal((await req('GET', `${gw.base}/whoami`, undefined, '')).status, 401);
  });

  it('enforces RBAC: a guest is denied qil:run (403)', async () => {
    const r = await req('POST', `${gw.base}/qil`, { program: 'MISSION "x" { REPORT }' }, guestToken);
    assert.equal(r.status, 403);
    // Developer is allowed.
    assert.equal((await req('POST', `${gw.base}/qil`, { program: 'MISSION "x" { REPORT }' }, devToken)).status, 200);
  });

  it('enforces RBAC: developer lacks admin-only plugin:manage (403)', async () => {
    const r = await req('POST', `${gw.base}/plugins`, { id: 'x', action: 'disable' }, devToken);
    assert.equal(r.status, 403);
  });

  it('versioning does not weaken auth: /v1/qil without a token is 401', async () => {
    assert.equal((await req('POST', `${gw.base}/v1/qil`, { program: 'MISSION "x" { REPORT }' })).status, 401);
  });
});

describe('security — multi-tenant isolation bypass attempts', () => {
  let gw: GW; let alice: string; let bob: string; let aliceOrg: string; let bobOrg: string;
  before(async () => {
    gw = await boot();
    for (const u of ['alice', 'bob']) await req('POST', `${gw.base}/auth/register`, { username: u, password: 'pw', roles: ['developer'] });
    alice = ((await req('POST', `${gw.base}/auth/login`, { username: 'alice', password: 'pw' })).body as { token: string }).token;
    bob = ((await req('POST', `${gw.base}/auth/login`, { username: 'bob', password: 'pw' })).body as { token: string }).token;
    aliceOrg = ((await req('POST', `${gw.base}/orgs`, { name: 'Alice Inc' }, alice)).body as { organization: { id: string } }).organization.id;
    bobOrg = ((await req('POST', `${gw.base}/orgs`, { name: 'Bob Inc' }, bob)).body as { organization: { id: string } }).organization.id;
    await req('POST', `${gw.base}/org/data`, { orgId: bobOrg, action: 'set', id: 'secret', value: 'bob-only' }, bob);
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('Alice cannot read Bob\u2019s org data by guessing the orgId (403)', async () => {
    const r = await req('GET', `${gw.base}/org/data?orgId=${bobOrg}&id=secret`, undefined, alice);
    assert.equal(r.status, 403);
  });

  it('Alice cannot WRITE into Bob\u2019s org by spoofing orgId in the body (403)', async () => {
    const r = await req('POST', `${gw.base}/org/data`, { orgId: bobOrg, action: 'set', id: 'pwn', value: 'x' }, alice);
    assert.equal(r.status, 403);
    // Bob\u2019s secret is unchanged.
    const get = await req('GET', `${gw.base}/org/data?orgId=${bobOrg}&id=secret`, undefined, bob);
    assert.equal((get.body as { value: string }).value, 'bob-only');
  });

  it('Alice cannot list Bob\u2019s org keys (403)', async () => {
    assert.equal((await req('POST', `${gw.base}/org/data`, { orgId: bobOrg, action: 'list' }, alice)).status, 403);
  });

  it('a made-up orgId is rejected, not silently empty (403)', async () => {
    const r = await req('GET', `${gw.base}/org/data?orgId=does-not-exist&id=x`, undefined, alice);
    assert.equal(r.status, 403);
  });
});

describe('security — session, body & input validation', () => {
  let gw: GW; let token: string;
  before(async () => {
    gw = await boot();
    await req('POST', `${gw.base}/auth/register`, { username: 'sec', password: 'pw', roles: ['developer'] });
    token = ((await req('POST', `${gw.base}/auth/login`, { username: 'sec', password: 'pw' })).body as { token: string }).token;
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('a revoked token cannot be reused (401)', async () => {
    const r = await req('POST', `${gw.base}/auth/login`, { username: 'sec', password: 'pw' });
    const tok = (r.body as { token: string }).token;
    assert.equal((await req('GET', `${gw.base}/whoami`, undefined, tok)).status, 200);
    await req('POST', `${gw.base}/session/revoke`, { token: tok }, token);
    assert.equal((await req('GET', `${gw.base}/whoami`, undefined, tok)).status, 401);
  });

  it('rejects an oversized request body (413)', async () => {
    const big = { program: 'X'.repeat(2 * 1024 * 1024) }; // 2 MiB > 1 MiB default cap
    assert.equal((await req('POST', `${gw.base}/qil`, big, token)).status, 413);
  });

  it('rejects malformed JSON (400)', async () => {
    const res = await fetch(`${gw.base}/qil`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{not json' });
    assert.equal(res.status, 400);
  });

  it('safely stores a username with SQL/metacharacters (no injection, exact-match login)', async () => {
    const evil = `a'; DROP TABLE users;--`;
    await req('POST', `${gw.base}/auth/register`, { username: evil, password: 'pw', roles: ['developer'] });
    // Exact username logs in; a quote-escaped variant does not.
    assert.equal((await req('POST', `${gw.base}/auth/login`, { username: evil, password: 'pw' })).status, 200);
    assert.equal((await req('POST', `${gw.base}/auth/login`, { username: `a'; DROP TABLE users;-- `, password: 'pw' })).status, 401);
    // The users store is still intact.
    assert.equal((await req('POST', `${gw.base}/auth/login`, { username: 'sec', password: 'pw' })).status, 200);
  });
});

describe('security — CORS, headers & rate limiting', () => {
  it('reflects only allowed CORS origins (spoofing blocked)', async () => {
    const gw = await boot({ cors: { origins: ['https://trusted.example.com'], credentials: true } });
    try {
      const ok = await req('GET', `${gw.base}/health`, undefined, undefined, { origin: 'https://trusted.example.com' });
      assert.equal(ok.headers.get('access-control-allow-origin'), 'https://trusted.example.com');
      const bad = await req('GET', `${gw.base}/health`, undefined, undefined, { origin: 'https://evil.example.com' });
      assert.equal(bad.headers.get('access-control-allow-origin'), null);
    } finally { await gw.handle.close(); await gw.kernel.shutdown(); }
  });

  it('emits standard security headers on every response', async () => {
    const gw = await boot();
    try {
      const r = await req('GET', `${gw.base}/health`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      // No HSTS over plain HTTP.
      assert.equal(r.headers.get('strict-transport-security'), null);
    } finally { await gw.handle.close(); await gw.kernel.shutdown(); }
  });

  it('rate-limits excessive requests from one key (429)', async () => {
    const gw = await boot({ rateLimit: { limit: 20, windowMs: 60_000 } });
    try {
      const statuses: number[] = [];
      // Fire many requests with the same key (no token => keyed by IP).
      for (let i = 0; i < 60; i++) {
        statuses.push((await req('GET', `${gw.base}/health`)).status);
      }
      assert.ok(statuses.includes(429), 'expected at least one 429 under rate limiting');
      assert.ok(statuses.filter((s) => s === 200).length <= 20, 'should not exceed the limit in 200s');
    } finally { await gw.handle.close(); await gw.kernel.shutdown(); }
  });
});
