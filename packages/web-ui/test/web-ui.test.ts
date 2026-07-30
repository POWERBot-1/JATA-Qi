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
    kernel.register(new SecurityModule());
    kernel.register(new OrchestratorModule());
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
});
