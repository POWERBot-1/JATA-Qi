# JATA Qi — Modular AI Operating System

JATA Qi is a production-ready, modular AI operating system built on a plugin-style
kernel. It coordinates storage, vector search, knowledge services, knowledge
graphs, an agent runtime, a declarative orchestration language (**QiL**), an
orchestration/workflow engine, identity & security, and an HTTP API gateway —
behind a unified event-driven API you can embed in any Node.js application or run
from the CLI.

The system implements the layered architecture described in the **JATA AI
specification**: a Quantum Intelligence kernel, a Unified Knowledge Fabric, a
multi-agent framework, and a set of intelligence services, exposed through an
**Alpha vertical slice** in which a user can authenticate → submit a request →
have QiL generate a workflow → execute agents → retrieve knowledge → receive a
structured response → produce an auditable execution record.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│            HTTP API Gateway   ·   CLI   ·   Applications          │
├──────────────────────────────────────────────────────────────────┤
│  Identity/Security (auth, RBAC, audit)  ·  Workflow Orchestrator  │
├──────────────────────────────────────────────────────────────────┤
│  Teams (multi-agent)  ·  Simulation (Monte-Carlo)  ·  Plugins     │
├──────────────────────────────────────────────────────────────────┤
│  Model Registry (selection)  ·  Compute Scheduler (task queue)    │
├──────────────────────────────────────────────────────────────────┤
│  QiL Language (lexer/parser/compiler → ExecutionPlan)             │
├──────────────────────────────────────────────────────────────────┤
│  Agent Runtime  ·  Tools  ·  Sessions / Memory                    │
├──────────────────────────────────────────────────────────────────┤
│  Knowledge Service  ·  Knowledge Graph  (Graph-RAG)               │
├──────────────────────────────────────────────────────────────────┤
│  Vector Search  (embeddings + ANN index + persistence)            │
├──────────────────────────────────────────────────────────────────┤
│  Storage Layer  (Memory / Filesystem drivers, KV+Docs+Blobs)      │
├──────────────────────────────────────────────────────────────────┤
│  Core Kernel  ·  Metrics (counters/gauges/histograms)             │
│   Event Bus  ·  DI Container  ·  Lifecycle  ·  Config / Log       │
└──────────────────────────────────────────────────────────────────┘
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
| `@jataqi/automation` | **SOMA AI (Phase 6)** — Intelligent Automation Engine: schedule/event/manual triggers, chained actions (memory, notifications, knowledge, agents, tools), concurrency caps, timeouts, execution history |
| `@jataqi/pki` | **PRX Part C** — X.509 certificate authority (root/intermediate), Registration Authority with CA/B Forum domain validation, CRLs, OIDC-lite Identity Provider (JWT ID tokens, JWKS, introspection) |
| `@jataqi/fx` | **KARIS FX (Phase 6)** — Foreign Exchange Intelligence: rate engine, cross rates, bid/ask spreads, conversions with margin, history, trend + volatility analytics |
| `@jataqi/mobility` | **MOTO X (Phase 7)** — Mobility Intelligence: vehicles/fleets/drivers, nearest-vehicle dispatch, trip lifecycle + fares, telemetry, geofences |
| `@jataqi/logistics` | **PORTLINK (Phase 7)** — Logistics & Port Intelligence: ports, vessels, containers, tracking-event shipment timelines, warehouses, freight analytics |
| `@jataqi/agriculture` | **KARIS FARM (Phase 7)** — Agricultural Intelligence: farms/fields, crop cycles + growth stages, harvests, livestock herds, yield analytics |
| `@jataqi/circular` | **KARIS LOOP (Phase 7)** — Circular Economy Platform: material streams, collection lifecycle, product take-back, circularity scoring, CO2e savings |
| `@jataqi/energy` | **KARIS ENERGY (Phase 7)** — Energy Intelligence: generation assets, meters + monotonic readings, consumption analytics, tariff billing |
| `@jataqi/border` | **KARIS BORDER X (Phase 7)** — Border Security Intelligence: posts, watchlist screening, crossing clearances, cargo manifests with risk flagging |
| `@jataqi/restaurants` | **NYUMBANI KITCHEN (Phase 7)** — Restaurant Intelligence: venues, menus, tables, order flow, ingredient inventory + reorder alerts, revenue analytics |
| `@jataqi/marketplace` | **MAZA (Phase 7)** — Marketplace Intelligence: vendor storefronts, listings + inventory, reviews & ratings, search, analytics; composes `@jataqi/commerce` for purchases |
| `@jataqi/cloud` | **PRX Part E** — Cloud Infrastructure Provider (cloud/vps/hosting): regions, compute instances, volumes + snapshots, VPCs + firewalls, load balancers, hosting plans, autoscaling |
| `@jataqi/cdn` | **PRX CDN** — Content delivery: edge nodes, cached zones with origins + TTLs, origin shield, purge, edge analytics |
| `@jataqi/email` | **PRX Email Provider** — domains with MX/SPF/DKIM/DMARC, verified sending, mailboxes, inbound with DMARC disposition |
| `@jataqi/ipam` | **PRX RIR Member** — IP Address Management: IPv4/IPv6 allocations from AFRINIC/APNIC/ARIN/RIPE/LACNIC, ASN holdings, CIDR subnetting, anycast announcements |
| `@jataqi/tanya` | **TANYA AI (Phase 6)** — conversational product layer: named personas materialized as agents, persistent chat with tool-call history, PKI IdP identity bridge |
| `@jataqi/qil` | **QiL** orchestration language — lexer, parser, AST, validator, and compiler to an execution plan |
| `@jataqi/orchestrator` | Workflow engine / Mission Coordinator — executes QiL plans (retrieval → reasoning → reporting) and emits audit records |
| `@jataqi/teams` | Multi-agent coordination (MAIF) — fan-out / sequential / consensus teams with synthesis |
| `@jataqi/simulation` | Probabilistic Monte-Carlo scenario engine with distributions, statistics, and target probabilities |
| `@jataqi/security` | Identity, authentication (scrypt), RBAC authorization, API keys, append-only audit ledger |
| `@jataqi/metrics` | Observability — counters, gauges, histograms, registry, Prometheus exposition |
| `@jataqi/plugins` | Plugin manager — capabilities, permissions, dependency validation, auto-registration |
| `@jataqi/model-registry` | Model intelligence — catalog with metadata and a cost/latency/quality selector |
| `@jataqi/scheduler` | Compute scheduler — priority task queue with targets, capacity, dependencies + adaptive compute router |
| `@jataqi/compute` | Scientific/math — statistics, linear regression, numerical optimization (Step 11); agent tools |
| `@jataqi/robotics` | Embodied intelligence (Step 32) — device registry, missions, telemetry, digital twins |
| `@jataqi/tool-intelligence` | Universal AI Tool Layer — global registry, adapters, risk classes, approval gating, evaluation, fallback |
| `@jataqi/readiness` | Honest machine-readable capability/readiness matrix (directives #64/#100) |
| `@jataqi/provenance` | Creator identity & provenance (JQ-CIP) — Ed25519 signed root manifest, append-only ledger, fingerprints, key rotation (creator: GITANYA K) |
| `@jataqi/commerce` | Commercial & product packaging — configurable plans/editions, subscriptions/trials, entitlements, usage metering, credits, licensing, invoices, marketplace commissions (payments abstracted) |
| `@jataqi/organizations` | Multi-tenancy — organizations, memberships, roles, invitations, tenant scoping |
| `@jataqi/notifications` | Notification engine — multi-channel delivery, in-app inbox, preferences, rate limits (event-driven) |
| `@jataqi/policies` | Governance — declarative policy engine (allow/deny/require_approval) + compliance-control registry |
| `@jataqi/feature-flags` | Deployment/testing rollout switches (deterministic % rollout; separate from entitlements) |
| `@jataqi/privacy` | Data privacy — classification, retention, consent, subject-access requests, AI-context restriction |
| `@jataqi/policy-governance` | Policy & governance control plane — versioned, tenant-aware, precedence-based engine; agent/tool/autonomy governance |
| `@jataqi/accreditation` | **PRX Part L** — Legal Operation Mode + accreditation governance: gates public-trust capabilities (registry, registrar, DNS authority, CA, RIR, cloud, hosting, IdP, CDN, marketplace) behind verified Ed25519-signed grants; SHA-256-chained immutable ledger; honest claim verification |
| `@jataqi/dns` | **PRX Part D** — Global DNS platform: RFC 1035 wire codec, authoritative UDP/TCP server, recursive resolver, DNSSEC (ECDSA P-256, RRSIG/DNSKEY/DS/NSEC), GeoDNS views, AXFR, RDAP |
| `@jataqi/registry` | **PRX Part A** — TLD Registry platform: domain lifecycle (ICANN grace periods), EPP (RFC 5730–5734 XML codec + TCP/TLS server/client), RDAP/WHOIS, DNSSEC DS delegation, data escrow (RFC 8909), premium/reserved/sunrise/trademark-claims, transfers |
| `@jataqi/registrar` | **PRX Part B** — Registrar platform: search/register/renew/transfer/restore, bulk registration, portfolio, pricing engine, billing (via commerce), KYC identity, compliance engine (reserved/claims/abuse) |
| `@jataqi/game-engine` | **NOVA §3** — Universal ECS game-engine core: entity-component-system, deterministic fixed-timestep simulation loop, math (Vec3/Quaternion/Mat4), built-in systems (kinematics, lifetime, transform hierarchy) |
| `@jataqi/game-world` | **NOVA §5** — Procedural world generation: seeded PRNG, Perlin/value noise, fBm, heightmaps + biomes, settlements (villages/towns/cities), MST road networks |
| `@jataqi/game-physics` | **NOVA §7** — 3D rigid-body physics: sphere/AABB colliders, impulse collision resolution + positional correction, gravity, distance constraints, raycasting |
| `@jataqi/game-architect` | **NOVA §2/§19** — AI game creation: natural-language prompt → game design document + 5 AI dev agents (Director/World/Character/Programmer/Tester) + autonomous build pipeline |
| `@jataqi/game-ai` | **NOVA §6** — NPC intelligence: behavior trees, utility AI, finite state machines, GOAP planning, personality/emotion/relationship model, branching dialogue, ECS NpcSystem |
| `@jataqi/game-net` | **NOVA §9** — Multiplayer netcode: authoritative rooms, snapshot/delta replication, client prediction + reconciliation, matchmaking, anti-cheat |
| `@jataqi/game-economy` | **NOVA §10/§11** — Game economy: virtual currencies, player/creator/developer/marketplace wallets, immutable chained ledger, royalty-paying asset marketplace with licensing |
| `@jataqi/game-audio` | **NOVA §12** — Sound & music AI: procedural synthesis (oscillators/ADSR), generative multi-instrument music, SFX, 3D spatial mixing, adaptive intensity layers, real WAV encoding |
| `@jataqi/game-esports` | **NOVA §13** — Esports: Elo ratings + rank tiers, ranked leaderboards/seasons, single-elim + Swiss tournaments, replay recording/playback (tamper-evident), live spectator |
| `@jataqi/game-publish` | **NOVA §14** — Publishing: deterministic signed multi-platform build pipeline (per-store artifacts), store submission lifecycle, semver |
| `@jataqi/game-liveops` | **NOVA §15** — Live-ops: analytics (DAU/MAU, cohorts, D1/D7/D30 retention, funnels, ARPDAU/ARPPU/LTV), A/B experiments + feature flags, live events, offer targeting, remote config, seasons |
| `@jataqi/design-system` | **JATA Qi design language** — universal design tokens (color/typography/8px spacing/elevation/motion/radius), light+dark themes, WCAG AA color science, per-product brand overrides, adaptive theming, CSS generation |
| `@jataqi/icons` | **JATA Qi Icon Library** — geometric SVG icon engine with 7 variants (outline/filled/duotone/glass/rounded/sharp/animated), 29 categories (AI, security, cloud, payments, crypto, etc.), tree-shakeable, custom icon registration |
| `@jataqi/branding` | **JATA Qi Branding** — brand identity system for 15 products: programmatically generated logos (6 shapes × glyph), app icons, splash screens, marketing templates, business cards, email signatures, brand CSS |
| `@jataqi/dashboard` | **Adaptive Dashboard** — widget framework (15 built-in widgets), layout engine (drag-drop grid, auto-arrange, responsive breakpoints), AI personalization (role + behavior-driven widget suggestions), analytics |
| `@jataqi/web-ui` | **Admin Console SPA** (Phase 5 step 4) — vanilla-JS dashboard served at `/ui`: TANYA chat console, adaptive dashboard layouts, federated search, memory/learning/FX, PRX engine views (cloud/CDN/email/IPAM), tool-governance console, system views |
| `@jataqi/universal-wallet` | **Universal Wallet** — consolidates finance + commerce credits + game-economy into one double-entry ledger. Multi-currency (KES/USD/EUR/GBP/KRT/USDT/USDC/POINTS/GEMS/COINS), escrow, treasury, backward-compat adapters |
| `@jataqi/link-intelligence` | **Universal Link Intelligence** — classifies external content (repos, docs, APIs, papers, RFCs), extracts structured intelligence (architectures, patterns, APIs, security models), detects capability gaps vs the platform, generates governed proposals, drives validated self-evolution |
| `@jataqi/multimodal-intelligence` | **Universal Multimodal Intelligence** — pluggable acquisition framework for text, documents, images, audio, video, code, web, device telemetry, enterprise knowledge, and API sources. Normalizes into SemanticKnowledge with authorization gates, privacy classification, gap detection |
| `@jataqi/crypto` | **KRT Digital Asset Platform** — blockchain-agnostic token/NFT engine, HD wallet (Ed25519), custody (hot/warm/cold), staking (APR + lockup), exchange (AMM + manual rates), smart contract registry |
| `@jataqi/memory` | **Digital Memory Engine** — unified governed platform-event memory: normalization, tenant isolation, policy/consent/retention gating, content-hash versioning, keyword search, right-to-delete/export |
| `@jataqi/learning` | **Continuous Learning + Personalization** — analyzes the memory stream for insights (adoption, journeys, friction, errors, search failures, automation), generates governed recommendations, and derives per-user behavior adaptations (nav order, search boost, shortcuts) |
| `@jataqi/ai-learning` | **AI Learning Platform** — prompt registry (versioning + approval lifecycle + variable rendering), response quality tracking (acceptance/rating/latency/cost), drift detection (acceptance/rating/latency degradation alerts), model/provider benchmarking |
| `@jataqi/api-gateway` | Zero-dependency HTTP gateway: `/health`, `/auth/*`, `/qil`, `/objective`, `/simulate`, `/team`, `/models`, `/compute/*`, `/devices`, `/missions`, `/twins`, `/tools/*`, `/readiness`, `/metrics`, `/plugins`, `/audit`, `/stats`, rate limiting, OpenAPI |
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

Run the Alpha vertical slice (all seven success criteria):

```bash
node examples/vertical-slice.mjs

Run the SDK streaming demo (TANYA + QiL + unified chat over WebSocket):

```bash
node examples/sdk-streaming.mjs http://localhost:7400 admin admin
```
```

Serve the HTTP API gateway:

```bash
node packages/cli/dist/src/index.js serve              # default port 7400
node packages/cli/dist/src/index.js serve 8080         # explicit port
```

Then talk to it:

```bash
curl http://127.0.0.1:7400/health
# register, login, then submit an objective
curl -X POST http://127.0.0.1:7400/auth/register -H 'content-type: application/json' \
  -d '{"username":"ada","password":"pw","roles":["developer"]}'
TOKEN=$(curl -s -X POST http://127.0.0.1:7400/auth/login -H 'content-type: application/json' \
  -d '{"username":"ada","password":"pw"}' | jq -r .token)
curl -X POST http://127.0.0.1:7400/objective -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" -d '{"objective":"Analyze my business"}'
```

Other CLI commands:

```bash
node packages/cli/dist/src/index.js ask "what is JATA Qi?"
node packages/cli/dist/src/index.js ingest ./README.md
node packages/cli/dist/src/index.js search "vector search"
node packages/cli/dist/src/index.js find "vector search" --user alice   # unified search
node packages/cli/dist/src/index.js memory record "deployed v2" --category config_change
node packages/cli/dist/src/index.js learning analyze --org org1
node packages/cli/dist/src/index.js learning distill --org org1
node packages/cli/dist/src/index.js prompts list
node packages/cli/dist/src/index.js experiments list
node packages/cli/dist/src/index.js wallet open alice creator
node packages/cli/dist/src/index.js crypto summary
node packages/cli/dist/src/index.js dashboard layouts
node packages/cli/dist/src/index.js brands list
node packages/cli/dist/src/index.js automation create "nightly digest" --trigger schedule --interval 3600000
node packages/cli/dist/src/index.js automation list
node packages/cli/dist/src/index.js automation run <id>
node packages/cli/dist/src/index.js fx set USD KES 128.5 --ask 129.0
node packages/cli/dist/src/index.js fx convert USD KES 10000
node packages/cli/dist/src/index.js pki root "JATA Qi Root"
node packages/cli/dist/src/index.js pki issue <caId> api.example.com --san api.example.com
node packages/cli/dist/src/index.js pki client "my app" https://app.example.com/cb
node packages/cli/dist/src/index.js pki acme new-account
node packages/cli/dist/src/index.js pki acme new-order <kid> example.com
node packages/cli/dist/src/index.js pki acme proof <kid> <challengeId> http://example.com/.well-known/acme-challenge/<token> <keyAuthorization>
node packages/cli/dist/src/index.js pki acme finalize <kid> <orderId> request.csr.der
node packages/cli/dist/src/index.js pki acme cert <orderId> --out cert.der
node packages/cli/dist/src/index.js mobility register KDD 123B Toyota Corolla --lat -1.2921 --lng 36.8219
node packages/cli/dist/src/index.js mobility trip -1.2921 36.8219 -1.2864 36.8172
node packages/cli/dist/src/index.js logistics port Mombasa MBA KE
node packages/cli/dist/src/index.js logistics shipment Shanghai Mombasa "Exporter Ltd" "Importer Co" --mode sea
node packages/cli/dist/src/index.js logistics track JQ-XXXXXX delivered "ICD Embakasi"
node packages/cli/dist/src/index.js farm farm "Green Acres" u1 --area 25
node packages/cli/dist/src/index.js farm plant <fieldId> maize --yield 3000
node packages/cli/dist/src/index.js farm harvest <cycleId> 3400
node packages/cli/dist/src/index.js circular stream "PET Bottles" --type plastic --co2e 1.5
node packages/cli/dist/src/index.js circular collect <streamId> 200 Nairobi
node packages/cli/dist/src/index.js circular score p1 --scope product
node packages/cli/dist/src/index.js energy asset "Roof Array" solar 12.5
node packages/cli/dist/src/index.js energy meter Office --customer c1
node packages/cli/dist/src/index.js energy reading <meterId> 800
node packages/cli/dist/src/index.js border post Busia KE-UG
node packages/cli/dist/src/index.js border crossing <postId> "Alice" P7654321 --mode road
node packages/cli/dist/src/index.js kitchen venue "Nyumbani Grill" u1 --cuisine Swahili
node packages/cli/dist/src/index.js kitchen item <venueId> "Grilled Fish" 1200 --category main
node packages/cli/dist/src/index.js kitchen order <venueId> --items <itemId>x2 --table T1
node packages/cli/dist/src/index.js maza storefront v1 "Karibu Crafts" --categories crafts
node packages/cli/dist/src/index.js maza listing <storefrontId> "Handwoven Basket" crafts 1500 --stock 5
node packages/cli/dist/src/index.js maza purchase <listingId> buyer-1
node packages/cli/dist/src/index.js cloud region Nairobi NBO KE nbo-1,nbo-2 --capacity 100
node packages/cli/dist/src/index.js cloud instance web-1 <regionId> <flavorId> <imageId>
node packages/cli/dist/src/index.js cloud hosting <planId> <regionId> acme.com <imageId>
node packages/cli/dist/src/index.js cloud autoscale <groupId> 0.9
node packages/cli/dist/src/index.js cdn zone cdn.example.com https://origin.example.com
node packages/cli/dist/src/index.js cdn cache <zoneId> /img/logo.png 5000 image/png
node packages/cli/dist/src/index.js mail domain acme.co.ke --dmarc quarantine
node packages/cli/dist/src/index.js mail send alice@acme.co.ke bob@partner.io "Hello"
node packages/cli/dist/src/index.js ipam block 196.201.0.0/16 AFRINIC --purpose anycast
node packages/cli/dist/src/index.js ipam asn 327780 AFRINIC --anycast
node packages/cli/dist/src/index.js ipam announce <blockId> <asnId>
node packages/cli/dist/src/index.js tanya chat "Hello TANYA"
node packages/cli/dist/src/index.js tanya persona support --prompt "You are a support specialist"
node packages/cli/dist/src/index.js tanya conversations
node packages/cli/dist/src/index.js tanya stats
node packages/cli/dist/src/index.js tools sync
node packages/cli/dist/src/index.js tools list
node packages/cli/dist/src/index.js tools approvals
node packages/cli/dist/src/index.js tools stats
node packages/cli/dist/src/index.js stats
node packages/cli/dist/src/index.js repl
```

## QiL — the Quantum Intelligence Language

QiL is the declarative orchestration language of JATA Qi (spec Step 2). It
expresses *objectives* and *workflows* rather than imperative steps. A QiL
program is parsed into an AST, validated, and **compiled into an execution plan**
(a dependency graph of steps) that the orchestrator interprets.

```qil
MISSION "Analyze quarterly revenue"
GOAL "Identify revenue risks"
AGENT research
MODEL gpt-4

RETRIEVE knowledge "revenue Q3"     # pull relevant context
REASON  "Summarize the findings"    # agent reasoning over the context
ANALYZE "Highlight risks"
REPORT                              # assemble the structured response
```

Native statements (spec Step 2): `MISSION`, `GOAL`, `AGENT`, `TEAM`, `MODEL`,
`DATASET`, `OBSERVE`, `RETRIEVE`, `LEARN`, `REASON`, `PLAN`, `SIMULATE`,
`SYNTHESIZE`, `ANALYZE`, `VERIFY`, `OPTIMIZE`, `EXECUTE`, `REPORT`, `AUDIT`,
`DEPLOY`, `STOP`. A trailing `-> agent` routes a step to a named agent;
`after: "step-1"` adds an explicit dependency edge.

```ts
import { compileSource } from '@jataqi/qil';

const { ok, plan, diagnostics } = compileSource('MISSION "x" { RETRIEVE "a" REPORT }');
if (ok) console.log(plan.steps);   // [{ id: 'step-1', kind: 'retrieve', ... }, ...]
```

### Language tooling

QiL ships a formatter and a semantic linter alongside the compiler:

```ts
import { format, lintSource } from '@jataqi/qil';

format('MISSION "x"{RETRIEVE "a" REPORT}');
// MISSION "x" {
//   RETRIEVE "a"
//   REPORT
// }

lintSource('AGENT a1\nAGENT a1\nREPORT -> a1');
// [ { severity: 'warning', message: 'duplicate agent declaration "a1" ...' } ]
```

The formatter is idempotent (`format(format(src)) === format(src)`); the linter
flags duplicate declarations, unused agents, dangling `after:` references,
unreachable steps after `STOP`, and empty missions. The grammar also accepts
comma-separated `after: "step-1", "step-2"` lists and trailing `-> agent`
routing after properties.

Run the toolchain from the CLI:

```bash
node packages/cli/dist/src/index.js qil format examples/objective.qil
node packages/cli/dist/src/index.js qil lint examples/objective.qil
node packages/cli/dist/src/index.js qil compile examples/objective.qil
node packages/cli/dist/src/index.js qil run examples/objective.qil   # executes with audit
```

## The Alpha vertical slice

The orchestrator turns a QiL plan into an audited workflow result:

```ts
const orch = qi.kernel.getModule('orchestrator');
const result = await orch.runObjective('Analyze revenue', { principal });
// result.status        -> 'completed'
// result.steps[]       -> per-step outputs (retrieve / reason / report)
// result.retrieved[]   -> knowledge snippets
// result.finalReport   -> structured response
// result.auditRecordId -> immutable audit record
```

### HTTP API (gateway)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | – | Liveness + booted modules |
| POST | `/auth/register` | – | Create a user `{username,password,roles?}` |
| GET | `/auth/session` | any authenticated | Session introspection (expiresAt/remainingMs) for expiry-aware clients |
| POST | `/auth/login` | – | `{username,password}` → bearer token |
| POST | `/auth/apikey` | bearer | Issue an API key |
| POST | `/auth/logout` | bearer | Invalidate the session |
| POST | `/qil` | `qil:run` | `{program}` → compiled + executed workflow |
| POST | `/objective` | `qil:run` | `{objective}` → workflow from free text |
| GET | `/workflows` | `qil:run` | Recent workflow runs (durable history) |
| GET | `/workflow?id=` | `qil:run` | Fetch a specific run by id |
| POST | `/ask` | `agent:run` | `{message}` → agent passthrough |
| GET | `/audit` | `audit:read` | Query the audit ledger |
| GET | `/stats` | `knowledge:read` | Knowledge + graph stats |
| GET | `/whoami` | bearer | Resolved principal |
| GET | `/metrics` | `metrics:read` | Prometheus exposition (counters/gauges/histograms) |
| POST | `/simulate` | `qil:run` | `{inputs, formula, trials, targets?}` Monte-Carlo result |
| POST | `/team` | `qil:run` | `{objective, members, mode?}` coordinated team result |
| GET | `/plugins` | `plugin:read` | List installed plugins |
| POST | `/plugins` | `plugin:manage` | `{id, action}` enable/disable a plugin |
| GET | `/models` | `model:read` | List registered models |
| POST | `/models/select` | `model:read` | `{capabilities, prefer}` select best model |
| GET | `/scheduler/stats` | `metrics:read` | Compute scheduler queue stats |
| POST | `/memory` | `memory:write` | Record a governed memory event |
| GET | `/memory` | `memory:read` | Query the memory event stream |
| GET | `/memory/export` · `POST /memory/delete` | `memory:read` / `memory:write` | Right-to-export / right-to-delete |
| POST | `/memory/policy` · `/memory/sweep` | `memory:write` | Org memory policy · retention sweep |
| POST | `/learning/analyze` | `learning:read` | Derive insights + recommendations from memory |
| GET | `/learning/insights` · `/learning/recommendations` · `/learning/adaptation` | `learning:read` | Learning + personalization reads |
| POST | `/learning/recommendation/review` · `/deploy` · `/learning/preference` | `learning:write` | Review/deploy recommendations, set preferences |
| GET | `/ai-learning/prompts` · `/metrics` · `/benchmarks` | `learning:read` | Prompt registry + quality reads |
| POST | `/ai-learning/prompts` · `/version` · `/approve` · `/activate` · `/outcomes` | `learning:write` | Prompt lifecycle + outcome tracking |
| POST | `/ai-learning/drift` | `learning:read` | Run drift detection |
| GET | `/design-system/tokens` · `/css` | `design:read` | Design tokens + generated stylesheet |
| POST | `/design-system/mode` · `/adaptive` | `design:write` | Theme mode + adaptive theming |
| GET | `/branding/products` · `/brand` | `design:read` | Brand kits for the 15 products |
| POST | `/branding/logo` · `/app-icon` · `/splash` · `/marketing` · `/business-card` | `design:write` | Brand asset generation |
| POST | `/wallet/open` · `/deposit` · `/withdraw` · `/transfer` · `/status` | `finance:write` | Wallet operations (double-entry) |
| GET | `/wallet` · `/balance` · `/ledger` · `/summary` · `/currencies` | `finance:read` | Wallet reads + ledger verification |
| POST | `/crypto/assets` · `/mint` · `/burn` · `/transfer` · `/nft/*` · `/stake` · `/swap` · `/custody` · `/contracts` | `finance:write` | KRT token/NFT/staking/exchange operations |
| GET | `/crypto/assets` · `/balance` · `/summary` | `finance:read` | KRT reads |
| POST | `/dashboard/layouts` · `/widgets` · `/adapt` · `/auto-arrange` | `dashboard:write` | Dashboard layout + widget management |
| GET | `/dashboard/layouts` · `/widgets` · `/analytics` | `dashboard:read` | Dashboard reads |
| POST | `/link/process` · `/process-batch` · `/proposals/validate` · `/evolve` | `knowledge:write` | Link intelligence pipeline |
| GET | `/link/results` · `/link/summary` | `knowledge:read` | Link intelligence reads |
| POST | `/multimodal/sources` · `/sources/authorize` · `/sources/revoke` · `/acquire` · `/acquire-batch` | `knowledge:write` | Multimodal acquisition |
| GET | `/multimodal/sources` | `knowledge:read` | Registered acquisition sources |
| POST | `/ai-learning/experiments` · `/experiments/evaluate` · `/experiments/conclude` · `/experiments/cancel` · `/ai-learning/serve` | `learning:write` / `learning:read` | CLP Phase 4 — eval-gated prompt experiments |
| GET | `/ai-learning/experiments` | `learning:read` | List experiments (optionally by status) |
| POST | `/learning/distill` | `learning:write` | CLP Phase 5 — distill insights + recommendations into knowledge |
| GET | `/learning/lessons` · `/learning/playbooks` · `/learning/distill-stats` | `learning:read` | Distilled knowledge reads |
| GET | `/search` | `search:read` | Phase 6 — unified search (`q`, `sources`, `topK`, `minScore`, `userId`, `orgId`) |
| GET | `/search/suggest` · `/search/history` · `/search/stats` | `search:read` | Suggestions, search history, stats |
| POST | `/search/history` | `search:read` | Record a search into memory history |
| GET | `/automations` · `/automation?id=` · `/automations/executions` · `/automations/stats` | `automation:read` | SOMA AI automation reads |
| POST | `/automations` · `/automations/run` · `/automations/status` · `/automations/remove` | `automation:write` | SOMA AI automation management + manual runs |
| POST | `/fx/rates` · `/fx/convert` | `finance:write` / `finance:read` | KARIS FX rates + conversion |
| GET | `/fx/rates` · `/fx/rate` · `/fx/history` · `/fx/analytics` · `/fx/currencies` · `/fx/stats` | `finance:read` | KARIS FX reads |
| GET | `/pki/status` · `/pki/cas` · `/pki/certificates` · `/pki/crl` · `/pki/idp/discovery` | `pki:read` | PKI reads |
| POST | `/pki/ca/root` · `/pki/ca/intermediate` · `/pki/certificates` · `/pki/certificates/revoke` · `/pki/ra/*` · `/pki/idp/clients` · `/pki/idp/authorize` | `pki:write` / `pki:read` | PKI operations |
| POST | `/pki/idp/token` · `/pki/idp/introspect` | – | OIDC token + introspection endpoints |
| GET | `/pki/acme/directory` · `/pki/acme/new-nonce` · `/pki/acme/order` · `/pki/acme/authz` · `/pki/acme/challenge` · `/pki/acme/challenge/key-auth` · `/pki/acme/certificate` | `pki:read` | ACME reads |
| POST | `/pki/acme/new-account` · `/pki/acme/new-order` · `/pki/acme/challenge/validate` · `/pki/acme/challenge/proof` · `/pki/acme/finalize` · `/pki/acme/revoke` | `pki:write` | ACME operations (JWS-signed) |
| POST | `/mobility/vehicles` · `/mobility/fleets` · `/mobility/drivers` · `/mobility/trips` · `/mobility/telemetry` · `/mobility/geofences` | `mobility:write` | MOTO X operations |
| GET | `/mobility/vehicles` · `/mobility/fleets` · `/mobility/drivers` · `/mobility/trips` · `/mobility/telemetry` · `/mobility/geofences` · `/mobility/stats` | `mobility:read` | MOTO X reads |
| POST | `/logistics/ports` · `/logistics/vessels` · `/logistics/containers` · `/logistics/shipments` · `/logistics/shipments/track` · `/logistics/warehouses` | `logistics:write` | PORTLINK operations |
| GET | `/logistics/ports` · `/logistics/vessels` · `/logistics/containers` · `/logistics/shipments` · `/logistics/shipment` · `/logistics/shipments/timeline` · `/logistics/warehouses` · `/logistics/stats` | `logistics:read` | PORTLINK reads |
| POST | `/pki/idp/login` | – | IdP access token → platform session bridge (JIT provisioning) |
| POST | `/agriculture/farms` · `/agriculture/fields` · `/agriculture/crops` · `/agriculture/harvests` · `/agriculture/herds` | `agriculture:write` | KARIS FARM operations |
| GET | `/agriculture/farms` · `/agriculture/fields` · `/agriculture/crops` · `/agriculture/harvests` · `/agriculture/herds` · `/agriculture/stats` | `agriculture:read` | KARIS FARM reads |
| POST | `/circular/streams` · `/circular/collections` · `/circular/collections/status` · `/circular/takeback` · `/circular/takeback/status` | `circular:write` | KARIS LOOP operations |
| GET | `/circular/streams` · `/circular/collections` · `/circular/takeback` · `/circular/score` · `/circular/stats` | `circular:read` | KARIS LOOP reads |
| POST | `/energy/assets` · `/energy/meters` · `/energy/readings` · `/energy/tariffs` · `/energy/bills` | `energy:write` | KARIS ENERGY operations |
| GET | `/energy/assets` · `/energy/meters` · `/energy/readings` · `/energy/tariffs` · `/energy/bills` · `/energy/stats` | `energy:read` | KARIS ENERGY reads |
| POST | `/border/posts` · `/border/watchlist` · `/border/crossings` · `/border/manifests` | `border:write` | KARIS BORDER X operations |
| GET | `/border/posts` · `/border/watchlist` · `/border/crossings` · `/border/manifests` · `/border/stats` | `border:read` | KARIS BORDER X reads |
| POST | `/restaurants/venues` · `/restaurants/menu` · `/restaurants/tables` · `/restaurants/orders` · `/restaurants/ingredients` | `restaurants:write` | NYUMBANI KITCHEN operations |
| GET | `/restaurants/venues` · `/restaurants/menu` · `/restaurants/tables` · `/restaurants/orders` · `/restaurants/ingredients` · `/restaurants/stats` | `restaurants:read` | NYUMBANI KITCHEN reads |
| POST | `/marketplace/storefronts` · `/marketplace/listings` · `/marketplace/reviews` · `/marketplace/purchases` | `marketplace:write` | MAZA operations |
| GET | `/marketplace/storefronts` · `/marketplace/listings` · `/marketplace/reviews` · `/marketplace/categories` · `/marketplace/stats` | `marketplace:read` | MAZA reads |
| POST | `/cloud/regions` · `/cloud/flavors` · `/cloud/images` · `/cloud/instances` · `/cloud/volumes` · `/cloud/vpcs` · `/cloud/firewall` · `/cloud/load-balancers` · `/cloud/hosting-plans` · `/cloud/hosting` · `/cloud/autoscaling` | `cloud:write` | Cloud operations |
| GET | `/cloud/regions` · `/cloud/flavors` · `/cloud/images` · `/cloud/instances` · `/cloud/volumes` · `/cloud/snapshots` · `/cloud/vpcs` · `/cloud/firewall` · `/cloud/load-balancers` · `/cloud/hosting-plans` · `/cloud/autoscaling` · `/cloud/stats` | `cloud:read` | Cloud reads |
| POST | `/cdn/nodes` · `/cdn/zones` · `/cdn/assets` · `/cdn/purge` | `cdn:write` | CDN operations |
| GET | `/cdn/nodes` · `/cdn/zones` · `/cdn/zone` · `/cdn/assets` · `/cdn/lookup` · `/cdn/stats` | `cdn:read` | CDN reads |
| POST | `/email/domains` · `/email/domains/verify` · `/email/mailboxes` · `/email/send` · `/email/receive` | `email:write` | Email operations |
| GET | `/email/domains` · `/email/domains/dns` · `/email/mailboxes` · `/email/messages` · `/email/inbox` · `/email/stats` | `email:read` | Email reads |
| POST | `/ipam/blocks` · `/ipam/blocks/split` · `/ipam/addresses` · `/ipam/asns` · `/ipam/announce` | `ipam:write` | IPAM operations |
| GET | `/ipam/blocks` · `/ipam/blocks/addresses` · `/ipam/addresses` · `/ipam/asns` · `/ipam/announcements` · `/ipam/stats` | `ipam:read` | IPAM reads |
| POST | `/tanya/chat` · `/tanya/conversation/delete` · `/tanya/persona` | `tanya:write` | TANYA chat + conversation/persona management |
| GET | `/tanya/conversations` · `/tanya/conversation` · `/tanya/personas` · `/tanya/stats` · POST `/tanya/identify` | `tanya:read` | TANYA reads + identity |
| GET | `/tools` · `/tools/capability` · `/tool` · `/approvals` | `tool:read`/`approval:decide` | Tool registry + pending approvals |
| POST | `/tools` · `/tools/sync` | `tool:read` | Register tools / sync the agent surface into governance |
| GET | `/tools/governance-stats` | `tool:read` | Aggregate governance posture (registry, approvals, invocations, decisions) |
| POST | `/tool/invoke` · `/tool/request-approval` · `/tool/approve` | `tool:invoke`/`approval:decide` | Governed invocation + approval flow |

### Security model

Passwords are hashed with scrypt; sessions are opaque bearer tokens; API keys are
hash-stored. Authorization is RBAC over permission strings with `*` and
`<segment>:*` wildcards.

| Role | Permissions |
|---|---|
| `admin` | `*` |
| `developer` | `health:read`, `qil:run`, `knowledge:*`, `agent:run`, `audit:read` |
| `analyst` | `health:read`, `qil:run`, `knowledge:read`, `agent:run`, `audit:read` |
| `guest` | `health:read` |

Every security-relevant action (login, denial, workflow run) is appended to the
**immutable audit ledger**, which is persisted via the storage layer.

## Configuring for production

Copy `.env.example` to `.env` and set:

- `STORAGE_DRIVER=filesystem` (persists to `STORAGE_FS_ROOT`)
- `VECTOR_MODEL=openai` with `OPENAI_API_KEY` and `OPENAI_EMBEDDING_MODEL`
- `AGENT_LLM=openai` with `OPENAI_CHAT_MODEL` (e.g. `gpt-4o-mini`)
- `JATAQI_ADMIN_USERNAME` / `JATAQI_ADMIN_PASSWORD` to seed a bootstrap admin
- `JATAQI_GATEWAY_PORT` / `JATAQI_GATEWAY_HOST` for `jataqi serve`
- `LOG_LEVEL=info` (or `debug` for development)

The CLI auto-loads `.env`; library users call `createJataQiFromEnv()`.

## Extending JATA Qi

Modules implement the `IModule` interface (`init`, `start`, `stop`, `dependsOn`)
and register themselves with the kernel:

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

The full suite (1790+ unit + integration tests across all packages):

```bash
npm test
```

Each package can be built/tested independently:

```bash
npm run build --workspace=@jataqi/qil
npm test --workspace=@jataqi/orchestrator
```

End-to-end demos:

```bash
node examples/demo.mjs              # knowledge + graph + agent
node examples/vertical-slice.mjs    # the seven Alpha success criteria
```

## Repository status

- ✅ Core Kernel (event bus, DI, lifecycle, config, logging)
- ✅ Storage Layer (memory + filesystem, KV/collections/blobs, pagination)
- ✅ Vector Search (hash + OpenAI embeddings, cosine/euclidean/dot, persistence)
- ✅ Knowledge Service (ingestion, chunking, retrieval, metadata filters, context expansion)
- ✅ Knowledge Graph (entities, triples, traversal, heuristic extraction, graph-RAG)
- ✅ Agent Runtime (tools, ReAct loop, Echo/Scripted/OpenAI LLMs, built-in tools, session memory)
- ✅ **Agent Intelligence Tools** (32 tools over the Phase 6/7 + PRX engines — `fx.*`, `mobility.*`, `logistics.*`, `agriculture.*`, `circular.*`, `energy.*`, `border.*`, `restaurants.*`, `marketplace.*`, `platform.search`, `wallet.balance`, `crypto.balance`, `cloud.*`, `cdn.*`, `email.*`, `ipam.*`; 37 default agent tools total; graceful degradation on partial kernels)
- ✅ **Agent Tool Governance** (tool directive #18 — 39-tool catalog with R0–R4 risk classes + privacy classes; `POST /tools/sync` registers the live agent surface into the governed registry; R4 financial/infrastructure tools — `mobility.dispatch`, `cloud.provision`, `cloud.autoscale` — require human approval; unknown tools default conservatively to R3/INTERNAL; CLI `tools sync|list|stats|invoke|approvals|approve`)
- ✅ **Tool Governance Observability** (Prometheus: `jataqi_tool_invocations_total{risk,status}`, `jataqi_tool_invocation_duration_ms`, `jataqi_tool_governance_decisions_total{decision}`, `jataqi_tool_approval_requests_total{decision}`, `jataqi_tool_pending_approvals`; aggregate `GET /tools/governance-stats`, CLI `tools stats`, web UI governance stat cards)
- ✅ **QiL Language** (lexer, parser, AST, validator, execution-plan compiler)
- ✅ **QiL Live Execution** (WebSocket `qil.run` → `qil.step`… → `qil.done` — plan steps stream as they complete, objectives compile to retrieve→reason→report, AI-safety gate, `qil.error`; web UI QiL console)
- ✅ **QiL Tooling** (idempotent formatter, semantic linter, CLI `qil parse|compile|format|lint|run` with auto-provisioned agents)
- ✅ **Orchestrator / Workflow Engine** (QiL plan execution, retrieval+reasoning+reporting, audit, durable history)
- ✅ **Teams** (multi-agent coordination: parallel fan-out, sequential, consensus)
- ✅ **Simulation** (Monte-Carlo scenarios, distributions, percentiles, target probabilities)
- ✅ **Security** (identity, scrypt auth, RBAC, API keys, immutable audit ledger)
- ✅ **Metrics** (counters/gauges/histograms, registry, Prometheus exposition)
- ✅ **Plugins** (capability/permission/dependency validation, auto-registration)
- ✅ **Model Registry** (catalog + cost/latency/quality model selection)
- ✅ **Compute Scheduler** (priority task queue, targets, capacity, dependencies)
- ✅ **HTTP API Gateway** (`/`, `/openapi.json`, `/health`, `/auth/*`, `/qil`, `/objective`, `/workflows`, `/simulate`, `/team`, `/models`, `/metrics`, `/plugins`, `/scheduler/stats`, `/ask`, `/audit`, `/stats`; bearer auth, RBAC, rate limiting)
- ✅ **Digital Memory Engine** (CLP Phase 1 — governed platform-event memory, consent/retention policies, right-to-delete/export)
- ✅ **Continuous Learning + Personalization** (CLP Phase 2/6 — insights, recommendations, per-user adaptation)
- ✅ **AI Learning Platform** (CLP Phase 3 — prompt registry lifecycle, response quality tracking, drift detection, model benchmarks)
- ✅ **Prompt Experiments** (CLP Phase 4 — eval-gated champion/challenger experiments: traffic-split serving, evidence-based promotion, latency regression guard)
- ✅ **Knowledge Distillation** (CLP Phase 5 — high-confidence insights + deployed recommendations become knowledge documents, graph lesson entities + triples, and operational playbooks)
- ✅ **Self-Evolution** (CLP Phase 7 — governed proposals, experiments, rollback; consumes memory + learning + drift)
- ✅ **Universal Search & Discovery** (Phase 6 — federated search across knowledge, memory, graph, conversations, and tools with recency decay, learned personalization boosts, facets, suggestions, and search history)
- ✅ **SOMA AI — Intelligent Automation Engine** (Phase 6 — scheduled / bus-event / manual automations with chained platform actions, concurrency caps, timeouts, execution history, stats)
- ✅ **Self-Evolution × CLP 4/5** (Phase 7 extension — evolution proposals from concluded prompt experiments; distillation progress observations)
- ✅ **PKI — PRX Part C** (X.509 CA root/intermediate hierarchy verified by OpenSSL, RFC 5280 DER certificates, revocation + CRLs, Registration Authority with dns-txt/http-01/email validation, OIDC-lite Identity Provider with JWT ID tokens + JWKS)
- ✅ **ACME — RFC 8555 automated issuance** (PRX Part C — replay nonces, JWS-signed accounts via RFC 7638 thumbprints, orders/authorizations/challenges with http-01/dns-01/tls-alpn-01, keyAuthorization proofs, PKCS#10 CSR finalization cross-validated with OpenSSL, certificate fetch + revocation)
- ✅ **Cloud Infrastructure Provider** (PRX Part E — multi-region capacity, compute lifecycle, volumes + snapshots, VPCs + firewalls, load balancers, hosting plans, autoscaling)
- ✅ **CDN Provider** (PRX — edge nodes, zones with origins + TTLs, origin shield, purge, hit-rate analytics)
- ✅ **Email Provider** (PRX — MX/SPF/DKIM/DMARC domains, verified sending, mailboxes, inbound DMARC disposition)
- ✅ **RIR Member — IPAM** (PRX — IPv4/IPv6 allocations from all five RIRs, ASN holdings, CIDR subnetting, anycast announcements, utilization analytics)
- ✅ **TANYA AI — Conversational Product Layer** (Phase 6 — personas materialized as agents with dedicated system prompts, persistent chat with tool-call history + conversation context, PKI IdP identity bridge, per-user stats; gateway `/tanya/*`, CLI `tanya`; WebSocket streaming: `tanya.chat` → `tanya.chunk`… → `tanya.done` over `/ws` with AI-safety gate + `tanya.chat.completed` bus events)
- ✅ **KARIS FX — Foreign Exchange Intelligence** (Phase 6 — cross rates via anchor, bid/ask spreads, integer-exact conversions with margin, trend/volatility analytics, memory-integrated)
- ✅ **MOTO X — Mobility Intelligence** (Phase 7 — vehicle/fleet/driver registry, nearest-vehicle dispatch, trip lifecycle + fares, telemetry, geofences)
- ✅ **PORTLINK — Logistics & Port Intelligence** (Phase 7 — ports/vessels/containers, tracking-event shipment timelines, warehouses, freight analytics)
- ✅ **IdP ↔ Security session bridge** (directive — OIDC authorization-code login mints platform sessions with RBAC + audit; JIT account provisioning)
- ✅ **KARIS FARM — Agricultural Intelligence** (Phase 7 — crop cycles, harvests + yield analytics, livestock)
- ✅ **KARIS LOOP — Circular Economy Platform** (Phase 7 — collection lifecycle, take-back, circularity scores, CO2e savings)
- ✅ **KARIS ENERGY — Energy Intelligence** (Phase 7 — solar/wind/grid assets, meters, consumption analytics, tariff billing)
- ✅ **KARIS BORDER X — Border Security Intelligence** (Phase 7 — watchlist screening, crossing clearances, cargo risk flagging)
- ✅ **NYUMBANI KITCHEN — Restaurant Intelligence** (Phase 7 — menus, table management, order flow, ingredient reorder alerts, revenue analytics)
- ✅ **MAZA — Marketplace Intelligence** (Phase 7 — vendor storefronts, listings with inventory, reviews & ratings, search, analytics; purchases via the commerce layer)
- ✅ **Design System** (universal design language — tokens, WCAG AA color science, adaptive theming, CSS generation)
- ✅ **Branding** (brand identity for the 15 JATA Qi products — logos, app icons, splash screens, marketing, business cards)
- ✅ **Icons** (premium geometric SVG icon library — 7 variants, 29 categories)
- ✅ **Adaptive Dashboard** (Phase 5 step 3 — widget framework, responsive layout engine, AI personalization; 19 built-in widgets incl. tool-governance widgets — governed tools / invocations / decisions KPIs + pending-approvals list, live governance panel in the web UI)
- ✅ **Admin Console Web UI** (Phase 5 step 4 — `/ui` SPA served by the gateway: TANYA chat with personas + conversation history streaming over `/ws` (word-by-word chunks, HTTP fallback), QiL console streaming plan steps live, adaptive dashboard layouts (create/AI-adapt/auto-arrange), federated search console, memory/learning/FX views, PRX engine views (cloud/CDN/email/IPAM), tool-governance console (sync + approvals), **live activity feed** (subscribes to platform bus topics — security/memory/tool/tanya/orchestrator — with sidebar feed + toast notifications), system health/readiness/identity views)
- ✅ **SDK WebSocket Streaming Client** (`StreamingClient` — typed `tanyaChat` / `qilRun` / `qilObjective` / `chat` over `/ws` with chunk/step handlers, `subscribe(topics)` for platform bus events, bearer-token auth, reconnect with backoff, handshake watchdog; `examples/sdk-streaming.mjs`)
- ✅ **Auth polish** (`GET /auth/session` expiry introspection; web UI register-first flow (Sign In / Create Account), session validation on restore, live countdown + auto-logout on expiry, global 401 handling; SDK `auth.session()`)
- ✅ **Universal Wallet** (Phase 2 — double-entry ledger consolidating finance/commerce/game-economy wallets; escrow, treasury, multi-currency)
- ✅ **Payments** (Phase 3 — M-Pesa, Flutterwave, Pesapal, Airtel Money, PayPal, Stripe adapters)
- ✅ **Crypto / KRT** (Phase 4 — tokens + NFTs, HD wallets, custody, staking, exchange, smart-contract registry)
- ✅ **Link Intelligence** (classify → extract → gap analysis → governed self-evolution proposals)
- ✅ **Multimodal Intelligence** (acquisition framework for text/document/image/audio/video/code/web/device/API sources)
- ✅ **CLI + Bootstrap** (`.env` support, `ask`/`ingest`/`stats`/`search`/`entities`/`repl`/`serve`)
- ✅ **Alpha vertical slice** (authenticate → QiL workflow → agents → knowledge → response → audit)
- ✅ **Intelligence gateway routes** (`/memory`, `/learning/*`, `/ai-learning/*`, `/design-system/*`, `/branding/*`, `/wallet/*`, `/crypto/*`, `/dashboard/*`, `/link/*`, `/multimodal/*`; bearer auth, RBAC, rate limiting)

## License

MIT
