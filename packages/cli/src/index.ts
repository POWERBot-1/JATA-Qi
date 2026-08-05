#!/usr/bin/env node
// JATA Qi CLI — boots the OS and offers simple commands.

import { createJataQiFromEnv, startScheduledBackupsFromEnv } from './bootstrap.js';
import { loadEnv, readConfig } from './config.js';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { AgentRuntimeModule } from '@jataqi/agent-runtime';
import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { ModelRegistryModule } from '@jataqi/model-registry';
import { SimulationModule, uniform, constant } from '@jataqi/simulation';
import { PluginManagerModule } from '@jataqi/plugins';
import type { SearchModule } from '@jataqi/search';
import type { DigitalMemoryModule } from '@jataqi/memory';
import type { ContinuousLearningModule } from '@jataqi/learning';
import type { AiLearningModule } from '@jataqi/ai-learning';
import type { UniversalWalletModule } from '@jataqi/universal-wallet';
import type { CryptoModule } from '@jataqi/crypto';
import type { DashboardModule } from '@jataqi/dashboard';
import type { BrandingModule } from '@jataqi/branding';
import type { AutomationModule } from '@jataqi/automation';
import type { FxModule } from '@jataqi/fx';
import type { PkiModule } from '@jataqi/pki';
import type { MobilityModule } from '@jataqi/mobility';
import type { LogisticsModule } from '@jataqi/logistics';
import type { AgricultureModule } from '@jataqi/agriculture';
import type { CircularModule } from '@jataqi/circular';
import type { EnergyModule } from '@jataqi/energy';
import type { BorderModule } from '@jataqi/border';
import type { RestaurantsModule } from '@jataqi/restaurants';
import type { MarketplaceModule } from '@jataqi/marketplace';
import type { OrchestratorModule } from '@jataqi/orchestrator';

const HELP = `
JATA Qi CLI
-----------
Commands:
  serve [port]        Boot the platform and start the HTTP API gateway (default port from
                      JATAQI_GATEWAY_PORT or 7400). Exposes /health, /auth/*, /qil, /objective,
                      /ask, /audit, /stats, /models, /simulate, /metrics.
  ask <question>      Run a single question through the default agent and exit.
  ingest <file>       Ingest a text file into the knowledge base.
  models [capability] List registered models (optionally filtered by capability).
  simulate            Run a built-in Monte-Carlo revenue scenario demo.
  plugins             List installed plugins.
  stats               Print knowledge/vector/graph stats.
  search <query>      Semantic search (no agent) — top 3 chunks.
  find <query>        Unified search across knowledge, memory, graph, conversations
                      and tools [--sources a,b] [--user u] [--org o] [--topK n] [--json].
  entities [<type>]   List entities in the knowledge graph.
  memory <sub>        Digital memory: record|query|stats|policy|sweep.
  learning <sub>      Continuous learning: analyze|recommendations|adapt|distill|lessons|playbooks|distill-stats.
  prompts <sub>       AI prompt registry: list|create|render.
  experiments <sub>   Prompt experiments (CLP P4): list|create|evaluate|conclude|cancel.
  wallet <sub>        Universal wallet: open|balance|transfer|summary.
  crypto <sub>        KRT platform: assets|balance|summary.
  dashboard <sub>     Adaptive dashboard: layouts|adapt.
  brands list         List the 15 JATA Qi product brands.
  automation <sub>    SOMA AI: list|show|create|run|executions|stats|enable|disable|remove.
  fx <sub>            KARIS FX: rates|rate|set|convert|history|analytics|currencies|stats.
  pki <sub>           PKI: status|root|cas|issue|list|revoke|crl|ra|client|discovery.
  mobility <sub>      MOTO X: vehicles|fleets|drivers|trip|telemetry|geofences|stats.
  logistics <sub>     PORTLINK: ports|vessels|containers|shipments|track|warehouses|stats.
  farm <sub>          KARIS FARM: farms|fields|plant|harvest|herds|stats.
  circular <sub>      KARIS LOOP: streams|collect|collections|takeback|score|stats.
  qil <sub>           QiL language: parse|compile|format|lint|run <file|->.
  energy <sub>        KARIS ENERGY: assets|asset|meters|reading|tariffs|bill|stats.
  border <sub>        KARIS BORDER X: posts|post|watchlist|crossing|manifests|manifest|stats.
  kitchen <sub>       NYUMBANI KITCHEN: venues|menu|tables|order|ingredients|stats.
  maza <sub>          MAZA marketplace: storefronts|listings|reviews|purchase|categories|stats.
  repl                Start an interactive REPL.
  help                Show this help.
  exit / quit         Exit REPL.
`;

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'repl';

  const jataqi = await createJataQiFromEnv();
  const kernel = jataqi.kernel;
  const agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
  const knowledge = kernel.getModule<KnowledgeService>('knowledge');
  const graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
  const search = kernel.getModule<SearchModule>('search');
  const memory = kernel.getModule<DigitalMemoryModule>('memory');
  const learning = kernel.getModule<ContinuousLearningModule>('learning');
  const aiLearning = kernel.getModule<AiLearningModule>('ai-learning');
  const wallet = kernel.getModule<UniversalWalletModule>('universal-wallet');
  const crypto = kernel.getModule<CryptoModule>('crypto');
  const dashboard = kernel.getModule<DashboardModule>('dashboard');
  const branding = kernel.getModule<BrandingModule>('branding');
  const automation = kernel.getModule<AutomationModule>('automation');
  const fx = kernel.getModule<FxModule>('fx');
  const pki = kernel.getModule<PkiModule>('pki');
  const mobility = kernel.getModule<MobilityModule>('mobility');
  const logistics = kernel.getModule<LogisticsModule>('logistics');
  const agriculture = kernel.getModule<AgricultureModule>('agriculture');
  const circular = kernel.getModule<CircularModule>('circular');
  const energy = kernel.getModule<EnergyModule>('energy');
  const border = kernel.getModule<BorderModule>('border');
  const restaurants = kernel.getModule<RestaurantsModule>('restaurants');
  const marketplace = kernel.getModule<MarketplaceModule>('marketplace');
  const orchestrator = kernel.getModule<OrchestratorModule>('orchestrator');
  let longRunning = false;

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        break;
      case 'serve': {
        const env = readConfig();
        const port = args[1] ? Number(args[1]) : env.JATAQI_GATEWAY_PORT ?? 7400;
        const host = env.JATAQI_GATEWAY_HOST ?? '0.0.0.0';
        if (!jataqi.gateway) throw new Error('API gateway module not registered');
        const handle = await jataqi.gateway.listen({ port, host });
        const scheme = handle.secure ? 'https' : 'http';
        console.log(`JATA Qi API gateway listening on ${scheme}://${host}:${handle.port}` + (handle.secure ? ' (TLS)' : ''));
        const backups = startScheduledBackupsFromEnv(kernel);
        console.log(`  GET  /health`);
        console.log(`  POST /auth/register  POST /auth/login`);
        console.log(`  POST /qil           (QiL program -> workflow)`);
        console.log(`  POST /objective     (natural language -> workflow)`);
        console.log(`  POST /ask           POST /audit  GET /stats`);
        // Keep the process alive until signalled.
        const stop = async (sig: string): Promise<void> => {
          console.log(`\nreceived ${sig}, shutting down...`);
          backups.stop?.();
          await handle.close();
          await jataqi.shutdown();
          process.exit(0);
        };
        process.on('SIGINT', () => void stop('SIGINT'));
        process.on('SIGTERM', () => void stop('SIGTERM'));
        longRunning = true;
        return; // the listening server keeps the process alive
      }
      case 'ask': {
        const q = args.slice(1).join(' ');
        if (!q) { console.error('Usage: jataqi ask <question>'); process.exit(1); }
        const res = await agents.run(q);
        console.log(res.answer);
        break;
      }
      case 'ingest': {
        const file = args[1];
        if (!file) { console.error('Usage: jataqi ingest <file>'); process.exit(1); }
        const fs = await import('node:fs/promises');
        const text = await fs.readFile(file, 'utf8');
        const doc = await knowledge.ingestText(text, { title: file });
        // Auto-extract entities for each chunk.
        for (const cid of doc.chunkIds) {
          const c = await knowledge.getChunk(cid);
          if (!c) continue;
          const r = graph.extractFromText(c.text, { chunkId: cid, documentId: doc.id });
          for (const t of r.triples) {
            graph.linkMention(cid, t.object, 0.7, doc.id);
          }
        }
        console.log(`Ingested ${file} → doc ${doc.id} (${doc.chunkIds.length} chunks)`);
        break;
      }
      case 'stats': {
        const ks = await knowledge.stats();
        const gs = graph.stats();
        console.log(JSON.stringify({ knowledge: ks, graph: gs }, null, 2));
        break;
      }
      case 'models': {
        const reg = kernel.getModule<ModelRegistryModule>('model-registry');
        const cap = args[1];
        const models = cap ? reg.byCapability(cap) : reg.list();
        if (models.length === 0) { console.log('(no models)'); break; }
        for (const m of models) {
          console.log(`- ${m.id}\t[${m.provider}]\tcap=${m.capabilities.join(',')}\tq=${m.quality ?? '-'}\tcost=${m.inputCostPer1k ?? '-'}`);
        }
        break;
      }
      case 'simulate': {
        const sim = kernel.getModule<SimulationModule>('simulation');
        const r = await sim.run({
          name: 'revenue-demo',
          description: 'Revenue minus cost (uniform revenue, fixed cost)',
          inputs: { revenue: uniform(80, 120), cost: constant(100) },
          output: (c) => (c.revenue ?? 0) - (c.cost ?? 0),
          trials: 10000,
          seed: 1,
          targets: [0],
        });
        console.log(`scenario=${r.scenario} trials=${r.trials}`);
        console.log(`mean=${r.stats.mean.toFixed(2)} stdev=${r.stats.stdev.toFixed(2)} p05=${r.stats.p05.toFixed(2)} p50=${r.stats.p50.toFixed(2)} p95=${r.stats.p95.toFixed(2)}`);
        console.log(`P(outcome <= 0)=${r.probabilities?.['0']?.toFixed(3)}`);
        console.log(`(${r.caveat})`);
        break;
      }
      case 'plugins': {
        const pm = kernel.getModule<PluginManagerModule>('plugins');
        const list = pm.list();
        console.log(list.length === 0 ? '(no plugins installed)' : list.map((p) => `- ${p.id}@${p.version} [${p.capabilities.join(',')}]${p.enabled ? '' : ' (disabled)'}`).join('\n'));
        break;
      }
      case 'search': {
        const q = args.slice(1).join(' ');
        if (!q) { console.error('Usage: jataqi search <query>'); process.exit(1); }
        const hits = await knowledge.retrieve(q, { topK: 3, expandContext: false });
        for (const h of hits) {
          console.log(`- [${h.score.toFixed(3)}] (doc=${h.document.id}) ${h.chunk.text.slice(0, 200)}${h.chunk.text.length > 200 ? '…' : ''}`);
        }
        break;
      }
      case 'entities': {
        const type = args[1];
        const ents = type ? graph.entitiesByType(type) : graph.allEntities();
        for (const e of ents.slice(0, 50)) console.log(`[${e.type}] ${e.id}\t${e.name}`);
        console.log(`\n${ents.length} entities shown`);
        break;
      }
      case 'find': {
        const q = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        if (!q) { console.error('Usage: jataqi find <query> [--sources a,b] [--user u] [--org o] [--topK n] [--json]'); process.exit(1); }
        const result = await search.search(q, {
          ...(flag('sources') ? { sources: flag('sources')!.split(',').map((s) => s.trim()).filter(Boolean) as never[] } : {}),
          ...(flag('user') ? { userId: flag('user') } : {}),
          ...(flag('org') ? { orgId: flag('org') } : {}),
          ...(flag('topK') ? { topK: Number(flag('topK')) } : {}),
        });
        if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); break; }
        console.log(`${result.total} result(s) in ${result.tookMs}ms`);
        for (const h of result.hits) {
          console.log(`- [${h.source}] ${h.title} (score ${h.score.toFixed(3)})`);
          console.log(`    ${h.snippet.slice(0, 160)}`);
        }
        break;
      }
      case 'memory': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'record': {
            const summary = args.slice(2).filter((a) => !a.startsWith('--')).join(' ');
            if (!summary) { console.error('Usage: jataqi memory record "<summary>" [--category cat] [--user u] [--org o]'); process.exit(1); }
            const res = await memory.record({
              category: (flag('category') ?? 'command') as never,
              summary,
              ...(flag('user') ? { userId: flag('user') } : {}),
              ...(flag('org') ? { orgId: flag('org') } : {}),
            });
            console.log(res.recorded ? `recorded ${res.event?.id}` : `not recorded: ${res.reason}`);
            break;
          }
          case 'query': {
            const events = memory.query({
              ...(flag('category') ? { category: flag('category') as never } : {}),
              ...(flag('user') ? { userId: flag('user') } : {}),
              ...(flag('org') ? { orgId: flag('org') } : {}),
              ...(flag('text') ? { text: flag('text') } : {}),
              ...(flag('limit') ? { limit: Number(flag('limit')) } : {}),
            });
            for (const e of events.slice(0, 25)) console.log(`[${e.ts}] ${e.category} :: ${e.summary}`);
            console.log(`${events.length} event(s)`);
            break;
          }
          case 'stats':
            console.log(JSON.stringify(memory.stats(flag('org')), null, 2));
            break;
          case 'policy': {
            const orgId = flag('org');
            if (!orgId) { console.error('Usage: jataqi memory policy --org <orgId> [--blocked a,b] [--retention n] [--disable]'); process.exit(1); }
            memory.setPolicy({
              orgId,
              ...(flag('blocked') ? { blockedCategories: flag('blocked')!.split(',').map((s) => s.trim()) } : {}),
              ...(flag('retention') ? { retentionDays: Number(flag('retention')) } : {}),
              ...(args.includes('--disable') ? { disabled: true } : {}),
            });
            console.log('policy updated');
            break;
          }
          case 'sweep': {
            const swept = await memory.sweep();
            console.log(`swept ${swept} expired event(s)`);
            break;
          }
          default:
            console.error('Usage: jataqi memory record|query|stats|policy|sweep'); process.exit(1);
        }
        break;
      }
      case 'learning': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'analyze': {
            const result = await learning.analyze(flag('org'));
            console.log(`insights: ${result.insights.length}, recommendations: ${result.recommendations.length}, events: ${result.summary.totalEvents}`);
            break;
          }
          case 'recommendations': {
            const recs = learning.getRecommendations({ ...(flag('status') ? { status: flag('status') as never } : {}), ...(flag('org') ? { orgId: flag('org') } : {}) });
            for (const r of recs) console.log(`[${r.status}] ${r.priority} ${r.title} (${r.category})`);
            console.log(`${recs.length} recommendation(s)`);
            break;
          }
          case 'adapt': {
            const userId = flag('user');
            if (!userId) { console.error('Usage: jataqi learning adapt --user <userId>'); process.exit(1); }
            const result = learning.adapt(userId);
            console.log(JSON.stringify(result ?? null, null, 2));
            break;
          }
          case 'distill': {
            const run = await learning.distill(flag('org'));
            console.log(`distilled ${run.lessons.length} lesson(s), ${run.playbooks.length} playbook(s)`);
            break;
          }
          case 'lessons':
            for (const l of learning.getLessons()) console.log(`[${l.sourceType}] ${l.title} (${l.category}, conf ${l.confidence.toFixed(2)})`);
            console.log(`${learning.getLessons().length} lesson(s)`);
            break;
          case 'playbooks':
            for (const p of learning.getPlaybooks()) console.log(`- ${p.name} [${p.category}] steps=${p.steps.length} lessons=${p.lessonIds.length}`);
            break;
          case 'distill-stats':
            console.log(JSON.stringify(learning.distillStats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi learning analyze|recommendations|adapt|distill|lessons|playbooks|distill-stats'); process.exit(1);
        }
        break;
      }
      case 'prompts': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'list': {
            const prompts = aiLearning.listPrompts(args[2]);
            for (const p of prompts) console.log(`- ${p.id} ${p.name} (${p.category}, versions=${p.versions.length}, active=${p.activeVersionId ? 'yes' : 'no'})`);
            console.log(`${prompts.length} prompt(s)`);
            break;
          }
          case 'create': {
            const name = args[2], content = args[3], category = args[4];
            if (!name || !content || !category) { console.error('Usage: jataqi prompts create <name> <content> <category>'); process.exit(1); }
            const p = aiLearning.createPrompt({ name, content, category });
            console.log(`created ${p.id}`);
            break;
          }
          case 'render': {
            const templateId = args[2];
            let vars: Record<string, string> = {};
            if (flag('vars')) { try { vars = JSON.parse(flag('vars')!) as Record<string, string>; } catch { console.error('--vars must be JSON'); process.exit(1); } }
            if (!templateId) { console.error('Usage: jataqi prompts render <templateId> [--vars \'{"k":"v"}\']'); process.exit(1); }
            console.log(aiLearning.render(templateId, vars));
            break;
          }
          default:
            console.error('Usage: jataqi prompts list|create|render'); process.exit(1);
        }
        break;
      }
      case 'experiments': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'list': {
            const exps = args[2] ? aiLearning.listExperiments(args[2] as never) : aiLearning.listExperiments();
            for (const e of exps) console.log(`[${e.status}] ${e.name} (${e.templateId}) champion=${e.championVersionId.slice(0, 8)} challenger=${e.challengerVersionId.slice(0, 8)}${e.decision ? ` decision=${e.decision}` : ''}`);
            console.log(`${exps.length} experiment(s)`);
            break;
          }
          case 'create': {
            const templateId = args[2], challenger = args[3];
            if (!templateId || !challenger) { console.error('Usage: jataqi experiments create <templateId> <challengerVersionId> [--traffic 0.5] [--by admin]'); process.exit(1); }
            const e = aiLearning.createExperiment({ templateId, challengerVersionId: challenger, createdBy: flag('by') ?? 'cli', ...(flag('traffic') ? { challengerTraffic: Number(flag('traffic')) } : {}) });
            console.log(`created ${e.id}`);
            break;
          }
          case 'evaluate':
          case 'conclude':
          case 'cancel': {
            const id = args[2];
            if (!id) { console.error(`Usage: jataqi experiments ${sub} <id>`); process.exit(1); }
            const result = sub === 'evaluate' ? aiLearning.evaluateExperiment(id) : sub === 'conclude' ? aiLearning.concludeExperiment(id) : aiLearning.cancelExperiment(id);
            console.log(JSON.stringify(result, null, 2));
            break;
          }
          default:
            console.error('Usage: jataqi experiments list|create|evaluate|conclude|cancel'); process.exit(1);
        }
        break;
      }
      case 'wallet': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'open': {
            const ownerId = args[2], role = args[3];
            if (!ownerId || !role) { console.error('Usage: jataqi wallet open <ownerId> <role> [--org o]'); process.exit(1); }
            const w = wallet.openWallet(ownerId, role as never, flag('org'));
            console.log(`wallet ${w.id} opened (${w.role})`);
            break;
          }
          case 'balance': {
            const walletId = args[2], currency = args[3];
            if (!walletId || !currency) { console.error('Usage: jataqi wallet balance <walletId> <currency>'); process.exit(1); }
            console.log(`${currency} ${wallet.balance(walletId, currency).toString()}`);
            break;
          }
          case 'transfer': {
            const from = args[2], to = args[3], currency = args[4], amount = args[5], desc = args[6];
            if (!from || !to || !currency || !amount || !desc) { console.error('Usage: jataqi wallet transfer <from> <to> <currency> <amount> <description>'); process.exit(1); }
            const tx = wallet.transfer(from, to, currency, BigInt(amount), desc);
            console.log(`tx ${tx.ref} settled`);
            break;
          }
          case 'summary': {
            const s = wallet.summary();
            console.log(JSON.stringify({ totalWallets: s.totalWallets, totalTxCount: s.totalTxCount, activeEscrows: s.activeEscrows, ledgerBalanced: wallet.verifyLedger() }, null, 2));
            break;
          }
          default:
            console.error('Usage: jataqi wallet open|balance|transfer|summary'); process.exit(1);
        }
        break;
      }
      case 'crypto': {
        const sub = args[1];
        switch (sub) {
          case 'assets': {
            const symbol = args[2];
            if (symbol) {
              const asset = crypto.getAsset(symbol);
              console.log(asset ? JSON.stringify(asset, null, 2) : 'asset not found');
            } else {
              for (const a of crypto.listAssets()) console.log(`- ${a.symbol} ${a.name} (${a.type}, supply=${a.totalSupply.toString()})`);
              console.log(`${crypto.listAssets().length} asset(s)`);
            }
            break;
          }
          case 'balance': {
            const address = args[2], symbol = args[3];
            if (!address || !symbol) { console.error('Usage: jataqi crypto balance <address> <symbol>'); process.exit(1); }
            console.log(crypto.getBalance(address, symbol).toString());
            break;
          }
          case 'summary':
            console.log(JSON.stringify(crypto.summary(), null, 2));
            break;
          default:
            console.error('Usage: jataqi crypto assets|balance|summary'); process.exit(1);
        }
        break;
      }
      case 'dashboard': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'layouts': {
            const layouts = flag('org') ? dashboard.layoutsForOrg(flag('org')!) : flag('owner') ? dashboard.layoutsForUser(flag('owner')!) : dashboard.layouts.listAll();
            for (const l of layouts) console.log(`- ${l.id} ${l.name} (owner=${l.ownerId}, widgets=${l.widgets.length})`);
            console.log(`${layouts.length} layout(s)`);
            break;
          }
          case 'adapt': {
            const layoutId = args[2], userId = args[3], role = args[4];
            if (!layoutId || !userId) { console.error('Usage: jataqi dashboard adapt <layoutId> <userId> [role]'); process.exit(1); }
            const applied = await dashboard.adapt(layoutId, userId, role);
            console.log(`applied ${applied} widget suggestion(s)`);
            break;
          }
          default:
            console.error('Usage: jataqi dashboard layouts|adapt'); process.exit(1);
        }
        break;
      }
      case 'brands': {
        if (args[1] !== 'list') { console.error('Usage: jataqi brands list'); process.exit(1); }
        for (const id of branding.listProducts()) {
          const b = branding.getBrand(id);
          console.log(`- ${id} :: ${b?.productName ?? id} (${b?.tagline ?? ''})`);
        }
        break;
      }
      case 'automation': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'list': {
            const automations = automation.list({
              ...(args[2] === 'enabled' || args[2] === 'disabled' ? { enabled: args[2] === 'enabled' } : {}),
            });
            for (const a of automations) {
              const t = a.trigger.type === 'schedule' ? `every ${a.trigger.intervalMs}ms`
                : a.trigger.type === 'event' ? `on ${a.trigger.event}`
                : 'manual';
              console.log(`- [${a.enabled ? 'on' : 'off'}] ${a.id} ${a.name} (${t}, runs=${a.runCount})`);
            }
            console.log(`${automations.length} automation(s)`);
            break;
          }
          case 'show': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi automation show <id>'); process.exit(1); }
            const a = automation.get(id);
            console.log(a ? JSON.stringify(a, null, 2) : 'automation not found');
            break;
          }
          case 'create': {
            const name = args[2];
            const triggerType = flag('trigger') ?? 'manual';
            if (!name) { console.error('Usage: jataqi automation create <name> [--trigger schedule|event|manual] [--interval ms] [--event name] [--actions \'[{"type":"memory.record","params":{"summary":"x"}}]\']'); process.exit(1); }
            let actions: Array<Record<string, unknown>> = [];
            if (flag('actions')) {
              try { actions = JSON.parse(flag('actions')!) as Array<Record<string, unknown>>; }
              catch { console.error('--actions must be a JSON array'); process.exit(1); }
            } else {
              actions = [{ type: 'memory.record', params: { summary: name } }];
            }
            const a = automation.create({
              name,
              trigger: (triggerType === 'schedule'
                ? { type: 'schedule', intervalMs: Number(flag('interval') ?? 60_000) }
                : triggerType === 'event'
                  ? { type: 'event', event: flag('event') ?? 'jataqi.automation' }
                  : { type: 'manual' }) as never,
              actions: actions as never,
              createdBy: 'cli',
            });
            console.log(`created ${a.id}`);
            break;
          }
          case 'run': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi automation run <id> [--payload \'{"k":"v"}\']'); process.exit(1); }
            let payload: Record<string, unknown> | undefined;
            if (flag('payload')) { try { payload = JSON.parse(flag('payload')!); } catch { console.error('--payload must be JSON'); process.exit(1); } }
            const exec = await automation.run({ automationId: id, trigger: 'manual', ...(payload ? { payload } : {}) });
            console.log(JSON.stringify({ status: exec.status, results: exec.results, error: exec.error ?? undefined, durationMs: exec.durationMs }, null, 2));
            break;
          }
          case 'executions': {
            const executions = automation.executions({ ...(args[2] ? { automationId: args[2] } : {}) });
            for (const e of executions.slice(0, 20)) console.log(`[${e.status}] ${e.automationId} ${e.trigger} ${e.durationMs ?? 0}ms`);
            console.log(`${executions.length} execution(s)`);
            break;
          }
          case 'stats':
            console.log(JSON.stringify(automation.stats(), null, 2));
            break;
          case 'enable':
          case 'disable': {
            const id = args[2];
            if (!id) { console.error(`Usage: jataqi automation ${sub} <id>`); process.exit(1); }
            const a = automation.setEnabled(id, sub === 'enable');
            console.log(a ? `${a.id} ${a.enabled ? 'enabled' : 'disabled'}` : 'automation not found');
            break;
          }
          case 'remove': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi automation remove <id>'); process.exit(1); }
            console.log(automation.remove(id) ? 'removed' : 'automation not found');
            break;
          }
          default:
            console.error('Usage: jataqi automation list|show|create|run|executions|stats|enable|disable|remove'); process.exit(1);
        }
        break;
      }
      case 'fx': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'set': {
            const base = args[2], quote = args[3], bid = args[4];
            if (!base || !quote || !bid) { console.error('Usage: jataqi fx set <base> <quote> <bid> [--ask n] [--source s]'); process.exit(1); }
            const q = fx.setRate({ base, quote, bid: Number(bid), ...(flag('ask') ? { ask: Number(flag('ask')) } : {}), ...(flag('source') ? { source: flag('source') } : {}) });
            console.log(`${q.pair} bid=${q.bid} ask=${q.ask} (${q.source})`);
            break;
          }
          case 'rates':
            for (const q of fx.listRates()) console.log(`${q.pair}\tbid=${q.bid}\task=${q.ask}\t${q.source}`);
            console.log(`${fx.listRates().length} pair(s)`);
            break;
          case 'rate': {
            const base = args[2], quote = args[3];
            if (!base || !quote) { console.error('Usage: jataqi fx rate <base> <quote>'); process.exit(1); }
            const q = fx.getRate(base, quote);
            console.log(q ? `${q.pair} bid=${q.bid} ask=${q.ask} (${q.source})` : `no rate for ${base}/${quote}`);
            break;
          }
          case 'convert': {
            const from = args[2], to = args[3], amount = args[4];
            if (!from || !to || !amount) { console.error('Usage: jataqi fx convert <from> <to> <amountMinorUnits> [--margin 1.02]'); process.exit(1); }
            try {
              const r = fx.convert({ from, to, amount: BigInt(amount), ...(flag('margin') ? { margin: Number(flag('margin')) } : {}) });
              console.log(`${r.amount} ${r.from} → ${r.result} ${r.to} @ ${r.rate.toFixed(4)} (margin ${r.margin})`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'history': {
            const pair = args[2];
            if (!pair) { console.error('Usage: jataqi fx history <pair> [--limit n]'); process.exit(1); }
            for (const p of fx.historyFor(pair, { ...(flag('limit') ? { limit: Number(flag('limit')) } : {}) }).slice(-10)) {
              console.log(`[${new Date(p.ts).toISOString()}] mid=${p.mid}`);
            }
            break;
          }
          case 'analytics': {
            const pair = args[2];
            if (!pair) { console.error('Usage: jataqi fx analytics <pair> [--windowMs n]'); process.exit(1); }
            const a = fx.analyze(pair, { ...(flag('windowMs') ? { windowMs: Number(flag('windowMs')) } : {}) });
            console.log(a ? JSON.stringify(a, null, 2) : `no history for ${pair}`);
            break;
          }
          case 'currencies':
            console.log(fx.currencies().join(' '));
            break;
          case 'stats':
            console.log(JSON.stringify(fx.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi fx set|rates|rate|convert|history|analytics|currencies|stats'); process.exit(1);
        }
        break;
      }
      case 'pki': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'status':
            console.log(JSON.stringify(pki.stats(), null, 2));
            break;
          case 'root': {
            const cn = args[2] ?? 'JATA Qi Root CA';
            const ca = pki.createRootCa([{ oid: '2.5.4.3', value: cn }, { oid: '2.5.4.10', value: 'JATA Qi' }]);
            console.log(`root CA created: ${ca.id}`);
            break;
          }
          case 'cas':
            for (const c of pki.ca.listCas()) console.log(`[${c.role}] ${c.id} ${c.subject.map((s) => s.value).join(', ')}`);
            console.log(`${pki.ca.listCas().length} CA(s)`);
            break;
          case 'issue': {
            const caId = args[2], cn = args[3];
            if (!caId || !cn) { console.error('Usage: jataqi pki issue <caId> <cn> [--san a.com,b.com]'); process.exit(1); }
            const key = (await import('@jataqi/pki')).generateKeyPair('ec-p256');
            const cert = pki.issueCertificate({
              caId, subject: [{ oid: '2.5.4.3', value: cn }],
              subjectPublicKeyJwk: key.jwk,
              ...(flag('san') ? { sanDnsNames: flag('san')!.split(',').map((s) => s.trim()) } : {}),
            });
            console.log(`issued ${cert.id} (serial ${cert.serialNumber.toString()})`);
            break;
          }
          case 'list':
            for (const c of pki.ca.list()) console.log(`[${pki.ca.effectiveStatus(c)}] ${c.id} ${c.subject.map((s) => s.value).join(', ')}`);
            console.log(`${pki.ca.list().length} certificate(s)`);
            break;
          case 'revoke': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi pki revoke <certId> [--reason keyCompromise]'); process.exit(1); }
            const c = pki.revokeCertificate(id, flag('reason'));
            console.log(`${c.id} ${c.status}`);
            break;
          }
          case 'crl': {
            const caId = args[2];
            if (!caId) { console.error('Usage: jataqi pki crl <caId>'); process.exit(1); }
            const crl = pki.ca.latestCrl(caId);
            console.log(crl ? JSON.stringify({ number: crl.number.toString(), revokedCount: crl.revokedCount, nextUpdate: crl.nextUpdate.toISOString() }, null, 2) : 'no CRL yet');
            break;
          }
          case 'ra': {
            const domains = args[2];
            if (!domains) { console.error('Usage: jataqi pki ra <domain> [--method dns-txt|http-01|email]'); process.exit(1); }
            const key = (await import('@jataqi/pki')).generateKeyPair('ec-p256');
            const req = pki.createRequest({
              domains: domains.split(',').map((s) => s.trim()),
              subject: [{ oid: '2.5.4.3', value: domains.split(',')[0]!.trim() }],
              publicKeyJwk: key.jwk,
              method: (flag('method') ?? 'dns-txt') as never,
              requestedBy: 'cli',
            });
            console.log(JSON.stringify({ id: req.id, proof: pki.ra.proofLocation(req) }, null, 2));
            break;
          }
          case 'client': {
            const name = args[2], redirect = args[3];
            if (!name || !redirect) { console.error('Usage: jataqi pki client <name> <redirectUri>'); process.exit(1); }
            const client = pki.registerIdpClient({ name, redirectUris: [redirect] });
            console.log(JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret }, null, 2));
            break;
          }
          case 'discovery':
            console.log(JSON.stringify(pki.idp.discovery(), null, 2));
            break;
          default:
            console.error('Usage: jataqi pki status|root|cas|issue|list|revoke|crl|ra|client|discovery'); process.exit(1);
        }
        break;
      }
      case 'mobility': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'vehicles': {
            const vehicles = mobility.listVehicles();
            for (const v of vehicles) console.log(`- ${v.registration} ${v.make} ${v.model} [${v.status}]${v.location ? ` @${v.location.lat},${v.location.lng}` : ''}`);
            console.log(`${vehicles.length} vehicle(s)`);
            break;
          }
          case 'register': {
            const reg = args[2], make = args[3], model = args[4];
            if (!reg || !make || !model) { console.error('Usage: jataqi mobility register <registration> <make> <model> [--type car] [--lat n --lng n]'); process.exit(1); }
            const v = mobility.registerVehicle({
              registration: reg, make, model,
              ...(flag('type') ? { type: flag('type') as never } : {}),
              ...(flag('lat') && flag('lng') ? { location: { lat: Number(flag('lat')), lng: Number(flag('lng')) } } : {}),
            });
            console.log(`registered ${v.id}`);
            break;
          }
          case 'trip': {
            const lat1 = args[2], lng1 = args[3], lat2 = args[4], lng2 = args[5];
            if (!lat1 || !lng1 || !lat2 || !lng2) { console.error('Usage: jataqi mobility trip <pickupLat> <pickupLng> <dropoffLat> <dropoffLng> [--rider u1]'); process.exit(1); }
            try {
              const trip = mobility.requestTrip({
                pickup: { lat: Number(lat1), lng: Number(lng1) },
                dropoff: { lat: Number(lat2), lng: Number(lng2) },
                ...(flag('rider') ? { riderId: flag('rider') } : {}),
              });
              console.log(`trip ${trip.id} | ${trip.distanceKm.toFixed(1)}km | fare ${trip.fare} | vehicle ${trip.vehicleId}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'telemetry': {
            const vehicleId = args[2], lat = args[3], lng = args[4];
            if (!vehicleId || !lat || !lng) { console.error('Usage: jataqi mobility telemetry <vehicleId> <lat> <lng> [--speed n]'); process.exit(1); }
            const p = mobility.recordTelemetry({ vehicleId, lat: Number(lat), lng: Number(lng), ...(flag('speed') ? { speedKmh: Number(flag('speed')) } : {}) });
            console.log(`telemetry @${p.ts}`);
            break;
          }
          case 'geofences':
            for (const g of mobility.listGeofences()) console.log(`- ${g.name} ${g.center.lat},${g.center.lng} r=${g.radiusM}m`);
            console.log(`${mobility.listGeofences().length} geofence(s)`);
            break;
          case 'stats':
            console.log(JSON.stringify(mobility.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi mobility vehicles|register|trip|telemetry|geofences|stats'); process.exit(1);
        }
        break;
      }
      case 'logistics': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'ports':
            for (const p of logistics.listPorts()) console.log(`- ${p.code} ${p.name} (${p.country}) ${p.capacityTeu}TEU`);
            console.log(`${logistics.listPorts().length} port(s)`);
            break;
          case 'port': {
            const name = args[2], code = args[3], country = args[4];
            if (!name || !code || !country) { console.error('Usage: jataqi logistics port <name> <code> <country>'); process.exit(1); }
            const p = logistics.registerPort({ name, code, country });
            console.log(`registered ${p.id}`);
            break;
          }
          case 'vessels':
            for (const v of logistics.listVessels()) console.log(`- ${v.name} ${v.imo} [${v.status}]`);
            console.log(`${logistics.listVessels().length} vessel(s)`);
            break;
          case 'shipments':
            for (const s of logistics.listShipments()) console.log(`- ${s.trackingRef} ${s.origin} → ${s.destination} [${s.status}]`);
            console.log(`${logistics.listShipments().length} shipment(s)`);
            break;
          case 'shipment': {
            const origin = args[2], destination = args[3], shipper = args[4], consignee = args[5];
            if (!origin || !destination || !shipper || !consignee) { console.error('Usage: jataqi logistics shipment <origin> <destination> <shipper> <consignee> [--mode sea]'); process.exit(1); }
            const s = logistics.createShipment({ mode: (flag('mode') as never) ?? 'sea', origin, destination, shipper, consignee });
            console.log(`created ${s.id} ref=${s.trackingRef}`);
            break;
          }
          case 'track': {
            const ref = args[2], code = args[3], location = args[4];
            if (!ref || !code || !location) { console.error('Usage: jataqi logistics track <trackingRef> <code> <location>'); process.exit(1); }
            const s = logistics.getShipmentByTrackingRef(ref);
            if (!s) { console.error('shipment not found'); break; }
            const e = await logistics.trackShipment({ shipmentId: s.id, code: code as never, location });
            console.log(`tracked ${e.code} at ${e.location}`);
            break;
          }
          case 'warehouses':
            for (const w of logistics.listWarehouses()) console.log(`- ${w.name} (${w.location}) ${w.usedSlots}/${w.capacitySlots}`);
            console.log(`${logistics.listWarehouses().length} warehouse(s)`);
            break;
          case 'stats':
            console.log(JSON.stringify(logistics.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi logistics ports|port|vessels|shipments|shipment|track|warehouses|stats'); process.exit(1);
        }
        break;
      }
      case 'farm': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'farms':
            for (const f of agriculture.listFarms()) console.log(`- ${f.name} (${f.ownerId}) ${f.areaHa}ha`);
            console.log(`${agriculture.listFarms().length} farm(s)`);
            break;
          case 'farm': {
            const name = args[2], owner = args[3];
            if (!name || !owner) { console.error('Usage: jataqi farm farm <name> <ownerId> [--area n]'); process.exit(1); }
            const f = agriculture.registerFarm({ name, ownerId: owner, ...(flag('area') ? { areaHa: Number(flag('area')) } : {}) });
            console.log(`registered ${f.id}`);
            break;
          }
          case 'fields': {
            const farmId = args[2];
            const fields = farmId ? agriculture.listFields(farmId) : agriculture.listFields();
            for (const f of fields) console.log(`- ${f.name} ${f.areaHa}ha [${f.status}]`);
            console.log(`${fields.length} field(s)`);
            break;
          }
          case 'plant': {
            const fieldId = args[2], crop = args[3];
            if (!fieldId || !crop) { console.error('Usage: jataqi farm plant <fieldId> <crop> [--yield n]'); process.exit(1); }
            try {
              const c = agriculture.plantCrop({ fieldId, crop, ...(flag('yield') ? { expectedYieldKg: Number(flag('yield')) } : {}) });
              console.log(`planted ${c.crop} cycle=${c.id}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'harvest': {
            const cycleId = args[2], yieldKg = args[3];
            if (!cycleId || !yieldKg) { console.error('Usage: jataqi farm harvest <cycleId> <yieldKg>'); process.exit(1); }
            const r = await agriculture.recordHarvest({ cropCycleId: cycleId, yieldKg: Number(yieldKg) });
            console.log(`harvested ${r.harvest.yieldKg}kg of ${r.harvest.crop}`);
            break;
          }
          case 'herds':
            for (const h of agriculture.listHerds()) console.log(`- ${h.type} x${h.headCount} [${h.healthStatus}]`);
            console.log(`${agriculture.listHerds().length} herd(s)`);
            break;
          case 'stats':
            console.log(JSON.stringify(agriculture.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi farm farms|farm|fields|plant|harvest|herds|stats'); process.exit(1);
        }
        break;
      }
      case 'circular': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'streams':
            for (const s of circular.listStreams()) console.log(`- ${s.name} (${s.type}) ${s.co2ePerKg}kgCO2e/kg ${s.active ? '' : '[inactive]'}`);
            console.log(`${circular.listStreams().length} stream(s)`);
            break;
          case 'stream': {
            const name = args[2];
            if (!name) { console.error('Usage: jataqi circular stream <name> [--type plastic] [--co2e 1.5]'); process.exit(1); }
            const s = circular.registerStream({ name, ...(flag('type') ? { type: flag('type') as never } : {}), ...(flag('co2e') ? { co2ePerKg: Number(flag('co2e')) } : {}) });
            console.log(`registered ${s.id}`);
            break;
          }
          case 'collect': {
            const streamId = args[2], weightKg = args[3], source = args[4];
            if (!streamId || !weightKg || !source) { console.error('Usage: jataqi circular collect <streamId> <weightKg> <source>'); process.exit(1); }
            try {
              const c = await circular.recordCollection({ streamId, weightKg: Number(weightKg), source });
              console.log(`collected ${c.id} (${c.weightKg}kg)`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'collections':
            for (const c of circular.listCollections()) console.log(`- ${c.id} ${c.weightKg}kg [${c.status}] from ${c.source}`);
            console.log(`${circular.listCollections().length} collection(s)`);
            break;
          case 'takeback': {
            const productId = args[2], productName = args[3], returnedBy = args[4];
            if (!productId || !productName || !returnedBy) { console.error('Usage: jataqi circular takeback <productId> <productName> <returnedBy>'); process.exit(1); }
            const item = circular.registerTakeBack({ productId, productName, composition: {}, returnedBy });
            console.log(`registered ${item.id}`);
            break;
          }
          case 'score': {
            const scopeId = args[2];
            if (!scopeId) { console.error('Usage: jataqi circular score <productId|orgId> [--scope product|organization]'); process.exit(1); }
            const score = circular.scoreCircularity((flag('scope') === 'organization' ? 'organization' : 'product'), scopeId);
            console.log(JSON.stringify(score, null, 2));
            break;
          }
          case 'stats':
            console.log(JSON.stringify(circular.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi circular streams|stream|collect|collections|takeback|score|stats'); process.exit(1);
        }
        break;
      }
      case 'qil': {
        const sub = args[1];
        if (!sub || !['parse', 'compile', 'format', 'lint', 'run'].includes(sub)) {
          console.error('Usage: jataqi qil parse|compile|format|lint|run <file.qil|->'); process.exit(1);
        }
        const fileArg = args[2] ?? '-';
        let source: string;
        if (fileArg === '-') {
          source = await readStdin();
        } else {
          const fs = await import('node:fs/promises');
          source = await fs.readFile(fileArg, 'utf8');
        }
        switch (sub) {
          case 'parse': {
            try {
              const { parse } = await import('@jataqi/qil');
              console.log(JSON.stringify(parse(source), null, 2));
            } catch (err) {
              console.error((err as Error).message);
              process.exit(1);
            }
            break;
          }
          case 'compile': {
            const { compileSource } = await import('@jataqi/qil');
            const result = compileSource(source);
            if (!result.ok) {
              for (const d of result.diagnostics) {
                console.error(`[${d.severity}]${d.line ? ` ${d.line}:${d.col}` : ''} ${d.message}`);
              }
              process.exit(1);
            }
            console.log(JSON.stringify(result.plan, null, 2));
            break;
          }
          case 'format': {
            const { format } = await import('@jataqi/qil');
            try {
              process.stdout.write(format(source));
            } catch (err) {
              console.error((err as Error).message);
              process.exit(1);
            }
            break;
          }
          case 'lint': {
            const { lintSource } = await import('@jataqi/qil');
            const diags = lintSource(source);
            if (diags.length === 0) { console.log('no issues found'); break; }
            for (const d of diags) {
              console.log(`${d.severity === 'error' ? 'error' : 'warn'} ${d.line ?? '?'}:${d.col ?? '?'} ${d.message}`);
            }
            process.exitCode = diags.some((d) => d.severity === 'error') ? 1 : 0;
            break;
          }
          case 'run': {
            // Auto-provision agents declared in the plan so `-> agent`
            // routing works out of the box (each agent uses the default LLM).
            const { compileSource } = await import('@jataqi/qil');
            const compiled = compileSource(source);
            if (compiled.ok && compiled.plan) {
              for (const agentName of compiled.plan.agents) {
                let exists = false;
                try { agents.getAgent(agentName); exists = true; } catch { /* not registered */ }
                if (!exists) {
                  try { agents.createAgent(agentName, { description: `QiL-declared agent ${agentName}` }); }
                  catch { /* already exists — race */ }
                }
              }
            }
            const result = await orchestrator.runSource(source);
            console.log(JSON.stringify({
              status: result.status,
              steps: result.steps?.map((s) => ({ id: s.stepId, kind: s.kind, status: s.status, error: s.error ?? undefined })) ?? [],
              finalReport: result.finalReport ?? undefined,
              auditRecordId: result.auditRecordId ?? undefined,
            }, null, 2));
            break;
          }
        }
        break;
      }
      case 'energy': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'assets':
            for (const a of energy.listAssets()) console.log(`- ${a.name} (${a.source}) ${a.capacityKw}kW [${a.status}]`);
            console.log(`${energy.listAssets().length} asset(s)`);
            break;
          case 'asset': {
            const name = args[2], source = args[3], capacity = args[4];
            if (!name || !source || !capacity) { console.error('Usage: jataqi energy asset <name> <source> <capacityKw>'); process.exit(1); }
            const a = energy.registerAsset({ name, source: source as never, capacityKw: Number(capacity) });
            console.log(`registered ${a.id}`);
            break;
          }
          case 'meters':
            for (const m of energy.listMeters()) console.log(`- ${m.name}${m.customerId ? ` (${m.customerId})` : ''}`);
            console.log(`${energy.listMeters().length} meter(s)`);
            break;
          case 'meter': {
            const name = args[2];
            if (!name) { console.error('Usage: jataqi energy meter <name> [--customer c1]'); process.exit(1); }
            const m = energy.registerMeter({ name, ...(flag('customer') ? { customerId: flag('customer') } : {}) });
            console.log(`registered ${m.id}`);
            break;
          }
          case 'reading': {
            const meterId = args[2], kwh = args[3];
            if (!meterId || !kwh) { console.error('Usage: jataqi energy reading <meterId> <kwh>'); process.exit(1); }
            try {
              const r = await energy.recordReading({ meterId, kwh: Number(kwh) });
              console.log(`recorded ${r.id} @ ${r.kwh}kWh`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'tariffs':
            for (const t of energy.listTariffs()) console.log(`- ${t.name} ${t.pricePerKwh}/kWh + ${t.fixedCharge} fixed`);
            console.log(`${energy.listTariffs().length} tariff(s)`);
            break;
          case 'bill': {
            const meterId = args[2], tariffId = args[3];
            if (!meterId || !tariffId) { console.error('Usage: jataqi energy bill <meterId> <tariffId> [--from <readingId>]'); process.exit(1); }
            try {
              const bill = await energy.bill({ meterId, tariffId, ...(flag('from') ? { fromReadingId: flag('from') } : {}) });
              console.log(`bill ${bill.total} units (${bill.kwhUsed}kWh)`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'stats':
            console.log(JSON.stringify(energy.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi energy assets|asset|meters|meter|reading|tariffs|bill|stats'); process.exit(1);
        }
        break;
      }
      case 'border': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'posts':
            for (const p of border.listPosts()) console.log(`- ${p.name} (${p.crossing}) [${p.status}]`);
            console.log(`${border.listPosts().length} post(s)`);
            break;
          case 'post': {
            const name = args[2], crossing = args[3];
            if (!name || !crossing) { console.error('Usage: jataqi border post <name> <crossing>'); process.exit(1); }
            const p = border.registerPost({ name, crossing });
            console.log(`registered ${p.id}`);
            break;
          }
          case 'watchlist':
            for (const w of border.listWatchlist()) console.log(`- ${w.name} ${w.documentNo} [${w.category}] ${w.active ? '' : '(inactive)'}`);
            console.log(`${border.listWatchlist().length} entry(ies)`);
            break;
          case 'crossing': {
            const postId = args[2], name = args[3], doc = args[4];
            if (!postId || !name || !doc) { console.error('Usage: jataqi border crossing <postId> <travelerName> <documentNo> [--mode road] [--dir inbound]'); process.exit(1); }
            const c = await border.processCrossing({
              postId, travelerId: 'cli', travelerName: name, documentNo: doc,
              mode: (flag('mode') as never) ?? 'road', direction: (flag('dir') as never) ?? 'inbound',
            });
            console.log(`${c.travelerName}: ${c.clearance}${c.reason ? ` (${c.reason})` : ''}`);
            break;
          }
          case 'manifests':
            for (const m of border.listManifests()) console.log(`- ${m.reference} ${m.description} ${m.weightKg}kg [${m.status}]${m.flagged ? ' FLAGGED' : ''}`);
            console.log(`${border.listManifests().length} manifest(s)`);
            break;
          case 'manifest': {
            const postId = args[2], ref = args[3], desc = args[4], weight = args[5];
            if (!postId || !ref || !desc || !weight) { console.error('Usage: jataqi border manifest <postId> <reference> <description> <weightKg>'); process.exit(1); }
            const m = await border.declareManifest({ postId, reference: ref, consignor: 'cli', consignee: 'cli', description: desc, weightKg: Number(weight) });
            console.log(`${m.reference} [${m.status}]${m.flagged ? ' FLAGGED for inspection' : ''}`);
            break;
          }
          case 'stats':
            console.log(JSON.stringify(border.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi border posts|post|watchlist|crossing|manifests|manifest|stats'); process.exit(1);
        }
        break;
      }
      case 'kitchen': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'venues':
            for (const v of restaurants.listVenues()) console.log(`- ${v.name}${v.cuisine ? ` (${v.cuisine})` : ''}`);
            console.log(`${restaurants.listVenues().length} venue(s)`);
            break;
          case 'venue': {
            const name = args[2], owner = args[3];
            if (!name || !owner) { console.error('Usage: jataqi kitchen venue <name> <ownerId> [--cuisine x]'); process.exit(1); }
            const v = restaurants.registerVenue({ name, ownerId: owner, ...(flag('cuisine') ? { cuisine: flag('cuisine') } : {}) });
            console.log(`registered ${v.id}`);
            break;
          }
          case 'menu': {
            const venueId = args[2];
            if (!venueId) { console.error('Usage: jataqi kitchen menu <venueId>'); process.exit(1); }
            for (const m of restaurants.listMenu(venueId)) console.log(`- ${m.name} ${m.price} [${m.category}]${m.available ? '' : ' SOLD OUT'}`);
            console.log(`${restaurants.listMenu(venueId).length} item(s)`);
            break;
          }
          case 'item': {
            const venueId = args[2], name = args[3], price = args[4];
            if (!venueId || !name || !price) { console.error('Usage: jataqi kitchen item <venueId> <name> <price> [--category main]'); process.exit(1); }
            const m = restaurants.addMenuItem({ venueId, name, price: Number(price), ...(flag('category') ? { category: flag('category') as never } : {}) });
            console.log(`added ${m.id}`);
            break;
          }
          case 'tables': {
            const venueId = args[2];
            if (!venueId) { console.error('Usage: jataqi kitchen tables <venueId>'); process.exit(1); }
            for (const t of restaurants.listTables(venueId)) console.log(`- ${t.number} (${t.seats}) [${t.status}]`);
            console.log(`${restaurants.listTables(venueId).length} table(s)`);
            break;
          }
          case 'order': {
            const venueId = args[2];
            if (!venueId) { console.error('Usage: jataqi kitchen order <venueId> --items <menuItemId>x<qty>[,<id>x<qty>] [--table T1]'); process.exit(1); }
            const items = flag('items');
            if (!items) { console.error('--items is required (e.g. --items abc123x2,def456x1)'); process.exit(1); }
            const lines = items.split(',').map((part) => {
              const [menuItemId, qty] = part.split('x');
              return { menuItemId: menuItemId!, quantity: Number(qty ?? 1) };
            });
            try {
              const o = await restaurants.createOrder({ venueId, lines, ...(flag('table') ? { tableId: flag('table') } : {}) });
              console.log(`order ${o.id} opened`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'orders': {
            const venueId = args[2];
            const orders = venueId ? restaurants.listOrders({ venueId }) : restaurants.listOrders();
            for (const o of orders) console.log(`- ${o.id} [${o.status}] ${o.lines.length} lines ${o.total}`);
            console.log(`${orders.length} order(s)`);
            break;
          }
          case 'ingredients': {
            const venueId = args[2];
            if (!venueId) { console.error('Usage: jataqi kitchen ingredients <venueId>'); process.exit(1); }
            for (const i of restaurants.listIngredients(venueId)) console.log(`- ${i.name} ${i.stock} (reorder at ${i.reorderLevel})${i.stock <= i.reorderLevel ? ' LOW' : ''}`);
            console.log(`${restaurants.listIngredients(venueId).length} ingredient(s)`);
            break;
          }
          case 'stats':
            console.log(JSON.stringify(restaurants.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi kitchen venues|venue|menu|item|tables|order|orders|ingredients|stats'); process.exit(1);
        }
        break;
      }
      case 'maza': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'storefronts':
            for (const s of marketplace.listStorefronts()) console.log(`- ${s.name} (${s.vendorId}) [${s.status}] rating=${s.rating} (${s.reviewCount})`);
            console.log(`${marketplace.listStorefronts().length} storefront(s)`);
            break;
          case 'storefront': {
            const vendor = args[2], name = args[3];
            if (!vendor || !name) { console.error('Usage: jataqi maza storefront <vendorId> <name> [--categories a,b]'); process.exit(1); }
            const s = marketplace.registerStorefront({ vendorId: vendor, name, ...(flag('categories') ? { categories: flag('categories')!.split(',') } : {}) });
            console.log(`registered ${s.id}`);
            break;
          }
          case 'listings': {
            const listings = marketplace.listListings({ ...(flag('q') ? { query: flag('q') } : {}), ...(flag('category') ? { category: flag('category') } : {}) });
            for (const l of listings) console.log(`- ${l.title} ${l.priceMinor} ${l.currency} [${l.status}]${l.stock !== undefined ? ` stock=${l.stock}` : ''} ★${l.rating}`);
            console.log(`${listings.length} listing(s)`);
            break;
          }
          case 'listing': {
            const sfId = args[2], title = args[3], category = args[4], price = args[5];
            if (!sfId || !title || !category || !price) { console.error('Usage: jataqi maza listing <storefrontId> <title> <category> <priceMinor> [--stock n]'); process.exit(1); }
            try {
              const l = await marketplace.createListing({ storefrontId: sfId, title, category, priceMinor: Number(price), ...(flag('stock') ? { stock: Number(flag('stock')) } : {}) });
              console.log(`created ${l.id}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'review': {
            const listingId = args[2], reviewer = args[3], rating = args[4];
            if (!listingId || !reviewer || !rating) { console.error('Usage: jataqi maza review <listingId> <reviewerId> <rating 1-5> [--comment x]'); process.exit(1); }
            try {
              const r = await marketplace.addReview({ listingId, reviewerId: reviewer, rating: Number(rating), ...(flag('comment') ? { comment: flag('comment') } : {}) });
              console.log(`review ${r.id} (${r.rating}★)`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'purchase': {
            const listingId = args[2], buyer = args[3];
            if (!listingId || !buyer) { console.error('Usage: jataqi maza purchase <listingId> <buyerId>'); process.exit(1); }
            const r = await marketplace.purchase(listingId, buyer);
            console.log(r.ok ? `purchased (order ${r.orderId ?? 'local'})` : `failed: ${r.error}`);
            break;
          }
          case 'categories':
            console.log(marketplace.categories().join(', '));
            break;
          case 'stats':
            console.log(JSON.stringify(marketplace.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi maza storefronts|storefront|listings|listing|review|purchase|categories|stats'); process.exit(1);
        }
        break;
      }
      case 'repl':
      default: {
        const rl = readline.createInterface({ input, output });
        console.log('JATA Qi REPL. Type "help" for commands, "exit" to quit.');
        while (true) {
          const line = (await rl.question('jataqi> ')).trim();
          if (!line) continue;
          if (line === 'exit' || line === 'quit') break;
          if (line === 'help') { console.log(HELP); continue; }
          if (line.startsWith('ingest ') || line.startsWith('search ') || line.startsWith('find ') || line.startsWith('stats') || line.startsWith('entities') || line.startsWith('memory ') || line.startsWith('learning ') || line.startsWith('prompts ') || line.startsWith('experiments ') || line.startsWith('wallet ') || line.startsWith('crypto ') || line.startsWith('dashboard ') || line.startsWith('brands ') || line.startsWith('automation ') || line.startsWith('fx ') || line.startsWith('pki ') || line.startsWith('mobility ') || line.startsWith('logistics ') || line.startsWith('farm ') || line.startsWith('circular ') || line.startsWith('qil ') || line.startsWith('energy ') || line.startsWith('border ') || line.startsWith('kitchen ') || line.startsWith('maza ')) {
            const parts = line.split(/\s+/);
            process.argv = ['node', 'jataqi', ...parts];
            await main(); // restart command dispatch (simple impl)
            continue;
          }
          const res = await agents.run(line);
          console.log(res.answer);
        }
        rl.close();
        break;
      }
    }
  } finally {
    if (!longRunning) await jataqi.shutdown();
  }
}

/** Read all of stdin as UTF-8 text (for `qil ... -`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
