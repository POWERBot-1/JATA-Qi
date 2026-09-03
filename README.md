# JATA Qi — Modular AI Operating System

JATA Qi is a modular AI operating-system foundation built on a plugin-style
kernel. It coordinates storage, vector search, knowledge services, knowledge
graphs, governed commercial capabilities, and an agent runtime behind a unified
event-driven API you can embed in any Node.js application or run from the CLI.
Individual capabilities carry explicit verification and external-access status;
this repository does not claim a live production deployment by default.

> **Storage status:** `STORAGE_DRIVER=filesystem` is a development-only,
> single-process local mode. It is not transactional, multi-process,
> multi-host, or authoritative production storage. See
> [`docs/PERSISTENCE_ARCHITECTURE.md`](docs/PERSISTENCE_ARCHITECTURE.md).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Applications / CLI                     │
├─────────────────────────────────────────────────────────────┤
│  Agent Runtime  │  Tools  │  Sessions / Memory  │  REPL      │
├─────────────────────────────────────────────────────────────┤
│ Commercial Control Plane │ Action Runtime │ Connector Fabric │
├─────────────────────────────────────────────────────────────┤
│  Knowledge Service     │  Knowledge Graph  (Graph-RAG)       │
├─────────────────────────────────────────────────────────────┤
│  Vector Search  (embeddings + brute-force flat index)       │
├─────────────────────────────────────────────────────────────┤
│  Storage Layer  (Memory / dev-only single-process FS, KV+Docs+Blobs) │
├─────────────────────────────────────────────────────────────┤
│                        Core Kernel                          │
│   Event Bus  ·  DI Container  ·  Lifecycle  ·  Config/Log   │
└─────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---|---|
| `@jataqi/core-kernel` | Event bus, DI container, topological module lifecycle, config, structured logging |
| `@jataqi/storage` | Pluggable KV / document collection / blob storage with in-memory and **development-only single-process** filesystem drivers |
| `@jataqi/vector-search` | Embedding models (hash, OpenAI), brute-force flat vector index with cosine/euclidean/dot, development snapshot persistence |
| `@jataqi/knowledge-service` | Document/chunk model, paragraph+sentence+fixed chunker, semantic retrieval with context expansion and development filesystem index restoration |
| `@jataqi/knowledge-graph` | Entities, relations, SPO triple store, BFS traversal, heuristic extractor, Graph-RAG fusion |
| `@jataqi/agent-runtime` | Tool system, ReAct agent loop, Echo/Scripted/OpenAI LLMs, built-in knowledge+graph tools, session memory |
| `@jataqi/commercial-control-plane` | Default-deny commercial decision, policy, approval, budget, consent, state-machine, event, experiment, and tamper-evident action-ledger boundary |
| `@jataqi/autonomous-action-runtime` | Adapter-only controlled action execution with bounded retries, timeouts, verification, rollback recording, and dry-run safety |
| `@jataqi/external-connectors` | Explicit connector registration, capability discovery, health activation, credential references, and action-runtime adapter lifecycle |
| `@jataqi/github-execution` | Injected-client GitHub execution boundary with blocked/connected/live-verified states, control-plane authorization, and independent verification requirements |
| `@jataqi/copilot-execution-adapter` | Persistent engineering task graph and bounded coding-worker execution through the commercial action/verification boundary |
| `@jataqi/autonomous-test-repair` | Profile-governed test/repair lifecycle that records diagnostics and patch proposals but never applies changes implicitly |
| `@jataqi/autonomous-deployment` | Adapter-only deployment lifecycle with required health verification, explicit production enablement, and confirmed rollback recording |
| `@jataqi/infrastructure-state-registry` | Adapter-only VPS/cloud/DNS/TLS resource registry with expected-vs-observed state, verification, drift detection, and confirmed rollback records |
| `@jataqi/payments` | Provider-neutral, action-runtime-gated payment/refund intents that cannot become real financial facts before independent verification |
| `@jataqi/billing` | Plans, subscriptions, invoices, and verified-payment-only activation |
| `@jataqi/revenue-ledger` | Per-tenant hash-chained recognized revenue, refund reversal, and evidence-classified cost ledger |
| `@jataqi/reconciliation` | Read-only internal/provider-state reconciliation with explicit pending-external and disputed outcomes |
| `@jataqi/commercial-analytics` | Evidence-classified funnel, MRR/ARR, revenue, cost, CAC, ROAS, churn, retention, and contribution-margin calculations |
| `@jataqi/commercial-intelligence` | Evidence-bound opportunity scoring, readiness gates, deliberate no-action outcomes, and recommendation-only SEA-facing analysis |
| `@jataqi/autonomous-venture-factory` | Evidence-gated venture lifecycle and commercial blueprint coordination with approval/readiness gates before production state |
| `@jataqi/portfolio-governor` | Configurable portfolio classification and evidence-bound resource-allocation recommendations that require separate execution authorization |
| `@jataqi/commercial-memory` | Tenant-bound hash-chained commercial memory, decision/outcome feedback, prohibited-strategy records, and correlation/causation graph |
| `@jataqi/commercial-health` | Evidence-bound commercial anomaly, drift, and containment-recommendation engine with no implicit intervention |
| `@jataqi/commercial-observability` | Privacy-minimized CCP event projections, correlation traces, evidence-classified metrics, local alerts/incidents, and no automatic remediation |
| `@jataqi/commercial-event-stream` | Explicit manual-pump event contracts, schema validation, idempotent delivery, bounded retry, replay, and dead-letter records |
| `@jataqi/commercial-command-center` | Read-only tenant-filtered approval, budget, health, observability, delivery, financial, readiness, portfolio, and memory command-center projection |
| `@jataqi/cognitive-kernel` | JQB v0.1 persistent classical cognitive state, observations, beliefs, goals, contradiction markers, uncertainty-aware assessment, and safe audit traces |
| `@jataqi/multi-agent-cognition` | Tenant-bound, injected-reviewer structured critique with evidence/consistency/safety assessment, retained disagreement, and non-executing synthesis |
| `@jataqi/meta-reasoning` | Classical, tenant-bound forecast/error/calibration registry with explicit uncertainty, model comparison, contradiction retention, and advisory-only autonomy reduction |
| `@jataqi/permanence-fabric` | Classical public-key JQ-ID/JQ-UIP identity, signed runtime/state continuity metadata, lineage, rotation/revocation, and non-executing handover planning |
| `@jataqi/capability-fabric` | Tenant-bound JQ-CAP/JQ-UCR capability and ENGINE_GENOME registry with lifecycle evidence, scoped grants, runtime requirements, composition graph, and no engine execution |
| `@jataqi/research-evidence` | Tenant-bound frontier-research claim/evidence provenance, reproducibility references, deterministic uncertainty assessment, and no physical execution capability |
| `@jataqi/human-approval` | Competency-aware, tenant-bound research human-attestation/review quorum with immutable vote audit records and no physical execution authorization |
| `@jataqi/regulatory-gates` | Tenant-configured local research evidence/human-review gate evaluation with explicit external-verification pending status and no compliance or physical authorization claim |
| `@jataqi/probabilistic-engine` | Classical Bayesian hypothesis, entropy, information-gain, and deterministic beam-selection engine with quantum-inspired metadata only |
| `@jataqi/hypothesis-engine` | Persistent competing-hypothesis sessions that bridge classical Bayesian updates into JQB cognitive beliefs and rank evidence plans without executing them |
| `@jataqi/world-model` | Tenant-bound JQB entities, association/causal-status relations, events, temporal validity, provenance, and bounded traversal |
| `@jataqi/causal-engine` | Classical linear structural causal models and explicitly simulated intervention/counterfactual scenarios with causal-evidence safeguards |
| `@jataqi/temporal-engine` | Tenant-bound temporal event ordering, causality checks, deterministic replay, and explicit simulated scenario timelines |
| `@jataqi/orbital-intelligence` | Provider-neutral authorized-reference orbital/geospatial metadata, sandbox-only adapter checks, encrypted opaque local references, quality/license-reference policy assessment, non-executing monitoring/request plans, World/Temporal Model links, and no live provider or tasking capability |
| `@jataqi/reproducibility` | Versioned experiment/simulation metadata, canonical input/output hashes, and explicit replication outcomes without workload execution |
| `@jataqi/universal-visibility-fabric` | Creative asset, claim, evidence, brand-policy, approval, and confirmed-distribution registry |
| `@jataqi/universal-distribution-nervous-system` | Connector-aware distribution plan lifecycle with explicit external-algorithm/reach boundary and verification before publication |
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

## Local development configuration

Copy `.env.example` to `.env` for local development or deterministic testing:

- `STORAGE_DRIVER=memory` is the default ephemeral mode.
- `STORAGE_DRIVER=filesystem` persists local development state to
  `STORAGE_FS_ROOT`, but supports **one process per root only** and is not
  production storage.
- `VECTOR_MODEL=openai` and `AGENT_LLM=openai` configure optional external
  model adapters when their API key/model settings are supplied. They do not
  create a production deployment or authorize external actions.
- `LOG_LEVEL=info` (or `debug` for development).

The CLI auto-loads `.env`; library users call `createJataQiFromEnv()`. A
production persistence/control-plane design is documented in
[`docs/PERSISTENCE_ARCHITECTURE.md`](docs/PERSISTENCE_ARCHITECTURE.md), but is
not implemented in this repository.

## Commercial control-plane safety

The commercial control plane is enabled during bootstrap with a conservative default:
no commercial action is authorized for real execution without a matching policy,
budget/connector/consent checks where applicable, and any required human approval.
The action runtime ships with **no live connector adapters or credentials**. A provider
response is recorded as `VERIFYING`, not `COMPLETED`, until independent verification
is attached. Sandbox and dry-run results remain explicitly marked as simulated.
See [`docs/COMMERCIAL_CONTROL_PLANE.md`](docs/COMMERCIAL_CONTROL_PLANE.md) for the
implemented contract, safety boundary, and external-integration status. See
[`docs/JQB_V0_1.md`](docs/JQB_V0_1.md) for the separately classified classical
cognitive, structured multi-agent critique, and meta-reasoning foundation, plus its scientific-integrity limits. Frontier research evidence and physical-safety boundaries are documented in [`docs/FRONTIER_RESEARCH_SAFETY.md`](docs/FRONTIER_RESEARCH_SAFETY.md).

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

Run the full suite (300 unit tests across all packages):

```bash
npm test
```

Each package can be built/tested independently:

```bash
npm run build --workspace=@jataqi/core-kernel
npm test --workspace=@jataqi/knowledge-graph
```

A controlled three-product lifecycle acceptance test is documented in
[`docs/THREE_PRODUCT_SANDBOX_ACCEPTANCE.md`](docs/THREE_PRODUCT_SANDBOX_ACCEPTANCE.md).
It is explicitly sandbox-only and does not claim live production outcomes.

An end-to-end demo is in `examples/demo.mjs`:

```bash
node examples/demo.mjs
```

## Repository status

- ✅ Core Kernel (event bus, DI, lifecycle, config, logging)
- ✅ Development Storage Layer (memory + **single-process/non-production** filesystem KV/collections/blobs, pagination)
- ✅ Development Vector Search (hash + OpenAI embeddings, cosine/euclidean/dot, local snapshot persistence)
- ✅ Development Knowledge Service (ingestion, chunking, retrieval, metadata filters, context expansion, local restart restoration)
- ✅ Development Knowledge Graph (entities, triples, traversal, heuristic extraction, graph-RAG, orderly-shutdown snapshots)
- ✅ Agent Runtime (tools, ReAct loop, Echo/Scripted/OpenAI LLMs, built-in tools, session memory)
- ✅ Commercial Control Plane (default-deny policy/authorization, approvals, budgets, consent, lifecycle state, events, experiments, action ledger)
- ✅ Autonomous Action Runtime (explicit adapters, bounded retries/timeouts, dry-runs, verification/rollback recording)
- ✅ External Connector Fabric (inactive-by-default capability/health registry; no bundled live credentials or providers)
- ✅ GitHub Execution Boundary (injected-client control plane; unconfigured by default and never claims live GitHub access)
- ✅ Coding-Agent Execution Adapter (persistent task graph; no worker or code write is implicit at boot)
- ✅ Autonomous Test/Repair Loop (profile-governed sandbox runner; repair proposals are not automatically applied)
- ✅ Autonomous Deployment Boundary (adapter-only deployment/health/rollback lifecycle; no infrastructure provider is bundled)
- ✅ Infrastructure State Registry (adapter-only resource lifecycle, expected-vs-observed state, drift, and reconciliation records)
- ✅ Payments + Billing + Revenue Ledger + Reconciliation + Commercial Analytics (provider-neutral and verification-gated; no bundled live provider credentials)
- ✅ Universal Visibility Fabric + Universal Distribution Nervous System (evidence-governed creative assets and connector-aware, externally verified distribution)
- ✅ Commercial Intelligence (evidence-bound opportunity scoring, readiness gates, and recommendation/no-action outcomes)
- ✅ Autonomous Venture Factory (explicit lifecycle, blueprint, decision, and readiness gates; no fabricated production state)
- ✅ Portfolio Governor (evidence/risk-aware classifications and non-executing resource-allocation recommendations)
- ✅ Commercial Memory + Health + Event Stream (tenant-bound outcome learning, attribution safeguards, anomaly/drift detection, bounded event delivery/retry/DLQ records)
- ✅ Commercial Observability (safe CCP event projections, correlation traces, evidence-classified metrics, local alerts/incidents, and no automatic remediation)
- ✅ Commercial Command Center (read-only approval and operational aggregation, including optional observability; approval mutations delegate to the control plane)
- ✅ JQB v0.1 Cognitive Foundation (classical cognitive/hypothesis/world/causal/temporal state, reproducibility records, explicit injected-reviewer multi-agent critique, and classical meta-reasoning/calibration; no quantum-native or AGI claims)
- ✅ JATA Qi Permanence Fabric (classical public-key JQ-ID/JQ-UIP continuity records, runtime/state attestations, lineage, key rotation/revocation, and non-executing handover plans; no quantum/availability guarantee)
- ✅ JQ Capability Fabric (tenant-bound capability and ENGINE_GENOME lifecycle registry, scoped grants, runtime requirements, composition graph, audit chain, and no engine/physical execution)
- ✅ Orbital Intelligence Foundation (provider-neutral authorized-reference source/observation metadata, sandbox-only adapter contract checks, encrypted opaque local references, local quality/license-reference policy assessment, non-executing monitoring/request plans, World/Temporal Model integration, derived fusion/change assessment, and no live provider, tasking, target-selection, or physical-control claim)
- ✅ Research Evidence Foundation (tenant-bound high-level claim/evidence provenance, reproducibility references, regulated-domain human/review routing, and no physical execution capability)
- ✅ Human Approval Foundation (upstream attestation records, competency-aware research review quorum, immutable vote ledger, and no physical-execution authorization)
- ✅ Regulatory Gate Foundation (administrator-managed local evidence/reproducibility/human-review checklists, explicit external-verification pending state, and no compliance/physical-authorization claim)
- ✅ CLI + Bootstrap (.env support, ask/ingest/stats/search/entities/repl)
- ⬜ GitHub recovery, remote push, and pull-request operations (`PENDING_EXTERNAL_ACCESS`; no remote write is claimed from this checkout)

## License

MIT
