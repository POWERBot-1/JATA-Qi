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

The full suite (200+ unit + integration tests across all packages):

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
- ✅ **QiL Language** (lexer, parser, AST, validator, execution-plan compiler)
- ✅ **Orchestrator / Workflow Engine** (QiL plan execution, retrieval+reasoning+reporting, audit, durable history)
- ✅ **Teams** (multi-agent coordination: parallel fan-out, sequential, consensus)
- ✅ **Simulation** (Monte-Carlo scenarios, distributions, percentiles, target probabilities)
- ✅ **Security** (identity, scrypt auth, RBAC, API keys, immutable audit ledger)
- ✅ **Metrics** (counters/gauges/histograms, registry, Prometheus exposition)
- ✅ **Plugins** (capability/permission/dependency validation, auto-registration)
- ✅ **Model Registry** (catalog + cost/latency/quality model selection)
- ✅ **Compute Scheduler** (priority task queue, targets, capacity, dependencies)
- ✅ **HTTP API Gateway** (`/`, `/openapi.json`, `/health`, `/auth/*`, `/qil`, `/objective`, `/workflows`, `/simulate`, `/team`, `/models`, `/metrics`, `/plugins`, `/scheduler/stats`, `/ask`, `/audit`, `/stats`; bearer auth, RBAC, rate limiting)
- ✅ **CLI + Bootstrap** (`.env` support, `ask`/`ingest`/`stats`/`search`/`entities`/`repl`/`serve`)
- ✅ **Alpha vertical slice** (authenticate → QiL workflow → agents → knowledge → response → audit)

## License

MIT
