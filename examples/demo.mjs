// End-to-end demo: boot JATA Qi, ingest some text, run a semantic search,
// traverse the knowledge graph, and run the agent.

import { createJataQi } from '../packages/cli/dist/src/bootstrap.js';

const qi = await createJataQi();
const { kernel } = qi;
const ks = kernel.getModule('knowledge');
const graph = kernel.getModule('knowledge-graph');
const agents = kernel.getModule('agent-runtime');

// 1. Ingest a couple of docs.
const docs = [
  'Alice Smith is the CEO of Acme Corporation, which is based in Paris. Acme was founded in 1998.',
  'Bob Jones is a software engineer at Acme Corporation. He studied at MIT.',
  'The Eiffel Tower is a famous landmark in Paris, France, designed by Gustave Eiffel.',
  'JATA Qi is a modular AI operating system with a kernel, storage, vector search, knowledge graph, and agent runtime.',
];
for (const text of docs) {
  const doc = await ks.ingestText(text, { chunkSize: 400 });
  for (const cid of doc.chunkIds) {
    const c = await ks.getChunk(cid);
    if (!c) continue;
    const r = graph.extractFromText(c.text, { chunkId: cid, documentId: doc.id });
    for (const t of r.triples) graph.linkMention(cid, t.object, 0.7, doc.id);
  }
}

console.log('\n=== Stats ===');
console.log('knowledge:', await ks.stats());
console.log('graph:', graph.stats());

// 2. Semantic search.
console.log('\n=== Semantic search: "who works at Acme?" ===');
const hits = await ks.retrieve('who works at Acme?', { topK: 3 });
for (const h of hits) {
  console.log(`- [${h.score.toFixed(3)}] ${h.chunk.text.slice(0, 200)}`);
}

// 3. Entity lookup.
console.log('\n=== Entities of type Person ===');
for (const e of graph.entitiesByType('Person')) console.log(`  ${e.id} :: ${e.name}`);

// 4. Run the agent.
console.log('\n=== Agent: "tell me about Acme" ===');
const res = await agents.run('tell me about Acme');
console.log(res.answer);
console.log(`(iterations=${res.iterations}, tools=${res.toolCalls.length}, reason=${res.finishedReason})`);

await qi.shutdown();
