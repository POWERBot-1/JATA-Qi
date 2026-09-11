# P0R-RUB-03 — P0 Rubric Numeric Provenance & Reconstruction Report

| Field | Value |
|---|---|
| Record type | Provenance search + authorized numeric reconstruction attempt (documentation-only) |
| Authorization | Phase A — Evidence, Governance & Critical-Path Unlock |
| Date of record | 2026-09-11 (UTC) |
| Canonical baseline (exact) | `2455c59e8462ca203e9d57788792acb32e5cdad9` |
| Rubric under investigation | `JATA-P0-95-v1.1` (adopted) and its predecessor `JATA-P0-95-v1.0` |
| Mode | READ-ONLY SEARCH + DOCUMENTATION. No rubric value invented. No score manufactured. |

---

## 1. Determination

> **The `JATA-P0-95-v1.0` numerical framework is UNRECOVERED.**
>
> `JATA-P0-95-v1.1` is **RECOVERED IN FULL and now published to canonical
> `main`** by this phase (byte-identical; see §3). v1.1 is an **amendment**. It
> does **not** contain the v1.0 numerical definitions, and this record makes
> **no claim that v1.0 has been recovered.**

Consequence: no dimension weight, evidence coefficient, freshness value,
dimension floor, or gate threshold is asserted anywhere in this phase. The
accompanying scorecard (`docs/rubric/P0R-95_SCORECARD.md`) is therefore
**PROVISIONAL** and publishes **no percentage**.

---

## 2. Provenance of v1.1 (RECOVERED)

| Attribute | Value | Verification |
|---|---|---|
| Source commit | `36f0026573074466e701db722e7f1cd91333d667` | GitHub API read, 2026-09-11 |
| Source branch | `arena/01a07e0c-jata-qi` | enumerated live |
| Commit subject | `docs(rubric): adopt JATA-P0-95-v1.1 (P0R-RUB-01A) — normative D07b mean-of-modality-products rule` | GitHub API |
| Parent | `10fc9baffbc432eb1ec92cec9cd1f4c86d810a64` | per commit metadata |
| Path | `docs/rubric/JATA-P0-95-v1.1.md` | GitHub contents API |
| Size | 15,483 bytes · 226 lines | verified |
| Git blob SHA | `fc9ce9c87f827a6324df4f9560a2cd6b1827423c` | **recomputed locally — MATCH** |
| SHA-256 | `e364205c51f3c5d0eeb10a92ec54039d35b0d0e24c7d549e4865e14954fdf4f2` | computed |
| Branch coverage | present on **1 of 30** remote branches | all 30 trees enumerated |
| Publication integrity | `git hash-object docs/rubric/JATA-P0-95-v1.1.md` = `fc9ce9c…` — **byte-identical to source** | **MATCH ✓** |

**Integrity method:** the file was retrieved via the GitHub contents API at the
exact source commit, written to canonical `main` without modification, and the
resulting git blob hash was recomputed and compared to the source blob hash. An
exact match proves the promotion introduced **zero** content drift — this is a
promotion, not an amendment.

---

## 3. Exhaustive search performed for v1.0 numerics

Every avenue named in the authorization was searched. Results:

| # | Avenue | Method | Result |
|---|---|---|---|
| 1 | Canonical working tree | `grep -rni "JATA-P0-95\|P0-95"` over all 681 tracked files | 7 files **reference** v1.1; **none contain** the v1.0 schedule |
| 2 | `docs/rubric/` in canonical | `ls docs/rubric`; `git ls-files \| grep rubric` | **absent** before this phase |
| 3 | Git history (local) | `git rev-list --all --count` | **1** — shallow clone; history not locally available |
| 4 | Git history (remote) | `gh api …/commits?sha=<branch>&per_page=100` for **all 30** remote branches → **1,679 unique commit messages** | **0** numeric-schedule hits |
| 5 | All branch trees | `gh api …/git/trees/<branch>?recursive=1` for all 30 branches | exactly **one** rubric path repo-wide: `docs/rubric/JATA-P0-95-v1.1.md` |
| 6 | Docs not in `main` | `comm -13` of canonical `docs/` listing vs union of all-branch `docs/` listings | only `docs/rubric/JATA-P0-95-v1.1.md` |
| 7 | Tags | `git tag -l`; branch/tag inventory via API | **no tags** |
| 8 | PR bodies + comments | all **32** PRs (`gh pr view --json body` + `issues/<n>/comments`) → 2,079 lines | **0** hits for `E0–E6` schedule, `S100`, dimension weights, floors |
| 9 | GitHub code search | `search/code` for `JATA-P0-95-v1.0`; for `"E0" "E6" evidence coefficient`; for `freshness factor dimension` | **total_count 0** on all three |
| 10 | Historical verification reports | all 24 files in `docs/verification/` read/grepped | reference v1.1 and the frozen values; none reproduce v1.0 |
| 11 | Archived/recoverable artifacts | dangling-blob and recovery references in commit messages (`3e48b0c`, recovery manifest SHA-256) | recovery artifacts concern the **capability fabric**, not rubric numerics |

**Search coverage statement:** all 30 remote branches, all 32 pull requests,
1,679 unique commit messages, all 681 canonical tracked files, all 52 canonical
`docs/` files, GitHub code search, and the tag namespace were searched. No
further repository-native avenue remains.

---

## 4. Per-element reconstruction findings

Each element required by the authorization is dispositioned individually.
"UNRECOVERED" means **no repository-native evidence establishes the value**; it
is never interpolated.

| # | Element | Status | Provenance | Confidence | Independently corroborated |
|---|---|---|---|---|---|
| 1 | **Total rubric weight** | **RECOVERED** | v1.1 §9: *"Total rubric weight **100%**"* | High | Yes — v1.1 §9 + `P0_ASSURANCE_CLOSURE_HANDOFF.md` |
| 2 | **Dimension count** | **RECOVERED** | v1.1 §9: *"**15 dimensions**"* | High | Yes — v1.1 §9; handoff |
| 3 | **Top-level units per dimension** | **RECOVERED** | v1.1 §9: *"**4 top-level units per dimension**"* | High | Yes — v1.1 §9; §1 (`D_07 = 100 × (q_07a+q_07b+q_07c+q_07d)/4`) |
| 4 | **Total scoring units** | **RECOVERED** | v1.1 §9: *"**60 top-level scoring units**"* | High | Yes — arithmetic identity 15 × 4 = 60 is self-consistent |
| 5 | **Unit scoring method** | **RECOVERED** | v1.1 §9: *"the **C × I × Q methodology**"*; §1 `Q_m = E_m × f_m` | High | Yes — v1.1 §1/§2 + `P1_CLOSURE_VERIFICATION.md` §7.1 |
| 6 | **D07 dimension weight** | **RECOVERED** | v1.1 §2: *"Weight of D07b — 9% (D07) ÷ 4"* ⇒ D07 = **9%** | High | Yes — v1.1 §2 + §9 |
| 7 | **D07b unit weight** | **RECOVERED** | v1.1 §2: **2.25 points**; each modality share **0.25 points exactly** | High | Yes — arithmetic 9 ÷ 4 = 2.25; 2.25 ÷ 9 = 0.25 |
| 8 | **D07 modality list & count** | **RECOVERED** | v1.1 §2: nine named modalities (Coding, Architecture, Website/building, Image, Video, Copy, Voice, Marketing, General agent tasks) | High | Yes — v1.1 §2, §3 M1 |
| 9 | **D07b aggregation rule** | **RECOVERED** | v1.1 §1: `q_07b = (1/9) × Σ(C_m × I_m × Q_m)` (mean-of-modality-products) | High | Yes — v1.1 §1/§11 + handoff §4 + worked examples WE1–WE6 |
| 10 | **Missing-modality rule** | **RECOVERED** | v1.1 §4 X1–X3: denominator fixed 9; zeros; never renormalized; `q_07b = (k/9) × μ_present` | High | Yes — v1.1 §4 + WE3 |
| 11 | **Arithmetic / rounding rules** | **RECOVERED** | v1.1 §6 R1–R4 (exact rational; 7-dp half-up display only; thresholds on exact values; order independence) | High | Yes — v1.1 §6; scope-limited to D07b per P0R-RUB-03 |
| 12 | **Auditor reproducibility rules** | **RECOVERED** | v1.1 §8 A1–A4 | High | Yes — v1.1 §8 |
| 13 | **95% release threshold** | **RECOVERED** (existence) | v1.1 §9: *"the **95% release threshold**"* | High (existence) | Yes — v1.1 §9 + handoff §5 |
| 14 | **100% baseline definition** | **PARTIAL** | v1.1 §9 confirms the *invariant exists*; its **definition text is absent** | Medium | Partially |
| 15 | **120% stretch framework** | **PARTIAL** | v1.1 §9 confirms existence; handoff §12 gives the four gating conditions; **scoring mechanics absent** | Medium | Partially — handoff §12 |
| 16 | **`E0–E6` evidence coefficient values** | **UNRECOVERED** | v1.1 §5: *"preserved by reference; nothing here redefines them."* No value appears in any searched artifact | — | **No** |
| 17 | **Freshness function `f`** | **UNRECOVERED** | v1.1 §2/§5 reference "the existing freshness model"; **no formula or decay table anywhere** | — | **No** |
| 18 | **D01–D06, D08–D15 weights** | **UNRECOVERED** | Only D07 = 9% is stated. The other 14 weights appear in no artifact | — | **No** |
| 19 | **59 non-D07b unit specifications** | **UNRECOVERED** | Only D07b is specified. D07a/c/d are explicitly *"v1.0-only (absent)"* per `POST_INV15…md:137` | — | **No** |
| 20 | **Dimension floor values** | **UNRECOVERED** | `POST_INV15…md:203`: *"values are not present in any canonical artifact (v1.0 absent) … a recorded evidence gap, not a waiver."* Register **L-11** | — | **No** |
| 21 | **Critical gate list** | **UNRECOVERED** | v1.1 §9 asserts "all critical/high release gates" are preserved; the **enumeration is absent**. L-11 | — | **No** |
| 22 | **High gate list** | **UNRECOVERED** | as above | — | **No** |
| 23 | **`S100` calculation** | **UNRECOVERED** | `grep -rni "S100"` over the canonical tree → **0 hits**; 0 hits in all PR bodies/comments | — | **No** |
| 24 | **Dimension IDs ↔ domain mapping** | **PARTIAL** | D07 ↔ Prompt-Compiler modalities is certain (v1.1 §2). The D01–D15 ↔ domain labels used in prior audits are a **convention**, not a recovered rubric fact | Low | **No** — treated as convention only |

**Tally:** 15 RECOVERED · 3 PARTIAL · 9 UNRECOVERED.

---

## 5. Why the missing elements cannot be derived

Three independent constraints make derivation inadmissible rather than merely
difficult:

1. **Weights are not derivable from the total.** Knowing 15 dimensions sum to
   100% and that D07 = 9% leaves 14 unknowns and one equation. Any allocation
   would be invented.
2. **Floors are not derivable from thresholds.** A 95% release threshold does
   not imply any per-dimension floor.
3. **v1.1 itself forbids the inference.** §6 scope note (P0R-RUB-03 preserved):
   the arithmetic rules are normative **for D07b only**, and *"any rubric-wide
   convention requires a separate versioned assurance review."* §5 V2 forbids
   grade upgrading. Constructing the missing schedule would violate both.

---

## 6. Disposition and required next action

| Item | Disposition |
|---|---|
| v1.1 provenance | **CLOSED** — recovered, integrity-verified, published to canonical `main` (this phase) |
| v1.0 numeric framework | **UNRECOVERED** — not fabricated, not interpolated |
| Repository-native search | **EXHAUSTED** — no further avenue remains (§3) |
| Register entry | **P0R-RUB-02 / L-3 / L-11 remain OPEN**, now with an exhaustive-search record attached |
| Scoring consequence | Only **D07b** is computable. It is recomputed in `docs/rubric/P0R-95_SCORECARD.md` — **no other unit is scored, and no total percentage is published.** |

**Required to close:** the v1.0 numerical schedule exists, if at all, **outside
this repository** (v1.1 §0 records that v1.0 "existed as a conversational
governance artifact"). Closing P0R-RUB-03 therefore requires an **owner-supplied
authoritative v1.0 text**, after which a separate versioned rubric review
(P0R-RUB-03 proper) may adopt it. **No agent-side reconstruction can substitute
for that source.** This is stated plainly rather than papered over with a
plausible-looking schedule.

---

*End of P0R-RUB-03 provenance and reconstruction report. No rubric value was
invented. No percentage was manufactured.*
