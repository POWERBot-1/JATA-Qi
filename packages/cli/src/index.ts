#!/usr/bin/env node
// JATA Qi CLI — boots the OS and offers simple commands.

import { createJataQiFromEnv } from './bootstrap.js';
import { loadEnv } from './config.js';
import { parseHostArgs, runHostCommand } from './host-command.js';
import { runHostInspectCommand } from './host-inspect.js';
import { runHostEnqueueCommand } from './host-ingress-command.js';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { AgentRuntimeModule } from '@jataqi/agent-runtime';
import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { KnowledgeGraphModule } from '@jataqi/knowledge-graph';

const HELP = `
JATA Qi CLI
-----------
Commands:
  ask <question>      Run a single question through the default agent and exit.
  ingest <file>       Ingest a text file into the knowledge base.
  stats               Print knowledge/vector/graph stats.
  search <query>      Semantic search (no agent) — top 3 chunks.
  entities [<type>]   List entities in the knowledge graph.
  repl                Start an interactive REPL.
  help                Show this help.
  exit / quit         Exit REPL.

Host runtime (R-01):
  host [options]      Run the supervised, unattended governed host process.
                      Requires a durable storage driver (STORAGE_DRIVER=postgres
                      + JATAQI_PG_CONNECTION_STRING); refuses to start on
                      development-only storage. Ctrl-C / SIGTERM drains cleanly.
        --max-cycles <n>              Stop after n supervision cycles.
        --min-idle-ms <n>             Floor on the pause between cycles.
        --max-idle-ms <n>             Ceiling on the pause between cycles.
        --allow-non-durable-storage   Local development only; state is lost.

  host:work [status]  Read-only: list hosted work items (operator inspection).
  host:dlq            Read-only: list dead-lettered / quarantined work items.
  host:health         Read-only: print host lifecycle, storage driver, next wake.

Authenticated work ingress (T-03):
  host:enqueue [options]
                      Create durable work behind the T-01/T-03 principal
                      boundary. Fails closed unless an authentication method is
                      configured; never self-attests a principal.
        --objective <text>          Required. What the loop is asked to do.
        --correlation-id <id>       Optional correlation identity.
        --idempotency-key <key>     Optional; re-submitting returns the same item.
        --tenant <tenantId>         Optional consistency check ONLY. Must equal
                                    the authenticated tenant or the request is
                                    refused; it can never override it.
        --roles <r1,r2>             Optional role NARROWING. Widening is refused.
        --knowledge-query <text>    Optional retrieval query for the loop.

      Credential material is read from JATAQI_AUTH_TOKEN (never argv), and the
      authentication METHOD comes from the configured JATAQI_AUTH_MODE — a
      caller cannot choose it. With no method configured the command refuses.

Host inspection commands are strictly read-only: they never dispatch, resume,
retry, approve, or settle anything. host:enqueue creates work; it never
dispatches, and the full 34-stage governed loop remains the only executor.
`;

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'repl';

  // R-01: the host runtime and its read-only inspection commands own their own
  // kernel lifecycle (the host module must be explicitly enabled for them), so
  // they are dispatched before the standard agent-oriented boot below.
  if (cmd === 'host') {
    const code = await runHostCommand(parseHostArgs(args.slice(1)));
    process.exit(code);
  }
  if (cmd === 'host:work' || cmd === 'host:dlq' || cmd === 'host:health') {
    const code = await runHostInspectCommand(cmd, args.slice(1));
    process.exit(code);
  }
  // T-03: authenticated work ingress. Creates durable work and nothing else.
  if (cmd === 'host:enqueue') {
    const code = await runHostEnqueueCommand(args.slice(1));
    process.exit(code);
  }

  const jataqi = await createJataQiFromEnv();
  const kernel = jataqi.kernel;
  const agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
  const knowledge = kernel.getModule<KnowledgeService>('knowledge');
  const graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        break;
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
    await jataqi.shutdown();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
