// Link Intelligence tests — classification, extraction, gap analysis, proposal
// generation, validation, and full kernel integration.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { classify, extract, analyzeGaps } from '../src/index.js';
import { LinkIntelligenceModule, LinkIntelEvents } from '../src/index.js';

const SAMPLE_README = `# Awesome Project

MIT License

A microservices architecture using event-driven design with Docker and Kubernetes.

## Dependencies
react, express, redis, kubernetes

## Features
- OAuth 2.1 authentication with OIDC
- ABAC authorization
- GraphQL federation
- Circuit breaker pattern
- Chaos engineering
- Webhook platform

\`\`\`typescript
const app = express();
app.get('/api/health', (req, res) => res.json({ ok: true }));
\`\`\`

## Testing
- Unit testing with Jest
- E2E testing with Playwright
- Property-based testing
- Security testing with SAST

## CI/CD
GitHub Actions pipeline with blue-green deployment.
`;

describe('Classifier — Phase 1', () => {
  it('detects GitHub source type', () => {
    const c = classify('https://github.com/user/repo');
    assert.equal(c.sourceType, 'github');
  });

  it('detects npm source type', () => {
    const c = classify('https://www.npmjs.com/package/express');
    assert.equal(c.sourceType, 'npm');
  });

  it('detects language from URL extension', () => {
    const c = classify('https://example.com/file.ts');
    assert.equal(c.language, 'typescript');
  });

  it('detects language from content', () => {
    const c = classify('https://example.com/code', 'export function foo(): void {}');
    assert.equal(c.language, 'typescript');
  });

  it('extracts metadata from content (title, license, deps, framework)', () => {
    const c = classify('https://github.com/x/y', SAMPLE_README);
    assert.equal(c.title, 'Awesome Project');
    assert.equal(c.license, 'MIT');
    assert.ok(c.dependencies.length > 0);
    assert.ok(c.framework);
    assert.ok(c.confidence > 0.3);
  });

  it('handles unknown sources gracefully', () => {
    const c = classify('https://random-site.com/page');
    assert.equal(c.sourceType, 'unknown');
  });
});

describe('Extractor — Phase 2', () => {
  it('extracts architectures, patterns, and APIs', () => {
    const e = extract(SAMPLE_README);
    assert.ok(e.architectures.includes('Microservices'));
    assert.ok(e.architectures.includes('Event-Driven'));
    assert.ok(e.algorithms.includes('Circuit Breaker'));
    assert.ok(e.apis.some((a) => a.path === '/api/health'));
    assert.ok(e.securityModels.length > 0);
    assert.ok(e.deploymentModels.includes('Kubernetes'));
    assert.ok(e.testingMethodologies.includes('Unit Testing'));
    assert.ok(e.snippets.length > 0);
  });

  it('extracts domain concepts', () => {
    const e = extract(SAMPLE_README);
    assert.ok(e.domainConcepts.length > 0);
  });

  it('extracts business capabilities', () => {
    const e = extract('A SaaS subscription marketplace with payments, notifications, and multi-tenant organizations. Includes analytics dashboards and workflow automation.');
    assert.ok(e.businessCapabilities.length > 0);
  });

  it('handles minimal content', () => {
    const e = extract('hello world');
    assert.equal(e.architectures.length, 0);
    assert.ok(e.confidence < 0.01);
  });
});

describe('Gap Analyzer — Phase 4', () => {
  it('detects missing capabilities (OAuth, ABAC, GraphQL, chaos, webhooks)', () => {
    const c = classify('https://example.com', SAMPLE_README);
    const e = extract(SAMPLE_README);
    const gaps = analyzeGaps(c, e, SAMPLE_README);
    const descriptions = gaps.map((g) => g.description).join(' ').toLowerCase();
    assert.ok(gaps.length > 0);
    // Should detect the missing platform capabilities.
    assert.ok(descriptions.includes('sso') || descriptions.includes('oauth') || descriptions.includes('enterprise'));
    assert.ok(descriptions.includes('abac') || descriptions.includes('rebac'));
    assert.ok(descriptions.includes('graphql'));
  });

  it('assigns severity and value', () => {
    const c = classify('https://example.com', SAMPLE_README);
    const e = extract(SAMPLE_README);
    const gaps = analyzeGaps(c, e, SAMPLE_README);
    assert.ok(gaps.every((g) => ['info', 'warning', 'critical'].includes(g.severity)));
    assert.ok(gaps.every((g) => ['low', 'medium', 'high', 'strategic'].includes(g.estimatedValue)));
  });
});

describe('LinkIntelligenceModule — full pipeline (kernel integration)', () => {
  let kernel: Kernel;
  let mod: LinkIntelligenceModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new LinkIntelligenceModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('processes a link end-to-end: classify → extract → gaps → proposals', async () => {
    let classified = 0; let gapsDetected = 0;
    kernel.bus.on(LinkIntelEvents.Classified, () => { classified++; });
    kernel.bus.on(LinkIntelEvents.GapsDetected, () => { gapsDetected++; });

    const result = await mod.processLink('https://github.com/awesome/project', SAMPLE_README);

    assert.equal(result.url, 'https://github.com/awesome/project');
    assert.equal(result.classification.sourceType, 'github');
    assert.ok(result.extract);
    assert.ok(result.gaps.length > 0);
    assert.ok(result.proposals.length > 0);
    assert.ok(result.proposals.every((p) => p.status === 'proposed' || p.status === 'approved' || p.status === 'rejected'));

    await new Promise((r) => setImmediate(r));
    assert.ok(classified >= 1);
    assert.ok(gapsDetected >= 1);
  });

  it('stores knowledge in memory when available', async () => {
    // Register memory module and re-process.
    const { DigitalMemoryModule } = await import('@jataqi/memory');
    const { StorageModule } = await import('@jataqi/storage');
    const k2 = createTestKernel();
    k2.register(new StorageModule());
    k2.register(new DigitalMemoryModule());
    const mod2 = new LinkIntelligenceModule();
    k2.register(mod2);
    await k2.boot();
    const result = await mod2.processLink('https://github.com/test/repo', SAMPLE_README);
    assert.equal(result.memoryStored, true);
    await k2.shutdown();
  });

  it('processes links without content (classification only)', async () => {
    const result = await mod.processLink('https://www.npmjs.com/package/express');
    assert.equal(result.classification.sourceType, 'npm');
    assert.equal(result.extract, undefined);
    assert.equal(result.gaps.length, 0); // no content → no extraction → no gaps
  });

  it('batch-processes multiple links', async () => {
    const results = await mod.processLinks([
      { url: 'https://github.com/a/b', content: SAMPLE_README },
      { url: 'https://www.npmjs.com/package/react' },
    ]);
    assert.equal(results.length, 2);
  });

  it('provides a summary', () => {
    const s = mod.summary();
    assert.ok(s.totalLinks >= 2);
    assert.ok(s.totalGaps > 0);
    assert.ok(s.totalProposals > 0);
    assert.ok(s.bySourceType.github >= 1);
  });

  it('validates proposals', () => {
    const results = mod.getResults();
    const firstWithProposals = results.find((r) => r.proposals.length > 0)!;
    const validation = mod.validateProposal(firstWithProposals.proposals[0]!);
    assert.ok(validation.checks.length > 0);
    assert.ok(validation.qualityScore > 0);
  });

  it('submits proposals to self-evolution when available', async () => {
    // Register self-evolution and re-process.
    const { SelfEvolutionModule } = await import('@jataqi/self-evolution');
    const { StorageModule } = await import('@jataqi/storage');
    const k2 = createTestKernel();
    k2.register(new StorageModule());
    k2.register(new SelfEvolutionModule());
    const mod2 = new LinkIntelligenceModule();
    k2.register(mod2);
    await k2.boot();
    const result = await mod2.processLink('https://github.com/x/y', SAMPLE_README);
    if (result.proposals.length > 0) {
      const evoId = await mod2.submitForEvolution(result.proposals[0]!, 'link-intel-agent');
      assert.ok(evoId); // self-evolution accepted the proposal
    }
    await k2.shutdown();
  });
});
