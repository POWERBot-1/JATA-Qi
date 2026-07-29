# JATA Qi Module Registry

22 packages, 250 tests. Every package is a kernel module (`IModule`) registered
through `@jataqi/core-kernel` and wired by `@jataqi/cli` (`createJataQi`).

| Package | id | Depends on | Purpose |
|---|---|---|---|
| `@jataqi/core-kernel` | `core-kernel` | – | event bus, DI, lifecycle, config, logging |
| `@jataqi/storage` | `storage` | – | KV / collections / blobs (memory + filesystem) |
| `@jataqi/vector-search` | `vector-search` | storage | embeddings + flat index |
| `@jataqi/knowledge-service` | `knowledge` | storage, vector | ingest / chunk / retrieve |
| `@jataqi/knowledge-graph` | `knowledge-graph` | storage | entities, triples, graph-RAG |
| `@jataqi/agent-runtime` | `agent-runtime` | knowledge, graph, vector | ReAct agents + tools + LLMs |
| `@jataqi/qil` | `qil` | – | QiL language → execution plan |
| `@jataqi/orchestrator` | `orchestrator` | agent-runtime, knowledge, qil | workflow engine + durable history |
| `@jataqi/security` | `security` | storage | identity, auth, RBAC, audit ledger |
| `@jataqi/api-gateway` | `api-gateway` | security, orchestrator | HTTP gateway, rate limiting, OpenAPI |
| `@jataqi/metrics` | `metrics` | – | counters / gauges / histograms |
| `@jataqi/simulation` | `simulation` | – | Monte-Carlo scenarios |
| `@jataqi/teams` | `teams` | agent-runtime | multi-agent coordination |
| `@jataqi/plugins` | `plugins` | – | plugin manager |
| `@jataqi/model-registry` | `model-registry` | – | model catalog + selector |
| `@jataqi/scheduler` | `scheduler` | – | task queue + adaptive compute router |
| `@jataqi/compute` | `compute` | – | statistics / regression / optimization |
| `@jataqi/robotics` | `robotics` | storage | device registry, missions, telemetry |
| `@jataqi/digital-twin` | `digital-twin` | storage | stateful twins, step/project |
| `@jataqi/tool-intelligence` | `tool-intelligence` | storage | Universal AI Tool Layer: registry, adapters, risk, approvals, fallback |
| `@jataqi/readiness` | `readiness` | – | honest capability/readiness matrix |
| `@jataqi/cli` | – | all | bootstrap (`createJataQi`) + CLI binary |

## Discovering modules at runtime

```bash
GET /                  # route index
GET /openapi.json      # OpenAPI 3.0
GET /readiness         # capability matrix with honest statuses
GET /health            # booted module list
```
