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
import { CloudModule } from '@jataqi/cloud';
import { CdnModule } from '@jataqi/cdn';
import { EmailModule } from '@jataqi/email';
import { IpamModule } from '@jataqi/ipam';
import { TanyaModule } from '@jataqi/tanya';
import { MetricsModule } from '@jataqi/metrics';
import { OrganizationsModule } from '@jataqi/organizations';
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
    kernel.register(new MetricsModule());
    kernel.register(new ToolIntelligenceModule());
    kernel.register(new OrganizationsModule());
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
    kernel.register(new CloudModule());
    kernel.register(new CdnModule());
    kernel.register(new EmailModule());
    kernel.register(new IpamModule());
    kernel.register(new TanyaModule());
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

  // --- PRX Part C — ACME automated issuance via gateway -------------------

  it('acme: directory → nonce → new-account → new-order → proof → finalize → cert', async () => {
    const pki = kernel.getModule<PkiModule>('pki');
    // Seed a root + intermediate CA for issuance.
    const root = pki.createRootCa([{ oid: '2.5.4.3', value: 'GW ACME Root' }]);
    pki.createIntermediateCa([{ oid: '2.5.4.3', value: 'GW ACME Intermediate' }], root.id);

    // Build a JWS-signed newAccount request (ES256).
    const { generateKeyPair } = await import('@jataqi/pki');
    const { sign } = await import('node:crypto');
    const accountKey = generateKeyPair('ec-p256');
    const b64 = (b: Buffer): string => b.toString('base64url');

    const nonceRes = await jsonRequest('GET', `${base}/pki/acme/new-nonce`, undefined, token);
    assert.equal(nonceRes.status, 200);
    const nonce = (nonceRes.body as { nonce: string }).nonce;

    const header = b64(Buffer.from(JSON.stringify({ alg: 'ES256', jwk: accountKey.jwk, nonce, url: '/new-account' }), 'utf8'));
    const payload = b64(Buffer.from(JSON.stringify({ termsOfServiceAgreed: true }), 'utf8'));
    const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key: accountKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const account = await jsonRequest('POST', `${base}/pki/acme/new-account`, { jws: `${header}.${payload}.${sig}` }, token);
    assert.equal(account.status, 201);
    const kid = (account.body as { kid: string }).kid;

    // Order for acme.example.com.
    const order = await jsonRequest('POST', `${base}/pki/acme/new-order`, {
      accountId: kid, identifiers: [{ type: 'dns', value: 'acme.example.com' }],
    }, token);
    assert.equal(order.status, 201);
    const orderBody = order.body as { order: { id: string; authorizationIds: string[]; status: string } };
    assert.equal(orderBody.order.status, 'pending');

    // Authorization + challenge + keyAuthorization.
    const authzId = orderBody.order.authorizationIds[0]!;
    const authz = await jsonRequest('GET', `${base}/pki/acme/authz?id=${authzId}`, undefined, token);
    assert.equal(authz.status, 200);
    const challengeId = (authz.body as { authorization: { challenges: Array<{ id: string; type: string }> } }).authorization.challenges[0]!.id;

    const keyAuth = await jsonRequest('GET', `${base}/pki/acme/challenge/key-auth?id=${challengeId}`, undefined, token);
    assert.equal(keyAuth.status, 200);
    const ka = (keyAuth.body as { keyAuthorization: string }).keyAuthorization;

    // Request validation + submit proof.
    const validated = await jsonRequest('POST', `${base}/pki/acme/challenge/validate`, { accountId: kid, challengeId }, token);
    assert.equal(validated.status, 200);
    const proven = await jsonRequest('POST', `${base}/pki/acme/challenge/proof`, {
      accountId: kid, challengeId,
      location: 'http://acme.example.com/.well-known/acme-challenge/x', value: ka,
    }, token);
    assert.equal((proven.body as { challenge: { status: string } }).challenge.status, 'valid');

    // Build a CSR and finalize.
    const {
      Oids, derBitString, derContext, derContextPrimitive, derInteger,
      derOctetString, derOid, derSequence, derSet, derUtf8String,
      ecdsaDerSignature, encodeSpki,
    } = await import('@jataqi/pki');
    const subjectKey = generateKeyPair('ec-p256');
    const subject = derSequence(derSet(derSequence(derOid(Oids.commonName), derUtf8String('acme.example.com'))));
    const sanExt = derSequence(derOid(Oids.subjectAltName), derOctetString(derSequence(derContextPrimitive(2, Buffer.from('acme.example.com')))));
    const attrs = derContext(0, derSequence(derOid('1.2.840.113549.1.9.14'), derSet(derSequence(sanExt))));
    const criChildren = [derInteger(0), subject, encodeSpki(subjectKey.jwk), attrs];
    const cri = derSequence(...criChildren);
    const raw = sign('sha256', cri, { key: subjectKey.privateKey, dsaEncoding: 'ieee-p1363' });
    const csr = derSequence(cri, derSequence(derOid(Oids.ecdsaWithSha256)), derBitString(ecdsaDerSignature(raw)));

    const finalized = await jsonRequest('POST', `${base}/pki/acme/finalize`, {
      accountId: kid, orderId: orderBody.order.id, csr: csr.toString('base64'),
    }, token);
    assert.equal(finalized.status, 200);
    const fin = finalized.body as { certificate: { id: string; certDer: string } };
    assert.ok(fin.certificate.id);

    // Fetch the certificate and revoke it.
    const cert = await jsonRequest('GET', `${base}/pki/acme/certificate?orderId=${orderBody.order.id}`, undefined, token);
    assert.equal(cert.status, 200);
    assert.equal((cert.body as { certificate: { id: string } }).certificate.id, fin.certificate.id);

    const revoked = await jsonRequest('POST', `${base}/pki/acme/revoke`, { accountId: kid, certId: fin.certificate.id, reason: 'keyCompromise' }, token);
    assert.equal(revoked.status, 200);
    assert.equal((revoked.body as { revoked: boolean }).revoked, true);

    const directory = await jsonRequest('GET', `${base}/pki/acme/directory`, undefined, token);
    assert.equal(directory.status, 200);
    assert.equal((directory.body as { newOrder: string }).newOrder, '/new-order');
  });

  // --- PRX Part E — Cloud platform via gateway ---------------------------

  it('cloud: region → flavor → image → instance → volume → hosting → stats over HTTP', async () => {
    const region = await jsonRequest('POST', `${base}/cloud/regions`, { name: 'Nairobi', code: 'NBO', country: 'KE', zones: ['nbo-1'], capacitySlots: 10 }, token);
    assert.equal(region.status, 201);
    const regionId = (region.body as { region: { id: string } }).region.id;

    const flavor = await jsonRequest('POST', `${base}/cloud/flavors`, { name: 'vps-2', tier: 'vps', vcpu: 2, ramGb: 4, diskGb: 80, pricePerHourMinor: 500 }, token);
    assert.equal(flavor.status, 201);
    const flavorId = (flavor.body as { flavor: { id: string } }).flavor.id;

    const image = await jsonRequest('POST', `${base}/cloud/images`, { name: 'Ubuntu', os: 'ubuntu', version: '24.04' }, token);
    const imageId = (image.body as { image: { id: string } }).image.id;

    const instance = await jsonRequest('POST', `${base}/cloud/instances`, { name: 'web-1', regionId, flavorId, imageId }, token);
    assert.equal(instance.status, 201);
    const instanceId = (instance.body as { instance: { id: string } }).instance.id;

    const running = await jsonRequest('POST', `${base}/cloud/instances/status`, { id: instanceId, status: 'running' }, token);
    assert.equal((running.body as { instance: { status: string } }).instance.status, 'running');

    const volume = await jsonRequest('POST', `${base}/cloud/volumes`, { name: 'data', sizeGb: 100, regionId }, token);
    assert.equal(volume.status, 201);
    const volumeId = (volume.body as { volume: { id: string } }).volume.id;

    const attached = await jsonRequest('POST', `${base}/cloud/volumes/attach`, { volumeId, instanceId }, token);
    assert.equal(attached.status, 200);
    assert.equal((attached.body as { volume: { status: string } }).volume.status, 'attached');

    const plan = await jsonRequest('POST', `${base}/cloud/hosting-plans`, { name: 'Starter VPS', tier: 'vps', monthlyPriceMinor: 150000, flavorId, sslAutomation: true }, token);
    assert.equal(plan.status, 201);
    const planId = (plan.body as { plan: { id: string } }).plan.id;

    const hosting = await jsonRequest('POST', `${base}/cloud/hosting`, { planId, regionId, siteName: 'acme.com', imageId }, token);
    assert.equal(hosting.status, 201);
    assert.equal((hosting.body as { instance: { hostingPlanId: string } }).instance.hostingPlanId, planId);

    const stats = await jsonRequest('GET', `${base}/cloud/stats`, undefined, token);
    assert.equal(stats.status, 200);
    const s = stats.body as { stats: { regions: number; instances: number; runningInstances: number } };
    assert.equal(s.stats.regions, 1);
    assert.equal(s.stats.instances, 2); // web-1 + hosting
    assert.equal(s.stats.runningInstances, 1);
  });

  // --- PRX CDN + Email via gateway ---------------------------------------

  it('cdn: zone → cache → lookup hit → purge → stats over HTTP', async () => {
    const zone = await jsonRequest('POST', `${base}/cdn/zones`, { domain: 'cdn.example.com', origin: 'https://origin.example.com', defaultTtlSec: 60 }, token);
    assert.equal(zone.status, 201);
    const zoneId = (zone.body as { zone: { id: string } }).zone.id;

    const cached = await jsonRequest('POST', `${base}/cdn/assets`, { zoneId, path: '/img/logo.png', contentType: 'image/png', sizeBytes: 5000 }, token);
    assert.equal(cached.status, 201);

    const miss = await jsonRequest('GET', `${base}/cdn/lookup?zoneId=${zoneId}&path=/img/missing.png`, undefined, token);
    assert.equal((miss.body as { outcome: string }).outcome, 'miss');

    const hit = await jsonRequest('GET', `${base}/cdn/lookup?zoneId=${zoneId}&path=/img/logo.png`, undefined, token);
    assert.equal((hit.body as { outcome: string }).outcome, 'hit');

    const purged = await jsonRequest('POST', `${base}/cdn/purge`, { zoneId, path: '/img/logo.png' }, token);
    assert.equal((purged.body as { purged: number }).purged, 1);

    const stats = await jsonRequest('GET', `${base}/cdn/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.ok((stats.body as { stats: { hits: number } }).stats.hits >= 1);
  });

  it('email: domain → verify → mailbox → send → receive → stats over HTTP', async () => {
    const domain = await jsonRequest('POST', `${base}/email/domains`, { domain: 'acme.co.ke', dmarcPolicy: 'quarantine' }, token);
    assert.equal(domain.status, 201);
    const domainId = (domain.body as { domain: { id: string } }).domain.id;

    const dns = await jsonRequest('GET', `${base}/email/domains/dns?id=${domainId}`, undefined, token);
    assert.ok((dns.body as { records: unknown[] }).records.length >= 4);

    const verified = await jsonRequest('POST', `${base}/email/domains/verify`, { id: domainId }, token);
    assert.equal((verified.body as { domain: { verified: boolean } }).domain.verified, true);

    const mailbox = await jsonRequest('POST', `${base}/email/mailboxes`, { domainId, address: 'alice' }, token);
    assert.equal(mailbox.status, 201);
    const mailboxId = (mailbox.body as { mailbox: { id: string } }).mailbox.id;

    const sent = await jsonRequest('POST', `${base}/email/send`, { from: 'alice@acme.co.ke', to: ['bob@other.io'], subject: 'Hello', body: 'World' }, token);
    assert.equal(sent.status, 201);
    assert.equal((sent.body as { message: { dkimSigned: boolean } }).message.dkimSigned, true);

    const received = await jsonRequest('POST', `${base}/email/receive`, { to: 'alice@acme.co.ke', from: 'x@y.io', subject: 'Incoming', body: 'Hi' }, token);
    assert.equal(received.status, 201);

    const inbox = await jsonRequest('GET', `${base}/email/inbox?mailboxId=${mailboxId}`, undefined, token);
    assert.equal((inbox.body as { count: number }).count, 1);

    const stats = await jsonRequest('GET', `${base}/email/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.ok((stats.body as { stats: { domains: number } }).stats.domains >= 1);
  });

  // --- PRX RIR Member (IPAM) via gateway --------------------------------

  it('ipam: block → split → address → asn → announce → stats over HTTP', async () => {
    const block = await jsonRequest('POST', `${base}/ipam/blocks`, { cidr: '196.201.0.0/16', rir: 'AFRINIC', purpose: 'anycast' }, token);
    assert.equal(block.status, 201);
    const blockId = (block.body as { block: { id: string } }).block.id;

    const split = await jsonRequest('POST', `${base}/ipam/blocks/split`, { blockId, newPrefix: 24 }, token);
    assert.equal(split.status, 201);
    assert.equal((split.body as { count: number }).count, 256);
    const childId = (split.body as { children: Array<{ id: string }> }).children[0]!.id;

    const address = await jsonRequest('POST', `${base}/ipam/addresses`, { blockId: childId, address: '196.201.0.10', assignedTo: 'web-1' }, token);
    assert.equal(address.status, 201);
    assert.equal((address.body as { entry: { assignedTo: string } }).entry.assignedTo, 'web-1');

    const asn = await jsonRequest('POST', `${base}/ipam/asns`, { asn: 327780, rir: 'AFRINIC', announcementType: 'anycast' }, token);
    assert.equal(asn.status, 201);
    const asnId = (asn.body as { asn: { id: string } }).asn.id;

    const announced = await jsonRequest('POST', `${base}/ipam/announce`, { blockId, asnId }, token);
    assert.equal(announced.status, 201);
    assert.equal((announced.body as { asnId: string }).asnId, asnId);

    const stats = await jsonRequest('GET', `${base}/ipam/stats`, undefined, token);
    assert.equal(stats.status, 200);
    const s = stats.body as { stats: { blocks: number; asns: number; totalAddresses: string } };
    assert.ok(s.stats.blocks >= 257); // parent /16 + 256 /24 children (leaf counting)
    assert.equal(s.stats.asns, 1);
    assert.equal(s.stats.totalAddresses, '65536'); // 256 leaf /24s × 256
  });

  // --- Authz guard --------------------------------------------------------

  it('intelligence routes reject unauthenticated requests', async () => {
    const res = await jsonRequest('GET', `${base}/memory`, undefined);
    assert.equal(res.status, 401);
  });

  // --- TANYA AI ------------------------------------------------------------

  it('POST /tanya/chat runs a persona turn; conversations/personas/stats routes work; guest is denied', async () => {
    const chat = await jsonRequest('POST', `${base}/tanya/chat`, { message: 'Hello TANYA' }, token);
    assert.equal(chat.status, 200);
    const result = chat.body as { conversationId: string; reply: string; messageCount: number; persona: string };
    assert.ok(result.conversationId);
    assert.match(result.reply, /Hello TANYA/);
    assert.equal(result.persona, 'main');
    assert.equal(result.messageCount, 2);

    const listed = await jsonRequest('GET', `${base}/tanya/conversations`, undefined, token);
    assert.equal(listed.status, 200);
    const listBody = listed.body as { conversations: unknown[]; total: number };
    assert.ok(listBody.total >= 1);

    const conv = await jsonRequest('GET', `${base}/tanya/conversation?id=${result.conversationId}`, undefined, token);
    assert.equal(conv.status, 200);
    assert.equal((conv.body as { messages: unknown[] }).messages.length, 2);

    const personas = await jsonRequest('GET', `${base}/tanya/personas`, undefined, token);
    assert.equal(personas.status, 200);
    assert.equal((personas.body as { personas: { id: string }[] }).personas.some((p) => p.id === 'main'), true);

    const stats = await jsonRequest('GET', `${base}/tanya/stats`, undefined, token);
    assert.equal(stats.status, 200);
    assert.equal((stats.body as { conversations: number }).conversations, listBody.total);

    // RBAC: a guest without tanya:write is denied.
    await jsonRequest('POST', `${base}/auth/register`, { username: 'tanya-guest', password: 'pw', roles: ['guest'] }, undefined);
    const guestLogin = await jsonRequest('POST', `${base}/auth/login`, { username: 'tanya-guest', password: 'pw' });
    const guestToken = (guestLogin.body as { token: string }).token;
    const denied = await jsonRequest('POST', `${base}/tanya/chat`, { message: 'hi' }, guestToken);
    assert.equal(denied.status, 403);
  });

  // --- Tool-intelligence governance (agent tool catalog) -------------------

  it('POST /tools/sync registers all 37 agent tools; R0 invokes; R4 requires approval', async () => {
    const sync = await jsonRequest('POST', `${base}/tools/sync`, {}, token);
    assert.equal(sync.status, 200);
    const syncBody = sync.body as { synced: number; created: number; updated: number };
    assert.equal(syncBody.synced, 37);
    assert.equal(syncBody.created, 37);

    const list = await jsonRequest('GET', `${base}/tools`, undefined, token);
    assert.equal(list.status, 200);
    const tools = (list.body as { tools: { id: string; canonicalName: string; riskClass: string; privacyClass: string; status: string }[] }).tools;
    assert.equal(tools.length, 37);
    const fx = tools.find((t) => t.canonicalName === 'fx.rate')!;
    assert.equal(fx.riskClass, 'R0');
    assert.equal(fx.status, 'ACTIVE');
    const provision = tools.find((t) => t.canonicalName === 'cloud.provision')!;
    assert.equal(provision.riskClass, 'R4');

    // R0 tool invokes end-to-end through the governed pipeline.
    const fxMod = kernel.getModule<FxModule>('fx');
    fxMod.setRate({ base: 'USD', quote: 'KES', bid: 128.5, ask: 129.0, source: 'test' });
    const inv = await jsonRequest('POST', `${base}/tool/invoke`, {
      id: fx.id,
      input: { base: 'USD', quote: 'KES' },
    }, token);
    assert.equal(inv.status, 200);
    const invResult = inv.body as { result: { status: string; output: { pair: string } } };
    assert.equal(invResult.result.status, 'success');
    assert.equal(invResult.result.output.pair, 'USD/KES');

    // R4 tool is gated: invoke → 202 pending_approval; approval unblocks it.
    const gated = await jsonRequest('POST', `${base}/tool/invoke`, {
      id: provision.id,
      input: { name: 'web-1', regionId: 'nope', flavorId: 'nope', imageId: 'nope' },
    }, token);
    assert.equal(gated.status, 202);
    assert.equal((gated.body as { result: { status: string } }).result.status, 'pending_approval');

    const req = await jsonRequest('POST', `${base}/tool/request-approval`, {
      id: provision.id, action: 'invoke', reason: 'provision test server',
    }, token);
    assert.equal(req.status, 202);
    const requestId = (req.body as { approvalRequest: { id: string } }).approvalRequest.id;

    const decide = await jsonRequest('POST', `${base}/tool/approve`, {
      id: requestId, decision: 'approved',
    }, token);
    assert.equal(decide.status, 200);

    const unblocked = await jsonRequest('POST', `${base}/tool/invoke`, {
      id: provision.id,
      input: { name: 'web-1', regionId: 'nope', flavorId: 'nope', imageId: 'nope' },
      approvalRequestId: requestId,
    }, token);
    // Approved R4 tool now runs: the engine rejects the bogus region inside the
    // tool's error envelope — the governance gate no longer blocks it.
    assert.notEqual(unblocked.status, 202, 'approved R4 tool must no longer be pending approval');
    const unblockedResult = unblocked.body as { result: { status: string; output?: { error?: string } } };
    assert.equal(unblockedResult.result.status, 'success');
    assert.match(unblockedResult.result.output!.error!, /unknown region nope/);

    const approvals = await jsonRequest('GET', `${base}/approvals`, undefined, token);
    assert.equal((approvals.body as { approvals: unknown[] }).approvals.length, 0); // all decided
  });

  it('GET /tools/governance-stats exposes registry + approval + invocation posture', async () => {
    const sync = await jsonRequest('POST', `${base}/tools/sync`, {}, token);
    assert.equal(sync.status, 200);

    const stats = await jsonRequest('GET', `${base}/tools/governance-stats`, undefined, token);
    assert.equal(stats.status, 200);
    const s = stats.body as {
      tools: { total: number; active: number; byRisk: Record<string, number>; approvalGated: number; agentTools: number };
      approvals: { pending: number; requested: number; approved: number; denied: number; expired: number };
      invocations: { total: number; byRisk: Record<string, number>; byStatus: Record<string, number> };
      decisions: { total: number; byDecision: Record<string, number> };
      avgDurationMs?: number;
    };
    assert.equal(s.tools.total, 37);
    assert.equal(s.tools.active, 37);
    assert.equal(s.tools.approvalGated, 3); // mobility.dispatch, cloud.provision, cloud.autoscale
    assert.equal(s.tools.agentTools, 37);
    assert.equal(s.tools.byRisk.R4, 3);
    assert.equal(s.approvals.pending, 0);
    assert.ok(s.invocations.total >= 0);
    assert.ok(s.decisions.total >= 0);

    // An R4 approval flow drives the counters (assert deltas — earlier tests
    // in this suite already exercised approval + invocation flows).
    const before = s;
    const provision = (await jsonRequest('GET', `${base}/tools`, undefined, token)).body as { tools: { id: string; canonicalName: string }[] };
    const pid = provision.tools.find((t) => t.canonicalName === 'cloud.provision')!.id;
    await jsonRequest('POST', `${base}/tool/invoke`, { id: pid, input: { name: 'web-1', regionId: 'nope', flavorId: 'nope', imageId: 'nope' } }, token); // 202 pending
    const req = await jsonRequest('POST', `${base}/tool/request-approval`, { id: pid, action: 'invoke' }, token);
    const rid = (req.body as { approvalRequest: { id: string } }).approvalRequest.id;
    await jsonRequest('POST', `${base}/tool/approve`, { id: rid, decision: 'approved' }, token);

    const after = (await jsonRequest('GET', `${base}/tools/governance-stats`, undefined, token)).body as {
      approvals: { pending: number; requested: number; approved: number };
      invocations: { total: number; byStatus: Record<string, number> };
    };
    assert.equal(after.approvals.requested, before.approvals.requested + 1);
    assert.equal(after.approvals.approved, before.approvals.approved + 1);
    assert.equal(after.approvals.pending, 0);
    assert.equal(after.invocations.total, before.invocations.total + 1);
    assert.equal(after.invocations.byStatus.pending_approval, (before.invocations.byStatus.pending_approval ?? 0) + 1);
  });

  it('GET /auth/session introspects the live session with expiry', async () => {
    // Valid session (admin token from the shared boot).
    const ok = await jsonRequest('GET', `${base}/auth/session`, undefined, token);
    assert.equal(ok.status, 200);
    const s = ok.body as { ok: boolean; expiresAt: number; remainingMs: number; username: string; roles: string[] };
    assert.equal(s.ok, true);
    assert.ok(s.expiresAt > Date.now());
    assert.ok(s.remainingMs > 0 && s.remainingMs <= 3_600_000, 'within default TTL');
    assert.equal(s.username, 'admin');
    assert.ok(s.roles.includes('admin'));

    // Expired/unknown token → 401.
    const bad = await jsonRequest('GET', `${base}/auth/session`, undefined, 'deadbeef');
    assert.equal(bad.status, 401);

    // No token → 401.
    const anon = await jsonRequest('GET', `${base}/auth/session`);
    assert.equal(anon.status, 401);
  });

  it('exposes governance widgets + data for adaptive dashboards', async () => {
    // Widget catalog exposes the governance widgets.
    const widgets = await jsonRequest('GET', `${base}/dashboard/widgets`, undefined, token);
    assert.equal(widgets.status, 200);
    const defs = (widgets.body as { widgets: { id: string; requiresDataSource?: boolean }[] }).widgets;
    for (const id of ['kpi-tools-governed', 'kpi-tools-invocations', 'kpi-tools-decisions', 'list-tool-approvals']) {
      const w = defs.find((d) => d.id === id);
      assert.ok(w, `widget ${id} in catalog`);
      assert.equal(w!.requiresDataSource, true);
    }

    // A layout can host a governance widget (add-widget path used by the UI).
    const layout = await jsonRequest('POST', `${base}/dashboard/layouts`, { name: 'Governance Layout', ownerId: 'admin' }, token);
    const layoutId = (layout.body as { layout: { id: string } }).layout.id;
    const add = await jsonRequest('POST', `${base}/dashboard/widgets`, { layoutId, widgetDefId: 'kpi-tools-governed' }, token);
    assert.equal(add.status, 201);
    const inst = (add.body as { widget: { widgetDefId: string } }).widget;
    assert.equal(inst.widgetDefId, 'kpi-tools-governed');

    // The data source for the widget renders (governance stats resolve).
    const gstats = await jsonRequest('GET', `${base}/tools/governance-stats`, undefined, token);
    assert.equal(gstats.status, 200);
    assert.ok((gstats.body as { tools: { total: number } }).tools.total >= 37);

    // AI-adapt keeps the layout healthy.
    const adapted = await jsonRequest('POST', `${base}/dashboard/adapt`, { layoutId, userId: 'admin' }, token);
    assert.equal(adapted.status, 200);
  });

  it('GET /approvals supports history + status filters (approval workflow)', async () => {
    // Ensure a governed R4 tool exists.
    await jsonRequest('POST', `${base}/tools/sync`, {}, token);
    const tools = (await jsonRequest('GET', `${base}/tools`, undefined, token)).body as { tools: { id: string; canonicalName: string }[] };
    const pid = tools.tools.find((t) => t.canonicalName === 'cloud.provision')!.id;

    // Create one pending + one decided request.
    const req = await jsonRequest('POST', `${base}/tool/request-approval`, { id: pid, action: 'invoke', reason: 'workflow test' }, token);
    const requestId = (req.body as { approvalRequest: { id: string } }).approvalRequest.id;
    await jsonRequest('POST', `${base}/tool/approve`, { id: requestId, decision: 'approved' }, token);
    await jsonRequest('POST', `${base}/tool/request-approval`, { id: pid, action: 'invoke', reason: 'workflow pending' }, token);

    // Default: pending only (backward compatible).
    const pending = (await jsonRequest('GET', `${base}/approvals`, undefined, token)).body as { approvals: { status: string }[] };
    assert.ok(pending.approvals.length >= 1);
    for (const a of pending.approvals) assert.equal(a.status, 'pending');

    // Status filter: approved.
    const approved = (await jsonRequest('GET', `${base}/approvals?status=approved`, undefined, token)).body as { approvals: { status: string }[] };
    assert.ok(approved.approvals.length >= 1);
    for (const a of approved.approvals) assert.equal(a.status, 'approved');

    // All history includes both statuses.
    const all = (await jsonRequest('GET', `${base}/approvals?status=all`, undefined, token)).body as { approvals: { status: string }[] };
    assert.ok(all.approvals.some((a) => a.status === 'approved'));
    assert.ok(all.approvals.some((a) => a.status === 'pending'));

    // Invalid status → 400.
    const bad = await jsonRequest('GET', `${base}/approvals?status=bogus`, undefined, token);
    assert.equal(bad.status, 400);
  });

  it('approval lifecycle writes immutable audit records (GET /audit)', async () => {
    await jsonRequest('POST', `${base}/tools/sync`, {}, token);
    const tools = (await jsonRequest('GET', `${base}/tools`, undefined, token)).body as { tools: { id: string; canonicalName: string }[] };
    const pid = tools.tools.find((t) => t.canonicalName === 'cloud.provision')!.id;

    // Denied high-risk invoke → tool.approval.required audit.
    await jsonRequest('POST', `${base}/tool/invoke`, { id: pid, input: { name: 'w', regionId: 'n', flavorId: 'n', imageId: 'n' } }, token);
    // Request + approve.
    const req = await jsonRequest('POST', `${base}/tool/request-approval`, { id: pid, action: 'invoke', reason: 'audit test' }, token);
    const rid = (req.body as { approvalRequest: { id: string } }).approvalRequest.id;
    await jsonRequest('POST', `${base}/tool/approve`, { id: rid, decision: 'approved' }, token);

    // Poll until the fire-and-forget audit writes land.
    let required = 0, requested = 0, decided = 0;
    for (let i = 0; i < 30; i++) {
      const requiredRes = (await jsonRequest('GET', `${base}/audit?action=tool.approval.required`, undefined, token)).body as { count: number };
      const requestedRes = (await jsonRequest('GET', `${base}/audit?action=tool.approval.requested`, undefined, token)).body as { count: number };
      const decidedRes = (await jsonRequest('GET', `${base}/audit?action=tool.approval.decided`, undefined, token)).body as { count: number };
      required = requiredRes.count; requested = requestedRes.count; decided = decidedRes.count;
      if (required >= 1 && requested >= 1 && decided >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(required >= 1, 'denied invocation audited (tool.approval.required)');
    assert.ok(requested >= 1, 'request audited (tool.approval.requested)');
    assert.ok(decided >= 1, 'decision audited (tool.approval.decided)');

    // The decided record carries the decider + decision detail.
    const decidedRes = (await jsonRequest('GET', `${base}/audit?action=tool.approval.decided`, undefined, token)).body as { records: { actor: string; result: string; detail: { decision: string } }[] };
    const approved = decidedRes.records.find((r) => r.detail?.decision === 'approved');
    assert.ok(approved, 'approved decision present');
    assert.equal(approved.result, 'success');
    assert.ok(approved.actor.length > 0, 'decider attributed');
  });

  it('GET /audit supports the audit-trail view (approval + auth actions)', async () => {
    // The prior audit test already produced approval records in this kernel.
    const approval = (await jsonRequest('GET', `${base}/audit?action=tool.approval.decided`, undefined, token)).body as { records: { ts: number; actor: string; result: string }[]; count: number };
    assert.ok(approval.count >= 1, 'approval decisions present');

    // Denied high-risk invocations.
    const denied = (await jsonRequest('GET', `${base}/audit?action=tool.approval.required`, undefined, token)).body as { count: number };
    assert.ok(denied.count >= 1);

    // Logins recorded with actor attribution (the shared admin session).
    const logins = (await jsonRequest('GET', `${base}/audit?action=auth.login`, undefined, token)).body as { records: { actor: string; result: string }[] };
    assert.ok(logins.records.length >= 1);
    for (const r of logins.records) assert.equal(r.result, 'success');

    // Limit applies.
    const limited = (await jsonRequest('GET', `${base}/audit?action=auth.login&limit=1`, undefined, token)).body as { records: unknown[] };
    assert.ok(limited.records.length <= 1);
  });

  it('POST /pki/idp/refresh + /pki/idp/rotate + /pki/idp/profile (deep IdP)', async () => {
    // Admin upserts an IdP profile with roles (pki:write).
    const profile = await jsonRequest('POST', `${base}/pki/idp/profile`, { sub: 'ext-user', preferred_username: 'idp-alice', roles: ['developer', 'analyst'] }, token);
    assert.equal(profile.status, 200);
    assert.deepEqual((profile.body as { profile: { roles: string[] } }).profile.roles, ['developer', 'analyst']);

    // Register a console client.
    const client = await jsonRequest('POST', `${base}/pki/idp/clients`, { name: 'console-e2e', redirectUris: ['https://console.example.com/ui'] }, token);
    assert.equal(client.status, 201);
    const creds = client.body as { clientId: string; clientSecret: string };

    // Authorization-code flow → tokens incl. refresh_token.
    const authz = await jsonRequest('POST', `${base}/pki/idp/authorize`, { clientId: creds.clientId, redirectUri: 'https://console.example.com/ui', scope: 'openid profile', userId: 'ext-user' }, token);
    assert.equal(authz.status, 200);
    const code = (authz.body as { code: string }).code;
    const tokens = await jsonRequest('POST', `${base}/pki/idp/token`, { code, clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: 'https://console.example.com/ui' });
    assert.equal(tokens.status, 200);
    const tokenBody = tokens.body as { access_token: string; refresh_token: string };

    // Refresh grant.
    const refreshed = await jsonRequest('POST', `${base}/pki/idp/refresh`, { refreshToken: tokenBody.refresh_token, clientId: creds.clientId, clientSecret: creds.clientSecret });
    assert.equal(refreshed.status, 200);
    assert.ok((refreshed.body as { access_token: string }).access_token);

    // Bad refresh → 400.
    const bad = await jsonRequest('POST', `${base}/pki/idp/refresh`, { refreshToken: 'nope', clientId: creds.clientId, clientSecret: creds.clientSecret });
    assert.equal(bad.status, 400);

    // Rotate: refreshed IdP token → new platform session (JIT user idp-alice).
    const rotated = await jsonRequest('POST', `${base}/pki/idp/rotate`, { refreshToken: tokenBody.refresh_token, clientId: creds.clientId, clientSecret: creds.clientSecret });
    assert.equal(rotated.status, 200);
    const rotBody = rotated.body as { ok: boolean; idpTokens: { access_token: string }; session: { token: string; username: string }; principal: { roles: string[] } };
    assert.equal(rotBody.ok, true);
    assert.ok(rotBody.idpTokens.access_token);
    assert.equal(rotBody.session.username, 'idp-alice');
    assert.deepEqual(rotBody.principal.roles, ['developer', 'analyst']);

    // The rotated session works on protected routes.
    const whoami = await jsonRequest('GET', `${base}/whoami`, undefined, rotBody.session.token);
    assert.equal(whoami.status, 200);
    assert.equal((whoami.body as { principal: { username: string } }).principal.username, 'idp-alice');

    // Bad rotate → 401.
    const badRotate = await jsonRequest('POST', `${base}/pki/idp/rotate`, { refreshToken: 'nope', clientId: creds.clientId, clientSecret: creds.clientSecret });
    assert.equal(badRotate.status, 401);
  });

  it('multi-user TANYA: org-scoped chat + sharing via the IdP identity bridge', async () => {
    // Register a second user (recipient) + login.
    await jsonRequest('POST', `${base}/auth/register`, { username: 'tanya-recipient', password: 'pw', roles: ['developer'] });
    const recLogin = await jsonRequest('POST', `${base}/auth/login`, { username: 'tanya-recipient', password: 'pw' });
    const recToken = (recLogin.body as { token: string }).token;

    // Owner links an IdP identity for the recipient (admin can upsert profiles).
    // The console linking flow registers sub = platform userId.
    const who = await jsonRequest('GET', `${base}/whoami`, undefined, recToken);
    const recUserId = (who.body as { principal: { userId: string } }).principal.userId;
    await jsonRequest('POST', `${base}/pki/idp/profile`, { sub: recUserId, preferred_username: 'tanya-recipient', email: 'tanya-recipient@jataqi.local', roles: ['developer'] }, token);
    // TANYA learns the mapping via /tanya/identify? No — registerIdentity is module-side.
    // Use the tanya module directly for the identity index (mirrors the UI flow).
    const tanya = kernel.getModule<TanyaModule>('tanya');
    tanya.registerIdentity({ sub: recUserId, email: 'tanya-recipient@jataqi.local', preferred_username: 'tanya-recipient' });

    // Org-scoped chat.
    const chat = await jsonRequest('POST', `${base}/tanya/chat`, { message: 'org-scoped hello', orgId: 'org-x' }, token);
    assert.equal(chat.status, 200);
    const convId = (chat.body as { conversationId: string }).conversationId;

    // Org filter on the list.
    const listed = await jsonRequest('GET', `${base}/tanya/conversations?orgId=org-x`, undefined, token);
    assert.equal((listed.body as { total: number }).total, 1);

    // Share with the recipient via IdP email.
    const share = await jsonRequest('POST', `${base}/tanya/share`, { conversationId: convId, email: 'tanya-recipient@jataqi.local' }, token);
    assert.equal(share.status, 201);
    const shareBody = share.body as { share: { recipientUserId: string; via: string } };
    assert.equal(shareBody.share.recipientUserId, recUserId);
    assert.equal(shareBody.share.via, 'email');

    // Recipient sees the shared conversation.
    const inbox = await jsonRequest('GET', `${base}/tanya/shared`, undefined, recToken);
    assert.equal((inbox.body as { count: number }).count, 1);

    // Owner grant list.
    const grants = await jsonRequest('GET', `${base}/tanya/shares?id=${convId}`, undefined, token);
    assert.equal((grants.body as { count: number }).count, 1);

    // Unshare → recipient loses access.
    const unshare = await jsonRequest('POST', `${base}/tanya/unshare`, { conversationId: convId, recipientUserId: recUserId }, token);
    assert.equal(unshare.status, 200);
    assert.equal((unshare.body as { removed: boolean }).removed, true);
    const inboxAfter = await jsonRequest('GET', `${base}/tanya/shared`, undefined, recToken);
    assert.equal((inboxAfter.body as { count: number }).count, 0);

    // Ownership enforced over HTTP.
    const hack = await jsonRequest('POST', `${base}/tanya/share`, { conversationId: convId, recipientUserId: 'x' }, recToken);
    assert.equal(hack.status, 400);
    assert.match((hack.body as { error: string }).error, /does not belong to this user/);
  });

  it('GET /audit/export returns CSV and JSON compliance documents', async () => {
    const before = await jsonRequest('GET', `${base}/audit?limit=100`, undefined, token);
    const beforeCount = (before.body as { count: number }).count;
    // Prior tests wrote audit records fire-and-forget — wait until the
    // filtered records are visible before exporting.
    let ready = 0;
    for (let i = 0; i < 30; i++) {
      const probe = (await jsonRequest('GET', `${base}/audit?action=tool.approval.decided`, undefined, token)).body as { count: number };
      ready = probe.count;
      if (ready >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(ready >= 1, 'approval decisions recorded before export');

    // CSV export (default format) — text/csv + attachment disposition.
    const csvRes = await fetch(`${base}/audit/export?action=tool.approval.decided`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type')!, /text\/csv/);
    assert.match(csvRes.headers.get('content-disposition')!, /attachment; filename="audit-.*\.csv"/);
    const csv = await csvRes.text();
    assert.ok(csv.startsWith('id,ts,actor,action,result,resource,detail'), 'CSV header present');
    assert.ok(csv.includes('tool.approval.decided'), 'rows include the filtered action');

    // JSON export — application/json + parseable array.
    const jsonRes = await fetch(`${base}/audit/export?action=tool.approval.decided&format=json`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(jsonRes.status, 200);
    assert.match(jsonRes.headers.get('content-type')!, /application\/json/);
    const jsonText = await jsonRes.text();
    const json = JSON.parse(jsonText) as Array<{ action: string }>;
    assert.ok(json.length >= 1);
    for (const r of json) assert.equal(r.action, 'tool.approval.decided');

    // Filters + since apply; total ledger unaffected by export.
    const after = await jsonRequest('GET', `${base}/audit?limit=100`, undefined, token);
    assert.equal((after.body as { count: number }).count, beforeCount);

    // Unauthenticated → 401.
    const anon = await fetch(`${base}/audit/export`);
    assert.equal(anon.status, 401);
  });

  it('POST /pki/idp/console-login — IdP-first passwordless login (client-credentials)', async () => {
    // Admin registers a user-bound console client via the gateway (pki:write).
    const who = await jsonRequest('GET', `${base}/whoami`, undefined, token);
    const adminUserId = (who.body as { principal: { userId: string } }).principal.userId;
    const client = await jsonRequest('POST', `${base}/pki/idp/clients`, {
      name: 'console-first', redirectUris: ['https://console.example.com/ui'], userId: adminUserId,
    }, token);
    assert.equal(client.status, 201);
    const creds = client.body as { clientId: string; clientSecret: string; userId: string };
    assert.equal(creds.userId, adminUserId);

    // Passwordless login with ONLY the client secret.
    const login = await jsonRequest('POST', `${base}/pki/idp/console-login`, { clientId: creds.clientId, clientSecret: creds.clientSecret });
    assert.equal(login.status, 200);
    const body2 = login.body as { ok: boolean; session: { token: string; username: string }; principal: { userId: string } };
    assert.equal(body2.ok, true);
    assert.equal(body2.principal.userId, adminUserId);
    assert.equal(body2.session.username, 'admin');

    // The minted session works on protected routes.
    const whoami = await jsonRequest('GET', `${base}/whoami`, undefined, body2.session.token);
    assert.equal((whoami.body as { principal: { username: string } }).principal.username, 'admin');

    // Bad secret → 401.
    const bad = await jsonRequest('POST', `${base}/pki/idp/console-login`, { clientId: creds.clientId, clientSecret: 'wrong' });
    assert.equal(bad.status, 401);

    // Missing fields → 400.
    const missing = await jsonRequest('POST', `${base}/pki/idp/console-login`, { clientId: creds.clientId });
    assert.equal(missing.status, 400);
  });

  it('org-aware TANYA: invite → accept → org-scoped chat (full loop)', async () => {
    // Owner (admin) creates an org.
    const org = await jsonRequest('POST', `${base}/orgs`, { name: 'Acme Org' }, token);
    assert.equal(org.status, 201);
    const orgId = (org.body as { organization: { id: string; ownerId: string } }).organization.id;

    // Owner invites the recipient by email (userId not yet known).
    const invite = await jsonRequest('POST', `${base}/org`, { id: orgId, action: 'invite', target: 'colleague@acme.io' }, token);
    assert.equal(invite.status, 201);
    const invToken = (invite.body as { invitation: { token: string } }).invitation.token;

    // Recipient (existing user from a prior test) accepts.
    const recLogin = await jsonRequest('POST', `${base}/auth/login`, { username: 'tanya-recipient', password: 'pw' });
    const recToken = (recLogin.body as { token: string }).token;
    const accept = await jsonRequest('POST', `${base}/org`, { id: orgId, action: 'accept', token: invToken }, recToken);
    assert.equal(accept.status, 200);

    // Both users now list the org.
    const ownerOrgs = (await jsonRequest('GET', `${base}/orgs`, undefined, token)).body as { organizations: { id: string }[] };
    assert.ok(ownerOrgs.organizations.some((o) => o.id === orgId));
    const recOrgs = (await jsonRequest('GET', `${base}/orgs`, undefined, recToken)).body as { organizations: { id: string }[] };
    assert.ok(recOrgs.organizations.some((o) => o.id === orgId), 'recipient sees the org after accepting');

    // Org-scoped TANYA chat (owner).
    const chat = await jsonRequest('POST', `${base}/tanya/chat`, { message: 'org hello', orgId }, token);
    assert.equal(chat.status, 200);
    const convId = (chat.body as { conversationId: string }).conversationId;

    // Org-scoped list reflects only this org's conversations.
    const scoped = (await jsonRequest('GET', `${base}/tanya/conversations?orgId=${orgId}`, undefined, token)).body as { total: number };
    assert.ok(scoped.total >= 1);

    // Owner shares with the recipient (by platform userId).
    const who = await jsonRequest('GET', `${base}/whoami`, undefined, recToken);
    const recUserId = (who.body as { principal: { userId: string } }).principal.userId;
    const share = await jsonRequest('POST', `${base}/tanya/share`, { conversationId: convId, recipientUserId: recUserId }, token);
    assert.equal(share.status, 201);
    const inbox = (await jsonRequest('GET', `${base}/tanya/shared`, undefined, recToken)).body as { count: number };
    assert.equal(inbox.count, 1);
  });

  it('GET /governance/alerts evaluates SLA rules live', async () => {
    const res = await jsonRequest('GET', `${base}/governance/alerts`, undefined, token);
    assert.equal(res.status, 200);
    const body2 = res.body as { checkedAt: number; alerts: Array<{ id: string; state: string; severity: string }> };
    assert.ok(body2.checkedAt > 0);
    const ids = body2.alerts.map((a) => a.id);
    assert.deepEqual(ids, ['approval-queue-age', 'deny-spike', 'r4-invocation-rate']);
    for (const a of body2.alerts) assert.ok(['firing', 'ok'].includes(a.state));
    for (const a of body2.alerts) assert.ok(['warning', 'critical'].includes(a.severity));
  });
});
