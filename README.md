# JATA Qi — Modular AI Operating System

JATA Qi is a production-ready, modular AI operating system built on a plugin-style
kernel that coordinates storage, vector search, knowledge services, knowledge
graphs, agents, tools, and memory behind a unified event-driven API.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Applications                         │
├─────────────────────────────────────────────────────────────┤
│  Agent Runtime │  Tool System │ Memory │ API / CLI          │
├─────────────────────────────────────────────────────────────┤
│  Knowledge Service  │  Knowledge Graph                       │
├─────────────────────────────────────────────────────────────┤
│  Vector Search                                              │
├─────────────────────────────────────────────────────────────┤
│  Storage Layer (Memory / Filesystem / SQLite adapters)      │
├─────────────────────────────────────────────────────────────┤
│                        Core Kernel                          │
│      (Event Bus, DI Container, Module Lifecycle, Config)    │
└─────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Purpose |
|---|---|
| `@jataqi/core-kernel` | Event bus, DI container, module lifecycle, config, logging |
| `@jataqi/storage` | Pluggable storage interface with in-memory, file, and SQLite adapters |
| `@jataqi/vector-search` | Embedding abstraction + vector index (HNSW-style) |
| `@jataqi/knowledge-service` | Document ingestion, chunking, retrieval, RAG orchestration |
| `@jataqi/knowledge-graph` | Entities, relations, triple store, traversal, graph-RAG fusion |
| `@jataqi/agent-runtime` | Agent loop, planning, tool invocation |

## Development

```bash
npm install
npm run build     # compile all packages
npm test          # run all test suites
```

Modules are loaded through the kernel's plugin interface, which manages
lifecycle (init → start → stop) and dependency ordering automatically.
