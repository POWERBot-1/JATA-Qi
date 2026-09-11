# P2-S2 — Verification Report (EVIDENCE BACKFILL)

| Field | Value |
|---|---|
| Record type | **Backfilled** canonical verification record for milestone P2-S2 |
| Backfill authorization | Phase A — Evidence, Governance & Critical-Path Unlock (2026-09-11) |
| Milestone | P2-S2 — durable session/token lifecycle over S-8 |
| Specification | `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` §6, §24-S2, §11/13/15/17 |
| PR | **#30** |
| Implementation commit | `b46400a3` |
| Merge commit | `f68f329cb26fcdd0aee58b50ba8972f4e6c6e4f5` |
| Merged | 2026-09-10T14:24:09Z |
| Stated baseline | `4293e7299349e27a137f71aad2530a3c6d4c04fb` |
| Fresh verification SHA | `2455c59e8462ca203e9d57788792acb32e5cdad9` (2026-09-11) |

---

## 1. Why this record is a backfill

`docs/verification/P2_S4_VERIFICATION_REPORT.md` §8 identified the gap:

> *"**S2/S3 gap (identified)**: the S2 and S3 reports are absent from
> `docs/verification/` (their verification was recorded as PR-body attestation
> only). **Remediation follow-up**: backfill canonical
> `docs/verification/P2_S2_VERIFICATION_REPORT.md` and
> `docs/verification/P2_S3_VERIFICATION_REPORT.md` artifacts from the existing
> PR evidence."*

Verified absent before this phase: `ls docs/verification/ | grep P2_S` returned
only `P2_S1_VERIFICATION_REPORT.md` and `P2_S4_VERIFICATION_REPORT.md`.

**Honest limitation of a backfill.** The original milestone-time independent
verification report was never written to canonical source control. This record
therefore combines (a) the preserved PR-body attestation, (b) GitHub-side CI
metadata, and (c) **fresh verification performed now at canonical**. It does
**not** retroactively create a milestone-time independent verification that did
not occur. Historical results are preserved verbatim in §3 and are not restated
as current results.

---

## 2. Implementation summary (from PR #30, preserved)

Product changes in `packages/authentication/src`:

- **`session-tokens.ts`** (new): `SessionTokenService`
  (mint/verify/rotate/revoke/markExpired), `SessionTokenAuthenticator`, boundary
  `authenticateWithSessionToken` login, closed `SessionTokenError` codes,
  fail-closed `storeCall` wrapper (substrate failures surface as
  `AuthenticationStoreError`).
- **`authentication-event-store.ts`**: token binding, rotation CAS,
  `findSessionByFingerprint`, oldest-session policy support.
- **`principal-boundary` / `module` / `policy` / `types` / `token-registry` /
  `static-token-authenticator` / `index`**: `SESSION_TOKEN` method wiring end to
  end.
- Explicit non-goals asserted: no second session/security store; no new security
  authority; no ambient grants; no RLS bypass.

Source presence re-confirmed at canonical: `packages/authentication/src/session-tokens.ts` exists.

---

## 3. Historical evidence (PR-body attestation — PRESERVED, NOT RE-RUN AS HISTORICAL)

Evidence class: **PR-ATTESTATION**.

> Gates (local, pre-push): authentication **148/148**, authorization-boundary
> **142/142**, loop-host **176/176**, cli **124/124**, unified-loop **42/42** —
> 0 fail, 0 skip. eslint clean; secret-scan clean.
>
> Two pre-existing parallel-boot PG flakes observed once each
> (`p2-s1-identity-core`, R-01 two-process), both green on rerun, zero code-path
> overlap with this diff.

Declared test program:

| Suite | Claimed coverage |
|---|---|
| `p2-s2-session-tokens.test.ts` | 49 core lifecycle/adversarial tests |
| `p2-s2-session-fanout.test.ts` (+ worker) | 32-process mint/verify/rotate/revoke waves; cross-process single-winner rotation; revoke-then-verify |
| `p2-s2-session-outage.test.ts` | outage throws fail-closed; recovery resumes |
| `p2-s2-session-decision.test.ts` (authorization-boundary) | session-gated durable A-01 decisions incl. `SECURITY_STATE_UNAVAILABLE` under outage |
| `p2-s2-session-dispatch.test.ts` (loop-host) | A-04 dispatch re-validation (revoke/rotate/deprovision/expire) |

Explicitly **not claimed** at S2: MFA/TOTP, SAML, federation, ReBAC, elevation,
break-glass, KMS/HSM, agent auth, prompt-injection, sandbox, AI/RAG/cache, prod
deploy, G10/G19/R-9/P1C-OBS-01.

---

## 4. GitHub CI record — MATERIAL FINDING

| Artifact | CI result | Detail |
|---|---|---|
| PR head `b46400a3` (pre-merge) | **success** | `build · lint · test`, started 2026-09-10T14:11:42Z |
| **Merge commit `f68f329` on `main` (post-merge)** | **FAILURE** | run `34488819576`, job `102909902630`; started 14:24:15Z, completed 14:36:43Z |

Step-level breakdown of the failing job (recovered via the actions jobs API):

| Step | Conclusion |
|---|---|
| Set up job / Checkout / Set up Node.js / Install dependencies | success |
| Verify workspace/lockfile integrity | success |
| Build all workspaces | success |
| Lint | success |
| **Test (all workspaces)** | **failure** |
| PostgreSQL integration status | success |

**Job log availability:** `gh api …/actions/runs/102909902630/jobs` → **404 Not
Found**. The run's job detail is no longer retained, so the specific failing
workspace/test **cannot be attributed** from available artifacts.

### 4.1 Assessment

- The **PR itself was green**; the failure occurred on the **post-merge `push`
  run on `main`**. `main` was therefore in a failing state immediately after the
  S2 merge, and no gate prevented or flagged it.
- The signature — red at **"Test (all workspaces)"** with a green build and lint —
  is the **same class as G10**.
- The most probable cause, on the evidence available, is the **pre-existing
  parallel-boot embedded-PostgreSQL flake** that PR #30's own body disclosed
  (`p2-s1-identity-core`, R-01 two-process) and that is registered as
  **P1C-OBS-01**. The PR body records both as "green on rerun" with "zero
  code-path overlap with this diff."
- **This remains a probable-cause attribution, not a proven one.** The log is
  gone. It is recorded as **OPEN / UNATTRIBUTABLE-PROBABLE-FLAKE**, not as
  closed.

### 4.2 Governance implication

This is a **second concrete instance** (after G10) of the red-merge / red-main
condition that the Phase A governance hardening targets. Note precisely what the
proposed ruleset change would and would not have prevented:

| Control | Would it have prevented this? |
|---|---|
| `required_status_checks` on PR merge | **No** — the PR was green |
| `required_approving_review_count ≥ 1` | **No** — not a CI control |
| **P1C-OBS-01 harness bounded-retry remediation** | **Yes** — this is the actual fix for the flake class |

Stated plainly so the governance change is not over-credited: required checks
raise the floor for *merging*, but the **post-merge red on `main`** is fixed by
remediating the flake, not by the ruleset.

---

## 5. Fresh verification at canonical `2455c59` (2026-09-11)

Evidence class: **PRIMARY** (executed this session) — real PostgreSQL, fail-hard harness.

| Suite | Result |
|---|---|
| `p2-s2-session-tokens.test.js` | **49 pass / 0 fail / 0 skipped** |
| `p2-s2-session-fanout.test.js` (32-process) | **4 pass / 0 fail / 0 skipped** |
| `p2-s2-session-outage.test.js` | **3 pass / 0 fail / 0 skipped** |
| `p2-s2-session-decision.test.js` | covered by the full-suite run (see §6) |
| `p2-s2-session-dispatch.test.js` (loop-host) | covered by the full-suite run (see §6) |

---

## 6. Full-suite context at canonical

`npm test` at `2455c59` → **`Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0`**;
**1,411 tests, 0 skipped, 0 failed**. Build: all 51 workspaces pass. Lint: 0
errors. Secret scan: 0 findings.

The S2 session suites are included in that green aggregate, so the **current**
canonical state is green notwithstanding the historical post-merge failure.

---

## 7. Determination

| Item | Determination |
|---|---|
| S2 implementation | **IMPLEMENTED + PRESENT** at canonical (source re-confirmed) |
| S2 current functional state | **GREEN** — 49/49, 4/4, 3/3 fresh; full suite 1,411/1,411 |
| S2 milestone-time independent verification | **NEVER COMMITTED** — PR-ATTESTATION only. **Not upgradeable retroactively.** |
| S2 current evidence class | **PRIMARY** (fresh execution this phase) for the suites re-run; **VERIFICATION** for the aggregate |
| Post-merge CI failure on `f68f329` | **RECORDED — OPEN / UNATTRIBUTABLE (probable P1C-OBS-01 flake; log 404)** |
| Overstated closure | **None.** The red post-merge run is recorded rather than omitted. |

### 7.1 What is still missing (exact)

| # | Missing evidence | Implementation or verification? |
|---|---|---|
| 1 | The identity of the failing workspace/test in run `34488819576` | **Verification** — requires log retrieval from a retention-capable source; currently 404 |
| 2 | A milestone-time independent (separate-party) verification report for S2 | **Verification** — historically absent; cannot be reconstructed |
| 3 | P1C-OBS-01 harness bounded-retry remediation (would close the flake class) | **Implementation** (test-harness only) — separate authorization |

**Closure status: S2 is functionally verified green at canonical, with one
recorded OPEN unattributable historical CI failure. Not marked fully closed.**

---

*End of P2-S2 backfilled verification record. Historical results preserved
verbatim; fresh results separately labelled; the post-merge CI failure is
recorded, not concealed.*
