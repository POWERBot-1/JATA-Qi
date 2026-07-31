// PR6 — End-to-end vertical slice. Boots the FULL stack via createJataQi (all
// 56 modules, the real composition root) and drives the complete user journey
// over real HTTP: probes → auth → org/tenant data → knowledge → workflow →
// agent → tools → commerce → governance → notifications → backup → metrics →
// identity → session management → readiness. This is the confidence baseline.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createJataQi } from '../src/bootstrap.js';
import type { ApiGatewayModule } from '@jataqi/api-gateway';
import type { GatewayHandle } from '@jataqi/api-gateway';

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

describe('E2E — full vertical slice (createJataQi → HTTP)', () => {
  let handle: GatewayHandle;
  let base: string;
  let shutdown: () => Promise<void>;
  let adminToken: string;
  let devToken: string;
  let orgId: string;

  before(async () => {
    const qi = await createJataQi({ security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    shutdown = qi.shutdown;
    handle = await (qi.gateway as ApiGatewayModule).listen({ port: 0 });
    base = `http://127.0.0.1:${handle.port}`;
  });
  after(async () => { await handle.close(); await shutdown(); });

  // --- transport & probes -------------------------------------------------
  it('reports healthy + ready + alive', async () => {
    const h = await req('GET', `${base}/health`);
    assert.equal(h.status, 200);
    assert.equal((h.body as { status: string }).status, 'healthy');
    const r = await req('GET', `${base}/readyz`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { checks: { storage: boolean } }).checks.storage, true);
    const l = await req('GET', `${base}/livez`);
    assert.equal((l.body as { status: string }).status, 'alive');
  });

  it('exposes an honest readiness summary (NOT production-ready)', async () => {
    const s = await req('GET', `${base}/readiness/summary`);
    assert.equal(s.status, 200);
    assert.match((s.body as { overall: string }).overall, /NOT production-ready/);
    assert.ok((s.body as { total: number }).total >= 60);
  });

  // --- identity & authentication ------------------------------------------
  it('logs in the bootstrap admin and a developer', async () => {
    const admin = await req('POST', `${base}/auth/login`, { username: 'admin', password: 'admin' });
    assert.equal(admin.status, 200);
    adminToken = (admin.body as { token: string }).token;
    assert.ok((admin.body as { principal: { roles: string[] } }).principal.roles.includes('admin'));

    const reg = await req('POST', `${base}/auth/register`, { username: 'dev', password: 'pw', roles: ['developer'] });
    assert.equal(reg.status, 201);
    const dev = await req('POST', `${base}/auth/login`, { username: 'dev', password: 'pw' });
    devToken = (dev.body as { token: string }).token;
    assert.ok(devToken);
  });

  it('verifies creator identity & provenance (GITANYA K)', async () => {
    const v = await req('GET', `${base}/identity/verify`);
    assert.equal(v.status, 200);
    assert.equal((v.body as { valid: boolean }).valid, true);
    const info = await req('GET', `${base}/identity`);
    assert.equal((info.body as { creator: { display_name: string } }).creator.display_name, 'GITANYA K');
  });

  // --- organizations & tenant isolation -----------------------------------
  it('creates an org and writes tenant-scoped data', async () => {
    const o = await req('POST', `${base}/orgs`, { name: 'E2E Corp' }, devToken);
    assert.equal(o.status, 201);
    orgId = (o.body as { organization: { id: string } }).organization.id;
    const set = await req('POST', `${base}/org/data`, { orgId, action: 'set', id: 'config', value: { region: 'ke' } }, devToken);
    assert.equal(set.status, 201);
    const get = await req('GET', `${base}/org/data?orgId=${orgId}&id=config`, undefined, devToken);
    assert.deepEqual((get.body as { value: { region: string } }).value, { region: 'ke' });
  });

  // --- orchestration: objective → workflow → agent → audit ----------------
  it('runs an objective to a completed workflow with an audit record', async () => {
    const o = await req('POST', `${base}/objective`, { objective: 'Summarize the platform' }, devToken);
    assert.equal(o.status, 200);
    const result = (o.body as { result: { status: string; finalReport: string; auditRecordId?: string; id: string } }).result;
    assert.equal(result.status, 'completed');
    assert.ok(result.finalReport.length > 0);
    assert.ok(result.auditRecordId);

    // Workflow history is queryable.
    const one = await req('GET', `${base}/workflow?id=${result.id}`, undefined, devToken);
    assert.equal(one.status, 200);
    assert.equal((one.body as { run: { id: string } }).run.id, result.id);

    // The audit ledger records the run.
    const audit = await req('GET', `${base}/audit?action=orchestrator.run`, undefined, devToken);
    assert.ok((audit.body as { records: unknown[] }).records.length >= 1);
  });

  it('accepts a QiL program and runs an agent', async () => {
    const q = await req('POST', `${base}/qil`, { program: 'MISSION "e2e" { REPORT }' }, devToken);
    assert.equal(q.status, 200);
    assert.equal((q.body as { result: { status: string } }).result.status, 'completed');
    const a = await req('POST', `${base}/ask`, { message: 'hello' }, devToken);
    assert.equal(a.status, 200);
    assert.ok(typeof (a.body as { answer: string }).answer === 'string');
  });

  // --- universal tool intelligence ----------------------------------------
  it('registers and invokes the seeded echo tool', async () => {
    const list = await req('GET', `${base}/tools`, undefined, devToken);
    const echo = (list.body as { tools: { id: string; canonicalName: string }[] }).tools.find((t) => t.canonicalName === 'echo');
    assert.ok(echo, 'bootstrap seeds an echo tool');
    const inv = await req('POST', `${base}/tool/invoke`, { id: echo!.id, input: 'ping' }, devToken);
    assert.equal(inv.status, 200);
    assert.deepEqual((inv.body as { result: { output: unknown } }).result.output, { echoed: 'ping' });
  });

  // --- commerce -----------------------------------------------------------
  it('subscribes and checks an entitlement', async () => {
    const plans = await req('GET', `${base}/commerce/plans`, undefined, devToken);
    assert.ok((plans.body as { plans: unknown[] }).plans.length >= 10);
    const sub = await req('POST', `${base}/commerce/subscribe`, { planSlug: 'free' }, devToken);
    assert.equal(sub.status, 201);
    const check = await req('GET', `${base}/commerce/check?feature=ai.requests`, undefined, devToken);
    assert.equal((check.body as { decision: { allowed: boolean } }).decision.allowed, true);
  });

  // --- governance ---------------------------------------------------------
  it('governs a sensitive action (DENY by default) and allows a whitelisted one', async () => {
    const denied = await req('POST', `${base}/gov/policies/evaluate`, { action: 'finance.transfer' }, devToken);
    assert.equal((denied.body as { result: { decision: string } }).result.decision, 'DENY');
    await req('POST', `${base}/gov/policies`, { name: 'allow read', effect: 'ALLOW', category: 'ACCESS', scope: 'GLOBAL', action: 'workspace.read' }, devToken);
    const allowed = await req('POST', `${base}/gov/policies/evaluate`, { action: 'workspace.read' }, devToken);
    assert.equal((allowed.body as { result: { decision: string } }).result.decision, 'ALLOW');
  });

  // --- notifications ------------------------------------------------------
  it('sends and lists a notification', async () => {
    const sent = await req('POST', `${base}/notify`, { type: 'system', title: 'E2E', body: 'hello' }, devToken);
    assert.equal(sent.status, 201);
    const list = await req('GET', `${base}/notifications`, undefined, devToken);
    assert.ok((list.body as { notifications: unknown[] }).notifications.length >= 1);
  });

  // --- disaster recovery (on-demand backup) ------------------------------
  it('takes an on-demand backup and lists it', async () => {
    const b = await req('POST', `${base}/backup`, { namespaces: ['security.audit'] }, adminToken);
    assert.equal(b.status, 201);
    assert.equal((b.body as { result: { snapshotIds: string[] } }).result.snapshotIds.length, 1);
    const list = await req('GET', `${base}/backups`, undefined, adminToken);
    assert.ok((list.body as { snapshots: unknown[] }).snapshots.length >= 1);
  });

  // --- observability ------------------------------------------------------
  it('exposes Prometheus metrics with the traffic we generated', async () => {
    const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${devToken}` } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('jataqi_requests_total'));
    assert.ok(text.includes('jataqi_request_duration_ms_count'));
  });

  // --- session management -------------------------------------------------
  it('lists and revokes sessions', async () => {
    const list = await req('GET', `${base}/sessions`, undefined, devToken);
    assert.ok((list.body as { count: number }).count >= 1);
    // Tokens are never exposed in the listing.
    assert.equal((list.body as { sessions: { token?: string }[] }).sessions.find((s) => s.token !== undefined), undefined);
    const rev = await req('POST', `${base}/session/revoke`, { all: true }, devToken);
    assert.equal(rev.status, 200);
    // The current token still works (we excepted it).
    const whoami = await req('GET', `${base}/whoami`, undefined, devToken);
    assert.equal(whoami.status, 200);
  });

  // --- versioning ---------------------------------------------------------
  it('serves the whole slice under the /v1 prefix too', async () => {
    const h = await req('GET', `${base}/v1/health`);
    assert.equal(h.status, 200);
    assert.equal((h.body as { apiVersion: string }).apiVersion, 'v1');
  });
});
