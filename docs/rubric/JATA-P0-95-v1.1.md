# JATA-P0-95 — v1.1 — P0 ACCEPTANCE RUBRIC (ADOPTED)

| Field | Value |
|---|---|
| Specification | **JATA-P0-95-v1.1** |
| Status | **ADOPTED** (formal adoption per authorization **P0R-RUB-01A**, 2026-09-08) |
| Supersedes | JATA-P0-95-v1.0 (v1.0 is NOT modified; it remains as historically published) |
| Assurance basis | P0R-RUB-01 final determination **A — RUBRIC AMENDMENT ACCEPTED — v1.1 PROPOSED** (exact-rational mathematical review) |
| Canonical commit at adoption | `10fc9baffbc432eb1ec92cec9cd1f4c86d810a64` |
| Application | **PROSPECTIVE ONLY** — future-scoring clarification; no retroactive rescoring; no capability credit added |
| Scope of this document | Rubric specification only. It implements no capability, remediates no gap, and changes no score. |

---

## 0. PROVENANCE AND ADOPTION RECORD

- This file is the **formally adopted successor specification** to JATA-P0-95-v1.0,
  adopted under authorization P0R-RUB-01A (controlled specification update; rubric
  adoption only; no implementation authorization).
- **P0R-RUB-02 provenance note (recorded, not fabricated):** the v1.0 rubric text was
  **not present** in the canonical repository artifact (`10fc9ba…`) examined during
  P0R-RUB-01; v1.0 existed as a conversational governance artifact. This v1.1 file is
  therefore the **first rubric specification stored in this repository**. No historical
  v1.0 text is reconstructed here, and no provenance for v1.0 is fabricated. v1.0
  remains the operative historical record, unmodified.
- P0R-RUB-01 resolved finding **P0R-RUB-01 (D07b nested aggregation
  under-specification)**; this v1.1 incorporates its resolution verbatim, as verified
  against the P0R-RUB-01 mathematical determination (conflict check: PASS, 2026-09-08).

## 1. NORMATIVE D07b AGGREGATION FORMULA

For the D07b top-level unit of dimension D07, the unit score is:

    q_07b = (1/9) × Σ [m = 1..9] ( C_m × I_m × Q_m )

This is the **mean of per-modality products (MOP)** rule. The product of factor
means — (average C_m) × (average I_m) × (average Q_m) — is **not** the rubric rule
(rejected by P0R-RUB-01: it contradicts the declared nine-equal-shares structure and
admits phantom credit for conjunctions never demonstrated within a single modality).

The dimension score remains, unchanged from v1.0:

    D_07 = 100 × ( q_07a + q_07b + q_07c + q_07d ) / 4

with each q ∈ [0, 1].

## 2. DEFINITIONS OF ALL VARIABLES

| Symbol | Definition |
|---|---|
| `m` | Index over the nine D07 modalities: 1 Coding, 2 Architecture, 3 Website/building, 4 Image, 5 Video, 6 Copy, 7 Voice, 8 Marketing, 9 General agent tasks. |
| `C_m ∈ [0,1]` | Capability score of modality `m`, graded under the existing v1.0/v1.1 capability scale. Not redefined by this amendment. |
| `I_m ∈ [0,1]` | Integration score of modality `m`, graded under the existing integration scale. Not redefined by this amendment. |
| `E_m` | The existing **E0–E6 evidence coefficient** assigned to the best qualifying evidence class covering modality `m`, under the existing evidence schedule. Not redefined by this amendment. |
| `f_m ∈ [0,1]` | The existing **freshness factor** for modality `m`'s evidence, computed by the existing freshness model. Not redefined by this amendment. If a given evidence class already incorporates freshness in its coefficient, then `f_m ≡ 1` for that class and `Q_m` is that coefficient; the aggregation is identical either way. |
| `Q_m ∈ [0,1]` | Modality `m`'s evidence score after freshness: `Q_m = E_m × f_m`. Freshness enters **once, per modality, before aggregation**. |
| `P_m` | Modality completion product: `P_m = C_m × I_m × Q_m ∈ [0,1]`. |
| `q_07b ∈ [0,1]` | D07b unit score. As a percentage of the unit: `D07b(%) = 100 × q_07b`. |
| `k` | Number of modalities with `P_m > 0` (qualifying modalities). |
| `μ_present` | Mean of `P_m` over qualifying modalities: `μ_present = (Σ_{P_m>0} P_m) / k` (0 when k = 0). |
| Weight of D07b | 9% (D07) ÷ 4 (equal top-level units) = **2.25 points** of the 100-point rubric. Each modality share = 2.25 ÷ 9 = **0.25 points** exactly. |

## 3. MODALITY TREATMENT

- **M1 (Equal shares).** Each of the nine modalities contributes exactly
  `(1/9) × P_m` to `q_07b`. Shares are additive, equal, and state-independent:
  fully completing one modality from zero adds exactly `1/9` to `q_07b`
  (= 0.25 rubric points), regardless of the state of any other modality.
- **M2 (Per-modality conjunction).** A modality scores only through the product of
  its **own** capability, integration, and evidence. No factor value crosses a
  modality boundary.
- **M3 (Partial implementations).** A partially implemented modality scores its
  actual `P_m ∈ (0,1)`. No floor, no rounding-up, no partial-credit heuristics.
- **M4 (No hidden weighting).** No modality-, factor-, evidence-class-, or
  auditor-specific weights exist. The only weights are the nine equal `1/9` shares.

## 4. MISSING-MODALITY TREATMENT

- **X1 (Fixed denominator).** The denominator is always **9** — the declared count of
  equal modality shares. Missing, unimplemented, unqualifying, or unevidenced
  modalities are **never omitted and never renormalized** across the remaining
  modalities.
- **X2 (Missing ⇒ zeros).** A modality with no qualifying capability, integration, or
  evidence is recorded with the corresponding factor(s) = 0, hence `P_m = 0` and its
  share contributes exactly zero. The rule is uniform; there are no special cases.
- **X3 (Proportionality identity and cap).** `q_07b = (k/9) × μ_present`, therefore
  `q_07b ≤ k/9`, with equality only if every qualifying modality is fully complete.
  One fully complete modality alone yields exactly `1/9 ≈ 11.11%` of D07b
  (0.25 rubric points) and can contribute **no more than 1/9 of D07b** — never 100%.

## 5. EVIDENCE AND FRESHNESS TREATMENT

The existing E0–E6 evidence framework and freshness model are preserved by reference;
nothing here redefines them.

- **V1 (Entry point).** Evidence and freshness are evaluated **per modality, before
  D07b aggregation** (`Q_m = E_m × f_m`). Stale or missing evidence in modality `j`
  decays or zeroes only modality `j`'s share; it is never averaged away across
  modalities.
- **V2 (No grade upgrading).** The aggregation clarification does not upgrade any
  evidence grade. `Q_m` derives solely from the existing E0–E6 schedule and freshness
  model.
- **V3 (Inspection ≠ runtime verification).** A source-code inspection is graded at
  the evidence class the existing schedule assigns to inspection. It is **never**
  graded as independent runtime verification.
- **V4 (Historical report ≠ current artifact).** A historical report grades at most
  at its existing historical-evidence class and remains subject to the freshness
  model. It is not automatically equivalent to an inspectable current E4 artifact.
- **V5 (Evidence does not close gates).** Any `Q_m` value, including `Q_m = 1`, does
  not satisfy or substitute for separately required E4/E5 release requirements.
  Gates, thresholds, floors, and the 95% release threshold are evaluated
  independently of q-scores.

## 6. ARITHMETIC, ROUNDING, AND THRESHOLD-COMPARISON RULES

- **R1 (Exact arithmetic).** `q_07b` is computed in exact rational arithmetic (or a
  fixed-point decimal equivalent with ≥ 12 significant digits). **No intermediate
  rounding** of `C_m`, `I_m`, `Q_m`, `P_m`, or partial sums.
- **R2 (Display).** Worksheet display values are rounded **half-up (away from zero) to
  7 decimal places**, applied once, at final display only.
- **R3 (Comparisons).** All threshold, gate, floor, baseline, and stretch comparisons
  use the **exact (unrounded)** value — never the displayed rounded value. No hidden
  rounding that could alter an acceptance outcome is permitted.
- **R4 (Order independence).** The rule is a fixed rational function of 27 bounded
  inputs; summation order, grouping, and share-by-share vs sum-then-divide evaluation
  produce identical results.
- **Scope note (P0R-RUB-03 preserved):** R1–R4 are normative **for D07b** and are the
  explicit D07b rules established by P0R-RUB-01. This adoption does **not** redesign
  rounding/threshold conventions for any other dimension or unit; any rubric-wide
  convention requires a separate versioned assurance review.

## 7. WORKED EXAMPLES (illustrative Q values; actual scoring uses the existing E0–E6 schedule)

- **WE1 — One missing modality.** Modalities 1–8 complete (`C=I=Q=1`), modality 9
  missing: `q_07b = 8/9 = 0.8888889` (2.0000000 rubric points). The rejected
  product-of-means reading would give `(8/9)³ = 512/729 = 0.7023320` — the v1.0
  ambiguity this amendment resolves (18.6556927 pp of D07b on this ordinary input).
- **WE2 — Phantom credit rejected.** Modalities 1–5 `(1,0,0)`, modalities 6–9
  `(0,1,1)`: no modality has capability ∧ integration ∧ evidence; `q_07b = 0`
  exactly. The rejected alternative would yield 80/729 = 0.1097394.
- **WE3 — One complete, eight missing.** `q_07b = 1/9 = 0.1111111` — exactly one
  0.25-point share; no renormalization to 100% of D07b.
- **WE4 — Unevidenced capability.** Modality 9 `(1,1,0)`, others complete:
  `q_07b = 8/9`. Built and integrated but unevidenced capability earns exactly zero
  for that share.
- **WE5 — Freshness localization.** `Q = (1,1,1,1,.25,.25,.25,.25,.25)`, `C=I=1`:
  `q_07b = 7/12 = 0.5833333`. Decay hits only the stale shares.
- **WE6 — Partials and unequal factors.** `(.5,.5,.75),(.5,.5,.5),(.5,.5,.5)`, rest
  missing: `q_07b = 7/144 = 0.0486111`. `(1,.25,.5),(.25,1,.5),(.5,.5,1)`, rest
  missing: `q_07b = 1/18 = 0.0555556`.

## 8. AUDITOR REPRODUCIBILITY REQUIREMENTS

- **A1 (Input manifest).** Every D07b scoring event publishes a nine-row manifest:
  modality; `C_m` with rubric-line citation; `I_m` with rubric-line citation; evidence
  class and artifact citations; freshness inputs (dates) and resulting `Q_m`; `P_m`.
- **A2 (Independent reproduction).** Two independent auditors applying the same
  manifest **must** obtain the identical `q_07b` (exact fraction and 7-dp display).
  Arithmetic discrepancies are inadmissible; the formula is closed-form and
  order-independent.
- **A3 (Dispute resolution).** Disagreements about inputs (evidence classification,
  freshness dating) are resolved solely by the existing E0–E6 and freshness
  definitions — never by averaging auditors' opinions or splitting scores.
- **A4 (Self-audit identity).** Auditors verify `q_07b = (k/9) × μ_present` as a
  cross-check.

## 9. INVARIANTS PRESERVED (unchanged from v1.0)

Total rubric weight **100%**; **15 dimensions**; **4 top-level units per dimension**;
**60 top-level scoring units**; **D07 weight 9%**; **equal weighting of the nine D07
modalities**; the **C × I × Q methodology**; the **E0–E6 evidence coefficients**; the
**freshness model**; the **95% release threshold**; the **100% baseline definition**;
the **120% stretch framework**; **all critical/high release gates**; **all dimension
floors**. **No hidden weighting is introduced.**

## 10. CURRENT SCORE FREEZE (unchanged by adoption)

The published current worksheet is frozen and is **not** recalculated, re-derived, or
reinterpreted by v1.1. No retroactive rescoring is authorized or performed:

| Quantity | Frozen value |
|---|---|
| Capability index | **44.375%** |
| Integration-adjusted index | **36.6875%** |
| Evidence-qualified baseline | **9.484375%** |
| Sensitivity range | **6.6484375% – 14.875%** |
| Stretch credit | **0 / 20** |
| Production readiness | **NOT READY** |

At the recorded current state D07b = 0, therefore `Σ P_m = 0` and the v1.1 formula
yields exactly 0 — adoption **must** and **does** produce exactly the same current
result. This amendment adds **no capability credit** of any kind.

## 11. CHANGE LOG — v1.0 → v1.1

| # | Entry |
|---|---|
| 1 | v1.0 had an **under-specified D07b aggregation order**: it declared nine equal modality shares and the C × I × Q methodology without stating whether products are formed per modality and averaged, or factor means are multiplied. |
| 2 | **P0R-RUB-01** identified the ambiguity and measured it: the two competent readings diverge by up to 35.6652949 percentage points of D07b on ordinary inputs, including 18.6556927 pp in the one-missing-modality case. |
| 3 | **v1.1 resolves it using mean-of-modality-products**: `q_07b = (1/9) × Σ (C_m × I_m × Q_m)` (§1), selected in P0R-RUB-01 as the unique rule consistent with the declared nine equal shares and free of phantom credit. |
| 4 | **Missing modalities remain in the fixed denominator**: denominator 9 always; zero contribution; never omitted; never renormalized; `q_07b = (k/9) × μ_present` (§4). |
| 5 | **The current historical score is unchanged**: the worksheet above (§10) is frozen; the amendment is prospective-only and provably score-neutral at the recorded state (D07b = 0 ⇒ v1.1 also yields exactly 0). |
| 6 | **No capability credit is added by this amendment**: it changes no capability, integration, evidence, or freshness value; it defines only how existing values aggregate. |
| 7 | Clarifications carried from P0R-RUB-01: per-modality freshness entry point (V1); no grade upgrading (V2); inspection ≠ runtime verification (V3); historical report ≠ current E4 artifact (V4); evidence never substitutes for E4/E5 gates (V5); arithmetic/rounding/comparison rules (R1–R4); auditor reproducibility (A1–A4); worked examples (§7). |
| 8 | **Adoption record:** adopted 2026-09-08 under authorization P0R-RUB-01A (controlled specification update, rubric adoption only); assurance basis P0R-RUB-01 determination A; conflict check against the P0R-RUB-01 mathematical determination: PASS. |

## 12. UNRESOLVED ASSURANCE ITEMS (status preserved by this adoption; unchanged)

| Item | Status |
|---|---|
| G10 | **OPEN — UNATTRIBUTABLE CI FAILURE.** Not addressed by this adoption; no CI modified, rerun, or inferred. |
| G19 | **UNRECOVERED — HISTORICAL SOURCE UNAVAILABLE.** F3–F12 not reconstructed, renamed, or mapped. |
| P0R-RUB-02 | **RECORDED — rubric artifact provenance/editorial issue.** v1.0 was not present in the canonical repository artifact examined during P0R. This file is the formally adopted in-repo successor specification; no historical provenance is fabricated. |
| P0R-RUB-03 | **RECORDED — rubric-wide rounding/threshold convention.** D07b rules preserved exactly as established (§6); no other dimension redesigned; any rubric-wide change requires separate versioned assurance review. |
| P0R-RUB-04 | **CANDIDATE — VERIFICATION BLOCKED BY P0R-RUB-02.** Not resolved; no assumption about post-aggregation freshness ordering is made. |
| Historical R2 | **PRESERVED.** Adoption does not invalidate R2, re-open R2, alter PR #24 history, alter the R2 PASS record, or reinterpret historical findings. |

**Governance note.** Adoption of this rubric is a specification act only. It is not
capability implementation, not increased JATA Qi capability, not production
readiness, and not progress toward the 95% release threshold. P0 remains subject to
G10, G19, independent qualification limitations, and all remaining production and
security gates.

---

*End of JATA-P0-95-v1.1 (ADOPTED). Prospective-only future-scoring clarification. Current score unchanged at 9.484375% evidence-qualified baseline; production readiness NOT READY.*
