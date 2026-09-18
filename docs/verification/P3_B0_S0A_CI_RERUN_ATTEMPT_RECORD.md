# P3-B₀ SLICE S0a — AUTHORIZED CI RE-RUN: ATTEMPT RECORD AND RESULT

| Field | Value |
|---|---|
| Document Class | **EVIDENCE RECORD.** Records the outcome of the single owner-authorized normal CI re-run attempt. No CI run was produced; the record states that plainly and classifies the cause. |
| Authorization | Owner: *"I explicitly AUTHORIZE ONE NORMAL CI RE-RUN ONLY for PR #40 at the unchanged head: ab9914a… Determine whether the previously failed required check `build · lint · test` passes on the exact unchanged S0a head."* |
| Date (UTC) | 2026-09-18 |
| **RESULT (final)** | **RE-RUN COMPLETED — SUCCESS** (§10). Run `35334202868` **attempt 2**, `completed/success`, at the **unchanged** head `ab9914a`, on the **identical merge tree** `c03bce24`. The required check is now **green**, and the original **red** attempt 1 is **preserved** (§10.2) and was **not** caused — nor "fixed" — by S0a (§10.5). |
| **RESULT (initial)** | *Superseded — retained as history:* the first five attempts to trigger the re-run were **refused** (`403`, missing `actions: write`); zero runs were created at that time (§3–§5). |
| Strict scope | Fully observed — see §6. Nothing was modified anywhere. |

---

## 1. PRE-CONDITIONS VERIFIED BEFORE ATTEMPT

| Check | Value | Verdict |
|---|---|---|
| PR #40 head | `ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7` | **exactly `ab9914a`** ✅ |
| PR #40 state | `OPEN`, `mergedAt=null`, base `main` | ✅ |
| PR #40 branch | `arena/01a0b3c7-jata-qi` | ✅ |
| Base branch `main` | `6b61256` (unchanged) | ✅ |
| PR merge ref `refs/pull/40/merge` | `c03bce24c0bd6441d391583b2d859fca09237aac` — **identical to the previously tested merge tree** | ✅ unchanged, so a re-run would have re-tested the same tree |
| CI workflow | `CI` (`id 350321572`), `.github/workflows/ci.yml`, **`state=active`** | ✅ healthy |

## 2. THE FAILED RUN — IDENTITY (UNCHANGED BY THIS ATTEMPT)

| Field | Value |
|---|---|
| Run id | **`35334202868`** |
| Run number | 89 |
| Attempt | **1** (no further attempt was ever created) |
| Workflow | `CI` — `workflow_id=350321572`, `path=.github/workflows/ci.yml` |
| Event | `pull_request` |
| Head branch | `arena/01a0b3c7-jata-qi` |
| **Head SHA** | **`ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7`** |
| Created | 2026-09-18T10:20:37Z |
| Updated | 2026-09-18T10:29:39Z |
| Status / conclusion | `completed` / **`failure`** |

**Required check run:**

| Field | Value |
|---|---|
| Check run id | `105565178475` |
| Name | **`build · lint · test`** |
| App | `github-actions`, `integration_id=15368` |
| Status / conclusion | `completed` / **`failure`** |
| Started / completed | 2026-09-18T10:20:40Z / 2026-09-18T10:29:38Z |
| URL | `https://github.com/POWERBot-1/JATA-Qi/actions/runs/35334202868/job/105565178475` |

At `ab9914a`, `total_count` of check runs = **1** (this check only); combined commit status = `pending` with **0** statuses.

## 3. ATTEMPTS MADE — FOUR ROUTES, ALL REFUSED

Every available normal re-run mechanism was attempted, in this order. **None produced a run.**

| # | Mechanism | Endpoint / command | Result |
|---|---|---|---|
| 1 | Re-run all jobs (CLI) | `gh run rerun 35334202868` | **refused** — stderr: *"run 35334202868 cannot be rerun; its workflow file may be broken"* |
| 2 | Re-run failed jobs (CLI) | `gh run rerun 35334202868 --failed` | **refused** — identical message |
| 3 | Re-run workflow run (API) | `POST /repos/POWERBot-1/JATA-Qi/actions/runs/35334202868/rerun` | **HTTP 403** `{"message":"Resource not accessible by integration"}` |
| 4 | Re-run job (API) | `POST /repos/POWERBot-1/JATA-Qi/actions/jobs/105565178475/rerun` | **HTTP 403** `{"message":"Resource not accessible by integration"}` |

`workflow_dispatch` is **not** an available route: the workflow declares only `pull_request` (branches `[main]`) and `push` (branches `[main]`) triggers — no `workflow_dispatch`. Adding one would be a workflow modification, which the authorization forbids.

## 4. ROOT CAUSE OF THE REFUSAL — ESTABLISHED, NOT ASSUMED

The `gh` CLI message in attempts 1–2 **is misleading and must not be recorded as a repository defect.** An API debug trace shows exactly what happened:

```
> GET  /repos/POWERBot-1/JATA-Qi/actions/runs/35334202868?exclude_pull_requests=true
< HTTP/2.0 200 OK     … "workflow_id": 350321572 …
> GET  /repos/POWERBot-1/JATA-Qi/actions/workflows/350321572
< HTTP/2.0 200 OK
> POST /repos/POWERBot-1/JATA-Qi/actions/runs/35334202868/rerun
< HTTP/2.0 403 Forbidden
  "message": "Resource not accessible by integration",  "status": "403"
run 35334202868 cannot be rerun; its workflow file may be broken     ← gh's generic fallback string
```

Both API responses to the *diagnostic* GETs were **`200 OK`**, and `workflow_id` resolved to a valid, registered, `active` workflow. `gh` then issued the POST, received the **403**, and printed a canned fallback message. **The workflow file is not broken; it parses, it is registered, and it ran successfully for other heads as recently as 2026-09-18T07:15:15Z.**

The authoritative refusal is a **permission** error:

```
HTTP/2.0 403 Forbidden
X-Accepted-Github-Permissions: actions=write
{"message":"Resource not accessible by integration", ...}
```

Session identity: **`arena-ai-coding-agent[bot]`** (GitHub App installation token). This token does **not** carry the **`actions: write`** permission, which the re-run endpoints require. `gh api /repos/…/actions/permissions` likewise returns `403 Resource not accessible by integration`.

**Classification of the refusal:**

| Candidate cause | Verdict |
|---|---|
| Broken / invalid workflow file | **REFUTED** — `state=active`, `workflow_id` resolves, diagnostic GETs `200`, recent successful runs |
| Repository or Actions outage, repo disabled/archived | **REFUTED** — `disabled=false`, `archived=false`; runs succeeded hours earlier |
| Ruleset interference | **REFUTED** — rulesets gate merges, not re-runs; `updated_at` unchanged |
| Run not re-runnable (age, non-completed state, deleted branch/ref) | **REFUTED** — run `completed`, attempt 1, branch and `pull/40/merge` ref both present |
| **`actions: write` not granted to the session's GitHub App token** | **ESTABLISHED** — `403` + `X-Accepted-Github-Permissions: actions=write` on both endpoints |

**This is a limitation of the automation session's credential scope. It is not a defect in the repository, the workflow, the ruleset, or the CI system.**

## 5. RESULTING CHECK CONCLUSION AND RUN IDENTITY

> **⚠ SUPERSEDED BY §10.** Everything in this section describes the state **at the time of the refused attempts**. The re-run was subsequently executed and **passed**; the required check is now green. §5 is retained as history, not as current status.

- **No re-run occurred.** `run_attempt` for `35334202868` remains **1**; `updated_at` remains **`2026-09-18T10:29:39Z`**; the workflow's run list contains **no new entry**.
- **The required check `build · lint · test` at `ab9914a` remains `completed` / `failure`** — the same historical run and check run identified in §2, unchanged.
- **No new CI evidence exists in either direction.** The recurrence question — whether the pre-existing authentication race would have failed again — **remains exactly as undetermined as it was before this attempt.**

### 5.1 Explicit non-claims

- It is **NOT** recorded that CI passed. It did not run.
- It is **NOT** recorded that CI failed again. It did not run.
- It is **NOT** assumed the failure would have recurred, nor that it would have passed. **No conclusion about the transient race is drawn** from this attempt, because no test executed.
- It is **NOT** claimed that the workflow file is broken, despite the CLI's printed message. §4 refutes that.
- The historical red result is **not** expunged: the required check is still red, and remains red.

## 6. STRICT-SCOPE COMPLIANCE

| Prohibition | Status |
|---|---|
| Modify source code | **Not done** |
| Modify tests | **Not done** |
| Modify workflows | **Not done** — `.github/` untouched; no `workflow_dispatch` added |
| Modify dependencies | **Not done** |
| Alter the ruleset | **Not done** — `20134880` `active`, `updated_at=2026-09-17T10:41:35.163Z`, `bypass_actors=null` |
| Force-push | **Not done** |
| Merge | **Not done** — PR #40 `OPEN`, `mergedAt=null` |
| Bypass branch protection | **Not done** — no `--admin`, no override attempted |
| Self-approve the PR | **Not done** — 0 reviews submitted; `reviewDecision=REVIEW_REQUIRED` |
| Remediate the flaky test | **Not done** |

The only writes made were GET/POST calls to the GitHub re-run endpoints (all refused) and this documentation commit. Working tree clean afterwards.

## 7. HOW A RE-RUN CAN ACTUALLY BE OBTAINED

None of these is authorized or performed by this record:

1. **Owner re-runs from the GitHub UI** — the *"Re-run all jobs"* button on run `35334202868`, or *"Re-run failed jobs"* on the job. This achieves precisely the authorized action, under credentials that hold `actions: write`. **Recommended — it is exactly the action the owner authorized.**
2. **Owner grants the Arena GitHub App `actions: write`** and re-issues the instruction — then this session can execute the re-run itself.
3. **Close and reopen PR #40** — a fresh `pull_request` event on the *same* head `ab9914a`, without modifying source, tests, workflows, or the ruleset. Note: this creates a **new run** rather than re-running the existing one, and briefly changes PR state; it therefore **exceeds this authorization** and requires explicit owner approval.

## 8. STANDING STATE AFTER THIS ATTEMPT

| Item | State |
|---|---|
| PR #40 | **OPEN · `mergedAt=null` · head `ab9914a` · `mergeStateStatus=BLOCKED` · `reviewDecision=REVIEW_REQUIRED`** |
| PR #39 | OPEN · `mergedAt=null` · head `608a6ea` — untouched |
| `main` | `6b61256` — unchanged |
| Required check `build · lint · test` @ `ab9914a` | **`failure`** (run `35334202868`, check run `105565178475`, attempt 1) — **historically RED, not green, not re-run** |
| Ruleset `20134880` | `active`, unmodified |
| P2-E4 | **9.484375% FROZEN — NOT ACHIEVED**; separately tracked, unchanged |
| Production readiness | **NOT READY** |
| S0b / S0c / S1 / S2 / S3 | **NOT AUTHORIZED, NOT IMPLEMENTED** |

---

## 9. ADDENDUM — RETRY AFTER OWNER ELECTED THE PERMISSION-GRANT PATH

Immediately after the owner selected *"Grant the Arena app `actions: write`, then I re-run"*, one further run-level re-run attempt was issued to test whether the widened permission was already in effect:

```
POST /repos/POWERBot-1/JATA-Qi/actions/runs/35334202868/rerun
-> HTTP/2.0 403 Forbidden
   X-Accepted-Github-Permissions: actions=write
   {"message":"Resource not accessible by integration","status":403}
```

**Result unchanged: still refused; `run_attempt` still 1; `updated_at` still `2026-09-18T10:29:39Z`; no run created.** Cumulative refused attempts: **5**, runs created: **0**. The permission grant had not yet propagated to the session token at the moment of this retry.

The re-run remains **outstanding** and will be executed — once, and only once — as soon as `actions: write` is actually carried by the session token, or by the owner clicking *"Re-run all jobs"* in the GitHub UI (§7.1).

---

## 10. THE RE-RUN HAS NOW COMPLETED — **SUCCESS** (Supersedes §5)

The owner subsequently reported that the authorized single normal re-run had completed successfully. That report was **independently verified** before being recorded. **It is confirmed.**

### 10.1 Verified run identity

| Field | Value |
|---|---|
| Run id | **`35334202868`** — the *same* run, now attempt **2** |
| **Attempt** | **2** (attempt 1, the failure, is preserved — §10.3) |
| Status / conclusion | **`completed` / `success`** |
| Head SHA | **`ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7`** — *unchanged* |
| Event / branch | `pull_request` · `arena/01a0b3c7-jata-qi` |
| Run started | **2026-09-18T15:11:45Z** |
| Updated | **2026-09-18T15:30:04Z** |
| `triggering_actor` | **`POWERBot-1`** (owner-initiated, via the normal re-run mechanism) |
| `actor` | `arena-ai-coding-agent[bot]` (original event actor) |

**Job / required check run, attempt 2:**

| Field | Value |
|---|---|
| Job id | `105651676282` |
| Name | **`build · lint · test`** |
| Status / conclusion | **`completed` / `success`** |
| Started / completed | 2026-09-18T15:11:49Z / 2026-09-18T15:30:03Z |
| App | `github-actions` |

**Check runs on `ab9914a` (now):** exactly **one** — `build · lint · test`, id `105651676282`, conclusion **`success`**.

### 10.2 The historical failure is preserved and is NOT expunged

Attempt 1 remains on the permanent record and continues to be reported as a failure:

| | Attempt 1 | Attempt 2 |
|---|---|---|
| Job id | `105565178475` | `105651676282` |
| Conclusion | **`failure`** | **`success`** |
| Started | 2026-09-18T10:20:40Z | 2026-09-18T15:11:49Z |
| Completed | 2026-09-18T10:29:38Z | 2026-09-18T15:30:03Z |

`run_attempt` on the run is now **2**; attempt 1 was not deleted, amended, or hidden, and §2 of this record still describes it accurately. **The check was red and then green. It was never "always green."**

### 10.3 Proof that nothing was changed to obtain the success

The strongest available proof is structural: **both attempts tested the identical merge tree.**

| Evidence | Value |
|---|---|
| `refs/pull/40/merge` at attempt 1 | `c03bce24c0bd6441d391583b2d859fca09237aac` |
| `refs/pull/40/merge` at attempt 2 | **`c03bce24c0bd6441d391583b2d859fca09237aac`** — *identical* |
| Branch head | `ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7` — *identical* |
| Commits on the branch vs `main` | exactly **2** (`503e67b`, `ab9914a`) — unchanged |
| Branch diff vs `6b61256` | exactly **6 files, +895 / −2** — unchanged |
| `ci.yml` blob | `cf8a5d00443b4cccbb5b2bd9dbe2e332edab078f` at **both** `ab9914a` and `6b61256` |
| `.github/`, lockfile, `package.json`, tsconfig changes | **NONE** |
| `main` | `6b61256` — unchanged |

**The only variable between the failing attempt and the passing attempt was the attempt itself.** No source file, test, workflow, dependency, lockfile, or configuration differed.

### 10.4 Direct corroboration of the transient-flake classification

The Step-8 job log for attempt 2 was retrieved through the same documented workaround path as the original (§0 of the B-1 classification). It records the **exact test that failed in attempt 1 now passing**:

```
# Subtest: P2-S2 lifecycle races (real PostgreSQL)
    # Subtest: revoke + validate race: terminal state exactly once; zero post-revocation ALLOWs
    ok 1 - revoke + validate race: terminal state exactly once; zero post-revocation ALLOWs
    # Subtest: deprovision + validate race: validators end denying; the cascade claims the row
    ok 2 - deprovision + validate race: validators end denying; the cascade claims the row
      ---
      duration_ms: 44.548207
      ...
ok 15 - P2-S2 lifecycle races (real PostgreSQL)
```

| | Attempt 1 | Attempt 2 |
|---|---|---|
| That assertion | **`not ok 2`** — `ERR_ASSERTION`, `false !== true`, `strictEqual`, "validation ends denying once the cascade lands" | **`ok 2`** |
| Duration | 528.223213 ms | **44.548207 ms** |
| Suite `P2-S2 lifecycle races` | `not ok 15` (`subtestsFailed`) | **`ok 15`** |

The attempt-2 log tail completes cleanly, with **no `##[error]Process completed with exit code 1.`** — the line that terminated attempt 1.

### 10.5 What this does and does not establish

**Does establish:** the failure was **non-deterministic**, not a persistent defect. The same tree, byte-for-byte, produced a failure on attempt 1 and a pass on attempt 2. This is the defining signature of the transient race described in the B-1 classification, and it **corroborates that classification** (KNOWN TRANSIENT FLAKE / NO S0a CAUSATION).

**Does NOT establish, and must not be read as:**

1. **That S0a "fixed" the failure.** S0a was present in **both** attempts — the tested tree was identical. A change that is present in the failing case cannot be the discriminator between failing and passing. The original failure was **not fixed by S0a**; it simply **did not recur**.
2. **A flake rate.** n = 2 (one failure, one pass). The true rate is unmeasured; §6.3 of the B-1 classification (absence of reproduction is not proof of rarity) still stands.
3. **That the underlying race is harmless.** The race and its bounded poll budget are unchanged and un-remediated. It may recur. **No de-flake was performed** and none is authorized.
4. **That the red attempt is superseded as history.** It is not. See §10.2.

---

## 11. MATERIAL GOVERNANCE OBSERVATION — REPOSITORY VISIBILITY CHANGE HAS DISARMED THE RULESET

Discovered during this slice's read-only verification. **Recorded, not remediated.**

**The repository `POWERBot-1/JATA-Qi` is now PRIVATE**, with `updated_at = 2026-09-18T14:44:03Z`:

```
private    = true
visibility = private     (owner plan: User — free tier)
```

Earlier in this session the repository reported `private=false`. The ruleset API, which returned the full ruleset JSON earlier, now returns:

```
403 — "Upgrade to GitHub Pro or make this repository public to enable this feature."
```

…for `/rulesets`, `/rulesets/{id}`, and `/rules/branches/main`.

**Consequence (material):** on a free User-plan account, repository rulesets are unavailable. The branch ruleset **`20134880` ("Jata Qi") is therefore no longer enforceable**, and PR #40's merge state changed accordingly:

| Field | Before | **Now** |
|---|---|---|
| `mergeStateStatus` | `BLOCKED` | **`CLEAN`** |
| `reviewDecision` | `REVIEW_REQUIRED` | **(empty)** |
| `mergeable` | `MERGEABLE` | `MERGEABLE` |
| Reviews | 0 | **0** — *still none* |

The two requirements that previously blocked the merge — the required status check and the **1 required approving review** — are **not currently being enforced**. Note that the review requirement has **not** been satisfied: there are still **zero reviews**; it is the *enforcement* that has lapsed, not the condition that has been met.

**Attribution and scope:**
- This session did **not** change repository visibility. Every write this session attempted against GitHub was either a refused re-run POST (5 × `403`, none of which altered any state) or a documentation commit to the session's own branch.
- Gate condition 9 of the final disposition (`docs/verification/P3_B0_S0A_FINAL_GOVERNANCE_DISPOSITION.md` §2) was confirmed true **as of its date**. This section records a **subsequent** change to the repository, not an error in that record. That record's §3 statement that a normal merge was blocked was correct at the time it was written; **it is no longer a description of current enforcement.**
- **No attempt was made to merge, and no advantage was taken of the lapsed enforcement.** PR #40 remains `OPEN`, `mergedAt=null`.

**Verification limit, stated plainly:** after the visibility change, the ruleset can **no longer be read** through the API, so its *definition* cannot be re-inspected to confirm it is unmodified. The last successful read — taken before the change — showed `updated_at = 2026-09-17T10:41:35.163Z` (i.e. untouched since before this session began). This section therefore records **loss of enforceability**, not a demonstrated edit to the ruleset definition. Whether the definition itself was altered is **not determinable** from the current API access.

**The successful re-run did not depend on any of this.** The re-run passed on the unmodified merge tree `c03bce24`; no ruleset change — and no change of any kind — was made to obtain it.

**Owner attention is required on two separate points:** (a) whether the visibility change was intended, and (b) that the merge gate which was blocking PR #40 — including the approval requirement — is presently **not** being enforced.

---

*— End of re-run attempt record. Initially the authorized re-run could not be executed (5 refusals, `403`, missing `actions: write`). It was subsequently performed normally, by the owner, on the unchanged head `ab9914a` and the identical merge tree `c03bce24` — and it **PASSED** (§10). The original failure is preserved (§10.2), was **not** fixed by S0a (§10.5), and no source, test, workflow, dependency, or config change was made to obtain the green result (§10.3). CI was run exactly once, as authorized; it will not be re-run. A separate material governance observation — the visibility change that has disarmed ruleset `20134880` — is recorded at §11. PR #40 remains OPEN and UNMERGED. —*
