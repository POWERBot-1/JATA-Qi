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
import { AutomationModule } from '@jataqi/automation';
import { FxModule } from '@jataqi/fx';
import { PkiModule } from '@jataqi/pki';
import { MobilityModule } from '@jataqi/mobility';
import { LogisticsModule } from '@jataqi/logistics';
import { AgricultureModule } from '@jataqi/agriculture';
import { CircularModule } from '@jataqi/circular';
import { EnergyModule } from '@jataqi/energy';
import { BorderModule } from '@jataqi/border';
import { RestaurantsModule } from '@jataqi/restaurants';
import { MarketplaceModule } from '@jataqi/marketplace';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { ApiGatewayModule } from '../src/index.js';
import type { GatewayHandle } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

async function jsonRequest(method: string, url: string, body?: unknown, token?: string, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
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
    kernel.register(new AutomationModule({ tickIntervalMs: 0 }));
    kernel.register(new FxModule({ anchor: 'USD' }));
    kernel.register(new PkiModule({ issuer: 'https://id.test.local' }));
    kernel.register(new MobilityModule());
    kernel.register(new LogisticsModule());
    kernel.register(new AgricultureModule());
    kernel.register(new CircularModule());
    kernel.register(new EnergyModule());
    kernel.register(new BorderModule());
    kernel.register(new RestaurantsModule());
    kernel.register(new MarketplaceModule());
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

  // --- Phase 6 — SOMA AI Automation via gateway ---------------------------

  it('automation CRUD + manual run + executions + stats over HTTP', async () => {
    const created = await jsonRequest('POST', `${base}/automations`, {
      name: 'gateway automation', trigger: { type: 'manual' },
      actions: [{ type: 'memory.record', params: { summary: 'ran from gateway', category: 'automation', orgId: 'org-gw' } }],
    }, token);
    assert.equal(created.status, 201);
    const automation = (created.body as { automation: { id: string; name: string } }).automation;
    assert.equal(automation.name, 'gateway automation');

    const listed = await jsonRequest('GET', `${base}/automations`, undefined, token);
    assert.equal(listed.status, 200);
    assert.ok((listed.body as { count: number }).count >= 1);

    const fetched = await jsonRequest('GET', `${base}/automation?id=${automation.id}`, undefined, token);
    assert.equal(fetched.status, 200);

    const run = await jsonRequest('POST', `${base}/automations/run`, { automationId: automation.id }, token);
    assert.equal(run.status, 200);
    const execution = (run.body as { execution: { status: string; results: unknown[] } }).execution;
    assert.equal(execution.status, 'succeeded');
    assert.equal(execution.results.length, 1);

    const executions = await jsonRequest('GET', `${base}/automations/executions?automationId=${automation.id}`, undefined, token);
    assert.equal(executions.status, 200);
    assert.equal((executions.body as { count: number }).count, 1);

    const stats = await jsonRequest('GET', `${base}/automations/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.ok((stats.body as { stats: { succeeded: number } }).stats.succeeded >= 1);

    // The memory action actually landed in the DME.
    const memory = kernel.getModule<DigitalMemoryModule>('memory');
    assert.equal(memory.query({ category: 'automation', orgId: 'org-gw' }).length, 1);

    // Enable/disable + remove.
    const disabled = await jsonRequest('POST', `${base}/automations/status`, { id: automation.id, enabled: false }, token);
    assert.equal(disabled.status, 200);
    assert.equal((disabled.body as { automation: { enabled: boolean } }).automation.enabled, false);

    const removed = await jsonRequest('POST', `${base}/automations/remove`, { id: automation.id }, token);
    assert.equal(removed.status, 200);
    assert.equal((removed.body as { removed: boolean }).removed, true);
  });

  it('automation routes reject unauthenticated requests', async () => {
    const res = await jsonRequest('GET', `${base}/automations`, undefined);
    assert.equal(res.status, 401);
  });

  // --- Phase 6 — KARIS FX + PRX Part C PKI via gateway --------------------

  it('fx: set rate → convert → history → analytics → stats over HTTP', async () => {
    const set = await jsonRequest('POST', `${base}/fx/rates`, { base: 'USD', quote: 'KES', bid: 128.5, ask: 129.0, source: 'test' }, token);
    assert.equal(set.status, 201);
    assert.equal((set.body as { quote: { pair: string } }).quote.pair, 'USD/KES');

    const conv = await jsonRequest('POST', `${base}/fx/convert`, { from: 'USD', to: 'KES', amount: '10000' }, token);
    assert.equal(conv.status, 200);
    const result = (conv.body as { result: { result: string; rate: number } }).result;
    assert.equal(result.result, '1287500');

    const rates = await jsonRequest('GET', `${base}/fx/rates`, undefined, token);
    assert.equal(rates.status, 200);
    assert.equal((rates.body as { count: number }).count, 1);

    const history = await jsonRequest('GET', `${base}/fx/history?pair=USD/KES`, undefined, token);
    assert.equal(history.status, 200);
    assert.equal((history.body as { count: number }).count, 1);

    const analytics = await jsonRequest('GET', `${base}/fx/analytics?pair=USD/KES`, undefined, token);
    assert.equal(analytics.status, 200);
    assert.equal((analytics.body as { analytics: { pair: string } }).analytics.pair, 'USD/KES');

    const stats = await jsonRequest('GET', `${base}/fx/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.ok((stats.body as { stats: { pairs: number } }).stats.pairs >= 1);
  });

  it('pki: root CA → intermediate → issue → revoke → CRL over HTTP', async () => {
    const root = await jsonRequest('POST', `${base}/pki/ca/root`, {
      subject: [{ oid: '2.5.4.3', value: 'GW Root' }],
    }, token);
    assert.equal(root.status, 201);
    const rootCa = (root.body as { ca: { id: string; certDer: string } }).ca;

    const sub = await jsonRequest('POST', `${base}/pki/ca/intermediate`, {
      subject: [{ oid: '2.5.4.3', value: 'GW Sub' }], issuerId: rootCa.id,
    }, token);
    assert.equal(sub.status, 201);
    const subCa = (sub.body as { ca: { id: string } }).ca;

    // Issue needs a JWK — generate one via the module API directly on the kernel.
    const pki = kernel.getModule<PkiModule>('pki');
    const key = (await import('@jataqi/pki')).generateKeyPair('ec-p256');
    const issued = await jsonRequest('POST', `${base}/pki/certificates`, {
      caId: subCa.id,
      subject: [{ oid: '2.5.4.3', value: 'secure.example.com' }],
      sanDnsNames: ['secure.example.com'],
      subjectPublicKeyJwk: key.jwk,
    }, token);
    assert.equal(issued.status, 201);
    const cert = (issued.body as { certificate: { id: string } }).certificate;

    // Cross-validate the issued certificate chain with OpenSSL via the module.
    assert.equal(pki.ca.verifySignature(cert.id, subCa.id), true);

    const list = await jsonRequest('GET', `${base}/pki/certificates`, undefined, token);
    assert.equal(list.status, 200);
    assert.ok((list.body as { count: number }).count >= 1);

    const revoked = await jsonRequest('POST', `${base}/pki/certificates/revoke`, { id: cert.id, reason: 'keyCompromise' }, token);
    assert.equal(revoked.status, 200);
    assert.equal((revoked.body as { certificate: { status: string } }).certificate.status, 'revoked');

    const crl = await jsonRequest('GET', `${base}/pki/crl?caId=${subCa.id}`, undefined, token);
    assert.equal(crl.status, 200);
    assert.equal((crl.body as { crl: { revokedCount: number } }).crl.revokedCount, 1);
  });

  it('pki: RA domain validation + IdP client/code/token flow over HTTP', async () => {
    const pki = kernel.getModule<PkiModule>('pki');
    const key = (await import('@jataqi/pki')).generateKeyPair('ec-p256');
    const created = await jsonRequest('POST', `${base}/pki/ra/requests`, {
      domains: ['ra.example.com'], publicKeyJwk: key.jwk, method: 'dns-txt',
    }, token);
    assert.equal(created.status, 201);
    const req = (created.body as { request: { id: string; proof: { value: string } } }).request;
    assert.match(req.proof.value, /_jataqi-pki-validation/);
    // Extract the token from the proof location and validate with it.
    const tokenMatch = req.proof.value.match(/"([0-9a-f]+)"/);
    assert.ok(tokenMatch, 'proof should expose the token');

    const validated = await jsonRequest('POST', `${base}/pki/ra/validate`, {
      id: req.id, location: '_jataqi-pki-validation.ra.example.com', token: tokenMatch![1]!,
    }, token);
    assert.equal((validated.body as { request: { status: string } }).request.status, 'validated');

    const approved = await jsonRequest('POST', `${base}/pki/ra/approve`, { id: req.id }, token);
    assert.equal((approved.body as { request: { status: string } }).request.status, 'approved');

    // IdP: client → authorize → token → userinfo.
    const client = await jsonRequest('POST', `${base}/pki/idp/clients`, {
      name: 'gw-app', redirectUris: ['https://gw.example.com/cb'],
    }, token);
    assert.equal(client.status, 201);
    const c = (client.body as { clientId: string; clientSecret: string });
    await pki.idp.upsertUser('gw-user', { name: 'GW User' });

    const authz = await jsonRequest('POST', `${base}/pki/idp/authorize`, {
      clientId: c.clientId, redirectUri: 'https://gw.example.com/cb', userId: 'gw-user',
    }, token);
    const code = (authz.body as { code: string }).code;

    const tok = await jsonRequest('POST', `${base}/pki/idp/token`, {
      code, clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: 'https://gw.example.com/cb',
    }, token);
    assert.equal(tok.status, 200);
    const tokens = tok.body as { access_token: string; id_token: string };
    assert.ok(tokens.access_token);

    const info = await jsonRequest('GET', `${base}/pki/idp/userinfo`, undefined, token, { 'x-idp-token': tokens.access_token });
    assert.equal(info.status, 200);
    assert.equal((info.body as { sub: string }).sub, 'gw-user');

    const intro = await jsonRequest('POST', `${base}/pki/idp/introspect`, { token: tokens.access_token });
    assert.equal((intro.body as { active: boolean }).active, true);

    const discovery = await jsonRequest('GET', `${base}/pki/idp/discovery`);
    assert.equal(discovery.status, 200);
    assert.equal((discovery.body as { issuer: string }).issuer, 'https://id.test.local');
  });

  // --- Phase 7 — MOTO X + PORTLINK via gateway ---------------------------

  it('mobility: vehicle → fleet → trip → status → stats over HTTP', async () => {
    const fleet = await jsonRequest('POST', `${base}/mobility/fleets`, { name: 'City Fleet', ownerId: 'u1' }, token);
    assert.equal(fleet.status, 201);
    const fleetId = (fleet.body as { fleet: { id: string } }).fleet.id;

    const vehicle = await jsonRequest('POST', `${base}/mobility/vehicles`, {
      registration: 'KDD 777X', make: 'Toyota', model: 'Corolla', type: 'car', fleetId,
      location: { lat: -1.2921, lng: 36.8219 },
    }, token);
    assert.equal(vehicle.status, 201);
    const vehicleId = (vehicle.body as { vehicle: { id: string } }).vehicle.id;

    const trip = await jsonRequest('POST', `${base}/mobility/trips`, {
      pickup: { lat: -1.2921, lng: 36.8219 }, dropoff: { lat: -1.2864, lng: 36.8172 }, riderId: 'r1',
    }, token);
    assert.equal(trip.status, 201);
    const tripBody = trip.body as { trip: { id: string; vehicleId?: string; fare: string } };
    assert.equal(tripBody.trip.vehicleId, vehicleId);

    const status = await jsonRequest('POST', `${base}/mobility/trips/status`, { id: tripBody.trip.id, status: 'completed' }, token);
    assert.equal(status.status, 200);
    assert.equal((status.body as { trip: { status: string } }).trip.status, 'completed');

    const telemetry = await jsonRequest('POST', `${base}/mobility/telemetry`, { vehicleId, lat: -1.29, lng: 36.82, speedKmh: 45 }, token);
    assert.equal(telemetry.status, 201);

    const stats = await jsonRequest('GET', `${base}/mobility/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.ok((stats.body as { stats: { vehicles: number } }).stats.vehicles >= 1);
  });

  it('logistics: port → shipment → containers → track → stats over HTTP', async () => {
    const port = await jsonRequest('POST', `${base}/logistics/ports`, { name: 'Mombasa', code: 'MBA', country: 'KE', capacityTeu: 1500000 }, token);
    assert.equal(port.status, 201);

    const shipment = await jsonRequest('POST', `${base}/logistics/shipments`, {
      mode: 'sea', origin: 'Shanghai', destination: 'Mombasa', shipper: 'S', consignee: 'C',
    }, token);
    assert.equal(shipment.status, 201);
    const ship = shipment.body as { shipment: { id: string; trackingRef: string } };

    const container = await jsonRequest('POST', `${base}/logistics/containers`, { number: 'MSCU9988776', type: '40' }, token);
    assert.equal(container.status, 201);
    const containerId = (container.body as { container: { id: string } }).container.id;

    const assigned = await jsonRequest('POST', `${base}/logistics/shipments/containers`, { shipmentId: ship.shipment.id, containerId }, token);
    assert.equal(assigned.status, 200);

    const tracked = await jsonRequest('POST', `${base}/logistics/shipments/track`, { shipmentId: ship.shipment.id, code: 'delivered', location: 'ICD Embakasi' }, token);
    assert.equal(tracked.status, 201);
    assert.equal((tracked.body as { event: { code: string } }).event.code, 'delivered');

    const lookup = await jsonRequest('GET', `${base}/logistics/shipment?ref=${ship.shipment.trackingRef}`, undefined, token);
    assert.equal(lookup.status, 200);
    assert.equal((lookup.body as { shipment: { status: string } }).shipment.status, 'delivered');

    const timeline = await jsonRequest('GET', `${base}/logistics/shipments/timeline?shipmentId=${ship.shipment.id}`, undefined, token);
    assert.equal((timeline.body as { count: number }).count, 1);

    const stats = await jsonRequest('GET', `${base}/logistics/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.equal((stats.body as { stats: { shipments: number } }).stats.shipments, 1);
  });

  it('pki idp login bridge mints a usable platform session over HTTP', async () => {
    const pki = kernel.getModule<PkiModule>('pki');
    const client = await jsonRequest('POST', `${base}/pki/idp/clients`, { name: 'sso', redirectUris: ['https://sso.example.com/cb'] }, token);
    const c = client.body as { clientId: string; clientSecret: string };
    pki.idp.upsertUser('ext-1', { preferred_username: 'bridged', roles: ['analyst'] });
    const authz = await jsonRequest('POST', `${base}/pki/idp/authorize`, { clientId: c.clientId, redirectUri: 'https://sso.example.com/cb', userId: 'ext-1' }, token);
    const code = (authz.body as { code: string }).code;
    const tok = await jsonRequest('POST', `${base}/pki/idp/token`, { code, clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: 'https://sso.example.com/cb' }, token);
    const accessToken = (tok.body as { access_token: string }).access_token;

    // Bridge (public endpoint — the IdP token is the credential).
    const login = await jsonRequest('POST', `${base}/pki/idp/login`, { accessToken });
    assert.equal(login.status, 200);
    const session = (login.body as { session: { token: string } }).session;

    // The minted platform session works against an RBAC route.
    const whoami = await jsonRequest('GET', `${base}/whoami`, undefined, session.token);
    assert.equal(whoami.status, 200);
    assert.equal((whoami.body as { principal: { username: string } }).principal.username, 'bridged');
  });

  // --- Phase 7 — KARIS FARM + KARIS LOOP via gateway ---------------------

  it('agriculture: farm → field → plant → harvest → stats over HTTP', async () => {
    const farm = await jsonRequest('POST', `${base}/agriculture/farms`, { name: 'Green Acres', ownerId: 'u1', areaHa: 25 }, token);
    assert.equal(farm.status, 201);
    const farmId = (farm.body as { farm: { id: string } }).farm.id;

    const field = await jsonRequest('POST', `${base}/agriculture/fields`, { farmId, name: 'North Plot', areaHa: 8 }, token);
    assert.equal(field.status, 201);
    const fieldId = (field.body as { field: { id: string } }).field.id;

    const planted = await jsonRequest('POST', `${base}/agriculture/crops`, { fieldId, crop: 'maize', expectedYieldKg: 3000 }, token);
    assert.equal(planted.status, 201);
    const cycleId = (planted.body as { cycle: { id: string } }).cycle.id;

    const stage = await jsonRequest('POST', `${base}/agriculture/crops/stage`, { id: cycleId, stage: 'harvesting' }, token);
    assert.equal(stage.status, 200);

    const harvested = await jsonRequest('POST', `${base}/agriculture/harvests`, { cropCycleId: cycleId, yieldKg: 3400 }, token);
    assert.equal(harvested.status, 201);
    assert.equal((harvested.body as { harvest: { yieldKg: number } }).harvest.yieldKg, 3400);

    const stats = await jsonRequest('GET', `${base}/agriculture/stats?farmId=${farmId}`, undefined, token);
    assert.equal(stats.status, 200);
    assert.equal((stats.body as { stats: { totalHarvestedKg: number } }).stats.totalHarvestedKg, 3400);
  });

  it('circular: stream → collection → recycled → score → stats over HTTP', async () => {
    const stream = await jsonRequest('POST', `${base}/circular/streams`, { name: 'PET', type: 'plastic', co2ePerKg: 1.5 }, token);
    assert.equal(stream.status, 201);
    const streamId = (stream.body as { stream: { id: string } }).stream.id;

    const collection = await jsonRequest('POST', `${base}/circular/collections`, { streamId, weightKg: 200, source: 'Nairobi' }, token);
    assert.equal(collection.status, 201);
    const collectionId = (collection.body as { collection: { id: string } }).collection.id;

    const processed = await jsonRequest('POST', `${base}/circular/collections/status`, { id: collectionId, status: 'recycled' }, token);
    assert.equal(processed.status, 200);
    assert.equal((processed.body as { collection: { status: string } }).collection.status, 'recycled');

    const takeback = await jsonRequest('POST', `${base}/circular/takeback`, { productId: 'p1', productName: 'Phone', returnedBy: 'u1' }, token);
    assert.equal(takeback.status, 201);
    const itemId = (takeback.body as { item: { id: string } }).item.id;
    await jsonRequest('POST', `${base}/circular/takeback/status`, { id: itemId, status: 'refurbished' }, token);

    const score = await jsonRequest('GET', `${base}/circular/score?scope=product&scopeId=p1`, undefined, token);
    assert.equal(score.status, 200);
    assert.equal((score.body as { score: { score: number } }).score.score, 100);

    const stats = await jsonRequest('GET', `${base}/circular/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.equal((stats.body as { stats: { recycledKg: number } }).stats.recycledKg, 200);
  });

  // --- Phase 7 — KARIS ENERGY + KARIS BORDER X via gateway --------------

  it('energy: asset → meter → readings → tariff → bill → stats over HTTP', async () => {
    const asset = await jsonRequest('POST', `${base}/energy/assets`, { name: 'Roof Array', source: 'solar', capacityKw: 12.5 }, token);
    assert.equal(asset.status, 201);

    const meter = await jsonRequest('POST', `${base}/energy/meters`, { name: 'Office', customerId: 'c1' }, token);
    assert.equal(meter.status, 201);
    const meterId = (meter.body as { meter: { id: string } }).meter.id;

    const r1 = await jsonRequest('POST', `${base}/energy/readings`, { meterId, kwh: 500 }, token);
    assert.equal(r1.status, 201);
    const r1Id = (r1.body as { reading: { id: string } }).reading.id;
    await jsonRequest('POST', `${base}/energy/readings`, { meterId, kwh: 800 }, token);

    const tariff = await jsonRequest('POST', `${base}/energy/tariffs`, { name: 'Commercial', pricePerKwh: 15, fixedCharge: 2000 }, token);
    const tariffId = (tariff.body as { tariff: { id: string } }).tariff.id;

    const bill = await jsonRequest('POST', `${base}/energy/bills`, { meterId, tariffId, fromReadingId: r1Id }, token);
    assert.equal(bill.status, 201);
    const billBody = bill.body as { bill: { kwhUsed: number; total: number } };
    assert.equal(billBody.bill.kwhUsed, 300);
    assert.equal(billBody.bill.total, 6500); // 300×15 + 2000

    const stats = await jsonRequest('GET', `${base}/energy/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.equal((stats.body as { stats: { meters: number } }).stats.meters, 1);
  });

  it('border: post → watchlist → crossing referred → manifest flagged → stats over HTTP', async () => {
    const post = await jsonRequest('POST', `${base}/border/posts`, { name: 'Busia', crossing: 'KE-UG' }, token);
    assert.equal(post.status, 201);
    const postId = (post.body as { post: { id: string } }).post.id;

    const watch = await jsonRequest('POST', `${base}/border/watchlist`, { name: 'Suspect X', documentNo: 'W-001', category: 'person', reason: 'test' }, token);
    assert.equal(watch.status, 201);

    const crossing = await jsonRequest('POST', `${base}/border/crossings`, {
      postId, travelerId: 't1', travelerName: 'Suspect X', documentNo: 'W-001', mode: 'road', direction: 'inbound',
    }, token);
    assert.equal(crossing.status, 201);
    assert.equal((crossing.body as { crossing: { clearance: string } }).crossing.clearance, 'referred');

    const manifest = await jsonRequest('POST', `${base}/border/manifests`, {
      postId, reference: 'MF-77', consignor: 'A', consignee: 'B', description: 'General goods', weightKg: 15000,
    }, token);
    assert.equal(manifest.status, 201);
    assert.equal((manifest.body as { manifest: { flagged: boolean } }).manifest.flagged, true);

    const stats = await jsonRequest('GET', `${base}/border/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.equal((stats.body as { stats: { referred: number } }).stats.referred, 1);
  });

  // --- Phase 7 — NYUMBANI KITCHEN via gateway ---------------------------

  it('restaurants: venue → menu → order → submit → paid → stats over HTTP', async () => {
    const venue = await jsonRequest('POST', `${base}/restaurants/venues`, { name: 'Nyumbani Grill', ownerId: 'u1', cuisine: 'Swahili' }, token);
    assert.equal(venue.status, 201);
    const venueId = (venue.body as { venue: { id: string } }).venue.id;

    const item = await jsonRequest('POST', `${base}/restaurants/menu`, { venueId, name: 'Grilled Fish', price: 1200, category: 'main' }, token);
    assert.equal(item.status, 201);
    const itemId = (item.body as { item: { id: string } }).item.id;

    const table = await jsonRequest('POST', `${base}/restaurants/tables`, { venueId, number: 'T1', seats: 4 }, token);
    const tableId = (table.body as { table: { id: string } }).table.id;

    const order = await jsonRequest('POST', `${base}/restaurants/orders`, {
      venueId, tableId, lines: [{ menuItemId: itemId, quantity: 2 }],
    }, token);
    assert.equal(order.status, 201);
    const orderId = (order.body as { order: { id: string } }).order.id;

    const submitted = await jsonRequest('POST', `${base}/restaurants/orders/submit`, { id: orderId }, token);
    assert.equal((submitted.body as { order: { total: number } }).order.total, 2400);

    const paid = await jsonRequest('POST', `${base}/restaurants/orders/status`, { id: orderId, status: 'paid' }, token);
    assert.equal((paid.body as { order: { status: string } }).order.status, 'paid');

    const stats = await jsonRequest('GET', `${base}/restaurants/stats?venueId=${venueId}`, undefined, token);
    assert.equal(stats.status, 200);
    const s = stats.body as { stats: { revenueMinorUnits: number; avgOrderValueMinorUnits?: number } };
    assert.equal(s.stats.revenueMinorUnits, 2400);
    assert.equal(s.stats.avgOrderValueMinorUnits, 2400);
  });

  // --- Phase 7 — MAZA marketplace via gateway ---------------------------

  it('marketplace: storefront → listing → review → purchase → stats over HTTP', async () => {
    const storefront = await jsonRequest('POST', `${base}/marketplace/storefronts`, { vendorId: 'v1', name: 'Karibu Crafts', categories: ['crafts'] }, token);
    assert.equal(storefront.status, 201);
    const sfId = (storefront.body as { storefront: { id: string } }).storefront.id;

    const listing = await jsonRequest('POST', `${base}/marketplace/listings`, { storefrontId: sfId, title: 'Handwoven Basket', category: 'crafts', priceMinor: 1500, stock: 3 }, token);
    assert.equal(listing.status, 201);
    const listingId = (listing.body as { listing: { id: string } }).listing.id;

    const review = await jsonRequest('POST', `${base}/marketplace/reviews`, { listingId, reviewerId: 'u1', rating: 5, comment: 'Lovely' }, token);
    assert.equal(review.status, 201);

    const search = await jsonRequest('GET', `${base}/marketplace/listings?q=basket&category=crafts`, undefined, token);
    assert.equal((search.body as { count: number }).count, 1);

    const purchase = await jsonRequest('POST', `${base}/marketplace/purchases`, { listingId, buyerId: 'buyer-1' }, token);
    assert.equal(purchase.status, 200);

    const stats = await jsonRequest('GET', `${base}/marketplace/stats`, undefined, token);
    assert.equal(stats.status, 200);
    const s = stats.body as { stats: { listings: number; listedListings: number; reviews: number } };
    assert.equal(s.stats.listings, 1);
    assert.equal(s.stats.reviews, 1);

    const categories = await jsonRequest('GET', `${base}/marketplace/categories`, undefined, token);
    assert.ok((categories.body as { categories: string[] }).categories.includes('crafts'));
  });

  // --- Authz guard --------------------------------------------------------

  it('intelligence routes reject unauthenticated requests', async () => {
    const res = await jsonRequest('GET', `${base}/memory`, undefined);
    assert.equal(res.status, 401);
  });
});
