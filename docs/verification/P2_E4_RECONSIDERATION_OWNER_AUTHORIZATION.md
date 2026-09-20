# P2-E4 — OWNER RECONSIDERATION AUTHORIZATION (2026-09-20)

| Field | Value |
|---|---|
| Document class | **GOVERNANCE AUTHORIZATION RECORD — documentation-only artifact.** Records an owner authorization issued in the Arena governance conversation. **Implements no capability, remediates no defect, verifies nothing, changes no score, touches no rubric, gate, ruleset, or PR state.** |
| Subject | Owner rescission of the "do not attempt to obtain separate-party E4" clause of the standing P2 assurance cap, and authorization to **pursue** genuine separate-party P2-E4 verification |
| Authorizing human | **Gitanya Kariuki (repository owner)** |
| Authorization date | **2026-09-20 (UTC)** — session date; no clock time for the issuance was stated, and none is invented here |
| Recorded by | Arena agent session `arena/01a0bdb0-jata-qi` (documentation only), 2026-09-20 |
| Record created (tree) | after the authorization, on branch `arena/01a0bdb0-jata-qi` (base `477aedb374580b0fe95d7c1f6f820ff68304b814`, tree `4b267261f5ce6a7a91f07b260ffce96ee848c767`, working tree clean) |
| Instrument amended | `docs/verification/P2_ASSURANCE_CAP_DISPOSITION.md` (2026-09-17) — amended additively by §7 of that record; §§1–6 preserved verbatim |
| Governance sequence position | **Step 2 of 7 (AUTHORIZATION).** Steps 3–7 are NOT performed by this record. |
| **P2-E4 status after this record** | **NOT ACHIEVED — unchanged** |
| Product code modified | **0** |
| Tests / workflows / configs / dependencies / rubric / ruleset modified | **0** |

---

## 1. Evidence rule applied by this record

Same provenance classes as `P3_B0_S0A_B3_OWNER_DECISION_RECORD.md` §1:

| Tag | Meaning |
|---|---|
| **[OWNER]** | Text/decision issued by the owner in the Arena governance conversation on 2026-09-20. Authoritative as to the owner's intent; **not independently verifiable from the repository** |
| **[REPO]** | Re-derived by read-only inspection of the repository and GitHub metadata while recording this authorization (command shown) |
| **[PRESERVE]** | This record — created *after* the authorization in order to preserve it. **Not contemporaneous with the authorization** |
| **[UNVERIFIED]** | Not obtainable by any means available to this session. Recorded as absent, **not** inferred |

**Provenance caveat, stated plainly.** Per spec §19 rule 2, chat messages are
**not** canonical evidence. The authorization itself was issued in
conversation; the chat transcript is not canonical and is not reproduced as
evidence of authenticity. This record is **[PRESERVE]**-class: it preserves the
text so it is not lost to a transcript (the §19 governance defect), and it is
**not** itself independent verification that the owner issued it. No signature,
timestamp, approval, or historical artifact is invented. This record must not be
represented as contemporaneous authorization.

---

## 2. The authorization — recorded verbatim [OWNER]

> **EXPLICIT OWNER AUTHORIZATION — P2-E4**
>
> **Owner:** Gitanya Kariuki
> **Date:** 2026-09-20 UTC
> **Authorization class:** Governance authorization only
> **Scope:** P2-E4 assurance-cap reconsideration and pursuit of genuine separate-party verification
>
> I, **Gitanya Kariuki, repository owner**, explicitly authorize reconsideration of the permanent P2 assurance cap recorded in:
>
> `docs/verification/P2_ASSURANCE_CAP_DISPOSITION.md`
>
> I authorize the project to **pursue a legitimate, genuine separate-party P2-E4 verification** in accordance with the requirements of the P2 production identity and privileged-plane specification, including §19 and §24.
>
> For this specific purpose, I explicitly rescind the portion of the standing cap instruction that prohibits attempting to obtain separate-party E4 verification.
>
> This authorization **does not**:
>
> - authorize implementation changes;
> - authorize modification of P2 production code;
> - authorize score recalculation or publication of a new score;
> - authorize reconstruction or inference of the missing JATA-P0-95-v1.0 numerical schedule;
> - authorize production qualification or deployment;
> - authorize weakening, bypassing, or disabling repository governance or required checks;
> - authorize relabeling historical PRIMARY evidence as E4;
> - authorize manufacturing, simulating, or falsely representing independence;
> - authorize merge of any resulting implementation or verification changes.
>
> **Required E4 standard**
>
> Any E4 verification must be performed by a **genuinely separate verification party**, with its identity, environment, independence basis, exact artifact SHA, commands, observed results, findings, remediation status, and limitations explicitly documented.
>
> The verifier must independently establish the artifact being assessed and must not rely on PR approval clicks, chat assertions, same-agent attestations, screenshots, or relabelled historical evidence as substitutes for E4.
>
> The verification must distinguish clearly between:
>
> **PRIMARY evidence → E4 evidence**
>
> and must not claim that historical PRIMARY evidence was independently verified merely because it is being referenced.
>
> **Artifact and scope**
>
> Before verification begins, the exact artifact under assessment must be explicitly identified and its ancestry, tree, working state, and relevant post-P2 modifications verified.
>
> If the historical P2 baseline is selected, the target is:
>
> `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`
>
> If a later artifact is selected, the verifier must explicitly identify that SHA and disclose all post-P2 changes relevant to the assessment.
>
> **Governance sequence**
>
> This authorization is **not** implementation authorization.
>
> The required sequence remains:
>
> **AUDIT → AUTHORIZATION → VERIFICATION PREPARATION → FRESH SEPARATE-PARTY VERIFICATION → CANONICAL EVIDENCE → INDEPENDENT REVIEW OF RESULTS → SEPARATE SCORE AUTHORIZATION, IF APPLICABLE**
>
> No score change follows automatically from this authorization.
>
> No production-readiness determination follows automatically from this authorization.
>
> **Rubric integrity**
>
> The missing authoritative **JATA-P0-95-v1.0 numerical schedule** remains unrecovered.
>
> No agent, verifier, or assessor is authorized by this document to reconstruct its missing values by inference.
>
> Any future score recalculation requires separate recovery and versioned governance review of the authoritative rubric before recalculation.
>
> **Final authorization**
>
> **I explicitly authorize the project to proceed toward genuine P2-E4 verification, subject to all applicable evidence, independence, governance, and verification requirements.**
>
> This authorization changes the governance permission to **seek genuine E4 verification**; it does **not** itself constitute E4 achievement.
>
> **P2-E4 remains NOT ACHIEVED until the required separate-party verification is actually completed and canonically evidenced.**

---

## 3. Exact effect on the standing cap (narrow, additive, reversible)

The 2026-09-17 disposition recorded this standing instruction:

> *"P2 SHALL BE PERMANENTLY CAPPED WITHOUT E4 … The absence of genuine
> separate-party verification is now an accepted assurance limitation …
> **Do not attempt to obtain, simulate, relabel, or manufacture separate-party
> E4 verification.**"* (`P2_ASSURANCE_CAP_DISPOSITION.md` header, 2026-09-17)

### 3.1 What is rescinded (one clause only)

| Clause | Status after 2026-09-20 |
|---|---|
| "**attempt to obtain** … separate-party E4 verification" | **RESCINDED** by the owner for the specific purpose of pursuing genuine E4 verification |

### 3.2 What is NOT rescinded (all remaining prohibitions stand)

| Prohibition | Status |
|---|---|
| "**simulate** … separate-party E4 verification" | **STILL PROHIBITED** |
| "**relabel** … separate-party E4 verification" | **STILL PROHIBITED** |
| "**manufacture** … separate-party E4 verification" | **STILL PROHIBITED** |
| `P2 E4: NOT ACHIEVED` as the standing status in every record | **UNCHANGED** — remains the status until genuine E4 is completed *and* canonically evidenced |
| No retroactive E4 credit for A-17…A-23 / mutation-hygiene / whole-tree PRIMARY evidence | **UNCHANGED** |
| Published evidence-qualified baseline frozen at **9.484375%** (v1.1 §10) | **UNCHANGED** — no recalculation authorized |
| All §5 limitations of the 2026-09-17 disposition (xproc-MFA race, P1-GAP-12 unkeyed digest, absent issuance idempotency key, A-20 test-class, G10, G19, EV-01/02/08, F1–F4, D02/D03/D14 UNSCORABLE, D07b 0.0000000/2.25, unimplemented P4–P7 surface) | **UNCHANGED — carried forward** |

### 3.3 What the authorization does and does not confer

- **Conferred:** the governance *permission to seek* genuine separate-party
  P2-E4 verification, and to perform the preparation steps that precede it.
- **Not conferred:** implementation authority; production-code modification;
  score recalculation or publication; rubric reconstruction; production
  qualification or deployment; governance weakening; evidence relabeling;
  independence manufacture; merge authority. **No score change and no
  production-readiness determination follows from this authorization.**
- **Not conferred, and not obtainable from this document:** the E4 class
  itself. Per the owner's own final clause, this authorization *is not* E4
  achievement.

---

## 4. Independence status probe, 2026-09-20 [REPO]

The authorization requires a **genuinely separate** verification party. Before
recording any plan, this session probed whether such a party is available in
its own environment. It is not.

| Probe | Command | Observed result |
|---|---|---|
| Authenticated GitHub actor | `gh auth status` | `Logged in to github.com as arena-ai-coding-agent[bot] (GH_TOKEN)` — the **same App that authored PR #37** |
| Actor identity read | `gh api user` | `HTTP 403 — Resource not accessible by integration` (bot token; identity not readable) |
| Git commit identity | `git config user.name` / `user.email` | `256624909+POWERBot-1@users.noreply.github.com` — the owner/merger account, i.e. **not a distinct verifier identity** |
| PR #37 review body | `gh pr view 37 --json reviews` | one review: author `POWERBot-1`, state `APPROVED`, body length **0** |

**Determination [REPO]:** the environment available to this session offers
**no second, distinct verification identity**. The 2026-09-17 finding
("the only authenticated actor was the same App that authored PR #37; the only
git identity was the owner/merger account") is **unchanged on 2026-09-20**.

**Consequence, recorded without softening:**

> **This session cannot perform P2-E4 and does not claim to have done so.**
> Any verification this session performs on any artifact is **PRIMARY
> (same-agent) at best**, exactly as classified in
> `P2_S8_WHOLE_TREE_VERIFICATION_PASS.md:6` and
> `CROSS_MILESTONE_EVIDENCE_CLAIM_AUDIT.md` finding EV-07. No E4 credit is
> claimed, asserted, or implied by any file written in this session.

**What a genuine E4 engagement therefore requires [OWNER-required standard]:** a
verifier operating under its own distinct identity and environment, whose
independence basis is documented in the report itself. Whether such a party can
be engaged is an owner/human matter; it is **not** resolvable by an agent
session acting on this repository's behalf. Recorded as **[UNVERIFIED —
out of session scope]**.

---

## 5. Governance sequence and current position

| Step | Status at end of this record |
|---|---|
| 1. AUDIT | **DONE (prior)** — `P2_S8_POSTMERGE_VERIFICATION.md` PM-04, `P0_V11_ASSESSMENT_AT_08ADBD9.md`, `P2_ASSURANCE_CAP_DISPOSITION.md` §2 |
| 2. AUTHORIZATION | **DONE (this record)** |
| 3. VERIFICATION PREPARATION | **DONE (documentation only)** — `P2_E4_VERIFICATION_PREPARATION.md`. Identifies the exact artifact, its ancestry/tree/working state, post-P2 modification disclosure, and the protocol the separate party must follow. **Contains no results, no findings, and no evidence class.** |
| 4. FRESH SEPARATE-PARTY VERIFICATION | **NOT PERFORMED** — no separate party engaged; no independence available in-session (§4) |
| 5. CANONICAL EVIDENCE | **NOT PERFORMED** — no `P2_S8_INDEPENDENT_VERIFICATION.md` exists in the tree |
| 6. INDEPENDENT REVIEW OF RESULTS | **NOT PERFORMED** — nothing to review |
| 7. SEPARATE SCORE AUTHORIZATION | **NOT PERFORMED / NOT REQUESTED** |

---

## 6. Rubric integrity (restated, not relaxed)

- The authoritative **JATA-P0-95-v1.0 numerical schedule remains
  UNRECOVERED.** No agent, verifier, or assessor may reconstruct its missing
  values by inference. This session performed **no** reconstruction, **no**
  renormalization, and **no** arithmetic on any missing value.
- `docs/rubric/JATA-P0-95-v1.1.md` and `docs/rubric/P0R-95_SCORECARD.md` are
  **untouched by this record** (see §8). The published baseline remains
  **9.484375% FROZEN**; production readiness remains **NOT READY**.
- Even a completed genuine E4 would **not** by itself move a published number:
  every unit except D07b is UNSCORABLE without the recovered schedule
  (`P2_POST_MILESTONE_V11_REASSESSMENT.md` §1). Evidence-class movement and
  score movement are different things, and only the latter requires the
  schedule.

---

## 7. Governance observation made while recording (for owner attention; not remediated)

Recording this authorization required reading current repository governance
state. One observation materially contradicts a committed record and is
reported here rather than left implicit. **No ruleset or gate was modified by
this session; no modification is authorized by the owner's text; and this
session's token cannot modify rulesets** (precedent:
`M1_CLOSURE_RECORD.md:87` — `PUT /rulesets/20134880` → `HTTP 403 — Resource
not accessible by integration`).

| Observation | Command | Observed (2026-09-20 ~07:25 UTC) |
|---|---|---|
| Ruleset `20134880` ("Jata Qi", `refs/heads/main`, enforcement `active`) required-approval count | `gh api repos/POWERBot-1/JATA-Qi/rulesets/20134880` | `required_approving_review_count: 0` |
| Same ruleset, last-modified stamp | same | `updated_at: 2026-09-18T17:24:09.815Z` (`created_at: 2026-07-31T16:22:21.909Z`) |
| Committed claim on 2026-09-17 | `docs/verification/P0_V11_ASSESSMENT_AT_08ADBD9.md:133` | *"the live ruleset now has **1 required approval**, required check `build · lint · test`, strict checks, thread resolution, deletion protection, no bypass actors"* |
| Status-check control (unchanged) | same API read | `required_status_checks: [{context: "build · lint · test", integration_id: 15368}]`, `strict_required_status_checks_policy: true` |
| Force-push protection | same API read | **no `non_fast_forward` rule present** (consistent with `P2_ASSURANCE_CAP_DISPOSITION.md` §5) |
| Bypass configuration | same API read | `bypass_actors` **key absent** from the single-ruleset response; `current_user_can_bypass: "never"` for this token. Bypass *configuration* is therefore **not** fully observable from this endpoint — recorded as **[UNVERIFIED]**, not asserted as "none" |
| Stale-review / last-push controls | same API read | `dismiss_stale_reviews_on_push: false`, `require_last_push_approval: false` (consistent with the disposition §5) |

**Why this matters to E4 specifically.** The separate party's report is
required to be *committed before merge authorization* (§19 rule 1). A ruleset
that requires **zero** approvals means a merge can be executed with no human
review gate at all, which weakens the assurance context the E4 report is meant
to serve. This session **flags** it and **does not fix** it: remediation is a
human-admin action (`administration:write`), and the owner's authorization
expressly forbids weakening or bypassing governance — it does not authorize
altering it either. **Owner decision required.**

---

## 8. Files changed by this record

| File | Change |
|---|---|
| `docs/verification/P2_E4_RECONSIDERATION_OWNER_AUTHORIZATION.md` | **added** — this record |
| `docs/verification/P2_E4_VERIFICATION_PREPARATION.md` | **added** — verification-preparation artifact (sequence step 3) |
| `docs/verification/P2_ASSURANCE_CAP_DISPOSITION.md` | **amended additively** — header amendment row + §7 amendment pointer; §§1–6 preserved verbatim; no historical finding altered |

**Untouched:** all production code (`packages/**`), all tests, all workflows,
`package.json`, `package-lock.json`, `docs/rubric/**`, all other
`docs/verification/**` records, the GitHub ruleset, PR #39's state, and every
historical verification report.

**Self-declared class of this session's work: PRIMARY (same-agent),
documentation-only. NOT E4. No E4 claimed.**

---

## 9. Standing statement

> **P2-E4: NOT ACHIEVED.**
>
> The 2026-09-20 owner authorization changes the permission to **seek** genuine
> E4 verification. It does not change the status, does not credit any existing
> evidence, and does not move any score. The repository must continue to state
> `P2-E4: NOT ACHIEVED` in every record until a genuinely separate party has
> verified the exact artifact and its report is canonically committed under
> `docs/verification/` per §19 rule 3.

**STOP.**
