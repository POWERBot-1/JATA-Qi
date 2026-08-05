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
    // Live activity feed.
    assert.match(js, /startLiveFeed/, 'live feed wired');
    assert.match(js, /topics: \['security', 'memory', 'tool', 'tanya', 'orchestrator'\]/, 'subscribes to platform topics');
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
