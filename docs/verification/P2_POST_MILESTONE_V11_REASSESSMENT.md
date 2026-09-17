# First post-P2 JATA-P0-95-v1.1 scoring assessment (assessment-only; no projection)

| Field | Value |
|---|---|
| Authority | Spec §24 P2-S8 acceptance ("first post-P2 v1.1 scoring assessment … recorded") + §19 rule 5 |
| Branch / base | `arena/01a0afbe-jata-qi` on `2c1cad0` (final SHA recorded in `P2_S8_IMPLEMENTATION_REPORT.md` §9 at Phase 6) |
| Prior assessment | `docs/rubric/P0R-95_SCORECARD.md` at canonical `2455c59` (2026-09-11, M1) |
| Assessment type | Source-verified at the S8 tree; assessment-ONLY — no projection, no roadmap credit (v1.1 V3/V4) |
| Evidence class of THIS record | PRIMARY (same-agent) |

---

## 1. Headline: figures frozen, and why (the full "why frozen" note)

| Quantity | Prior (frozen) | This assessment | Change |
|---|---|---|---|
| Capability index | 44.375% | 44.375% (quoted) | none |
| Integration-adjusted index | 36.6875% | 36.6875% (quoted) | none |
| **Evidence-qualified baseline (published)** | **9.484375%** | **9.484375% (frozen)** | **0.0000000 pp** |
| Sensitivity range | 6.6484375% – 14.875% | quoted unchanged | none |
| D07b (only scored unit) | 0.0000000 / 2.25 | 0.0000000 / 2.25 | 0.0000000 pp |
| Production readiness | NOT READY | NOT READY | none |

**No recalculation is justified.** Three jointly-sufficient reasons:

1. **S8 is verification-only.** The milestone's diff contains zero
   production-code changes (test files + `docs/verification/` records
   only — §0 of the S8 implementation report). No capability was added,
   removed, or modified, so no `C` input to any unit changed.
2. **The numeric schedule is still unrecovered.** The scorecard's §0
   (v1.0 schedule missing; exhaustive 30-branch / 32-PR / 1,679-commit /
   code-search recovery attempt found nothing) remains true at this tree
   — S8 recovered no schedule, invented no schedule, and performed no
   renormalization (v1.1 X1/X2). Every unit except D07b therefore remains
   UNSCORABLE, exactly as before.
3. **D07b's inputs are untouched.** All nine modality groundings are
   `C = I = Q = P_m = 0` by source inspection at `2455c59`; S8 touched
   no modality surface, so `k = 0`, `ΣP_m = 0`, `μ_present = 0`,
   `q_07b = (0/9) × 0 = 0` exactly, and the A4 self-audit identity still
   passes. Re-running the arithmetic yields the identical 0.0000000.

Freezing is therefore not conservatism — it is the only rubric-compliant
output: any other number would require a schedule this program does not
have, or capability credit for tests (prohibited by V3/V4: tests are
evidence, and evidence-class movement without the schedule cannot move a
numeric score).

## 2. Minima restated at the S8 tree (D02 / D03 / D14 / D07b)

| Unit | Minimum (verified value) | Basis |
|---|---|---|
| D02 — Identity / access | **UNSCORABLE** (capability PARTIAL, strengthened — §3) | numeric schedule unrecovered; floor value unrecovered |
| D03 — Core architecture | **UNSCORABLE** (capability IMPLEMENTED) | same |
| D14 — Testing / assurance | **UNSCORABLE** (capability IMPLEMENTED, strong — §3) | same |
| D07b — Autonomous Prompt Compiler breadth | **0.0000000 / 2.25** | exact recomputation, §1 reason 3 |

## 3. Evidence movement observed (no numeric credit taken)

The following movements are RECORDED because §19 exists to prevent
evidence loss — but per V1–V5 none of them moves a published number
today. Class upgrades to VERIFICATION additionally require a SEPARATE
party (spec §19 rule 4); same-agent evidence is PRIMARY at best.

1. **D02 "Required next evidence" — substantially delivered (PRIMARY).**
   The scorecard required "RFC 6238 TOTP vectors; step-up staleness
   boundary table; A-26/A-12/A-23". Since M1: S5 delivered MFA/TOTP +
   step-up enforcement (§8/§5.3, M-S3 mutants); S6 delivered break-glass
   (A-12); S8 delivers the step-up/MFA staleness boundary table (A-21:
   strict `maxAge`/`maxAge+1` flips, future-evidence MISMATCH, per-grant
   durable `expiresAt` probes) and A-23 (11/11: `ALREADY_ENROLLED`,
   idempotent-skip import, `BG_ONE_SHOT`, exactly-once records). The D02
   "Absent" list (MFA/TOTP, break-glass) is now stale and should be
   revised by the NEXT CARRIED assessment — but revision of the
   scorecard's capability prose is that assessment's job, not this
   record's; this record only preserves the evidence pointers.
   Remaining D02 gaps unchanged: SAML, ABAC, ReBAC, PAM, KMS/HSM (D2),
   T1 account-takeover residual until independently verified.
2. **D03 "Required next evidence" — delivered (PRIMARY).**
   "Maintained green full-suite on each promoted artifact": the S8
   Phase-4 whole-tree run (build exit 0 / lint 0 errors / full `npm
   test` — see implementation report §9 and the whole-tree pass file)
   is the maintained-green evidence for this artifact.
3. **D04 "Required next evidence" — delivered (PRIMARY).**
   "Node-loss / kill-9 harness": S8 A-17 (SIGKILL of an open-tx worker;
   uncommitted row absent, postmaster healthy) and A-19 (outage
   injection → DENY `SECURITY_STATE_UNAVAILABLE`) are exactly the
   requested harnesses.
4. **D14 — strengthened, one remission noted.** Test count grows by the
   S8 program (A-17 4, A-18 5, A-19 6, A-20 3, A-21 6, A-22/A-23 11,
   hygiene 4, all fail-hard with zero skips) plus the mutation harness's
   disposable-copy migration with its own hygiene gate (15/15 mutants
   killed, tracked tree provably untouched). **G10: PR #34 is MERGED**
   (`ccdfb9b`, 2026-09-12 — bounded PG readiness protection,
   +570/−19). G10 *attribution* nevertheless REMAINS OPEN: the original
   log content is still egress-blocked, and a merged mitigation is not
   an attribution. Required next evidence for G10 is unchanged (log
   retrieval from an egress-capable environment).
5. **D15 — AG-1/R-9 unchanged.** Ruleset `20134880` hardening remains
   HUMAN ADMIN REQUIRED (S8 neither attempted nor received it). This
   milestone's PR will demonstrate the gate behavior from the
   contributor side (1 approval + build·lint·test + strict + resolution;
   STOP BEFORE MERGE).

## 4. What the NEXT assessment must do (handoff, not done here)

- Revise the D02 capability prose (MFA/TOTP + break-glass no longer
  "absent"/"contract-only") once separate-party verification exists.
- Evaluate P2 security/identity dimensions under V1–V5 per §19 rule 5
  (receivable only with rule-1 artifacts, including a genuine
  `P2_S8_INDEPENDENT_VERIFICATION.md` — still outstanding).
- Re-derive any number ONLY from a recovered schedule; until then the
  frozen 9.484375% and the UNSCORABLE minima stand.

**STOP-note:** this assessment changes no published figure, projects no
future score, and claims no E4/E5 credit.
