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
  entities [<type>]   List entities in the knowledge graph.
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
      case 'repl':
      default: {
        const rl = readline.createInterface({ input, output });
        console.log('JATA Qi REPL. Type "help" for commands, "exit" to quit.');
        while (true) {
          const line = (await rl.question('jataqi> ')).trim();
          if (!line) continue;
          if (line === 'exit' || line === 'quit') break;
          if (line === 'help') { console.log(HELP); continue; }
          if (line.startsWith('ingest ') || line.startsWith('search ') || line.startsWith('stats') || line.startsWith('entities')) {
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

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
