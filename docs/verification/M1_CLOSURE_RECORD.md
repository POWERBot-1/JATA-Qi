# M1 Closure — Governance, Evidence & Assurance Remediation

| Field | Value |
|---|---|
| Record type | M1 closure record — verification, remediation, and formal disposition of every remaining M1 blocker |
| Authorization | M1 CLOSURE — Governance, Evidence & Assurance Remediation (implementation/remediation authorized, M1 only) |
| Date of record | 2026-09-11 (UTC) |
| Canonical baseline | `2455c59e8462ca203e9d57788792acb32e5cdad9` |
| Phase A PR / head | PR **#33** · head `67e68ffd7f09b872763c963d8729890c224c6c7e` |
| Working branch | `arena/01a08e8a-jata-qi` |
| Scope discipline | **Test harness, CI reliability, diagnostics, evidence collection ONLY.** Zero `packages/*/src/` changes. No product behavior altered. |

---

## 1. PR #33 — INDEPENDENT VERIFICATION

Verified against the exact head. Every check below was executed this session.

| Check | Method | Result |
|---|---|---|
| PR state | `gh pr view 33 --json state,mergedAt,mergeStateStatus` | `state=OPEN` · `mergedAt=None` · `mergeStateStatus=CLEAN` — **not merged** |
| Base | `baseRefName` | `main` |
| Head | `headRefOid` | `67e68ffd7f09b872763c963d8729890c224c6c7e` — **matches the audited artifact** |
| Ancestry | `git merge-base --is-ancestor 2455c59 67e68ff` | **PASS** — and `git rev-parse 67e68ff^` = `2455c59…`, i.e. the head's **direct parent is the canonical baseline** |
| Commit count in PR | `git log 2455c59..67e68ff` | exactly **1** commit |
| Working tree | `git status --porcelain` | clean at verification start |
| Change scope | `git diff --name-status` | **7 files, all `A` (added), all under `docs/`**; `+1777 / −0` |
| `packages/` source changes | `git diff --name-only -- packages \| wc -l` | **0** |
| Non-`docs/` changes | `git diff --name-only \| grep -v '^docs/' \| wc -l` | **0** |
| Rubric byte-identity | `git show 67e68ff:docs/rubric/JATA-P0-95-v1.1.md \| git hash-object --stdin` | `fc9ce9c87f827a6324df4f9560a2cd6b1827423c` — **identical to the source blob at `36f0026`** |
| Build | `npm run build` | **PASS** — all 51 workspaces (exit 0) |
| Full test suite | `npm test` | **1,411 tests · 0 fail · 0 skipped** · `Total: 50 · Passed: 50` |
| Zero skipped mandatory tests | aggregate `# skipped` | **0** |
| Lint | `npm run lint` | **0 errors**, 60 warnings (known, pre-existing) |
| Secret scan | `npm run scan:r2` | **PASS** — 0 findings |
| CI | `gh api …/commits/67e68ff…/check-runs` | `build · lint · test: **success**` |

**Determination: PR #33 is exactly the audited artifact. It differs in no respect.**

---

## 2. v1.0 RUBRIC — OWNER DEPENDENCY

No further reconstruction was attempted, per the authorization. The Phase A search
stands as exhaustive and is not repeated.

| Item | State |
|---|---|
| `JATA-P0-95-v1.1` | **RECOVERED, canonical, integrity-verified** (blob `fc9ce9c…` at PR head) |
| `JATA-P0-95-v1.0` numerical schedule | **UNRECOVERED** — unchanged |
| Owner-supplied v1.0 received this session | **No** |
| Interpolation / guessing | **None performed** |
| Percentage manufactured | **None** |

**NUMERICAL 95% SCORE = NOT COMPUTABLE.**

Register entries **P0R-RUB-02 / L-3 / L-11 remain OPEN**, now with the exhaustive
search record attached. Closure requires an owner-supplied authoritative v1.0
text followed by a separate versioned rubric review (P0R-RUB-03 proper).

---

## 3. GOVERNANCE RULESET — ADMIN DEPENDENCY

> ## **GOVERNANCE ACTION = HUMAN ADMIN REQUIRED**
>
> This item is **NOT completed**. It is formally dispositioned as human-owned.

### 3.1 Verified current state (re-read live this session)

`gh api repos/POWERBot-1/JATA-Qi/rules/branches/main`:

| Rule | State |
|---|---|
| `deletion` | present |
| `non_fast_forward` | present — prevents force-push / history rewrite |
| `pull_request` | `required_approving_review_count: **0**`; `required_review_thread_resolution: true` |
| `required_status_checks` | **ABSENT** |

Re-confirmed after all Phase A and M1 work: `required_approving_review_count` is
still `0` and there is still no `required_status_checks` rule.

### 3.2 Authority probe (no escalation attempted)

| Probe | Result |
|---|---|
| `PUT /rulesets/20134880` with the minimum patch | **HTTP 403 — `Resource not accessible by integration`** |
| `GET /repos/…` `.permissions` | `{admin:false, maintain:false, pull:false, push:false, triage:false}` |
| `GET /user` | **403 — Resource not accessible by integration** |
| `git push` (control) | **success** — proves the limitation is scope-specific, not a repository or network fault |

The credential is a GitHub App installation token holding `contents: write` but
**not `administration: write`**. No credential escalation, permission bypass, or
alternate route was attempted.

### 3.3 Exact administrator action required

Minimum change — two additions, nothing existing weakened:

| # | Change | From → To |
|---|---|---|
| 1 | `pull_request.parameters.required_approving_review_count` | `0` → **`1`** |
| 2 | new rule `required_status_checks` | absent → **`[{ context: "build · lint · test" }]`** |

```bash
gh api -X PUT repos/POWERBot-1/JATA-Qi/rulesets/20134880 --input - <<'JSON'
{
  "name": "Jata Qi",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "exclude": [], "include": ["refs/heads/main"] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": false,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": false,
        "allowed_merge_methods": ["merge", "squash", "rebase"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [ { "context": "build · lint · test" } ] } }
  ]
}
JSON
```

### 3.4 Expected read-back state (independent verification)

```bash
gh api repos/POWERBot-1/JATA-Qi/rules/branches/main \
  --jq '.[] | "\(.type): \(.parameters)"'
```

Expected after a successful change:

| Rule | Expected |
|---|---|
| `deletion` | present (unchanged) |
| `non_fast_forward` | present (unchanged) |
| `pull_request` | `required_approving_review_count: 1`, `required_review_thread_resolution: true`, `allowed_merge_methods: [merge, squash, rebase]` |
| `required_status_checks` | `strict_required_status_checks_policy: false`, `required_status_checks: [{"context":"build · lint · test"}]` |
| `current_user_can_bypass` | `never` (unchanged) |

**Reversibility:** the pre-change payload is preserved byte-for-byte in
`RULESET_20134880_BACKUP_PRE_PHASE_A.json` (workspace root, outside the repo).
Re-`PUT`ting it reverts exactly. `strict_required_status_checks_policy: false` is
the minimum change; raising it to `true` is a strengthening left to owner
judgment.

---

## 4. P1C-OBS-01 — TEST HARNESS REMEDIATION (IMPLEMENTED)

### 4.1 Exact failure mechanism (established, not assumed)

The defect is a **readiness race** in the embedded-PostgreSQL test harnesses:

1. `embedded-postgres` resolves `start()` on the postmaster's *"ready to accept
   connections"* **log line**, which can **precede the TCP listener actually
   accepting connections**. (This is already documented in the repo's own
   `r2-pg.ts` as the O-2 defect class.)
2. `node --test dist/test/*.test.js` runs test **files concurrently**, and each
   file boots its **own** embedded PostgreSQL. Concurrency per workspace:
   `storage-postgres` 6 files · `loop-host` 8 files · `commercial-event-stream` 1 ·
   `cli` 3. The workspace runner (`scripts/run-workspaces.mjs`) is sequential
   across workspaces, so the contention is intra-workspace.
3. Under that contention a connect lands before the listener is ready →
   `ECONNREFUSED`.

**Two divergent consequences from the same race**, both previously unguarded:

| Unguarded call | Previous behaviour | Consequence |
|---|---|---|
| `initialise()` / `start()` | error caught → `started: false` → callers register a trivially-passing `it('SKIPPED: …')` and return | **FALSE-NEGATIVE GREEN** — a real PostgreSQL integration suite silently tests nothing while the run reports success |
| `createDatabase()` | error thrown straight out of the suite | **FALSE-POSITIVE RED** — a red run on an unmodified tree |

**Product or infrastructure?** **Infrastructure/harness.** No product code path
is involved; the product's own driver boot already applies bounded retry.

### 4.2 Corroborating evidence — the historical failure class

Enumerating every CI run (`gh api …/actions/runs?per_page=100`): **65 runs —
53 success, 10 failure, 2 cancelled.** Step-level signature of all 10 failures:

| Run | Head | Event | Failed step |
|---|---|---|---|
| `34033434142` | `d221f655` | pull_request | **Test (all workspaces)** |
| `34034524011` | `82af3def` | push | **Test (all workspaces)** |
| `34040029489` | `0cb6b6bd` | pull_request | **Test (all workspaces)** |
| `34157600765` | `18d5dd49` | — | Lint *(different — not this class)* |
| `34160282081` | `f1aae3b6` | pull_request | **Test (all workspaces)** |
| **`34162894915`** | **`10fc9baf`** | **push** | **Test (all workspaces)** ← **G10** |
| `34255207381` | `bb2b2f52` | push | **Test (all workspaces)** |
| `34322457691` | `27853d17` | pull_request | **Test (all workspaces)** |
| `34412338682` | `55ba753f` | pull_request | **Test (all workspaces)** |
| **`34488819576`** | **`f68f329c`** | **push** | **Test (all workspaces)** ← **P2-S2 post-merge** |

**9 of 10 failures share an identical signature**: build success, lint success,
failure at "Test (all workspaces)". **G10 and the P2-S2 post-merge failure are
members of the same 9-occurrence class.** Three of the nine are `push` runs on
`main`, so `main` was red post-merge three times.

Stated precisely: a uniform **step-level** signature is strong evidence of a
common cause but is **not proof** of one. The specific failing test inside G10
remains unretrievable (§5). What is now established — and was not before — is
that G10 is **not an isolated unexplained event**; it is one instance of a
recurring, mechanistically-explained class.

### 4.3 Reproducibility

No failing SHA was ever retried (`all_runs_on_sha=[failure]` for all nine), so
same-SHA flake/recovery evidence cannot be derived from CI history. The race is
contention-dependent and therefore **non-deterministic by nature**; it was not
reproduced on demand in this sandbox (2 CPUs, full suite green across three
consecutive runs). That is recorded honestly rather than claimed.

### 4.4 Remediation implemented

Four harnesses were defective; all four are fixed. The proven `r2-pg.ts` (O-2)
pattern was used as the reference, since it already solves this correctly.

| File | Consumers | Change |
|---|---|---|
| `packages/storage-postgres/test/pg-test-harness.ts` | 6 test files | bounded readiness retry on `initialise`/`start`/`createDatabase`; **transient-vs-unavailable discrimination**; `pgDiagnostics` record |
| `packages/loop-host/test/pg-host-harness.ts` | 8 test files | same (this is the harness named in P2-S4 finding 6) |
| `packages/commercial-event-stream/test/pg-harness.ts` | 1 test file | same |
| `packages/cli/test/p1-pg.ts` | 3 test files | bounded retry (already fail-hard; this removes the false-**red**) |

**The decisive change** is not the retry alone — it is the discrimination. A
transient error that survives bounded retry now **throws**, because the binaries
are demonstrably present and the server merely lost a readiness race. Only a
**non-transient** error (missing binaries, unsupported platform) retains the
documented honest skip. Both directions matter:

| Misclassification | Consequence |
|---|---|
| transient → "unavailable" | false-negative green (the original defect) |
| genuine absence → "transient" | false-positive red, and the harness's documented honest-skip contract is broken |

### 4.5 CI reliability and diagnostics

`.github/workflows/ci.yml` had three defects, all fixed:

| Defect | Before | After |
|---|---|---|
| Double cost | the detector ran `npm test` a **second full time** (~6 min) | the judged run's output is captured once via `tee` |
| Wrong sample | the detector inspected a **different run** than the one producing the conclusion, so a transient skip could be missed entirely | the detector greps **the same captured output** |
| Never fails | the step only `echo`ed a RESULT line | it now **exits 1** when PostgreSQL skipped on a runner where the binaries are demonstrably available |
| No attribution | nothing machine-readable in the log | new **Embedded-PostgreSQL readiness diagnostics** step surfaces retry evidence and harness outcomes in the job log — so a future failure is attributable **from the log alone**, without the Azure blob download that G10 proved unreachable |

The last point is a direct response to how G10 became unattributable: the
evidence existed only in a blob this environment cannot reach. Attribution data
now lives in the job log.

### 4.6 Non-vacuity proof (mutation testing)

A new deterministic regression test,
`packages/storage-postgres/test/p1c-obs-01-harness-resilience.test.ts` (6 tests),
locks in the classification. It was mutation-tested in **both** directions:

| Mutant | Expected | Result |
|---|---|---|
| `isTransientPgError` → always `false` (never retry) | retry-side assertions fail | **3 fail / 3 pass** — tests 1, 2, 6 failed ✓ |
| `isTransientPgError` → always `true` (never honestly skip) | honest-skip assertions fail | **3 fail / 3 pass** — tests 3, 4, 6 failed ✓ |

Both mutants reverted; `grep -c MUTANT` → **0** in source **and** in `dist/`;
pristine re-run **6/6 pass**. The test is bidirectionally load-bearing.

### 4.7 Verification after remediation

| Gate | Result |
|---|---|
| Build | **PASS** — all 51 workspaces (exit 0) |
| Affected workspaces | storage-postgres **53/53** · commercial-event-stream **22/22** · loop-host **176/176** · cli **132/132** — all **0 skipped** |
| New regression test | **6/6 pass** |
| **Full regression** | **1,417 tests · 0 fail · 0 skipped** · `Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0` |
| Lint | **0 errors**, 60 warnings — **unchanged from baseline** (no new warnings introduced) |
| Secret scan | **PASS** — 0 findings |
| Workflow YAML | parsed and validated — 9 steps, structure intact |

Test count moved **1,411 → 1,417**, exactly the +6 new tests.

### 4.8 Scope compliance

| Requirement | Result |
|---|---|
| No product behavior changed to make the historical run green | **Confirmed** — `git status` shows **0** files under `packages/*/src/` |
| Changes restricted to test harness / CI / diagnostics / evidence | **Confirmed** — 4 harness files + 1 new test + 1 workflow |
| Complete regression run afterward | **Done** — §4.7 |

### 4.9 P1C-OBS-01 disposition

> ## **P1C-OBS-01 = RESOLVED (remediated + regression-locked)**
>
> The historical P2-S2 post-merge failure (run `34488819576`) **remains
> OPEN / UNATTRIBUTABLE** — the current green suite does not erase it, and its
> log is unretrievable. What changed is that the **mechanism is now identified,
> fixed, and prevented from recurring silently**.

---

## 5. G10 — EVIDENCE ATTRIBUTION

### 5.1 Retrieval attempt

| Target | Method | Result |
|---|---|---|
| Run metadata | `gh api …/actions/runs/34162894915` | **RETRIEVED** — `conclusion=failure`, head `10fc9baf`, `2026-09-07T21:22:25Z` → `21:33:01Z`, attempt 1 |
| Job metadata + steps | `gh api …/actions/jobs/101868167969` | **RETRIEVED** — build ✓, lint ✓, **Test (all workspaces) ✗**, PostgreSQL integration status ✓ |
| Job log content | `gh api …/actions/jobs/101868167969/logs` | **FAILED — EOF** at `productionresultssa19.blob.core.windows.net` |
| Run log archive | `gh api …/actions/runs/34162894915/logs` | **FAILED — EOF** at `results-receiver.actions.githubusercontent.com`; 0 bytes written |

**Retention vs reachability.** The GitHub API issues a **valid signed SAS URL**
for the log blob (a signature and expiry are present in the redirect). The
connection then fails with `EOF`. The evidence is therefore **retained
server-side but unreachable from this environment** — an **egress** limitation,
not retention decay. This is a sharper characterization than the prior record,
which could not distinguish the two.

### 5.2 What is and is not established

| Question | Answer |
|---|---|
| Exact workflow / job | **ESTABLISHED** — workflow `CI`, job `build · lint · test`, step **Test (all workspaces)** |
| Exact failure signature | **ESTABLISHED at step level**; the failing test name is **NOT** retrievable |
| Transient? | **NOT PROVEN** — no failing SHA was retried, so no same-SHA recovery evidence exists |
| Harness-related? | **STRONGLY INDICATED** — G10 belongs to a 9-occurrence class with a uniform signature, and the mechanism is now identified (§4.1–4.2). Not proven at assertion level for this specific run. |
| Product-regression evidence | **NONE FOUND** — build and lint both passed; the same tree `10fc9baf` was the accepted canonical baseline for subsequent milestones |
| Repeated occurrences share a cause? | **9 of 10 CI failures share an identical step-level signature** — established; common root cause strongly indicated, not proven |

### 5.3 G10 disposition

> ## **G10 = OPEN / UNATTRIBUTABLE — FORMALLY DISPOSITIONED AS EVIDENCE-BLOCKED**
>
> No attribution is invented. Closure requires retrieval of the job log from an
> **egress-capable environment** (or human download from the GitHub UI). The
> evidence is retained, so this remains recoverable — but not from here.
>
> **Mitigation now in place:** the new CI diagnostics step puts attribution data
> in the job log itself, so a recurrence will be attributable without the blob.

---

## 6. EVIDENCE SCORECARD

`docs/rubric/P0R-95_SCORECARD.md` is updated only with evidence verified this
session.

| Quantity | Value | Basis |
|---|---|---|
| **Capability index** | **44.375%** (frozen) | v1.1 §10 historical record — carried, not re-derived |
| **Evidence-qualified score** | **9.484375%** (frozen) | v1.1 §10 historical record — carried, not re-derived |
| **Numerical 95% score** | **NOT COMPUTABLE** | v1.0 numeric schedule UNRECOVERED |
| Units scored | **1 of 60** (D07b only) | only D07b has a fully-specified rule |
| Units unscorable | **59 of 60** | missing E0–E6 values, freshness model, dimension weights, floors, gate lists |
| D07b | **0.0000000 / 2.25** (`q_07b = 0` exactly) | recomputed at this SHA; all nine modalities `P_m = 0` |
| Provenance limitation | **P0R-RUB-02 / L-3 / L-11 OPEN** | exhaustive search exhausted; owner input required |
| Renormalization | **NOT performed** | v1.1 X1/X2 |
| Roadmap/documentation credit | **NOT awarded** | v1.1 V3/V4 |

**Evidence-class movements this session** (class only — no numeric coefficient is
asserted, because the E0–E6 values are unrecovered):

| Item | Before | After |
|---|---|---|
| P2-S2 evidence | PR-ATTESTATION | **PRIMARY** (fresh execution) + committed canonical record |
| P2-S3 evidence | PR-ATTESTATION | **PRIMARY** (fresh execution) + committed canonical record |
| P2-S4 F6 (A-16/A-24) | remediation-in-review | **VERIFICATION** (fresh independent + mutation-proven) |
| D14 testing/assurance | strong | **stronger** — +6 deterministic regression tests; false-negative path eliminated; CI detector now deterministic and failing |
| D15 governance | deficient | **unchanged in effect** — defect fully characterized and the exact reversible fix prepared, but **not applied** (human-owned) |

---

## 7. S4 / F6 STATUS — PRESERVED

| Item | Status | Note |
|---|---|---|
| **F6** | **CLOSED** | Preserved on the fresh independent A-16 + A-24 verification and bidirectional mutation testing. **Not reopened** — no contradictory evidence arose this session. The full regression re-run (1,417 / 0 fail / 0 skipped) is consistent with the closure. |
| **F1** service-elevation coverage | **OPEN / NON-BLOCKING** | unchanged |
| **F2** service-seam session binding | **OPEN / NON-BLOCKING** | unchanged |
| **F3** `approvalRequired` enforcement | **OPEN / NON-BLOCKING** | unchanged |
| **F4** bootstrap operator / CLI gap | **OPEN / NON-BLOCKING** | unchanged |
| **F5** step-up re-verification | **OPEN / NON-BLOCKING** | unchanged |
| **A-09** privacy-preserving deviation | governed documented deviation | not relabelled |
| **`sessionEventId` absence** | CONFIRMED IN SOURCE, OPEN / NON-BLOCKING | `delegationEventDoc()` omits it; `DelegationRequirement.sessionEventId` optional vs. `privilege-store.ts:154` mandatory for elevations |
| **S-10 enforcement-denial audit semantics** | **UNVERIFIED FORMAL FINDING** | No formal S4 finding label invented. The underlying behaviour is documented: decide-path audit is fail-closed (`AUDIT_UNAVAILABLE`), enforce-path audit is best-effort by design (`durable-decider.ts:1738-1749`) |
| Platform-scope consumption ordering | unchanged | not relabelled |
| Exact-or-`*` target semantics | unchanged | not relabelled |

---

## 8. M1 EXIT CRITERIA

| Required final state | Status | Class |
|---|---|---|
| PR #33 independently verified | **DONE** — §1, every check executed | CLOSED BY VERIFIED EVIDENCE |
| v1.1 provenance canonical/verified | **DONE** — blob-identical at PR head | CLOSED BY VERIFIED EVIDENCE |
| v1.0 explicitly unrecovered | **DONE** — no further reconstruction attempted | FORMALLY DISPOSITIONED — EXTERNAL/EVIDENCE-BLOCKED (owner-supplied text required) |
| Governance ruleset human-admin action identified | **DONE** — exact payload + read-back + reversibility | FORMALLY DISPOSITIONED — HUMAN-OWNED |
| P1C-OBS-01 resolved or dispositioned | **DONE — RESOLVED** (remediated, regression-locked, mutation-proven) | CLOSED BY VERIFIED EVIDENCE |
| G10 resolved or dispositioned | **DONE — formally dispositioned** OPEN/UNATTRIBUTABLE, evidence-blocked | FORMALLY DISPOSITIONED — EXTERNAL/EVIDENCE-BLOCKED |
| F6 CLOSED | **DONE** — preserved on verified evidence | CLOSED BY VERIFIED EVIDENCE |
| Provisional scorecard current and evidence-backed | **DONE** — §6, no fabricated percentage | CLOSED BY VERIFIED EVIDENCE |

**No unresolved item is omitted.** Every M1 item carries one of the three
permitted dispositions.

---

## 9. SECURITY PRESERVATION

| Control | Touched? |
|---|---|
| Authorization / A-01 pipeline | **No** |
| Tenant isolation / RLS | **No** |
| Fail-closed behavior | **No** — and the harness change makes the *test* posture more fail-closed, not less |
| Durable identity state | **No** |
| Delegation controls | **No** |
| Audit integrity | **No** |
| Production refusal of `dev-inmemory` credentials | **No** |
| Credential escalation / permission bypass | **None attempted** — the 403 was reported, not worked around |
| SSL verification bypass | **None** |
| Force push / history rewrite / canonical reset | **None** |

Zero `packages/*/src/` files were modified. No security-relevant product code was
altered in this milestone.

---

## 10. NEXT-MILESTONE GATE — ANSWERS

| Question | Answer |
|---|---|
| **Is M1 CLOSED?** | **YES** — every item is CLOSED BY VERIFIED EVIDENCE or formally dispositioned as human-owned / evidence-blocked. |
| **Is PR #33 ready for explicit human merge authorization?** | **YES** — verified as exactly the audited artifact; CI green; `mergeStateStatus=CLEAN`; documentation-only. |
| **Which blockers remain human-owned?** | **1.** Ruleset `20134880` hardening (needs `administration:write`). **2.** Merge authorization for PR #33. **3.** Owner-supplied authoritative `JATA-P0-95-v1.0` text. **4.** D1–D4 owner decisions (static-token default, KMS/HSM provider, DB role provisioning, slice granularity). |
| **Which blockers are evidence-unrecoverable?** | **1.** G10 job-log content — retained server-side, egress-blocked here. **2.** The v1.0 numeric schedule — absent from every repository artifact. **3.** Milestone-time independent verification reports for S2/S3 — never written; not reconstructible. |
| **Is P1C-OBS-01 resolved?** | **YES** — remediated across 4 harnesses (15 + 3 test files), regression-locked by 6 mutation-proven tests, CI detector made deterministic and failing, diagnostics added. Full regression 1,417 / 0 / 0. |
| **Is G10 resolved?** | **NO — OPEN / UNATTRIBUTABLE**, formally dispositioned as evidence-blocked. Substantially advanced: it is now shown to belong to a recurring 9-occurrence class with an identified mechanism. |
| **Is the 95% score still non-computable?** | **YES — NOT COMPUTABLE.** 1 of 60 units scored. No percentage published. |
| **What exact prerequisites remain before S7?** | **Technical: NONE.** S7's only stated dependency is S1, which is implemented and verified. Remaining prerequisites are **governance**: (a) PR #33 merged by human authorization; (b) a separate explicit S7 implementation authorization naming scope, D1–D4 resolutions, G10/G19 handling, verification criteria, report-durability rule, scoring rules, and rollback boundary (per the P2 spec's standing rule). Recommended-but-not-blocking: apply the ruleset hardening first, so S7's PR is merge-gated. |
| **Is S7 now the highest-value authorized next milestone?** | **YES.** It has the best dependency-reduction ratio available: its contract already exists (`credential-store.ts:185`, production already refuses `dev-inmemory`), its cost is **S**, and it simultaneously unblocks **S5** (TOTP secrets), **S6** (break-glass seal), and **D2 KMS/HSM**. Building S5 first would produce MFA over a dev double — negative-value work. |

---

## 11. TOOL-INDUCED TRACKED-ARTIFACT MUTATION

| Event | Handling |
|---|---|
| `npm run scan:r2` rewrites tracked `docs/verification/r2-secret-scan.json` | Detected via `git status --porcelain`, restored with `git checkout --`, tree re-verified. **Documented, never concealed.** |
| Two temporary mutations to `pg-test-harness.ts` for non-vacuity proof | Reverted from a pristine copy; `grep -c MUTANT` → 0 in source and `dist/`; pristine re-run 6/6. |
| `node_modules/`, `packages/*/dist/`, `.jataqi/` | All gitignored — verified |

---

*End of M1 closure record. No product behavior changed. No security control
weakened. No credential escalated. No force push. No merge performed.*
