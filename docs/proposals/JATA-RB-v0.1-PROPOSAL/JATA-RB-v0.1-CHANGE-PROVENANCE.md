# JATA-RB-v0.1-PROPOSED — Change and Provenance Record

| Field | Value |
|---|---|
| Proposal | **JATA-RB-v0.1-PROPOSED** |
| Status | **NOT ADOPTED — PROPOSAL ONLY** |
| Date | 2026-09-27 (UTC) |
| Purpose | Distinguish **PRESERVED** constraints (adopted v1.1 + governance material) from **NEW / PROPOSED** rules/values. No v1.1 text is modified. No v1.0 recovery is claimed. |

> Convention: **PRESERVED** = carried without change from the cited source.
> **NEW / PROPOSED** = introduced here; no standing until separately assured and
> explicitly adopted. **GAP-FILL** = NEW / PROPOSED content filling a reference to
> irrecoverable v1.0 text (explicitly labeled as new, never as recovery).

---

## A. Audit-element disposition (P0R-RUB-03 §4 elements 1–24)

P0R-RUB-03 found 15 RECOVERED, 3 PARTIAL, 9 UNRECOVERED. This proposal preserves
every RECOVERED element and supplies NEW / PROPOSED definitions for every
PARTIAL and UNRECOVERED element. Nothing is left "by reference" to v1.0.

| # | Element (P0R-RUB-03) | Prior status | RB disposition | RB source |
|---|---|---|---|---|
| 1 | Total rubric weight | RECOVERED (100%) | PRESERVED (100 points; restated as RB identity) | SPEC §2 P-01, §10 |
| 2 | Dimension count | RECOVERED (15) | PRESERVED | SPEC §2 P-02, §4 |
| 3 | Units per dimension | RECOVERED (4) | PRESERVED | SPEC §2 P-03, §5 |
| 4 | Total scoring units | RECOVERED (60) | PRESERVED (15×4=60 identity checked) | SPEC §2 P-04, §5 |
| 5 | Unit scoring method | RECOVERED (C×I×Q) | PRESERVED methodology; rubric-wide equations NEW / PROPOSED | SPEC §2 P-15, §9 |
| 6 | D07 dimension weight | RECOVERED (9%) | PRESERVED (9) | SPEC §2 P-05, §4 |
| 7 | D07b unit weight / modality share | RECOVERED (2.25 / 0.25) | PRESERVED | SPEC §2 P-06, §5 |
| 8 | D07 modality list & count | RECOVERED (nine named) | PRESERVED | SPEC §2 P-07; CATALOG D07b |
| 9 | D07b aggregation rule | RECOVERED (MOP) | PRESERVED verbatim; no NEW PROPOSED RULE for D07b | SPEC §2 P-08, §9.2 |
| 10 | Missing-modality rule | RECOVERED (X1–X3) | PRESERVED for D07b; rubric-wide no-renormalization NEW / PROPOSED | SPEC §2 P-11, §20 |
| 11 | Arithmetic / rounding rules | RECOVERED (R1–R4, D07b-scoped) | PRESERVED for D07b; rubric-wide RB-R1…RB-R4 NEW / PROPOSED (the separate versioned review v1.1 §6 scope note requires — as proposal) | SPEC §2 P-13, §18 |
| 12 | Auditor reproducibility rules | RECOVERED (A1–A4, D07b-scoped) | PRESERVED for D07b; rubric-wide RB-A1…RB-A4 NEW / PROPOSED | SPEC §2 P-14, §19 |
| 13 | 95% release threshold | RECOVERED (existence) | PRESERVED existence; comparison semantics NEW / PROPOSED | SPEC §2 P-17, §13 |
| 14 | 100% baseline definition | PARTIAL (existence only) | GAP-FILL: full mechanics NEW / PROPOSED | SPEC §§9–10 |
| 15 | 120% stretch framework | PARTIAL (existence + 4 gating conditions) | PRESERVED conditions (handoff §12); mechanics + 20 points NEW / PROPOSED | SPEC §§14–15 |
| 16 | E0–E6 coefficient values | UNRECOVERED | GAP-FILL: all 7 coefficients + mapping NEW / PROPOSED (0, 1/8, 1/4, 1/2, 3/4, 7/8, 1) | SPEC §7 |
| 17 | Freshness function f | UNRECOVERED | GAP-FILL: dating + decay table NEW / PROPOSED | SPEC §8 |
| 18 | D01–D06, D08–D15 weights | UNRECOVERED | GAP-FILL: 13/2 each NEW / PROPOSED (neutral equal prior; D07 anchor preserved) | SPEC §4 |
| 19 | 59 non-D07b unit specifications | UNRECOVERED | GAP-FILL: 59 unit specs NEW / PROPOSED; D07b preserved | CATALOG (59 entries) |
| 20 | Dimension floor values | UNRECOVERED | GAP-FILL: tiered floors NEW / PROPOSED (80/70/50) | SPEC §11 |
| 21 | Critical gate list | UNRECOVERED | GAP-FILL: 8 critical gates NEW / PROPOSED | SPEC §12 |
| 22 | High gate list | UNRECOVERED | GAP-FILL: 10 high gates NEW / PROPOSED | SPEC §12 |
| 23 | S100 calculation | UNRECOVERED | GAP-FILL: baseline equation S + identities NEW / PROPOSED | SPEC §§9–10 |
| 24 | Dimension IDs ↔ domain mapping | PARTIAL (convention only) | GAP-FILL: 15 explicit definitions NEW / PROPOSED (labels reused as new definitions, not recovery) | SPEC §4 |

**Tally:** 13 RECOVERED elements preserved without change (1–13, of which 11–13
are existence/scoped preservations with NEW rubric-wide/semantic extensions);
11 PARTIAL/UNRECOVERED elements gap-filled as NEW / PROPOSED (14–24). Zero
v1.1 normative rules changed. Zero v1.0 values claimed.

---

## B. Rule-level provenance

### B.1 Preserved without change (v1.1 normative)

| Rule | Source | RB location restating preservation |
|---|---|---|
| D07b MOP formula; Q_m = E_m × f_m | v1.1 §1–§2 | SPEC §9.2 |
| D_07 mean-of-four | v1.1 §1 | SPEC §9.3 (D07 instance) |
| M1 equal shares; M2 conjunction; M3 partials; M4 no hidden weighting | v1.1 §3 | SPEC §2 P-10; §9.2 |
| X1 fixed denominator; X2 missing⇒zeros; X3 proportionality + cap | v1.1 §4 | SPEC §2 P-11; §§9.2, 20 |
| V1 entry point; V2 no upgrading; V3 inspection≠verification; V4 historical≠E4; V5 evidence≠gates | v1.1 §5 | SPEC §2 P-12; §§7–8, 12, 17 |
| R1 exact; R2 7-dp half-up display-once; R3 exact comparisons; R4 order independence | v1.1 §6 | SPEC §2 P-13; §18 (D07b instances) |
| A1 nine-row manifest; A2 identical reproduction; A3 disputes by definitions; A4 identity check | v1.1 §8 | SPEC §2 P-14; §19 (D07b instances) |
| WE1–WE6 numerical identities | v1.1 §7 | Carried by rule preservation (re-derivable; see CHECKS MC-14) |
| Frozen worksheet §10; change log §11 text; unresolved items §12 | v1.1 §§10–12 | SPEC §§1–3 (AF-RB-01 records the §11 finding without altering text) |

### B.2 Preserved without change (governance material)

| Rule | Source | RB location |
|---|---|---|
| Release-mandatory list (≥95%; floors; critical PASS; high PASS; independent verification PASS; no unexplained CI failure; exact artifact; production qualification) | Handoff §5 | SPEC §13 (preserved list; RB semantics new) |
| Stretch gating conditions (95%; gates; implemented; independently evidenced) | Handoff §12 | SPEC §14 (preserved; mechanics new) |
| No credit for docs/interfaces/mocks/historical-without-equivalence/adoption/closure/plans | Handoff §11 | SPEC §§6–7 (enforced via scales) |
| E4 = separate-party exact-artifact verification; E5 = production-qualified; durability rules 1–5 | P2 spec §19 | SPEC §§7, 17 (wording preserved; coefficients new) |
| Implementation-without-independent-verification ⇒ no points where E4+ required | P1-CLOSURE §§7–8 | SPEC §§7, 12, 17 |
| P2-E4 cap §4.3 reading (separate-party retrospective permitted under own identity/record; manufacturing forbidden) | Cap §4.3 + recognition record | SPEC §§1.5, 17 (RB re-verification required; recognition confers zero RB credit) |

### B.3 NEW / PROPOSED (complete list)

| ID | New content | RB location | Justification (why new, why this value) |
|---|---|---|---|
| N-01 | 15 dimension definitions | SPEC §4.1 | v1.0 mapping irrecoverable; convention-only labels needed explicit scope to be scorable. |
| N-02 | 14 dimension weights 13/2 | SPEC §4.1–4.2 | Neutral equal prior over residual 91; exactly representable; preserves D07=9 anchor; avoids invented differentiation (UQ-01). |
| N-03 | Equal quarter unit split (13/8; 9/4 for D07a/c/d) | SPEC §5.1 | Unique neutral prior consistent with preserved D07b weight; no hidden weighting. |
| N-04 | 59 unit specifications (all except D07b rule) | CATALOG | v1.0 unit specs absent; each unit needed scope/C/I criteria to be assessable. |
| N-05 | C scale (5 levels, quarters) | SPEC §6.2 | "Existing capability scale" irrecoverable; coarse exactly-representable scale enforcing no-roadmap-credit. |
| N-06 | I scale (5 levels, quarters) | SPEC §6.3 | Same; distinguishes dev-wiring from canonical multi-plane integration. |
| N-07 | E0–E6 coefficients (0,1/8,1/4,1/2,3/4,7/8,1) | SPEC §7.1 | v1.0 schedule irrecoverable; binary fractions with the independence premium at E4 (UQ-02). |
| N-08 | Evidence-class mapping + caps (incl. CI→E2, historical→E2, inspection→E3 max) | SPEC §7.2 | Implements preserved V2–V5 as checkable caps. |
| N-09 | Best-qualifying-class rule | SPEC §7.2 | Prevents stacking/averaging; required for reproducibility. |
| N-10 | Evidence dating + age definition | SPEC §8.1 | Freshness model irrecoverable; calendar-day rule is auditable (UQ-04). |
| N-11 | Decay table (30/90/180/365; 1,3/4,1/2,1/4,0) | SPEC §8.2 | Coarse exactly-representable decay; EXPIRED at >365d forces re-verification. |
| N-12 | Rubric-wide per-unit freshness entry (Q_u = E_u × f_u) | SPEC §8.3 | Generalizes preserved V1; f≡1 proviso preserved-but-vacuous documented. |
| N-13 | Standard-unit equation q_u = C×I×Q; contribution p_u | SPEC §9.1 | Instantiates preserved C×I×Q methodology for the 59 standard units. |
| N-14 | Rubric-wide dimension mean-of-four | SPEC §9.3 | Generalizes preserved D07 formula. |
| N-15 | Baseline S + weighted-dimension identity | SPEC §9.4 | Gap-fills S100 (element 23). |
| N-16 | S_max=100 proof; 100% iff all q=1 (E6+fresh everywhere) | SPEC §10 | Makes 100% mathematically meaningful; preserves evidence-as-binding-constraint. |
| N-17 | Tiered floors (80/70/50) + FLOORS_MET + 61.05 compatibility | SPEC §11 | Balances security-critical strictness with feasibility (61.05<95). |
| N-18 | Gate semantics RB-G1…RB-G4 (boolean, independent, no waivers, f≥3/4) | SPEC §12.1 | Makes gates checkable; no-waiver is the conservative default (UQ-03). |
| N-19 | 8 critical gates CG-01…CG-08 | SPEC §12.2 | Covers isolation, fail-closed, findings, exactness, attribution, independence, secrets, production honesty. |
| N-20 | 10 high gates HG-01…HG-10 | SPEC §12.3 | Covers privilege hygiene, durability, ops, supply chain, freshness, HIGH hygiene. |
| N-21 | Release predicate (S≥95 exact + floors + gates) | SPEC §13 | Preserved threshold existence + handoff list, with exact comparison semantics. |
| N-22 | Stretch mechanics (additive gated, T=Σt, S_total=S+T, max 120, gate-vs-point separation) | SPEC §14 | Makes 120% mathematically meaningful; preserves handoff gating conditions. |
| N-23 | 20 stretch points (5/5/5/5) with per-point evidence + independence | SPEC §15 | Concrete beyond-baseline achievements, each independently evidenced. |
| N-24 | Solo-builder workflow SB-01…SB-08 | SPEC §16 | Makes the owner operating model executable without weakening independence. |
| N-25 | Admissibility RB-EA1…RB-EA6 | SPEC §17.1 | Checkable admissible/inadmissible partition; caps same-agent at E3. |
| N-26 | Independence RB-IV1…RB-IV8 + no-self-certification | SPEC §17.2 | Separate-party test; agent sessions explicitly non-independent. |
| N-27 | Rubric-wide RB-R1…RB-R4 | SPEC §18 | The separate versioned review v1.1 §6 scope note contemplates (as proposal). |
| N-28 | Rubric-wide RB-A1…RB-A4 + manifest contract | SPEC §19 | Generalizes D07b reproducibility to 60 rows + annexes. |
| N-29 | Rubric-wide unscorable treatment RB-U1…RB-U4 | SPEC §20 | Generalizes preserved X1/X2; distinguishes blank from zero. |
| N-30 | RB historical-applicability + prospective-only RB-H1…RB-H4, RB-P1…RB-P3 | SPEC §21 | Prevents retroactive rescoring and cross-basis comparison. |
| N-31 | Pipeline relationship (§22) | SPEC §22 | Single reference for normal→baseline→threshold→stretch. |
| N-32 | Synthetic worked examples WE-RB1…WE-RB5 | SPEC §23 | Illustrate mechanics with hypothetical inputs; not assessments. |
| N-33 | Manifest templates (60-row + D07b annex + stretch) + JSON schema | Templates + schema | Machine-readable assessment contract, unassessed. |
| N-34 | Consistency-check program (structural + mathematical) | CHECKS + script | Makes every identity in N-02/N-03/N-07/N-11/N-14…N-17/N-22 machine-verified. |

### B.4 Changed rules (v1.1 normative rules altered by this proposal)

**NONE.** This proposal changes zero adopted v1.1 normative rules. D07b is
preserved verbatim. All RB rubric-wide rules coincide with the D07b rules on D07b
inputs by construction. If a future revision proposes a D07b change, it must be
labeled **NEW PROPOSED RULE** with explicit justification per the owner
authorization §6 — no such rule exists in v0.1.

---

## C. Historical figures and recognitions

| Item | Value/record | Treatment |
|---|---|---|
| Evidence-qualified baseline | 9.484375% FROZEN, v1.0-basis | PRESERVED; quoted only as frozen reference; never an RB input; never rescored; never converted (SPEC §1.3). |
| Capability / integration indices | 44.375% / 36.6875% FROZEN | PRESERVED as historical record only (SPEC §2 P-19). |
| Sensitivity range | 6.6484375%–14.875% FROZEN | PRESERVED as historical record only. |
| Stretch | 0/20 FROZEN (v1.0-basis) | PRESERVED; RB stretch is a separate 20-point program (SPEC §15). |
| Production readiness | NOT READY | PRESERVED; RB claims no production qualification. |
| P2-E4 recognition (2026-09-27) | Governance recognition | Zero RB credit; zero RB gate closure; RB re-verification required (SPEC §1.5). |
| v1.1 §11 divergence figure | 35.6652949 pp (recorded) vs 38.4087791 pp (reported supremum) | KNOWN ASSURANCE FINDING AF-RB-01; OPEN; v1.1 text unaltered (SPEC §3). |

---

## D. Files in this proposal (all NOT ADOPTED)

| Path (relative to repo root) | Content |
|---|---|
| `docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-PROPOSAL-SPEC.md` | Complete design specification (this proposal's normative text) |
| `docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-UNIT-CATALOG.md` | Complete 60-unit catalog (normative to the proposal) |
| `docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-ASSESSMENT-MANIFEST-TEMPLATE.csv` | Machine-readable 60-row baseline manifest template — UNASSESSED |
| `docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-D07B-MODALITY-ANNEX-TEMPLATE.csv` | Machine-readable 9-row D07b modality annex template — UNASSESSED |
| `docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-STRETCH-MANIFEST-TEMPLATE.csv` | Machine-readable 20-row stretch manifest template — UNASSESSED |
| `docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-MANIFEST-SCHEMA.json` | JSON schema for manifest-row validation |
| `docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-CHANGE-PROVENANCE.md` | This change/provenance record |
| `docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-CONSISTENCY-CHECKS.md` | Structural + mathematical check definitions and results |
| `docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-check.mjs` | Executable consistency-check program (exact rational arithmetic; performs no scoring) |

No other repository file is created, modified, renamed, or deleted by this
proposal. In particular: `docs/rubric/JATA-P0-95-v1.1.md` is unmodified;
`docs/rubric/P0R-95_SCORECARD.md` is unmodified; the frozen `9.484375%` is
unmodified everywhere; no scorecard, verification report, or source file is touched.

---

*End of change/provenance record. NOT ADOPTED.*
