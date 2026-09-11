# P2-S4 — F6 Fresh Independent Re-Verification (A-16 / A-24)

| Field | Value |
|---|---|
| Record type | Fresh independent re-verification of the S4 F6 acceptance items (A-16, A-24) |
| Authorization | Phase A — Evidence, Governance & Critical-Path Unlock |
| Date of verification | 2026-09-11 (UTC) |
| Canonical SHA verified | `2455c59e8462ca203e9d57788792acb32e5cdad9` |
| Working branch | `arena/01a08e8a-jata-qi` |
| Suite under verification | `packages/authorization-boundary/test/p2-s4-delegation-decision.test.ts` |
| Backend | **Real PostgreSQL** (embedded, fail-hard — never skips) |
| Node / npm | v22.22.3 / 10.9.8 |
| Prior F6 status | **PARTIALLY CLOSED → remediation in review** (`P2_S4_VERIFICATION_REPORT.md` §9) |
| **New F6 status** | **CLOSED** — see §7 |

---

## 1. Why this re-verification was required

`docs/verification/P2_S4_VERIFICATION_REPORT.md` §9 records F6 as *"PARTIALLY
CLOSED → (remediation in review)"* and states: *"F6 may only be re-marked CLOSED
after a fresh independent re-verification of both"* A-16 and A-24.

The remediation history confirms why:

| Commit | Role | CI |
|---|---|---|
| `5623af56` | S4 implementation | — |
| `40350aab` | canonical verification evidence artifact | **success** ← independent verification ran against **this** head |
| `fbe7332e` | remediation (durable USED/DENIED audit, disablement cascade) | cancelled |
| `fdc38e6c` | remediation (already-consumed grants in the cascade) | **success** |

Merged `2026-09-10T22:50:24Z` as `2455c59`. The independent verification
therefore predates the two remediation commits, and no committed re-verification
existed. **This record supplies it.**

---

## 2. Method — beyond re-running existing tests

Re-running a test only proves it passes. It does not prove the test would
**detect** the failure it claims to detect. This re-verification therefore adds
**mutation testing**: each control is deliberately broken in source, the suite is
rebuilt and re-run, and the corresponding test must **fail**. A test that still
passes under mutation is vacuous and cannot support closure.

Every mutation was reverted with `git checkout --` and the pristine state was
re-verified afterwards (§6).

---

## 3. A-16 — delegator authority change (VERIFIED)

### 3.1 Required semantics

| Requirement | Verified |
|---|---|
| Delegator authority change is detected | ✓ |
| Result `DELEGATOR_AUTHORITY_CHANGED` | ✓ |
| Durable audit evidence emitted | ✓ |
| Correct fail-closed behaviour (DENY) | ✓ |

### 3.2 Test evidence

**Test 13 — `chain integrity (A-16): rotating the delegator manifest after the grant denies DELEGATION_DELEGATOR_AUTHORITY_CHANGED`** → **PASS** (20.07 ms)

**Test 19 — `A-16: a delegator-authority denial emits a durable DELEGATION_DENIED event with result DELEGATOR_AUTHORITY_CHANGED`** → **PASS** (21.03 ms)

Test 19 body (inspected, not inferred) performs:

1. Mint session; grant delegation against capability `CAP_A16` v1 digest.
2. `decideAsync` → asserts `decision === 'ALLOW'`.
3. **Rotate** the delegator's manifest to version 2 via
   `store.registerManifestVersion(...)`, so the cited v1 digest is no longer live.
4. `decideAsync` again → asserts `decision === 'DENY'` **and**
   `reasonCodes` is exactly `['DELEGATION_DELEGATOR_AUTHORITY_CHANGED']`.
5. Query the durable event store: `identity.queryEvents(TENANT, 'DELEGATION_DENIED')`.
6. Assert the event **exists**, `result === 'DELEGATOR_AUTHORITY_CHANGED'`,
   `decision === 'DENY'`, `resource === 'identity.delegations'`.

This covers all four required semantics, including durable audit evidence read
back from PostgreSQL — not merely an in-memory return value.

### 3.3 Mutation test (non-vacuity proof)

| Step | Action |
|---|---|
| Mutation | `durable-decider.ts` — the audit-result mapping `case 'DELEGATION_DELEGATOR_AUTHORITY_CHANGED': return 'DELEGATOR_AUTHORITY_CHANGED'` changed to return `'MUTANT_NOT_THE_REAL_RESULT'` |
| Emission confirmed | `grep -c MUTANT_NOT_THE_REAL_RESULT dist/src/durable-decider.js` → **1** (mutant reached the compiled artifact) |
| Result | **Test 19 FAILED** — `not ok 19 … the A-16 denial cites reason DELEGATOR_AUTHORITY_CHANGED`. Suite: **22 pass / 1 fail** |
| Control | **Test 13 still PASSED** — correct, since this mutation alters only the audit `result` string, not the denial code. The mutation was therefore precisely targeted |

**Conclusion:** the A-16 audit assertion is genuine and load-bearing.

---

## 4. A-24 — enforcement-time manifest/digest mismatch (VERIFIED)

### 4.1 Required semantics

| Requirement | Verified |
|---|---|
| Enforcement-time manifest/digest mismatch detected | ✓ |
| Live revalidation at enforcement | ✓ |
| Denial raised | ✓ |
| **No side effect** | ✓ |
| Durable evidence where required | ✓ — see §4.4 |

### 4.2 Test evidence

**Test 22 — `A-24: rotating the manifest between decide and enforce denies CAPABILITY_VERSION_MISMATCH before the side effect`** → **PASS** (20.05 ms)

Test body (inspected):

1. Grant delegation for `CAP_A24`; `decideAsync` → `ALLOW`, envelope issued.
2. **Rotate** the manifest *after* decide and *before* enforce.
3. Call `gate.executeAuthorized(envelope, sideEffect, …)` where `sideEffect`
   sets a local flag `ran = true`.
4. Assert the call **rejects** with `reasons` including `CAPABILITY_VERSION_MISMATCH`.
5. Assert **`ran === false`** — *"the side effect never ran after the manifest rotation"*.

Step 5 is the security-critical assertion: it proves denial occurred **before**
the side effect, not merely that an error surfaced afterwards.

### 4.3 Mutation test (non-vacuity proof)

| Step | Action |
|---|---|
| Mutation | `durable-decider.ts` — the enforcement digest check `if (active.manifestId !== verified.manifestId || active.digest !== verified.manifestDigest)` prefixed with `false &&`, disabling it |
| Result | **Test 22 FAILED** — `not ok 22 - A-24: … denies CAPABILITY_VERSION_MISMATCH before the side effect`. Suite: **22 pass / 1 fail** |

**Conclusion:** with the control disabled the test fails, so the test genuinely
detects loss of enforcement-time revalidation. It is not vacuous.

### 4.4 Durable-evidence semantics at enforcement (source-verified)

The brief requires "durable evidence where required". Source inspection
establishes the actual semantics, which differ by path:

| Path | Audit behaviour | Source |
|---|---|---|
| **Decide-time denial** (Phase B, in-transaction) | **Awaited and fail-closed** — a failed audit write throws `AUDIT_UNAVAILABLE`; *"an unaudited decision must not exist"* | `durable-decider.ts:1189-1191` |
| **Enforcement-time denial** (`executeDurable`) | **Best-effort** — `bestEffortDenyReceipt()` writes a CONSUMED receipt with `sideEffectInvoked: false` and detail `denied-stale-manifest`, then **swallows** write failures: *"Best-effort: the denial stands regardless (R1 parity)"* | `durable-decider.ts:1303`, `1738-1749` |

The A-24 denial path **does** attempt a durable receipt
(`bestEffortDenyReceipt(verified, 'denied-stale-manifest')`). It is best-effort
rather than fail-closed **by deliberate design**: the *security decision* always
fails closed, and only the *audit record* may be absent under an audit-store
outage.

This asymmetry is **recorded as an observation**, not as a defect and not as a
closed finding. It is separately addressed in §8.

---

## 5. Full-suite result at this SHA (no skipping)

```
$ node --test --test-reporter=spec dist/test/p2-s4-delegation-decision.test.js

▶ P2-S4 durable delegation plane (real PostgreSQL)
  ✔ PostgreSQL backend started (no silent PG skip)
  ✔ chain integrity (A-16): rotating the delegator manifest after the grant
        denies DELEGATION_DELEGATOR_AUTHORITY_CHANGED
  ✔ A-16: a delegator-authority denial emits a durable DELEGATION_DENIED event
        with result DELEGATOR_AUTHORITY_CHANGED
  ✔ A-24: rotating the manifest between decide and enforce denies
        CAPABILITY_VERSION_MISMATCH before the side effect
  ✔ A-25: two distinct envelopes citing the same one-shot grant — exactly one
        consumes it
  … (23 subtests total)

# tests 23
# pass 23
# fail 0
# skipped 0
```

The first subtest, **`PostgreSQL backend started (no silent PG skip)`**, is an
explicit assertion that the backend is live. The harness
(`packages/authorization-boundary/test/r2-pg.ts`) is fail-hard by design:
*"Unlike the canonical storage-postgres harness (which skips when PostgreSQL is
unavailable), this helper THROWS."* With `skipped: 0`, the results are
attributable to real PostgreSQL.

**Also verified:** `packages/authentication/test/p2-s4-delegation-store.test.ts`
→ **22/22 pass, 0 skipped** (suite *"P2-S4 durable delegation store (real
PostgreSQL)"*).

---

## 6. Restoration proof

| Check | Result |
|---|---|
| `git checkout --` after each mutation | performed |
| `git status --porcelain` after restoration | **empty** |
| `npm run build` after restoration | **exit 0** (clean) |
| `grep -c MUTANT_NOT_THE_REAL_RESULT dist/src/durable-decider.js` | **0** — mutant gone from the compiled artifact |
| Pristine suite re-run after restoration | **23 pass / 0 fail / 0 skipped** |
| Tracked tree vs canonical | **identical** to `2455c59` |

No mutation survives in source, in `dist/`, or in the committed tree.

---

## 7. F6 DETERMINATION

> ## **F6 = CLOSED**

Justification:

| Condition required by `P2_S4_VERIFICATION_REPORT.md` §9 | Met |
|---|---|
| A-16 freshly re-verified | ✓ (§3) — deny + durable audit event + correct result + fail-closed |
| A-24 freshly re-verified | ✓ (§4) — live revalidation + denial + **no side effect** |
| Real PostgreSQL | ✓ (§5) — fail-hard harness, explicit no-skip assertion |
| No test skipping | ✓ — `skipped: 0` |
| Re-verification is fresh (post-remediation commits) | ✓ — performed against canonical `2455c59`, which contains `fbe7332` + `fdc38e6` |
| Non-vacuity demonstrated | ✓ (§3.3, §4.3) — both tests fail under targeted mutation |

**No source was patched to achieve this result.** Both items passed as
implemented; the mutations were temporary, reverted, and used only to prove the
tests are load-bearing.

---

## 8. Findings recorded (not silently weakened)

| # | Finding | Disposition |
|---|---|---|
| 1 | **A-09 privacy-preserving deviation** — `DELEGATION_UNKNOWN_GRANT` emitted where the spec row says `DELEGATION_CROSS_TENANT_REFUSED` | **UNCHANGED** — governed, documented deviation preserving tenant invisibility (no grant-existence oracle). Re-confirmed present at this SHA. Not relabelled. |
| 2 | **Delegation event `sessionEventId` absence** | **CONFIRMED IN SOURCE** — `delegation-store.ts` `delegationEventDoc()` emits `{id, at, tenantId, kind, principalId, resource, authority, decision, result, detail, correlationId?}` with **no `sessionEventId`**. `delegation-types.ts:229` declares it **optional** (`readonly sessionEventId?: string`), whereas `privilege-store.ts:154` makes it **mandatory fail-closed** for elevations. Real asymmetry between the privilege and delegation planes. **OPEN / NON-BLOCKING**; not patched (out of Phase A scope). |
| 3 | **"S-10 enforcement-denial audit semantics"** | **UNVERIFIED as a formal S4 finding** — this label appears in neither §10 (items 1–6) nor §13 (findings 1–7) of the canonical S4 report, nor anywhere else in the canonical tree. The **underlying behaviour** is now source-verified and documented at §4.4 (decide-path audit is fail-closed; enforce-path audit is best-effort by design). The behaviour is real; the *finding label* is not established. **No closure invented.** |
| 4 | **Platform-scope consumption ordering** | **UNCHANGED** — platform grant consumed in a system-scope transaction before Tx-1; fail-closed direction. Not relabelled. |
| 5 | **Exact-or-`*` target semantics** | **UNCHANGED** — glob re-narrowing not inferred; conservative fail-closed. Not relabelled. |
| 6 | **F1 service-elevation coverage** | **OPEN / NON-BLOCKING** — not exercised by this re-verification; no new evidence. Not relabelled. |
| 7 | **F2 service-seam session binding** | **OPEN / NON-BLOCKING** — as above. |
| 8 | **F3 `approvalRequired` enforcement** | **OPEN / NON-BLOCKING** — as above. |
| 9 | **F4 bootstrap operator / CLI gap** | **OPEN / NON-BLOCKING** — as above. |
| 10 | **F5 step-up re-verification** | **OPEN / NON-BLOCKING** — as above. |
| 11 | **F6 A-16/A-24 adversarial exercise** | **CLOSED** — §7 |

**Scope note:** this re-verification covered **F6 only**. F1–F5 were **not**
re-examined and retain their prior OPEN/NON-BLOCKING status; no evidence was
generated for them in this phase, and none is claimed.

---

## 9. Reproduction

```bash
# at canonical 2455c59e8462ca203e9d57788792acb32e5cdad9
npm install
npm run build
cd packages/authorization-boundary && npm run build
node --test --test-reporter=spec dist/test/p2-s4-delegation-decision.test.js
cd ../authentication && node --test dist/test/p2-s4-delegation-store.test.js
```

Expected: 23/23 and 22/22, **0 skipped**, real PostgreSQL.

---

*End of F6 re-verification. F6 = CLOSED. No source patched. All mutations
reverted and proven absent.*
