# B-1 CI INVESTIGATION RECORD — P3-B₀ SLICE S0a (READ-ONLY)

| Field | Value |
|---|---|
| Document Class | **READ-ONLY CI INVESTIGATION RECORD.** Evidence, determination, limitations, recommended next governance action. Grants nothing; remediates nothing. |
| Authorization | Owner: *"I explicitly AUTHORIZE a B-1 CI INVESTIGATION ONLY for PR #40"* (investigation only) |
| Subject | Root-cause investigation of the confirmed CI failure on verified S0a head `ab9914a` |
| Under investigation | PR **#40** · required check **`build · lint · test`** · failing step **Step 8 — Test (all workspaces)** · CI run **`35334202868`** |
| Head / Baseline | `ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7` / `6b61256c6115a02da2d3ad6ba42771831b550f81` |
| Environment | **Node 20.18.1** (CI-parity, obtained during this investigation) and **Node 22.22.3**; npm 10.9.8; Linux sandbox, 2 vCPU |
| Date (UTC) | 2026-09-18 |
| Boundaries observed | No code change · no test change · no CI/workflow change · no remediation · no PR #40 modification · no merge · **CI was not re-run** |

---

## 1. HEADLINE DETERMINATION

| Question | Determination |
|---|---|
| Is the CI failure genuine? | **YES — confirmed.** A real red required check on the verified head. Not an artifact of tooling. |
| Is the failure **S0a-caused**? | **REFUTED on available evidence.** Both packages changed by S0a pass fully on CI-parity Node 20; the aggregate suite *including* the new test passes on Node 20. §5. |
| Is it **pre-existing/baseline**? | **Not supported.** The baseline is equally green locally on both runtimes; and the baseline's CI run was green. No pre-existing failure reproduced at either revision. §4. |
| Is it **environment/version-dependent**? | **Best-supported but UNPROVEN.** The failure does not reproduce on Node 20 *or* Node 22, and the failure class this repository documents (`§7`) is environmentally triggered. Recorded as the most consistent classification, **not** as a finding. |
| Root cause | **STILL UNDETERMINED.** The failing step's log is unobtainable. **No root cause is asserted or promoted from hypothesis.** §3. |
| Is a corrective code change justified? | **NO.** No defect was reproduced at either revision. §8. |

**Net effect:** B-1 **remains open and merge-blocking**, but its character changes from *"cause unexamined"* to *"cause examined; S0a-causation refuted; a specific, hard tool-access limitation prevents final attribution."*

---

## 2. THE FAILURE — CONFIRMED EVIDENCE

| Fact | Evidence |
|---|---|
| Run / job / head | `35334202868` / `105565178475` / `ab9914a` |
| Job conclusion | **`failure`** (10:20:40Z → 10:29:38Z, 8m58s) |
| Failing step | **Step 8, "Test (all workspaces)"** — `conclusion: failure` |
| GitHub annotation | `#annotation:8:15882` → **"Process completed with exit code 1."** |
| Steps 1–7 | `success` (incl. "Build all workspaces", "Lint") |
| Steps 9–10 | `success` (incl. "PostgreSQL integration status") |
| Check is required | Ruleset `20134880`, `enforcement: active`, `required_status_checks: ["build · lint · test"]`, `strict_required_status_checks_policy: true` |

`ci.yml` step 8 is `set -o pipefail; npm test 2>&1 | tee /tmp/jataqi-test-output.log`, so exit 1 originates from `npm test`.

**Inference from step 9 (confirmed, not hypothesised):** step 9 executes `grep -qi 'SKIPPED: PostgreSQL integration' "$LOG"` and `exit 1` on a match. It **succeeded**, therefore that pattern was absent ⇒ **PostgreSQL integration *did* execute in the CI run**. The failure is **not** a database-skip false-negative and **not** "PostgreSQL unavailable on the runner".

---

## 3. LIMITATION — CI LOG INACCESSIBILITY (PRECISELY CHARACTERISED)

The failing step's log content could **not** be obtained. This is a **hard tool-access limitation**, characterised exactly:

| Probe | Result |
|---|---|
| `gh api repos/…/actions/runs/35334202868/logs` | error `Get "https://results-receiver.actions.githubusercontent.com/…"` → **EOF** (2 attempts) |
| `gh api repos/…/actions/jobs/105565178475/logs` | error `Get "https://productionresultssa14.blob.core.windows.net/…"` → **EOF** |
| Direct `curl -sSL` of the fresh signed SAS URL | **`curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to productionresultssa14.blob.core.windows.net:443`** |
| TCP `/dev/tcp` probe to `results-receiver.actions.githubusercontent.com:443` | **reachable** |
| TCP probe to `productionresultssa14.blob.core.windows.net:443` | **reachable** |
| TCP probe to `nodejs.org:443` | **reachable** |
| TCP probe to `registry.npmjs.org:443` | **reachable** |
| GitHub UI (`/actions/runs/…/job/…`) | *"Sign in to view logs"*; every step reported **"truncated due to its large size"**; `output.title` and `output.summary` both **null** |

**Characterisation:** TCP connectivity succeeds on every host; the **TLS handshake is reset** (`SSL_ERROR_SYSCALL`) on the GitHub/Azure log-storage hosts. This is **TLS-layer egress filtering**, **not** a TCP block, **not** an authentication failure, and **not** a property of PR #40. `api.github.com` and `github.com` remain reachable (all other evidence in this record was gathered through them).

**This limitation is pre-existing and already recorded twice in this repository:**
- `docs/S01_TENANT_BOUNDARY_HARDENING.md:168` — *"CI log blobs are unreachable from this sandbox (TLS egress blocked), which will be reported as an explicit limitation rather than inferred away."*
- PR #34 (G10) body — *"the original canonical-main CI failure … **remains unreadable from this environment** (CI log-storage egress blocked — `results-receiver.actions.githubusercontent.com` / Azure blob unreachable). … **This PR therefore does NOT retroactively prove the original CI failure's exact cause**."*

**Consequence:** the *exact failing test/package/error* (authorization requirement 1) **could not be established**. Requirement 2 is therefore satisfied by this section: the limitation is documented precisely rather than inferred away.

---

## 4. REPRODUCED EXECUTION EVIDENCE (NEW)

To test CI parity rather than assume it, a **genuine Node 20 runtime was obtained during this investigation**. `nodejs.org` is TLS-blocked, but the **npm registry is reachable**, so the arch-specific distribution was taken from the registry:

```
npm pack node-linux-x64@20.18.1     → 98 MB binary
/tmp/node20/bin/node -v             → v20.18.1
```

(CI pins `node-version: '20'`; the repository's own record observed **v20.20.2** in CI. `20.18.1` is the same minor line and is the closest obtainable parity runtime.)

### 4.1 Full aggregate suite — both revisions, both runtimes

| Revision | Runtime | Result |
|---|---|---|
| **Head `ab9914a`** | **Node 20.18.1** | **`Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0` — EXIT 0** · **1621 tests / 1621 pass** |
| **Baseline `6b61256`** | **Node 20.18.1** | **`Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0` — EXIT 0** · **1619 tests / 1619 pass** |
| Head `ab9914a` | Node 22.22.3 | `Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0` |
| Baseline `6b61256` | Node 22.22.3 | 50/50, 0 failed |

**Delta head − baseline = +2 tests = exactly the R-17 suite. No regression on either runtime.**

### 4.2 The packages S0a actually changes

| Target | Runtime | Result |
|---|---|---|
| `@jataqi/authorization-boundary` (contains R-17) | **Node 20.18.1** | **188 tests / 188 pass / 0 fail — exit 0** |
| `@jataqi/authorization-boundary` | Node 22.22.3 | 188 / 188 / 0 fail — exit 0 |
| `r17-matcher-conformance.test.js` alone | **Node 20.18.1** | **2 / 2 pass — exit 0** |
| `@jataqi/authentication` | **Node 20.18.1** | part of the green aggregate (365 / 365 / 0 fail) |

### 4.3 Masked-failure hunt — the repository's own recommended check

`docs/verification/P2_S1_VERIFICATION_REPORT.md:72-79` documents that node:test emits **`not ok`** for a top-level suite-setup failure while **excluding it from the `# tests`/`# pass`/`# fail` counters**, with version-dependent exit status. The repository's own §1.5 recommends a **TAP `not ok` scan** as the detector. That scan was performed on the captured output of both runtimes and both revisions:

| Scan (head, Node 20, full 50-workspace run) | Result |
|---|---|
| `not ok` occurrences | **0** |
| `# fail` > 0 occurrences | **0** |
| `SKIPPED: PostgreSQL integration` | **0** |
| `^Error:` lines | **0** |
| Reported `# tests` vs `# pass` | **1621 / 1621 — exact** |

Baseline (Node 20) identical: **0 `not ok`**, **0** failures, **0** skips, 1619/1619.

**Therefore the documented masking mechanism is NOT currently active at this head** — no suite is throwing at setup on either runtime. This materially weakens, and for this head effectively refutes, the previously-recorded hypothesis **H2** (masked setup failure in the newly added, environment-sensitive R-17 file). The R-17 file also passes standalone on Node 20.

**Note on 4 `ECONNREFUSED` strings present in the head log:** these are inside the readiness-harness regression suite (`ok 6 - withPgReadiness retries transient boot operations and surfaces permanent ones immediately`) and in postmaster stderr diagnostics — **assertion content, not failures**.

---

## 5. CAUSALITY — IS IT S0a-CAUSED? **REFUTED**

The complete executable surface of PR #40 is:

| File | Change |
|---|---|
| `packages/authorization-boundary/src/capability-manifests.ts` | 1 line (`:281` `.join('[^/.]*')`) |
| `packages/authentication/src/delegation-types.ts` | 1 line (`:399` `.join('[^/.]*')`) |
| `packages/authorization-boundary/test/r17-matcher-conformance.test.ts` | new file (test-only) |

Everything else in the diff is documentation (`docs/…`) and one standalone script (`scripts/t16-grant-corpus-eval.mjs`) that **is not executed by CI**.

Reasoning:

1. **No other workspace is modified** — `git diff 6b61256 origin/pr40` touches **no** file under any other package, and **no** file under `packages/storage-postgres/`, `.github/`, or any config. A failure originating in an unrelated workspace therefore **cannot** be caused by the S0a code change.
2. **Both changed packages pass completely on CI-parity Node 20** (§4.2) — so a failure *within* them is not present on the pinned runtime.
3. **The new test passes on Node 20** (§4.2) and is not implicated by the `not ok` scan (§4.3).
4. **The aggregate run including the new test passes on Node 20** (§4.1) — so the new test does not destabilise the aggregate.
5. **Residual contention path, examined and not supported:** the only way a test-only addition could affect an *unrelated* workspace is indirect resource pressure during the aggregate run. The verification runner is **more** constrained (2 vCPU) than a GitHub-hosted runner, so contention-driven failure would be *more* likely here — and it did not occur, on either runtime. This path is therefore **not supported**, though it is not formally excludable by reproduction alone.

**Determination: S0a-causation is refuted on available evidence.** The failure lies outside the slice's executable surface.

---

## 6. BASELINE COMPARISON (REQUIREMENT 6)

Both revisions were executed in full on CI-parity Node 20 (§4.1). They are **identical in outcome**: 50/50 green, 0 failures, 0 skips, 0 `not ok`. The **only** difference is +2 tests (the additive R-17 suite). Consequently:

- The **baseline does not exhibit** the failure locally either ⇒ the local environment cannot reproduce the CI condition at **either** revision.
- Because the baseline's own CI run (`6b61256`, push) was **green**, and the head's is **red**, while their local behaviour is *identical and green*, the discriminator lies **outside** the code — i.e. in run-to-run environment/timing, or in a condition specific to the CI runner at the time.
- **No evidence supports classifying B-1 as "pre-existing/baseline".**

---

## 7. CONTEXT — DOCUMENTED CI-FAILURE HISTORY (CONTEXT ONLY, NOT ROOT CAUSE)

Recorded because it bears on how this class of failure should be *dispositioned*, **not** as an explanation of this failure.

- `packages/storage-postgres/test/pg-test-harness.ts:183` states that an unguarded post-boot `ECONNREFUSED` *"previously threw straight out of the suite — producing a RED run on an unmodified tree, which is the **signature shared by 9 of the 10 historical CI failures**."*
- That race is **already mitigated** at **both** baseline and head by `withPgReadinessRetry` (bounded, 4 attempts, 500 ms·n backoff; transient-only). The file is **identical** at baseline and head (PR #40 does not touch it).
- Repository precedent for dispositioning a red step 8 as transient rather than product: `P0_G10_G19_GAP_RECONNAISSANCE.md:21` (*"Determination **D — TRANSIENT/UNRESOLVED FLAKE**"*) and `M1_CLOSURE_RECORD.md:217` (*"same-SHA flake/recovery evidence cannot be derived from CI history"*).
- Counter-precedent (a red step 8 that **was** a genuine defect): `P2_S1_VERIFICATION_REPORT.md` (fixture calling a non-existent `node:crypto` method) and PR #35 (*"remediate measured CI defects from run 34714876835"*).

**Both classes are documented in this repository.** That is precisely why **no root cause is promoted here**: the available evidence cannot distinguish them, and instruction 3 forbids assuming either.

---

## 8. IS A CORRECTIVE CODE CHANGE JUSTIFIED? — **NO**

| Candidate action | Justified? | Reason |
|---|---|---|
| Change the matchers / R-17 | **NO** | No defect reproduced; both packages green on Node 20 and Node 22; the matcher semantics were independently verified against a separate oracle. |
| Change the PG harness | **NO** | Already mitigated at both revisions; no failure reproduced in the harness. |
| Change `ci.yml` | **NO** | Step 8 is a faithful aggregate run. No CI misconfiguration was demonstrated. |
| Weaken/skip/adjust any test to obtain green | **NO — expressly forbidden** by the authorization, and unsupported by evidence. |
| **Re-run CI to obtain a green check** | **NOT PERFORMED — deliberately.** A re-run is a legitimate *future* diagnostic, but performing it here could manufacture a green status that masks an unclassified failure. Recorded as a recommended owner action instead (§9). |
| Add a TAP `not ok` scan guard in CI | **NOT part of B-1.** It is a pre-existing, independently-motivated improvement (recommended by the repo's own `P2_S1` §1.5). The scan performed in §4.3 found **0** `not ok`, so this guard **would not have changed this outcome**. It must not be smuggled in as a B-1 fix. |

**No corrective code change is justified by the evidence available.** There is nothing reproduced to repair.

---

## 9. RECOMMENDED NEXT GOVERNANCE ACTION

To the owner — **investigation remains incomplete only for want of the log**, so the minimum path to closure is:

1. **Obtain the Step-8 log of run `35334202868` from an egress-capable environment** (a session without the TLS egress filter, or an authenticated browser download of the raw log). This is diagnosis, not remediation. Either the failing test/workspace will be named, or the log will show the run's own summary — both settle the classification.
2. **If the log names a genuine defect** → request a separately-scoped remediation authorization. Do **not** merge.
3. **If the log shows a transient/environmental condition** (e.g. a readiness race surviving bounded retry, or an infrastructure error) → the correct action is a **CI re-run**, with the result and the classification recorded as the disposition — following the repository's existing "Determination D — TRANSIENT/UNRESOLVED FLAKE" precedent.
4. **Record the B-1 disposition** in the verification chain and update `P3_B0_S0A_INDEPENDENT_VERIFICATION.md` accordingly. Until then **B-1 remains open and merge-blocking**.
5. **Do not merge PR #40** until the required check is green **on the exact head** and its cause is classified.
6. *Optional, separate, and explicitly outside B-1:* consider the TAP `not ok` CI guard recommended by the repo's own `P2_S1` §1.5, as its own authorized item.

---

## 10. LIMITATIONS OF THIS INVESTIGATION

- **Root cause not established.** The Step-8 log is unreachable (§3). No root cause is inferred, and no hypothesis is promoted.
- **CI parity is proximate, not exact.** Testing used **Node 20.18.1** vs CI's observed **20.20.2**, and npm **10.9.8** vs CI's **10.8.2**, on a 2 vCPU Linux sandbox rather than `ubuntu-24.04` on GitHub infrastructure. Patch-level differences and runner differences remain.
- **A single observation of the CI failure exists.** Determinism of the CI failure could not be assessed; the repository's own record notes that *"same-SHA flake/recovery evidence cannot be derived from CI history"*.
- **No deployment-side corpus or environment** was available; all execution was against the repository trees at the two named revisions.
- **CI was not re-run** and **no repository artifact was created, modified or deleted other than this record**; no code, test, workflow, PR or ruleset was touched.

---

*— End of B-1 investigation record. Awaiting separate explicit authorization for any remediation. —*
