# JATA-RB-v0.1-PROPOSED — Replacement-Basis Design Specification

| Field | Value |
|---|---|
| Proposal | **JATA-RB-v0.1-PROPOSED** (Replacement Basis v0.1, PROPOSED) |
| Status | **NOT ADOPTED — PROPOSAL ONLY** |
| Date | 2026-09-27 (UTC) |
| Authority | Repository Owner authorization dated 2026-09-27 — **DESIGN ONLY** |
| Scope | Design a complete replacement scoring basis capable of measuring the JATA Qi 120% objective. Solo-builder implementation model; independent assurance remains separate and mandatory where required. |
| Canonical rubric (unchanged) | `JATA-P0-95-v1.1` (ADOPTED) at `docs/rubric/JATA-P0-95-v1.1.md` — **NOT MODIFIED by this proposal** |
| Historical record (unchanged) | Evidence-qualified baseline **9.484375% — FROZEN, v1.0-basis** — **NOT an input to this basis; NOT rescored; NOT converted** |
| Current score under this basis | **NONE — no score calculated; no assessment performed** |
| P2-E4 recognition (2026-09-27) | **Zero scoring credit under this basis; zero gate closure; zero production qualification** |
| Production qualification | **NONE claimed. This proposal qualifies nothing for production.** |

> **GOVERNANCE BOUNDARY — READ FIRST.**
> This document is a **separately versioned proposal**. It is **NOT** the canonical
> rubric, **NOT** an amendment to v1.1, and **NOT** an adoption. It authorizes no
> scoring, no reassessment, no retroactive rescoring, no gate closure, no
> implementation of product capabilities, no commit, no push, no PR, no merge, and
> no approval. It must never be silently converted into an adopted rubric. Adoption,
> if ever sought, requires a separate explicit owner authorization preceded by
> independent assurance review. Every newly introduced rule or value herein is
> labeled **NEW / PROPOSED**. Every preserved constraint cites its source.

---

## 0. How to read this proposal — labeling convention [PRESERVED principle + NEW / PROPOSED]

- **[PRESERVED from v1.1 §X]** means the rule is carried verbatim from the adopted
  v1.1 specification and is **not** new. The citation is the authority; this
  proposal adds no content to it.
- **[PRESERVED from handoff §X / P2 spec §Y]** means the rule is carried from
  existing governance material (handoff, P2 specification durability rules) and is
  **not** new.
- **[NEW / PROPOSED]** means the rule, value, table entry, equation, threshold, or
  definition is **introduced by this proposal**. It has **no standing** until
  separately assured and explicitly adopted. Nothing herein claims to recover the
  irrecoverable v1.0 numerical schedule.
- **[KNOWN ASSURANCE FINDING]** means a recorded open issue that this proposal
  **does not silently correct**. Findings remain open.

**This proposal does not claim to recover v1.0.** It is a **new design**, not a
reconstruction. No numerical value is left "by reference" to the missing v1.0;
every value needed to reproduce scores is stated explicitly with exact rationals.

---

## 1. Provenance stance [PRESERVED + NEW / PROPOSED]

1.1. The authoritative `JATA-P0-95-v1.0` numerical schedule has been declared
**IRRECOVERABLE** by the owner following exhausted recovery. This proposal
**does not dispute, revisit, or repair** that declaration. **[PRESERVED — owner declaration, restated]**

1.2. This basis is **separately versioned** as `JATA-RB-v0.1-PROPOSED` and is
**mathematically independent** of v1.0 and v1.1. Scores computed under this basis
(if ever adopted and assessed) would be **RB-basis scores**, incomparable to
v1.0-basis or v1.1 figures. No conversion, delta, or carry-forward exists or is
defined. **[NEW / PROPOSED]**

1.3. The historical `9.484375%` figure is **preserved unchanged** as the frozen
v1.0-basis record (v1.1 §10). It is **never used as an input** to any equation,
calibration, coefficient, weight, floor, gate, threshold, or worked example in
this basis. Its only appearance in proposal artifacts is in this preservation
statement and in the change/provenance record as a frozen reference. **[PRESERVED
figure; NEW / PROPOSED non-use rule]**

1.4. This proposal **never retroactively rescores** any historical artifact,
**never assigns a score to current `main`** or to any SHA, and **calculates no
assessment score of any kind**. Worked examples in §23 use **synthetic
hypothetical inputs only**, bear no SHA, and are not assessments. **[NEW / PROPOSED]**

1.5. P2-E4 recognition (2026-09-27, `P2_E4_RECOGNITION_DISPOSITION.md`) is a
governance recognition. Under this basis it confers **zero points, zero gate
closure, and zero production qualification**. Any future RB-basis assessment must
re-verify under RB admissibility and independence rules; no credit is inherited
from that recognition. **[NEW / PROPOSED]**

---

## 2. Preserved v1.1 constraints [PRESERVED]

The following are carried from the adopted v1.1 specification without change.
Citations are to `docs/rubric/JATA-P0-95-v1.1.md`. This proposal **changes none
of them**. Any future RB change to a D07b rule would be labeled
**NEW PROPOSED RULE** with explicit justification; **no such change is proposed
here — D07b is preserved verbatim**.

| # | Constraint | v1.1 source | Treatment here |
|---|---|---|---|
| P-01 | Total rubric weight **100%** | §9 | PRESERVED; RB total is also 100 points by explicit RB definition (§10), not by derivation |
| P-02 | **15 dimensions** | §9 | PRESERVED count; RB dimension definitions are NEW / PROPOSED (§4) |
| P-03 | **4 top-level units per dimension** | §9, §1 | PRESERVED count; RB unit specs are NEW / PROPOSED except D07b (§5) |
| P-04 | **60 top-level scoring units** | §9 | PRESERVED count (15×4=60 identity verified in checks) |
| P-05 | **D07 weight 9%** | §2, §9 | PRESERVED value |
| P-06 | **D07b unit weight 2.25 points; per-modality share 0.25 points exactly** | §2 | PRESERVED values |
| P-07 | **Nine D07 modalities** (Coding, Architecture, Website/building, Image, Video, Copy, Voice, Marketing, General agent tasks) | §2 | PRESERVED list |
| P-08 | **D07b MOP rule**: `q_07b = (1/9) × Σ[m=1..9] (C_m × I_m × Q_m)`; `Q_m = E_m × f_m` | §1, §2 | PRESERVED verbatim; RB generalizes the per-unit conjunction pattern rubric-wide as NEW / PROPOSED (§9) without altering D07b |
| P-09 | **Dimension formula for D07**: `D_07 = 100 × (q_07a+q_07b+q_07c+q_07d)/4`, each q ∈ [0,1] | §1 | PRESERVED for D07; RB extends the same mean-of-four form to all dimensions as NEW / PROPOSED (§9) |
| P-10 | **M1–M4** (equal shares; per-modality conjunction; partials scored as-is; no hidden weighting) | §3 | PRESERVED for D07b |
| P-11 | **X1–X3** (fixed denominator 9; missing ⇒ zeros; proportionality identity `q_07b=(k/9)×μ_present` and cap) | §4 | PRESERVED for D07b; RB extends fixed-denominator/no-renormalization rubric-wide as NEW / PROPOSED (§20) |
| P-12 | **V1–V5** (per-modality evidence/freshness entry; no grade upgrading; inspection ≠ runtime verification; historical ≠ current E4; evidence never closes gates) | §5 | PRESERVED principles; RB evidence mapping and admissibility implement them as NEW / PROPOSED (§§7, 17) |
| P-13 | **R1–R4** (exact arithmetic; 7-dp half-up display once at final display; comparisons on exact values; order independence) | §6 | PRESERVED for D07b; RB extends rubric-wide as RB-R1…RB-R4, NEW / PROPOSED (§18). This is the separate versioned review contemplated by the v1.1 §6 scope note (P0R-RUB-03 preserved) — as a proposal, not an adoption |
| P-14 | **A1–A4** (nine-row input manifest; independent reproduction identical; disputes by definitions; self-audit identity) | §8 | PRESERVED for D07b; RB extends rubric-wide as RB-A1…RB-A4, NEW / PROPOSED (§19) |
| P-15 | **C × I × Q methodology** (unit score is the product of capability, integration, and evidence-after-freshness) | §9, §1 | PRESERVED methodology; RB unit equation instantiates it for all 60 units as NEW / PROPOSED (§9) |
| P-16 | **E0–E6 framework existence; freshness model existence** | §5, §9 | PRESERVED existence only; all coefficient values and the freshness function are NEW / PROPOSED (§§7, 8) because v1.0 values are irrecoverable and v1.1 preserves them only by reference |
| P-17 | **95% release threshold existence; 100% baseline existence; 120% stretch framework existence; critical/high gates existence; dimension floors existence** | §9 | PRESERVED existence only; all semantics, values, lists, and mechanics are NEW / PROPOSED (§§10–15) |
| P-18 | **No hidden weighting** | §3 M4, §9 | PRESERVED principle; RB weights are all explicit (§§4, 5) |
| P-19 | **Frozen worksheet** (44.375% / 36.6875% / 9.484375% / 6.6484375%–14.875% / 0-of-20 / NOT READY) | §10 | PRESERVED as historical record; not inputs (see §1.3) |
| P-20 | **Prospective-only; no retroactive rescoring; no capability credit by specification act** | §0, §10, §11 | PRESERVED principle; RB prospective-only treatment is NEW / PROPOSED (§21) |
| P-21 | **Stretch gating conditions** (95% achieved; all mandatory release/security gates pass; stretch capability implemented; independent evidence) | Handoff §12 (governance material) | PRESERVED conditions; RB stretch mechanics implementing them are NEW / PROPOSED (§14) |
| P-22 | **E4 = separate-party verification of the exact artifact; E5 = production-qualified artifact; report-durability rule** | P2 spec §19 rules 1–5 (governance material) | PRESERVED wording of the class meanings and durability rule; RB coefficients E4=3/4, E5=7/8 and rubric-wide application are NEW / PROPOSED (§§7, 17) |
| P-23 | **No roadmap/documentation credit; implementation-without-independent-verification earns no points where E4+ is required** | Handoff §11; P1-CLOSURE §7–8 (governance material) | PRESERVED principle; RB C/I/E scales enforce it as NEW / PROPOSED (§§6, 7) |

**Justification for zero changes:** v1.1 is the adopted specification. A
replacement basis must not silently rewrite adopted governance material. All RB
content that goes beyond v1.1 is confined to elements v1.1 preserves only by
reference (values irrecoverable) or to rubric-wide generalizations v1.1
explicitly leaves to a separate versioned review. D07b is byte-identical in
rule; only the surrounding RB framework is new.

---

## 3. Known assurance findings [KNOWN ASSURANCE FINDING — OPEN, NOT CORRECTED]

### AF-RB-01 — v1.1 §11 D07b divergence-maximum figure [KNOWN ASSURANCE FINDING]

- **v1.1 §11 recorded value:** the two competent D07b readings (mean-of-products
  vs product-of-means) "diverge by up to **35.6652949** percentage points of D07b
  on ordinary inputs, including 18.6556927 pp in the one-missing-modality case."
  **[PRESERVED — v1.1 text, not altered]**
- **Reported mathematical supremum:** **38.4087791 pp**. **[RECORDED as a reported
  value; provenance: owner authorization of 2026-09-27 stating a recently
  identified v1.1 §11 numerical issue]**
- **Disposition:** **OPEN assurance finding.** This proposal **does not adjudicate**
  which figure is correct, **does not recompute** the divergence, **does not amend**
  v1.1 §11, and **does not import either figure as an RB input**. The v1.1 rule
  (MOP) is unaffected by this descriptive discrepancy: the rule is preserved in §9
  regardless of which divergence magnitude is correct.
- **Required follow-up (not in this design phase):** a separately assured exact-
  rational analysis of `sup |MOP − POM|` over `[0,1]^27`, with domain statement
  (whether "ordinary inputs" restricts the domain), must precede any correction of
  v1.1 §11. Correction, if ever warranted, requires its own versioned assurance
  review and explicit owner authorization — never a silent edit. **[NEW / PROPOSED
  follow-up requirement]**

### AF-RB-02 — Unresolved v1.1 assurance items carried [PRESERVED status]

G10 (OPEN), G19 (UNRECOVERED), P0R-RUB-02/03/04 (RECORDED/CANDIDATE), and the
historical R2 record (PRESERVED) retain exactly the statuses in v1.1 §12. This
proposal neither closes nor re-opens them. RB gates CG-05 (no unattributed
mandatory failure) and RB provenance rules are **new forward-looking controls**;
they do not retroactively disposition G10/G19. **[PRESERVED statuses; NEW /
PROPOSED forward controls]**

---

## 4. Dimensions — definitions and weights [NEW / PROPOSED except D07 weight]

### 4.1 Dimension table [NEW / PROPOSED definitions and weights; D07 weight PRESERVED]

Dimension labels below reuse the conventional D01–D15 vocabulary used in prior
audits **as explicitly adopted new definitions**, because P0R-RUB-03 establishes
that the v1.0 ID↔domain mapping was never recovered and prior labels were
convention only. Reuse of the same strings does **not** claim recovery; each
definition here is **NEW / PROPOSED** in full.

Weights are exact rationals. Percent means rubric points out of 100.

| Dim | Name [NEW / PROPOSED] | Scope definition [NEW / PROPOSED] | Weight (exact) [NEW / PROPOSED unless noted] |
|---|---|---|---|
| D01 | Security | Fail-closed authorization boundary; tenant isolation at the data plane; credential/secrets hygiene; adversarial agent-authorization resistance; audit integrity. | **13/2 % = 6.5** |
| D02 | Identity / access | Identity lifecycle; authentication (OIDC, MFA/TOTP, step-up); sessions/tokens; privilege plane; delegation; break-glass; key-management seam. | **13/2 % = 6.5** |
| D03 | Core architecture | Kernel lifecycle; module composition; event-surface contracts; durable delivery; storage abstraction integrity; configuration assurance. | **13/2 % = 6.5** |
| D04 | Agent / execution | Governed execution loop; tool boundary enforcement; budgets/rate limits; durable leases/queue/checkpoints; containment of workers. | **13/2 % = 6.5** |
| D05 | AI / model intelligence | Production model adapters; evaluation; cross-model deliberation; hallucination/uncertainty controls; no credit for doubles/interfaces alone. | **13/2 % = 6.5** |
| D06 | Model Fabric | Model router/registry; cost/latency-aware routing; fallback; provider health; evaluation harness for routing decisions. | **13/2 % = 6.5** |
| D07 | Autonomous Prompt Compiler | Prompt-compilation pipeline and the nine breadth modalities (see P-07). Breadth-gated: ceiling requires all nine modalities. | **9 % [PRESERVED from v1.1 §2, §9]** |
| D08 | Knowledge / memory | Ingestion/chunking; retrieval quality; tenant-scoped RAG isolation; memory lifecycle (retention/forgetting/deletion); poisoning resistance. | **13/2 % = 6.5** |
| D09 | Commerce / economics | Money integrity (per-currency, wallets, FX); revenue ledger; reconciliation; billing; PSP integration; no simulated revenue credited as real. | **13/2 % = 6.5** |
| D10 | Product / UX | Product surface; API gateway; operator workflows; accessibility/usability baselines; docs that are themselves tested. | **13/2 % = 6.5** |
| D11 | Production infrastructure | Provisioned infra (DNS/TLS/HA/PITR/DR/backups); deployment pipeline; environment parity; secret-provider wiring. | **13/2 % = 6.5** |
| D12 | Reliability / distributed systems | Contention/restart/outage/failover behavior; exactly-once semantics; multi-process safety; measured resilience on prod-like substrate. | **13/2 % = 6.5** |
| D13 | Observability / operations | Metrics/traces/logs export; alerting with firing proof; incident response; runbooks; health surfacing. | **13/2 % = 6.5** |
| D14 | Testing / assurance | Suite completeness; fail-hard harnesses; adversarial matrices; mutation hygiene; zero-skip enforcement; reproducibility records. | **13/2 % = 6.5** |
| D15 | Governance / autonomy | Merge gates; review/approval integrity; report durability; decision/audit chains; autonomy bounds with human authorization. | **13/2 % = 6.5** |

### 4.2 Weight identity [NEW / PROPOSED]

Let `w_d` be the weight of dimension `d` in rubric points:

- `w_D07 = 9` **[PRESERVED]**.
- `w_d = 13/2 = 6.5` for every other `d` **[NEW / PROPOSED]**.
- **Identity:** `Σ_d w_d = 14 × (13/2) + 9 = 91 + 9 = 100` exactly.
  Machine check: `14 × 13 = 182; 182/2 = 91; 91 + 9 = 100`. **[NEW / PROPOSED —
  neutral equal-weight prior]**

**Rationale (why equal weights for the 14 unrecovered dimensions):** with v1.0
irrecoverable, any differentiated allocation would invent false precision. An
equal split of the residual `91` points (`91/14 = 13/2` exactly, no rounding) is
the unique neutral, auditable, exactly-representable prior that preserves the
D07=9 anchor. Differentiation, if ever desired, requires post-adoption evidence
and a versioned review — it is listed as unresolved design question UQ-01.

---

## 5. Scoring units — the 60-unit catalog [NEW / PROPOSED except D07b rule]

### 5.1 Unit-weight rule [NEW / PROPOSED]

Each dimension's four top-level units split the dimension weight **equally**
**[NEW / PROPOSED — equal quarter split]**:

- For `d ≠ D07`: unit weight `u_{d,x} = w_d / 4 = (13/2)/4 = 13/8 = 1.625` points.
- For D07: unit weight `u_{07,x} = 9/4 = 2.25` points **[PRESERVED for D07b;
  NEW / PROPOSED extension of the equal-quarter principle to D07a/c/d — numerically
  identical to the preserved D07b weight, so no D07b change]**.
- D07b modality share: `2.25/9 = 1/4 = 0.25` points exactly **[PRESERVED]**.
- **Identity:** `Σ_{60 units} u = 14×4×(13/8) + 4×(9/4) = 14×(13/2) + 9 = 100` exactly.

### 5.2 Catalog pointer [NEW / PROPOSED]

The complete 60-unit catalog is the companion file
`JATA-RB-v0.1-UNIT-CATALOG.md` (60 entries: D01a–D15d). Each entry states unit
ID, name, scope, capability-complete criteria, integration criteria, minimum
evidence guidance, weight, and linked gates. The catalog is **normative to this
proposal** (if ever adopted) and **NOT ADOPTED** today. D07b's entry restates the
preserved MOP rule; the other 59 entries are **NEW / PROPOSED** in full.

### 5.3 D07b preservation [PRESERVED — no NEW PROPOSED RULE for D07b]

D07b is governed **solely** by v1.1 §1–§5 as preserved in §2 (P-08 through P-12).
This proposal introduces **no new D07b aggregation, weighting, denominator,
missing-modality, evidence-entry, or rounding rule**. The RB rubric-wide rules
(§§9, 18–20) are generalizations that **coincide with** the D07b rules on D07b
inputs; where any future conflict were found, the preserved D07b rule would
prevail for D07b unless a **NEW PROPOSED RULE** explicitly superseding it were
adopted — and **none is proposed here**.

---

## 6. C and I grading scales [NEW / PROPOSED]

### 6.1 General rules [NEW / PROPOSED]

- RB-C1. `C, I ∈ {0, 1/4, 1/2, 3/4, 1}` exactly. No other values are admissible.
  Assessors select the **highest level whose every criterion holds**; if any
  criterion of a level fails, the grade is at most the next lower level. No
  interpolation, no rounding-up, no partial-credit heuristics.
- RB-C2. Grades cite **executable implementation on the exact assessed artifact**
  (file paths + line spans or test IDs at the assessed SHA). Documentation,
  interfaces without executable implementation, mocks without production-provider
  evidence, and planned capabilities earn **no C credit above C0** (preserved
  no-roadmap-credit principle, P-23).
- RB-C3. For D07b modalities, `C_m`/`I_m` use these same scales. (v1.1 grades D07b
  factors "under the existing capability/integration scale" — the existing scale
  text being irrecoverable, this proposal supplies the scale as NEW / PROPOSED.
  This is a **gap-filling definition**, not a change to the D07b aggregation rule.)

### 6.2 Capability scale [NEW / PROPOSED]

| Level | Value (exact) | Criteria (all required) |
|---|---|---|
| C0 Absent | `0/1 = 0` | No executable implementation of the unit's scope on the assessed artifact; or only docs/interfaces/doubles. |
| C1 Minimal executable | `1/4 = 0.25` | Executable happy-path exists and is invoked by at least one committed test on the exact artifact; known gaps are enumerated in a committed register; no adversarial handling claimed. |
| C2 Substantial executable | `1/2 = 0.5` | All major specified behaviors executable; enumerated gaps are minor and bounded; at least one negative/adversarial case per major behavior is committed and green. |
| C3 Complete executable | `3/4 = 0.75` | Every specified behavior executable with full positive + negative coverage committed and green; concurrency/restart behavior specified and tested where applicable; zero known functional gaps. |
| C4 Complete + hardened | `1/1 = 1` | C3 plus: adversarial matrix green, multi-process contention green where applicable, production-posture suites green, and a committed hardening note with exact commands/SHA. |

### 6.3 Integration scale [NEW / PROPOSED]

| Level | Value (exact) | Criteria (all required) |
|---|---|---|
| I0 Unintegrated | `0/1 = 0` | Not invoked in the canonical composition; standalone library, dead code, or test-only wiring. |
| I1 Dev/test composition only | `1/4 = 0.25` | Wired in development/test composition with at least one committed integration test; absent from the canonical production composition path. |
| I2 Canonical single-plane | `1/2 = 0.5` | Invoked in the canonical composition for one plane/consumer; failure propagation is fail-closed and tested. |
| I3 Canonical multi-plane | `3/4 = 0.75` | Integrated across all applicable planes/consumers; cross-package suites green; boot/configuration invariants cover the wiring. |
| I4 Fully integrated + regression-guarded | `1/1 = 1` | I3 plus: integration covered by fail-hard suites with zero-skip enforcement on the exact artifact; wiring changes break named regression tests (proven by a committed mutation or negative control). |

---

## 7. E0–E6 evidence coefficients and class mapping [NEW / PROPOSED values and mapping]

### 7.1 Coefficients [NEW / PROPOSED]

| Class | Coefficient (exact) | Meaning [NEW / PROPOSED wording; E4/E5 core meanings PRESERVED from P2 spec §19] |
|---|---|---|
| E0 | `0/1 = 0` | None / unverifiable / inadmissible. No qualifying evidence. |
| E1 | `1/8 = 0.125` | Attestation-only: PR body/comment attestation, chat, uncommitted report, self-assertion without cited artifact. Below PRIMARY. |
| E2 | `1/4 = 0.25` | PRIMARY: directly inspected canonical artifact at a cited SHA, or executed command output with recorded environment — implementer-produced and same-agent allowed. |
| E3 | `1/2 = 0.5` | PRIMARY+ durable: E2 plus a committed evidence pack on the exact SHA (implementation evidence doc + assertion-level results + full-suite green + adversarial matrix where applicable), committed before assessment. Same-agent allowed. |
| E4 | `3/4 = 0.75` | Separate-party verification of the exact artifact (committed report by a genuinely separate party stating identity, environment, and independence basis; exact SHA + configuration; findings register + remediation record). |
| E5 | `7/8 = 0.875` | Production-qualified: E4 plus production-posture proof on the exact artifact (real providers/infrastructure, not doubles/simulation; production configuration evidenced). |
| E6 | `1/1 = 1` | Replicated production-qualified: E5 plus independent replication (a second separate party replicates the verification or the production proof is independently re-executed) with durability (committed, hash-pinned inputs/outputs) and current freshness. |

Identities: `0 = E0 < E1 < E2 < E3 < E4 < E5 < E6 = 1`, all in `[0,1]`, all exact
binary fractions (denominator 8). E0=0 and E6=1 exactly. Monotonicity is machine-checked.

**Rationale:** the E4 step (`1/2 → 3/4`) is the largest single premium because
independence is the binding assurance constraint (preserved P-23); E5/E6 reward
production reality and replication without dwarfing the independence premium.
Spacing is exactly representable and deliberately coarse to avoid false precision
(UQ-02).

### 7.2 Class mapping and caps [NEW / PROPOSED mapping; V3–V5 principles PRESERVED]

| Observed evidence | Maximum RB class | Notes |
|---|---|---|
| UNVERIFIED (asserted, nothing cited) | E0 | Scores zero through Q=0. |
| PR-ATTESTATION (PR body/comment, no committed artifact) | E1 | Never higher; chat/screenshots/sandbox transcripts without a committed record are E1 at best. |
| Source-code inspection (same-agent or owner) | E2, or E3 with a committed durable pack | **Never E4+** (V3 preserved: inspection ≠ runtime verification). |
| Executed command output (same-agent, exact SHA, recorded env) | E2, or E3 with a committed durable pack | Same-agent capped at E3 (see §17). |
| CI-class (workflow-reported green; metadata observed; raw logs not independently inspected) | E2 | **Never E4+**; CI is not a separate party. |
| HISTORICAL (authoritative past-milestone record, not re-executed) | E2 | **Never E4+** (V4 preserved); additionally freshness-decayed (§8); never automatically equivalent to a current E4 artifact. |
| VERIFICATION (separate-party, exact artifact, committed report meeting §17) | E4 | The standing RB threshold for release-relevant credit. |
| Production proof + E4 (real provider/infra, exact artifact) | E5 | Doubles/simulation explicitly disqualified. |
| Replication of E5 by a second separate party (or independent re-execution) | E6 | Both reports committed; inputs/outputs hash-pinned. |

**Best-qualifying-class rule [NEW / PROPOSED]:** each unit (each D07b modality)
is graded at the **single best qualifying class** whose **every** criterion holds
on the exact assessed artifact. Evidence does not stack, average, or upgrade:
two E2 packs do not make E3; an E4 report with an SHA mismatch is not E4.

**No-grade-upgrading [PRESERVED V2]:** aggregation, freshness, or auditor
judgment never raises an evidence class. Only better evidence raises the class.

---

## 8. Freshness and decay rules [NEW / PROPOSED]

### 8.1 Evidence dating [NEW / PROPOSED]

- RB-F1. Every graded unit (every D07b modality) declares an **evidence date**
  `t_e` (UTC): for committed reports/packs, the first-commit timestamp on
  canonical `main` of the evidence artifact; for executed outputs, the recorded
  execution date (UTC). The assessment declares an **assessment date** `t_a`
  (UTC). Both are calendar dates (`YYYY-MM-DD`).
- RB-F2. **Age** `a = t_a − t_e` in whole UTC calendar days (date subtraction,
  non-negative integer). Future-dated evidence (`a < 0`) is **inadmissible**:
  the unit's evidence is rejected and `f = 0` with a recorded anomaly.
- RB-F3. **Exact-artifact freshness:** if the evidence artifact's SHA (or
  configuration identity) differs from the assessed SHA/configuration, the
  evidence is **not current** regardless of age: `f = 0` unless the evidence is
  re-executed/re-verified on the exact artifact and re-dated.

### 8.2 Decay table [NEW / PROPOSED]

| Age `a` (days) | Freshness `f` (exact) | Label |
|---|---|---|
| `0 ≤ a ≤ 30` | `1/1 = 1` | CURRENT |
| `31 ≤ a ≤ 90` | `3/4 = 0.75` | RECENT |
| `91 ≤ a ≤ 180` | `1/2 = 0.5` | AGING |
| `181 ≤ a ≤ 365` | `1/4 = 0.25` | STALE |
| `a ≥ 366`, or SHA/config mismatch, or future-dated | `0/1 = 0` | EXPIRED |

Boundaries are inclusive as stated; there are no gaps and no overlaps
(machine-checked). `f ∈ [0,1]`, monotonically non-increasing in `a`.

### 8.3 Entry point [PRESERVED V1 principle; NEW / PROPOSED rubric-wide application]

- RB-F4. Freshness enters **once, per unit, before aggregation**: `Q_u = E_u × f_u`.
  For D07b, freshness enters **per modality**: `Q_m = E_m × f_m` **[PRESERVED V1
  for D07b]**. Stale evidence in one unit/modality decays or zeroes only that
  unit/modality share; it is never averaged away.
- RB-F5. No RB evidence class incorporates freshness in its coefficient; `f`
  always applies separately. (The v1.1 §2 `f_m ≡ 1` proviso for classes that
  already incorporate freshness is preserved in principle but vacuous under RB
  coefficients.)

---

## 9. Scoring equations [PRESERVED methodology; NEW / PROPOSED rubric-wide equations]

### 9.1 Standard units — 59 units (all except D07b) [NEW / PROPOSED]

For each standard unit `u`:

- `E_u ∈ {0, 1/8, 1/4, 1/2, 3/4, 7/8, 1}` (best qualifying class, §7).
- `f_u ∈ {0, 1/4, 1/2, 3/4, 1}` (decay table, §8).
- `Q_u = E_u × f_u ∈ [0,1]`.
- `C_u, I_u ∈ {0, 1/4, 1/2, 3/4, 1}` (§6).
- **Unit score:** `q_u = C_u × I_u × Q_u ∈ [0,1]`.
- **Unit contribution:** `p_u = u_w × q_u` points, where `u_w` is the unit weight
  from §5.1 (`13/8` points, or `9/4` for D07a/c/d).

### 9.2 D07b — preserved MOP rule [PRESERVED from v1.1 §1–§5]

For each modality `m = 1..9`:

- `Q_m = E_m × f_m`, `P_m = C_m × I_m × Q_m ∈ [0,1]`.
- **Unit score:** `q_07b = (1/9) × Σ[m=1..9] P_m ∈ [0,1]`.
- **Contribution:** `p_07b = (9/4) × q_07b` points (max 2.25).
- Fixed denominator 9; missing ⇒ zeros; `q_07b = (k/9) × μ_present ≤ k/9`
  (X1–X3 preserved). Each modality share max `1/4 = 0.25` points.

C/I/E/f vocabularies for D07b modalities are the RB scales (§§6–8), which fill
the irrecoverable "existing scale" references as NEW / PROPOSED gap-fillers. The
aggregation rule itself is unchanged.

### 9.3 Dimension scores [PRESERVED for D07; NEW / PROPOSED for all others]

For every dimension `d` with units `{a,b,c,d}`:

- `D_d = 100 × (q_{d,a} + q_{d,b} + q_{d,c} + q_{d,d}) / 4`, each `q ∈ [0,1]`,
  so `D_d ∈ [0,100]`.
- For D07 this is exactly the preserved v1.1 formula (P-09). For all other
  dimensions it is the **NEW / PROPOSED** extension of that form.

### 9.4 Baseline score [NEW / PROPOSED]

- **Baseline (evidence-qualified) score:**
  `S = Σ_{all 60 units u} p_u = Σ_u (u_w × q_u)` points, `S ∈ [0,100]`.
- Equivalent weighted-dimension form (identity, machine-checked):
  `S = Σ_d w_d × (Σ_{u∈d} q_u)/4`.
- `S` is the **only** quantity compared to the 95% release threshold and the
  100% baseline definition. Stretch never enters `S`.

---

## 10. 100% baseline mechanics and normal-score maximum [NEW / PROPOSED]

- RB-B1. **Normal-score maximum:** `S_max = 100` points exactly. Proof: each
  `q_u ≤ 1` (product of factors each ≤ 1), so `S = Σ u_w q_u ≤ Σ u_w = 100` (§5.1
  identity), with equality iff every `q_u = 1`.
- RB-B2. **100% definition:** `S = 100` **iff** every one of the 60 units has
  `q_u = 1`. For standard units this requires `C_u = I_u = 1` and `Q_u = 1`
  (hence `E_u = E6 = 1` with `f_u = 1`, since `Q = E×f = 1` with `E,f ≤ 1`
  requires `E = f = 1`). For D07b it requires all nine `P_m = 1` (hence every
  modality at `C=I=1`, `E6`, current). **100% therefore requires replicated
  production-qualified, current evidence for every unit and every D07b modality.**
  This strictness is deliberate: it preserves the evidence-as-binding-constraint
  principle (P-23).
- RB-B3. **100% ≠ release and ≠ production qualification.** `S = 100` satisfies
  the numerical component of release but release additionally requires floors and
  gates (§§11–13). Production qualification is a separate E5-gated determination
  (§12, CG-08); a high or perfect `S` never constitutes it.

---

## 11. Dimension floors [NEW / PROPOSED]

### 11.1 Floor table [NEW / PROPOSED]

Let `F_d` be the minimum dimension score `D_d` (0–100 scale) required for any
release claim. Comparisons use exact values (RB-R3, §18).

| Tier [NEW / PROPOSED] | Dimensions | Floor `F_d` (exact) [NEW / PROPOSED] |
|---|---|---|
| Security-critical | D01, D02, D11 | `80/1 = 80` |
| Execution assurance | D04, D12, D14, D15 | `70/1 = 70` |
| Capability breadth | D03, D05, D06, D07, D08, D09, D10, D13 | `50/1 = 50` |

### 11.2 Floor predicate [NEW / PROPOSED]

- RB-FL1. **Floors-met predicate:** `FLOORS_MET ⇔ ∀d: D_d ≥ F_d` (exact comparison).
  A single dimension below its floor denies release regardless of `S`.
- RB-FL2. **Compatibility identity:** the minimum baseline consistent with all
  floors is `S_min_floors = Σ_d w_d × F_d / 100 = 61.05` points exactly
  (computation: `3×(13/2)×(4/5) + 4×(13/2)×(7/10) + 7×(13/2)×(1/2) + 9×(1/2)`
  `= 78/5 + 91/5 + 91/4 + 9/2 = 1221/20 = 61.05`). Since `61.05 < 95`, floors and
  the 95% threshold are jointly feasible. Machine-checked.

---

## 12. Critical and high gates [NEW / PROPOSED]

### 12.1 Gate semantics [NEW / PROPOSED]

- RB-G1. Every gate is a **boolean predicate** over the exact assessed artifact
  and its committed evidence. Verdicts are `PASS` or `FAIL`. There is no partial,
  weighted, or compensated gate outcome.
- RB-G2. **All critical gates and all high gates must be PASS** for any release
  claim, regardless of `S`. Gates are evaluated **independently** of q-scores:
  no `Q`, `q`, `D`, `S`, or stretch value satisfies, substitutes for, or waives
  a gate (V5 preserved).
- RB-G3. **No waivers.** This proposal defines no waiver, exception, or expiry
  mechanism. If a waiver mechanism is ever desired, it requires a versioned
  review (UQ-03).
- RB-G4. Gate evidence must meet the stated minimum class **on the exact
  artifact** with current-or-recent freshness (`f ≥ 3/4`, i.e. age ≤ 90 days and
  SHA match), unless the gate row states otherwise.

### 12.2 Critical gates [NEW / PROPOSED]

| ID | Gate [NEW / PROPOSED] | Predicate (PASS iff) [NEW / PROPOSED] | Min evidence [NEW / PROPOSED] |
|---|---|---|---|
| CG-01 | Tenant isolation enforced | Cross-tenant probe suite (canary read/write refusal + no-context blindness) is green on the exact artifact; every durable read path is tenant-scoped or on the committed enumerated-exception list. | E4 |
| CG-02 | Authorization fail-closed | Every externally consequential invocation traverses the enforced boundary; no fail-open path exists; the ordered deny pipeline + enforcement-point checks are green including negative controls. | E4 |
| CG-03 | No unresolved CRITICAL finding | The committed findings register contains zero findings with severity CRITICAL in state OPEN. | E3 (register) + E4 (verification that the register is complete for the artifact) |
| CG-04 | Exact-artifact promotion | Assessed SHA == released SHA; tree clean; configuration identity match; no uncommitted delta; promotion record committed. | E3 |
| CG-05 | No unattributed mandatory failure | Every required check (per the committed required-checks list) is green on the exact SHA, or has a committed attribution with root cause and disposition. No unattributed red. | E3 (records) + E4 (attribution audit for any non-green check) |
| CG-06 | Independent verification present | Committed separate-party (E4-meeting §17) verification reports cover D01, D02, D14, and D15 on the exact SHA; each report states identity, environment, and independence basis. | E4 (the reports themselves) |
| CG-07 | Secrets hygiene | The committed secret scan is clean (zero findings) on the exact tree; no credential material appears in audit/diagnostic/durable records (asserted by test). | E3 (scan) + E4 (verification of scan scope) |
| CG-08 | Production honesty | Any production claim (provider access, live money, deployed infra, SLO) is evidenced at E5+ on the exact artifact; artifacts without E5 carry an explicit non-production disclaimer. No production qualification is implied by any score. | E5 for each production claim; E3 for the disclaimer record |

### 12.3 High gates [NEW / PROPOSED]

| ID | Gate [NEW / PROPOSED] | Predicate (PASS iff) [NEW / PROPOSED] | Min evidence [NEW / PROPOSED] |
|---|---|---|---|
| HG-01 | MFA/step-up for privileged ops | Privileged-plane operations require MFA/step-up with tested staleness boundaries; no privilege path bypasses step-up in tests. | E4 |
| HG-02 | Break-glass controlled | Break-glass activation is one-shot with terminal records and a review-deadline state machine (pending→due→reviewed/overdue-alert); all sub-cases green. | E4 |
| HG-03 | Audit durability | Action/decision audit is append-only with retention ≥ 30 days and tamper-evidence; GC interlocks refuse to delete live exactly-once state. | E3 |
| HG-04 | Backup/restore drilled | A restore drill from a real backup is green within the freshness window (age ≤ 90 days); RTO/RPO stated and met. | E4 (E5 where prod-DR proof is claimed) |
| HG-05 | Observability live | Metrics/traces export on the assessed configuration; at least one alert rule has committed firing proof; health reflects authoritative checks. | E3 |
| HG-06 | SLOs met | Every committed SLO (latency/error/cost where applicable) measures green over its stated window on the assessed configuration. | E3 (E5 for prod-SLO claims) |
| HG-07 | Supply-chain hygiene | SBOM + lockfile committed; no HIGH-or-above dependency vulnerability older than 30 days without a committed disposition; build reproducible from lockfile. | E3 |
| HG-08 | Runbooks complete | Operator runbooks are committed for every failure class in the outage matrix; a fresh-operator drill record exists within the freshness window. | E3 |
| HG-09 | Evidence freshness | Zero units/modalities/points rely on EXPIRED evidence (`f = 0`) at the assessment date; all SHA/config identities match the assessed artifact. | E3 (manifest audit) |
| HG-10 | HIGH-findings hygiene | Zero HIGH findings are OPEN without a committed disposition; accepted HIGHs carry an expiry ≤ 90 days and are re-verified at expiry. | E3 + E4 (disposition audit) |

### 12.4 Gates that remain gates (never points) [NEW / PROPOSED]

Tenant isolation, fail-closed authorization, exact-artifact promotion, mandatory-
failure attribution, independent-verification presence, secrets hygiene, and
production honesty are **gates**, not stretch points and not bonus credit. No
stretch point rewards them; no high baseline compensates their failure.

---

## 13. 95% release threshold and comparison semantics [PRESERVED existence; NEW / PROPOSED semantics]

- RB-T1. **Threshold value:** `95/1 = 95` points. Existence PRESERVED from v1.1 §9
  and handoff §5; the value 95 is the preserved threshold. **[PRESERVED value]**
- RB-T2. **Release predicate [NEW / PROPOSED]:**
  `RELEASE_READY ⇔ (S ≥ 95) ∧ FLOORS_MET ∧ (∀ critical gates PASS) ∧ (∀ high gates PASS)`,
  where `S` is the baseline only (stretch excluded), and every comparison uses
  exact values (RB-R3). `S = 94.9999999…` (exact) does **not** pass; `S = 95`
  exactly passes its numerical conjunct.
- RB-T3. **Stretch never counts toward release.** `T` and `S_total` are ignored by
  RB-T2. Earning stretch points before release does not contribute to `S` and (by
  §14 gating) yields `T = 0` until release predicates hold.
- RB-T4. **Release ≠ production qualification.** `RELEASE_READY` is an assessment
  outcome about the scored artifact and its evidence. Production deployment
  additionally requires CG-08 satisfaction for every production claim and whatever
  operational authorizations the owner requires. No score constitutes deployment
  authorization.

---

## 14. 120% stretch mechanics [PRESERVED existence + gating conditions; NEW / PROPOSED mechanics]

### 14.1 Structure [NEW / PROPOSED]

- RB-S1. **Twenty stretch points**, `ST = {ST-C01…C05, ST-I01…I05, ST-V01…V05,
  ST-P01…P05}` (§15). Each point is worth exactly `1/1 = 1` point. Each is binary:
  `t_j ∈ {0, 1}` — earned (1) or not (0). No partials.
- RB-S2. **Additive:** `T = Σ[j=1..20] t_j ∈ {0, …, 20}`.
- RB-S3. **Gated (prerequisites):** let `PRE ⇔ (S ≥ 95) ∧ FLOORS_MET ∧
  (∀ critical gates PASS) ∧ (∀ high gates PASS)` — i.e. the release predicate
  RB-T2. Then the **effective stretch score** is `T_eff = PRE ? T : 0`. Stretch
  evidence gathered before `PRE` holds is recorded but yields zero until `PRE`
  holds; it must still be fresh (HG-09) when credited.
- RB-S4. The gating conditions of handoff §12 are preserved and implemented as:
  (1) 95% achieved = `S ≥ 95`; (2) gates pass = floors + all gates PASS;
  (3) stretch capability implemented = point acceptance criteria met (§15);
  (4) independent evidence = point evidence thresholds met (≥ E4, or ≥ E5 for
  production points). **[PRESERVED conditions; NEW / PROPOSED implementation]**
- RB-S5. **Total:** `S_total = S + T_eff ∈ [0, 120]`. Maximum `120/1 = 120`
  exactly, attained iff `S = 100` and `T = 20` with `PRE` holding.
- RB-S6. **120% definition:** `S_total = 120` iff `S = 100` (every unit `q = 1`)
  and all 20 stretch points earned with `PRE` holding. **120% does not imply
  production qualification** (CG-08 and E5 rules still apply per claim).
- RB-S7. **Independence of points:** each point requires its **own** evidence pack
  and (where stated) its **own** separate-party verification. One report may
  support multiple points only if it contains a separately-labeled, separately-
  reproducible section per point; shared boilerplate without per-point evidence
  earns nothing.

### 14.2 Entry flow [NEW / PROPOSED]

1. Assess the 60-unit baseline → `S`, floors, gates.
2. Evaluate `PRE`. If false: publish baseline outcome; `T_eff = 0`; stop (stretch
   evidence may be collected for the future but credited at zero).
3. If true: evaluate each of the 20 points against §15 (binary each).
4. `S_total = S + T_eff`. Publish per RB-A1 (60-row manifest + 20-row stretch
   manifest + gate table).

## 15. The 20 stretch points [NEW / PROPOSED]

Each point: 1 point, binary, independently evidenced. "Min E" is the minimum
evidence class for the point's own pack on the exact artifact; E4+ always requires
§17 independence. Solo-builder path per point: the owner may implement and
document alone; where Min E ≥ E4, a separate party must verify (assurance, not
product-building — see §16).

### 15.1 Capability points (5) [NEW / PROPOSED]

| ID | Point [NEW / PROPOSED] | Acceptance [NEW / PROPOSED] | Min E [NEW / PROPOSED] |
|---|---|---|---|
| ST-C01 | Autonomous multi-step task completion | A ≥ 5-step governed task graph completes end-to-end with approvals honored; human gates trip correctly in negative controls. | E4 |
| ST-C02 | Cross-modal synthesis | One governed run fuses ≥ 3 D07b modalities with pinned provenance; output cites per-modality sources. | E4 |
| ST-C03 | Continual learning with guardrails | Feedback loop improves a committed metric across two assessed windows without authority escalation (proven by invariant suites). | E4 |
| ST-C04 | Adversarial robustness | Prompt-injection + confused-deputy + tool-abuse + indirect-instruction suites green under contained execution with independent containment proof. | E4 |
| ST-C05 | Cost/latency-aware routing at scale | Router honors budgets over a 7-day measured window; accounting reconciles; fallback never silently degrades quality. | E4 |

### 15.2 Integration points (5) [NEW / PROPOSED]

| ID | Point [NEW / PROPOSED] | Acceptance [NEW / PROPOSED] | Min E [NEW / PROPOSED] |
|---|---|---|---|
| ST-I01 | Production IdP federation | Real IdP (OIDC; SAML if claimed) authenticates production logins; JWKS rotation exercised; outage fails closed. | E5 |
| ST-I02 | Real PSP settlement | Real PSP authorize/capture/refund/dispute cycle completes with ledger reconciliation; no simulated money in the proof. | E5 |
| ST-I03 | Multi-cloud deployment | Health-verified deployments on ≥ 2 providers from the same artifact; drift clean on both. | E5 |
| ST-I04 | Ecosystem API | Versioned public API with contract tests + compatibility suite; two minor versions supported simultaneously in tests. | E4 |
| ST-I05 | External connector mesh | ≥ 3 live connectors with health/credential/rotation lifecycle green; revocation propagates within the stated bound. | E5 |

### 15.3 Verification points (5) [NEW / PROPOSED]

| ID | Point [NEW / PROPOSED] | Acceptance [NEW / PROPOSED] | Min E [NEW / PROPOSED] |
|---|---|---|---|
| ST-V01 | Independent security audit | External audit report (distinct auditor, own environment) with findings register; all CRITICAL/HIGH dispositioned. | E4 (auditor is the separate party; report committed) |
| ST-V02 | Chaos and fault injection | Kill-9/node-loss/outage/partition matrix green on prod-like substrate; blast radius bounded and evidenced. | E4 |
| ST-V03 | Supply-chain SLSA L3 | Signed provenance + SBOM + hermetic build statement verified by a separate party on the exact artifact. | E4 |
| ST-V04 | Formal property verification | At least three stated invariants model-checked or proof-checked with committed models and reproducible runs. | E4 |
| ST-V05 | Red-team exercise | Scoped red-team report with objectives, methods, and findings; objectives not met by the team is itself recorded (no clean-bill inference). | E4 |

### 15.4 Production points (5) [NEW / PROPOSED]

| ID | Point [NEW / PROPOSED] | Acceptance [NEW / PROPOSED] | Min E [NEW / PROPOSED] |
|---|---|---|---|
| ST-P01 | SLO sustained 30 days | Committed SLOs green over 30 consecutive days on production; measurement independently re-executed. | E5 |
| ST-P02 | Zero-downtime migration drill | Migration completes with zero loss and zero downtime per committed criteria; rollback path drilled. | E5 |
| ST-P03 | DR failover drill | Failover meets committed RTO/RPO; drill report with timelines committed. | E5 |
| ST-P04 | Commercial operation | Real revenue recognized with hash-chained ledger proof and PSP reconciliation; refunds/disputes handled. | E5 |
| ST-P05 | Scale test | Committed load profile sustained (throughput + p95 + error budget) on prod-like substrate; independent re-execution. | E5 |

### 15.5 Point categories summary [NEW / PROPOSED]

Capability: ST-C01…C05 (5). Integration: ST-I01…I05 (5). Verification:
ST-V01…V05 (5). Production: ST-P01…P05 (5). Total 20. Evidence thresholds:
E4 for 10 points (all capability, ST-I04, all verification); E5 for 10 points
(ST-I01/I02/I03/I05, all production). Every point requires independence (≥ E4);
**no stretch point is earnable on same-agent evidence alone.**

---

## 16. Solo-builder workflow and independence [NEW / PROPOSED workflow; PRESERVED independence]

### 16.1 Operating model [NEW / PROPOSED]

- RB-SB1. The owner as solo builder may, alone: implement product capabilities;
  write and execute tests; run harnesses and drills; author implementation
  evidence packs; commit artifacts and records; operate staging/development
  infrastructure; and prepare assessment manifests. All such work products are
  **implementer-produced** and capped at **E3** (§17).
- RB-SB2. Engaging separate parties **for assurance** (verification, audit,
  red-team, replication) does **not** violate the solo-builder model: verifiers
  must not author, review-for-merge, approve, merge, or direct product work on
  the assessed artifact. Assurance participation is not product-building
  participation. The builder must preserve this separation in records (commit
  authorship, review lists, and the independence basis of each report).

### 16.2 Builder-to-verifier handoff [NEW / PROPOSED]

- RB-SB3. For each E4+ verification the builder provides: exact artifact SHA +
  configuration identity; scope statement; environment specification; evidence
  pack (E3); and an explicit statement that **no expected conclusion is supplied
  and FAIL may be issued without permission**.
- RB-SB4. The builder must not: share credentials, tokens, or private keys with
  the verifier; direct, revoke, or inspect the verifier's access/device/
  environment; supply prepared conclusions; or condition payment/relationship on
  PASS. Any such act voids the report's E4+ eligibility.
- RB-SB5. The verifier works under §17 (own identity, environment, judgment,
  custody of raw logs) and commits (or delivers for commit with custody
  statement) the report before any assessment credit.
- RB-SB6. Builder evidence generation checklist (per unit/point): implement →
  test (positive + negative) → execute on exact SHA → record environment →
  commit pack → date evidence → declare SHA match → submit for verification
  (E4+) or assessment (≤ E3).
- RB-SB7. A solo builder can therefore reach any `S` value on ≤ E3 evidence
  alone (mathematically: with all `C = I = 1`, `E3`, fresh, `q = 1/2` per unit,
  `S = 50`), but **release (95) and stretch (any) require E4+** and hence
  separate parties. The maximum same-agent-only baseline is `S = 50` with fresh
  E3 everywhere (and lower with any decay or imperfection) — a deliberate
  assurance property, not a defect.
- RB-SB8. No agent session may certify its own work as independent assurance
  (see RB-IV8). Builder-operated automation (including AI agents directed by the
  builder) is same-agent evidence regardless of its sophistication.

### 16.3 Why 120% remains achievable for a solo builder [NEW / PROPOSED analysis]

The builder performs 100% of product work alone. The only human involvement
required beyond the builder is **assurance**: separate parties who verify, audit,
and replicate without building. This matches the authorization: solo
implementation with mandatory independent assurance. The cost is assurance
engagement, not team-building — and the proposal states every E4+/E5 requirement
explicitly so the builder can plan them.

## 17. Evidence admissibility and independence rules [NEW / PROPOSED + PRESERVED V3–V5]

### 17.1 Admissibility [NEW / PROPOSED]

- RB-EA1. **Admissible:** committed files at a cited SHA on canonical `main`;
  executed command outputs with recorded environment (tool versions, config,
  date); CI metadata (capped at E2); separate-party reports meeting §17.2 and
  the durability rule (committed before assessment credit; naming convention per
  the assessment plan).
- RB-EA2. **Inadmissible as scoring evidence (E1 at best, E0 where nothing is
  cited):** chat messages; PR bodies/comments (attestation only); screenshots;
  uncommitted local reports; sandbox transcripts without a committed record;
  and unrecorded assertions of any kind. (PR comments may attest that a canonical report exists;
  the report itself must be in the tree — preserved P2 §19 rule 2.)
- RB-EA3. **Same-agent cap:** evidence produced by the builder, the builder's
  agents/automation, or any party that authored/reviewed/approved/merged the
  assessed artifact is capped at **E3** and is **never E4+**, regardless of
  quality, rigor, or honesty labeling.
- RB-EA4. **CI cap:** CI-class evidence is capped at **E2** and is never E4+.
- RB-EA5. **Historical cap:** historical records are capped at **E2** and are
  freshness-decayed (V4 preserved). A historical E4 report about a past SHA is
  not a current E4 artifact.
- RB-EA6. **Inspection cap:** source-code inspection is capped at **E3** and is
  never runtime verification (V3 preserved).

### 17.2 Independence (separate-party test) [NEW / PROPOSED]

A report qualifies as E4+ only if **every** element holds (each recorded in the
report or its custody record):

- RB-IV1. **Distinct identity:** the verifier is a different person/system
  identity than the builder/implementer, with stated name and account/identity
  basis.
- RB-IV2. **Non-participation:** the verifier did not author, review-for-merge,
  approve, merge, or direct the assessed artifact or its product work (verified
  against commit authorship and review lists for the assessed scope).
- RB-IV3. **Independent environment:** the verifier's own machine/infra with a
  stated manifest (OS, toolchain, config) and custody statement; the builder
  cannot direct, revoke, or inspect it.
- RB-IV4. **Independent judgment:** the verifier chose and interpreted the work;
  FAIL was available without permission; no expected conclusion was supplied
  (itemized owner-side inputs listed).
- RB-IV5. **Authentication separation:** the verifier used their own credentials;
  no builder-issued token, deploy key, or shared secret (stated).
- RB-IV6. **Raw-log custody:** verifier-retained raw logs, hashes, and manifests
  under verifier control, sufficient to reproduce the conclusion.
- RB-IV7. **Relationship/tooling disclosure:** familial, household, financial,
  organizational relationships and AI/tooling use disclosed; the assessment
  records any accepted residual (disclosure is mandatory; the assessment states
  whether the residual was accepted and why).
- RB-IV8. **No self-certification:** no agent session (including any AI-assisted
  session directed by or on behalf of the builder) may certify its own work as
  independent assurance. Builder-operated automation is same-agent by definition.

Failure of any element caps the report at E3. Corroboration gaps are recorded as
gaps, never as imputations and never as passes.

---

## 18. Rounding and exact-arithmetic rules (RB-R1…RB-R4) [PRESERVED for D07b; NEW / PROPOSED rubric-wide]

- **RB-R1 (Exact arithmetic) [NEW / PROPOSED rubric-wide; PRESERVED for D07b].**
  All `C`, `I`, `E`, `f`, `Q`, `P`, `q`, `D`, `p`, `S`, `t`, `T`, `S_total`
  computations use exact rational arithmetic (or fixed-point decimal with ≥ 12
  significant digits). **No intermediate rounding** of any factor, product,
  partial sum, or mean.
- **RB-R2 (Display) [NEW / PROPOSED rubric-wide; PRESERVED for D07b].** Worksheet
  display values are rounded **half-up (away from zero for non-negatives) to 7
  decimal places**, applied once, at final display only. Displayed values never
  feed further computation.
- **RB-R3 (Comparisons) [NEW / PROPOSED rubric-wide; PRESERVED for D07b].** All
  threshold, gate, floor, baseline, and stretch comparisons use the **exact
  (unrounded)** value — never the displayed rounded value.
- **RB-R4 (Order independence) [NEW / PROPOSED rubric-wide; PRESERVED for D07b].**
  All aggregations are fixed rational functions of bounded inputs; summation
  order, grouping, and share-by-share vs sum-then-divide evaluation produce
  identical exact results (verifiers check exact fractions, not string equality
  of displays).

---

## 19. Reproducibility and assessment-manifest requirements (RB-A1…RB-A4) [PRESERVED for D07b; NEW / PROPOSED rubric-wide]

- **RB-A1 (Input manifest) [NEW / PROPOSED].** Every RB scoring event publishes:
  (a) the 60-row baseline manifest (unit; `C` + citation; `I` + citation;
  evidence class + artifact citations + SHA; freshness inputs (dates) and `f`;
  `Q`; `q`; `p`); (b) the 9-row D07b modality annex; (c) the gate table (one row
  per gate with verdict + evidence); (d) where `PRE` holds, the 20-row stretch
  manifest; (e) exact fractions plus 7-dp displays; (f) assessor identity and
  assessment date. Schema: `JATA-RB-v0.1-MANIFEST-SCHEMA.json`.
- **RB-A2 (Independent reproduction) [NEW / PROPOSED].** Two independent parties
  applying the same manifest must obtain identical exact fractions and 7-dp
  displays for every `q`, `D`, `p`, `S`, `t`, `T`, and `S_total`. Arithmetic
  discrepancies are inadmissible.
- **RB-A3 (Dispute resolution) [NEW / PROPOSED].** Disagreements about inputs
  (grades, classes, dates) are resolved solely by §§6–8 and §17 — never by
  averaging opinions or splitting scores.
- **RB-A4 (Self-audit identities) [NEW / PROPOSED].** Assessors verify:
  `S = Σ p_u`; `D_d = 100 × mean(q)`; `q_07b = (k/9) × μ_present`;
  `Σ unit weights = 100`; `T = Σ t_j`; `S_total = S + T_eff`. Any identity
  failure invalidates the assessment.

---

## 20. Treatment of unscorable units [PRESERVED X1/X2 for D07b; NEW / PROPOSED rubric-wide]

- **RB-U1 (Fixed denominator) [NEW / PROPOSED].** All 60 units always count. Units
  with no qualifying capability, integration, or evidence are recorded with the
  corresponding factor(s) = 0, hence `q = 0` and contribution zero. Units are
  never omitted and never renormalized across scored units.
- **RB-U2 (Unscorable ⇒ zero, with rationale) [NEW / PROPOSED].** An assessed
  unit with no qualifying input is `q = 0` **with a recorded rationale** (which
  factor is zero and why). A zero with rationale is a completed assessment row.
- **RB-U3 (Unassessed ≠ unscorable) [NEW / PROPOSED].** A blank row (template
  `UNASSESSED`) is **not** a zero and **not** a score. An assessment with any
  blank row is **incomplete** and publishes **no total, no dimension value, and
  no delta** — exactly as the v1.1 PROVISIONAL scorecard published NONE.
- **RB-U4 (No hidden zeros-to-credit) [NEW / PROPOSED].** No rule converts
  unscorable units to credit via floors, gates, stretch, or rounding. The only
  path from zero is better implementation, integration, or evidence.

## 21. Historical applicability and prospective-only treatment [NEW / PROPOSED]

- **RB-H1.** This basis applies, if ever adopted, **prospectively only**: to
  assessments conducted on or after the adoption date, on artifacts at or after
  the adoption SHA/configuration. No assessment under this basis may be backdated
  to an earlier artifact or date.
- **RB-H2.** **No retroactive rescoring.** No historical artifact (including every
  SHA assessed or referenced under v1.0/v1.1) is rescored, reinterpreted, or
  converted under this basis. Historical records stand as records of their dates.
- **RB-H3.** **No cross-basis comparison.** RB scores (if any are ever produced)
  are RB-basis quantities. They must never be differenced against, averaged with,
  or presented as movements of the frozen `9.484375%` or any other v1.0/v1.1
  figure. Scorecards must label the basis of every figure.
- **RB-H4.** The frozen `9.484375%` is **not an input** to any RB equation,
  calibration, or example (see §1.3). Its appearances in proposal artifacts are
  preservation statements only.
- **RB-P1.** Adoption (if ever) is itself score-neutral: adopting a rubric adds
  no capability credit of any kind (preserved v1.1 principle, P-20).
- **RB-P2.** Evidence created before adoption may support a post-adoption
  assessment only if it satisfies §§7–8 and 17 on the assessed artifact —
  including SHA match and freshness at the assessment date. Pre-adoption E4+
  reports about other SHAs are historical (capped E2), not current E4.
- **RB-P3.** The P2-E4 recognition (2026-09-27) confers zero RB credit and zero
  RB gate closure (see §1.5). RB assessments re-verify under RB rules.

---

## 22. Relationship between normal scoring, baseline, release threshold, and stretch [NEW / PROPOSED]

Single pipeline (each stage feeds only the next; no stage substitutes for another):

1. **Normal scoring (per unit):** inputs `(C, I, E, f)` → `Q = E×f` →
   `q = C×I×Q` (standard units) or per-modality `P_m` → `q_07b = mean(P_m)` (D07b).
2. **Baseline:** `p_u = weight×q_u` → `S = Σ p_u` (0–100); `D_d = 100×mean(q)`.
3. **Release threshold:** `RELEASE_READY ⇔ (S ≥ 95) ∧ FLOORS_MET ∧ all gates PASS`.
   Uses `S` only; stretch excluded; exact comparisons.
4. **Stretch (gated additive):** `PRE ⇔ RELEASE_READY`; `T = Σ t_j` (20 binary);
   `T_eff = PRE ? T : 0`.
5. **Total and objective:** `S_total = S + T_eff` (0–120); the 120% objective is
   `S_total = 120` (requires `S = 100` and `T = 20` with `PRE`).
6. **Production qualification:** orthogonal to all stages above; determined
   per claim by E5 rules and CG-08, never by any score.

```
(C,I,E,f) → q → p → S ──┬──→ [S ≥ 95 ∧ floors ∧ gates] ──→ PRE ──→ T_eff ──→ S_total = S + T_eff
                        └──→ [S = 100] (baseline perfection; still needs PRE + T = 20 for 120%)
Scores ──✕──→ gates, floors, production qualification (never substitutes; V5 preserved)
```

---

## 23. Worked examples (SYNTHETIC hypothetical inputs — NOT assessments) [NEW / PROPOSED]

> **Disclaimer.** Every input below is invented for illustration. No SHA, branch,
> tree, artifact, or date refers to anything real. No example scores any actual
> system, past or present. No example uses `9.484375%`. Exact fractions with 7-dp
> half-up displays; re-derivation is machine-checked (MC-15).

- **WE-RB1 — Standard unit, mixed inputs (synthetic).** `C = 1/2`, `I = 3/4`,
  `E = E2 = 1/4`, `f = 1/4` (stale): `Q = (1/4)×(1/4) = 1/16`;
  `q = (1/2)×(3/4)×(1/16) = 3/128` (display `0.0234375`); on a `13/8` unit,
  `p = (13/8)×(3/128) = 39/1024` points (display `0.0380859`).
- **WE-RB2 — Fresh independent verification (synthetic).** `C = 3/4`, `I = 1/2`,
  `E = E4 = 3/4`, `f = 3/4` (recent): `Q = (3/4)×(3/4) = 9/16`;
  `q = (3/4)×(1/2)×(9/16) = 27/128` (display `0.2109375`); on a `13/8` unit,
  `p = (13/8)×(27/128) = 351/1024` (display `0.3427734`).
- **WE-RB3 — D07b-style breadth (synthetic P values).** `P = (1/2, 1/4, 1/8, 3/4,
  1, 0, 1/4, 1/2, 0)`; `ΣP = 27/8`; `q = (1/9)×(27/8) = 3/8` (display
  `0.3750000`); `p = (9/4)×(3/8) = 27/32` points (display `0.8437500`); `k = 7`,
  `μ_present = (27/8)/7 = 27/56`, identity `(7/9)×(27/56) = 3/8` holds.
- **WE-RB4 — Floor failure despite a strong unit (synthetic).** Suppose 52
  standard units at `q = 1/16` (`C = I = 1/2`, `E = E2`, fresh: `Q = 1/4`,
  `q = 1/16`), the four D01 units at `q = 0`, and D07a–d at `q = (0, 0, 0, 1)`
  (52 + 4 + 4 = 60 units exactly): `S = 52×(13/8)×(1/16) + 4×0 + (9/4)×1`
  `= 52×(13/128) + 9/4 = 676/128 + 288/128 = 964/128 = 241/32`
  (display `7.5312500`). But `D_01 = 0 < 80` (floor), so release is denied
  despite the perfect D07d unit — floors bind independently of `S`.
- **WE-RB5 — Stretch gating (synthetic).** An artifact with 20/20 stretch packs
  but `S = 94` (exact): `PRE` is false, so `T_eff = 0` and `S_total = 94`. The
  packs are recorded; they credit zero until `PRE` holds and remain subject to
  HG-09 freshness when re-evaluated.

---

## 24. Unresolved design questions [NEW / PROPOSED]

| ID | Question | Why open | Required before |
|---|---|---|---|
| UQ-01 | Should the 14 residual dimension weights differentiate (risk-based) rather than equal 13/2? | Equal is the neutral prior; differentiation needs evidence and would re-open every downstream identity. | Any weight change (versioned review) |
| UQ-02 | Is the E-step spacing (1/8…1) correctly calibrated to assurance cost? | Spacing is exactly representable but ultimately a policy choice; the E4 premium is deliberate. | Adoption assurance review |
| UQ-03 | Should a gate-waiver mechanism (owner disposition with expiry) exist? | RB-G3 defines no waivers (conservative); operations may need a governed exception path. | Any waiver rule (versioned review) |
| UQ-04 | Are the freshness windows (30/90/180/365) operationally right? | Windows balance re-verification cost against staleness risk; no empirical basis exists yet. | Adoption assurance review |
| UQ-05 | Is E6 replication (second separate party) proportionate for 100%? | E6-everywhere makes 100% extremely demanding; alternatives (E5-everywhere for 100%) weaken replication. | Adoption assurance review |
| UQ-06 | Do the 20 stretch points have balanced difficulty? | Points were drafted for coverage (5/5/5/5), not calibrated difficulty. | First stretch assessment dry-run (post-adoption, if ever) |
| UQ-07 | What is the required-checks list for CG-05? | CG-05 references a committed list this proposal does not (and cannot) fix for all futures. | Each assessment plan |
| UQ-08 | What are the committed SLOs for HG-06/ST-P01/ST-P05? | SLO values are deployment-specific and must be committed per assessment. | Each assessment plan |
| UQ-09 | What is the exact `sup |MOP − POM|` (AF-RB-01)? | Open assurance finding; needs exact-rational analysis, not a design edit. | Any v1.1 §11 correction (separate review) |
| UQ-10 | What adoption criteria (assurance review scope, dry-run assessments) must precede any adoption? | This proposal is DESIGN ONLY and defines no adoption path beyond requiring one. | Any adoption authorization |

---

## 25. Adoption block [NEW / PROPOSED]

- **Status: NOT ADOPTED.** This proposal has no normative force. It must not be
  cited as the rubric, used for any assessment, or treated as approval of anything.
- **No silent conversion.** No use, reference, partial implementation, or passage
  of time converts this proposal into an adopted rubric. Any adoption requires:
  (a) independent assurance review of the full proposal (including UQ-01…UQ-10
  disposition); (b) remediation of every review finding; (c) a separate explicit
  written authorization by the repository owner naming this proposal version and
  stating adoption scope; (d) publication of the adoption record with version,
  hashes, and effective SHA/date.
- **Versioning.** Any post-design change produces a new proposal version
  (`v0.2-PROPOSED`, …). This `v0.1-PROPOSED` text is frozen as the design record
  of 2026-09-27.

---

*End of JATA-RB-v0.1-PROPOSED specification. NOT ADOPTED. No score calculated.
Historical 9.484375% preserved frozen and unused. P2-E4 recognition confers zero
credit. Nothing herein qualifies anything for production.*
