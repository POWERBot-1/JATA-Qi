# JATA Qi Module Registry

90 packages, 1790+ tests. Every package is a kernel module (`IModule`) registered
through `@jataqi/core-kernel` and wired by `@jataqi/cli` (`createJataQi`).

| Package | id | Depends on | Purpose |
|---|---|---|---|
| `@jataqi/core-kernel` | `core-kernel` | – | event bus, DI, lifecycle, config, logging |
| `@jataqi/storage` | `storage` | – | KV / collections / blobs (memory + filesystem) |
| `@jataqi/vector-search` | `vector-search` | storage | embeddings + flat index |
| `@jataqi/knowledge-service` | `knowledge` | storage, vector | ingest / chunk / retrieve |
| `@jataqi/knowledge-graph` | `knowledge-graph` | storage | entities, triples, graph-RAG |
| `@jataqi/agent-runtime` | `agent-runtime` | knowledge, graph, vector, fx, mobility, logistics, agriculture, circular, energy, border, restaurants, marketplace, search, universal-wallet, crypto, cloud, cdn, email, ipam | ReAct agents + 37 default tools (knowledge/graph/vector + 32 intelligence tools) + LLMs |
| `@jataqi/qil` | `qil` | – | QiL language → execution plan; idempotent formatter + semantic linter |
| `@jataqi/orchestrator` | `orchestrator` | agent-runtime, knowledge, qil | workflow engine + durable history + per-step streaming (onStep) |
| `@jataqi/security` | `security` | storage | identity, auth, RBAC, audit ledger + CSV/JSON export, session introspection (sessionInfo) |
| `@jataqi/api-gateway` | `api-gateway` | security, orchestrator | HTTP gateway, rate limiting, OpenAPI |
| `@jataqi/realtime` | `realtime` | – | WebSocket server — auth, topic subscriptions, bus-event broadcast (security/orchestrator/memory/tools/tanya), keepalive + pruning, connection stats (CLI + console + gateway) |
| `@jataqi/metrics` | `metrics` | – | counters / gauges / histograms |
| `@jataqi/simulation` | `simulation` | – | Monte-Carlo scenarios |
| `@jataqi/teams` | `teams` | agent-runtime | multi-agent coordination |
| `@jataqi/plugins` | `plugins` | – | plugin manager |
| `@jataqi/model-registry` | `model-registry` | – | model catalog + selector |
| `@jataqi/scheduler` | `scheduler` | – | task queue + adaptive compute router |
| `@jataqi/compute` | `compute` | – | statistics / regression / optimization |
| `@jataqi/robotics` | `robotics` | storage | device registry, missions, telemetry |
| `@jataqi/digital-twin` | `digital-twin` | storage | stateful twins, step/project |
| `@jataqi/tool-intelligence` | `tool-intelligence` | storage | Universal AI Tool Layer: registry, adapters, risk, approvals, fallback; agent tool governance catalog (39 tools, R0–R4) + sync + governance metrics/observability + SLA alerts |
| `@jataqi/readiness` | `readiness` | – | honest capability/readiness matrix |
| `@jataqi/memory` | `memory` | storage | Digital Memory Engine (CLP P1) — governed platform-event memory |
| `@jataqi/learning` | `learning` | memory | Continuous Learning + Personalization (CLP P2/6) + Knowledge Distillation (CLP P5) |
| `@jataqi/ai-learning` | `ai-learning` | – | AI Learning Platform (CLP P3) — prompt registry, quality, drift; prompt experiments (CLP P4) |
| `@jataqi/search` | `search` | knowledge, memory, graph, conversations, tool-intelligence | Universal Search & Discovery (Phase 6) — federated, personalized, faceted |
| `@jataqi/automation` | `automation` | memory, notifications, knowledge, agent-runtime, tool-intelligence | SOMA AI (Phase 6) — Intelligent Automation Engine: schedule/event/manual triggers, chained actions, executions |
| `@jataqi/pki` | `pki` | – | PRX Part C — X.509 CA (root/intermediate), Registration Authority (domain validation), OIDC-lite Identity Provider, ACME (RFC 8555) automated issuance; deep IdP (refresh grant + rotation, session rotation, profile upsert, client-credentials IdP-first login, revocation) |
| `@jataqi/fx` | `fx` | memory, universal-wallet | KARIS FX (Phase 6) — rate engine, cross rates, conversions, trend/volatility analytics |
| `@jataqi/mobility` | `mobility` | memory | MOTO X (Phase 7) — vehicles/fleets/drivers, dispatch, trips, telemetry, geofences |
| `@jataqi/logistics` | `logistics` | memory | PORTLINK (Phase 7) — ports, vessels, containers, shipments + tracking, warehouses |
| `@jataqi/agriculture` | `agriculture` | memory | KARIS FARM (Phase 7) — farms, fields, crop cycles, harvests, livestock |
| `@jataqi/circular` | `circular` | memory | KARIS LOOP (Phase 7) — material streams, collections, take-back, circularity |
| `@jataqi/energy` | `energy` | memory | KARIS ENERGY (Phase 7) — assets, meters, readings, tariffs/billing |
| `@jataqi/border` | `border` | memory | KARIS BORDER X (Phase 7) — posts, watchlists, crossings, manifests |
| `@jataqi/restaurants` | `restaurants` | memory | NYUMBANI KITCHEN (Phase 7) — venues, menus, orders, inventory |
| `@jataqi/marketplace` | `marketplace` | memory, commerce | MAZA (Phase 7) — storefronts, listings, reviews, purchases |
| `@jataqi/cloud` | `cloud` | memory | PRX Part E — regions, compute, volumes, networks, hosting plans, autoscaling |
| `@jataqi/cdn` | `cdn` | memory | PRX CDN — edge nodes, zones, caching + origin shield, purge |
| `@jataqi/email` | `email` | memory | PRX Email Provider — MX/SPF/DKIM/DMARC, mailboxes, delivery |
| `@jataqi/ipam` | `ipam` | memory | PRX RIR Member — IP allocations, ASNs, subnetting, anycast |
| `@jataqi/tanya` | `tanya` | conversations, agent-runtime, pki | TANYA AI — personas, persistent chat with tool-call history, IdP identity bridge, WS streaming (tanya.chunk), multi-user org-scoped chat + IdP-identity sharing, org-aware console + role-gated org directory |
| `@jataqi/conversations` | `conversations` | storage | persistent history, folders, pins, search, sharing, export; org scope + recipient-scoped shares |
| `@jataqi/self-evolution` | `self-evolution` | storage | governed self-evolution (CLP P7) — proposals, experiments, rollback |
| `@jataqi/design-system` | `design-system` | – | universal design language — tokens, themes, CSS generation |
| `@jataqi/branding` | `branding` | – | brand identity for the 15 JATA Qi products |
| `@jataqi/web-ui` | `web-ui` | – | Admin Console SPA served at `/ui` — TANYA chat, dashboards, engines, tools governance; PWA shell (manifest + service worker) |
| `@jataqi/dashboard` | `dashboard` | learning | adaptive dashboard — widget framework + layout + AI personalization |
| `@jataqi/universal-wallet` | `universal-wallet` | – | double-entry wallet engine (finance/commerce/game consolidation) |
| `@jataqi/payments` | `flutterwave` | – | payment provider bridges (M-Pesa, Flutterwave, Pesapal, Stripe, …) |
| `@jataqi/crypto` | `crypto` | – | KRT digital asset platform — tokens, NFTs, staking, exchange, custody |
| `@jataqi/link-intelligence` | `link-intelligence` | knowledge, memory | link classification → extraction → gap analysis → evolution |
| `@jataqi/multimodal-intelligence` | `multimodal-intelligence` | knowledge, memory | cross-modality knowledge acquisition framework |
| `@jataqi/soc` | `soc` | – | Global Security Operations — telemetry pipeline + hash-chained data lake, threat hunting/intel, insider risk, abuse detection, incident command (sev/escalation/evidence), adversarial validation, security KPIs |
| `@jataqi/active-defense` | `active-defense` | – | Active Defense & Adaptive Resilience — session risk scoring, adaptive access, approval-gated containment, honeytokens/decoys, dynamic defense, autonomous recovery, continuous improvement |
| `@jataqi/mobile` | `mobile` | storage | TANYA Mobile Native — push devices (FCM/APNs), push payloads, offline outbox sync, home snapshot |
| `@jataqi/mobile-app` | – | – | TANYA Mobile Reference App — platform-neutral mobile controller over the SDK (auth persistence, device heartbeat, home snapshot, streaming chat, offline outbox, push feed, silent IdP rotation) + Expo/React Native reference app in examples/react-native-app |
| `@jataqi/sdk` | – | – | typed HTTP client (26 namespaces incl. pki, audit, tanya, alerts) + WebSocket StreamingClient (/ws: tanya.chat, qil.run, chat) |
| `@jataqi/cli` | – | all | bootstrap (`createJataQi`) + CLI binary |

## Discovering modules at runtime

```bash
GET /                  # route index
GET /openapi.json      # OpenAPI 3.0
GET /readiness         # capability matrix with honest statuses
GET /health            # booted module list
```
