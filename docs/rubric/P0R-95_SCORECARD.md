# P0R-95 — Canonical Scorecard (PROVISIONAL)

| Field | Value |
|---|---|
| Specification | `JATA-P0-95-v1.1` (adopted; canonical at `docs/rubric/JATA-P0-95-v1.1.md`) |
| Scorecard status | **PROVISIONAL — v1.0 numeric schedule UNRECOVERED** (see `docs/verification/P0R_RUB_03_PROVENANCE_RECONSTRUCTION.md`) |
| Canonical SHA scored | `2455c59e8462ca203e9d57788792acb32e5cdad9` |
| Date of assessment | 2026-09-11 (UTC) — **refreshed at M1 closure** (see `docs/verification/M1_CLOSURE_RECORD.md` §6) |
| Assessment type | Fresh, source-verified, at the exact canonical SHA above — **not** a carry-forward of a historical report |
| **Numerical 95% score** | **NOT COMPUTABLE** — v1.0 numeric schedule UNRECOVERED |
| **Published percentage** | **NONE.** No total, no per-dimension percentage, and no delta is published. Only the one fully-specified unit (D07b) is scored, as v1.1 permits. |

---

## 0. Why this scorecard is provisional

v1.1 §9 preserves the E0–E6 evidence coefficients, the freshness model, the
per-dimension weights (other than D07 = 9%), the dimension floors, and the
critical/high gate lists **by reference to v1.0** — and v1.0 was never stored in
this repository. An exhaustive search of all 30 remote branches, all 32 pull
requests, 1,679 commit messages, and GitHub code search recovered **none** of
them.

Therefore:

- **`E` (evidence coefficient)** is reported as an **evidence class**, not a
  number. The class vocabulary is the one already used by the canonical
  `docs/verification/P1_CLOSURE_VERIFICATION.md` §1, which is itself a committed
  artifact — so no new vocabulary is invented.
- **`f` (freshness)** is reported qualitatively against the assessment date.
- **`score = C × I × Q`** is computed **only for D07b**, the sole unit whose rule
  v1.1 fully specifies. Every other unit is marked **UNSCORABLE**.
- **No renormalization** is performed (v1.1 X1/X2).

### Evidence-class vocabulary (from `P1_CLOSURE_VERIFICATION.md` §1)

| Class | Meaning |
|---|---|
| **VERIFICATION** | Independent (separate-party) verification of the exact artifact (E4+ class) |
| **PRIMARY** | Directly inspected canonical artifact at a cited SHA, or executed command output |
| **HISTORICAL** | Authoritative record of a past milestone; not re-executed as current evidence |
| **PR-ATTESTATION** | Claim attested in a PR body/comment without a committed artifact (below VERIFICATION) |
| **UNVERIFIED** | Asserted without supporting evidence |

> Per v1.1 V3, a source-code inspection is graded at the class the schedule
> assigns to inspection and is **never** graded as independent runtime
> verification. Per V4, a historical report is not automatically equivalent to a
> current E4 artifact. Per V5, no `Q` value closes an E4/E5 gate.

---

## 1. Frozen baseline (carried, not re-derived)

Per v1.1 §10 — frozen by the v1.1 adoption, not recomputed by this phase:

| Quantity | Frozen value |
|---|---|
| Capability index | 44.375% |
| Integration-adjusted index | 36.6875% |
| Evidence-qualified baseline | **9.484375%** |
| Sensitivity range | 6.6484375% – 14.875% |
| Stretch credit | 0 / 20 |
| Production readiness | **NOT READY** |

These figures are quoted as the **historical frozen record only**. This
scorecard does **not** update them, because updating them requires the missing
numeric schedule.

---

## 2. D07b — the only computable unit (recomputed at this SHA)

**Rule (v1.1 §1):** `q_07b = (1/9) × Σ[m=1..9] (C_m × I_m × Q_m)`, `Q_m = E_m × f_m`.
**Unit weight:** 2.25 rubric points. **Per-modality share:** 0.25 points exactly.

Per-modality evidence, **re-verified in source at `2455c59`** (not copied from
the historical assessment):

| m | Modality | C | I | Q | `P_m` | Source-verified grounding at this SHA |
|---|---|---|---|---|---|---|
| 1 | Coding | 0 | 0 | 0 | **0** | `github-execution-service.ts:60` — `const environment = input.environment ?? 'sandbox'`; production staged but *"cannot be activated/executed until explicit enablement"* |
| 2 | Architecture | 0 | 0 | 0 | **0** | design documents only; no executable architecture-generation capability |
| 3 | Website/building | 0 | 0 | 0 | **0** | three-product sandbox is SIMULATED; advancement to PRODUCTION refused by test |
| 4 | Image | 0 | 0 | 0 | **0** | `cognitive-kernel/src/types.ts:32` — `'IMAGE'` is an **enum label** in a modality union, not an implementation. `orbital-intelligence-service.ts:846` states *"no image-analysis or target-identification claim is made"* |
| 5 | Video | 0 | 0 | 0 | **0** | `cognitive-kernel/src/types.ts:32` — `'VIDEO'` enum label only |
| 6 | Copy | 0 | 0 | 0 | **0** | `agent-module.ts:42` — `this.defaultLLM = this.cfg.llm ?? new EchoLLM()` (deterministic test double); `llms/openai.ts:48` — `if (!this.apiKey) throw …`; `bootstrap.ts:574` — OpenAI selected **only** when `OPENAI_API_KEY` is set ⇒ interface without production-provider evidence |
| 7 | Voice | 0 | 0 | 0 | **0** | **zero** word-boundary `\bvoice\b` hits in any `packages/*/src`. (All prior substring hits were `invoice` — verified.) |
| 8 | Marketing | 0 | 0 | 0 | **0** | universal-distribution-nervous-system inert / sandbox-only |
| 9 | General agent tasks | 0 | 0 | 0 | **0** | `orbital-intelligence-service.ts:271` — `if (registration.environment !== 'sandbox')` refuses non-sandbox; `unified-loop` is in-process, single-task, sandbox adapters only |

**Computation (exact rational arithmetic, v1.1 R1):**

```
k          = 0                      (modalities with P_m > 0)
Σ P_m      = 0
μ_present  = 0                      (defined as 0 when k = 0, v1.1 §2)
q_07b      = (k/9) × μ_present = (0/9) × 0 = 0      exactly
```

**Self-audit identity check (v1.1 A4):** `q_07b = (k/9) × μ_present = 0` — **PASS**.

| Result | Value |
|---|---|
| `q_07b` | **0** exactly |
| **D07b score** | **0.0000000 / 2.25 rubric points** |
| Change vs frozen record | **0.0000000 pp** (independently recomputed; agrees with the frozen value) |

**Interpretation.** Under v1.1 X3, one fully complete modality earns exactly
`1/9` of D07b = **0.25 rubric points**, and can never earn more. D07b's ceiling
is therefore reached only by breadth across all nine modalities — a material
planning constraint for the Prompt Compiler milestone.

---

## 3. All fifteen dimensions — PROVISIONAL status

Score columns are **UNSCORABLE** except D07b, because the numeric schedule is
unrecovered. "Blocking gates" lists gates whose *existence* is established even
where their *thresholds* are not.

### D01 — Security

| Field | Value |
|---|---|
| Capability status | **PARTIAL (strong core, adversarial-agent surface open)** — A-01 fail-closed boundary; RLS + `FORCE ROW LEVEL SECURITY` with fail-closed `rls-probe`; single durable PostgreSQL authority; INV-15 ambient `'*'` eliminated |
| Evidence status | **VERIFICATION** for the S-1…S-10 substrate and P2-S4 (fresh, this phase); **PRIMARY** for source inspection |
| Evidence coefficient | numeric **UNRECOVERED**; class = VERIFICATION |
| Freshness | **CURRENT** — re-executed 2026-09-11 at this SHA |
| Verified score | **UNSCORABLE** |
| Remaining gap | prompt-injection, confused-deputy, tool-abuse, indirect-instruction, sandbox/workload containment, SSRF, cross-tenant RAG/cache isolation — all **explicitly UNRESOLVED** per `P2_S4_VERIFICATION_REPORT.md` §10.4 |
| Blocking gates | critical security gates (list UNRECOVERED); P3 containment |
| Required next evidence | adversarial agent-authorization suite under contained execution, committed E4 |

### D02 — Identity / access

| Field | Value |
|---|---|
| Capability status | **PARTIAL** — OIDC (JWKS-pinned, provider-neutral), identity/session/privilege/delegation stores, JTI replay, 8 `p2.production.*` posture invariants. **Absent:** MFA/TOTP, SAML, ABAC, ReBAC, PAM, KMS/HSM, break-glass (all contract-only) |
| Evidence status | **VERIFICATION** (S4, this phase); **PR-ATTESTATION** for S2; **VERIFICATION** for S3 |
| Evidence coefficient | numeric **UNRECOVERED** |
| Freshness | **CURRENT** for S4; historical for S2/S3 |
| Verified score | **UNSCORABLE** |
| Remaining gap | S7 key seam → S5 MFA/federation → S6 break-glass; ABAC/ReBAC/PAM; KMS/HSM provider (D2) |
| Blocking gates | T1 account-takeover residual (HIGH until MFA); dimension floor value UNRECOVERED |
| Required next evidence | RFC 6238 TOTP vectors; step-up staleness boundary table; A-26/A-12/A-23 |

### D03 — Core architecture

| Field | Value |
|---|---|
| Capability status | **IMPLEMENTED** — 51 workspaces, single authoritative PostgreSQL security state, event-surface contract, T-05 durable event delivery, T-06 CAS sequence integrity |
| Evidence status | **VERIFICATION** (R2 + fresh full-suite run this phase) |
| Freshness | **CURRENT** |
| Verified score | **UNSCORABLE** |
| Remaining gap | integration hardening; general durable workflow units |
| Blocking gates | none specific identified |
| Required next evidence | maintained green full-suite on each promoted artifact |

### D04 — Agent / execution

| Field | Value |
|---|---|
| Capability status | **PARTIAL** — 34-stage governed loop with fail-closed POLICY/SAFETY/AUTHORITY/HUMAN_OR_REGULATORY_GATE; A-01 envelope + pre-side-effect enforcement; budgets + rate limits; loop-host durable leases. **Absent:** distributed execution, hard worker isolation, general compensation |
| Evidence status | **VERIFICATION** (execution + enforcement suites) |
| Freshness | **CURRENT** |
| Verified score | **UNSCORABLE** |
| Remaining gap | containment (P3); distributed execution; kill-9 mid-transaction harness |
| Blocking gates | P3 containment |
| Required next evidence | node-loss / kill-9 harness; contained-execution proof |

### D05 — AI / model intelligence

| Field | Value |
|---|---|
| Capability status | **MISSING** — `ILLM` + `EchoLLM` + `ScriptedLLM` + key-gated OpenAI adapter only. No evaluation, no cross-model deliberation, no hallucination control |
| Evidence status | **PRIMARY** (source inspection); no runtime production-provider evidence |
| Freshness | n/a (nothing to age) |
| Verified score | **UNSCORABLE**; capability = 0 by inspection |
| Remaining gap | the entire dimension (P4) |
| Blocking gates | P3 governed egress; D2 for production keys |
| Required next evidence | production-provider execution evidence — `EchoLLM` and key-gated interfaces score **0** under V3/V4 |

### D06 — Model Fabric

| Field | Value |
|---|---|
| Capability status | **MISSING** — **0 source hits**; no router, registry, cost/latency-aware routing, fallback, or evaluation |
| Evidence status | **PRIMARY** (absence verified by exhaustive grep) |
| Verified score | **UNSCORABLE**; capability = 0 |
| Remaining gap | the entire dimension (P4) |
| Blocking gates | P3 governed egress (routing is an egress decision) |
| Required next evidence | routing/fallback/cost behaviour under production providers |

### D07 — Autonomous Prompt Compiler

| Field | Value |
|---|---|
| Capability status | **MISSING** — 0 source hits. `unified-loop` is a governed orchestrator over capability contracts, **not** a prompt-compilation pipeline |
| Evidence status | **PRIMARY** |
| **D07b verified score** | **0.0000000 / 2.25** — see §2 (the only scored unit in this scorecard) |
| D07a / D07c / D07d | **UNSCORABLE** — unit specifications are v1.0-only and absent |
| Remaining gap | all nine modalities × (C · I · Q) |
| Blocking gates | P4 Model Fabric (compiler execution/refinement needs a real model substrate) |
| Required next evidence | per-modality nine-row input manifest per v1.1 A1 |

### D08 — Knowledge / memory

| Field | Value |
|---|---|
| Capability status | **PARTIAL (dev class)** — brute-force flat index; `HashEmbeddingModel` deterministic hash-trick (no external calls); chunker; tenant-context; hash-chained `commercial-memory`. **Absent:** ANN, RAG isolation, forgetting/deletion semantics |
| Evidence status | **VERIFICATION** for tenant-isolation behaviour; **PRIMARY** for retrieval class |
| Freshness | **CURRENT** |
| Verified score | **UNSCORABLE** |
| Remaining gap | production vector persistence/ANN; governed memory; cross-tenant RAG isolation; memory lifecycle |
| Blocking gates | P3 (isolation) |
| Required next evidence | adversarial cross-tenant RAG probe suite; retrieval-poisoning tests |

### D09 — Commerce / economics

| Field | Value |
|---|---|
| Capability status | **PARTIAL** — per-currency money + wallet + injected FX; revenue ledger; reconciliation; hash-chained ledgers. **No PSP, no external money movement** (`payments/src/module.ts:12`); simulated payments explicitly cannot be verified as real revenue (`payments-service.ts:236`) |
| Evidence status | **VERIFICATION** for money-integrity; **PRIMARY** for the PSP absence |
| Freshness | **CURRENT** |
| Verified score | **UNSCORABLE** |
| Remaining gap | real PSP integration, settlement/refunds/disputes, production-class metering |
| Blocking gates | external PSP (P6) |
| Required next evidence | production PSP evidence; T09 L-1…L-8 register closure |

### D10 — Product / UX

| Field | Value |
|---|---|
| Capability status | **MISSING** — **zero** `.tsx` / `.html` / `.vue` files in the repository. CLI only |
| Evidence status | **PRIMARY** (absence verified) |
| Verified score | **UNSCORABLE**; capability = 0 |
| Remaining gap | the entire dimension |
| Blocking gates | owner strategy decision (canonical-build vs dormant-stream port vs integration program) |
| Required next evidence | product surface + production API gateway |

### D11 — Production infrastructure

| Field | Value |
|---|---|
| Capability status | **MISSING** — no DNS/TLS/HA/PITR/DR/backup artifacts. Boot invariants and fail-closed configuration exist |
| Evidence status | **PRIMARY** |
| Verified score | **UNSCORABLE** |
| Remaining gap | the entire dimension (P7) |
| Blocking gates | production qualification; D3 role provisioning |
| Required next evidence | real infrastructure evidence — not simulated |

### D12 — Reliability / distributed systems

| Field | Value |
|---|---|
| Capability status | **PARTIAL** — 8-/32-process contention, restart/orphan-lease/GC evidence, 911 transactions with **0 serialization and 0 deadlock retries** (`docs/verification/r2-perf.json`). **Absent:** kill-9 mid-transaction harness |
| Evidence status | **VERIFICATION** (multi-process suites re-run green this phase) |
| Freshness | **CURRENT** |
| Verified score | **UNSCORABLE** |
| Remaining gap | kill-9/node-loss harness; failover; outage injection (S8) |
| Blocking gates | S8 requires S1–S7 |
| Required next evidence | A-17…A-23 on the exact final artifact |

### D13 — Observability / operations

| Field | Value |
|---|---|
| Capability status | **PARTIAL** — `commercial-observability` service; audit event streams; `r2-perf` harness. **Absent:** OpenTelemetry / Prometheus / exporters (0 hits), alerting, incident response |
| Evidence status | **PRIMARY** |
| Freshness | **CURRENT** |
| Verified score | **UNSCORABLE** |
| Remaining gap | metrics/tracing exporters; alerting; runbooks; incident response |
| Blocking gates | P7 |
| Required next evidence | exporter output + alert-firing proof |

### D14 — Testing / assurance

| Field | Value |
|---|---|
| Capability status | **IMPLEMENTED (strong)** — **1,417 tests, 0 skipped, 0 failed**; fail-hard embedded-PostgreSQL harness (`test/r2-pg.ts` **throws**, never skips); 20-case adversarial matrix; lint 0 errors; secret scan 0 findings |
| Evidence status | **VERIFICATION** — full suite re-executed this phase at this SHA |
| Freshness | **CURRENT (2026-09-11, M1)** |
| Verified score | **UNSCORABLE** |
| Remaining gap | P1C-OBS-01 **RESOLVED at M1** (4 harnesses remediated; false-negative skip path eliminated; CI detector made deterministic and failing; +6 mutation-proven regression tests). Still open: G10 attribution |
| Blocking gates | **G10 OPEN** — "no unexplained mandatory CI/test failure" (now formally dispositioned as evidence-blocked: log retained server-side, egress-unreachable) |
| Required next evidence | G10 log retrieval from an egress-capable environment |

### D15 — Governance / autonomy

| Field | Value |
|---|---|
| Capability status | **PARTIAL** — normal Git history, PR-based merges, `docs/verification` durability convention, posture invariants, honest SKIP-vs-PASS CI step. **Defect:** ruleset `20134880` has `required_approving_review_count: 0` and **no `required_status_checks`** |
| Evidence status | **VERIFICATION** — ruleset read live via API this phase |
| Freshness | **CURRENT** |
| Verified score | **UNSCORABLE** |
| Remaining gap | AG-1/R-9 merge-gate hardening — **still NOT applied at M1 closure**; the exact reversible payload and read-back verification are prepared and the item is formally dispositioned **HUMAN ADMIN REQUIRED** (`administration:write` not granted to the available token; 403 confirmed, no bypass attempted). Also: report-durability rule |
| Blocking gates | independent verification; human merge authorization |
| Required next evidence | post-change ruleset read-back showing `required_approving_review_count: 1` and a `required_status_checks` rule with context `build · lint · test` |

---

## 4. Cross-dimension observations

1. **Evidence, not capability, is the binding constraint.** The frozen capability
   index (44.375%) qualifies down to 9.484375%. The largest available lever is
   raising evidence class — which is why S2's PR-ATTESTATION cap and G10's open
   state matter more than their code volume suggests.
2. **Three dimensions are entirely absent from source** (D05, D06, D10) and one
   is absent in substance (D07). All four are downstream of P3/P4.
3. **D14 and D15 are the strongest dimensions** and both are cheap to improve —
   they need governance and evidence work, not features.
4. **No dimension may be credited from documentation.** Model Fabric, Prompt
   Compiler, MFA, SAML, ABAC, ReBAC, PAM, KMS/HSM, break-glass, execution
   acceleration, and the product surface are all recorded **MISSING** despite
   extensive specification, per v1.1 V3/V4 and the standing no-roadmap-credit
   rule.

---

## 5. Status

| Item | Status |
|---|---|
| Scorecard class | **PROVISIONAL** |
| Units scored | **1 of 60** (D07b only) |
| Units unscorable | **59 of 60** — numeric schedule UNRECOVERED |
| Published total percentage | **NONE — deliberately withheld** |
| Upgrade condition | owner-supplied authoritative v1.0 numeric schedule, then a separate versioned rubric review (P0R-RUB-03 proper) |
| Renormalization | **NOT performed** (v1.1 X1/X2) |
| Roadmap/documentation credit | **NOT awarded** anywhere |

---

*End of P0R-95 provisional scorecard. One unit scored; fifty-nine unscorable; no
percentage fabricated.*
