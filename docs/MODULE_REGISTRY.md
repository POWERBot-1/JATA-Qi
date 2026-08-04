# JATA Qi Module Registry

89 packages, 1500+ tests. Every package is a kernel module (`IModule`) registered
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
| `@jataqi/memory` | `memory` | storage | Digital Memory Engine (CLP P1) — governed platform-event memory |
| `@jataqi/learning` | `learning` | memory | Continuous Learning + Personalization (CLP P2/6) + Knowledge Distillation (CLP P5) |
| `@jataqi/ai-learning` | `ai-learning` | – | AI Learning Platform (CLP P3) — prompt registry, quality, drift; prompt experiments (CLP P4) |
| `@jataqi/search` | `search` | knowledge, memory, graph, conversations, tool-intelligence | Universal Search & Discovery (Phase 6) — federated, personalized, faceted |
| `@jataqi/automation` | `automation` | memory, notifications, knowledge, agent-runtime, tool-intelligence | SOMA AI (Phase 6) — Intelligent Automation Engine: schedule/event/manual triggers, chained actions, executions |
| `@jataqi/pki` | `pki` | – | PRX Part C — X.509 CA (root/intermediate), Registration Authority (domain validation), OIDC-lite Identity Provider |
| `@jataqi/fx` | `fx` | memory, universal-wallet | KARIS FX (Phase 6) — rate engine, cross rates, conversions, trend/volatility analytics |
| `@jataqi/mobility` | `mobility` | memory | MOTO X (Phase 7) — vehicles/fleets/drivers, dispatch, trips, telemetry, geofences |
| `@jataqi/logistics` | `logistics` | memory | PORTLINK (Phase 7) — ports, vessels, containers, shipments + tracking, warehouses |
| `@jataqi/self-evolution` | `self-evolution` | storage | governed self-evolution (CLP P7) — proposals, experiments, rollback |
| `@jataqi/design-system` | `design-system` | – | universal design language — tokens, themes, CSS generation |
| `@jataqi/branding` | `branding` | – | brand identity for the 15 JATA Qi products |
| `@jataqi/dashboard` | `dashboard` | learning | adaptive dashboard — widget framework + layout + AI personalization |
| `@jataqi/universal-wallet` | `universal-wallet` | – | double-entry wallet engine (finance/commerce/game consolidation) |
| `@jataqi/payments` | `flutterwave` | – | payment provider bridges (M-Pesa, Flutterwave, Pesapal, Stripe, …) |
| `@jataqi/crypto` | `crypto` | – | KRT digital asset platform — tokens, NFTs, staking, exchange, custody |
| `@jataqi/link-intelligence` | `link-intelligence` | knowledge, memory | link classification → extraction → gap analysis → evolution |
| `@jataqi/multimodal-intelligence` | `multimodal-intelligence` | knowledge, memory | cross-modality knowledge acquisition framework |
| `@jataqi/cli` | – | all | bootstrap (`createJataQi`) + CLI binary |

## Discovering modules at runtime

```bash
GET /                  # route index
GET /openapi.json      # OpenAPI 3.0
GET /readiness         # capability matrix with honest statuses
GET /health            # booted module list
```
