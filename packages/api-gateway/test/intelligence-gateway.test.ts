// Gateway integration tests for the CLP + Phase 2–5 module wave:
// digital memory, continuous learning, AI learning, design system, branding,
// universal wallet, crypto, adaptive dashboard, link intelligence, and
// multimodal intelligence — all exposed over the HTTP gateway.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, EchoLLM } from '@jataqi/agent-runtime';
import { QiLModule } from '@jataqi/qil';
import { SecurityModule } from '@jataqi/security';
import { OrchestratorModule } from '@jataqi/orchestrator';
import { DigitalMemoryModule } from '@jataqi/memory';
import { ContinuousLearningModule } from '@jataqi/learning';
import { AiLearningModule } from '@jataqi/ai-learning';
import { DesignSystemModule } from '@jataqi/design-system';
import { BrandingModule } from '@jataqi/branding';
import { UniversalWalletModule } from '@jataqi/universal-wallet';
import { CryptoModule } from '@jataqi/crypto';
import { DashboardModule } from '@jataqi/dashboard';
import { LinkIntelligenceModule } from '@jataqi/link-intelligence';
import { MultimodalIntelligenceModule } from '@jataqi/multimodal-intelligence';
import { ConversationsModule } from '@jataqi/conversations';
import { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import { SearchModule } from '@jataqi/search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { ApiGatewayModule } from '../src/index.js';
import type { GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

async function jsonRequest(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as Record<string, unknown> };
}

describe('ApiGatewayModule (CLP + Phase 2–5 intelligence routes)', () => {
  let kernel: Kernel;
  let gateway: ApiGatewayModule;
  let handle: GatewayHandle;
  let base: string;
  let token = '';

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
    kernel.register(new ContinuousLearningModule());
    kernel.register(new AiLearningModule());
    kernel.register(new DesignSystemModule());
    kernel.register(new BrandingModule());
    kernel.register(new UniversalWalletModule());
    kernel.register(new CryptoModule());
    kernel.register(new DashboardModule());
    kernel.register(new LinkIntelligenceModule());
    kernel.register(new MultimodalIntelligenceModule());
    kernel.register(new ConversationsModule());
    kernel.register(new ToolIntelligenceModule());
    kernel.register(new SearchModule());
    gateway = new ApiGatewayModule();
    kernel.register(gateway);
    await kernel.boot();

    handle = await gateway.listen({ port: 0 });
    base = `http://127.0.0.1:${handle.port}`;

    const login = await jsonRequest('POST', `${base}/auth/login`, { username: 'admin', password: 'admin' });
    assert.equal(login.status, 200);
    token = (login.body as { token: string }).token;
  });

  after(async () => {
    await handle.close();
    await kernel.shutdown();
  });

  // --- Digital Memory -----------------------------------------------------

  it('POST /memory records a governed event and GET /memory queries it', async () => {
    const rec = await jsonRequest('POST', `${base}/memory`, {
      category: 'feature_usage', summary: 'user opened dashboard',
      userId: 'u1', orgId: 'org1', tags: ['dashboard'],
    }, token);
    assert.equal(rec.status, 201);
    const event = (rec.body as { event: { id: string; summary: string } }).event;
    assert.equal(event.summary, 'user opened dashboard');

    const q = await jsonRequest('GET', `${base}/memory?orgId=org1&userId=u1`, undefined, token);
    assert.equal(q.status, 200);
    const body = q.body as { events: unknown[]; count: number };
    assert.ok(body.count >= 1);
    assert.ok(body.events.some((e) => (e as { id: string }).id === event.id));
  });

  it('GET /memory/stats and POST /memory/sweep work', async () => {
    const stats = await jsonRequest('GET', `${base}/memory/stats`, undefined, token);
    assert.equal(stats.status, 200);
    const sweep = await jsonRequest('POST', `${base}/memory/sweep`, {}, token);
    assert.equal(sweep.status, 200);
    assert.equal(typeof (sweep.body as { swept: number }).swept, 'number');
  });

  it('POST /memory requires category + summary', async () => {
    const res = await jsonRequest('POST', `${base}/memory`, { summary: 'missing category' }, token);
    assert.equal(res.status, 400);
  });

  // --- Continuous Learning ------------------------------------------------

  it('POST /learning/analyze derives insights and recommendations from memory', async () => {
    const res = await jsonRequest('POST', `${base}/learning/analyze`, { orgId: 'org1' }, token);
    assert.equal(res.status, 200);
    const body = res.body as { insights: unknown[]; recommendations: unknown[]; summary: { totalEvents: number } };
    assert.ok(Array.isArray(body.insights));
    assert.ok(Array.isArray(body.recommendations));
    assert.equal(typeof body.summary.totalEvents, 'number');
  });

  it('GET /learning/insights + /learning/recommendations and review flow', async () => {
    const insights = await jsonRequest('GET', `${base}/learning/insights?orgId=org1`, undefined, token);
    assert.equal(insights.status, 200);

    const recs = await jsonRequest('GET', `${base}/learning/recommendations?orgId=org1`, undefined, token);
    assert.equal(recs.status, 200);
    const list = (recs.body as { recommendations: Array<{ id: string }> }).recommendations;
    if (list.length > 0) {
      const reviewed = await jsonRequest('POST', `${base}/learning/recommendation/review`,
        { id: list[0].id, decision: 'accepted', reviewer: 'admin' }, token);
      assert.equal(reviewed.status, 200);
      const deployed = await jsonRequest('POST', `${base}/learning/recommendation/deploy`, { id: list[0].id }, token);
      assert.equal(deployed.status, 200);
    }
  });

  it('POST /learning/preference and GET /learning/adaptation', async () => {
    const pref = await jsonRequest('POST', `${base}/learning/preference`, { userId: 'u1', key: 'theme', value: 'dark' }, token);
    assert.equal(pref.status, 200);
    const adapt = await jsonRequest('GET', `${base}/learning/adaptation?userId=u1`, undefined, token);
    assert.equal(adapt.status, 200);
  });

  // --- AI Learning Platform -----------------------------------------------

  it('prompt lifecycle: create → version → approve → activate → render', async () => {
    const created = await jsonRequest('POST', `${base}/ai-learning/prompts`, {
      name: 'qa-summarizer', content: 'Summarize {{topic}}', category: 'research',
    }, token);
    assert.equal(created.status, 201);
    const template = (created.body as { prompt: { id: string } }).prompt;

    const v2 = await jsonRequest('POST', `${base}/ai-learning/prompts/version`, {
      templateId: template.id, content: 'Please summarize {{topic}} concisely', notes: 'tighter',
    }, token);
    assert.equal(v2.status, 201);
    const version = (v2.body as { version: { id: string } }).version;

    const approved = await jsonRequest('POST', `${base}/ai-learning/prompts/approve`,
      { templateId: template.id, versionId: version.id, approver: 'admin' }, token);
    assert.equal(approved.status, 200);

    const activated = await jsonRequest('POST', `${base}/ai-learning/prompts/activate`,
      { templateId: template.id, versionId: version.id }, token);
    assert.equal(activated.status, 200);

    const rendered = await jsonRequest('GET',
      `${base}/ai-learning/prompts/render?templateId=${template.id}&vars=${encodeURIComponent(JSON.stringify({ topic: 'Q3' }))}`,
      undefined, token);
    assert.equal(rendered.status, 200);
    assert.match((rendered.body as { text: string }).text, /Q3/);
  });

  it('POST /ai-learning/outcomes + GET /ai-learning/metrics + benchmarks + drift', async () => {
    const out = await jsonRequest('POST', `${base}/ai-learning/outcomes`, {
      model: 'gpt-4o-mini', provider: 'openai', outcome: 'accepted', latencyMs: 800, rating: 5, tokensIn: 100, tokensOut: 50,
    }, token);
    assert.equal(out.status, 201);

    const metrics = await jsonRequest('GET', `${base}/ai-learning/metrics?model=gpt-4o-mini`, undefined, token);
    assert.equal(metrics.status, 200);
    assert.equal((metrics.body as { metrics: { total: number } }).metrics.total, 1);

    const bench = await jsonRequest('GET', `${base}/ai-learning/benchmarks`, undefined, token);
    assert.equal(bench.status, 200);
    assert.ok(Array.isArray((bench.body as { benchmarks: unknown[] }).benchmarks));

    const drift = await jsonRequest('POST', `${base}/ai-learning/drift`, {}, token);
    assert.equal(drift.status, 200);
    assert.ok(Array.isArray((drift.body as { alerts: unknown[] }).alerts));
  });

  // --- Design system + branding -------------------------------------------

  it('GET /design-system/tokens + /design-system/css honor mode/brand', async () => {
    const tokens = await jsonRequest('GET', `${base}/design-system/tokens?mode=light`, undefined, token);
    assert.equal(tokens.status, 200);
    assert.equal((tokens.body as { mode: string }).mode, 'light');

    const css = await jsonRequest('GET', `${base}/design-system/css`, undefined, token);
    assert.equal(css.status, 200);
    assert.match((css.body as { css: string }).css, /:root/);
  });

  it('POST /design-system/adaptive resolves the theme', async () => {
    const res = await jsonRequest('POST', `${base}/design-system/adaptive`, { preference: 'dark', hour: 10 }, token);
    assert.equal(res.status, 200);
    assert.equal((res.body as { mode: string }).mode, 'dark');
  });

  it('branding: products, brand kit, logo, app icon, business card', async () => {
    const products = await jsonRequest('GET', `${base}/branding/products`, undefined, token);
    assert.equal(products.status, 200);
    assert.ok((products.body as { products: string[] }).products.length >= 15);

    const brand = await jsonRequest('GET', `${base}/branding/brand?productId=jata-qi`, undefined, token);
    assert.equal(brand.status, 200);
    assert.equal((brand.body as { brand: { productId: string } }).brand.productId, 'jata-qi');

    const logo = await jsonRequest('POST', `${base}/branding/logo`, { productId: 'jata-qi' }, token);
    assert.equal(logo.status, 200);
    assert.match((logo.body as { logo: { content: string } }).logo.content, /<svg/);

    const icon = await jsonRequest('POST', `${base}/branding/app-icon`, { productId: 'tanya-ai', size: 512 }, token);
    assert.equal(icon.status, 200);

    const card = await jsonRequest('POST', `${base}/branding/business-card`, {
      productId: 'jata-qi',
      card: {
        name: 'Ada Lovelace', title: 'CEO', email: 'ada@jataqi.ai', company: 'JATA Qi',
        backgroundColor: '#0c0e1a', textColor: '#e7e9f5', accentColor: '#5b5bd6',
      },
    }, token);
    assert.equal(card.status, 200);
    assert.match((card.body as { card: string }).card, /Ada Lovelace/);
  });

  // --- Universal wallet ---------------------------------------------------

  it('wallet: open → deposit → transfer → balance → ledger', async () => {
    const opened = await jsonRequest('POST', `${base}/wallet/open`, { ownerId: 'alice', role: 'creator' }, token);
    assert.equal(opened.status, 201);
    const wallet = (opened.body as { wallet: { id: string; balances: Record<string, string> } }).wallet;
    assert.ok(wallet.id);

    const opened2 = await jsonRequest('POST', `${base}/wallet/open`, { ownerId: 'bob', role: 'marketplace' }, token);
    assert.equal(opened2.status, 201);
    const wallet2 = (opened2.body as { wallet: { id: string } }).wallet;

    const dep = await jsonRequest('POST', `${base}/wallet/deposit`,
      { walletId: wallet.id, currency: 'KES', amount: '100000', description: 'seed' }, token);
    assert.equal(dep.status, 201);

    const tx = await jsonRequest('POST', `${base}/wallet/transfer`,
      { from: wallet.id, to: wallet2.id, currency: 'KES', amount: '25000', description: 'payout' }, token);
    assert.equal(tx.status, 201);
    assert.equal((tx.body as { transaction: { status: string } }).transaction.status, 'settled');

    const bal = await jsonRequest('GET', `${base}/wallet/balance?walletId=${wallet.id}&currency=KES`, undefined, token);
    assert.equal(bal.status, 200);
    assert.equal((bal.body as { balance: string }).balance, '75000');

    const bal2 = await jsonRequest('GET', `${base}/wallet/balance?walletId=${wallet2.id}&currency=KES`, undefined, token);
    assert.equal((bal2.body as { balance: string }).balance, '25000');

    const ledger = await jsonRequest('GET', `${base}/wallet/ledger?walletId=${wallet.id}`, undefined, token);
    assert.equal(ledger.status, 200);
    assert.equal((ledger.body as { count: number }).count, 2);

    const summary = await jsonRequest('GET', `${base}/wallet/summary`, undefined, token);
    assert.equal(summary.status, 200);
    assert.equal((summary.body as { ledgerBalanced: boolean }).ledgerBalanced, true);
  });

  it('wallet: invalid amount is rejected', async () => {
    const res = await jsonRequest('POST', `${base}/wallet/deposit`,
      { walletId: 'missing', currency: 'KES', amount: 'not-a-number', description: 'x' }, token);
    assert.equal(res.status, 400);
  });

  // --- KRT crypto platform ------------------------------------------------

  it('crypto: register asset → mint → balance → transfer → summary', async () => {
    const reg = await jsonRequest('POST', `${base}/crypto/assets`, {
      symbol: 'KRT', name: 'KRT Token', type: 'fungible', decimals: 2, totalSupply: '100000000', chain: 'native',
    }, token);
    assert.equal(reg.status, 201);
    assert.equal((reg.body as { asset: { symbol: string } }).asset.symbol, 'KRT');

    const mint = await jsonRequest('POST', `${base}/crypto/mint`, { to: 'addr-1', symbol: 'KRT', amount: '5000' }, token);
    assert.equal(mint.status, 201);

    const bal = await jsonRequest('GET', `${base}/crypto/balance?address=addr-1&symbol=KRT`, undefined, token);
    assert.equal(bal.status, 200);
    assert.equal((bal.body as { balance: string }).balance, '5000');

    const transfer = await jsonRequest('POST', `${base}/crypto/transfer`,
      { from: 'addr-1', to: 'addr-2', symbol: 'KRT', amount: '2000' }, token);
    assert.equal(transfer.status, 201);

    const list = await jsonRequest('GET', `${base}/crypto/assets?symbol=KRT`, undefined, token);
    assert.equal(list.status, 200);
    assert.equal((list.body as { assets: unknown[] }).assets.length, 1);

    const summary = await jsonRequest('GET', `${base}/crypto/summary`, undefined, token);
    assert.equal(summary.status, 200);
    assert.ok((summary.body as { summary: { transactions: number } }).summary.transactions >= 2);
  });

  it('crypto: NFT mint + stake + quote + swap', async () => {
    // NFT collections must be registered as non-fungible assets first; the
    // mint keys off the returned asset id.
    const regNft = await jsonRequest('POST', `${base}/crypto/assets`, {
      symbol: 'ART', name: 'ART Collection', type: 'non_fungible', decimals: 0, totalSupply: '1000', chain: 'native',
    }, token);
    assert.equal(regNft.status, 201);
    const collectionId = (regNft.body as { asset: { id: string } }).asset.id;

    const nft = await jsonRequest('POST', `${base}/crypto/nft/mint`,
      { collectionId, to: 'addr-1', tokenURI: 'ipfs://art/1' }, token);
    assert.equal(nft.status, 201);
    assert.equal((nft.body as { nft: { collectionId: string } }).nft.collectionId, collectionId);

    const stake = await jsonRequest('POST', `${base}/crypto/stake`,
      { staker: 'addr-1', assetSymbol: 'KRT', amount: '1000', apr: 0.08, lockupDays: 30 }, token);
    assert.equal(stake.status, 201);

    const quote = await jsonRequest('POST', `${base}/crypto/quote`, { from: 'KRT', to: 'KRT', amount: '100' }, token);
    assert.equal(quote.status, 200);
    const q = (quote.body as { quote: unknown }).quote;
    const swap = await jsonRequest('POST', `${base}/crypto/swap`, { quote: q, fromAddress: 'addr-1' }, token);
    assert.equal(swap.status, 200);
  });

  // --- Adaptive dashboard -------------------------------------------------

  it('dashboard: create layout → add widgets → adapt → analytics', async () => {
    const created = await jsonRequest('POST', `${base}/dashboard/layouts`,
      { name: 'Ops', ownerId: 'u1', role: 'admin', orgId: 'org1' }, token);
    assert.equal(created.status, 201);
    const layout = (created.body as { layout: { id: string } }).layout;

    const added = await jsonRequest('POST', `${base}/dashboard/widgets`,
      { layoutId: layout.id, widgetDefId: 'kpi-revenue', size: 'wide' }, token);
    assert.equal(added.status, 201);

    const adapted = await jsonRequest('POST', `${base}/dashboard/adapt`,
      { layoutId: layout.id, userId: 'u1', role: 'admin' }, token);
    assert.equal(adapted.status, 200);
    assert.ok((adapted.body as { applied: number }).applied > 0);

    const layouts = await jsonRequest('GET', `${base}/dashboard/layouts?ownerId=u1`, undefined, token);
    assert.equal(layouts.status, 200);
    assert.equal((layouts.body as { count: number }).count, 1);

    const widgets = await jsonRequest('GET', `${base}/dashboard/widgets`, undefined, token);
    assert.equal(widgets.status, 200);
    assert.ok((widgets.body as { count: number }).count > 0);

    const analytics = await jsonRequest('GET', `${base}/dashboard/analytics`, undefined, token);
    assert.equal(analytics.status, 200);
    assert.equal((analytics.body as { analytics: { totalLayouts: number } }).analytics.totalLayouts, 1);
  });

  // --- Link intelligence --------------------------------------------------

  it('POST /link/process classifies a link and GET /link/summary aggregates', async () => {
    const res = await jsonRequest('POST', `${base}/link/process`, {
      url: 'https://github.com/openai/evals',
      content: 'A framework for evaluating AI models with standardized benchmarks and test suites.',
    }, token);
    assert.equal(res.status, 201);
    const result = res.body as { result: { url: string; classification: { sourceType: string } } };
    assert.equal(result.result.url, 'https://github.com/openai/evals');

    const summary = await jsonRequest('GET', `${base}/link/summary`, undefined, token);
    assert.equal(summary.status, 200);
    assert.ok((summary.body as { summary: { totalLinks: number } }).summary.totalLinks >= 1);
  });

  // --- Multimodal intelligence --------------------------------------------

  it('multimodal: register source → authorize → acquire → list', async () => {
    const reg = await jsonRequest('POST', `${base}/multimodal/sources`,
      { modality: 'web', name: 'Company Wiki', requiresAuth: true, config: { url: 'https://wiki.example.com' } }, token);
    assert.equal(reg.status, 201);
    const source = (reg.body as { source: { id: string } }).source;

    const authz = await jsonRequest('POST', `${base}/multimodal/sources/authorize`,
      { sourceId: source.id, grantedBy: 'admin', scope: 'read', legalBasis: 'consent' }, token);
    assert.equal(authz.status, 200);

    const acquire = await jsonRequest('POST', `${base}/multimodal/acquire`,
      { sourceId: source.id, content: 'JATA Qi is a modular AI operating system.' }, token);
    assert.equal(acquire.status, 200);
    assert.equal((acquire.body as { result: { modality: string } }).result.modality, 'web');

    const direct = await jsonRequest('POST', `${base}/multimodal/acquire`,
      { modality: 'text', content: 'hello world', name: 'note' }, token);
    assert.equal(direct.status, 200);
    assert.equal((direct.body as { result: { modality: string } }).result.modality, 'text');

    const list = await jsonRequest('GET', `${base}/multimodal/sources?modality=web`, undefined, token);
    assert.equal(list.status, 200);
    assert.equal((list.body as { count: number }).count, 1);
  });

  // --- CLP Phase 4 — prompt experiments via gateway -----------------------

  it('experiment lifecycle over HTTP: create → outcomes → evaluate → conclude', async () => {
    const created = await jsonRequest('POST', `${base}/ai-learning/prompts`, {
      name: 'gateway-exp', content: 'Answer {{topic}}', category: 'research',
    }, token);
    const template = (created.body as { prompt: { id: string; versions: Array<{ id: string }> } }).prompt;
    const v1 = template.versions[0]!.id;
    await jsonRequest('POST', `${base}/ai-learning/prompts/approve`, { templateId: template.id, versionId: v1, approver: 'admin' }, token);
    await jsonRequest('POST', `${base}/ai-learning/prompts/activate`, { templateId: template.id, versionId: v1 }, token);
    const v2res = await jsonRequest('POST', `${base}/ai-learning/prompts/version`, { templateId: template.id, content: 'Answer {{topic}} concisely' }, token);
    const v2 = (v2res.body as { version: { id: string } }).version.id;
    await jsonRequest('POST', `${base}/ai-learning/prompts/approve`, { templateId: template.id, versionId: v2, approver: 'admin' }, token);

    const exp = await jsonRequest('POST', `${base}/ai-learning/experiments`, {
      templateId: template.id, challengerVersionId: v2, createdBy: 'admin', minOutcomes: 4, minAcceptanceGain: 0.1,
    }, token);
    assert.equal(exp.status, 201);
    const expId = (exp.body as { experiment: { id: string } }).experiment.id;

    // Record 5 accepted champion + 5 accepted challenger outcomes (challenger better).
    for (let i = 0; i < 5; i++) {
      await jsonRequest('POST', `${base}/ai-learning/outcomes`, { promptTemplateId: template.id, promptVersionId: v1, model: 'm', provider: 'p', outcome: 'accepted', latencyMs: 10, rating: 4 }, token);
    }
    for (let i = 0; i < 5; i++) {
      await jsonRequest('POST', `${base}/ai-learning/outcomes`, { promptTemplateId: template.id, promptVersionId: v2, model: 'm', provider: 'p', outcome: 'accepted', latencyMs: 10, rating: 5 }, token);
    }

    const evaluated = await jsonRequest('POST', `${base}/ai-learning/experiments/evaluate`, { id: expId }, token);
    assert.equal(evaluated.status, 200);
    assert.equal((evaluated.body as { decision: string }).decision, 'keep'); // no measurable gain (both 100%)

    // Drop the challenger to a 0% acceptance rate → regression.
    for (let i = 0; i < 5; i++) {
      await jsonRequest('POST', `${base}/ai-learning/outcomes`, { promptTemplateId: template.id, promptVersionId: v2, model: 'm', provider: 'p', outcome: 'rejected', latencyMs: 10, rating: 1 }, token);
    }
    const evaluated2 = await jsonRequest('POST', `${base}/ai-learning/experiments/evaluate`, { id: expId }, token);
    assert.equal((evaluated2.body as { decision: string }).decision, 'regression');

    const concluded = await jsonRequest('POST', `${base}/ai-learning/experiments/conclude`, { id: expId }, token);
    assert.equal((concluded.body as { experiment: { status: string } }).experiment.status, 'concluded');

    const listed = await jsonRequest('GET', `${base}/ai-learning/experiments?status=concluded`, undefined, token);
    assert.equal(listed.status, 200);
    assert.ok((listed.body as { count: number }).count >= 1);
  });

  // --- CLP Phase 5 — knowledge distillation via gateway -------------------

  it('POST /learning/distill produces lessons + playbooks; GET reads work', async () => {
    // Seed memory + analyze so insights and recommendations exist. 30 events
    // put the feature-adoption insight at the 0.6 distillation confidence.
    for (let i = 0; i < 30; i++) {
      await jsonRequest('POST', `${base}/memory`, { category: 'search', summary: `gateway search ${i}`, userId: 'u1', orgId: 'org-d' }, token);
    }
    const analyzed = await jsonRequest('POST', `${base}/learning/analyze`, { orgId: 'org-d' }, token);
    assert.equal(analyzed.status, 200);

    const distilled = await jsonRequest('POST', `${base}/learning/distill`, { orgId: 'org-d' }, token);
    assert.equal(distilled.status, 200);
    assert.ok((distilled.body as { stats: { lessons: number } }).stats.lessons >= 1);

    const lessons = await jsonRequest('GET', `${base}/learning/lessons`, undefined, token);
    assert.equal(lessons.status, 200);
    assert.ok((lessons.body as { count: number }).count >= 1);

    const stats = await jsonRequest('GET', `${base}/learning/distill-stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.ok((stats.body as { stats: { documentsIngested: number } }).stats.documentsIngested >= 1);

    // The distilled lesson is now retrievable through the knowledge service.
    const knowledge = kernel.getModule<KnowledgeService>('knowledge');
    const hits = await knowledge.retrieve('High adoption', { topK: 3 });
    assert.ok(hits.length >= 1);
  });

  // --- Phase 6 — Universal Search via gateway -----------------------------

  it('GET /search federates across sources with facets', async () => {
    const knowledge = kernel.getModule<KnowledgeService>('knowledge');
    await knowledge.ingestText('JATA Qi unified search indexes the entire platform.', { title: 'Search docs' });

    const res = await jsonRequest('GET', `${base}/search?q=search&orgId=org-d`, undefined, token);
    assert.equal(res.status, 200);
    const body = res.body as { hits: Array<{ source: string; title: string }>; facets: { source: Record<string, number> } };
    assert.ok(body.hits.length >= 1);
    assert.ok(body.hits.some((h) => h.source === 'knowledge'));
    assert.ok((body.facets.source.knowledge ?? 0) >= 1);
  });

  it('GET /search/suggest + POST /search/history + GET /search/stats', async () => {
    const suggest = await jsonRequest('GET', `${base}/search/suggest?q=search`, undefined, token);
    assert.equal(suggest.status, 200);
    assert.ok((suggest.body as { suggestions: unknown[] }).suggestions.length >= 1);

    const recorded = await jsonRequest('POST', `${base}/search/history`, { query: 'vector search', userId: 'u1', orgId: 'org-d' }, token);
    assert.equal(recorded.status, 201);
    assert.equal((recorded.body as { recorded: boolean }).recorded, true);

    const history = await jsonRequest('GET', `${base}/search/history?userId=u1&orgId=org-d`, undefined, token);
    assert.equal(history.status, 200);
    assert.ok((history.body as { count: number }).count >= 1);

    const stats = await jsonRequest('GET', `${base}/search/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.ok((stats.body as { stats: { adapters: string[] } }).stats.adapters.length >= 4);
  });

  // --- Authz guard --------------------------------------------------------

  it('intelligence routes reject unauthenticated requests', async () => {
    const res = await jsonRequest('GET', `${base}/memory`, undefined);
    assert.equal(res.status, 401);
  });
});
