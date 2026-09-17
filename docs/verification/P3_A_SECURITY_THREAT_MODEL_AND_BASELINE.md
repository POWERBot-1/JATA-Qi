# P3-A — AGENT SECURITY THREAT MODEL & IMPLEMENTATION BASELINE

| Field | Value |
|---|---|
| Milestone | **P3 — Agent Security / Execution Containment**, phase **P3-A** (baseline + plan) |
| Exact artifact measured | **`08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`** (canonical `main`) |
| Date (UTC) | 2026-09-17 |
| Method | Read-only source measurement (`grep`/file reads at the exact SHA), canonical docs, live GitHub metadata. **No test suite was executed** for this baseline (stated in §9). |
| Evidence class | **PRIMARY** (source-verified at the exact SHA) |
| Authorization | P3 authorized by the owner (2026-09-17) **for planning only**; implementation requires a separate P3 implementation authorization naming the selected slice(s) |
| Status of this document | **Baseline + plan. Implements nothing. Normalizes no defect. Closes no gap.** |
| Governing cap | **`P2 E4: NOT ACHIEVED`** — the identity/privilege plane P3 builds on is PRIMARY-verified, **not** E4-verified (`P2_ASSURANCE_CAP_DISPOSITION.md`) |

---

## 1. Scope statement and honesty rules

P3-A measures what exists. It does **not** assume any control exists, and it does
**not** treat specification text as implementation (v1.1 V3/V4; the program's
standing no-roadmap-credit rule). Every claim below cites a file at `08adbd9`.

Three classifications are used and are never conflated:

- **CONFIRMED DEFECT** — a measured behaviour that contradicts a committed claim
  or an expected safety property.
- **MISSING CAPABILITY** — no implementation exists at all.
- **HARDENING OPPORTUNITY** — a control exists and works, but is weaker than it
  could cheaply be.

## 2. Measured architecture baseline (what actually executes)

### 2.1 Execution model

| Property | Measurement at `08adbd9` | Evidence |
|---|---|---|
| Process/worker spawning | **none** | `child_process`: **0 hits** across `packages/*/src`; `worker_threads`: **0**; `node:vm`: **0**; `eval(`: **0**; `new Function`: **0** |
| Agent execution | **in-process, single-process** — `Agent.run` loop with `maxIterations` (default 8) calling tools in the same process | `packages/agent-runtime/src/agent.ts` |
| Tool execution | in-process function calls through `ToolRegistry.call` | `packages/agent-runtime/src/tools.ts` |
| Governed orchestration | 34-stage loop; governance spine `POLICY → SAFETY → AUTHORITY → HUMAN_OR_REGULATORY_GATE`; latches that skip execution-side stages once a gate holds; `HELD_AT_GATE` outcome | `packages/unified-loop/src/{state-machine.ts,unified-loop-service.ts}` |
| External side effects | routed through `ActionRuntimeService.execute` → adapter, with per-attempt decision, timeout, verify/rollback | `packages/autonomous-action-runtime/src/action-runtime-service.ts` (`withTimeout` :361, timeout resolution :156) |
| Containment of the workload | **none** — no OS/container/VM isolation, no seccomp/capability drop, no resource cgroups | `docker|containerd|gVisor|firecracker|seccomp`: **0 hits** in `packages/*/src` |

### 2.2 Network reality — the outbound seams (measured)

There is **more outbound network capability than the program's own boundary
inventory records**. Three seams can perform HTTP(S) egress at this SHA:

| # | Seam | Detail | Governed by A-01? |
|---|---|---|---|
| N-1 | **LLM provider call** | `packages/agent-runtime/src/llms/openai.ts:72` — `POST` to `this.endpoint`; endpoint default `https://api.openai.com/v1/chat/completions` (`:39`), **constructor-configurable**; bearer key from `cfg.apiKey ?? process.env.OPENAI_API_KEY` (`:42`); transport injectable (`fetcher`, `:10/:42`); default Node `fetch` | **NO** |
| N-2 | **Embedding provider call** | `packages/vector-search/src/embeddings.ts:109` — `POST` with `Authorization: Bearer <key>`; endpoint default `https://api.openai.com/v1/embeddings` (`:90`), **configurable via module config** (`vector-module.ts:21`); **no `signal`/timeout parameter** | **NO** |
| N-3 | **JWKS fetch** | `packages/authentication/src/jwt.ts:232-243` — `fetch(url, { redirect: 'error' })`; URL must be `http(s)://` (`:230`) and is operator-pinned; injectable `fetcher` for tests | **NO** (pinned URL, no tenant payload) |

**No payload/destination allowlist, no manifest/capability binding, no policy
decision, no provenance/audit record, and no timeout accompany N-1/N-2.** The
A-01 invocation-boundary inventory (`docs/A01_AUTHORIZATION_BOUNDARY.md` §2(A)/(B))
lists neither seam: §2(B) covers “knowledge/graph/vector **data planes (read)**”
as non-consequential, which is true of the retrieval data plane but **not** of the
credentialed embedding provider that sits beside it.

### 2.3 Authorization / identity at execution boundaries (measured, strong)

| Control | Mechanism | Evidence |
|---|---|---|
| No boundary ⇒ DENY | `NO_BOUNDARY_DENIAL`; tool body unreachable | `tools.ts` (`ToolRegistry.call`) |
| Undeclared tool ⇒ DENY | `UNDECLARED_TOOL_AUTHORIZATION` | `tools.ts` |
| Missing envelope ⇒ DENY | `AUTHORIZATION_ENVELOPE_MISSING` | `tools.ts` |
| Envelope re-verified before side effect | `assertEnvelope` (integrity, decision, freshness, replay, credential) then `executeAuthorized` | `tools.ts`, `authorization-boundary/src/gate.ts:355,378` |
| Boundary not swappable | install-once `setAuthorizationGate` throws on replacement | `tools.ts` |
| Model output cannot choose authority | envelope request built **only** from verified principal + tool declaration; model picks tool name/args | `agent.ts:renderToolEnvelope` |
| Fail-closed defaults | undeclared tool ⇒ `impact: EXTERNAL_SIDE_EFFECT`, `dataClassification: INTERNAL`; missing principal ⇒ empty principal ⇒ DENY | `agent.ts` |
| Tenant authority | execution tenant = envelope tenant; conflicting `metadata.tenantId` ⇒ `IDENTITY_CONFLICT`; no envelope ⇒ S-1 metadata tenant; none ⇒ refuse | `agent-runtime/src/builtins.ts:ctxTenantId` |
| Operation allow-list, target matching, classification, impact | manifest-driven PDP checks | `authorization-boundary/src/policy-engine.ts:202` (comment) |
| Rate limit / budget | `usage >= manifest.rateLimit.max` ⇒ deny (`:415`); `cost > manifest.budgetPerRunCostUnits` ⇒ deny (`:408`) | `policy-engine.ts` |
| Approval | `manifest.requiresApproval` ⇒ `APPROVAL_MISSING` (`:529`) | `policy-engine.ts` |
| Credential handling | binding only in the decision; material delivered once at the enforcement point; never in model context/audit | `docs/A01_AUTHORIZATION_BOUNDARY.md` §3 |
| Connector posture | registration ≠ activation; `UNBOUND_CONNECTOR`; `OVER_PRIVILEGED_CONNECTOR`; no bundled connector | `external-connectors/src/registry.ts` |
| GitHub writes | injected client + secret-manager reference required; otherwise blocked | `github-execution/src/*service*.ts` |
| Worker wrapper | `runUnderEnvelope`/`WorkerTask` for future external I/O from workers | `authorization-boundary/src/worker-boundary.ts` |
| Secret material | seal/open/rotate/revoke + access audit + dev-provider refusal in production | `authentication/src/{secret-material,key-management}.ts` |
| Tenancy at the data plane | RLS + `FORCE ROW LEVEL SECURITY`; INV-15 scope minimization with enumerated labels; vector records without a tenant marker never returned | `storage-postgres/src/*`, `vector-search/src/types.ts:37-42` |
| Static control precedent | ESLint `no-restricted-syntax` bans `openNamespace`/`openBlobStore`/`namespace`/`blobStore` call shapes | `eslint.config.mjs:63-122` |

**Envelope integrity caveat (unchanged, P1-GAP-12):** the digest is **unkeyed
SHA-256** (`authorization-boundary/src/canonical.ts:42`) — tamper-evident, not
origin-authenticated.

## 3. The 20 mandated surfaces — measured status

| # | Surface | Status | Measured basis |
|---|---|---|---|
| 1 | **Prompt injection** | **MISSING CAPABILITY** (structural mitigation only) | 0 source hits for injection/sanitization defenses; model output **cannot** set identity/tenant/capability/credential (envelope construction, `agent.ts`), so injection cannot directly escalate — but see #18 |
| 2 | **Indirect instruction attacks** | **MISSING CAPABILITY** | Retrieved/external content is fed back into model context verbatim (`agent.ts` pushes tool output as `role: 'tool'`); no provenance tagging, no instruction/content separation, no screening |
| 3 | **Confused deputy** | **PARTIALLY MITIGATED (no dedicated mechanism/tests)** | Envelope binds tool+operation+target to the **verified principal** (`tools.ts`, `worker-boundary.ts`); delegation narrowing exists (P2-S4). No explicit confused-deputy test class |
| 4 | **Tool authorization & tool abuse** | **CONTROL EXISTS (strong)** with residual abuse window | Gate enforcement + manifests + rate/budget (`§2.3`). Residual: **abuse *within* a granted capability** (a model may pick any allowed tool/args it can justify) is bounded only by manifest scope, rate, budget, and approval flags |
| 5 | **Agent identity propagation** | **CONTROL EXISTS** | `principal`/`agentId`/`agentVersion`/`runId`/`correlationId` flow into the envelope; `provenance: agent:<name>` (`agent.ts`) |
| 6 | **Cross-tenant authorization** | **CONTROL EXISTS (strong)** | Envelope tenant authoritative; `IDENTITY_CONFLICT` refusal; kernel-worker tenancy only under deliberately system-scoped capabilities (`policy-engine.ts:321`) |
| 7 | **Cross-tenant RAG/cache isolation** | **PARTIAL / EVIDENCE GAP** | Retrieval is tenant-bound and RLS-backed; **no cache layer exists at all** (so cache isolation is *not applicable today*, and must be designed in when one is introduced). No production-class RAG isolation evidence; no adversarial cross-tenant RAG suite |
| 8 | **Sandbox/workload containment** | **MISSING CAPABILITY** | 0 isolation primitives (§2.1); execution is in-process with full host privileges |
| 9 | **SSRF** | **MISSING CAPABILITY** | No URL validation/denylist/redirect policy except `redirect:'error'` on JWKS; no private-range/link-local blocking; no destination policy |
| 10 | **Governed egress** | **MISSING CAPABILITY — plus a CONFIRMED inventory defect** | N-1/N-2 perform credentialed egress outside any decision point (§2.2); the A-01 inventory does not record them |
| 11 | **Capability/tool allowlisting** | **PARTIAL** | Operation allow-lists, manifests, and connector binding exist; **no destination/network allowlist** and no tool allowlist *per agent* beyond what is registered |
| 12 | **Least privilege** | **CONTROL EXISTS** | Kernel-worker authority requires an explicit non-empty operation list; system scope only under deliberately system-scoped capabilities; grants expire |
| 13 | **Execution provenance** | **PARTIAL** | Decisions, audits, ledgers, and run metadata exist; **outbound model/embedding calls produce no provenance record** |
| 14 | **Auditability** | **PARTIAL** | Durable audit for decisions/actions/secret access; **no audit for LLM/embedding egress** (what prompt/context left the boundary, to where) |
| 15 | **Secret/material isolation** | **CONTROL EXISTS** with a **coverage gap** | Sealed store + access audit + dev-provider refusal (P2-S7). **But N-1 reads `process.env.OPENAI_API_KEY` directly (`openai.ts:42`) and bootstrap passes `env.OPENAI_API_KEY` (`cli/src/bootstrap.ts:575,591`)** — the provider keys never traverse the P2 seam |
| 16 | **Resource exhaustion / runaway execution** | **PARTIAL** | `maxIterations` (8) bounds the tool loop; budgets/rate limits at the gate; timeouts on action adapters. **No timeout on N-1/N-2** (unbounded hang); no bound on prompt/context size; `max_tokens` defaults to 1024 but is not policy-derived |
| 17 | **Agent-to-agent trust boundaries** | **NOT APPLICABLE TODAY / MISSING BY DESIGN** | `multi-agent-cognition` ships **no reviewer by default** and performs no execution; injected reviewers are non-executing. Any future executing multi-agent channel needs its own boundary |
| 18 | **Untrusted model output handling** | **PARTIAL — highest-value gap** | Tool output is stored as a tool message and fed back to the model verbatim; tool *arguments* come from the model and are validated only for **presence of required keys** (`tools.ts:validateInput` — no type/enum/format enforcement); no output-schema validation of tool results |
| 19 | **Policy enforcement at execution boundaries** | **CONTROL EXISTS (strong)** on governed paths; **absent** on the model/embedding egress path | §2.3 vs §2.2 |
| 20 | **Fail-closed behaviour** | **CONTROL EXISTS (strong)** | No-boundary ⇒ DENY; missing principal ⇒ DENY; unresolved boundary ⇒ DENY; unknown tenant ⇒ refuse; store unreachable ⇒ `SECURITY_STATE_UNAVAILABLE`; gate latches in the loop |

## 4. Findings register (classified)

### 4.1 CONFIRMED DEFECTS

| ID | Defect | Evidence | Severity |
|---|---|---|---|
| **P3-D1** | **Two production-capable credentialed egress paths (LLM, embeddings) are outside every authorization decision** — no manifest binding, no destination policy, no provenance, no audit | `openai.ts:72`, `embeddings.ts:109`; A-01 inventory §2 (absence from both (A) and (B)) | **HIGH** |
| **P3-D2** | **The A-01 invocation-boundary inventory is incomplete/misleading as to completeness** — it enumerates (A) enforced paths and (B) proven-non-consequential paths, and the credentialed embedding provider is presented under a “read data plane” row that cannot perform egress | `docs/A01_AUTHORIZATION_BOUNDARY.md` §2 vs `vector-search/src/embeddings.ts` | **MEDIUM** (documentation/inventory integrity) |
| **P3-D3** | **No timeout/deadline on N-1/N-2** — the embedding seam has no `signal` parameter at all; the LLM seam passes only a caller-supplied signal. An unresponsive provider hangs the run indefinitely | `embeddings.ts:109` (no `signal`), `openai.ts:79` (`signal: req.signal` only) | **MEDIUM** |
| **P3-D4** | **Provider endpoints are constructor/configurable with no scheme/host validation or allowlist** — `endpoint` can be redirected by configuration (`openai.ts:39`, `embeddings.ts:90`, `vector-module.ts:21`), and the bearer token goes to whatever host is set | same | **MEDIUM** (SSRF-adjacent / credential-redirection) |
| **P3-D5** | **Provider API keys bypass the P2 secret-material seam** — `process.env.OPENAI_API_KEY` is read directly by the adapter and injected by bootstrap | `openai.ts:42`, `cli/src/bootstrap.ts:575,591` | **MEDIUM** (control-coverage gap; P2-INV-08 governs the seam, not these call sites) |

### 4.2 MISSING CAPABILITIES

**P3-M1** governed egress control plane (destination allowlist + manifest binding + decision + provenance) · **P3-M2** workload containment / OS isolation · **P3-M3** SSRF defenses · **P3-M4** prompt-injection / indirect-instruction defenses · **P3-M5** cross-tenant RAG/cache adversarial evidence · **P3-M6** egress provenance/audit · **P3-M7** agent-to-agent execution boundary (only if executing multi-agent is ever introduced).

### 4.3 HARDENING OPPORTUNITIES

**P3-H1** envelope digest is unkeyed SHA-256 (P1-GAP-12) · **P3-H2** `validateInput` checks required-key presence only — no type/enum/format enforcement · **P3-H3** no ESLint static restriction on `fetch`/`node:http(s)`/`child_process` in `packages/*/src` (the repository already uses this pattern for storage-namespace calls) · **P3-H4** no per-agent tool allowlist (all registered tools are offered to the model) · **P3-H5** prompt/context size is unbounded · **P3-H6** `Agent.run` converts any error into a model-visible answer string (possible information disclosure in error text) · **P3-H7** ruleset: no `non_fast_forward`; stale-review controls disabled (human-admin) · **P3-H8** no production-class RAG isolation evidence (test-class only).

## 5. Trust-boundary map (measured)

```
 untrusted ------------------------------------------------------------------► trusted
 ┌──────────────┐   ┌───────────────────┐   ┌────────────────────────┐   ┌─────────────────────┐
 │ user message │   │ model output      │   │ retrieved content      │   │ capability manifests│
 │ tool args    │──►│ (tool name+args)  │──►│ (knowledge/vector/     │   │ verified principal  │
 │ metadata     │   │ tool RESULTS      │   │  graph/external text)  │   │ sealed envelope     │
 └──────────────┘   └───────────────────┘   └────────────────────────┘   └─────────────────────┘
        │                    │                          │                          ▲
        │        ┌───────────▼────────────┐             │                          │
        │        │ model SEES all of the  │◄────────────┘                          │
        │        │ above as one context   │  ← no instruction/content separation    │
        │        └───────────┬────────────┘                                         │
        │                    │ tool call proposal (deny-by-default)                 │
        │        ┌───────────▼──────────────────────────────┐                      │
        └───────►│ AUTHORIZATION GATE (A-01)                 │──────────────────────┘
                 │ assertEnvelope → executeAuthorized        │
                 └───────────┬──────────────────────────────┘
                             │ ALLOW (envelope-bound)        │ DENY → model-visible error
                 ┌───────────▼───────────┐        ┌──────────▼──────────────┐
                 │ in-process tool body  │        │ LLM / EMBEDDING EGRESS  │  ◄── NO GATE
                 │ (host privileges)     │        │ (credentialed POST)     │      (P3-D1)
                 └───────────┬───────────┘        └─────────────────────────┘
                             │
                 ┌───────────▼───────────┐
                 │ action runtime →      │  (per-attempt decision, timeout, verify/rollback)
                 │ adapters/connectors   │
                 └───────────────────────┘
```

**The single structural asymmetry:** side effects are governed; **the model
itself is an ungoverned egress channel** — anything in the context window
(including other tenants' retrieved content composed into the same run, and the
system prompt) can leave the boundary to a configurable host with a bearer
credential, with no decision, no allowlist, and no record.

## 6. Attack cases and measurable acceptance criteria

Each case names the surface(s), the observable criterion, and the evidence that
would satisfy it. **None of these tests exists today unless marked.** Cases
marked *(structurally mitigated — test to pin)* are expected to pass against the
current code and therefore serve as regression pins for P3 work.

| ID | Attack case | Expected fail-closed behaviour | Acceptance criterion |
|---|---|---|---|
| **AT-1** | Tool call with no envelope | DENY, tool body never runs | *(structurally mitigated — test to pin)* `NO_BOUNDARY_DENIAL` / `AUTHORIZATION_ENVELOPE_MISSING`; side-effect counter = 0 |
| **AT-2** | Tool declared without `authorization` behind an installed gate | DENY | *(mitigated — pin)* `UNDECLARED_TOOL_AUTHORIZATION` |
| **AT-3** | Model emits `tenantId`/identity/capability in tool input or metadata | authority unchanged; conflict refused | *(mitigated — pin)* `IDENTITY_CONFLICT`; envelope tenant wins; no cross-tenant read |
| **AT-4** | Model requests a tool outside the capability manifest operation list | DENY | *(mitigated — pin)* policy denial; no adapter invocation |
| **AT-5** | Retry/replay of a consumed envelope | DENY (replay) | *(mitigated — pin)* replay refusal; exactly-once side effect |
| **AT-6** | **Injected instruction in retrieved content asks the agent to exfiltrate context** to an attacker host | **currently UNPROTECTED** | with P3-B: destination not in allowlist ⇒ no egress; run records a denial. Without P3-B the criterion cannot be met |
| **AT-7** | **Config/actor sets `endpoint` to a non-approved host** for LLM or embeddings | refuse | with P3-B: only allowlisted origins accepted; refusal recorded; credential not transmitted |
| **AT-8** | **Provider hangs / never responds** | bounded failure | with P3-D: deadline exceeded ⇒ DENY/abort; no unbounded hang; elapsed time ≤ configured bound |
| **AT-9** | **SSRF via provider/connector URL** (loopback, link-local, metadata IP) | refuse | with P3-B/C: private-range/loopback/link-local blocked; DNS-rebinding consideration documented |
| **AT-10** | Tool argument type abuse (wrong type/enum/oversized payload) | refuse before execution | with P3-C: schema enforcement (type/enum/format/size) — currently only required-key presence |
| **AT-11** | **Cross-tenant RAG probe**: tenant A run retrieves tenant B content | zero disclosure | *(data-plane mitigated — RAG-path suite to be added)* 0 foreign chunks in output; refusal code recorded |
| **AT-12** | Runaway execution: model loops on tool calls | bounded | *(mitigated — pin)* `maxIterations` terminates; budget/rate denials recorded |
| **AT-13** | Excess context / oversized retrieved content inflates the prompt | bounded | with P3-D: context-size bound enforced; refusal recorded |
| **AT-14** | Worker bypasses `runUnderEnvelope` and attempts a credential-bound external call | fails closed | *(mitigated — pin)* no envelope ⇒ no credential ⇒ refusal |
| **AT-15** | Provider key read bypasses the secret seam | closed | with P3-B/C: provider credentials sourced via the seam (or an explicit, recorded decision that the seam does not cover them); no direct `process.env` read on the egress path |
| **AT-16** | Tamper with a sealed envelope in durable state | detected | *(mitigated for integrity — pin)* digest mismatch ⇒ DENY; **note P1-GAP-12: unkeyed digest ⇒ integrity, not authenticity** |
| **AT-17** | Connector registered without capability binding / over-privileged action list | DENY | *(mitigated — pin)* `UNBOUND_CONNECTOR` / `OVER_PRIVILEGED_CONNECTOR` |
| **AT-18** | Decision store unreachable during a tool call | fail closed | *(mitigated — pin)* `SECURITY_STATE_UNAVAILABLE`; no memory fallback |

## 7. Proposed implementation scope (bounded slices; none authorized yet)

Recommended order follows dependency and measured risk, not feature appeal.

| Slice | Objective | Addresses | Depends on | Rollback |
|---|---|---|---|---|
| **P3-B — Governed Egress Control Plane** *(RECOMMENDED FIRST)* | One narrow, injectable egress seam used by **all** outbound HTTP (LLM, embeddings, JWKS, future connectors): destination allowlist (origin + scheme), manifest/capability binding, decision through the existing A-01 gate where a principal exists, mandatory deadline, provenance + audit record, credential delivered from the P2 seam (or an explicit recorded exclusion) | P3-D1, D3, D4, D5; M1, M3(partial), M6 | existing gate + manifests + secret seam | additive; egress plane can be disabled by posture (production posture fails closed without an allowlist) |
| **P3-C — Untrusted content & model-output hardening** | Instruction/content separation and provenance tagging for retrieved content; tool-argument schema enforcement (type/enum/format/size); tool-output schema validation; explicit injection test corpus as an adversarial suite | P3-M4, M5, H2, H4, H6 | P3-B for egress-related cases | additive; enforcement flags default permissive-with-record until posture enables |
| **P3-D — Execution bounds** | Deadlines and size bounds on model calls and prompts; per-run cost/token ceilings as policy inputs; recorded cancellation semantics | P3-D3, M(partial), H5 | P3-B (deadline seam) | additive |
| **P3-E — Containment feasibility (design only in this phase)** | Evaluate process/container isolation for tool execution (out-of-process worker, filesystem/network confinement, resource limits) against the existing in-process model; produce a design + threat delta, **no implementation** | P3-M2 | P3-B/C outcomes | n/a (design) |
| **P3-F — Isolation evidence** | Adversarial cross-tenant RAG/cache suite; cache-isolation design requirements recorded **before** any cache is introduced | P3-M5, H8 | P3-C | test-only |
| **P3-G — Static & governance hardening** | ESLint no-restricted-syntax bans on `fetch`/`node:http(s)`/`child_process` in `packages/*/src` with explicit exemptions; per-agent tool allowlist; A-01 inventory correction (**P3-D2**) | P3-H3, H4, P3-D2 | none | revert lint/docs |

**Explicitly out of P3 scope:** P4 knowledge/Model Fabric; P5 prompt compiler; P6
commerce/PSP; P7 production qualification (HA/DR/deployment); 120% acceleration;
dormant-stream integration; rubric or score work; remediation of EV-01/02/08;
ruleset changes (human-admin).

## 8. Verification and evidence requirements (P3)

1. **E4 remains unavailable** (capped; §9). P3 must therefore state, in every
   record, that its evidence is **PRIMARY / same-agent + CI-class**, and must not
   claim E4, independence, or production assurance.
2. **Because the cap must not lower the bar**, P3 compensates with *stronger
   internal* evidence: (a) every new control ships with **negative-path tests**
   proving fail-closed behaviour, (b) **mutation coverage** of the new control
   paths (disposable-copy harness, ≥1 mutant per control branch), (c) the
   **adversarial matrix** AT-1…AT-18 executed with recorded observables, (d) a
   **zero-skip, fail-hard** run, (e) the CI gate green on the exact artifact SHA.
3. **Acceptance-criteria table** per slice: case → command → observed result
   (assertion-level), plus environment (SHA, Node version, PG mode).
4. **No assertion weakening, no test suppression, no speculative fix**; any
   discovered defect is **measured and recorded first** and fixed only under an
   explicit remediation authorization.
5. **Rollback evidence**: each slice declares its revert boundary and the
   posture flag that disables it, with a test proving the disabled path fails
   closed in production posture.

## 9. Baseline limitations (disclosed)

1. **No suite was executed for this baseline.** All findings are source-measured
   at `08adbd9`. Consequently no pass/fail, skip, or assertion-level claim is made
   here; the CI-class facts are those recorded in `P2_S8_POSTMERGE_VERIFICATION.md`
   §3 (green on the exact SHA, metadata class).
2. **Environment non-parity** for any future local execution: this sandbox is
   Node **v22.22.3** vs CI **Node 20**, 2 vCPU, no installed toolchain, shallow
   clone — CI on the exact artifact remains the normative gate.
3. **E4 unobtainable** (permanent cap). P3 cannot inherit verified status from P2.
4. **No production environment exists**, so no containment/egress control can be
   validated against real infrastructure in this phase.
5. Findings are limited to the surfaces measured; absence of a hit is evidence of
   absence **only for the patterns searched**, and P3 implementation must extend
   the search (e.g. dynamic imports, string-concatenated module loading).

## 10. Determination

**P3-A baseline: COMPLETE (measurement + threat model + plan).**
The measured posture is **gated-and-fail-closed on side effects**, and
**ungoverned on the model/egress path**. Five confirmed defects (P3-D1…D5), seven
missing capabilities (P3-M1…M7) and eight hardening opportunities (P3-H1…H8) are
recorded with exact evidence. **Recommended first implementation slice:
P3-B (Governed Egress Control Plane)**, because it closes the only measured
production-capable path that bypasses authorization, it is additive and
rollback-safe, and P3-C/D depend on its seam.

**STOP. No P3 implementation is authorized by this document.**
A separate P3 implementation authorization must name the slice(s), acceptance
criteria, evidence requirements, and rollback boundary before any production-code
change. Nothing in this baseline is a claim that any control already exists.
