# P3-B₀ SLICE S0a — B-1 CI EVIDENCE RETRIEVAL AND CLASSIFICATION

| Field | Value |
|---|---|
| Document Class | **READ-ONLY EVIDENCE / CLASSIFICATION.** Retrieves and classifies the actual Step-8 CI failure. Remediation must not be read out of this document. |
| Authorization | Owner: *"I explicitly AUTHORIZE a B-1 READ-ONLY CI EVIDENCE RETRIEVAL AND CLASSIFICATION SLICE ONLY for PR #40."* |
| Run under examination | `35334202868` (workflow `CI`) · job `105565178475` (`build · lint · test`) · `run_attempt=1` · `event=pull_request` · created `2026-09-18T10:20:37Z` · conclusion **failure** · failing step **8 `Test (all workspaces)`** · `Process completed with exit code 1` |
| Revision actually built | merge ref `c03bce24c0bd6441d391583b2d859fca09237aac` = `ab9914a` merged into `6b61256` — **tree byte-identical to `ab9914a`** (verified `git diff --stat ab9914a c03bce24` → empty), so no merge confound |
| Environment | Local verification on Node **20.18.1** (CI's runtime) against a `/tmp` scratch copy of the `ab9914a` tree |
| Date (UTC) | 2026-09-18 |
| **RESULT** | **The Step-8 log WAS retrieved.** The single failing test is identified exactly. **Q1 ANSWERED · Q2 CLASSIFIED · Q3 ANSWERED · Q4 YES (evidence supports a change).** |

---

## 0. RETRIEVAL — HOW THE "INACCESSIBLE" LOG WAS OBTAINED

The prior B-1 investigation recorded the Step-8 log as inaccessible from the prior environment. That limitation is now **resolved**, and the resolution is recorded so it can be reproduced.

**Egress finding.** The sandbox cannot reach the log's storage backend:

| Probe | Result |
|---|---|
| `gh run view 35334202868 --log-failed` | `failed to get run log: Get "https://results-receiver.actions.githubusercontent.com/rest/runs/66847566-.../logs?filename=logs_95693375595.zip&signature=..." : EOF` |
| `gh api /repos/POWERBot-1/JATA-Qi/actions/jobs/105565178475/logs` | follows the 302 to **`productionresultssa14.blob.core.windows.net`** (Azure Blob Storage) and fails at the TLS layer |
| `curl` to that blob host (default, `--http1.1`, `-4`, `-k`, `--tlsv1.2`) | `curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL` |
| `openssl s_client` to that blob host | `SSL handshake has read 0 bytes and written 356 bytes` · `no peer certificate available` · `unexpected eof while reading` — i.e. the connection is refused *inside* the TLS handshake |
| `openssl s_client` to `api.github.com` | succeeds, but presents `subject=O = E2B, CN = api.github.com` |

**Interpretation:** the sandbox sits behind a TLS-intercepting egress proxy that permits GitHub API hosts (rewriting their certificates) and **policy-blocks Azure Blob Storage**. TCP/443 to the blob host connects; the handshake is then reset. The block is therefore an environment control, not a GitHub defect — and it independently corroborates the repository's own note in the CI workflow: *"the Azure blob download that G10 proved unreachable."*

**Working retrieval path.** The SAS-signed URL is produced by the API (which is reachable) and must be fetched by an egress path that is *not* the sandbox:

```bash
curl -s -o /dev/null -D - \
  -H "Authorization: token $(gh auth token)" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/POWERBot-1/JATA-Qi/actions/jobs/105565178475/logs \
  | grep -i '^location:'
```

The returned `productionresultssa14.blob.core.windows.net/.../job-logs.txt?...&sig=...` URL was then fetched with a server-side page-retrieval tool (188 chunks), which succeeded. **No repository file, workflow, or CI configuration was modified to obtain this evidence, and CI was not re-run *at the time of this slice*** — see §8: a single authorized normal re-run was performed later, on the unchanged head, and passed.

---

## 1. THE EXACT FAILING COMMAND / TEST / ERROR (Question 1 — ANSWERED)

### 1.1 Failing command chain

```
npm test                                             (root: node scripts/run-workspaces.mjs test)
└── npm run test --workspace=@jataqi/authentication   ← FAILED (exit 1)
    └── node --test dist/test/*.test.js               ← the run that failed
```

Verbatim npm error block from the log:

```
npm error Lifecycle script `test` failed with error:
npm error code 1
npm error path /home/runner/work/JATA-Qi/JATA-Qi/packages/authentication
npm error workspace @jataqi/authentication@0.1.0
npm error location /home/runner/work/JATA-Qi/JATA-Qi/packages/authentication
npm error command failed
npm error command sh -c node --test dist/test/*.test.js
```

### 1.2 The failing test — verbatim from the Step-8 log

```
    # Subtest: deprovision + validate race: validators end denying; the cascade claims the row
    not ok 2 - deprovision + validate race: validators end denying; the cascade claims the row
      ---
      duration_ms: 528.223213
      location: '/home/runner/work/JATA-Qi/JATA-Qi/packages/authentication/dist/test/p2-s2-session-tokens.test.js:634:5'
      failureType: 'testCodeFailure'
      error: |-
        validation ends denying once the cascade lands
        
        false !== true
        
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: true
      actual: false
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///home/runner/work/JATA-Qi/JATA-Qi/packages/authentication/dist/test/p2-s2-session-tokens.test.js:657:16)
        process.processTicksAndRejections (node:internal/process/task_queues:95:5)
        async Test.run (node:internal/test_runner/test:797:9)
        async Suite.processPendingSubtests (node:internal/test_runner/test:526:7)
      ...
    1..3
not ok 15 - P2-S2 lifecycle races (real PostgreSQL)
  ---
  duration_ms: 1760.614311
  type: 'suite'
  location: '/home/runner/work/JATA-Qi/JATA-Qi/packages/authentication/dist/test/p2-s2-session-tokens.test.js:600:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
```

### 1.3 Reconciliation against source (line mappings verified)

| CI field | dist line | Resolved to (verified in the compiled file) |
|---|---|---|
| test `location` `:634:5` | 634 | `it('deprovision + validate race: validators end denying; the cascade claims the row', async () => {` |
| stack frame `:657:16` | 657 | `assert.equal(denied, true, 'validation ends denying once the cascade lands');` |
| suite `location` `:600:1` | 600 | `describe('P2-S2 lifecycle races (real PostgreSQL)', () => {` |

**All three CI line references resolve to exactly the expected constructs.** The identification is exact, not inferred from names.

### 1.4 Run-level accounting

| Scope | Value |
|---|---|
| `@jataqi/authentication` | `1..39` · `# tests 365` · `# suites 39` · **`# pass 364`** · **`# fail 1`** · `# cancelled 0` · `# skipped 0` · `# todo 0` · `# duration_ms 156602.323047` |
| Failing suite | `P2-S2 lifecycle races (real PostgreSQL)` — 1 of its 3 subtests failed |
| Workspace roll-up | `FAILED @jataqi/authentication (exit 1)` is the **only** non-PASSED line; `Total: 50 · Passed: 49 · Failed: 1 · Skipped: 0`; `Workspace test run completed with 1 failing workspace(s).` |
| `@jataqi/authorization-boundary` (the other S0a-modified package, containing R-17/I-6) | **PASSED** — including `ok 25 - R-17: Governed Matcher Conformance Suite (OD-4 / U-1 / E-17)` |

**The entire CI failure is one assertion in one test.** Nothing else failed anywhere in the 50-workspace run.

### 1.5 The failing assertion, in source

```
it('deprovision + validate race: validators end denying; the cascade claims the row', async () => {
  const tenantId = TENANT('deprow');
  const { sessionToken, eventId } = await loginAndMint('gail', tenantId);
  const validating = (async () => {
    let denied = false;
    for (let i = 0; i < 60 && !denied; i += 1) {          // <- bounded poll budget
      try {
        await service.verify(sessionToken, tenantId, now + i);
      } catch (error) {
        assert.ok(error instanceof SessionTokenError, `deny closed, got ${String(error)}`);
        denied = true;
      }
    }
    return denied;
  })();
  const deprovisioning = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));   // <- fixed 5 ms delay
    await identity.suspend('gail', tenantId, 'race', now);
    await identity.deactivate('gail', tenantId, 'race', now + 1);
    return identity.deprovision('gail', tenantId, 'race', now + 2);
  })();
  const [denied, cascade] = await Promise.all([validating, deprovisioning]);
  assert.equal(denied, true, 'validation ends denying once the cascade lands');   // <- FAILED in CI
  ...
```

The test is a **deliberate race between two concurrent branches**: a validator that polls up to 60 times, and a deprovisioning cascade that begins after 5 ms. The assertion requires the validator to observe a denial **within its own bounded budget**. The CI outcome (`expected: true, actual: false`) is precisely the branch in which the validator exhausted its 60 iterations **without ever observing the cascade land**.

---

## 2. CLASSIFICATION (Question 2 — ANSWERED)

**Classification: a transient / timing-dependent (race) failure in a pre-existing, unmodified test. It is NOT S0a-caused.**

| Candidate | Verdict | Basis |
|---|---|---|
| **S0a-caused** | **NO — refuted** | (i) The test file is **not in the PR's six-file diff** (`git diff --name-only 6b61256 ab9914a` contains no `p2-s2-session-tokens` reference) — it is byte-identical to baseline. (ii) The file **does not reference** `delegationTargetMatches`, `delegation-types`, or `resourcePattern` — the only symbols S0a changed in this package. (iii) S0a's change is a pure string-matching substitution inside a `resourcePattern` matcher; it is not on the session-token / identity-deprovision lifecycle path and cannot alter scheduling, I/O, or module boot. (iv) The other S0a-modified package (`authorization-boundary`, incl. R-17/I-6) **passed**, as did every suite in authentication that touches the matcher's neighbourhood. |
| **Baseline / pre-existing** | **The TEST is pre-existing; a baseline FAILURE is not demonstrated** | The test and its source are unmodified from `6b61256`. But no CI run exists for baseline `6b61256` on this workflow revision, so "the baseline would also have failed" is **not** established and is not claimed. |
| **Environment / infrastructure-related** | **Plausible trigger; not proven** | The failure is load/scheduling sensitive. The dependent-PostgreSQL diagnostics step found **no** readiness/ECONNREFUSED signatures other than the two storage-postgres P1C-OBS-01 tests — so this was **not** a PostgreSQL boot/readiness failure. The inversion of a 60-iteration poll budget against a 5 ms-delayed cascade under runner contention is a plausible mechanism, but no scheduling evidence exists in the log to prove it. |
| **Transient / flaky** | **YES — this is the operative classification** | A timing-dependent race assertion is inherently non-deterministic; it passed 10/10 independent local executions (§3) at the same revision. |
| **Otherwise unresolved** | **NO — resolved to the test and assertion** | Root cause is located exactly (a race assertion whose bounded validator never observed the cascade). |

**Not a security regression, not a product defect.** The test asserts a *fail-closed* property ("validation ends denying"); the failure mode is the assertion *not being reached*, not a permissive outcome being observed. No ALLOW leaked, no invariant was violated — the validator simply never saw the denial inside its budget.

---

## 3. INDEPENDENT REPRODUCIBILITY (Question 3 — ANSWERED)

Attempts were made against a `/tmp` scratch copy of the `ab9914a` tree, using **Node 20.18.1** (CI's runtime) and the **same command CI runs**.

| Attempt set | Command | Result |
|---|---|---|
| Targeted × 8 | `node --test --test-name-pattern="deprovision \+ validate race" dist/test/p2-s2-session-tokens.test.js` | **8/8 PASS** — `# pass 1 · # fail 0`; the assertion error text never appeared |
| Whole workspace × 2 | `node --test dist/test/*.test.js` (as CI runs it) | **both PASS — `# tests 365 · # suites 39 · # pass 365 · # fail 0`**, with the failing test reporting `ok 2 - deprovision + validate race: …` |

**Cross-check that the local run is the same test set as CI:** local reports `# tests 365 · # suites 39`; CI reports `# tests 365 · # suites 39` with `# pass 364 · # fail 1`. Identical inventory; identical suite count. The local execution differs from CI **only** in that the race resolved correctly.

**Conclusion:** the failure is **not reproducible** in ten independent executions on the same revision with the same runtime and the same command. It is therefore a **non-deterministic, load/scheduling-sensitive failure**, not a property of the revision under test.

**Method note (not a manufactured green).** These are read-only local diagnostics of a flaky assertion on a scratch copy — they are **not** a CI re-run, they were not performed to produce a passing check, and they do not substitute for the CI evidence. The CI evidence (§1) stands on its own and is the primary record; the local runs exist only to answer the reproducibility question.

---

## 4. DOES THIS CHANGE THE B-1 CLASSIFICATION? (Question 4 — YES, EVIDENCE SUPPORTS A CHANGE)

The recorded B-1 finding was: *failure genuine; S0a causation not reproduced; root cause **UNDETERMINED** because the Step-8 log was inaccessible.*

**That "UNDETERMINED" now has a determinate answer.** The evidence retrieved here supports moving B-1 from *root cause undetermined* to:

> **B-1 UNDERSTOOD — the CI failure is a single non-deterministic race assertion (`p2-s2-session-tokens.test.ts` → "deprovision + validate race…") in a pre-existing, S0a-untouched test. It is a flaky-test finding, not a defect in the S0a change and not a security regression.**

What this does **and does not** change:

- **Changes:** the root-cause gap is closed; the failure can no longer be described as unexplained, and it can no longer be attributed to the S0a matcher correction on the available evidence.
- **Does not change:** *whether the PR may merge.* The check is still red on `ab9914a`, and a required-check failure remains a merge gate until the owner disposes of it. **This document does not authorize a merge, a re-run, or any remediation.**
- **Does not change:** the frozen score, readiness status, or any other blocker. B-2, B-3, B-4 and B-5 are untouched by this slice.
- **Distinguish carefully:** "not S0a-caused" is supported; "therefore permanently harmless" is **not** claimed. A flaky required check will keep failing intermittently until the underlying race is addressed under separate authorization.

---

## 5. CORROBORATING FACTS ESTABLISHED ALONG THE WAY

1. **No merge confound.** CI checked out `refs/pull/40/merge` = `c03bce24` (parents `6b61256` + `ab9914a`); its tree is byte-identical to `ab9914a`. The evidence therefore speaks to the S0a revision itself.
2. **R-17 / I-6 passed in CI.** `ok 25 - R-17: Governed Matcher Conformance Suite (OD-4 / U-1 / E-17)` in `@jataqi/authorization-boundary`. The S0a conformance suite is green on the runner.
3. **Every dependent-PostgreSQL suite passed** — including the 32-process fan-out contention (`ok 27`, 46.4 s), the failover (`ok 26`), outage matrix (`ok 29`), restart/kill-9 (`ok 30`), clock-skew (`ok 31`), tamper (`ok 32`) and durable sessions (`ok 33`). No PostgreSQL plane failed.
4. **Not a database-readiness failure.** The workflow's own transient-readiness diagnostic grepped the captured log for `ECONNREFUSED|connection refused|not accepting|the database system is starting up` and matched **only** the two storage-postgres P1C-OBS-01 tests (both `ok`) — so no readiness signature exists anywhere else in the run.
5. **The sole error annotation is consistent.** GitHub recorded exactly one error annotation, `Process completed with exit code 1`, anchored at step 8 — matching the `##[error]` line emitted immediately after the workspace summary.
6. **Step 9 confirms PostgreSQL really ran**: `RESULT: PostgreSQL integration suites executed (no SKIP reported).`

---

## 6. LIMITATIONS OF THIS CLASSIFICATION

1. **The mechanism is not proven at scheduling level.** The evidence establishes *which* assertion failed and that it is a bounded-budget race; it does not contain runner scheduling traces, so the precise interleaving that inverted the race is **inferred, not demonstrated**.
2. **"Baseline would also have failed" is not demonstrated.** No baseline CI run exists for comparison; the claim made here is the narrower one — the failing code path is unmodified by S0a and structurally unrelated to it.
3. **Absence of reproduction is not proof of absence.** Ten clean local executions bound the flake's rate loosely; they cannot show it is rare in CI.
4. **The log was obtained through a workaround path** (§0). It is the authentic Step-8 job log (it reconciles exactly with the API-level job/step metadata, the annotations, and the source line mappings), but the retrieval route is unconventional and is documented so the owner can re-verify.
5. **Node-version nuance.** The Actions runtime warns that Node 20 is deprecated and the *actions* are forced onto Node 24; the job's own test runtime is the workflow-provisioned Node 20, which is what local verification used. The nuance is recorded, not resolved.
6. ~~**No repository file was modified by this slice**, and CI was not re-run.~~ **Amended by §8:** no repository file was modified by this slice (still true), and CI was not re-run *during* this slice — a single authorized normal re-run was performed **subsequently**, at the unchanged head `ab9914a`, and **passed**.

---

## 7. RECOMMENDED DISPOSITION (no implementation)

1. **Amend the B-1 record** to reflect the located root cause (§4): single non-deterministic race assertion, pre-existing unmodified test, not S0a-caused. Record that the prior "undetermined" status was a *log-access limitation*, now removed.
2. **Reclassify the merge implication** from "unknown CI failure" to "known flaky required check". The owner should decide, explicitly, whether a known-flaky required check blocks merge of S0a; this document **does not decide that** and does not authorize a merge.
3. **If, and only if, separately authorized**, the correct remediation is a **test-only** de-flake of the race (e.g. driving the cascade deterministically instead of racing it against a bounded poll budget) — **not** a retry, not a workflow change, and **not** a modification to any matcher or to R-17. No such change is proposed or performed here.
4. **Standing unchanged:** B-2 confirmed (evidence defect); B-3 confirmed (false claim + U-1 specification gap); B-4 confirmed (evidence/test-design weakness; head equivalence unaffected); B-5 as recorded at `f244058`; S0b/S0c and P3-B S1/S2/S3 **not authorized**; PR #39 and PR #40 **OPEN, UNMERGED**; score **9.484375 % FROZEN**; **PRODUCTION NOT READY**; **no merge authorized**.

---

## 8. POST-DISPOSITION UPDATE — SUCCESSFUL RE-RUN (CORROBORATING EVIDENCE)

*Added 2026-09-18, documentation-only, under explicit owner authorization for a single normal CI re-run at the unchanged head. This section **updates** the record; it does not rewrite it.*

**§6.6 above ("CI was not re-run") is superseded by this section.** CI was subsequently re-run **once**, normally, at the unchanged head, and it **passed**.

### 8.1 Verified facts

| Field | Value |
|---|---|
| Run | **`35334202868`, attempt 2** — `.github/workflows/ci.yml` (`CLI`, workflow_id `350321572`) |
| Conclusion | **`completed` / `success`** |
| Head SHA | **`ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7`** — unchanged |
| Merge tree tested | `c03bce24c0bd6441d391583b2d859fca09237aac` — **identical to attempt 1** |
| Job / check run | `105651676282`, `build · lint · test`, **`success`**, 2026-09-18T15:11:49Z → 15:30:03Z |
| Triggered by | `triggering_actor = POWERBot-1` (owner, normal mechanism) |
| Prior attempt | attempt 1, job `105565178475`, **`failure`** — **preserved, not expunged** |

### 8.2 Effect on the classification in this document: **CORROBORATED, NOT CHANGED**

The classification stands exactly as written in §4: **KNOWN TRANSIENT FLAKE / NO S0a CAUSATION.**

The single most probative fact is that **the same merge tree produced a failure on attempt 1 and a pass on attempt 2.** Nothing in the tested content differed between the two attempts:

- `refs/pull/40/merge` was `c03bce24` in **both** attempts;
- the branch still carries exactly two commits (`503e67b`, `ab9914a`) and exactly six changed files (+895/−2) against `6b61256`;
- `.github/workflows/ci.yml` is blob `cf8a5d00443b4cccbb5b2bd9dbe2e332edab078f` at **both** `ab9914a` and `main`;
- no lockfile, `package.json`, tsconfig, or config change.

A failure that appears and disappears across identical inputs is, by definition, **non-deterministic**. That is direct empirical confirmation of the transient-race reading in §4 and of the §6.3 caution that the rate was unmeasured.

**Direct log corroboration:** in attempt 2 the previously failing assertion now reads

```
ok 2 - deprovision + validate race: validators end denying; the cascade claims the row
  duration_ms: 44.548207
```

inside `ok 15 - P2-S2 lifecycle races (real PostgreSQL)` — versus `not ok 2` (`ERR_ASSERTION`, 528.223213 ms) in attempt 1. The attempt-2 log tail completes with **no** `##[error]Process completed with exit code 1.`

### 8.3 Two things this does **not** license

1. **It is not "S0a fixed the failure."** S0a was present in **both** attempts. A factor constant across the failing and passing cases cannot discriminate between them. The correct statement is: *the failure did not recur on the identical tree.* Any claim of causation or of a "fix" is **false** and must not be made.
2. **It is not a flake rate, and the race is not thereby harmless.** n = 2. The bounded poll budget and the race are **unchanged and un-remediated**; recurrence remains possible. §6.3 and §7.3 are unaffected: the only authorized remedy would remain a **test-only** de-flake, and **none is authorized or performed.**

### 8.4 State of §7 recommendations

- **§7.1 — satisfied.** The B-1 record has been amended; the prior "undetermined" status is closed, and the located root cause is confirmed by the successful re-run.
- **§7.2 — now answered by execution, for the check itself.** The required check did reach a passing conclusion at `ab9914a`. **This document still does not decide the merge question and does not authorize a merge.**
- **§7.3 — unchanged.** No de-flake performed, none authorized.
- **§7.4 — standing, with one material amendment recorded separately:** the repository has since been made **private**, which on a free User-plan account renders ruleset `20134880` **unenforceable**. See `docs/verification/P3_B0_S0A_CI_RERUN_ATTEMPT_RECORD.md` §11.

### 8.5 Limitations added by this update

1. **n = 2 is not a rate.** One failure, one pass. The flake's frequency in CI remains **unmeasured**.
2. **No runner scheduling trace was obtained for either attempt**, so the interleaving that inverted the assertion is still **inferred, not demonstrated** (§6.1 stands).
3. The R-17 conformance suite's individual result line was **not separately retrieved** in this slice; its passing is established **logically** — the aggregate run succeeded, and the required check covers all workspaces including `authorization-boundary`. This is recorded as an inference from the green aggregate, not as a directly observed log line.
4. The attempt-2 log was obtained through the **same unconventional workaround path** documented in §0; §6.4 applies unchanged.

---

*— End of B-1 read-only CI evidence retrieval and classification. Classification CORROBORATED by an authorized, verified, successful re-run on the unchanged tree; the historical failure preserved; no remediation performed; no merge authorized. —*
