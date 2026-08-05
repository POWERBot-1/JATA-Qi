import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { SecurityModule } from '@jataqi/security';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, EchoLLM } from '@jataqi/agent-runtime';
import { QiLModule } from '@jataqi/qil';
import { OrchestratorModule } from '@jataqi/orchestrator';
import { DigitalMemoryModule } from '@jataqi/memory';
import { DashboardModule } from '@jataqi/dashboard';
import { ConversationsModule } from '@jataqi/conversations';
import { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import { SearchModule } from '@jataqi/search';
import { AutomationModule } from '@jataqi/automation';
import { FxModule } from '@jataqi/fx';
import { PkiModule } from '@jataqi/pki';
import { CloudModule } from '@jataqi/cloud';
import { CdnModule } from '@jataqi/cdn';
import { EmailModule } from '@jataqi/email';
import { IpamModule } from '@jataqi/ipam';
import { TanyaModule } from '@jataqi/tanya';
import { ApiGatewayModule } from '@jataqi/api-gateway';
import { WebUIModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('WebUIModule', () => {
  let kernel: Kernel;
  let ui: WebUIModule;

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
    kernel.register(new DigitalMemoryModule());
    kernel.register(new DashboardModule());
    kernel.register(new ConversationsModule());
    kernel.register(new ToolIntelligenceModule());
    kernel.register(new SearchModule());
    kernel.register(new AutomationModule({ tickIntervalMs: 0 }));
    kernel.register(new FxModule({ anchor: 'USD' }));
    kernel.register(new PkiModule({ issuer: 'https://id.ui.test.local' }));
    kernel.register(new CloudModule());
    kernel.register(new CdnModule());
    kernel.register(new EmailModule());
    kernel.register(new IpamModule());
    kernel.register(new TanyaModule());
    kernel.register(new ApiGatewayModule());
    kernel.register(new WebUIModule());
    await kernel.boot();
    ui = kernel.getModule<WebUIModule>('web-ui');
  });

  after(async () => { await kernel.shutdown(); });

  it('initializes and exposes static files', () => {
    const files = ui.listFiles();
    assert.ok(files.includes('index.html'));
    assert.ok(files.includes('style.css'));
    assert.ok(files.includes('app.js'));
    assert.ok(files.includes('manifest.json'), 'PWA manifest present');
    assert.ok(files.includes('sw.js'), 'service worker present');
    assert.ok(files.includes('icon.svg'), 'app icon present');
  });

  it('serves the PWA shell (manifest + service worker) with correct MIME', () => {
    const manifest = ui.serve('/ui/manifest.json')!;
    assert.match(manifest.contentType, /application\/json/);
    const parsed = JSON.parse(manifest.content.toString('utf8')) as { start_url: string; display: string; icons: { type: string }[] };
    assert.equal(parsed.start_url, '/ui/');
    assert.equal(parsed.display, 'standalone');
    assert.ok(parsed.icons.some((i) => i.type === 'image/svg+xml'));

    const sw = ui.serve('/ui/sw.js')!;
    assert.match(sw.contentType, /javascript/);
    const swText = sw.content.toString('utf8');
    assert.match(swText, /cache-first/, 'shell strategy documented');
    assert.match(swText, /addAll\(SHELL\)/, 'shell precached');

    const icon = ui.serve('/ui/icon.svg')!;
    assert.match(icon.contentType, /image\/svg/);

    // index.html links the manifest + icon.
    const html = ui.serve('/ui/index.html')!.content.toString('utf8');
    assert.match(html, /rel="manifest" href="\/ui\/manifest\.json"/, 'manifest linked');
    assert.match(html, /theme-color/, 'theme color declared');
  });

  it('serves index.html with correct MIME type', () => {
    const result = ui.serve('/ui/');
    assert.ok(result);
    assert.match(result!.contentType, /text\/html/);
    assert.ok(result!.content.length > 100);
  });

  it('serves CSS with correct MIME type', () => {
    const result = ui.serve('/ui/style.css');
    assert.ok(result);
    assert.match(result!.contentType, /text\/css/);
  });

  it('serves JS with correct MIME type', () => {
    const result = ui.serve('/ui/app.js');
    assert.ok(result);
    assert.match(result!.contentType, /javascript/);
  });

  it('returns undefined for non-existent files', () => {
    assert.equal(ui.serve('/ui/nonexistent.xyz'), undefined);
  });

  it('blocks path traversal', () => {
    assert.equal(ui.serve('/ui/../../../etc/passwd'), undefined);
  });

  it('app.js wires the engine + TANYA + dashboard views to gateway endpoints', () => {
    const js = ui.serve('/ui/app.js')!.content.toString('utf8');
    // TANYA conversational console.
    assert.match(js, /tanya: async/, 'tanya view present');
    assert.match(js, /\/tanya\/chat/, 'chat endpoint wired');
    assert.match(js, /\/tanya\/conversations/, 'conversations endpoint wired');
    assert.match(js, /sendTanya/, 'send action present');
    // Adaptive dashboard.
    assert.match(js, /dashboards: async/, 'dashboards view present');
    assert.match(js, /\/dashboard\/layouts/, 'layouts endpoint wired');
    assert.match(js, /\/dashboard\/adapt/, 'adapt endpoint wired');
    // Engines.
    for (const [view, path] of [
      ['search', '/search?q='], ['memory', '/memory/stats'], ['fx', '/fx/rates'],
      ['cloud', '/cloud/stats'], ['cdn', '/cdn/stats'], ['email', '/email/stats'],
      ['ipam', '/ipam/stats'], ['automations', '/automations'],
    ]) {
      assert.match(js, new RegExp(`${view}: async`), `${view} view present`);
      assert.match(js, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${view} endpoint wired`);
    }
    // Tool governance actions.
    assert.match(js, /\/tools\/sync/, 'tools sync wired');
    assert.match(js, /decideApproval/, 'approval decision wired');
    // Tool governance observability.
    assert.match(js, /\/tools\/governance-stats/, 'governance stats endpoint wired');
    assert.match(js, /Decisions ALLOW/, 'decision stat cards rendered');
    // Tool governance widgets in the dashboards view.
    assert.match(js, /statCard\('Governed Tools'/, 'governed-tools widget data rendered');
    assert.match(js, /Tool Governance Widgets/, 'governance widget panel rendered');
    assert.match(js, /\/tools\/governance-stats/, 'dashboards view fetches governance stats');
    // Governance SLA alerts view.
    assert.match(js, /alerts: async/, 'alerts view present');
    assert.match(js, /\/governance\/alerts/, 'alerts endpoint wired');
    assert.match(js, /SLA Rules/, 'rules panel rendered');
    assert.match(js, /JataQiToolApprovalQueueHigh/, 'prometheus rule names surfaced');
    // PWA shell.
    assert.match(js, /serviceWorker\.register\('\/ui\/sw\.js'\)/, 'service worker registered');
    // Audit export (CSV/JSON compliance handoff).
    assert.match(js, /exportAudit/, 'audit export action present');
    assert.match(js, /\/audit\/export/, 'export endpoint wired');
    assert.match(js, /audit-export-scope/, 'export scope selector rendered');
    assert.match(js, /Export CSV/, 'CSV export button present');
    assert.match(js, /Export JSON/, 'JSON export button present');
    // Live auto-refresh for alerts + approvals views.
    assert.match(js, /scheduleRefresh\('alerts', 15_000\)/, 'alerts auto-refresh scheduled');
    assert.match(js, /scheduleRefresh\('approvals', 10_000\)/, 'approvals auto-refresh scheduled');
    assert.match(js, /refreshTimers\[view\]/, 'refresh throttled per view');
    // Conversation export + governance feed topic.
    assert.match(js, /exportTanyaConversation/, 'tanya export action present');
    assert.match(js, /\/chat\/export\?id=/, 'chat export endpoint wired');
    assert.match(js, /'governance'/, 'governance topic in the live feed');
    assert.match(js, /governance: '🚨'/, 'governance feed icon');
    // Multi-user TANYA (org scope + sharing).
    assert.match(js, /\/tanya\/share/, 'share endpoint wired');
    assert.match(js, /\/tanya\/shared/, 'shared-with-me endpoint wired');
    assert.match(js, /shareTanyaConversation/, 'share action present');
    assert.match(js, /tanya-org/, 'org scope input rendered');
    assert.match(js, /recipient email \(IdP identity\)/, 'IdP-identity sharing UI present');
    // Org-aware TANYA + Organizations view.
    assert.match(js, /orgs: async/, 'orgs view present');
    assert.match(js, /createOrg/, 'create-org action present');
    assert.match(js, /inviteToOrg/, 'invite action present');
    assert.match(js, /acceptInvite/, 'accept-invitation action present');
    assert.match(js, /\/orgs/, 'my-orgs fetch wired');
    assert.match(js, /state\.myOrgs\[0\]/, 'TANYA defaults to the first org');
    assert.match(js, /\/tanya\/conversations\?orgId=/, 'org-scoped conversation list wired');
    // Session rotation hardening.
    assert.match(js, /\/pki\/idp\/revoke/, 'idp revoke endpoint wired on logout');
    assert.match(js, /result\.idpTokens\.refresh_token \|\| tokens\.refresh_token/, 'rotated refresh token persisted');
    assert.match(js, /localStorage.removeItem\('jq_idp_tokens'\)/, 'tokens cleared on logout');
    // IdP-first login (client-credentials grant).
    assert.match(js, /\/pki\/idp\/console-login/, 'console-login endpoint wired');
    assert.match(js, /consoleLoginIdp/, 'passwordless IdP login helper present');
    assert.match(js, /doIdpLogin/, 'IdP login button action present');
    assert.match(js, /Sign in with saved IdP session/, 'IdP button rendered');
    assert.match(js, /idpClientKey/, 'per-user IdP client keyed by username');
    // Deep IdP integration (refresh + rotation).
    assert.match(js, /\/pki\/idp\/rotate/, 'session rotation endpoint wired');
    assert.match(js, /\/pki\/idp\/token/, 'idp authorization-code exchange wired');
    assert.match(js, /linkIdpSession/, 'idp linking on login wired');
    assert.match(js, /rotateIdpSession/, 'silent rotation helper present');
    assert.match(js, /jq_idp_tokens/, 'refresh token stored for rotation');
    // Audit trail view.
    assert.match(js, /audit: async/, 'audit view present');
    assert.match(js, /tool\.approval\.decided/, 'approval ledger fetched');
    assert.match(js, /Approval Decisions \(ledger\)/, 'decision ledger rendered');
    assert.match(js, /Denied High-Risk Invocations/, 'denial view rendered');
    assert.match(js, /Recent Logins/, 'login trail rendered');
    // Approvals workflow view.
    assert.match(js, /approvals: async/, 'approvals view present');
    assert.match(js, /\/approvals\?status=all/, 'history fetch wired');
    assert.match(js, /Approval Queue/, 'queue rendered');
    assert.match(js, /decideApproval\(/i, 'approve/deny actions wired');
    // Realtime observability badge.
    assert.match(js, /\/realtime\/stats/, 'realtime stats endpoint wired');
    assert.match(js, /refreshRealtimeCount/, 'client-count refresh helper present');
    assert.match(js, /connected/, 'count badge text');
    // Live activity feed.
    assert.match(js, /startLiveFeed/, 'live feed wired');
    assert.match(js, /topics: \['security', 'memory', 'tool', 'tanya', 'orchestrator', 'governance'\]/, 'subscribes to platform topics');
    assert.match(js, /addFeedEvent/, 'feed events appended');
    assert.match(js, /feed-toast/, 'toast element rendered');
    assert.match(js, /activity-feed/, 'feed sidebar section present');
    // Auth polish: session introspection + register-first + countdown.
    assert.match(js, /\/auth\/session/, 'session introspection wired');
    assert.match(js, /registerAndLogin/, 'register-first flow present');
    assert.match(js, /setAuthTab/, 'sign-in / create-account tabs present');
    assert.match(js, /session-countdown/, 'session countdown rendered');
    assert.match(js, /startSessionTimer/, 'expiry auto-logout wired');
    assert.match(js, /res.status === 401/, 'global 401 handling clears auth');
    // QiL live console.
    assert.match(js, /qil: async/, 'qil view present');
    assert.match(js, /runQiL/, 'qil run action present');
    assert.match(js, /qil\.step/, 'streams qil.step events');
    assert.match(js, /type: 'qil\.run'/, 'sends qil.run over /ws');
    // TANYA WebSocket streaming (with HTTP fallback).
    assert.match(js, /new WebSocket\(tanyaWsUrl\(\)\)/, 'tanya chat streams over /ws');
    assert.match(js, /tanya\.chunk/, 'streams tanya.chunk events');
    assert.match(js, /sendTanyaHttp/, 'HTTP fallback preserved');
    assert.match(js, /\/ws\?token=/, 'socket authenticates with the session token');
  });

  it('serves the UI through the API gateway', async () => {
    const gateway = kernel.getModule('api-gateway') as unknown as { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> };
    const handle = await gateway.listen({ port: 0 });
    try {
      // Serve index.html at /ui
      const res = await fetch(`http://127.0.0.1:${handle.port}/ui`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /JATA Qi.*Admin Console/i);
      // CSS
      const css = await fetch(`http://127.0.0.1:${handle.port}/ui/style.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type')!, /text\/css/);
      // JS
      const js = await fetch(`http://127.0.0.1:${handle.port}/ui/app.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type')!, /javascript/);
      // PWA shell files.
      const manifest = await fetch(`http://127.0.0.1:${handle.port}/ui/manifest.json`);
      assert.equal(manifest.status, 200);
      assert.match(manifest.headers.get('content-type')!, /application\/json/);
      const sw = await fetch(`http://127.0.0.1:${handle.port}/ui/sw.js`);
      assert.equal(sw.status, 200);
      assert.match(sw.headers.get('content-type')!, /javascript/);
    } finally {
      await handle.close();
    }
  });

  it('renders login form (unauthenticated) and allows auth via API', async () => {
    const gateway = kernel.getModule('api-gateway') as unknown as { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> };
    const handle = await gateway.listen({ port: 0 });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      // Register + login.
      await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'uitest', password: 'pw', roles: ['developer'] }) });
      const loginRes2 = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'uitest', password: 'pw' }) });
      const loginBody = await loginRes2.json() as { token: string };
      const token = loginBody.token;
      // Authenticated API call.
      const health = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(health.status, 200);
      const healthBody = await health.json() as { status: string };
      assert.equal(healthBody.status, 'healthy');
    } finally {
      await handle.close();
    }
  });

  it('engine views resolve through the gateway with a developer session (UI data path)', async () => {
    const gateway = kernel.getModule('api-gateway') as unknown as { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> };
    const handle = await gateway.listen({ port: 0 });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
      const token = (await login.json() as { token: string }).token;
      const auth = { authorization: `Bearer ${token}` };

      // TANYA chat (used by the UI console).
      const chat = await fetch(`${base}/tanya/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ message: 'Hello from the UI' }) });
      assert.equal(chat.status, 200);
      const chatBody = await chat.json() as { conversationId: string; reply: string };
      assert.ok(chatBody.conversationId);
      assert.match(chatBody.reply, /Hello from the UI/);

      // Adaptive dashboard: create layout + add a widget.
      const layout = await fetch(`${base}/dashboard/layouts`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ name: 'UI Layout', ownerId: 'admin' }) });
      assert.equal(layout.status, 201);
      const layoutBody = await layout.json() as { layout: { id: string } };
      const layouts = await fetch(`${base}/dashboard/layouts`, { headers: auth });
      assert.equal((await layouts.json() as { count: number }).count, 1);

      // Engine stats endpoints used by the views.
      for (const path of ['/cloud/stats', '/cdn/stats', '/email/stats', '/ipam/stats', '/fx/stats', '/memory/stats', '/automations']) {
        const res = await fetch(`${base}${path}`, { headers: auth });
        assert.equal(res.status, 200, `${path} should resolve`);
      }

      // Tool governance sync (used by the Tools view).
      const sync = await fetch(`${base}/tools/sync`, { method: 'POST', headers: { ...auth }, body: JSON.stringify({}) });
      assert.equal(sync.status, 200);
      const syncBody = await sync.json() as { synced: number };
      assert.ok(syncBody.synced >= 37);

      void layoutBody;
    } finally {
      await handle.close();
    }
  });
});
