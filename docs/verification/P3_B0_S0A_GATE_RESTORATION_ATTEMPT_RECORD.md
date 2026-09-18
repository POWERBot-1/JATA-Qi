# P3-B₀ SLICE S0a — GATE-RESTORATION ATTEMPT: **STOPPED, NOT MERGED**

| Field | Value |
|---|---|
| Document Class | **GOVERNANCE / GATE RECORD.** Records why the owner's "restore governance gate, then merge" authorization terminated at §7 (STOP) with **no merge and no setting change**. |
| Authorization | Owner: *"PR #40 — RESTORE GOVERNANCE GATE, THEN MERGE … 7. If the gate cannot be legitimately restored, or if the required approval cannot be obtained, STOP. Do not merge under lapsed enforcement and do not waive the approval requirement."* |
| Date (UTC) | 2026-09-18 |
| **OUTCOME** | **STOPPED at §7 — invoked by two independent unmet conditions.** The gate **cannot be legitimately restored by this session**, and the required approving review **does not exist** and cannot be supplied by this session. **NO MERGE. NO SETTING CHANGED. NO REVIEW CREATED.** |

---

## 1. STEP 1 — DETERMINATION

### 1.1 Can the prior ruleset enforcement be legitimately restored under the current GitHub plan? — **NO, not from this session, and not without an owner decision.**

The ruleset API states the constraint in GitHub's own words:

```
403  "Upgrade to GitHub Pro or make this repository public to enable this feature."
     GET /repos/POWERBot-1/JATA-Qi/rulesets/20134880
     GET /repos/POWERBot-1/JATA-Qi/rulesets
     GET /repos/POWERBot-1/JATA-Qi/rules/branches/main
```

Repository facts:

| Field | Value |
|---|---|
| `owner.type` | **`User`** (personal account `POWERBot-1`) |
| `private` / `visibility` | **`true` / `private`** |
| `updated_at` | `2026-09-18T14:44:03Z` (the visibility change) |

On a **free personal-tier** account, rulesets are unavailable to **private** repositories. Legitimate restoration therefore requires **one of two owner actions**:

1. **return the repository to `public`** (its prior visibility), or
2. **upgrade the account to GitHub Pro** — a **billing** decision.

Neither is within this session's authority or capability. **Path 2 was not attempted (it would spend money) and path 1 was not performed (see §1.3).**

### 1.2 Does this session hold the permission to change visibility? — **NO.** *Decisive.*

| Probe (read-only) | Result |
|---|---|
| `GET /repos/POWERBot-1/JATA-Qi` → `.permissions` | **`{"admin":false,"maintain":false,"pull":false,"push":false,"triage":false}`** |
| `GET /repos/…/actions/permissions` (admin-scoped) | `403 Resource not accessible by integration` |
| `GET /repos/…/branches/main/protection` (admin-scoped) | `403 Resource not accessible by integration` |
| Identity | `arena-ai-coding-agent[bot]` — GitHub App installation token |

Changing repository visibility requires **`administration: write`**. The installation token holds **no admin permission**, and every admin-scoped endpoint returns `Resource not accessible by integration`. **This session cannot change the visibility at all — the question of whether it *should* is moot.**

### 1.3 Was the PUBLIC → PRIVATE change intentional? — **NOT DETERMINABLE BY THIS SESSION.**

- No attributable actor is readable through the API available to this session; the audit-log endpoints require admin, which is absent (§1.2).
- **Timeline:** the change is stamped `2026-09-18T14:44:03Z` — **before** the CI re-run (started `15:11:45Z`) and before this session first observed it. It was therefore **not** caused by the re-run, by this session, or by any action recorded in this engagement.
- **Intent is an owner-side fact, not an API fact.** It cannot be derived from repository data.

**Consequently the §1 precondition — determine intent — could not be satisfied**, and §2's restoration is conditioned on the change being *unintentional* and legitimately correctable. **§2 was not performed.**

This is not pedantry: **making a private repository public is an irreversible disclosure.** Once public, the full source — including the S0a matcher, R-17, the T-16 corpus, the design records, and `docs/verification/P3_A_SECURITY_THREAT_MODEL_AND_BASELINE.md` — is immediately readable and may be scraped or mirrored within minutes; reverting to private does **not** undo that. Acting on inference would be the single most consequential, least reversible write in this entire engagement. It requires the owner's explicit confirmation, not a machine's deduction.

## 2. STEP 2 — **NOT PERFORMED**

Conditioned on §1. Because intent is undetermined **and** the permission required is not held **and** the action is an irreversible disclosure, the condition for restoring `public` was not met. **No setting was changed. The repository remains private.**

## 3. STEP 3 — RULESET ENFORCEMENT COULD **NOT** BE VERIFIED AS ACTIVE. IT IS **NOT** ENFORCING.

The ruleset cannot even be **read** (403, §1.1), so "verify it is ACTIVE and enforcing" is **impossible from this session**. The observable merge surface shows non-enforcement:

| Signals required by §3 | Status |
|---|---|
| Ruleset `20134880` readable / ACTIVE | **UNREADABLE — `403` (plan restriction)** |
| Required check `build · lint · test` | **Present and `success`** (§4) |
| Required approving reviews = **1** | **Ruleset unreadable; enforcement not observable** |

Corroborating behavioural evidence of lapsed enforcement (recorded in the previous slice):

| Field | Before visibility change | **Now** |
|---|---|---|
| `mergeStateStatus` | `BLOCKED` | **`CLEAN`** |
| `reviewDecision` | `REVIEW_REQUIRED` | **(empty)** |
| Reviews | 0 | **0 — still none** |

A repository whose PR reports `CLEAN` with **zero reviews** is not enforcing a one-approval requirement. **The gate is not satisfied in substance, even where it has lapsed in enforcement.**

## 4. STEP 4 — PR #40 INTEGRITY CHECK (read-only, GitHub API authoritative)

| Condition | Result |
|---|---|
| Head unchanged `ab9914a` | ✅ `ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7` |
| No unauthorized commits / scope changes | ✅ `commits = 2`, `changed_files = 6`, `+895 / −2`; commits exactly `503e67b`, `ab9914a`; files exactly the authorized six |
| Successful required CI | ✅ `build · lint · test` → `completed/success` (check run `105651676282`, attempt 2) |
| No force push | ✅ remote head matches expected tip exactly |
| No ruleset bypass | ✅ none attempted |
| **One genuine approving review** | ❌ **0 reviews. NO review exists.** |

*(Verification basis: `GET /pulls/40` → `merged=false`, `mergeable=true`, `merge_commit_sha=c03bce24`; `GET /pulls/40/commits`; `GET /pulls/40/files`. The local clone is shallow — `git rev-parse --is-shallow-repository` → `true` — so all composition figures were taken from the GitHub API, not from local history.)*

**§4 is not satisfied**, and by a condition this session is expressly forbidden to remedy: §4 demands *one genuine approving review* and the authorization forbids *self-approval or fabricated review*. Only the owner can supply it.

## 5. STEP 5 — **MERGE NOT PERFORMED**

The governing instruction is explicit: merge **"if and only if all gates are genuinely satisfied."** They are not — the gate is not enforcing, the review does not exist, and head `ab9914a` sits under a disarmed protection. **No merge of any kind was attempted. No `--merge`, `--squash`, `--rebase`, or `--admin` flag was used.**

## 6. STEP 6 — **NOT APPLICABLE** (no merge occurred; no post-merge verification to perform)

## 7. STOP INVOKED — TWO INDEPENDENT, SUFFICIENT CONDITIONS

> *"If the gate cannot be legitimately restored, or if the required approval cannot be obtained, STOP. Do not merge under lapsed enforcement and do not waive the approval requirement."*

1. **The gate cannot be legitimately restored by this session** — no `administration: write`; restoration requires an owner-side visibility change or a paid plan upgrade.
2. **The required approving review cannot be obtained by this session** — 0 reviews exist, and creating one is forbidden as self-approval/fabrication.

Either alone is sufficient. **Both obtain.** The STOP branch is therefore mandatory, not discretionary, and it is **not** a waiver of the approval requirement — §7 forbids that too.

## 8. WRITES PERFORMED

The authorization contemplated a visibility change and a merge. **Neither occurred.** This slice performed:

| Action | Count |
|---|---|
| Repository setting changes | **0** |
| Merges | **0** |
| Reviews created | **0** |
| Ruleset / protection changes | **0** |
| Source, test, workflow, dependency changes | **0** |
| Documentation commits (this record, session branch only) | 1 |

## 9. WHAT ONLY THE OWNER CAN DO (in order)

1. **Confirm whether the PUBLIC → PRIVATE change was intentional.**
   - If **intentional**, the gate can only be restored by a **GitHub Pro upgrade** — a billing decision — or by accepting an unprotected merge, which §7 forbids.
   - If **unintentional**, return the repository to **`public`** (requires admin; this session cannot).
2. **Then verify ruleset `20134880` is ACTIVE** with required check `build · lint · test` **and** `required_approving_review_count: 1`.
3. **Then submit one genuine approving review on PR #40** — the review is the owner's to give; it must not be manufactured, and this session will not supply it.

Only after 1–3 does a **normal merge commit** of `ab9914a` become both authorized and gated.

## 10. STANDING STATE (unchanged by this slice)

| Item | State |
|---|---|
| PR #40 | **OPEN · `mergedAt=null` · head `ab9914a` · `mergeable=true` · `merged=false`** |
| PR #39 | OPEN · `mergedAt=null` · head `608a6ea` — untouched |
| `main` | `6b61256` — unchanged |
| Required check @ `ab9914a` | `completed/success` (attempt 2) |
| Historical failure | attempt 1 `failure` — **preserved** |
| Reviews | **0** |
| Repository visibility | **private** — unchanged by this session |
| Ruleset `20134880` | **not enforceable** (plan restriction); definition unreadable |
| P2-E4 | **9.484375 % FROZEN — NOT ACHIEVED** |
| Production readiness | **NOT READY** — no readiness claim made |
| S0b / S0c / S1 / S2 / S3 | **NOT AUTHORIZED, NOT IMPLEMENTED** |

---

*— End of gate-restoration attempt. The gate could not be restored (no admin permission; owner-side decision required) and the required approving review does not exist (0 reviews; self-approval forbidden). Per §7 the STOP branch was mandatory. No merge, no setting change, no review. —*
