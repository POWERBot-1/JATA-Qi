#!/usr/bin/env node
// JATA Qi CLI — boots the OS and offers simple commands.

import { createJataQi } from './bootstrap.js';
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
`;

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'repl';

  const jataqi = await createJataQi();
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
