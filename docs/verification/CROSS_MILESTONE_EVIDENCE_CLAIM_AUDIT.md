# JATA Qi — Cross-Milestone Evidence Claim Audit

**Post-S7 / pre-S5 gate · READ-ONLY AUDIT · no implementation, no merge, no push**

| Field | Value |
|---|---|
| Audit date | 2026-09-11 (UTC) |
| Canonical `main` | `2455c59e8462ca203e9d57788792acb32e5cdad9` (confirmed unchanged) |
| PR #33 | OPEN, `merged=false`, head **`09b8ee0cde3afa5f96a2bf70fa632b833d8b723e`** |
| Artifacts audited | 34 files under `docs/verification/` + `docs/rubric/` (24 already on canonical `main`) |
| Milestones in scope | P0 / P0-R, Phase A, M1, P2-S1, P2-S2, P2-S3, P2-S4, P2-S7 |
| Working tree modified? | **No** — 0 dirty files; all reads via `git show <sha>:<path>` |
| Determination | **B — NON-BLOCKING EVIDENCE CORRECTIONS REQUIRED** |

> **Stale premise corrected.** The directive states PR #33 head = `b38a6a2`.
> The actual head is `09b8ee0` (verified via `gh api .../pulls/33`).

---

## 1. Executive determination

**B — non-blocking evidence corrections required.**

Across 34 artifacts and eight milestones, this audit found **one claim
contradicted by its artifact** (EV-01), **one claim needing scope precision**
(EV-02), **one systemic semantic issue** (EV-07), and **one finding already
superseded by later work** (EV-08). It found **no capability, security,
tenant-isolation, or production-readiness overclaim**, and **no vacuous test**.

Two categories came back clean and are worth stating as clean rather than by
silence:

* **Production-readiness language (§8): clean.** A sweep for
  `production-ready`, `hardened`, `enterprise/deployment/release-ready`,
  `fully integrated`, `95%`, `100%`, `security-complete` across all 34 artifacts
  found **zero** achievement claims. Every `95%`/`100%` hit is either the rubric
  defining its own terms (`JATA-P0-95-v1.1` §§9), an explicit **NOT COMPUTABLE**
  (`P0R-95_SCORECARD:10`, `M1_CLOSURE_RECORD:55,358,445`), or disk usage
  (`P1_O1_O2_O3_REMEDIATION:119`).
* **Pattern 2 (control confused with authorization): clean in prior
  milestones.** No prior report describes identity/tenant binding, audit
  logging, or fail-closed behaviour as equivalent to authorization enforcement.
  The S3/S4 wording is actively careful (`P2_S4_VERIFICATION_REPORT:278`:
  *"fail-closed; documented, **not an over-authorization**"*).

**No P0 finding. No security control is weaker than its report claims.**

---

## 2. Exact artifacts audited

Read from the PR head commit object, never from the working tree:

| Milestone | Artifact | Lines | Introduced at |
|---|---|---|---|
| P0 / P0-R | `JATA-P0-95-v1.1.md`, `P0R-95_SCORECARD.md`, `P0R_RUB_03_PROVENANCE_RECONSTRUCTION.md` | 226 / 335 / 153 | `67e68ff` |
| P0 gap recon | `P0_G10_G19_GAP_RECONNAISSANCE.md` | 440 | `2455c59` |
| Phase A | `PHASE_A_GOVERNANCE_AND_CRITICAL_PATH.md` | 424 | `67e68ff` |
| M1 | `M1_CLOSURE_RECORD.md` | 462 | `7e46dbc` |
| P2-S1 | `P2_S1_VERIFICATION_REPORT.md`, `S1_INDEPENDENT_VERIFICATION.md` | 251 / 150 | `2455c59` |
| P2-S2 | `P2_S2_VERIFICATION_REPORT.md` | 198 | `67e68ff` (backfill) |
| P2-S3 | `P2_S3_VERIFICATION_REPORT.md` | 176 | `67e68ff` (backfill) |
| P2-S4 | `P2_S4_VERIFICATION_REPORT.md`, `P2_S4_F6_REVERIFICATION.md` | 387 / 266 | `2455c59` / `67e68ff` |
| P2-S7 | `P2_S7_IMPLEMENTATION_REPORT.md` | 627 | `bb54738` |
| P1 lineage | `P1_CLOSURE_VERIFICATION.md`, `P1_IMPLEMENTATION_EVIDENCE.md`, `P1_O1_O2_O3_REMEDIATION.md`, `P1_O3_SCRIPT_CLEANUP_REMEDIATION.md`, `P1_REMEDIATION_V1_V2.md`, `INV-15_GAP-07_*.md`, `A01_RECOVERY_*.md` | 494/198/264/142/256/83+166/96 | `2455c59` |
| R0–R2 / other | `R0_BASELINE_EVIDENCE.md`, `R1_R4_REMEDIATION_VERIFICATION.md`, `R2_IMPLEMENTATION_EVIDENCE.md`, `T09_INDEPENDENT_VERIFICATION.md`, `PR20_*`, `P2_READINESS_AUDIT.md`, `POST_INV15_*`, matrices | — | `2455c59` |

Code artifacts examined at `09b8ee0`: `packages/storage-postgres/src/postgres-driver.ts`,
`packages/cli/src/security-posture.ts`, `packages/authentication/src/{key-management,secret-material}.ts`,
`packages/cli/test/p2-s3-posture-invariants.test.ts`, `packages/cli/test/p1-pg.ts`,
`packages/cli/test/p1-posture.test.ts`.

---

## 3. Methodology

1. Inventory every `.md` artifact at the exact PR head via `git ls-tree`.
2. For each audit pattern, grep **all** artifacts for the claim shape, then
   reconcile each hit against the **artifact**, not the wording.
3. For code claims, read the pushed source with `git show <sha>:<path>` and cite
   file:line.
4. For CI claims, resolve the cited run id via `gh api` and compare
   `head_sha` / `event` / `conclusion` to what the report asserts.
5. For test claims, read the assertions in the test file and ask the §6
   questions (can it pass without the mechanism?).
6. Classify per §4; assign severity; trace downstream dependency.

**Method caveat, disclosed.** One audit grep produced a false positive (EV-03).
It is recorded in §11 rather than dropped, because an audit that hides its own
errors is the failure mode this audit exists to catch.

---

## 4. Finding register

| ID | Milestone | Claim (source) | Artifact evidence | Classification | Sev | Security | Score impact | Downstream | Remediate? |
|---|---|---|---|---|---|---|---|---|---|
| **EV-01** | INV-15/GAP-07 (P1) | *"the driver registers **no listeners anywhere**"* — `INV-15_GAP-07_IMPLEMENTATION_EVIDENCE.md:52` | `postgres-driver.ts:443` `this._pool.on('error', …)`; `:422` `this._pool = this.opts.pool ?? new Pool(…)` ⇒ pool **can be caller-supplied** | **OVERSTATED** (Pattern 1) | **MEDIUM** | Low — the *security* control is intact | none | P2 readiness citations | **YES** |
| **EV-02** | P2-S1 | *"all test key material is generated in-process (node:crypto) and **never persisted**"* — `P2_S1_VERIFICATION_REPORT.md:225` | Static auth tokens **are** written to disk: `p1-pg.ts:143` (`'p1-pg-token-alpha'`, `'-beta'` → `os.tmpdir()/jataqi-*-principals-*.json`); `p1-posture.test.ts:227` (`token:'x'` → `p1-posture-principals-<ts>.json`) | **PARTIALLY VERIFIED** — literal subject (node:crypto key material) not contradicted; scope easily over-read | **LOW** | None — fixtures, not real credentials; `scan:r2` 0 findings | none | none | Optional |
| **EV-03** | *audit itself* | *(this audit's first pass claimed S3 has no negative posture cases)* | `p2-s3-posture-invariants.test.ts:153-154, 172-173, 194-195` assert `typeof outcome === 'string'` + `/NOT attached\|not wired\|WINDOW_POLICY_VIOLATION/`; test names are explicitly "(negative)" | **AUDIT FALSE POSITIVE — corrected. S3 report VERIFIED** | INFORMATIONAL | none | none | audit method | Recorded |
| **EV-04** | M1, S2 | Cited CI run ids and their outcomes | `34033434142` → head `d221f65`, `pull_request`, **failure** ✓ · `34488819576` → head `f68f329`, `push`, **failure** ✓ | **VERIFIED** | — | none | none | — | No |
| **EV-05** | all | production-ready / hardened / 95% / complete | 0 achievement claims across 34 artifacts | **VERIFIED (clean)** | — | none | none | — | No |
| **EV-06** | S1, T09, S2, S3, S4 | provenance of reconstructed records | S1/T09 self-label *"Document type: Independent-verification evidence record **(reconstruction)**"*; S2/S3 title *"**EVIDENCE BACKFILL**"*; S4 F6 states SHA + date + *"Fresh independent re-verification"* | **VERIFIED** | — | none | none | — | No |
| **EV-07** | all | "independent verification" | Every such record was produced by **the same agent**, on the same session branch (`P2_S4_F6_REVERIFICATION.md:9`: *"Working branch `arena/01a08e8a-jata-qi`"*). Only the S7 report discloses this (`P2_S7_IMPLEMENTATION_REPORT.md` §12: *"performed by the same session that wrote the code"*) | **MISLEADING** (systemic, category L) | **LOW** | Low | none | **S5/S6 assurance inheritance** | **YES** |
| **EV-08** | S7-adjacent | *"four untouched PostgreSQL harnesses retain `random(250)` collision risk"* | `09b8ee0` fixed `authorization-boundary` (5 overlapping base pairs, 183/183 green). Measured overlap in the other three: **0** | **SUPERSEDED — now three, all with zero current overlap** | INFORMATIONAL | none | none | none | Update wording |

---

## 5. VERIFIED claims (spot-checked against artifacts)

| Claim | Source | Evidence |
|---|---|---|
| Canonical baseline `2455c59` | all | `git rev-parse origin/main` = `2455c59e8462ca203e9d57788792acb32e5cdad9` |
| Existing A-01 `CredentialMaterialProvider` contract preserved | S7 | `git diff 2455c59 09b8ee0 -- packages/authorization-boundary/src/credential-store.ts` → **identical** |
| S7 audit record cannot carry secret material | S7 | all 14 fields of `SecretAccessRecord` are `string`/`number`/closed enum; **no** `Uint8Array`/`Buffer`/blob |
| S7 imports no authorization authority | S7 | `grep AuthorizationBoundary\|IdentityStore\|assertAuthorized` → 0; `actorPrincipalId` never compared to `principalId` (only 2 `typeof` guards at `:289`,`:654`) |
| No vendor **dependency** in S7 | S7 | 0 vendor imports in `key-management.ts` |
| P2-S3 posture: 5 tests = PG + positive + 3 negatives | `P2_S3_VERIFICATION_REPORT.md:113` | test file shows exactly 5 S3 cases incl. three named "(negative)" with real assertions |
| CI runs cited by M1/S2 are real and correctly characterized | EV-04 | both resolve, both `failure`, heads match |
| Provenance of reconstructed records is labelled | EV-06 | see register |

---

## 6. Vacuous-test findings

**None found.** The specific §6 questions were asked of the highest-risk tests:

* *Can a posture test pass while the invariant is violated?* — No. S3 asserts
  `check() === true` on the positive path **and** `typeof outcome === 'string'`
  with a reason regex on each negative path (`:153,172,194`). S7 does the same
  and additionally asserts boot refusal (`assert.rejects` +
  `/MANDATORY SECURITY INVARIANT VIOLATED/`).
* *Can a missing dependency make an assertion vacuous?* — The PG-backed suites
  are fail-hard: `assert.ok(pg, '…requires a real PostgreSQL backend…')`. Skip
  calls in both S7 PG suites: **0**.
* *Is "green" based on complete execution?* — M1's P1C-OBS-01 work made the CI
  detector `exit 1` on any `SKIP`, so a green `Test (all workspaces)` implies
  zero skips. Fresh run at `09b8ee0`: **1,504 · 0 fail · 0 skipped · 0 cancelled · 50/50**.

**Known vacuity, already disclosed, retained:** P2-INV-08 returns `true`
vacuously when no key seam is attached (`P2_S7_IMPLEMENTATION_REPORT.md`). Not
new; must not be silently closed.

---

## 7. Security-claim findings

No report claims JATA Qi *possesses* a capability for which only a seam, spec,
or test adapter exists. Verified negatives:

| Capability | Claimed as possessed anywhere? | Evidence |
|---|---|---|
| Real KMS/HSM | **No** | `P1_IMPLEMENTATION_EVIDENCE:63` *"No vendor selected; no KMS/HSM implementation claimed"*; `P0_G10_G19:273` *"contract only; no vendor selected; tests use honestly-labeled doubles"*; S7 §11 |
| MFA / SSO / ABAC / ReBAC / PAM | **No** | listed as open items, not achievements |
| Prompt-injection / agent-tool auth / sandbox containment | **No** | S7 §11 open-items list |
| Production identity assurance | **No** | S7: *"not hardened, **not** production-ready, and **not** security-complete"* |

The one place where a **control could be misread as authorization** is S7
itself, and it is already documented as residual risk §9.7.

---

## 8. Production-claim findings

Clean — see §1. The strongest production-adjacent wording found is an
**objective**, not a claim: `PHASE_A_GOVERNANCE_AND_CRITICAL_PATH:292`,
*"Objective: convert the existing `CredentialMaterialProvider` contract into a
hardened, rotating, versioned, revocable seam."* S7 delivered exactly the
seam-level guarantees, and its report states that provider-level guarantees are
**not** claimed.

---

## 9. Score-integrity impact

**No score component depends on an overstated claim.** The only computable
scoring unit remains **D07b** (1 of 60), value `0.0000000 / 2.25`.

| Item | Status |
|---|---|
| Numerical 95% score | **NOT COMPUTABLE** — cause is v1.0 numeric schedule **UNRECOVERED**, unchanged by this audit |
| Rubric v1.1 | 15 RECOVERED / 3 PARTIAL / 9 UNRECOVERED (`P0R_RUB_03:86-99`) |
| Effect of EV-01/02/07 on any scored unit | **none** |
| Renormalization or replacement score invented? | **No** |

No percentage is published and none is computed here.

---

## 10. Downstream dependency impact

| Entering milestone | Depends on | Audit result |
|---|---|---|
| **S5 (MFA/TOTP)** | S1 ✓, S3 ✓, S7 ✓ | All three verified. **No blocking code dependency.** |
| **S6 (break-glass)** | S3 ✓, S7 ✓ | Verified. **No blocking code dependency.** |
| **S8 / P3 / P4** | not yet designed | n/a |

**One BLOCKING DEPENDENCY, and it is procedural, not technical:**

> **BD-01 (process).** EV-07 means the phrase "independently verified" attached
> to S1, T09, S2, S3 and S4 denotes *a separate read-only pass by the same
> agent*, never review by a different person or system. If S5/S6 inherit that
> status without the caveat, the program will be overstating its assurance
> level in exactly the way this audit was convened to prevent.
> **Remediation:** adopt the S7 §12 disclosure wording as the standing
> definition of "independent verification" before S5 begins. No code change.

---

## 11. Audit's own error (disclosed)

The first pass of this audit asserted that P2-S3's posture tests contain **no
negative cases**, on the strength of a grep for `assert.rejects`. That was
**wrong**: S3 asserts negatives via `typeof outcome === 'string'` plus a reason
regex, at lines 153-154, 172-173 and 194-195, and the test names say
"(negative)". The S3 report's §5.1 reconciliation (5 tests = PG + positive +
3 negatives) is **verified exactly**.

This is the same defect class as the S7 findings and as the vacuous
`packages/*/src` pathspec: **a search too narrow to find what it claims to have
looked for.** It is recorded here rather than quietly fixed, and it is the
reason §3 requires every negative finding to be re-checked by reading the
artifact before it is reported.

---

## 12. Blockers

| Level | Item |
|---|---|
| **P0** | none |
| **P1** | none |
| **P2 (non-blocking)** | EV-01 correct the "no listeners anywhere" wording · EV-07 adopt an explicit definition of "independent verification" · EV-02 narrow the S1 persistence claim · EV-08 update "four harnesses" to three |

---

## 13. Remediation recommendations

1. **EV-01** — restate as: *"the driver registers no `'connect'` listener on any
   pool, including caller-supplied pools. It does register a pool-level
   `'error'` handler (F1 remediation) which records degradation and never
   grants scope."* That is what `postgres-driver.ts:431-443` actually does.
2. **EV-07** — add a standing sentence to every future verification record:
   *"Independence here means a separate read-only verification pass, not review
   by a different person or system."*
3. **EV-02** — restate as *"no cryptographic key material is persisted; static
   test-principal fixtures (dummy tokens) are written to temp files."*
4. **EV-08** — record three harnesses, with the measured zero overlap.
5. **Do not** repair the S3/S4 posture suites — they are already correct.

Each requires separate explicit authorization. **None was performed in this
audit.**

---

## 14. Recommended next milestone

**S5 (MFA/TOTP) is not blocked by this audit**, subject to two preconditions
that are documentation-only:

* EV-07's definition of "independent verification" is adopted first, so S5's
  evidence starts from an honest assurance vocabulary.
* S5's design explicitly states that the S7 seam **binds and audits but does not
  authorize** (`P2_S7_IMPLEMENTATION_REPORT.md` §9.7), and that S5 must obtain
  its binding tuple from the existing identity/authorization authority.

No score should be recomputed before the owner supplies rubric v1.0.

---

## 15. Explicit non-authorizations

This audit did **not**: implement any fix · edit source code · commit · push ·
merge PR #33 · alter branch protection · create a PR · start S5, S6, S8, P3 or
P4 · deploy · claim 95% · claim production readiness.

Working tree at completion: **0 modified files**, `HEAD = 09b8ee0cde3afa5f96a2bf70fa632b833d8b723e`.
This report exists only as an uncommitted workspace file.

**Merge authorization remains outstanding and is human-owned.**
