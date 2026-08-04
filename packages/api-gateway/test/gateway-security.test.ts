// API gateway security-hardening tests (PR4): TLS/HTTPS, CORS, API versioning,
// secure headers, multi-tenant data isolation, and session management endpoints.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as https from 'node:https';

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

// Long-lived (until 2036) self-signed certificate + key for CN=localhost.
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUBLYXAi8fiiLrxu+vDIBAvZboBDAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDczMDIwNTE0MloXDTM2MDcy
NzIwNTE0MlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAsaQ2g+xB4A3QjWxiTJ7GxwTgfBW2h8JQATfVEGBHF5Jj
QUKOLXJH8NXDhNznGk3/PBkFnjCurpVa2yCIxFYvigUco+8kcNNsMpIwLK5n1T/H
9ZnHqHfAH3nyIK+lGQ2tOw2GSnoGClbV7m6yI43GphBOoCbZ9gwJBxnKtJiiFbmv
2tYrhNTdPx9v9PduZx9jZKQ0TThytHIQlVcL4/PpkvK1VWI31ByI7Wcw6RZ/wQ1M
TGCpKUnIoSXFbERh6jcMG4bLL+3C+ebroCp36SJUD2EUv/PXZybpIJpIpFpTS15a
iqGC35li9z9DaYpahfUaEaTTJ4Jig4kv3VZcaUvGWwIDAQABo28wbTAdBgNVHQ4E
FgQUap5ExRLlWlvRKfAXtkIna2kowogwHwYDVR0jBBgwFoAUap5ExRLlWlvRKfAX
tkIna2kowogwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAIwx4G3EPOv+SWEUIZl/gr0panKE+CKU
hAvJIY/0qNcDZkKTQ1La4oU5h0JON8HUPQj87QK6nujf+buRgHphNAM9tAs30EnT
XieOxrpqyhlFr92CNszgyj7L6hYc2uH+91gZqz2EjY+c2biKxPEMKA1u+xj5ZiJl
nLyOglzcKOHn/xMaO72T2Ox2+W1j5e8R9iaH6P4iRsR+hdNzJtqq10N9kHOuXDXh
zEJlW4wkuSlrNq0qGvT5yPCJgshaGOSr9Sny9YP9AFoRbLnzP5QXYvn0XgdgMG94
nwAzxAE7eYRzwQC0qYDGOCaAk39klAxZibKYYZRvDaAxjMhUpzL5Fb4=
-----END CERTIFICATE-----`;
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCxpDaD7EHgDdCN
bGJMnsbHBOB8FbaHwlABN9UQYEcXkmNBQo4tckfw1cOE3OcaTf88GQWeMK6ulVrb
IIjEVi+KBRyj7yRw02wykjAsrmfVP8f1mceod8AfefIgr6UZDa07DYZKegYKVtXu
brIjjcamEE6gJtn2DAkHGcq0mKIVua/a1iuE1N0/H2/0925nH2NkpDRNOHK0chCV
Vwvj8+mS8rVVYjfUHIjtZzDpFn/BDUxMYKkpScihJcVsRGHqNwwbhssv7cL55uug
KnfpIlQPYRS/89dnJukgmkikWlNLXlqKoYLfmWL3P0NpilqF9RoRpNMngmKDiS/d
VlxpS8ZbAgMBAAECggEARESZdsV644Irnc4DUPLL7XwgUU9+4Fl6qZ0tUqfNam+l
mVTckvaSUymzhAHpBqDm78+l6w9Gcm2PhxrPtLRyfJZOVWn4FSwLLrwjq2gzGy7x
x58brdCnkvEobgtSZXhuFH20GDcgzyRj/senyiYYK4Wk0cNcjEQ/y+zLi/AEilg3
jlYctxGYhvwoD57xt4j7dlbVz/217Xgiy+4ZeLZ9XHdLa6tadpauo7fK1fTxHu5b
xzYOmwWtE1/zndV045I5Yd0C9m5WulbqMqhNjIU1iXzm08Ymw15UIfG4E+N7WM31
MPAAn+oy4KIQWWnZCcih/6j3ix3LDfDsF/IJZbqY8QKBgQDoMJdNqwMPNTta74C9
ei1tiLnDjhDOTXps7nfIek849E2Ro/Ycc+C/195y+ySL1J0/9B72jZEf8sUZEzHg
YrvcmHsoeorLf6dgGmZaC4SfuS1x6V0geG/guAADkwQg6B7IofKrkz92eekwFvGR
AtXFjs/WtqeL3l9JGesM0+CdHwKBgQDD26CjISExVrTT1Exp/mFPqHXvThyLJFQ7
6d3Yra8eKWHVAs+NyWciXSsU6zP4PAzlzkl8R2UQ6pS5n/KfhiYEzOAfp5xdA0SF
JMXC3aYj6gcnUFkXuPmYIU+pvVz0KJD3YYZ4+UJgAmtEtN0wVrpMZZwYERfDEj99
fgP3VsPzRQKBgQCTfXo/DehtmqTPiN/AfIGq2HUX8YBfa/vegkR4hqkYRqeXYg2N
2VXkxx048KswX6hb3ZhliVusbawh132RSWaIJBvnhJ/x0G7jryFhBXwDcb+aYmCT
pa17k6X+nz66IHidfbIGpwxjF+G2eHyOXryoN6VygKhBQspIRzx184j0hQKBgF3Z
IGjqWAhXPsB96rujS6eq1g/8AstddgtbbZUE7HNsatdxyFhtWEDsGdelODrLM3bu
WOH3J+NqNCeaD90Gn7MPJJmma9NZ3Hxb+XL9WD2/Rvw8kORAG0EdPRndhevsgEI5
dgEDlx2AKzw52f7un8g5rAkQL62mUcvlFStwZOZtAoGBANlft14954ABrX4s2dXU
3IIq30E4C8b2yAOwIijLs24nS5S9vHSiLZCzHaSb4KHgRFdGqsxUaWIBJXlZJGFi
JP1z2y1QeCUiYpehJG6N8/nNfdY2fXLvAQYB8HzvHJZmJqjcGsGPidiLvCrGnUCC
JI6JW3rUDvSFz2nkITAfY6Ph
-----END PRIVATE KEY-----`;

interface BootedGateway {
  kernel: Kernel;
  gateway: ApiGatewayModule;
  handle: GatewayHandle;
  base: string;
}

/** Boot a gateway with the given options + the modules needed for these tests. */
async function bootGateway(opts: GatewayOptions = {}): Promise<BootedGateway> {
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
  const proto = handle.secure ? 'https' : 'http';
  return { kernel, gateway, handle, base: `${proto}://127.0.0.1:${handle.port}` };
}

async function req(method: string, url: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** HTTPS GET that accepts the self-signed test certificate (TLS tests only). */
interface TlsResponse { status: number; headers: Record<string, string | string[] | undefined>; body: unknown; }
function tlsGet(url: string): Promise<TlsResponse> {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const r = https.request(url, { method: 'GET', agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = undefined;
        if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
        resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string | string[] | undefined>, body: parsed });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// ---------------------------------------------------------------------------

describe('API versioning (/v1)', () => {
  let gw: BootedGateway;
  before(async () => { gw = await bootGateway(); });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('serves a route under the /v1 prefix', async () => {
    const r = await req('GET', `${gw.base}/v1/health`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, 'healthy');
    assert.equal((r.body as { apiVersion: string }).apiVersion, 'v1');
  });

  it('keeps the legacy (un-prefixed) route working (backward compatibility)', async () => {
    const r = await req('GET', `${gw.base}/health`);
    assert.equal(r.status, 200);
  });

  it('resolves /v1 to the root index', async () => {
    const r = await req('GET', `${gw.base}/v1`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { versionedBase: string }).versionedBase, '/v1');
    assert.ok(Array.isArray((r.body as { versions: string[] }).versions) && (r.body as { versions: string[] }).versions.includes('v1'));
  });

  it('authenticates under /v1/auth/login', async () => {
    const reg = await req('POST', `${gw.base}/v1/auth/register`, { username: 'v1user', password: 'pw', roles: ['developer'] });
    assert.equal(reg.status, 201);
    const login = await req('POST', `${gw.base}/v1/auth/login`, { username: 'v1user', password: 'pw' });
    assert.equal(login.status, 200);
    assert.ok((login.body as { token: string }).token);
  });

  it('returns 404 for an unknown versioned path', async () => {
    const r = await req('GET', `${gw.base}/v1/does-not-exist`);
    assert.equal(r.status, 404);
  });
});

describe('CORS policy', () => {
  let gw: BootedGateway;
  before(async () => {
    gw = await bootGateway({ cors: { origins: ['https://app.example.com', 'https://admin.example.com'], credentials: true, methods: ['GET', 'POST'] } });
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('reflects an allowed origin on real responses', async () => {
    const r = await req('GET', `${gw.base}/health`, undefined, undefined, { origin: 'https://app.example.com' });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
    assert.match(r.headers.get('vary') ?? '', /origin/);
  });

  it('omits CORS headers for a disallowed origin', async () => {
    const r = await req('GET', `${gw.base}/health`, undefined, undefined, { origin: 'https://evil.example.com' });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });

  it('answers an OPTIONS preflight for an allowed origin with 204', async () => {
    const res = await fetch(`${gw.base}/qil`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.ok((res.headers.get('access-control-allow-methods') ?? '').includes('POST'));
    assert.ok(res.headers.has('access-control-max-age'));
  });

  it('does not answer preflight for a disallowed origin', async () => {
    const res = await fetch(`${gw.base}/qil`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    // No CORS headers => falls through to route resolution (OPTIONS not a registered route) => 404.
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.status, 404);
  });
});

describe('CORS legacy boolean (backward compatibility)', () => {
  let gw: BootedGateway;
  before(async () => { gw = await bootGateway({ cors: true }); });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('allows any origin with the permissive default', async () => {
    const r = await req('GET', `${gw.base}/health`, undefined, undefined, { origin: 'https://anything.example.com' });
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });
});

describe('security response headers', () => {
  let gw: BootedGateway;
  before(async () => { gw = await bootGateway(); });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('emits no-sniff, frame-deny, referrer-policy on every response', async () => {
    const r = await req('GET', `${gw.base}/health`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  });

  it('does NOT emit HSTS over plain HTTP', async () => {
    const r = await req('GET', `${gw.base}/health`);
    assert.equal(r.headers.get('strict-transport-security'), null);
  });
});

describe('TLS / HTTPS termination', () => {
  let gw: BootedGateway;
  before(async () => {
    gw = await bootGateway({ tls: { cert: TLS_CERT, key: TLS_KEY } });
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('reports a secure handle (protocol=https, secure=true)', () => {
    assert.equal(gw.handle.secure, true);
    assert.equal(gw.handle.protocol, 'https');
    assert.match(gw.base, /^https:\/\//);
  });

  it('serves HTTPS and emits HSTS', async () => {
    const res = await tlsGet(`${gw.base}/health`);
    assert.equal(res.status, 200);
    const body = res.body as { transport: string; secure: boolean };
    assert.equal(body.transport, 'https');
    assert.equal(body.secure, true);
    assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
    // Security headers are present over TLS too.
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('serves a versioned route over HTTPS', async () => {
    const res = await tlsGet(`${gw.base}/v1/health`);
    assert.equal(res.status, 200);
    const body = res.body as { apiVersion: string };
    assert.equal(body.apiVersion, 'v1');
  });
});

describe('multi-tenant data isolation', () => {
  let gw: BootedGateway;
  let aliceToken: string;
  let bobToken: string;
  let orgA: string;
  let orgB: string;

  before(async () => {
    gw = await bootGateway();
    // Two users, each their own organization.
    await req('POST', `${gw.base}/auth/register`, { username: 'alice', password: 'pw', roles: ['developer'] });
    await req('POST', `${gw.base}/auth/register`, { username: 'bob', password: 'pw', roles: ['developer'] });
    aliceToken = ((await req('POST', `${gw.base}/auth/login`, { username: 'alice', password: 'pw' })).body as { token: string }).token;
    bobToken = ((await req('POST', `${gw.base}/auth/login`, { username: 'bob', password: 'pw' })).body as { token: string }).token;
    const a = await req('POST', `${gw.base}/orgs`, { name: 'Acme' }, aliceToken);
    orgA = (a.body as { organization: { id: string } }).organization.id;
    const b = await req('POST', `${gw.base}/orgs`, { name: 'Globex' }, bobToken);
    orgB = (b.body as { organization: { id: string } }).organization.id;
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('lets Alice write data into her org', async () => {
    const r = await req('POST', `${gw.base}/org/data`, { orgId: orgA, action: 'set', id: 'secret', value: 'acme-secret' }, aliceToken);
    assert.equal(r.status, 201);
  });

  it('Alice can read her own org data', async () => {
    const r = await req('GET', `${gw.base}/org/data?orgId=${orgA}&id=secret`, undefined, aliceToken);
    assert.equal(r.status, 200);
    assert.equal((r.body as { value: string }).value, 'acme-secret');
  });

  it('Bob writing the same key into his org does NOT leak into Alice\u2019s org', async () => {
    const r = await req('POST', `${gw.base}/org/data`, { orgId: orgB, action: 'set', id: 'secret', value: 'globex-secret' }, bobToken);
    assert.equal(r.status, 201);
    // Alice still sees only her own value.
    const aRead = await req('GET', `${gw.base}/org/data?orgId=${orgA}&id=secret`, undefined, aliceToken);
    assert.equal((aRead.body as { value: string }).value, 'acme-secret');
    // Bob sees his own value.
    const bRead = await req('GET', `${gw.base}/org/data?orgId=${orgB}&id=secret`, undefined, bobToken);
    assert.equal((bRead.body as { value: string }).value, 'globex-secret');
  });

  it('denies Alice access to Bob\u2019s org data (403 — not a member)', async () => {
    const r = await req('GET', `${gw.base}/org/data?orgId=${orgB}&id=secret`, undefined, aliceToken);
    assert.equal(r.status, 403);
  });

  it('requires org membership even for listing keys', async () => {
    const r = await req('POST', `${gw.base}/org/data`, { orgId: orgB, action: 'list' }, aliceToken);
    assert.equal(r.status, 403);
  });

  it('requires authentication (401) without a token', async () => {
    const r = await req('GET', `${gw.base}/org/data?orgId=${orgA}&id=secret`);
    assert.equal(r.status, 401);
  });
});

describe('session management endpoints', () => {
  let gw: BootedGateway;
  let token: string;

  before(async () => {
    gw = await bootGateway();
    await req('POST', `${gw.base}/auth/register`, { username: 'sessuser', password: 'pw', roles: ['developer'] });
    const login = await req('POST', `${gw.base}/auth/login`, { username: 'sessuser', password: 'pw' });
    token = (login.body as { token: string }).token;
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('lists the caller\u2019s sessions without exposing the token', async () => {
    const r = await req('GET', `${gw.base}/sessions`, undefined, token);
    assert.equal(r.status, 200);
    const sessions = (r.body as { sessions: { token?: string; userId: string }[] }).sessions;
    assert.ok(sessions.length >= 1);
    assert.equal(sessions.find((s) => s.token !== undefined), undefined, 'token must not be exposed');
  });

  it('revokes all other sessions for the caller', async () => {
    // Create a second session to be revoked.
    await req('POST', `${gw.base}/auth/login`, { username: 'sessuser', password: 'pw' });
    const before = await req('GET', `${gw.base}/sessions`, undefined, token);
    const countBefore = (before.body as { count: number }).count;
    assert.ok(countBefore >= 2);
    const r = await req('POST', `${gw.base}/session/revoke`, { all: true }, token);
    assert.equal(r.status, 200);
    assert.ok((r.body as { revoked: number }).revoked >= 1);
    // The current session remains valid.
    const whoami = await req('GET', `${gw.base}/whoami`, undefined, token);
    assert.equal(whoami.status, 200);
  });
});

describe('disaster-recovery backup endpoints', () => {
  let gw: BootedGateway;
  let token: string;

  before(async () => {
    gw = await bootGateway();
    await req('POST', `${gw.base}/auth/register`, { username: 'bkadmin', password: 'pw', roles: ['admin'] });
    const login = await req('POST', `${gw.base}/auth/login`, { username: 'bkadmin', password: 'pw' });
    token = ((login.body as { token: string })).token;
    // Seed a namespace with data to back up.
    const storage = gw.kernel.getModule('storage') as unknown as { namespace: (n: string) => Promise<{ set: (k: string, v: unknown) => Promise<unknown> }> };
    const ns = await storage.namespace('app.critical');
    await ns.set('k', { important: true });
  });
  after(async () => { await gw.handle.close(); await gw.kernel.shutdown(); });

  it('creates an on-demand backup via POST /backup', async () => {
    const r = await req('POST', `${gw.base}/backup`, { namespaces: ['app.critical'] }, token);
    assert.equal(r.status, 201);
    assert.equal((r.body as { result: { snapshotIds: string[] } }).result.snapshotIds.length, 1);
  });

  it('lists backups and schedulers via GET /backups', async () => {
    const r = await req('GET', `${gw.base}/backups`, undefined, token);
    assert.equal(r.status, 200);
    assert.ok((r.body as { snapshots: unknown[] }).snapshots.length >= 1);
  });

  it('starts a scheduler via POST /backup/schedule', async () => {
    const r = await req('POST', `${gw.base}/backup/schedule`, { namespaces: ['app.critical'], intervalMs: 60_000, retention: 3 }, token);
    assert.equal(r.status, 201);
    assert.equal((r.body as { scheduler: { running: boolean } }).scheduler.running, true);
  });

  it('rejects a backup request without permissions (developer role lacks audit:read via admin-only? admin has *)', async () => {
    // A guest has no audit:read permission -> 403.
    await req('POST', `${gw.base}/auth/register`, { username: 'guestbk', password: 'pw', roles: ['guest'] });
    const gl = await req('POST', `${gw.base}/auth/login`, { username: 'guestbk', password: 'pw' });
    const gtoken = (gl.body as { token: string }).token;
    const r = await req('POST', `${gw.base}/backup`, { namespaces: ['app.critical'] }, gtoken);
    assert.equal(r.status, 403);
  });
});

