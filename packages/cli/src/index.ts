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
import type { CloudModule } from '@jataqi/cloud';
import type { ActiveDefenseModule } from '@jataqi/active-defense';
import type { SocModule } from '@jataqi/soc';

/** SOC incident severity → escalation SLA in minutes (mirrors the module). */
function severityToSlaMin(severity: string): number {
  switch (severity) {
    case 'sev1': case 'critical': return 15;
    case 'sev2': case 'high': return 60;
    case 'sev3': case 'medium': return 480;
    default: return 1440;
  }
}
import type { CdnModule } from '@jataqi/cdn';
import type { EmailModule } from '@jataqi/email';
import type { IpamModule } from '@jataqi/ipam';
import type { TanyaModule } from '@jataqi/tanya';
import type { OrganizationsModule } from '@jataqi/organizations';
import type { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
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
  pki <sub>           PKI: status|root|cas|issue|list|revoke|crl|ra|client|discovery|acme.
  pki acme <sub>      ACME (RFC 8555): directory|nonce|new-account|new-order|challenge|validate|proof|finalize|cert|revoke.
  mobility <sub>      MOTO X: vehicles|fleets|drivers|trip|telemetry|geofences|stats.
  logistics <sub>     PORTLINK: ports|vessels|containers|shipments|track|warehouses|stats.
  farm <sub>          KARIS FARM: farms|fields|plant|harvest|herds|stats.
  circular <sub>      KARIS LOOP: streams|collect|collections|takeback|score|stats.
  qil <sub>           QiL language: parse|compile|format|lint|run <file|->.
  energy <sub>        KARIS ENERGY: assets|asset|meters|reading|tariffs|bill|stats.
  border <sub>        KARIS BORDER X: posts|post|watchlist|crossing|manifests|manifest|stats.
  kitchen <sub>       NYUMBANI KITCHEN: venues|menu|tables|order|ingredients|stats.
  maza <sub>          MAZA marketplace: storefronts|listings|reviews|purchase|cart|add|checkout|orders|order|cancel|refund|payouts|categories|stats.
  soc <sub>           Security Operations: report|kpis|lake|telemetry|incidents|incident|escalate|hunt|hunts|playbooks|intel|match|insider|abuse|campaign|validation|tabletop.
  defense <sub>       Active Defense: posture|findings|risk|signal|bans|ban|lift|contain|actions|approve|deny|honeytokens|honeytoken|decoys|decoy|touches|incidents|incident|review|recover|report|integrity|rotate.
  cloud <sub>         PRX Part E cloud: regions|region|flavors|images|instances|instance|volumes|vpcs|firewall|lbs|hosting|autoscale|stats.
  cdn <sub>           PRX CDN: nodes|zones|zone|cache|lookup|purge|stats.
  mail <sub>          PRX email: domains|domain|verify|dns|mailboxes|send|inbox|stats.
  ipam <sub>          PRX RIR member: blocks|block|split|addresses|address|asns|asn|announce|announcements|stats.
  mobile <sub>        TANYA Mobile Native: devices|register|snapshot|notify.
  realtime <sub>      Realtime: stats.
  tanya <sub>         TANYA AI: chat|conversations|conversation|personas|persona|identify|stats|share|unshare|shared|shares|export|sharelink|summary|pin|unpin|archive|restore|folders|folder.
  org <sub>           Organizations: create|invite|accept|list|members.
  tools <sub>         Tool governance: sync|list|stats|alerts|invoke|approvals|approve.
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
  const cloud = kernel.getModule<CloudModule>('cloud');
  const defense = kernel.getModule<ActiveDefenseModule>('active-defense');
  const soc = kernel.getModule<SocModule>('soc');
  const cdn = kernel.getModule<CdnModule>('cdn');
  const email = kernel.getModule<EmailModule>('email');
  const ipam = kernel.getModule<IpamModule>('ipam');
  const tanya = kernel.getModule<TanyaModule>('tanya');
  const orgs = kernel.getModule<OrganizationsModule>('organizations');
  const mobile = kernel.getModule('mobile') as unknown as {
    registerDevice: (userId: string, input: { platform: 'ios' | 'android'; pushToken?: string; name?: string; locale?: string }) => Promise<{ id: string; platform: string; pushToken?: string; name?: string; locale?: string }>;
    listDevices: (userId: string) => Promise<Array<{ id: string; platform: string; pushToken?: string; name?: string; locale?: string; lastSeenAt: number }>>;
    snapshot: (userId: string) => Promise<{ serverTime: number; devices: unknown[]; personas: unknown[]; myOrgs: unknown[]; recentConversations: unknown[]; sharedWithMeCount: number; pendingApprovalCount: number }>;
    notifyUser: (userId: string, input: { title: string; body: string; event?: string }) => Promise<{ delivered: number }>;
  } | undefined;
  const realtime = kernel.getModule('realtime') as unknown as { stats: () => { clients: number; totalConnections: number; uptimeMs: number; path: string; pingIntervalMs: number } } | undefined;
  const toolIntel = kernel.getModule<ToolIntelligenceModule>('tool-intelligence');
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
          case 'acme': {
            const sub2 = args[2];
            switch (sub2) {
              case 'directory':
                console.log(JSON.stringify(pki.acmeDirectory(), null, 2));
                break;
              case 'nonce':
                console.log(pki.acmeNewNonce());
                break;
              case 'new-account': {
                // Generate an account key, sign a newAccount JWS, and print
                // the kid + account JWK for the operator to keep.
                const { generateKeyPair } = await import('@jataqi/pki');
                const { sign } = await import('node:crypto');
                const key = generateKeyPair('ec-p256');
                const b64 = (b: Buffer): string => b.toString('base64url');
                const header = b64(Buffer.from(JSON.stringify({ alg: 'ES256', jwk: key.jwk, nonce: pki.acmeNewNonce(), url: '/new-account' }), 'utf8'));
                const payload = b64(Buffer.from(JSON.stringify({ termsOfServiceAgreed: true }), 'utf8'));
                const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
                const result = pki.acmeNewAccount(`${header}.${payload}.${sig}`);
                console.log(JSON.stringify({ kid: result.kid, accountJwk: key.jwk, existing: result.existing, note: 'Keep this JWK — it is your ACME account key for JWS-signed requests.' }, null, 2));
                break;
              }
              case 'new-order': {
                const kid = args[3], domains = args[4];
                if (!kid || !domains) { console.error('Usage: jataqi pki acme new-order <kid> <domain1,domain2>'); process.exit(1); }
                const order = pki.acmeNewOrder(kid, domains.split(',').map((d) => d.trim()).filter(Boolean).map((d) => ({ type: 'dns' as const, value: d })));
                const out: Record<string, unknown> = {
                  order: { id: order.id, status: order.status, identifiers: order.identifiers, finalizeUrl: order.finalizeUrl },
                };
                const authzs = order.authorizationIds.map((id) => pki.acmeGetAuthorization(id)!).map((a) => {
                  const first = a.challenges[0]!;
                  let keyAuth: string | undefined;
                  try { keyAuth = pki.acmeChallengeKeyAuthorization(first.id).keyAuthorization; } catch { /* no account */ }
                  return {
                    id: a.id, identifier: a.identifier.value, status: a.status,
                    challenge: { id: first.id, type: first.type, token: first.token, keyAuthorization: keyAuth },
                    proofLocation: `http://${a.identifier.value.replace(/^\*\./, '')}/.well-known/acme-challenge/${first.token}`,
                  };
                });
                out.authorizations = authzs;
                console.log(JSON.stringify(out, null, 2));
                break;
              }
              case 'challenge': {
                const id = args[3];
                if (!id) { console.error('Usage: jataqi pki acme challenge <challengeId>'); process.exit(1); }
                try {
                  console.log(JSON.stringify(pki.acmeChallengeKeyAuthorization(id), null, 2));
                } catch (err) {
                  console.log((err as Error).message);
                }
                break;
              }
              case 'validate': {
                const kid = args[3], challengeId = args[4];
                if (!kid || !challengeId) { console.error('Usage: jataqi pki acme validate <kid> <challengeId>'); process.exit(1); }
                try {
                  console.log(JSON.stringify(pki.acmeRequestValidation(kid, challengeId), null, 2));
                } catch (err) {
                  console.log((err as Error).message);
                }
                break;
              }
              case 'proof': {
                const kid = args[3], challengeId = args[4], location = args[5], value = args[6];
                if (!kid || !challengeId || !location || !value) { console.error('Usage: jataqi pki acme proof <kid> <challengeId> <location> <keyAuthorization>'); process.exit(1); }
                try {
                  console.log(JSON.stringify(pki.acmeSubmitProof(kid, challengeId, { location, value }), null, 2));
                } catch (err) {
                  console.log((err as Error).message);
                }
                break;
              }
              case 'finalize': {
                const kid = args[3], orderId = args[4], csrFile = args[5];
                if (!kid || !orderId || !csrFile) { console.error('Usage: jataqi pki acme finalize <kid> <orderId> <csrFile.der>'); process.exit(1); }
                const fs = await import('node:fs/promises');
                const csr = await fs.readFile(csrFile);
                const result = pki.acmeFinalize(kid, orderId, csr);
                if (result.certificate) {
                  const cert = result.certificate;
                  console.log(JSON.stringify({ orderId: result.order.id, status: result.order.status, certificateId: cert.id, sanDnsNames: cert.sanDnsNames, certDer: cert.certDer }, null, 2));
                } else {
                  console.log(`finalize failed: ${result.order.error?.detail ?? 'unknown'}`);
                }
                break;
              }
              case 'cert': {
                const orderId = args[3];
                if (!orderId) { console.error('Usage: jataqi pki acme cert <orderId> [--out cert.der]'); process.exit(1); }
                const cert = pki.acmeCertificate(orderId);
                if (!cert) { console.log('no certificate for this order'); break; }
                if (flag('out')) {
                  const fs = await import('node:fs/promises');
                  await fs.writeFile(flag('out')!, Buffer.from(cert.certDer, 'base64'));
                  console.log(`wrote ${flag('out')}`);
                } else {
                  console.log(JSON.stringify({ certificateId: cert.id, sanDnsNames: cert.sanDnsNames, certDer: cert.certDer }, null, 2));
                }
                break;
              }
              case 'revoke': {
                const kid = args[3], certId = args[4];
                if (!kid || !certId) { console.error('Usage: jataqi pki acme revoke <kid> <certId> [--reason keyCompromise]'); process.exit(1); }
                try {
                  console.log(pki.acmeRevoke(kid, certId, flag('reason')) ? 'revoked' : 'not revoked');
                } catch (err) {
                  console.log((err as Error).message);
                }
                break;
              }
              default:
                console.error('Usage: jataqi pki acme directory|nonce|new-account|new-order|challenge|validate|proof|finalize|cert|revoke'); process.exit(1);
            }
            break;
          }
          default:
            console.error('Usage: jataqi pki status|root|cas|issue|list|revoke|crl|ra|client|discovery|acme'); process.exit(1);
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
      case 'soc': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'report': {
            const r = soc.report();
            console.log(`SOC report @ ${new Date(r.generatedAt).toISOString()}`);
            console.log(`  incidents: ${r.kpis.openIncidents} open / ${r.kpis.incidents} total (sev1: ${r.kpis.sev1Incidents})`);
            console.log(`  MTTA ${r.kpis.avgTimeToTriageMin}m · MTTC ${r.kpis.avgTimeToContainMin}m · MTTR ${r.kpis.avgTimeToResolveMin}m`);
            console.log(`  lake: ${r.kpis.lakeEntries} entries (chain ${r.lakeIntegrity.chainValid ? 'valid' : 'BROKEN'})`);
            console.log(`  intel: ${r.kpis.intelIndicators} indicators / ${r.kpis.intelMatches} matches · hunts: ${r.kpis.huntsRun}`);
            console.log(`  insider alerts: ${r.kpis.insiderAlerts} · abuse alerts: ${r.kpis.abuseAlerts}`);
            console.log(`  validation: ${Math.round(r.kpis.validationScore * 100)}% coverage across ${r.kpis.campaignsRun} campaign(s)`);
            break;
          }
          case 'kpis':
            console.log(JSON.stringify(soc.kpis(), null, 2));
            break;
          case 'lake': {
            const entries = soc.query({ ...(flag('type') ? { type: flag('type') } : {}), ...(flag('actor') ? { actor: flag('actor') } : {}), ...(flag('limit') ? { limit: Number(flag('limit')) } : {}) });
            for (const e of entries.slice(-10)) console.log(`- ${new Date(e.ts).toISOString()} [${e.source}] ${e.type}${e.actor ? ` actor=${e.actor}` : ''}${e.origin ? ` from=${e.origin}` : ''}`);
            console.log(`${entries.length} event(s) in window · lake total ${soc.lake.count()} · chain ${soc.verifyLake().valid ? 'valid' : 'BROKEN'}`);
            break;
          }
          case 'telemetry': {
            const type = args[2], source = args[3];
            if (!type || !source) { console.error('Usage: jataqi soc telemetry <type> <source> [--actor x] [--origin ip]'); process.exit(1); }
            const e = soc.ingest({ type, source: source as never, ...(flag('actor') ? { actor: flag('actor') } : {}), ...(flag('origin') ? { origin: flag('origin') } : {}) });
            console.log(`ingested ${e.id} (${e.type}) — chain entry ${e.hash.slice(0, 12)}`);
            break;
          }
          case 'incidents': {
            const incidents = soc.listIncidents({ ...(flag('severity') ? { severity: flag('severity') } : {}), ...(flag('status') ? { status: flag('status') } : {}) });
            for (const i of incidents) console.log(`- [${i.severity}] ${i.title} (${i.status})${i.commander ? ` IC=${i.commander}` : ''} escalated=${i.escalations}`);
            console.log(`${incidents.length} incident(s)`);
            break;
          }
          case 'incident': {
            const title = args[2], severity = args[3];
            if (!title || !severity) { console.error('Usage: jataqi soc incident <title> <sev1|sev2|sev3|sev4|low|medium|high|critical> [--commander x]'); process.exit(1); }
            const i = soc.openIncident({ title, severity, ...(flag('commander') ? { commander: flag('commander') } : {}) });
            console.log(`incident ${i.id} [${i.severity}] ${i.status} — escalation SLA ${severityToSlaMin(i.severity)}m`);
            break;
          }
          case 'escalate': {
            const results = soc.sweepEscalations();
            for (const r of results) if (r.escalated) console.log(`escalated ${r.id}: ${r.reason}`);
            console.log(`${results.filter((r) => r.escalated).length} escalated`);
            break;
          }
          case 'hunt': {
            const playbook = args[2];
            if (!playbook) { console.error('Usage: jataqi soc hunt <playbookId>'); process.exit(1); }
            const s = soc.hunt(playbook);
            for (const h of s.hits.slice(0, 10)) console.log(`- hit ${h.eventId.slice(0, 8)} ${h.actor ?? ''} ${h.origin ?? ''} ${h.detail ?? ''}`);
            console.log(s.summary);
            break;
          }
          case 'hunts':
            for (const s of soc.huntSessions()) console.log(`- ${s.playbookName}: ${s.hits.length} hit(s) @${new Date(s.startedAt).toISOString()}`);
            break;
          case 'playbooks':
            for (const p of soc.huntPlaybooks()) console.log(`- ${p.id} (${p.severity}): ${p.description}`);
            break;
          case 'intel': {
            const type = args[2], value = args[3], confidence = args[4], severity = args[5], source = args[6];
            if (!type || !value || !confidence || !severity || !source) { console.error('Usage: jataqi soc intel <type> <value> <confidence 0-1> <severity> <source> [--tlp x]'); process.exit(1); }
            const i = soc.ingestIntel({ type: type as never, value, confidence: Number(confidence), severity: severity as never, source, ...(flag('tlp') ? { tlp: flag('tlp') as never } : {}) });
            console.log(`indicator ${i.id} (${i.tlp}) ${i.value} conf=${i.confidence}`);
            break;
          }
          case 'match': {
            const value = args[2];
            if (!value) { console.error('Usage: jataqi soc match <value>'); process.exit(1); }
            const matches = soc.matchIntel([{ value }]);
            for (const m of matches) console.log(`- MATCH ${m.indicator.value} (${m.indicator.severity}, conf ${m.indicator.confidence}, ${m.indicator.source})`);
            console.log(`${matches.length} match(es)`);
            break;
          }
          case 'insider': {
            const actor = args[2], action = args[3], sensitivity = args[4];
            if (!actor || !action || !sensitivity) { console.error('Usage: jataqi soc insider <actor> <action> <standard|privileged|critical>'); process.exit(1); }
            const alert = soc.observeInsider({ actor, action, sensitivity: sensitivity as never });
            console.log(alert ? `ALERT [${alert.severity}] ${alert.message}` : 'no alert (within baseline)');
            break;
          }
          case 'abuse': {
            const kind = args[2];
            if (!kind) { console.error('Usage: jataqi soc abuse <registration|login|api_call|content|invite> [--actor x] [--origin ip] [--value v]'); process.exit(1); }
            const alert = soc.observeAbuse({ kind: kind as never, ...(flag('actor') ? { actor: flag('actor') } : {}), ...(flag('origin') ? { origin: flag('origin') } : {}), ...(flag('value') ? { value: flag('value') } : {}) });
            console.log(alert ? `ALERT [${alert.severity}] ${alert.message}` : 'no abuse detected');
            break;
          }
          case 'campaign': {
            const kind = args[2];
            if (!kind) { console.error('Usage: jataqi soc campaign <credential_stuffing|phishing_lure|privilege_escalation|data_exfiltration|lateral_movement|supply_chain_tamper>'); process.exit(1); }
            const c = soc.runCampaign(kind as never);
            for (const r of c.results) console.log(`- ${r.step}: ${r.detected ? 'DETECTED' : 'MISSED'} (${r.control})`);
            console.log(`campaign "${c.name}" score ${Math.round(c.score * 100)}%`);
            break;
          }
          case 'validation':
            console.log(`detection coverage: ${Math.round(soc.validationScore() * 100)}% across ${soc.campaigns().length} campaign(s)`);
            break;
          case 'tabletop': {
            const title = args.slice(2).join(' ');
            if (!title) { console.error('Usage: jataqi soc tabletop <title> [--injects a,b]'); process.exit(1); }
            const s = soc.addTabletop({ title, description: 'tabletop exercise', injects: (flag('injects') ?? 'detect,contain,recover').split(',') });
            console.log(`scenario ${s.id} ready (${s.injects.length} injects)`);
            break;
          }
          default:
            console.error('Usage: jataqi soc report|kpis|lake|telemetry|incidents|incident|escalate|hunt|hunts|playbooks|intel|match|insider|abuse|campaign|validation|tabletop'); process.exit(1);
        }
        break;
      }
      case 'defense': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'posture': {
            const s = defense.stats();
            console.log(`risk assessments: ${s.riskAssessments} (critical: ${s.criticalSessions})`);
            console.log(`findings: ${s.openFindings} open / ${s.criticalFindings} critical`);
            console.log(`containment: ${s.containmentActions} actions / ${s.pendingApprovals} pending approval`);
            console.log(`bans: ${s.activeBans} · honeytokens: ${s.honeytokens} · decoys: ${s.decoys} · touches: ${s.touches}`);
            console.log(`incidents: ${s.incidents} · recoveries: ${s.recoveryRuns} · playbook v${s.playbookVersion}`);
            break;
          }
          case 'findings': {
            const findings = defense.findings({ ...(flag('severity') ? { severity: flag('severity') as never } : {}), ...(flag('status') ? { status: flag('status') as never } : {}) });
            for (const f of findings) console.log(`- [${f.severity}] ${f.title} (rule=${f.rule}) ${f.actor ? `actor=${f.actor} ` : ''}${f.status} @${new Date(f.createdAt).toISOString()}`);
            console.log(`${findings.length} finding(s)`);
            break;
          }
          case 'risk': {
            const userId = args[2];
            if (!userId) { console.error('Usage: jataqi defense risk <userId>'); process.exit(1); }
            const r = defense.risk(userId);
            console.log(r ? `${userId}: ${r.score}/100 (${r.level}) — ${r.signals.length} signal(s)` : `${userId}: no assessment (low)`);
            break;
          }
          case 'signal': {
            const userId = args[2], type = args[3];
            if (!userId || !type) { console.error('Usage: jataqi defense signal <userId> <signalType> [--weight n]'); process.exit(1); }
            defense.ingestRisk(userId, { type, ...(flag('weight') ? { weight: Number(flag('weight')) } : {}) });
            const r = defense.risk(userId)!;
            console.log(`${userId}: now ${r.score}/100 (${r.level})`);
            break;
          }
          case 'bans': {
            for (const b of defense.listBans()) console.log(`- [${b.scope}] ${b.value} — ${b.reason}${b.permanent ? ' (permanent)' : ` (until ${new Date(b.expiresAt!).toISOString()})`}`);
            console.log(`${defense.listBans().length} ban(s)`);
            break;
          }
          case 'ban': {
            const scope = args[2], value = args[3], reason = args.slice(4).join(' ') || 'manual ban';
            if (!scope || !value) { console.error('Usage: jataqi defense ban <user|ip|token> <value> <reason> [--hours n]'); process.exit(1); }
            const b = defense.ban({ scope: scope as never, value, reason, ...(flag('hours') ? { durationMs: Number(flag('hours')) * 3600_000 } : {}) });
            console.log(`banned [${b.scope}] ${b.value} (${b.permanent ? 'permanent' : `expires ${new Date(b.expiresAt!).toISOString()}`})`);
            break;
          }
          case 'lift': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi defense lift <banId>'); process.exit(1); }
            console.log(defense.liftBan(id) ? `lifted ${id}` : 'ban not found');
            break;
          }
          case 'contain': {
            const kind = args[2], target = args[3], reason = args.slice(4).join(' ') || 'automated containment';
            if (!kind || !target) { console.error('Usage: jataqi defense contain <kind> <target> <reason>'); process.exit(1); }
            const a = defense.contain({ kind: kind as never, target, reason });
            console.log(`action ${a.id}: ${a.kind} on ${a.target} [${a.status}]${a.requiresApproval ? ' — awaiting human approval' : ''}`);
            break;
          }
          case 'actions': {
            const actions = defense.listActions({ ...(flag('status') ? { status: flag('status') as never } : {}) });
            for (const a of actions) console.log(`- ${a.id.slice(0, 8)} ${a.kind} on ${a.target} [${a.status}]${a.requiresApproval ? ' (approval)' : ''}${a.approvedBy ? ` by ${a.approvedBy}` : ''}`);
            console.log(`${actions.length} action(s)`);
            break;
          }
          case 'approve': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi defense approve <actionId>'); process.exit(1); }
            const a = defense.approveAction(id, 'cli-operator');
            console.log(a ? `approved: ${a.kind} on ${a.target} [${a.status}]` : 'action not found or not pending');
            break;
          }
          case 'deny': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi defense deny <actionId>'); process.exit(1); }
            const a = defense.denyAction(id, 'cli-operator');
            console.log(a ? `denied: ${a.kind} on ${a.target} [${a.status}]` : 'action not found or not pending');
            break;
          }
          case 'honeytoken': {
            const label = args[2], value = args[3], placement = args[4];
            if (!label || !value || !placement) { console.error('Usage: jataqi defense honeytoken <label> <value> <placement>'); process.exit(1); }
            const t = defense.createHoneytoken({ label, value, placement });
            console.log(`honeytoken ${t.id} placed at "${t.placement}" (${t.oneTime ? 'one-time' : 'multi-use'})`);
            break;
          }
          case 'honeytokens':
            for (const t of defense.listHoneytokens()) console.log(`- ${t.label} @ ${t.placement} [${t.touched ? 'touched' : 'armed'}]`);
            break;
          case 'decoy': {
            const name = args[2], kind = args[3];
            if (!name || !kind) { console.error('Usage: jataqi defense decoy <name> <api|service|database|credential>'); process.exit(1); }
            const d = defense.registerDecoy({ name, kind: kind as never });
            console.log(`decoy ${d.name} (${d.kind}) armed`);
            break;
          }
          case 'decoys':
            for (const d of defense.listDecoys()) console.log(`- ${d.name} (${d.kind})${d.endpoint ? ` @ ${d.endpoint}` : ''}`);
            break;
          case 'touches':
            for (const t of defense.touches()) console.log(`- ${t.kind} ${t.target}${t.source ? ` source=${t.source}` : ''} @${new Date(t.ts).toISOString()}`);
            break;
          case 'incidents':
            for (const i of defense.listIncidents()) console.log(`- [${i.severity}] ${i.title} (${i.status}) ${i.lessonsLearned?.length ? `lessons=${i.lessonsLearned.length}` : `playbook v${i.playbookVersion ?? '—'}`}`);
            break;
          case 'incident': {
            const title = args[2], severity = args[3];
            if (!title || !severity) { console.error('Usage: jataqi defense incident <title> <low|medium|high|critical>'); process.exit(1); }
            const i = defense.recordIncident({ title, severity: severity as never });
            console.log(`incident ${i.id} recorded`);
            break;
          }
          case 'review': {
            const id = args[2], rca = args.slice(3).join(' ');
            if (!id || !rca) { console.error('Usage: jataqi defense review <incidentId> <root cause analysis...>'); process.exit(1); }
            const i = defense.reviewIncident(id, { rca, lessonsLearned: ['validated fix', 'updated detection'] });
            console.log(i ? `incident ${i.id} reviewed → playbook v${i.playbookVersion}` : 'incident not found');
            break;
          }
          case 'recover': {
            const target = args[2];
            if (!target) { console.error('Usage: jataqi defense recover <target> [--snapshot id]'); process.exit(1); }
            const r = defense.recover({ target, ...(flag('snapshot') ? { fromSnapshot: flag('snapshot') } : {}) });
            console.log(`recovery ${r.id}: ${r.target} → ${r.stage}${r.completedAt ? ' (completed)' : ''}`);
            break;
          }
          case 'rotate': {
            const scope = args[2];
            if (!scope) { console.error('Usage: jataqi defense rotate <scope> [--min-interval-hours n]'); process.exit(1); }
            const r = defense.rotateCryptoMaterial(scope, flag('min-interval-hours') ? Number(flag('min-interval-hours')) * 3600_000 : undefined);
            console.log(r.rotated ? `rotated ${scope}` : `skipped: ${r.reason}`);
            break;
          }
          case 'report': {
            const r = defense.report();
            console.log(`Security report @ ${new Date(r.generatedAt).toISOString()}`);
            console.log(`  risk: ${JSON.stringify(r.riskDistribution)}`);
            console.log(`  findings: ${JSON.stringify(r.findingsBySeverity)}`);
            console.log(`  bans: ${r.activeBans.length} · pending approvals: ${r.pendingApprovals.length} · incidents: ${r.incidents.length}`);
            for (const f of r.recentFindings.slice(0, 5)) console.log(`  ! [${f.severity}] ${f.title}`);
            break;
          }
          default:
            console.error('Usage: jataqi defense posture|findings|risk|signal|bans|ban|lift|contain|actions|approve|deny|honeytoken|honeytokens|decoy|decoys|touches|incidents|incident|review|recover|rotate|report'); process.exit(1);
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
          case 'cart': {
            const buyer = args[2];
            if (!buyer) { console.error('Usage: jataqi maza cart <buyerId>'); process.exit(1); }
            const cart = marketplace.getCartForBuyer(buyer) ?? marketplace.createCart(buyer);
            for (const i of cart.items) console.log(`- ${i.title} ×${i.quantity} = ${i.priceMinor * i.quantity} ${i.currency}`);
            console.log(`total ${cart.totalMinor} ${cart.currency} (cart ${cart.id})`);
            break;
          }
          case 'add': {
            const cartId = args[2], listingId = args[3], qty = args[4];
            if (!cartId || !listingId) { console.error('Usage: jataqi maza add <cartId> <listingId> [qty]'); process.exit(1); }
            try {
              const cart = await marketplace.addToCart(cartId, listingId, qty ? Number(qty) : 1);
              console.log(`cart ${cart.id}: ${cart.items.length} item(s), total ${cart.totalMinor} ${cart.currency}`);
            } catch (err) { console.log((err as Error).message); }
            break;
          }
          case 'checkout': {
            const cartId = args[2];
            if (!cartId) { console.error('Usage: jataqi maza checkout <cartId>'); process.exit(1); }
            try {
              const order = await marketplace.checkout(cartId);
              console.log(`order ${order.id} paid — ${order.totalMinor} ${order.currency} (${order.items.length} item(s))`);
            } catch (err) { console.log((err as Error).message); }
            break;
          }
          case 'orders': {
            const orders = marketplace.listOrders({ ...(flag('buyer') ? { buyerId: flag('buyer') } : {}), ...(flag('vendor') ? { vendorId: flag('vendor') } : {}), ...(flag('status') ? { status: flag('status') as never } : {}) });
            for (const o of orders) console.log(`- ${o.id} ${o.status} ${o.totalMinor} ${o.currency} buyer=${o.buyerId} (${o.items.length} item(s))`);
            console.log(`${orders.length} order(s)`);
            break;
          }
          case 'order': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi maza order <orderId>'); process.exit(1); }
            const o = marketplace.getOrder(id);
            if (!o) { console.log('order not found'); break; }
            for (const i of o.items) console.log(`- ${i.title} ×${i.quantity} ${i.lineTotalMinor} ${i.currency}`);
            console.log(`status=${o.status} total=${o.totalMinor} ${o.currency} commission=${o.commissionMinor}`);
            break;
          }
          case 'cancel': {
            const orderId = args[2], buyer = args[3];
            if (!orderId || !buyer) { console.error('Usage: jataqi maza cancel <orderId> <buyerId>'); process.exit(1); }
            try {
              const o = await marketplace.cancelOrder(orderId, buyer);
              console.log(`order ${o.id} ${o.status}`);
            } catch (err) { console.log((err as Error).message); }
            break;
          }
          case 'refund': {
            const orderId = args[2];
            if (!orderId) { console.error('Usage: jataqi maza refund <orderId>'); process.exit(1); }
            try {
              const o = await marketplace.refundOrder(orderId);
              console.log(`order ${o.id} ${o.status} (stock restored)`);
            } catch (err) { console.log((err as Error).message); }
            break;
          }
          case 'payouts': {
            const payouts = marketplace.listPayouts(flag('vendor'), flag('status') as never);
            for (const p of payouts) console.log(`- ${p.id} ${p.status} net=${p.netMinor} ${p.currency} (order ${p.orderId.slice(0, 8)})`);
            console.log(`${payouts.length} payout(s)`);
            break;
          }
          case 'categories':
            console.log(marketplace.categories().join(', '));
            break;
          case 'stats':
            console.log(JSON.stringify({ ...marketplace.stats(), analytics: marketplace.orderAnalytics() }, null, 2));
            break;
          default:
            console.error('Usage: jataqi maza storefronts|storefront|listings|listing|review|purchase|cart|add|checkout|orders|order|cancel|refund|payouts|categories|stats'); process.exit(1);
        }
        break;
      }
      case 'cloud': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'regions':
            for (const r of cloud.listRegions()) console.log(`- ${r.code} ${r.name} (${r.country}) ${r.usedSlots}/${r.capacitySlots} [${r.status}]`);
            console.log(`${cloud.listRegions().length} region(s)`);
            break;
          case 'region': {
            const name = args[2], code = args[3], country = args[4], zones = args[5];
            if (!name || !code || !country || !zones) { console.error('Usage: jataqi cloud region <name> <code> <country> <zone1,zone2> [--capacity n]'); process.exit(1); }
            const r = cloud.registerRegion({ name, code, country, zones: zones.split(',').map((z) => z.trim()), ...(flag('capacity') ? { capacitySlots: Number(flag('capacity')) } : {}) });
            console.log(`registered ${r.id}`);
            break;
          }
          case 'flavors':
            for (const f of cloud.listFlavors()) console.log(`- ${f.name} [${f.tier}] ${f.vcpu}vCPU/${f.ramGb}GB ${f.gpu ? `${f.gpu}GPU ` : ''}${f.pricePerHourMinor}/hr`);
            console.log(`${cloud.listFlavors().length} flavor(s)`);
            break;
          case 'flavor': {
            const name = args[2], tier = args[3], vcpu = args[4], ram = args[5], disk = args[6], price = args[7];
            if (!name || !tier || !vcpu || !ram || !disk || !price) { console.error('Usage: jataqi cloud flavor <name> <tier> <vcpu> <ramGb> <diskGb> <pricePerHourMinor> [--gpu n]'); process.exit(1); }
            const f = cloud.registerFlavor({ name, tier: tier as never, vcpu: Number(vcpu), ramGb: Number(ram), diskGb: Number(disk), pricePerHourMinor: Number(price), ...(flag('gpu') ? { gpu: Number(flag('gpu')) } : {}) });
            console.log(`registered ${f.id}`);
            break;
          }
          case 'images':
            for (const i of cloud.listImages()) console.log(`- ${i.name} (${i.os} ${i.version}, ${i.arch})`);
            console.log(`${cloud.listImages().length} image(s)`);
            break;
          case 'image': {
            const name = args[2], os = args[3], version = args[4];
            if (!name || !os || !version) { console.error('Usage: jataqi cloud image <name> <os> <version>'); process.exit(1); }
            const i = cloud.registerImage({ name, os, version });
            console.log(`registered ${i.id}`);
            break;
          }
          case 'instances': {
            const instances = cloud.listInstances({ ...(flag('region') ? { regionId: flag('region') } : {}), ...(flag('status') ? { status: flag('status') as never } : {}) });
            for (const i of instances) console.log(`- ${i.name} [${i.status}] ${i.publicIp ?? '-'} flavor=${i.flavorId}${i.hostingPlanId ? ' (hosting)' : ''}`);
            console.log(`${instances.length} instance(s)`);
            break;
          }
          case 'instance': {
            const name = args[2], regionId = args[3], flavorId = args[4], imageId = args[5];
            if (!name || !regionId || !flavorId || !imageId) { console.error('Usage: jataqi cloud instance <name> <regionId> <flavorId> <imageId> [--vpc id]'); process.exit(1); }
            try {
              const i = await cloud.provisionInstance({ name, regionId, flavorId, imageId, ...(flag('vpc') ? { vpcId: flag('vpc') } : {}) });
              console.log(`provisioned ${i.id}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'volumes': {
            const volumes = cloud.listVolumes(flag('region'));
            for (const v of volumes) console.log(`- ${v.name} ${v.sizeGb}GB [${v.status}]${v.instanceId ? ` -> ${v.instanceId}` : ''}`);
            console.log(`${volumes.length} volume(s)`);
            break;
          }
          case 'volume': {
            const name = args[2], size = args[3], regionId = args[4];
            if (!name || !size || !regionId) { console.error('Usage: jataqi cloud volume <name> <sizeGb> <regionId>'); process.exit(1); }
            const v = cloud.createVolume({ name, sizeGb: Number(size), regionId });
            console.log(`created ${v.id}`);
            break;
          }
          case 'vpcs':
            for (const v of cloud.listVpcs(flag('region'))) console.log(`- ${v.name} ${v.cidr} ${v.subnetCidrs.join(', ')}`);
            console.log(`${cloud.listVpcs().length} vpc(s)`);
            break;
          case 'vpc': {
            const name = args[2], regionId = args[3], cidr = args[4], subnets = args[5];
            if (!name || !regionId || !cidr || !subnets) { console.error('Usage: jataqi cloud vpc <name> <regionId> <cidr> <subnet1,subnet2>'); process.exit(1); }
            const v = cloud.createVpc({ name, regionId, cidr, subnetCidrs: subnets.split(',').map((s) => s.trim()) });
            console.log(`created ${v.id}`);
            break;
          }
          case 'firewall': {
            const vpcId = args[2];
            if (!vpcId) { console.error('Usage: jataqi cloud firewall <vpcId>'); process.exit(1); }
            for (const r of cloud.listFirewallRules(vpcId)) console.log(`- ${r.name} ${r.direction} ${r.protocol}${r.portRange ? ':' + r.portRange : ''} from ${r.sourceCidr ?? '*'}: ${r.action}`);
            console.log(`${cloud.listFirewallRules(vpcId).length} rule(s)`);
            break;
          }
          case 'lbs':
            for (const lb of cloud.listLoadBalancers(flag('region'))) console.log(`- ${lb.name} ${lb.protocol}:${lb.port} targets=${lb.targetInstanceIds.length} [${lb.status}]`);
            console.log(`${cloud.listLoadBalancers().length} load balancer(s)`);
            break;
          case 'hosting': {
            const planId = args[2], regionId = args[3], site = args[4], imageId = args[5];
            if (!planId || !regionId || !site || !imageId) { console.error('Usage: jataqi cloud hosting <planId> <regionId> <siteName> <imageId>'); process.exit(1); }
            try {
              const i = await cloud.provisionHosting({ planId, regionId, siteName: site, imageId });
              console.log(`provisioned hosting ${i.id}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'plans':
            for (const p of cloud.listHostingPlans()) console.log(`- ${p.name} [${p.tier}] ${p.monthlyPriceMinor}/mo ssl=${p.sslAutomation} cdn=${p.cdnIncluded} backup=${p.backupIncluded}`);
            console.log(`${cloud.listHostingPlans().length} plan(s)`);
            break;
          case 'autoscale': {
            const groupId = args[2], load = args[3];
            if (!groupId || !load) { console.error('Usage: jataqi cloud autoscale <groupId> <load 0..1> [--memory x] [--rpm n]'); process.exit(1); }
            const signals: Record<string, number> = { cpu: Number(load) };
            if (flag('memory')) signals.memory = Number(flag('memory'));
            if (flag('rpm')) signals.requestsPerMinute = Number(flag('rpm'));
            console.log(JSON.stringify(cloud.evaluateAutoscaling(groupId, signals)));
            break;
          }
          case 'autoscale-groups': {
            for (const g of cloud.listAutoscalingGroups()) console.log(`- ${g.name} (${g.id}) min=${g.min} max=${g.max} cpu${g.cpuHighThreshold}/${g.cpuLowThreshold} load=${g.currentLoad}${g.cooldownMs ? ` cooldown=${g.cooldownMs}ms` : ''}`);
            console.log(`${cloud.listAutoscalingGroups().length} group(s)`);
            break;
          }
          case 'autoscale-update': {
            const groupId = args[2];
            if (!groupId) { console.error('Usage: jataqi cloud autoscale-update <groupId> [--min n] [--max n] [--cpu-high x] [--cpu-low x] [--cooldown ms]'); process.exit(1); }
            try {
              const g = cloud.updateAutoscalingGroup(groupId, {
                ...(flag('min') ? { min: Number(flag('min')) } : {}),
                ...(flag('max') ? { max: Number(flag('max')) } : {}),
                ...(flag('cpu-high') ? { cpuHighThreshold: Number(flag('cpu-high')) } : {}),
                ...(flag('cpu-low') ? { cpuLowThreshold: Number(flag('cpu-low')) } : {}),
                ...(flag('cooldown') ? { cooldownMs: Number(flag('cooldown')) } : {}),
              });
              console.log(`updated ${g.name}: min=${g.min} max=${g.max}`);
            } catch (err) { console.log((err as Error).message); }
            break;
          }
          case 'autoscale-history': {
            const entries = cloud.autoscalingHistory(flag('group'));
            for (const e of entries) console.log(`- ${new Date(e.ts).toISOString()} ${e.action} count=${e.count} cpu=${e.signals.cpu} reason=${e.reason}`);
            console.log(`${entries.length} decision(s)`);
            break;
          }
          case 'stats':
            console.log(JSON.stringify(cloud.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi cloud regions|region|flavors|flavor|images|image|instances|instance|volumes|volume|vpcs|vpc|firewall|lbs|hosting|plans|autoscale|autoscale-groups|autoscale-update|autoscale-history|stats'); process.exit(1);
        }
        break;
      }
      case 'cdn': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'nodes':
            for (const n of cdn.listEdgeNodes()) console.log(`- ${n.name} (${n.region}/${n.country}) ${n.capacityRps}rps [${n.status}]`);
            console.log(`${cdn.listEdgeNodes().length} node(s)`);
            break;
          case 'node': {
            const name = args[2], region = args[3], country = args[4];
            if (!name || !region || !country) { console.error('Usage: jataqi cdn node <name> <region> <country> [--rps n]'); process.exit(1); }
            const n = cdn.registerEdgeNode({ name, region, country, ...(flag('rps') ? { capacityRps: Number(flag('rps')) } : {}) });
            console.log(`registered ${n.id}`);
            break;
          }
          case 'zones':
            for (const z of cdn.listZones()) console.log(`- ${z.domain} -> ${z.origin} ttl=${z.defaultTtlSec}s shield=${z.originShield} tls=${z.tlsEnabled} [${z.status}]`);
            console.log(`${cdn.listZones().length} zone(s)`);
            break;
          case 'zone': {
            const domain = args[2], origin = args[3];
            if (!domain || !origin) { console.error('Usage: jataqi cdn zone <domain> <origin> [--ttl n] [--no-shield]'); process.exit(1); }
            const z = cdn.createZone({ domain, origin, ...(flag('ttl') ? { defaultTtlSec: Number(flag('ttl')) } : {}), ...(args.includes('--no-shield') ? { originShield: false } : {}) });
            console.log(`created ${z.id}`);
            break;
          }
          case 'cache': {
            const zoneId = args[2], path = args[3], size = args[4], contentType = args[5] ?? 'application/octet-stream';
            if (!zoneId || !path || !size) { console.error('Usage: jataqi cdn cache <zoneId> <path> <sizeBytes> [contentType]'); process.exit(1); }
            const a = await cdn.storeAsset({ zoneId, path, contentType, sizeBytes: Number(size) });
            console.log(`cached ${a.id}`);
            break;
          }
          case 'lookup': {
            const zoneId = args[2], path = args[3];
            if (!zoneId || !path) { console.error('Usage: jataqi cdn lookup <zoneId> <path>'); process.exit(1); }
            console.log(JSON.stringify(cdn.lookup(zoneId, path)));
            break;
          }
          case 'purge': {
            const zoneId = args[2], target = args[3];
            if (!zoneId || !target) { console.error('Usage: jataqi cdn purge <zoneId> <path|prefix|all>'); process.exit(1); }
            const result = await cdn.purge(zoneId, target === 'all' ? { all: true } : target.startsWith('/') ? { path: target } : { prefix: target });
            console.log(`purged ${result.purged}`);
            break;
          }
          case 'stats':
            console.log(JSON.stringify(cdn.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi cdn nodes|node|zones|zone|cache|lookup|purge|stats'); process.exit(1);
        }
        break;
      }
      case 'mail': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'domains':
            for (const d of email.listDomains()) console.log(`- ${d.domain} [${d.verified ? 'verified' : 'unverified'}] dmarc=${d.dmarcPolicy}`);
            console.log(`${email.listDomains().length} domain(s)`);
            break;
          case 'domain': {
            const domain = args[2];
            if (!domain) { console.error('Usage: jataqi mail domain <domain> [--dmarc none|quarantine|reject]'); process.exit(1); }
            const d = email.registerDomain({ domain, ...(flag('dmarc') ? { dmarcPolicy: flag('dmarc') as never } : {}) });
            console.log(`registered ${d.id}`);
            break;
          }
          case 'verify': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi mail verify <domainId>'); process.exit(1); }
            const d = email.verifyDomain(id);
            console.log(d ? `${d.domain} verified` : 'domain not found');
            break;
          }
          case 'dns': {
            const id = args[2];
            if (!id) { console.error('Usage: jataqi mail dns <domainId>'); process.exit(1); }
            for (const r of email.dnsRecords(id)) console.log(`${r.type} ${r.name} = ${r.value}`);
            break;
          }
          case 'mailboxes': {
            const domainId = args[2];
            const mailboxes = domainId ? email.listMailboxes(domainId) : email.listMailboxes();
            for (const m of mailboxes) console.log(`- ${m.address} ${m.usedMb}/${m.quotaMb}MB`);
            console.log(`${mailboxes.length} mailbox(es)`);
            break;
          }
          case 'mailbox': {
            const domainId = args[2], address = args[3];
            if (!domainId || !address) { console.error('Usage: jataqi mail mailbox <domainId> <address>'); process.exit(1); }
            const m = email.createMailbox({ domainId, address });
            console.log(`created ${m.address}`);
            break;
          }
          case 'send': {
            const from = args[2], to = args[3], subject = args[4];
            if (!from || !to || !subject) { console.error('Usage: jataqi mail send <from> <to> <subject> [body]'); process.exit(1); }
            try {
              const m = await email.send({ from, to: [to], subject, body: args[5] ?? '' });
              console.log(`sent ${m.id} dkim=${m.dkimSigned}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'inbox': {
            const mailboxId = args[2];
            const messages = mailboxId ? email.listInbound(mailboxId) : email.listInbound();
            for (const m of messages) console.log(`- [${m.status}] ${m.from}: ${m.subject}${m.dmarcDisposition ? ` (dmarc:${m.dmarcDisposition})` : ''}`);
            console.log(`${messages.length} message(s)`);
            break;
          }
          case 'stats':
            console.log(JSON.stringify(email.stats(), null, 2));
            break;
          default:
            console.error('Usage: jataqi mail domains|domain|verify|dns|mailboxes|mailbox|send|inbox|stats'); process.exit(1);
        }
        break;
      }
      case 'ipam': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'blocks': {
            const blocks = ipam.listBlocks({ ...(flag('rir') ? { rir: flag('rir') as never } : {}), ...(flag('family') ? { family: flag('family') as never } : {}) });
            for (const b of blocks) console.log(`- ${b.cidr} (${b.family}) ${b.rir} [${b.status}]${b.purpose ? ` ${b.purpose}` : ''}`);
            console.log(`${blocks.length} block(s)`);
            break;
          }
          case 'block': {
            const cidr = args[2], rir = args[3];
            if (!cidr || !rir) { console.error('Usage: jataqi ipam block <cidr> <rir> [--purpose anycast]'); process.exit(1); }
            try {
              const b = await ipam.allocateBlock({ cidr, rir: rir as never, ...(flag('purpose') ? { purpose: flag('purpose') } : {}) });
              console.log(`allocated ${b.id} (${b.cidr})`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'split': {
            const blockId = args[2], prefix = args[3];
            if (!blockId || !prefix) { console.error('Usage: jataqi ipam split <blockId> <newPrefix>'); process.exit(1); }
            try {
              const children = ipam.splitBlock(blockId, Number(prefix));
              console.log(`split into ${children.length} block(s): ${children[0]!.cidr} .. ${children[children.length - 1]!.cidr}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'addresses': {
            const blockId = args[2];
            if (!blockId) { console.error('Usage: jataqi ipam addresses <blockId> [--limit n]'); process.exit(1); }
            const addrs = ipam.addressesInBlock(blockId, flag('limit') ? Number(flag('limit')) : 1000);
            console.log(addrs.slice(0, 20).join(', ') + (addrs.length > 20 ? ` … (${addrs.length})` : ''));
            break;
          }
          case 'address': {
            const blockId = args[2], address = args[3];
            if (!blockId || !address) { console.error('Usage: jataqi ipam address <blockId> <address> [--assign web-1]'); process.exit(1); }
            try {
              const e = await ipam.registerAddress({ blockId, address, ...(flag('assign') ? { assignedTo: flag('assign') } : {}) });
              console.log(`registered ${e.address}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'asns':
            for (const a of ipam.listAsns()) console.log(`- AS${a.asn} (${a.rir}) ${a.announcementType} [${a.status}]`);
            console.log(`${ipam.listAsns().length} ASN(s)`);
            break;
          case 'asn': {
            const asn = args[2], rir = args[3];
            if (!asn || !rir) { console.error('Usage: jataqi ipam asn <asn> <rir> [--anycast]'); process.exit(1); }
            try {
              const a = ipam.holdAsn({ asn: Number(asn), rir: rir as never, ...(args.includes('--anycast') ? { announcementType: 'anycast' as const } : {}) });
              console.log(`held AS${a.asn} (${a.id})`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'announce': {
            const blockId = args[2], asnId = args[3];
            if (!blockId || !asnId) { console.error('Usage: jataqi ipam announce <blockId> <asnId>'); process.exit(1); }
            try {
              const r = ipam.announce({ blockId, asnId });
              console.log(`announced block ${r.blockId} via ${r.asnId}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'announcements':
            for (const a of ipam.listAnnouncements()) console.log(`- block ${a.blockId} via ${a.asnId}`);
            console.log(`${ipam.listAnnouncements().length} announcement(s)`);
            break;
          case 'stats': {
            const stats = ipam.stats();
            console.log(JSON.stringify({ ...stats, totalAddresses: stats.totalAddresses.toString(), allocatedAddresses: stats.allocatedAddresses.toString() }, null, 2));
            break;
          }
          default:
            console.error('Usage: jataqi ipam blocks|block|split|addresses|address|asns|asn|announce|announcements|stats'); process.exit(1);
        }
        break;
      }
      case 'tools': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'sync': {
            const agent = agents.getAgent('main');
            const result = await toolIntel.syncAgentTools(agent.getTools(), { provider: 'agent-runtime', version: '1.0.0' });
            console.log(`synced ${result.synced.length} agent tool(s) into governance registry (created ${result.created}, updated ${result.updated})`);
            break;
          }
          case 'list': {
            const all = await toolIntel.list(flag('category'), flag('status') as never);
            for (const t of all) console.log(`- ${t.canonicalName} [${t.riskClass}/${t.privacyClass}] ${t.status} (${t.category})`);
            console.log(`${all.length} tool(s)`);
            break;
          }
          case 'stats': {
            const stats = await toolIntel.governanceStats();
            console.log(JSON.stringify({
              tools: stats.tools,
              approvals: stats.approvals,
              invocations: stats.invocations,
              decisions: stats.decisions,
              avgDurationMs: stats.avgDurationMs,
            }, null, 2));
            break;
          }
          case 'invoke': {
            const id = args[2] ?? flag('id');
            if (!id) { console.error('Usage: jataqi tools invoke <id> [--json input]'); process.exit(1); }
            const input = flag('json') ? JSON.parse(flag('json')!) : {};
            const result = await toolIntel.invoke(id, input, undefined, flag('approval'));
            console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
            break;
          }
          case 'alerts': {
            const result = await toolIntel.evaluateSlaRules();
            for (const a of result.alerts) {
              const icon = a.state === 'firing' ? (a.severity === 'critical' ? '🚨' : '⚠️') : '✅';
              console.log(`${icon} ${a.id} [${a.severity}] ${a.state} — ${a.message} (value ${a.value}/${a.threshold})`);
            }
            break;
          }
          case 'approvals': {
            const pending = toolIntel.listPendingApprovals();
            for (const a of pending) console.log(`- ${a.id} ${a.toolId} by ${a.principalId} [${a.status}] ${a.reason ?? ''}`);
            console.log(`${pending.length} pending approval(s)`);
            break;
          }
          case 'approve': {
            const id = args[2] ?? flag('id');
            const decision = flag('decision') ?? 'approved';
            if (!id) { console.error('Usage: jataqi tools approve <requestId> [--decision approved|denied]'); process.exit(1); }
            try {
              const decided = toolIntel.decideApproval(id, decision as never, 'cli-admin');
              console.log(`request ${id} -> ${decided.status}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          default:
            console.error('Usage: jataqi tools sync|list|stats|alerts|invoke|approvals|approve'); process.exit(1);
        }
        break;
      }
      case 'mobile': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'register': {
            const platform = args[2] ?? flag('platform');
            if (platform !== 'ios' && platform !== 'android') { console.error('Usage: jataqi mobile register <ios|android> [--token x] [--name x]'); process.exit(1); }
            const device = await mobile!.registerDevice('cli', { platform, ...(flag('token') ? { pushToken: flag('token')! } : {}), ...(flag('name') ? { name: flag('name')! } : {}) });
            console.log(`registered ${device.id} (${device.platform})`);
            break;
          }
          case 'devices': {
            if (!mobile) { console.log('mobile module not registered'); break; }
            const devices = await mobile.listDevices('cli');
            for (const d of devices) console.log(`- ${d.id} ${d.platform}${d.name ? ` (${d.name})` : ''}${d.pushToken ? ` token=${d.pushToken.slice(0, 8)}…` : ''}`);
            console.log(`${devices.length} device(s)`);
            break;
          }
          case 'snapshot': {
            if (!mobile) { console.log('mobile module not registered'); break; }
            console.log(JSON.stringify(await mobile.snapshot('cli'), null, 2));
            break;
          }
          case 'notify': {
            const title = flag('title') ?? args[2];
            const body = flag('body') ?? args[3];
            if (!title || !body) { console.error('Usage: jataqi mobile notify <title> <body>'); process.exit(1); }
            const result = await mobile!.notifyUser('cli', { title, body });
            console.log(`delivered to ${result.delivered} device(s)`);
            break;
          }
          default:
            console.error('Usage: jataqi mobile register|devices|snapshot|notify'); process.exit(1);
        }
        break;
      }
      case 'realtime': {
        const sub = args[1];
        switch (sub) {
          case 'stats': {
            if (!realtime) { console.log('realtime module not registered'); break; }
            const s = realtime.stats();
            console.log(JSON.stringify({ ...s, uptimeSec: Math.round(s.uptimeMs / 1000) }, null, 2));
            break;
          }
          default:
            console.error('Usage: jataqi realtime stats'); process.exit(1);
        }
        break;
      }
      case 'org': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'create': {
            const rest = args.slice(2);
            const nameParts: string[] = [];
            for (let i = 0; i < rest.length; i++) {
              if (rest[i]!.startsWith('--')) { i++; continue; } // skip flag + value
              nameParts.push(rest[i]!);
            }
            const name = nameParts.join(' ') || flag('name') || '';
            if (!name) { console.error('Usage: jataqi org create "<name>" [--slug x]'); process.exit(1); }
            const org = await orgs.createOrganization(name, 'cli', flag('slug'));
            console.log(`created ${org.id} (${org.name})`);
            break;
          }
          case 'list': {
            const mine = await orgs.organizationsForUser('cli');
            for (const o of mine) console.log(`- ${o.id} ${o.name} (${o.slug})`);
            console.log(`${mine.length} organization(s)`);
            break;
          }
          case 'invite': {
            const orgId = args[2] ?? flag('org');
            const target = args[3] ?? flag('target');
            if (!orgId || !target) { console.error('Usage: jataqi org invite <orgId> <email|userId> [--role member]'); process.exit(1); }
            try {
              const invitation = await orgs.invite(orgId, target, (flag('role') as never) ?? 'member', 'cli');
              console.log(`invitation created — token: ${invitation.token}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'accept': {
            const token = args[2] ?? flag('token');
            if (!token) { console.error('Usage: jataqi org accept <token>'); process.exit(1); }
            try {
              const membership = await orgs.acceptInvitation(token, 'cli');
              console.log(`joined ${membership.orgId} as ${membership.role}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'members': {
            const orgId = args[2] ?? flag('org');
            if (!orgId) { console.error('Usage: jataqi org members <orgId>'); process.exit(1); }
            const members = await orgs.listMembers(orgId);
            for (const m of members) console.log(`- ${m.userId} [${m.role}]`);
            console.log(`${members.length} member(s)`);
            break;
          }
          default:
            console.error('Usage: jataqi org create|list|invite|accept|members'); process.exit(1);
        }
        break;
      }
      case 'tanya': {
        const sub = args[1];
        const flag = (name: string): string | undefined => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
        };
        switch (sub) {
          case 'chat': {
            const message = args.slice(2).join(' ').trim() || flag('message') || '';
            if (!message) { console.error('Usage: jataqi tanya chat "<message>" [--conv <id>] [--persona <id>]'); process.exit(1); }
            try {
              let streamed = '';
              const result = await tanya.chat({
                userId: 'cli',
                message,
                ...(flag('conv') ? { conversationId: flag('conv')! } : {}),
                ...(flag('persona') ? { persona: flag('persona')! } : {}),
                // Stream word-by-word to stdout when NOT piped (TTY).
                ...(process.stdout.isTTY ? { onChunk: (c: string) => { process.stdout.write(c); streamed += c; } } : {}),
              });
              if (streamed) process.stdout.write('\n');
              console.log(`[${result.persona}@${result.agent}] ${streamed || result.reply}`);
              console.log(`conversation ${result.conversationId} (${result.messageCount} messages)`);
              for (const tc of result.toolCalls) console.log(`  tool: ${tc.name}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'conversations': {
            const listed = await tanya.listConversations('cli', { ...(flag('search') ? { search: flag('search') } : {}) });
            for (const c of listed.conversations) console.log(`- ${c.id} ${c.title} (${c.messages.length} msgs)`);
            console.log(`${listed.total} conversation(s)`);
            break;
          }
          case 'conversation': {
            const id = args[2] ?? flag('id');
            if (!id) { console.error('Usage: jataqi tanya conversation <id>'); process.exit(1); }
            const conv = await tanya.getConversation(id);
            if (!conv) { console.log('not found'); break; }
            for (const m of conv.messages) console.log(`[${m.role}] ${m.content}`);
            break;
          }
          case 'personas': {
            for (const p of tanya.listPersonas()) console.log(`- ${p.id} (${p.name}, agent ${p.agentName}): ${p.description}`);
            break;
          }
          case 'persona': {
            const id = args[2] ?? flag('id');
            const prompt = flag('prompt');
            if (!id || !prompt) { console.error('Usage: jataqi tanya persona <id> --prompt "system prompt" [--name N] [--description D]'); process.exit(1); }
            try {
              const persona = tanya.registerPersona({ id, systemPrompt: prompt, ...(flag('name') ? { name: flag('name')! } : {}), ...(flag('description') ? { description: flag('description')! } : {}) });
              console.log(`registered persona ${persona.id} -> agent ${persona.agentName}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'identify': {
            const token = flag('token') ?? args[2];
            if (!token) { console.error('Usage: jataqi tanya identify --token <accessToken>'); process.exit(1); }
            const identity = tanya.identify(token);
            if (!identity) { console.log('no identity for token'); break; }
            console.log(JSON.stringify(identity, null, 2));
            break;
          }
          case 'stats': {
            console.log(JSON.stringify(await tanya.stats('cli'), null, 2));
            break;
          }
          case 'export': {
            const convId = args[2];
            const format = flag('format') ?? 'json';
            if (!convId) { console.error('Usage: jataqi tanya export <convId> [--format json|markdown|text]'); process.exit(1); }
            try {
              const conv = await tanya.getConversation(convId);
              if (!conv) { console.log('not found'); break; }
              if (format === 'json') {
                console.log(JSON.stringify(conv, null, 2));
              } else if (format === 'markdown') {
                console.log(`# ${conv.title}\n`);
                for (const m of conv.messages) console.log(`**${m.role}**: ${m.content}\n`);
              } else {
                for (const m of conv.messages) console.log(`[${m.role}] ${m.content}`);
              }
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'share': {
            const convId = flag('conv') ?? args[2];
            const email = flag('email');
            const userId = flag('user');
            if (!convId || (!email && !userId)) { console.error('Usage: jataqi tanya share <convId> --email <e> | --user <userId> [--days n]'); process.exit(1); }
            try {
              const share = email
                ? await tanya.shareWithIdpIdentity(convId, 'cli', { email }, { ...(flag('days') ? { expiresInDays: Number(flag('days')) } : {}) })
                : await tanya.shareWith(convId, 'cli', userId!, { ...(flag('days') ? { expiresInDays: Number(flag('days')) } : {}) });
              console.log(`shared ${convId} with ${share.recipientUserId}${(share as { via?: string }).via ? ` (via ${(share as { via?: string }).via})` : ''}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'folders': {
            const conversationsMod = kernel.getModule('conversations') as unknown as { listFolders: (userId: string) => Promise<Array<{ id: string; name: string; color?: string }>> };
            const folders = await conversationsMod.listFolders('cli');
            for (const f of folders) console.log(`- ${f.id} ${f.name}${f.color ? ` (${f.color})` : ''}`);
            console.log(`${folders.length} folder(s)`);
            break;
          }
          case 'folder': {
            const action = args[2];
            const convId = args[3];
            const folderName = args[4];
            if (action === 'create' && folderName) {
              const conversationsMod = kernel.getModule('conversations') as unknown as { createFolder: (userId: string, name: string) => Promise<{ id: string }> };
              const folder = await conversationsMod.createFolder('cli', folderName);
              console.log(`created folder ${folder.id} (${folderName})`);
              break;
            }
            if (action === 'move' && convId) {
              const conversationsMod = kernel.getModule('conversations') as unknown as { moveToFolder: (id: string, folderId: string | undefined) => Promise<void> };
              const folderId = args[4] ?? flag('folder');
              await conversationsMod.moveToFolder(convId, folderId || undefined);
              console.log(`moved ${convId}${folderId ? ` into ${folderId}` : ' out of folder'}`);
              break;
            }
            console.error('Usage: jataqi tanya folder create <name> | folder move <convId> [folderId]'); process.exit(1);
          }
          case 'archive':
          case 'restore': {
            const convId = args[2];
            const archived = sub === 'archive';
            if (!convId) { console.error(`Usage: jataqi tanya ${sub} <convId>`); process.exit(1); }
            try {
              await tanya.setArchived(convId, 'cli', archived);
              console.log(`${archived ? 'archived' : 'restored'} ${convId}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'pin':
          case 'unpin': {
            const convId = args[2];
            const pinned = sub === 'pin';
            if (!convId) { console.error(`Usage: jataqi tanya ${sub} <convId>`); process.exit(1); }
            try {
              await tanya.setPinned(convId, 'cli', pinned);
              console.log(`${pinned ? 'pinned' : 'unpinned'} ${convId}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'summary': {
            const convId = args[2];
            if (!convId) { console.error('Usage: jataqi tanya summary <convId>'); process.exit(1); }
            try {
              const summary = await tanya.summarize(convId, 'cli');
              console.log(JSON.stringify(summary, null, 2));
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'sharelink': {
            const convId = args[2];
            if (!convId) { console.error('Usage: jataqi tanya sharelink <convId>'); process.exit(1); }
            try {
              const conv = await tanya.getConversation(convId);
              if (!conv || conv.userId !== 'cli') { console.log('conversation not found or not owned'); break; }
              const conversationsMod = kernel.getModule('conversations') as unknown as { share: (id: string) => Promise<string> };
              const shareId = await conversationsMod.share(convId);
              console.log(`share link id: ${shareId}`);
              console.log(`GET /chat/shared?id=${shareId} (public)`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'unshare': {
            const convId = args[2];
            const userId = args[3];
            if (!convId || !userId) { console.error('Usage: jataqi tanya unshare <convId> <userId>'); process.exit(1); }
            try {
              console.log(`removed: ${await tanya.unshareFrom(convId, 'cli', userId)}`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          case 'shared': {
            const inbox = await tanya.sharedWithMe('cli');
            for (const c of inbox) console.log(`- ${c.id} ${c.title} (by ${c.ownerId})`);
            console.log(`${inbox.length} shared conversation(s)`);
            break;
          }
          case 'shares': {
            const convId = args[2];
            if (!convId) { console.error('Usage: jataqi tanya shares <convId>'); process.exit(1); }
            try {
              const grants = await tanya.sharesFor(convId, 'cli');
              for (const g of grants) console.log(`- ${g.recipientUserId ?? 'public'} ${g.expiresAt ? `(expires ${new Date(g.expiresAt).toISOString()})` : ''}`);
              console.log(`${grants.length} grant(s)`);
            } catch (err) {
              console.log((err as Error).message);
            }
            break;
          }
          default:
            console.error('Usage: jataqi tanya chat|conversations|conversation|personas|persona|identify|stats|share|unshare|shared|shares|export|sharelink|summary|pin|unpin|archive|restore|folders|folder'); process.exit(1);
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
          if (line.startsWith('ingest ') || line.startsWith('search ') || line.startsWith('find ') || line.startsWith('stats') || line.startsWith('entities') || line.startsWith('memory ') || line.startsWith('learning ') || line.startsWith('prompts ') || line.startsWith('experiments ') || line.startsWith('wallet ') || line.startsWith('crypto ') || line.startsWith('dashboard ') || line.startsWith('brands ') || line.startsWith('automation ') || line.startsWith('fx ') || line.startsWith('pki ') || line.startsWith('mobility ') || line.startsWith('logistics ') || line.startsWith('farm ') || line.startsWith('circular ') || line.startsWith('qil ') || line.startsWith('energy ') || line.startsWith('border ') || line.startsWith('kitchen ') || line.startsWith('maza ') || line.startsWith('cloud ') || line.startsWith('cdn ') || line.startsWith('mail ') || line.startsWith('ipam ') || line.startsWith('tanya ') || line.startsWith('tools ') || line.startsWith('org ') || line.startsWith('realtime ') || line.startsWith('mobile ')) {
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
