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
import { SimulationModule } from '@jataqi/simulation';
import { TeamCoordinatorModule } from '@jataqi/teams';
import { PluginManagerModule } from '@jataqi/plugins';
import { ModelRegistryModule } from '@jataqi/model-registry';
import { SchedulerModule } from '@jataqi/scheduler';
import { ApiGatewayModule } from '../src/index.js';
import type { GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('Rate limiting', () => {
  let kernel: Kernel;
  let handle: GatewayHandle;
  let base: string;

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
    kernel.register(new MetricsModule());
    kernel.register(new SimulationModule());
    kernel.register(new TeamCoordinatorModule());
    kernel.register(new PluginManagerModule());
    kernel.register(new ModelRegistryModule());
    kernel.register(new SchedulerModule());
    // Tight limit: 3 requests per minute per key.
    kernel.register(new ApiGatewayModule({ rateLimit: { limit: 3, windowMs: 60_000 } }));
    await kernel.boot();
    const gw = kernel.getModule<ApiGatewayModule>('api-gateway');
    handle = await gw.listen({ port: 0 });
    base = `http://127.0.0.1:${handle.port}`;
  });

  after(async () => {
    await handle.close();
    await kernel.shutdown();
  });

  it('allows up to the limit then returns 429 with headers', async () => {
    const statuses: number[] = [];
    const headers: Record<string, string>[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/health`);
      statuses.push(res.status);
      headers.push(Object.fromEntries(res.headers));
    }
    // First 3 allowed (200), then 429.
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    const limited = headers[3]!;
    assert.equal(limited['x-ratelimit-limit'], '3');
    assert.ok(Number(limited['retry-after']) >= 1);
  });
});
