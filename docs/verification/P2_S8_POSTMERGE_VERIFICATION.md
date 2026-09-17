# P2-S8 — POST-MERGE VERIFICATION RECORD

| Field | Value |
|---|---|
| Record type | Post-merge verification (naming per `P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` §19 rule 3) |
| Exact canonical artifact | **`08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`** |
| Pre-merge main (parent 1) | `2c1cad0ae9edbcc6ef13a241e120d3bb8de22415` (PR #36 merge) |
| Authorized PR head (parent 2) | `0a25b7ebc9eb464c1332044b8ea24a5c640920a1` |
| Merge commit | `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe` (PR #37) |
| Post-merge CI | run **`35252694561`**, `push`, head `08adbd9…`, conclusion **`success`** |
| Date (UTC) | 2026-09-17 |
| Evidence class of THIS record | **PRIMARY (same-agent, read-only)** — **NOT E4** (see §7) |
| Related records | `P2_S8_IMPLEMENTATION_REPORT.md`, `P2_S8_COMPLETION_REPORT.md`, `P2_S8_WHOLE_TREE_VERIFICATION_PASS.md`, `P2_S8_OPERATOR_RUNBOOK.md`, `P2_ASSURANCE_CAP_DISPOSITION.md`, `P0_V11_ASSESSMENT_AT_08ADBD9.md` |

---

## 1. Merge identity (verified read-only)

| Check | Method | Observed |
|---|---|---|
| PR #37 state | GitHub API | `MERGED`, base `main`, `reviewDecision: APPROVED` |
| Merge SHA | API + local git | `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe` |
| Merge parents | `git cat-file -p HEAD` | parent 1 = `2c1cad0ae9edbcc6ef13a241e120d3bb8de22415`; parent 2 = `0a25b7ebc9eb464c1332044b8ea24a5c640920a1` |
| Authorized head actually merged | API (`pulls/37`) vs remote branch head | **equal** — `0a25b7eb…` was both the PR head and remote branch head; it is parent 2 |
| Post-merge main | `git rev-parse HEAD`, `origin/main`, API `branches/main` | all three = `08adbd9…` |
| Commits on `main` after the merge | API commit list | **none** |
| Merge actor / approver | API | merged and approved by `POWERBot-1` (approval body empty) |
| Branch protection | API `branches/main` | `protected: true` |

## 2. Merge scope (verified at commit level)

`compare(2c1cad0…08adbd9)`: **3 commits ahead, 16 files, +3491/−30**.

| Class | Count | Detail |
|---|---|---|
| Test files (`packages/*/test/`) | 9 | 7 new S8 suites + worker helper; `p2-s7-mutation.test.ts` migrated to disposable-copy execution |
| `docs/verification/` records | 5 | implementation report, completion report, whole-tree pass, runbook, v1.1 reassessment |
| Rubric scorecard | 1 | `docs/rubric/P0R-95_SCORECARD.md` (+14 lines, S8 addendum) |
| **Production `src/` files** | **0** | **no production-code change — independently confirmed at commit level** |

The "verification-only milestone" claim in `P2_S8_IMPLEMENTATION_REPORT.md` §0 is
therefore **confirmed by the merged diff**, not merely asserted.

## 3. Post-merge CI (metadata class; logs inaccessible)

Run `35252694561` — `push`, head `08adbd9…`, created `2026-09-17T17:25:56Z`,
updated `17:36:03Z`, conclusion **`success`**. Job **`build · lint · test`** —
**all steps success**:

`Set up job` · `Checkout` · `Set up Node.js` · `Install dependencies` ·
`Verify workspace/lockfile integrity` · `Build all workspaces` · `Lint` ·
`Test (all workspaces)` · `PostgreSQL integration status` ·
`Embedded-PostgreSQL readiness diagnostics` · post-steps.

**Honest limits:** these are **run/job/step conclusions from the API**. The
workflow's `PostgreSQL integration status` step is fail-hard on any `SKIP`, so a
green step is CI's own assertion of no skip — it is **not** an independently read
skip count. **Raw log content was not retrieved**: an attempt during this task
returned **0 bytes** from GitHub's log storage (egress-blocked), re-confirming the
G10-class limitation on this artifact's run. No log text, no lint-warning count,
and no assertion-level detail is quoted anywhere in this record.

## 4. Exact local verification performed (and not performed)

**Performed (read-only):**
1. Local ref/identity checks: `git rev-parse`, `git cat-file -p HEAD`, `git log`.
2. Merge-graph and parent-identity verification; ancestry of both parents.
3. Diff-scope verification via GitHub compare API (file classes and line counts, §2).
4. Absence check for `P2_S8_INDEPENDENT_VERIFICATION.md` and inventory of the
   three IV-class records present in `docs/verification/`.
5. Live ruleset `20134880` read-back (§5).
6. CI run/job/step metadata read (§3).
7. Working-tree cleanliness (`git status --porcelain` empty) before and after.

**NOT performed (stated explicitly so this record is not over-read):**
- **No build, lint, test, mutation, or suite execution** was performed locally in
  this verification session. Accordingly this record **claims no local
  pass/fail counts, no skip counts, and no assertion-level results**. The
  milestone's own same-agent whole-tree pass
  (`P2_S8_WHOLE_TREE_VERIFICATION_PASS.md`) remains the PRIMARY execution
  evidence; CI §3 is the CI-class evidence.
- No raw CI log access (§3).
- No source, test, or assertion was modified; nothing was weakened; no
  speculative fix was attempted.

*Rationale for not re-running locally:* the environment is not CI-parity
(Node **v22.22.3** vs CI **Node 20**; 2 vCPU; no installed toolchain; shallow
clone), and a same-agent re-run cannot change the assurance class obtained for
this milestone. A local re-execution remains available to a **separate party**
and would be evidence for their report — never a substitute for their identity.

## 5. Ruleset read-back (live; read-only; unmodified)

Ruleset **`Jata Qi`, id `20134880`**: `target: branch`, `enforcement: active`,
`ref_name.include: ["refs/heads/main"]`, `bypass_actors: null`,
`updated_at: 2026-09-17T10:41:35Z`. Live rule types: `deletion`,
`pull_request`, `required_status_checks`.

| Control | Live value |
|---|---|
| Required approvals | **1** |
| Required check | **`build · lint · test`** (integration_id 15368) |
| Strict checks | **true** (`strict_required_status_checks_policy`) |
| Thread resolution | **true** |
| Deletion protection | **present** |
| Bypass actors | **none** |
| **Force-push / `non_fast_forward`** | **ABSENT** |
| `dismiss_stale_reviews_on_push` / `require_last_push_approval` | **false / false** |

**Discrepancy recorded, cause NOT inferred:** `PHASE_A_GOVERNANCE_AND_CRITICAL_PATH.md`
§A.1 (read 2026-09-11) and the prescribed Phase-A/M1 payload both record
`non_fast_forward` as present/preserved; the live ruleset does not contain it.
The ruleset history endpoint returns `403` for the available token, so the change
event cannot be inspected. **No repair was attempted** (human-admin decision).

## 6. Findings register

| ID | Finding | Class | Status |
|---|---|---|---|
| PM-01 | Merge graph, parent identity, and post-merge main all agree with the authorized values | PASS (verification) | Recorded |
| PM-02 | Zero production `src/` changes in the merged diff — verification-only milestone confirmed at commit level | PASS (verification) | Recorded |
| PM-03 | Post-merge CI green on the exact merge SHA, all steps | PASS (CI class) | Recorded |
| PM-04 | **No `P2_S8_INDEPENDENT_VERIFICATION.md` exists**; S8's E4 acceptance item is unsatisfied | **EVIDENCE GAP** | Carried; governed by `P2_ASSURANCE_CAP_DISPOSITION.md` |
| PM-05 | Raw CI logs remain inaccessible (0 bytes) — G10-class limitation live on this run | EVIDENCE LIMITATION | Carried; G10 stays OPEN |
| PM-06 | Force-push protection absent; live ruleset differs from prior records; no committed read-back existed before today | GOVERNANCE | Recorded; human-admin decision |
| PM-07 | Stale-review dismissal and last-push approval disabled | GOVERNANCE (hardening) | Recorded; human-admin decision |
| PM-08 | No local suite re-execution in this session | LIMITATION (disclosed §4) | Recorded |

## 7. Verification-class statement (explicit)

This is a **post-merge verification record**, not an independent verification.
Per `P2_ASSURANCE_CAP_DISPOSITION.md`:

- **`P2 E4: NOT ACHIEVED.`** No separate-party verification exists for P2-S8
  (or for any P2 slice); the owner has permanently capped P2 without E4.
- This record is **PRIMARY / same-agent** and is labelled as such; it must never
  be cited as E4, and its CI section must never be cited as independent
  verification.
- **A-20 remains test-class**; no production HA/DR exists or is claimed.
- **No previously open architectural gap is claimed solved** by this record.

## 8. Determination

**Post-merge state: VERIFIED (operationally) with disclosed limitations.**
PR #37 merged the correct authorized head; post-merge `main` equals the merge
SHA; the diff is verification-only; post-merge CI is green on the exact artifact;
the working tree is clean. The milestone's **E4 gate remains UNSATISFIED**, and
that is now a recorded, owner-authorized permanent assurance cap rather than an
outstanding action item.

**STOP. No merge action, no ruleset change, and no remediation accompanies this record.**
