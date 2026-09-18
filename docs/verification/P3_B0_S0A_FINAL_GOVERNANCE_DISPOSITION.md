# P3-B₀ SLICE S0a — FINAL GOVERNANCE DISPOSITION

| Field | Value |
|---|---|
| Document Class | **GOVERNANCE DISPOSITION RECORD.** Records the owner's five blocker dispositions and the result of the final read-only merge gate check. |
| PR under disposition | **#40** — base `main` · head branch `arena/01a0b3c7-jata-qi` · head **`ab9914a`** · baseline `6b61256` · scope **S0a only** |
| Authorization | Owner: *"I AUTHORIZE the FINAL GOVERNANCE DISPOSITION AND MERGE DECISION FOR PR #40, subject to the exact conditions below."* |
| Date (UTC) | 2026-09-18 |
| **GATE RESULT** | **All ten gate conditions confirmed (§2).** |
| **MERGE RESULT** | **NOT MERGED — a normal merge is not executable.** The active ruleset blocks it on two independent grounds, and the owner expressly forbade bypassing branch protections (§3). **No bypass was attempted. No approval was manufactured. No check, ruleset, or protection was altered.** |

---

## 1. OWNER DISPOSITIONS — RECORDED VERBATIM

The following are the owner's dispositions, recorded exactly as issued. They are owner decisions, not findings of this session.

| Blocker | Disposition (as directed by the owner) |
|---|---|
| **B-1** — CI failure | **DISPOSITIONED — KNOWN TRANSIENT FLAKE / NO S0a CAUSATION.** The owner accepted the evidence-based classification: the failed required check is a known transient/flaky race in a pre-existing, unmodified authentication test; not caused by S0a; no S0a security regression demonstrated; the exact failing assertion identified; local Node 20.18.1 reproduction 10/10 pass; the CI-tested tree byte-identical to `ab9914a`; R-17/I-6 and the PostgreSQL-plane tests passed in that run. |
| **B-2** — T-16 evidence defect | **DISPOSITIONED — EVIDENCE DEFECT / NO DEMONSTRATED SECURITY REGRESSION.** The 88 transitions were derived from a self-referential corpus rather than a deployed-grant corpus. Accepted as an evidence/reporting defect with no demonstrated S0a implementation regression and no demonstrated adverse deployed-grant decision. The absence of a deployed-grant corpus remains an evidentiary limitation. T-16 is **not** rewritten and no deployed-grant evidence is manufactured. |
| **B-3** — U-1 specification gap / T-16 claim | **DISPOSITIONED — SPECIFICATION GAP + FALSE EVIDENCE CLAIM — NO DEMONSTRATED CURRENT S0a SECURITY BYPASS.** The four line-terminator differences are real; `[^/.]*` faithfully implements the literal U-1 election; U-1 itself did not specify treatment of those characters; T-16's "zero widening" statement is false as a general semantic claim; no affected authorization decision or bypass was demonstrated. **Matcher semantics are not silently changed.** The specification question is carried forward into the canonicalization / input-contract design work and must be resolved under **separate authorization**. |
| **B-4** — static guard weakness | **DISPOSITIONED — NON-BLOCKING TEST-MECHANISM WEAKNESS.** The current matcher bodies are genuinely identical at `ab9914a`; the I-6 guard is weaker than literal byte-identity proof; realistic single-site drift is detected; the adversarial false positive demonstrates a weakness in the guard mechanism; no present S0a matcher divergence was demonstrated. **No guard remediation is authorized by this disposition.** |
| **B-5** — governance record | **DISPOSITIONED — GOVERNANCE HISTORY PRESERVED POST-FACTO WITH PROVENANCE LIMITATIONS DISCLOSED.** Documented by `f244058`. This record must **not** be represented as contemporaneous authorization. |

### 1.1 Mandatory disclosure attached to B-1

The required check `build · lint · test` is **NOT green and is not represented as green**. It is and remains **historically RED** at `ab9914a` (`conclusion=FAILURE`). Its disposition above concerns *causation and severity*, not the colour of the check.

### 1.2 Status of P2-E4

**P2-E4 remains a separate tracked governance matter.** The frozen score is unchanged at **9.484375%**; P2-E4 remains **NOT ACHIEVED**. Nothing in this disposition retrospectively alters it.

---

## 2. FINAL READ-ONLY GATE CHECK — ALL TEN CONDITIONS

| # | Condition | Result | Evidence |
|---|---|---|---|
| 1 | PR #40 head remains exactly `ab9914a` | **CONFIRMED** | `headRefOid = ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7`; branch `arena/01a0b3c7-jata-qi`; base `main` |
| 2 | No unauthorized commits or file changes have entered PR #40 | **CONFIRMED** | The branch carries exactly **2** commits vs baseline (`503e67b` docs evidence record, `ab9914a` S0a change); total diff = **6 files, 895 insertions(+), 2 deletions(−)**; the head tree is byte-identical to the CI-tested merge tree `c03bce24` (`git diff --stat ab9914a c03bce24` empty) |
| 3 | PR #40 contains only the authorized S0a scope plus its authorized evidence records | **CONFIRMED** | Exactly: `docs/verification/P3_B0_DESIGN_INDEPENDENT_VERIFICATION.md` (+229) · `docs/verification/T16_GRANT_CORPUS_REEVALUATION_REPORT.md` (+94) · `packages/authentication/src/delegation-types.ts` (1+/1−) · `packages/authorization-boundary/src/capability-manifests.ts` (1+/1−) · `packages/authorization-boundary/test/r17-matcher-conformance.test.ts` (+468) · `scripts/t16-grant-corpus-eval.mjs` (+102) |
| 4 | PR #39 remains untouched and unmerged | **CONFIRMED** | PR #39: `state=OPEN`, `mergedAt=null`, head `608a6ea` — unchanged from its previously recorded value |
| 5 | No S0b/S0c/S1/S2/S3 implementation has occurred | **CONFIRMED** | No implementation. Grep of the added lines returns only **prose references inside the evidence/roadmap document** — e.g. "Dependency Invariants: S1 merge depends on S0a & S0b…", "S0c rollback warning…", "…an evidence artifact and does NOT grant authorization for P3-B implementation, nor does it authorize S0a, S0b, or S0c." No S0b/S0c/S1/S2/S3 code, module, or test exists |
| 6 | All five blocker dispositions above are recorded truthfully | **CONFIRMED** | §1 of this record, with the B-1 red-check disclosure (§1.1) and the B-5 provenance limitation |
| 7 | No production-readiness claim is introduced | **CONFIRMED** | The only matches in the added lines are **disclaimers of** readiness, not claims: "strictly forbid … unverified production readiness claims"; "product remains NOT READY FOR PRODUCTION" |
| 8 | The frozen P2-E4 score remains **9.484375%** | **CONFIRMED** | Recorded at `docs/rubric/JATA-P0-95-v1.1.md` (`9.484375%` evidence-qualified baseline; production readiness NOT READY) and `docs/rubric/P0R-95_SCORECARD.md` (`9.484375% — FROZEN, change 0.0000000 pp`). **PR #40 touches no `docs/rubric/` file.** |
| 9 | No repository ruleset or CI requirement has been weakened or bypassed | **CONFIRMED** | Ruleset `20134880` ("Jata Qi") is `enforcement=active`, targeting `refs/heads/main`, **unmodified** — `updated_at = 2026-09-17T10:41:35.163Z`, identical to its previously recorded value. PR #40's diff contains **no `.github/` file**. No check was disabled, no ruleset altered, no protection bypassed |
| 10 | The historical red CI result is disclosed rather than represented as green | **CONFIRMED** | §1.1 and §3. The required check is stated to be historically RED in every reference |

**All ten conditions confirmed.** No condition failed.

---

## 3. MERGE DECISION — NOT MERGED. NORMAL MERGE IS NOT EXECUTABLE.

The owner authorized a merge *"if and only if the final gate check confirms all ten conditions"* and directed the use of *"the repository's normal non-force merge mechanism"*, expressly prohibiting: *"Do NOT squash, rewrite, force-push, disable checks, alter rulesets, or bypass branch protections."*

**All ten conditions are confirmed (§2). However, GitHub will not perform a normal merge of PR #40.** The active ruleset imposes two independent, simultaneously-failing requirements:

| Blocker | Ruleset requirement | PR #40 actual | Consequence |
|---|---|---|---|
| **A** | `required_status_checks`: context **`build · lint · test`** with `strict_required_status_checks_policy: true` | `status=COMPLETED`, **`conclusion=FAILURE`** | The required check must pass; it does not |
| **B** | `pull_request`: **`required_approving_review_count: 1`** | **0 reviews** (and 0 requested reviewers) | The required approval has not been given |

Ruleset facts (read-only, from the rulesets API):

```
id                 : 20134880   name: "Jata Qi"
target             : branch      enforcement: ACTIVE
conditions.ref_name.include : ["refs/heads/main"]
bypass_actors      : null        <-- NO bypass list is configured on the ruleset
rules              : deletion, pull_request{required_approving_review_count: 1,
                     required_review_thread_resolution: true,
                     allowed_merge_methods: [merge, squash, rebase]},
                     required_status_checks{strict: true,
                     required: ["build · lint · test"]}
```

GitHub's own computed merge state for PR #40:

```
mergeable        = MERGEABLE     (no conflicts)
mergeStateStatus = BLOCKED       (ruleset requirements unmet)
reviewDecision   = REVIEW_REQUIRED
```

**Assessment.** A merge could only complete by **overriding an active ruleset** — i.e. by bypassing branch protections, which the authorization explicitly forbids, and which would simultaneously falsify gate condition 9 (*"No repository ruleset or CI requirement has been weakened or bypassed"*) in the act of merging. Blocker **B** is additionally independent of CI: even a green check would not make a normal merge available without an approving review.

**Accordingly, and per the standing instruction to *"STOP and report the exact blocker rather than repairing it,"* no merge was performed.**

### 3.1 What was deliberately NOT done

- **No merge** — no `--merge`, no `--squash`, no `--rebase`.
- **No bypass** — `--admin` was not used, and no override of the ruleset was attempted.
- **No self-approval.** No review was submitted to satisfy the `required_approving_review_count: 1` requirement. Manufacturing the required approval would be a fabricated governance act, and the verifying party approving the implementation's PR would defeat the separation this verification exists to provide. **The approval slot is left empty for the owner.**
- **No check re-run.** The red required check was not re-run to attempt a green result (separately prohibited, and not authorized).
- **No ruleset or workflow change.** Ruleset `20134880` is untouched (`updated_at` unchanged); no CI requirement was disabled, relaxed, or bypassed.
- **No change to PR #40**, its branch, its head, or its scope. **PR #39 untouched.**
- No S0b/S0c/S1/S2/S3 implementation; no P3-B implementation; no score or readiness change.

### 3.2 The exact remediation paths (owner action required — none taken)

1. **Satisfy the review requirement** — an approving review by an authorized reviewer on PR #40. Only the owner can supply this.
2. **Satisfy the status-check requirement** — the `build · lint · test` check must reach a passing conclusion on `ab9914a`. That requires either a re-run (which may still flake, since the failure is non-deterministic) or the test-only de-flake contemplated in §7.3 of the B-1 classification — **neither of which is authorized by this message**.
3. **Alternatively, the owner may amend the ruleset** — an owner decision outside this session's authority, and one that would have to be weighed against gate condition 9.

**This session took none of these paths.** It reports the blocker and stops.

---

## 4. STANDING STATE AFTER THIS RECORD

| Item | State |
|---|---|
| PR #40 | **OPEN · `mergedAt=null` · head `ab9914a` · `mergeStateStatus=BLOCKED`** |
| PR #39 | **OPEN · `mergedAt=null` · head `608a6ea` · untouched** |
| `main` | Still `6b61256` — the baseline. **Unchanged by this session.** |
| Required check `build · lint · test` @ `ab9914a` | **Historically RED** (not green, not re-run) |
| Ruleset `20134880` | ACTIVE, unmodified (`updated_at 2026-09-17T10:41:35.163Z`) |
| P2-E4 score | **9.484375% — FROZEN**, unchanged |
| Production readiness | **NOT READY** — no readiness claim made |
| S0b / S0c / S1 / S2 / S3 | **NOT AUTHORIZED, NOT IMPLEMENTED** |
| B-1 … B-5 | Dispositioned (§1); B-3's specification question carried forward under separate authorization |

---

*— End of final governance disposition. The merge gate check passed on all ten conditions; the merge itself is blocked by an active, unmodified ruleset on two independent grounds, and bypassing branch protections was expressly prohibited. No merge performed. Awaiting the owner's resolution of §3.2. —*
