# Phase A — Governance, Security Dependency Map, Acceleration Assessment & Critical Path

| Field | Value |
|---|---|
| Record type | Phase A authoritative record — governance gate, security dependency map, acceleration architecture assessment, ranked critical path |
| Authorization | Phase A — Evidence, Governance & Critical-Path Unlock |
| Date of record | 2026-09-11 (UTC) |
| Canonical baseline | `2455c59e8462ca203e9d57788792acb32e5cdad9` |
| Working branch | `arena/01a08e8a-jata-qi` |
| Scope discipline | **ZERO-FEATURE.** No S7/S5/S6/S8, no Model Fabric, no Prompt Compiler, no DAG, no P3, no deployment. |

Companion records produced by this phase:

| Deliverable | Artifact |
|---|---|
| B — canonical v1.1 publication | `docs/rubric/JATA-P0-95-v1.1.md` (byte-identical promotion) |
| C — P0R-RUB-03 provenance | `docs/verification/P0R_RUB_03_PROVENANCE_RECONSTRUCTION.md` |
| D — provisional scorecard | `docs/rubric/P0R-95_SCORECARD.md` |
| E — S2 backfill | `docs/verification/P2_S2_VERIFICATION_REPORT.md` |
| F — S3 backfill | `docs/verification/P2_S3_VERIFICATION_REPORT.md` |
| G/H/I — A-16, A-24, F6 | `docs/verification/P2_S4_F6_REVERIFICATION.md` |
| A/J/K/L | **this document** |

---

# PART A — GOVERNANCE MERGE GATE

## A.1 Current state (verified live, 2026-09-11)

Ruleset `20134880` ("Jata Qi"), `target: branch`, `enforcement: active`,
`conditions.ref_name.include: ["refs/heads/main"]`, `current_user_can_bypass: "never"`.

| Rule | Current parameters | Assessment |
|---|---|---|
| `deletion` | — | **adequate** — prevents branch deletion |
| `non_fast_forward` | — | **adequate** — prevents force-push / history rewrite |
| `pull_request` | `required_approving_review_count: **0**`<br>`required_review_thread_resolution: true`<br>`dismiss_stale_reviews_on_push: false`<br>`require_code_owner_review: false`<br>`require_last_push_approval: false`<br>`require_extra_approval_for_unattributed_changes: false`<br>`allowed_merge_methods: [merge, squash, rebase]` | **DEFICIENT** — zero required approvals |
| `required_status_checks` | **ABSENT** | **DEFICIENT** — CI is not a merge gate |

**Confirmed exposure:** a pull request can be merged into `main` with **zero
human approvals** and **failing or entirely absent CI**.

**Realized instance:** PR #30 (P2-S2) merged and the subsequent `main` run
**failed** at "Test (all workspaces)" — recorded in
`docs/verification/P2_S2_VERIFICATION_REPORT.md` §4. This is the second instance
of the class after G10.

## A.2 Minimum change required

Exactly **two** additions. Nothing existing is weakened.

| # | Change | From → To |
|---|---|---|
| 1 | `pull_request.parameters.required_approving_review_count` | `0` → **`1`** |
| 2 | new rule `required_status_checks` | absent → **`[{ context: "build · lint · test" }]`** |

The context string `build · lint · test` is the verified job name
(`.github/workflows/ci.yml:30`) and the verified check-run name on canonical
(`gh api …/commits/2455c59…/check-runs` → `name=[build · lint · test]`).

**Preserved unchanged:** `deletion`, `non_fast_forward`,
`required_review_thread_resolution: true`, `allowed_merge_methods`,
`enforcement: active`, the `refs/heads/main` condition, and
`current_user_can_bypass: "never"`.

`strict_required_status_checks_policy` is set to **`false`** deliberately — this
is the minimum change. Setting it `true` (require branches up to date before
merging) is a **strengthening** that changes merge friction, and is therefore
recorded as an owner decision rather than silently imposed.

## A.3 EXECUTION STATUS — **BLOCKED BY TOKEN SCOPE**

> **The governance change could NOT be applied in this phase.**

| Step | Command | Result |
|---|---|---|
| Read ruleset | `gh api repos/POWERBot-1/JATA-Qi/rulesets/20134880` | **success** — full payload retrieved |
| Backup | written to `RULESET_20134880_BACKUP_PRE_PHASE_A.json` (outside the repo) | success |
| **Apply change** | `gh api -X PUT repos/POWERBot-1/JATA-Qi/rulesets/20134880 --input <payload>` | **HTTP 403 — `Resource not accessible by integration`** |
| Corroborating scope probe | `gh api repos/POWERBot-1/JATA-Qi --jq .permissions` | `{admin:false, maintain:false, pull:false, push:false, triage:false}` |
| Corroborating scope probe | `gh api user` | **403 — Resource not accessible by integration** |
| Contrast: contents write | `git push origin arena/01a08e8a-jata-qi` | **success** — new branch created |

**Diagnosis:** the available credential is a GitHub **App installation token**
with `contents: write` (push and PR creation work) but **without
`administration: write`** (ruleset mutation is refused). This is a credential
scope limitation, not a repository or logic error.

**Required human action** — a maintainer with an admin-scoped token runs:

```bash
gh api -X PUT repos/POWERBot-1/JATA-Qi/rulesets/20134880 --input - <<'JSON'
{
  "name": "Jata Qi",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "exclude": [], "include": ["refs/heads/main"] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": false,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": false,
        "allowed_merge_methods": ["merge", "squash", "rebase"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [ { "context": "build · lint · test" } ] } }
  ]
}
JSON
```

**Verification after application** (independent read-back — must show both controls):

```bash
gh api repos/POWERBot-1/JATA-Qi/rules/branches/main \
  --jq '.[] | "\(.type): \(.parameters)"'
# expect: required_approving_review_count: 1
# expect: required_status_checks: [{"context":"build · lint · test"}]
```

**Reversibility:** the pre-change payload is preserved byte-for-byte in
`RULESET_20134880_BACKUP_PRE_PHASE_A.json`; restoring it via the same `PUT`
reverts exactly. The change is auditable through GitHub's ruleset history and
this record.

## A.4 Governance-gate status

| Item | Status |
|---|---|
| Deficiency identified and evidenced | **DONE** |
| Minimum reversible patch prepared and verified against live schema | **DONE** |
| Patch applied | **BLOCKED — `administration: write` not granted to the available token** |
| Independent post-change verification | **PENDING human application** |
| **Overall** | **OPEN — requires human admin action** |

**This is not concealed or worked around.** No attempt was made to bypass the
permission boundary.

---

# PART J — SECURITY DEPENDENCY MAP

Implementation is **not** performed in this phase. This map establishes
dependency, evidence requirement, verification requirement, criticality, and
likely critical-path position for every unresolved security item.

Current state anchor: `P2_S4_VERIFICATION_REPORT.md` §10.4 records
prompt-injection, confused-deputy, sandbox-escape, tool-abuse,
indirect-instruction, and cross-tenant RAG-cache contamination as **explicitly
UNRESOLVED**. §10.5 records KMS/HSM, HA/PITR, and advanced identity as tracked
and out of S4 scope.

| # | Item | Current status (source-verified) | Dependency | Evidence requirement | Verification requirement | Criticality | Critical-path position |
|---|---|---|---|---|---|---|---|
| J-1 | **Agent/tool authorization** | **PARTIAL** — A-01 fail-closed envelope, pre-side-effect enforcement, budget+rate, delegation narrowing | none (substrate exists) | adversarial agent-authorization suite | independent E4 under adversarial inputs | **CRITICAL** | now (analysis) → P3 |
| J-2 | **Prompt-injection resistance** | **MISSING** — model output is never an authority source (good) but no screening/filtering exists | P3 | injection corpus + measured refusal | independent adversarial E4 | **CRITICAL** | P3 |
| J-3 | **Confused-deputy resistance** | **MISSING** | P3, J-1 | deputy-confusion scenario suite | independent E4 | **CRITICAL** | P3 |
| J-4 | **Sandbox / workload containment** | **MISSING** — `runUnderEnvelope` wrapper only; no hard isolation | P3 | escape-attempt suite; process/namespace isolation proof | independent E4 | **CRITICAL** | **P3 — hard prerequisite for acceleration** |
| J-5 | **Tool abuse resistance** | **MISSING** | P3, J-1 | abuse-pattern suite | independent E4 | **HIGH** | P3 |
| J-6 | **Cross-tenant AI / RAG / cache isolation** | **MISSING** — tenant RLS exists at the storage layer; no RAG- or cache-layer isolation | P3, P4 | cross-tenant probe suite (must show invisibility, not just refusal) | independent E4 | **CRITICAL** | P3/P4 |
| J-7 | **Account takeover / advanced identity** | **PARTIAL** — OIDC landed; **no MFA/step-up** | S7 → S5 | RFC 6238 vectors; step-up staleness table | A-26 green + independent E4 | **CRITICAL** (T1 HIGH) | **S7 → S5** |
| J-8 | **SSO / OIDC maturity** | **IMPLEMENTED (provider-neutral)** — `OidcAuthenticator`, JWKS-pinned, private-key JWK refusal | S1 ✓ | real-IdP operational evidence (P2-GAP-13) | operational verification | MEDIUM | operational, not implementation |
| J-9 | **SAML** | **MISSING** — contract declaration only (`contracts.ts`) | S5 (seam spec only, no code) | seam contract compiles + spec doc | contract test | LOW (Phase A scope) | S5 (seam only) |
| J-10 | **ABAC** | **MISSING** — 0 source hits | S1 ✓ | attribute-policy suite | independent E4 | MEDIUM | post-S8 |
| J-11 | **ReBAC** | **MISSING** — 1 contract-text hit | S1 ✓ | relation-graph suite | independent E4 | MEDIUM | post-S8 |
| J-12 | **PAM** | **MISSING** | S3 ✓, S6 | privileged-session lifecycle suite | independent E4 | MEDIUM | post-S6 |
| J-13 | **KMS / HSM** | **MISSING (contract only)** — `CredentialMaterialProvider` with `kind: 'dev-inmemory' \| 'external'`; production **refuses** the dev provider | **S7** + owner decision **D2** | §12 contract tests; revoked-key denial; rotation window; P2-INV-08 negative test | independent E4 + secret scan | **HIGH** | **S7** |
| J-14 | **HA / PITR** | **MISSING** — no infra artifacts | external infra, D3 | failover + restore-point evidence | operational verification | **HIGH** | P7 |
| J-15 | **Production identity operations** | **PARTIAL** — 8 `p2.production.*` posture invariants enforced at boot | S5, S6, S7 | posture read-back at production boot | independent E4 | HIGH | S8 |
| J-16 | **Production deployment gates** | **PARTIAL** — CI exists; **not a required merge gate** (Part A) | **Part A governance** | ruleset read-back showing both controls | independent API read | **HIGH** | **now (human action)** |
| J-17 | **Observability (security)** | **PARTIAL** — audit event streams; no OTel/Prometheus/alerting | none | exporter output + alert-firing proof | operational verification | MEDIUM | parallel (Track E) |
| J-18 | **Supply chain** | **MISSING** — no SBOM/provenance verification (T18 HIGH, accepted residual) | none | SBOM + provenance verification | independent E4 | HIGH | P7 |

## J.1 Security-critical convergence points

Three items unblock disproportionate downstream work:

1. **S7 key/secret seam** — unblocks J-7 (MFA secrets), J-12 (PAM), J-13
   (KMS/HSM), and the S6 break-glass seal. Its contract **already exists**
   (`credential-store.ts:185`), making it the cheapest high-leverage security
   item available.
2. **P3 containment** — unblocks J-2, J-3, J-4, J-5, J-6 simultaneously, and is
   the **hard prerequisite** for any execution acceleration.
3. **Governance gate (Part A)** — unblocks J-16 and prevents recurrence of the
   red-merge class that has now occurred twice.

---

# PART K — ACCELERATION ARCHITECTURE DEPENDENCY ASSESSMENT (ANALYSIS ONLY)

**No acceleration is implemented in this phase.**

## K.1 Architectural decision recorded

> **DECISION: execution acceleration MUST NOT be introduced before the security
> and containment prerequisites (P3) are understood and implemented.**

Rationale, grounded in verified current state:

| Verified fact | Consequence |
|---|---|
| `unified-loop/src/types.ts:11-12` — *"Canonical loop stages, in **mandated order** … skipping an order-dependent stage …"*; 34 stages WAKE → CONTINUE_OR_SLEEP | The loop is **sequential by design**, not by accident. Parallelisation is a rearchitecture, not a tuning change. |
| `loop-host/src/scheduler.ts` = **35 lines**, with **zero** matches for `concurren\|parallel\|Promise.all\|maxInflight\|batch` | No parallel scheduling primitive exists to extend |
| **0 source hits** for `DAG` in any `packages/*/src` | No dependency-graph substrate |
| J-2/J-3/J-4/J-5 all **MISSING** | Parallel execution would **multiply** an unresolved attack surface — N concurrent branches instead of 1 |
| Only performance evidence is `docs/verification/r2-perf.json`: decide R2 durable mean **4.026 ms** (p99 7.826), execute R2 mean **5.291 ms** (p99 7.621), 911 tx with **0 serialization / 0 deadlock retries** | The measured bottleneck is **not** the authorization path. Accelerating it would optimise the wrong thing. |

**Rework hazard:** introducing a DAG before P3 would bake parallel authority
checks into a boundary that is about to be re-shaped by containment. That is the
single largest rework risk identified in this phase.

## K.2 Primitive-by-primitive evaluation

"Safe after P3" means the primitive can be added **without rearchitecting the
security boundary**, because the A-01 envelope remains the atomic unit of
authority.

| Primitive | Feasible without rearchitecting the security boundary? | Prerequisite | Assessment |
|---|---|---|---|
| **Parallel DAG execution** | **YES — conditionally** | P3 | Safe **iff** each parallel branch independently passes the full A-01 pipeline. The envelope is already self-contained and digest-sealed, so it is a valid parallel unit. Must never allow a branch to inherit another branch's authority. |
| **Speculative execution** | **YES — conditionally** | P3 + J-4 | Only for **side-effect-free** speculation. Any speculative branch that could produce a side effect must be gated by the envelope *before* the effect, exactly as today. |
| **Cancellation of losing branches** | **YES** | DAG | Requires the DAG substrate. Cancellation must revoke in-flight leases (loop-host already has lease + GC machinery to build on). |
| **Precomputation** | **YES** | none hard | Safe for pure/deterministic stages. Must not precompute across tenant boundaries. |
| **Artifact / component caching** | **YES** | J-6 | Cache keys **must** include tenant identity or the cache becomes a cross-tenant channel. |
| **Semantic / result caching** | **YES — with isolation** | J-6 | Highest isolation risk of the caching family: semantically-similar queries from different tenants must not share entries. |
| **Incremental builds** | **YES** | none hard | Orthogonal to the security boundary. |
| **Prewarmed workers** | **YES — with care** | J-4 | A warm worker is a **warm attack surface**; must be per-tenant or fully reset between tenants. |
| **Latency-aware model routing** | **YES** | P3 governed egress, D06 Model Fabric | Routing is an egress decision; needs the governed egress plane first. |
| **Local-model fast paths** | **YES** | D06 | Reduces egress; security-positive. |
| **Frontier-model escalation** | **YES** | D06 + J-6 | Escalation must not carry tenant context to an external model without governed egress. |
| **Streaming results** | **YES** | none hard | Stream *after* authorization, never as a way to bypass it. |
| **Deadline-aware execution** | **YES** | DAG | A deadline must **never** downgrade a security gate — fail closed on deadline, not open. |
| **Execution-time prediction** | **YES** | telemetry (J-17) | Predictive, advisory only; must not influence authorization. |

## K.3 Shared primitive recommendation

The **A-01 authorization envelope is already the correct unit of parallel work**:
it is self-contained, digest-sealed, tenant-scoped, carries durable citations
(`manifestId` + `manifestDigest`, `sessionEventId`, `securityStoreTxId`), and is
re-validated at enforcement (A-24, verified this phase). An acceleration layer
built on "N independently-authorized envelopes executed concurrently" therefore
requires **no change to the security boundary** — which is precisely why P3
containment, not envelope redesign, is the true prerequisite.

**One constraint to preserve in any future design:** A-24-style enforcement-time
revalidation must run **per branch**, not once for the batch. A single batch-level
check would reintroduce the stale-manifest window that A-24 closes.

---

# PART L — RANKED CRITICAL PATH (3–5 MILESTONES)

Ranking function, as authorized:

```
value = (score gain × security importance × dependency reduction × evidence leverage)
        ÷ (implementation cost × verification cost × regression risk)
```

Score gain is expressed **qualitatively** because the v1.0 numeric schedule is
UNRECOVERED (Part C). No percentage is projected.

---

## 🥇 M1 — Governance & Evidence Closure  *(partially delivered by this phase)*

| Field | Value |
|---|---|
| Objective | Make the score measurable and the merge gate safe — with zero product code |
| Capabilities closed | L-5 rubric provenance (**CLOSED this phase**); L-4 S2/S3 evidence (**CLOSED this phase**); F6 (**CLOSED this phase**); AG-1/R-9 merge gate (**OPEN — human action**); P0R-RUB-03 numerics (**OPEN — requires owner-supplied v1.0**) |
| Dimensions affected | **D14, D15** directly; **D01, D02** indirectly (unblocks their credit); all others (makes them measurable) |
| Expected score impact | Not quantifiable. Directionally the **highest available**: frozen capability 44.375% qualifies down to 9.484375%, so evidence class — not features — is the binding constraint |
| Security impact | HIGH — closes the live red-merge exposure |
| Dependencies removed | 3 of 5 already removed by this phase |
| Implementation complexity | **XS** |
| Verification complexity | **Low** |
| Parallelization | Fully parallel; blocks nothing |
| Regression risk | **~Zero** — no product code |
| Why critical path | Without it 95% cannot be measured, security work cannot be credited, and the next PR can merge red |
| Authorize next? | **Remaining slivers only** (ruleset application + v1.0 supply) — the bulk is delivered |

## 🥈 M2 — P2-S7 Production Key/Secret Seam

| Field | Value |
|---|---|
| Objective | Convert the existing `CredentialMaterialProvider` contract into a hardened, rotating, versioned, revocable seam |
| Capabilities closed | J-13 KMS/HSM groundwork; the secret-storage half of MFA and break-glass |
| Dimensions affected | **D02** primary; D01, D11 |
| Expected score impact | Not quantifiable; closes a gate-adjacent identity gap |
| Security impact | HIGH |
| Dependencies removed | Unblocks **S5, S6, and D2** simultaneously — best dependency-reduction ratio of any implementation item |
| Implementation complexity | **S** — the contract exists (`credential-store.ts:185`) and production already refuses `dev-inmemory` |
| Verification complexity | Low–medium (§12 contract tests: signing/encryption separation, revoked-key denial, rotation window, P2-INV-08 negative test) |
| Parallelization | Parallel to Tracks E/F; **must precede S5** |
| Regression risk | Low — additive seam |
| Why critical path | Doing S5 first yields MFA over a dev double — negative-value work requiring redo |
| Authorize next? | **YES — first implementation slice** |

## 🥉 M3 — P2-S5 MFA/Federation → P2-S6 Break-Glass

| Field | Value |
|---|---|
| Objective | Close the T1 account-takeover HIGH residual; complete the privileged plane |
| Capabilities closed | J-7 (TOTP, step-up, `auth_time`), J-9 (SAML seam spec only), J-12 groundwork, break-glass lifecycle |
| Dimensions affected | **D02** primary; D01, D15 |
| Expected score impact | Not quantifiable; largest remaining identity gap |
| Security impact | **CRITICAL** — T1 is the top residual threat |
| Dependencies removed | Unblocks S6 and S8 |
| Implementation complexity | M + M |
| Verification complexity | Medium (RFC 6238 vectors, step-up staleness table, A-26/A-12/A-23) |
| Parallelization | S5 → S6 sequential; both parallel to Tracks B/E/F |
| Regression risk | Medium — touches the privilege stage; rollback is posture-config revert and stays fail-closed |
| Why critical path | Highest-severity open threat in the register |
| Authorize next? | **After M2** |

## 4️⃣ M4 — P3 Contained Execution & Governed Egress

| Field | Value |
|---|---|
| Objective | Close the entire adversarial-agent cluster recorded UNRESOLVED in S4 §10.4 |
| Capabilities closed | J-2, J-3, J-4, J-5, J-6 + governed egress + SSRF |
| Dimensions affected | **D01** primary; D04, D08, D12 |
| Expected score impact | Not quantifiable; gate-class |
| Security impact | **CRITICAL** — closes six explicitly-UNRESOLVED items at once; T8/T9 MEDIUM-HIGH, T4 MEDIUM |
| Dependencies removed | **Unblocks all execution acceleration (Part K), Model Fabric routing, and RAG isolation** — three downstream tracks |
| Implementation complexity | **L** |
| Verification complexity | **High** — adversarial suite required |
| Parallelization | Parallel to Track E; prerequisite for Track C |
| Regression risk | Medium-high — new isolation boundary |
| Why critical path | **Hard prerequisite** for the 120% acceleration requirement (Part K.1) |
| Authorize next? | **After M1's remaining slivers; not concurrent with M2/M3 in the same package family** |

## 5️⃣ M5 — P4 Production Knowledge + Model Fabric

| Field | Value |
|---|---|
| Objective | Create the largest remaining capability-credit surface |
| Capabilities closed | Production vector persistence/ANN, governed memory, retrieval-poisoning + hallucination controls, cross-tenant RAG evidence, Model Fabric (routing/cost/fallback/evaluation) |
| Dimensions affected | **D05, D06, D08** — the largest unscored surfaces outside product |
| Expected score impact | Not quantifiable; structurally the largest capability volume remaining |
| Security impact | MEDIUM directly; HIGH via J-6 |
| Dependencies removed | Unblocks **P5 Prompt Compiler**, hence all nine D07 modalities |
| Implementation complexity | **XL** |
| Verification complexity | High — requires **production-provider** evidence; `EchoLLM` and key-gated interfaces score **0** under v1.1 V3/V4 |
| Parallelization | Parallel to Track A once P3 lands |
| Regression risk | Medium |
| Why critical path | D05/D06/D07 are MISSING today (0 source hits). Note v1.1 X3: one complete modality = exactly 0.25 rubric points, so **breadth beats depth** |
| Authorize next? | **No — sequence after M1–M4** |

## L.1 Critical-path answer to "is the numbered P2 sequence the global path?"

**No.** Verified conclusions:

- **S7 must precede S5** — the spec's own graph and S5's stated dependency make
  S7 a hard prerequisite, and S7's contract already exists. The historical
  numbering (S5 → S6 → S7) is **not** the dependency order.
- **P3 outranks the P2 tail** on security criticality and on dependency
  reduction, because it unblocks the entire acceleration programme.
- **Governance/evidence (M1) outranks all implementation** on the ranking
  function, because it is near-zero cost and unblocks measurement and credit.
- **Tracks E (production infra) and F (evidence automation) are genuinely
  parallel** — they touch disjoint package families and have no dependency on the
  P2 chain.

---

# PART M — 120% COMPATIBILITY CHECK

Confirmed that nothing delivered or recommended in Phase A forecloses the 120%
architecture:

| 120% capability | Preserved by |
|---|---|
| Model Fabric | M5 is scoped as a first-class dimension (D06); no routing shortcut is baked into `agent-runtime` |
| Autonomous Prompt Compiler | D07 kept as nine separately-scored modalities (v1.1 §2); the envelope remains modality-agnostic |
| Unified orchestration | The 34-stage loop is left **unmodified** — acceleration will wrap it, not replace it |
| Governed memory | D08 scoped with lifecycle + forgetting semantics as explicit gaps |
| Cross-model deliberation | No single-model assumption introduced; `ILLM` remains pluggable |
| Knowledge extraction | Existing heuristic extractor left intact as a foundation |
| Execution acceleration | Part K establishes the envelope as the parallel unit, so acceleration needs **no boundary rearchitecture** |
| Continuous evaluation | Recommended as a **shared primitive** serving D05/D06/D07/D08 at once |
| Progressive model specialization | Left entirely open; no premature abstraction |

**Key compatibility decision:** because the A-01 envelope is retained as the
atomic authority unit, every acceleration primitive in Part K.2 can be added
later **without** revisiting the security boundary. That is the single most
important 120%-compatibility property established by this phase.

---

# PART N — PHASE A TESTING & EVIDENCE COMPLIANCE

Per the authorization's testing requirements:

| Requirement | Result |
|---|---|
| Clean working tree before starting | ✓ (verified `2455c59`, porcelain empty) |
| Exact base SHA recorded | `2455c59e8462ca203e9d57788792acb32e5cdad9` |
| Targeted tests | S4 delegation 23/23 + 22/22; S2 49/49 + 4/4 + 3/3; S3 11/11 + 18/18 + 8/8 — all **0 skipped** |
| Full regression | `npm test` → **1,411 tests, 0 fail, 0 skipped**; `Total: 50 · Passed: 50` |
| Build | all 51 workspaces pass |
| Lint | 0 errors, 60 warnings |
| Secret scan | 0 findings |
| PostgreSQL-backed security tests | ✓ real embedded PostgreSQL, fail-hard harness |
| Zero skipped mandatory tests | ✓ `skipped: 0` throughout |

## N.1 Tool-induced tracked-artifact mutation — detected, restored, documented

| Event | Handling |
|---|---|
| `npm run scan:r2` **rewrites** the tracked file `docs/verification/r2-secret-scan.json` | Detected via `git status --porcelain`; restored with `git checkout --`; `git diff --exit-code HEAD` re-verified clean. **Documented here and in the prior audit record. Never concealed.** |
| Mutation-testing edits to `packages/authorization-boundary/src/durable-decider.ts` (2 temporary mutations) | Each reverted with `git checkout --`; build re-run to exit 0; `grep -c MUTANT… dist/src/durable-decider.js` → **0**; pristine suite re-run 23/23. Proven absent. |
| `node_modules/`, `packages/*/dist/`, `.jataqi/` | All gitignored — verified via `git status --porcelain --untracked-files=all` |

---

*End of Phase A governance, security dependency map, acceleration assessment,
and critical-path record.*
