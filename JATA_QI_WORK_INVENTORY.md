# JATA Qi — Work Inventory

**Date:** 2026-08-29  
**Scope:** Complete file and module inventory of the JATA Qi workspace.

---

## 1. Project Root Files
- `package.json` — Root monorepo configuration and workspace mappings (`packages/*`)
- `package-lock.json` — Locked dependency tree
- `tsconfig.base.json` — Base TypeScript compiler options across packages
- `README.md` — Comprehensive architecture documentation, package table, quick start guide, production config, extension guide, repository status
- `examples/demo.mjs` — End-to-end JavaScript demo script (ingestion, extraction, semantic search, entity listing, agent call)
- `JATA_QI_DEVELOPMENT_HANDOFF.md` — Detailed handoff record
- `JATA_QI_CONTINUITY_MANIFEST.json` — Machine-readable project state manifest
- `JATA_QI_WORK_INVENTORY.md` — This work inventory

---

## 2. Monorepo Packages Inventory

### `@jataqi/core-kernel` (`packages/core-kernel`)
- **Source Files:**
  - `src/index.ts` — Main export
  - `src/kernel.ts` — Kernel lifecycle, module registration, topological boot/shutdown
  - `src/container.ts` — Dependency injection container (singletons, values, factories)
  - `src/event-bus.ts` — Typed pub/sub event bus with wildcarding & error isolation
  - `src/config.ts` — Typed configuration store
  - `src/logger.ts` — Structured JSON logger
  - `src/testing.ts` — Test helpers and mock kernel/modules
- **Test Files:**
  - `test/kernel.test.js`
  - `test/event-bus.test.js`
  - `test/container.test.js`
  - `test/config.test.js`
  - `test/logger.test.js`
- **Config:** `package.json`, `tsconfig.json`, `tsconfig.test.json`

### `@jataqi/storage` (`packages/storage`)
- **Source Files:**
  - `src/index.ts` — Main export
  - `src/types.ts` — Storage interfaces (Namespace, Collection, BlobStore, Driver)
  - `src/memory-driver.ts` — In-memory driver implementation (Map-based KV, Collection, Blob)
  - `src/fs-driver.ts` — Filesystem driver implementation (JSONL collections, file KV/blobs)
  - `src/storage-module.ts` — Kernel module integrating storage driver into DI container
- **Test Files:**
  - `test/memory.test.js`
  - `test/fs.test.js`
  - `test/storage-module.test.js`
- **Config:** `package.json`, `tsconfig.json`, `tsconfig.test.json`

### `@jataqi/vector-search` (`packages/vector-search`)
- **Source Files:**
  - `src/index.ts` — Main export
  - `src/types.ts` — Embedding model and index interfaces
  - `src/distance.ts` — Cosine, Euclidean, Dot product metrics and normalization
  - `src/hash-embedding.ts` — Deterministic hash embedding model (fallback/testing)
  - `src/openai-embedding.ts` — OpenAI API embedding model integration
  - `src/flat-index.ts` — Exact flat vector index with metadata filtering and JSON persistence
  - `src/vector-module.ts` — Kernel module integrating embedding model and vector index
- **Test Files:**
  - `test/distance.test.js`
  - `test/hash-embedding.test.js`
  - `test/flat-index.test.js`
  - `test/vector-module.test.js`
- **Config:** `package.json`, `tsconfig.json`, `tsconfig.test.json`

### `@jataqi/knowledge-service` (`packages/knowledge-service`)
- **Source Files:**
  - `src/index.ts` — Main export
  - `src/types.ts` — Document, chunk, and retrieval options
  - `src/chunker.ts` — Paragraph, sentence, and fixed-size chunking strategies with overlap and token estimation
  - `src/knowledge-service.ts` — Ingestion pipeline, chunk persistence, semantic retrieval, context window expansion
  - `src/knowledge-module.ts` — Kernel module integrating knowledge service
- **Test Files:**
  - `test/chunker.test.js`
  - `test/knowledge-service.test.js`
- **Config:** `package.json`, `tsconfig.json`, `tsconfig.test.json`

### `@jataqi/knowledge-graph` (`packages/knowledge-graph`)
- **Source Files:**
  - `src/index.ts` — Main export
  - `src/types.ts` — Entity, relation, triple, and graph query types
  - `src/triple-store.ts` — Subject-Predicate-Object triple storage with graph traversal (BFS)
  - `src/extractor.ts` — Heuristic entity and relation extractor from unstructured text
  - `src/graph-rag.ts` — Graph-RAG fusion engine combining vector retrieval with graph neighbors
  - `src/graph-module.ts` — Kernel module integrating knowledge graph and Graph-RAG
- **Test Files:**
  - `test/triple-store.test.js`
  - `test/extractor.test.js`
  - `test/graph-rag.test.js`
- **Config:** `package.json`, `tsconfig.json`, `tsconfig.test.json`

### `@jataqi/agent-runtime` (`packages/agent-runtime`)
- **Source Files:**
  - `src/index.ts` — Main export
  - `src/types.ts` — Tool, agent, and LLM interfaces
  - `src/tool-registry.ts` — Tool registration and parameter validation
  - `src/agent.ts` — ReAct agent execution loop with max iterations and `AbortSignal`
  - `src/llm.ts` — LLM adapters (EchoLLM, ScriptedLLM, OpenAI LLM)
  - `src/builtins.ts` — Built-in tools for knowledge search, graph lookup, and storage
  - `src/agent-module.ts` — Kernel module integrating agent runtime and default agents
- **Test Files:**
  - `test/tool-registry.test.js`
  - `test/agent.test.js`
  - `test/agent-module.test.js`
- **Config:** `package.json`, `tsconfig.json`, `tsconfig.test.json`

### `@jataqi/cli` (`packages/cli`)
- **Source Files:**
  - `src/index.ts` — CLI binary entry point and command handlers (ask, ingest, search, stats, entities, repl)
  - `src/config.ts` — `.env` parser and config loader (`loadEnv`, `readConfig`)
  - `src/bootstrap.ts` — `createJataQi` and `createJataQiFromEnv` stack initializers
- **Test Files:**
  - `test/bootstrap.test.js`
  - `test/config.test.js`
- **Config:** `package.json`, `tsconfig.json`, `tsconfig.test.json`

---

## 3. Git Status & Checkpoint
- New continuity files (`JATA_QI_DEVELOPMENT_HANDOFF.md`, `JATA_QI_CONTINUITY_MANIFEST.json`, `JATA_QI_WORK_INVENTORY.md`) created.
- Local checkpoint commit can be established to secure continuity records.
