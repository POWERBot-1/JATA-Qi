# JATA Qi — Modular AI Operating System

JATA Qi is a production-ready, modular AI operating system built on a plugin-style
kernel. It coordinates storage, vector search, knowledge services, knowledge
graphs, and an agent runtime behind a unified event-driven API you can embed in
any Node.js application or run from the CLI.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Applications / CLI                     │
├─────────────────────────────────────────────────────────────┤
│  Agent Runtime  │  Tools  │  Sessions / Memory  │  REPL      │
├─────────────────────────────────────────────────────────────┤
│  Knowledge Service     │  Knowledge Graph  (Graph-RAG)       │
├─────────────────────────────────────────────────────────────┤
│  Vector Search  (embeddings + ANN index + persistence)      │
├─────────────────────────────────────────────────────────────┤
│  Storage Layer  (Memory / Filesystem drivers, KV+Docs+Blobs)│
├─────────────────────────────────────────────────────────────┤
│                        Core Kernel                          │
│   Event Bus  ·  DI Container  ·  Lifecycle  ·  Config/Log   │
└─────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---|---|
| `@jataqi/core-kernel` | Event bus, DI container, topological module lifecycle, config, structured logging |
| `@jataqi/storage` | Pluggable KV / document collection / blob storage with in-memory and filesystem drivers |
| `@jataqi/vector-search` | Embedding models (hash, OpenAI), flat vector index with cosine/euclidean/dot, persistence |
| `@jataqi/knowledge-service` | Document/chunk model, paragraph+sentence+fixed chunker, semantic retrieval with context expansion |
| `@jataqi/knowledge-graph` | Entities, relations, SPO triple store, BFS traversal, heuristic extractor, Graph-RAG fusion |
| `@jataqi/agent-runtime` | Tool system, ReAct agent loop, Echo/Scripted/OpenAI LLMs, built-in knowledge+graph tools, session memory |
| `@jataqi/cli` | Bootstrapper (`createJataQi`, `createJataQiFromEnv`), CLI binary (`jataqi`) |

## Quick start

```bash
npm install
npm run build
npm test
```

Boot JATA Qi with one call:

```ts
import { createJataQi } from '@jataqi/cli';

const qi = await createJataQi();              // in-memory, EchoLLM
const answer = await qi.kernel
  .getModule('agent-runtime')
  .run('What is JATA Qi?');
console.log(answer);
await qi.shutdown();
```

Run the CLI:

```bash
node packages/cli/dist/src/index.js ask "what is JATA Qi?"
node packages/cli/dist/src/index.js ingest ./README.md
node packages/cli/dist/src/index.js search "vector search"
node packages/cli/dist/src/index.js stats
node packages/cli/dist/src/index.js repl
```

## Configuring for production

Copy `.env.example` to `.env` and set:

- `STORAGE_DRIVER=filesystem` (persists to `STORAGE_FS_ROOT`)
- `VECTOR_MODEL=openai` with `OPENAI_API_KEY` and `OPENAI_EMBEDDING_MODEL`
- `AGENT_LLM=openai` with `OPENAI_CHAT_MODEL` (e.g. `gpt-4o-mini`)
- `LOG_LEVEL=info` (or `debug` for development)

The CLI auto-loads `.env`; library users call `createJataQiFromEnv()`.

## Extending JATA Qi

Modules implement the `IModule` interface (`init`, `start`, `stop`, `dependsOn`) and
register themselves with the kernel:

```ts
class MyModule implements IModule {
  id = 'my-module';
  dependsOn = ['knowledge'] as const;
  async init(kernel: KernelApi) {
    const svc = kernel.getModule(KnowledgeService);
    kernel.container.registerValue('my.service', this);
  }
}
kernel.register(new MyModule());
await kernel.boot();
```

## Testing

Run the full test suite (100+ unit tests across all packages):

```bash
npm test
```

Each package can be built/tested independently:

```bash
npm run build --workspace=@jataqi/core-kernel
npm test --workspace=@jataqi/knowledge-graph
```

An end-to-end demo is in `examples/demo.mjs`:

```bash
node examples/demo.mjs
```

## Repository status

- ✅ Core Kernel (event bus, DI, lifecycle, config, logging)
- ✅ Storage Layer (memory + filesystem, KV/collections/blobs, pagination)
- ✅ Vector Search (hash + OpenAI embeddings, cosine/euclidean/dot, persistence)
- ✅ Knowledge Service (ingestion, chunking, retrieval, metadata filters, context expansion)
- ✅ Knowledge Graph (entities, triples, traversal, heuristic extraction, graph-RAG)
- ✅ Agent Runtime (tools, ReAct loop, Echo/Scripted/OpenAI LLMs, built-in tools, session memory)
- ✅ CLI + Bootstrap (.env support, ask/ingest/stats/search/entities/repl)
- ⬜ Push to GitHub remote (awaiting remote URL; all commits ready at `master`)

## License

MIT
