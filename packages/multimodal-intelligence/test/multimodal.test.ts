// Multimodal Intelligence tests — modality processing, authorization gate,
// knowledge storage, gap detection, privacy classification, and kernel integration.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { process, MultimodalIntelligenceModule, MultimodalIntelEvents } from '../src/index.js';
import type { Modality } from '../src/index.js';

const SAMPLE_TEXT = `
# API Gateway Documentation

The API Gateway uses OAuth 2.1 with OIDC for authentication.
ABAC authorization is enforced through a policy engine.

## Setup Procedure
1. Register your application
2. Configure redirect URIs
3. Obtain client credentials

## Endpoints
GET /api/v1/health
POST /api/v1/auth/login

The system uses Redis caching and connection pooling for performance.
GraphQL federation is planned for v2.

\`\`\`typescript
const client = new GatewayClient({ apiKey: '...' });
\`\`\`
`;

const SAMPLE_CODE = `
export interface User { id: string; email: string; roles: string[] }
export class AuthService {
  async login(email: string, password: string): Promise<string> { return 'jwt-token'; }
}
`;

const SAMPLE_DEVICE = JSON.stringify({
  device_id: 'sensor-001', temperature: 22.5, humidity: 65, battery: 0.87,
  location: { lat: -1.2864, lng: 36.8172 }, timestamp: Date.now(),
});

describe('Processor — modality-specific extraction', () => {
  const modalities: Array<{ modality: Modality; content: string; label: string }> = [
    { modality: 'text', content: SAMPLE_TEXT, label: 'text' },
    { modality: 'document', content: 'name,age,role\nAlice,30,admin\nBob,25,user', label: 'CSV' },
    { modality: 'code', content: SAMPLE_CODE, label: 'TypeScript' },
    { modality: 'device', content: SAMPLE_DEVICE, label: 'JSON telemetry' },
    { modality: 'web', content: '<html><head><title>Test Page</title></head><body>Hello World</body></html>', label: 'HTML' },
    { modality: 'audio', content: 'Welcome to the meeting. Today we will discuss the API gateway deployment.', label: 'transcript' },
    { modality: 'image', content: 'OCR: Error message showing DatabaseTimeout on line 42', label: 'OCR text' },
    { modality: 'api', content: 'GET /v1/users POST /v1/users/{id}', label: 'API spec' },
  ];

  for (const { modality, content, label } of modalities) {
    it(`processes ${modality} modality (${label})`, () => {
      const result = process(modality, content, 'src-1', 'test-source');
      assert.equal(result.modality, modality);
      assert.ok(result.id);
      assert.ok(result.extractedAt > 0);
      // Each modality should produce some structured output.
      const totalItems = result.concepts.length + result.facts.length + result.apis.length +
        result.dataModels.length + result.procedures.length + result.snippets.length;
      assert.ok(totalItems > 0 || result.confidence > 0, `${modality} should produce output`);
    });
  }

  it('extracts concepts, APIs, and security patterns from text', () => {
    const result = process('text', SAMPLE_TEXT, 's', 'ref');
    assert.ok(result.concepts.includes('oauth'));
    assert.ok(result.concepts.includes('graphql'));
    assert.ok(result.securityPatterns.includes('OAuth/OIDC'));
    assert.ok(result.securityPatterns.includes('ABAC'));
    assert.ok(result.apis.some((a) => a.path === '/api/v1/health'));
    assert.ok(result.procedures.length > 0);
  });

  it('extracts data models from code', () => {
    const result = process('code', SAMPLE_CODE, 's', 'ref');
    assert.ok(result.dataModels.includes('User'));
    assert.ok(result.dataModels.includes('AuthService'));
  });

  it('extracts device telemetry from JSON', () => {
    const result = process('device', SAMPLE_DEVICE, 's', 'ref');
    assert.ok(result.concepts.includes('temperature'));
    assert.ok(result.concepts.includes('battery'));
    assert.ok(result.facts.some((f) => f.predicate === 'temperature'));
  });

  it('extracts CSV headers as data model', () => {
    const result = process('document', 'name,age,role\nAlice,30,admin', 's', 'ref');
    assert.ok(result.dataModels.some((d) => d.includes('name') && d.includes('age')));
  });
});

describe('MultimodalIntelligenceModule — kernel integration', () => {
  let kernel: Kernel;
  let mod: MultimodalIntelligenceModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new MultimodalIntelligenceModule({ minConfidence: 0.01 });
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('registers and lists sources', () => {
    const src = mod.registerSource({ modality: 'text', name: 'Documentation', requiresAuth: false });
    assert.ok(src.id);
    assert.equal(mod.listSources().length, 1);
    assert.equal(mod.listSources('text').length, 1);
    assert.equal(mod.listSources('image').length, 0);
  });

  it('acquires from an unauthenticated source', async () => {
    let acquired = 0;
    kernel.bus.on(MultimodalIntelEvents.Acquired, () => { acquired++; });
    const src = mod.registerSource({ modality: 'text', name: 'Docs', requiresAuth: false });
    const result = await mod.acquire(src.id, SAMPLE_TEXT);
    assert.ok(result.knowledge.concepts.length > 0);
    assert.ok(result.processingMs >= 0);
    await new Promise((r) => setImmediate(r));
    assert.ok(acquired >= 1);
  });

  it('blocks acquisition without authorization (secure-by-default)', async () => {
    const src = mod.registerSource({ modality: 'enterprise', name: 'CRM', requiresAuth: true });
    await assert.rejects(() => mod.acquire(src.id, 'customer data'), /authorization/);
  });

  it('allows acquisition after granting authorization', async () => {
    let unauthorized = 0;
    kernel.bus.on(MultimodalIntelEvents.Unauthorized, () => { unauthorized++; });
    const src = mod.registerSource({ modality: 'enterprise', name: 'Wiki', requiresAuth: true });
    // First attempt without auth → rejected.
    await assert.rejects(() => mod.acquire(src.id, 'wiki content'));
    // Grant auth.
    mod.authorize(src.id, { grantedBy: 'admin', scope: 'read' });
    // Now acquisition succeeds.
    const result = await mod.acquire(src.id, 'The API Gateway uses OAuth for authentication.');
    assert.ok(result.knowledge.concepts.includes('oauth'));
    assert.equal(unauthorized, 1);
  });

  it('acquires directly without registering a source', async () => {
    const result = await mod.acquireDirect('code', SAMPLE_CODE, 'inline code');
    assert.equal(result.modality, 'code');
    assert.ok(result.knowledge.dataModels.includes('User'));
  });

  it('detects capability gaps from acquired knowledge', async () => {
    const longContent = 'The system uses GraphQL federation for its API layer. ABAC authorization is enforced through a policy engine. ' +
      'The platform implements chaos engineering practices including fault injection and automated recovery. ' +
      'OAuth 2.1 with OIDC provides enterprise SSO. The infrastructure includes a service mesh with mTLS. ' +
      'Data flows through an event-driven architecture with Redis streams and Kafka queues for reliability.';
    const result = await mod.acquireDirect('text', longContent, 'gap-test');
    assert.ok(result.gaps.length > 0, `expected gaps but got: ${JSON.stringify(result.gaps)}`);
    assert.ok(result.gaps.some((g) => g.includes('GraphQL') || g.includes('ABAC') || g.includes('Chaos')));
  });

  it('classifies privacy levels', async () => {
    const restricted = await mod.acquireDirect('text', 'User credentials include password: secret123 and credit card number 4532-1234-5678-9012 for billing purposes with full account details and history.', 'leaked');
    assert.equal(restricted.privacyLevel, 'restricted');
    const normal = await mod.acquireDirect('text', 'The weather is sunny today and the API gateway documentation describes the health check endpoints available for monitoring system status.', 'public');
    assert.notEqual(normal.privacyLevel, 'restricted');
  });

  it('batch-acquires from multiple sources', async () => {
    const s1 = mod.registerSource({ modality: 'text', name: 'S1', requiresAuth: false });
    const s2 = mod.registerSource({ modality: 'code', name: 'S2', requiresAuth: false });
    const results = await mod.acquireBatch([
      { sourceId: s1.id, content: 'hello world' },
      { sourceId: s2.id, content: SAMPLE_CODE },
    ]);
    assert.equal(results.length, 2);
  });

  it('provides a summary', () => {
    const s = mod.summary();
    assert.ok(s.totalSources > 0);
    assert.ok(s.totalAcquisitions > 0);
    assert.ok(Object.keys(s.byModality).length > 0);
    assert.ok(s.avgConfidence >= 0);
  });

  it('stores knowledge in memory when available', async () => {
    const k2 = createTestKernel();
    const { StorageModule } = await import('@jataqi/storage');
    const { DigitalMemoryModule } = await import('@jataqi/memory');
    k2.register(new StorageModule());
    k2.register(new DigitalMemoryModule());
    const mod2 = new MultimodalIntelligenceModule({ minConfidence: 0.01 });
    k2.register(mod2);
    await k2.boot();
    const result = await mod2.acquireDirect('text', SAMPLE_TEXT, 'memory-test');
    assert.equal(result.stored, true);
    await k2.shutdown();
  });
});
