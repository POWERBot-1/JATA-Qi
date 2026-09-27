# P2-E4 OWNER-SIDE REPRODUCIBILITY DRY-RUN AT `08adbd9` — NON-INDEPENDENT

| Field | Value |
|---|---|
| Record type | Owner/builder execution record (reproducibility dry-run) |
| **Evidence class** | **PRIMARY — owner/builder. NOT E4. NOT independent verification.** |
| Executor | Arena agent session `arena/01a0e22c-jata-qi` |
| Executor principal | The **implementation-side** principal: git identity `POWERBot-1 <256624909+POWERBot-1@users.noreply.github.com>`; GitHub credential is a repository App installation token |
| Executed (UTC) | 2026-09-27, 09:24:43Z → 09:48:26Z |
| Target artifact | `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe` |
| Target tree | `5f2152ce0cd702b649b93bc23c165d36cb9b9dba` |
| E4 determination | **NONE ISSUED.** This record issues no PASS, no FAIL, and no E4 verdict. |
| Verifier eligibility | **NOT ESTABLISHED** — see `P2_E4_VERIFIER_ELIGIBILITY_GAP.md` |
| Effect on standing state | **None.** P2-E4 NOT ACHIEVED; `9.484375%` FROZEN; assurance cap IN FORCE; production NOT READY. |

> **Read this first.** This is **not**
> `docs/verification/P2_S8_INDEPENDENT_VERIFICATION.md` and does not substitute
> for it. Under BD-01 §3, execution by the implementing principal is PRIMARY
> evidence **regardless of how completely it is executed and retained** — rigor
> does not convert class. Everything below is offered so that a genuinely
> eligible verifier inherits a known-good, fully documented execution path
> instead of a list of expectations. It must never be relabelled, quoted, or
> summarised as independent verification.

---

## 1. Why this was run despite eligibility failing

Phase 2 (verifier eligibility) **failed**: no eligible separate verifier could be
corroborated from this session. Phase 3 independent execution is therefore not
authorized and was **not** performed or claimed.

The canonical 13-step sequence was nonetheless executed once, in full, against
the exact target artifact, because two of the owner's stop conditions can only be
answered by running it:

- *"the environment cannot reproduce the required execution"* — now answered with
  observations rather than assumptions;
- *"required evidence cannot be retained"* — now answered with hashes and logs.

The run is recorded at its true class. No independence is asserted, inferred, or
implied.

---

## 2. Environment (observed, `logs/02-environment.log`)

| Item | Observed |
|---|---|
| Host | `Linux e2b.local 6.1.158+ #1 SMP PREEMPT_DYNAMIC … x86_64 GNU/Linux` |
| OS | `Debian GNU/Linux 12 (bookworm)` container |
| Node | `v22.22.3` |
| npm | `10.9.8` |
| Git | `git version 2.39.5` |
| CPU / memory | **2 vCPU / 3939 MiB total** |
| PostgreSQL | `postgres (PostgreSQL) 18.4` from `@embedded-postgres/linux-x64` installed by `npm ci` |
| Registry reachability | `npm ping` → `PONG` (1 match) |
| Custody | **Owner-provisioned Arena sandbox — fails BD-01 IV-6** |

**Environment divergences that an eligible verifier must not inherit silently:**
this is Node **v22.22.3**, not the Node 20 line; git 2.39.5, not 2.53.0; Debian
12 container, not Ubuntu 26.04.1/WSL; and **2 vCPU / 3.9 GiB**, which is far below
what the A-18 32-process contention suite nominally wants. Every suite still
completed (see §5), but the resource envelope is a real difference and is
recorded rather than smoothed over.

---

## 3. Target establishment (`logs/01-checkout.log`)

```
git worktree add --detach /home/user/p2-e4-run/worktree 08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe
→ Preparing worktree (detached HEAD 08adbd9)
→ HEAD is now at 08adbd9 Merge pull request #37 from POWERBot-1/arena/01a0afbe-jata-qi
```

| Check | Observed |
|---|---|
| `git rev-parse HEAD` | `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe` — **match** |
| `git rev-parse HEAD^{tree}` | `5f2152ce0cd702b649b93bc23c165d36cb9b9dba` — **match** |
| Detached | true |
| `git status --porcelain=v1` before any command | empty |
| Tracked path count | **725** |
| Commit identity | `Merge: 2c1cad0 0a25b7e`; Author `POWERBot-1`; AuthorDate `Thu Sep 17 10:25:52 2026 -0700`; subject `Merge pull request #37 …` |

The target was obtained by `git fetch --no-tags origin 08adbd9a…` → `* branch
08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe -> FETCH_HEAD`. The SHA **is** exposed by
the remote: before the fetch, `git cat-file -t 08adbd9a…` failed with `could not
get object info` (exit 128) because the object had simply not been fetched into
this clone; after it, `git cat-file -t` returns `commit`. Current `main` /
`e82897bb…` was **not** substituted at any point; every step recorded the same
commit and tree (§7).

---

## 4. Declared expectations vs observations

Expectations were taken from PR #44's `EXPECTED_RESULTS.json` — owner-side,
declared before execution, explicitly labelled *"not observations."* They were
**not** copied into the evidence column. Each row below was read out of the
retained log for that step.

| # | Canonical step | Command | Exit | Observed (from retained log) | Expected | Divergence |
|---:|---|---|---:|---|---|---|
| 1 | Clean checkout, exact SHA/tree | `git worktree add --detach … 08adbd9a…` | 0 | HEAD and tree match; detached; clean; 725 paths | exact SHA/tree, clean | none |
| 2 | Environment manifest | `uname -a`, `node --version`, … | 0 | Node v22.22.3, npm 10.9.8, git 2.39.5, 2 vCPU/3939 MiB, PG 18.4 | Node ≥ 20 | **version/host differ from prior reports — recorded** |
| 3 | `npm ci` | `npm ci --no-audit --no-fund` | 0 | `added 178 packages in 4s`; 1 deprecation warning (`eslint@9.39.5`) | exit 0 | none (warning noted) |
| 4 | Workspace verification | `npm run check:workspaces` | 0 | `Workspace/lockfile consistency check passed (50 workspaces).` | exit 0 | none |
| 5 | Build | `npm run build` | 0 | All 50 workspace builds completed; zero TypeScript errors | exit 0 | none |
| 6 | Lint | `npm run lint` | 0 | `✖ 60 problems (0 errors, 60 warnings)` | exit 0, zero errors | **0 errors but 60 warnings — recorded** |
| 7 | Whole-tree tests | `npm test` | 0 | `Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0`; case-level TAP aggregate **1619 tests / 1619 pass / 0 fail / 0 skipped**; aggregate `duration_ms 620358`; embedded PostgreSQL came up **22** times (`database system is ready to accept connections`) — real integration, not skips | 50/50, 0 failed, 0 skipped, PG executed | none |
| 8 | A-17 … A-23 focused suites | see §5 | 0 (all 7) | see §5 | 4/4, 5/5, 3/3, 3/3, 3/3, 6/6, 11/11 | none |
| 9 | Mutation hygiene | `node --test dist/test/p2-s8-mutation-hygiene.test.js` | 0 | **4/4 pass, 0 fail, 0 skipped** | 4/4 | none |
| 10 | Disposable P2-S7 mutation | `node --test dist/test/p2-s7-mutation.test.js` | 0 | **17/17 pass**, of which **15/15 mutants killed**; `INCONCLUSIVE` occurrences **0**; `not ok` occurrences **0**; byte-equality subtest passed; tracked tree unchanged | 17/17, 15/15 killed | none |
| 11 | Negative-assertion + provider/config inspection | two recorded greps | 0 | 40 negative-assertion matches across the 9 target suites; provider/seam and CI configuration captured | inspection recorded | none |
| 12 | Final integrity | `git rev-parse`, `git diff --exit-code`, `ls-tree \| sha256sum` | 0 | commit/tree match; `status --porcelain` empty; `git diff --exit-code` → 0; 725 paths; `sha256 = 4da512f6d9c936445f4f9014a0d25ffc5abbd3c53cc54696058db041aaed6637` | unchanged | none |
| 13 | Machine-readable records | generated from the logs | 0 | `logs/13-result-record.json` (19 steps, `overallExitCode 0`) and `logs/13-evidence-manifest.json` (23 artifacts, each sha256-hashed) | generated | none |

**Overall observed exit status across all 19 recorded steps: 0.**

---

## 5. Focused suite detail (observed subtests, not expectations)

| Suite | Log | Tests | Pass | Fail | Skip |
|---|---|---:|---:|---:|---:|
| A-17 restart/recovery | `08a-A-17.log` | 4 | 4 | 0 | 0 |
| A-18 fan-out/contention | `08b-A-18.log` | 5 | 5 | 0 | 0 |
| A-19 authentication outage | `08c-A-19-auth.log` | 3 | 3 | 0 | 0 |
| A-19 authorization outage | `08d-A-19-authz.log` | 3 | 3 | 0 | 0 |
| A-20 failover | `08e-A-20.log` | 3 | 3 | 0 | 0 |
| A-21 skew/boundary | `08f-A-21.log` | 6 | 6 | 0 | 0 |
| A-22/A-23 tamper + duplicates | `08g-A-22-A-23.log` | 11 | 11 | 0 | 0 |
| Mutation hygiene | `09-mutation-hygiene.log` | 4 | 4 | 0 | 0 |
| Disposable P2-S7 mutation | `10-disposable-mutation.log` | 17 | 17 | 0 | 0 |

A-18 observed subtests (verbatim names from the log):

1. `PostgreSQL backend started and the seed verifies`
2. `A-18 break-glass one-shot: 32 processes race → exactly 1 winner, 31 BG_ONE_SHOT, 1 elevation`
3. `A-18 session verify load: 32 processes × 10 verifies → 320/320 succeed, zero duplicate accepts`
4. `A-18 elevation revoke race: 8 revokers → terminal exactly once, every racer resolves`
5. `A-18 cross-process MFA boundary: a fresh process fails closed (documented limitation)`

Disposable mutation — all 15 mutants observed killed (`ok`, none `INCONCLUSIVE`):
M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M-S3-1, M-S3-2, M-S3-3, M-S6-1, M-S6-2.
Subtest 1 `captures pristine sources` and subtest 17 `every tracked source file is
untouched byte-for-byte after the suite` both `ok`.

---

## 6. Negative assertions inspected (`logs/11a-negative-assertion-inspection.log`)

40 matching lines were retained across the nine target suites (counted between the `--- begin output ---` and `--- end output ---` markers; the log file itself has 42 colon-bearing lines because the step header and footer each contain colons). The negative
claims are real assertions in the artifact, not prose:

| Negative claim | Where it is actually asserted |
|---|---|
| No ALLOW during authentication outage; no memory fallback; no hang | `packages/authentication/test/p2-s8-outage-matrix.test.ts:70` — `assert.ok(!/ALLOW/.test(outcome.message), …)`; `:214` test name; `:274` `assert.fail(…)` recovery guard |
| No ALLOW during authorization outage; DENY `SECURITY_STATE_UNAVAILABLE` | `packages/authorization-boundary/test/p2-s8-decision-outage.test.ts:71`, `:246`; observed subtest `ok 2 - A-19 outage: privilege/delegation/plain decisions DENY SECURITY_STATE_UNAVAILABLE (never ALLOW)` |
| Exactly one break-glass winner; zero duplicate accepts | `packages/authentication/test/p2-s8-fanout-contention.test.ts:194`, `:203`; observed subtests 2 and 3 |
| Cross-process MFA fails closed (capability **not** established) | `packages/authentication/test/p2-s8-fanout-contention.test.ts:261`; observed subtest 5 — a negative control, not a positive capability |
| Tampered / shape-violated rows refused at re-read | `packages/authentication/test/p2-s8-tamper-duplicates.test.ts:210`, `:222`, `:274`, `:371`, `:395`, `:409`, `:450` (`assert.rejects`) |
| One-shot break-glass re-activation refused | same file `:501` — `assert.rejects(bg.activate(input), /BG_ONE_SHOT/)` |
| No secret material in durable rows | `packages/authentication/test/p2-s7-mutation.test.ts:247` control; observed A-22 subtest 6 `no-material sweep: no known secret appears in any durable P2 row` |
| Tracked tree never mutated by the mutation harness | `p2-s7-mutation.test.ts:350`, `:472`, `:502`; observed subtest 17; plus step 12 `git diff --exit-code` → 0 |

A surviving mutant, a skipped suite, or a tracked-tree write would have been a
finding. None occurred: `INCONCLUSIVE` count 0, skipped count 0 in every focused
suite, tracked diff empty.

---

## 7. Integrity and provenance

| Check | Observed |
|---|---|
| Commit recorded at **every** step | `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe` — the only value present in any step log |
| Tree recorded at **every** step | `5f2152ce0cd702b649b93bc23c165d36cb9b9dba` — the only value present in any step log |
| Tracked status after each step | `[]` for every step that reports it |
| Final `git diff --exit-code -- .` | exit **0** (no tracked modification) |
| `git ls-tree -r HEAD` path count | **725** |
| `sha256` of observed tree listing | `4da512f6d9c936445f4f9014a0d25ffc5abbd3c53cc54696058db041aaed6637` |
| Independent `sha256` of `git ls-tree -r 08adbd9a…` | identical — `4da512f6d9c936445f4f9014a0d25ffc5abbd3c53cc54696058db041aaed6637` |
| Comparison against PR #44's `artifact-tree-manifest.json` | `sha256Match: true`; `entryLevelMismatchCount: 0` across all 725 path/mode/type/blob-sha entries (`logs/12b-tree-manifest-comparison.json`) |
| Session branch | `arena/01a0e22c-jata-qi`; the session working tree was **not** used for execution |
| Target mutated | **No.** The disposable worktree is separate; the target commit object is unchanged |

---

## 8. Retained evidence

Machine-readable records: `logs/13-result-record.json` (19 steps; per-step command,
exit code, UTC start/end, log sha256, TAP summary; `overallExitCode 0`) and
`logs/13-evidence-manifest.json` (23 artifacts with byte counts and sha256, all
re-verified 23/23). The whole-tree step carries a `summaryNote` warning that the
first `# tests N` line in that log belongs to a single package and must not be
read as the whole-tree total; the authoritative figures are the runner summary
line `Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0` and the case-level
aggregate 1619/1619.

**Retention limitation (material, and honestly stated).** The 23 raw artifacts
(≈1.2 MB) exist only at `/home/user/p2-e4-run/logs/` on the **ephemeral sandbox
filesystem**, outside the repository. They are **not** committed to Git — the
repository convention keeps generated artifacts out of the tree — and they are
**not** under verifier custody. They will not survive the sandbox.

What is durable is therefore: the hashes recorded in `13-evidence-manifest.json`
and transcribed here, and the observed outputs quoted verbatim in §3–§7. That is
a **weaker** retention position than an eligible verifier must have, and it is one
of the reasons this record cannot carry E4 weight even setting independence
aside. An eligible verifier must retain their own raw copies under their own
custody and must not inherit these.

**Manifest integrity note.** The first generated manifest hashed
`13-result-record.json` before that file's whole-tree summary field was corrected
(see §11 note), so one hash did not match the file it named. The manifest was
regenerated from the final files and re-verified: **23/23 artifacts, 0
mismatches**. The defect is recorded rather than quietly fixed.

---

## 9. Findings

| # | Finding | Class | Disposition |
|---:|---|---|---|
| F-1 | Verifier eligibility could not be corroborated from this session; the only principal able to act is the implementation-side principal. | **BLOCKING for E4** | `P2_E4_VERIFIER_ELIGIBILITY_GAP.md`. STOP. |
| F-2 | BD-01 (explicit definition of "independent verification") was never adopted, so independence claims in the tree have no testable standard. | Governance prerequisite | `docs/BD-01_INDEPENDENT_VERIFICATION_DEFINITION.md` prepared; **not adopted, not merged.** |
| F-3 | Execution environment differs materially from the environments named in prior reports (Node v22.22.3 vs v20.20.2; git 2.39.5 vs 2.53.0; Debian 12 container vs Ubuntu/WSL; **2 vCPU / 3.9 GiB**). | Non-blocking, must be disclosed | Recorded. An eligible verifier must publish their own manifest. |
| F-4 | Lint reports **60 warnings** (0 errors). Prior summaries state "0 errors" without the warning count. | Non-blocking | Recorded as observed. |
| F-5 | `npm ci` emits a deprecation warning for `eslint@9.39.5`. | Informational | Recorded. |
| F-6 | A-18 cross-process MFA remains **not established**; the suite asserts fail-closed behaviour only. | Existing limitation, reproduced | Retained verbatim; not upgraded. |
| F-7 | P1-GAP-12 (envelope integrity is an unkeyed SHA-256 — tamper-evidence, not origin authenticity) and A-23 issuance lacking an idempotency key remain as dispositioned. | Existing limitations | Not remediated; not authorized. |
| F-8 | Evidence retention is sandbox-local rather than verifier-custodied. | Process limitation | Recorded; see §8. |

No finding was closed, downgraded, or reworded to produce a cleaner result. No
test expectation was altered. No suite was skipped or omitted.

---

## 10. Acceptance mapping

| Required coverage item (owner authorization) | Covered here? | Where |
|---|---|---|
| `npm ci` | **Yes** — genuinely executed | step 3, `logs/03-npm-ci.log` |
| Workspace verification | **Yes** | step 4, `logs/04-workspaces.log` |
| Build | **Yes** | step 5, `logs/05-build.log` |
| Lint | **Yes** | step 6, `logs/06-lint.log` |
| Complete test suite | **Yes** — 50/50 packages, 1619/1619 cases | step 7, `logs/07-whole-tree-test.log` |
| A-17 … A-23 focused suites | **Yes** — all seven | §5 |
| Mutation hygiene 4/4 | **Yes** | §5 |
| Disposable P2-S7 mutation 17/17 incl. kill results | **Yes** — 15/15 mutants killed, enumerated | §5 |
| Negative-assertion inspection | **Yes** — 42 matches retained | §6 |
| Provider / test configuration | **Yes** | `logs/11b-provider-config-inspection.log` |
| Machine-readable evidence / manifests | **Yes** | `logs/13-result-record.json`, `logs/13-evidence-manifest.json` |
| Command / result / exit status / timestamp / SHA / environment per step | **Yes** | every log header + `13-result-record.json` |
| **Independent** execution | **NO** | Fails BD-01 IV-1/2/3/4/5/6/7 |
| **Independent** PASS/FAIL judgment | **NO** | Owner-directed; see eligibility record |
| Canonical independent report authored | **NO — deliberately** | Not this session's to author |

---

## 11. Exact conclusion

**Technical result (owner-side, PRIMARY):** on the exact artifact
`08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe` /
tree `5f2152ce0cd702b649b93bc23c165d36cb9b9dba`, in this environment, the full
canonical 13-step sequence **executed to completion with exit status 0 at every
step**, the tracked tree remained byte-identical, and the observed counts matched
the owner-side declared expectations. No step failed, no suite skipped, no mutant
survived.

**P2-E4 governance result: NO CHANGE.** This record is PRIMARY evidence produced
by the implementation-side principal under owner direction. It is **not**
independent verification, it satisfies **no** part of the E4 gate, and it issues
**no** E4 verdict.

The following are unchanged by this record and require separate governance
action: **P2-E4 status (NOT ACHIEVED)**, the **9.484375% frozen score**, the
**assurance cap (IN FORCE)**, and **production readiness (NOT READY)**.

---

## 12. STOP

Phase 3 independent execution is not performed. Phase 4's canonical independent
report is not authored. Control returns to the owner.

The open items requiring the owner are, in order:

1. adopt or reject **BD-01** (separately authorized governance change);
2. establish an **eligible verifier** against the eleven BD-01 conditions, or
   record that none is available;
3. only then authorize independent execution and the report that follows it.
