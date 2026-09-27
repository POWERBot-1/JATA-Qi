# JATA-RB-v0.1-PROPOSED — Structural and Mathematical Consistency Checks

| Field | Value |
|---|---|
| Proposal | **JATA-RB-v0.1-PROPOSED** |
| Status | **NOT ADOPTED — PROPOSAL ONLY** |
| Date | 2026-09-27 (UTC) |
| Check program | `JATA-RB-v0.1-check.mjs` (exact rational arithmetic; performs no scoring) |
| Historical score | **9.484375% — FROZEN, v1.0-basis; used in zero checks as an input** |
| Current score | **NONE — no score calculated by any check** |

> **What these checks are.** Design-identity verification only: weight sums,
> coefficient properties, table coverage, template structure, and re-derivation of
> stated fractions and 7-dp displays. **What they are not:** scoring. No check
> computes a baseline, dimension, unit, or stretch score for any real artifact or
> SHA. The check program contains no SHA, no evidence input, and no 9.484375%.

---

## 1. How to run

```bash
node docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-check.mjs
```

Expected: `ALL CHECKS PASS` and exit 0. Any FAIL is a proposal defect that must be
remedied in the proposal (not by editing the check to pass) before any assurance
review.

---

## 2. Structural checks (SC-01…SC-10)

| ID | Check | Method | Expected |
|---|---|---|---|
| SC-01 | All 9 proposal files exist | filesystem presence | 9/9 present |
| SC-02 | Every proposal .md carries NOT ADOPTED | substring search | 4/4 (spec, catalog, provenance, this file) |
| SC-03 | No silent adoption wording | every ADOPTED occurrence is inside a NOT ADOPTED line or a v1.1-status fact line (.md + schema) | zero bare ADOPTED |
| SC-04 | Baseline manifest: 60 rows, 60 unique units, 4/dim, weights exact | CSV parse + patterns | 60 rows; 15×4; 56×13/8 + 4×9/4 |
| SC-05 | Baseline manifest UNASSESSED | C/I/E all UNASSESSED; Q/q/points/evidence/sha/dates blank; assessor UNASSESSED | zero assessed cells |
| SC-06 | D07b annex: 9 rows, modalities 1–9, UNASSESSED | CSV parse | 9 rows; all UNASSESSED |
| SC-07 | Stretch manifest: 20 rows, 20×1 pt, UNASSESSED | CSV parse | 20 rows; IDs ST-*01…; earned all UNASSESSED |
| SC-08 | JSON schema parses with required contract | JSON.parse + required keys | valid; 8 required keys |
| SC-09 | Canonical rubric + scorecard untouched; no RB score for any SHA | (a) `git status` shows no modification to `docs/rubric/*` (manual); (b) proposal CSVs contain no 40-hex SHA and no 9.484375% (automatic) | untouched; zero SHAs; zero historical-figure occurrences in CSVs |
| SC-10 | Proposal .md files contain no assessment score for any SHA | manual attestation + CSV automatic above | no `S =`, `D_d =`, or points-earned numerics attached to any SHA in proposal docs; worked examples synthetic only |

SC-09(a) and SC-10(manual) are attested by the design session in §4 below; all
other structural checks are automatic in the check program.

---

## 3. Mathematical checks (MC-01…MC-15)

All arithmetic is exact rational (BigInt numerator/denominator). Display values
are half-up to 7 dp, applied once at final display (RB-R2).

| ID | Check | Identity verified | Expected |
|---|---|---|---|
| MC-01 | Dimension weights sum to 100 | 14×(13/2)+9 = 100 | 100/1 |
| MC-02 | Unit weights sum to 100; per-dim quarters | 56×(13/8)+4×(9/4) = 100; 4×(13/8)=13/2; 4×(9/4)=9 | 100/1; 13/2; 9/1 |
| MC-03 | D07b modality shares sum to D07b | 9×(1/4) = 9/4 | 9/4 |
| MC-04 | C scale valid | {0,1/4,1/2,3/4,1} ⊆ [0,1]; min 0; max 1; strictly increasing | PASS |
| MC-05 | I scale valid | same as MC-04 | PASS |
| MC-06 | E coefficients valid | {0,1/8,1/4,1/2,3/4,7/8,1} ⊆ [0,1]; E0=0; E6=1; strictly increasing | PASS |
| MC-07 | Freshness table valid | values {1,3/4,1/2,1/4,0} ⊆ [0,1], non-increasing; intervals [0,30],[31,90],[91,180],[181,365],[366,∞) gapless/overlapless | PASS |
| MC-08 | Q range | all 35 E×f products ∈ [0,1] | PASS |
| MC-09 | q range scaffold | min 0×0×0=0; max 1×1×1=1; both in [0,1] | 0/1; 1/1 |
| MC-10 | Floors valid + compatible | floors ∈ [0,100]; ΣwF/100 = 1221/20 = 61.05 < 95 | 1221/20; holds |
| MC-11 | Normal-score maximum | S_max = Σ unit weights = 100 | 100/1 |
| MC-12 | Stretch + total maxima | 20×1=20; 100+20=120 | 20/1; 120/1 |
| MC-13 | 95 feasibility | 95 ≤ 100 and 1221/20 < 95 | holds |
| MC-14 | v1.1 WE1–WE6 re-derived (rule preservation) | 8/9→0.8888889; 512/729→0.7023320; Δ=136/729→18.6556927pp; 80/729→0.1097394; 1/9→0.1111111; 7/12→0.5833333; 7/144→0.0486111; 1/18→0.0555556 | all match v1.1 §7 |
| MC-15 | RB synthetic examples re-derived | WE-RB1 q=3/128→0.0234375 p=39/1024→0.0380859; WE-RB2 q=27/128→0.2109375 p=351/1024→0.3427734; WE-RB3 q=3/8→0.3750000 p=27/32→0.8437500 k=7; WE-RB4 S=241/32→7.5312500 (synthetic floor-failure); WE-RB5 gating holds | all match SPEC §23 |

---

## 4. Results

### 4.1 Automatic results (from the check program)

> Filled by the design session after executing the program. The pasted output
> below is the program's stdout verbatim.

```
PASS SC-01 — all 9 proposal files exist
    9/9 present
PASS SC-02 — every proposal .md carries NOT ADOPTED
    4/4 carry NOT ADOPTED
PASS SC-03 — no silent adoption wording (ADOPTED only as NOT ADOPTED or v1.1 fact)
    no bare ADOPTED outside NOT ADOPTED lines and v1.1-status facts
PASS SC-04 — baseline manifest: 60 rows, 60 unique units, 4 per dimension, weights exact
    60 rows; 15×4; weights 56×13/8 + 4×9/4
PASS SC-05 — baseline manifest remains UNASSESSED (no scores, no SHAs, no dates)
    60/60 rows fully UNASSESSED; zero scores; zero SHAs; zero dates
PASS SC-06 — D07b annex: 9 rows, modalities 1-9, UNASSESSED
    9/9 modality rows UNASSESSED
PASS SC-07 — stretch manifest: 20 rows, 20x1pt, UNASSESSED
    20 rows; 5/5/5/5 categories; all UNASSESSED
PASS SC-08 — JSON schema parses with required contract
    schema valid; 8 required keys
PASS SC-09 — proposal CSVs contain no SHA and no historical figure
    zero SHAs; zero historical-figure occurrences in CSVs
PASS MC-01 — dimension weights sum to 100
    14x(13/2)+9 = 100/1
PASS MC-02 — unit weights sum to 100; per-dim quarters
    56x(13/8)+4x(9/4) = 100/1; 4x(13/8)=13/2; 4x(9/4)=9/1
PASS MC-03 — D07b modality shares sum to D07b weight
    9x(1/4) = 9/4
PASS MC-04 — C scale valid
    {0,1/4,1/2,3/4,1} in [0,1], increasing, endpoints 0 and 1
PASS MC-05 — I scale valid
    {0,1/4,1/2,3/4,1} in [0,1], increasing, endpoints 0 and 1
PASS MC-06 — E coefficients valid (E0=0, E6=1, monotonic)
    {0,1/8,1/4,1/2,3/4,7/8,1} in [0,1], increasing, E0=0, E6=1
PASS MC-07 — freshness table valid (values + gapless intervals)
    f in [0,1] non-increasing; [0,30],[31,90],[91,180],[181,365],[366,inf) gapless
PASS MC-08 — Q range over all 35 E x f combos
    35/35 E x f products in [0,1]
PASS MC-09 — q range scaffold (min 0, max 1)
    min q=0/1; max q=1/1
PASS MC-10 — floors valid and compatible (weighted min 1221/20 < 95)
    floor-min S = 1221/20 = 61.05 < 95
PASS MC-11 — normal-score maximum S_max = 100
    S_max = 100/1 (all q=1)
PASS MC-12 — stretch + total maxima (20; 120)
    T_max=20/1; S_total_max=120/1
PASS MC-13 — 95 threshold feasibility
    95 <= 100 and 1221/20 < 95
PASS MC-14 — v1.1 WE1-WE6 re-derived (MOP rule preservation)
    WE1 8/9/512/729/delta, WE2 80/729, WE3 1/9, WE5 7/12, WE6 7/144+1/18 all match
PASS MC-15 — RB synthetic examples WE-RB1..RB5 re-derived
    RB1 q=3/128 p=39/1024; RB2 q=27/128 p=351/1024; RB3 q=3/8 p=27/32 k=7; RB4 S=241/32; RB5 gating holds by predicate form

24/24 checks PASS. No score calculated. Proposal remains NOT ADOPTED.
RESULT: ALL CHECKS PASS
```

### 4.2 Manual attestations

- **SC-09(a) — canonical rubric/scorecard untouched.** Design-session attestation
  method: `git status --porcelain` shows modifications/untracked paths confined
  to `docs/proposals/JATA-RB-v0.1-PROPOSAL/`; `git diff --name-only` shows no
  `docs/rubric/*`; `git hash-object docs/rubric/JATA-P0-95-v1.1.md` still equals
  `fc9ce9c87f827a6324df4f9560a2cd6b1827423c`. Recorded outcome in §4.3.
- **SC-10(manual) — no assessment score for any SHA.** The design session attests
  that no proposal file states any `S`, `D_d`, `q`, `Q`, points-earned, or stretch
  value for any real SHA, branch, tree, or artifact. All numerics in SPEC §23 and
  MC-14/MC-15 are synthetic re-derivations labeled as such. Recorded outcome in §4.3.

### 4.3 Recorded run

| Field | Value |
|---|---|
| Date (UTC) | 2026-09-27T13:57:26Z |
| Command | `node docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-check.mjs` |
| Exit code | 0 |
| Automatic tally | 24/24 PASS (SC-01…SC-09 + MC-01…MC-15) |
| SC-09(a) manual | PASS — `git status` shows only untracked `docs/proposals/`; `git diff --name-only` empty; `git hash-object docs/rubric/JATA-P0-95-v1.1.md` = `fc9ce9c87f827a6324df4f9560a2cd6b1827423c` (match) |
| SC-10 manual | PASS — no proposal file states any S, D, q, Q, points-earned, or stretch value for any real SHA/branch/tree/artifact; the sole 40-hex string in proposal docs is the cited v1.1 blob integrity value (CHECKS §4.2), not an assessment; all numerics in SPEC §23 / MC-14 / MC-15 are synthetic re-derivations labeled as such |
| Overall | ALL CHECKS PASS |

---

*End of consistency checks. NOT ADOPTED. No score calculated.*
