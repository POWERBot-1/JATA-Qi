# JATA Qi — P2-S5 MFA Implementation & Verification Report

**Authorization: IMPLEMENT S5 ONLY · merge NOT authorized · S6/S8/P3/P4 NOT authorized**

| Field | Value |
|---|---|
| Canonical `main` | `2455c59e8462ca203e9d57788792acb32e5cdad9` (unchanged) |
| Stacked on | `09b8ee0` (PR #33 head before S5) |
| New code | `packages/authentication/src/mfa.ts` (1 file), exports in `index.ts` |
| New tests | `packages/authentication/test/p2-s5-mfa.test.ts` — **27 tests, real PostgreSQL** |
| Regression | **1,531 · 0 fail · 0 skipped · 0 cancelled · 50/50** (was 1,504; +27) |
| Build / lint / scan | exit 0 · 0 errors / **60** warnings (baseline unchanged) · `scan:r2` PASS, 0 findings |
| Determination | **B — implemented with non-blocking findings** |

---

## 1. Executive determination

**B.** S5 is implemented, tested against real PostgreSQL, and green across the
full suite. Two **real security bugs were found in S5's own first draft by its
own tests** and fixed before commit (§7) — both would have shipped a control
that looked enforced and was not. That is the reason for B rather than A,
together with the scope limits in §12.

**No merge. No S6/S8/P3/P4. No deployment.**

---

## 2. Pre-implementation gap audit (source evidence, not prior reports)

Measured by grepping the pushed tree, not by reading previous reports.

| Capability area | Status | Evidence |
|---|---|---|
| Any MFA/TOTP/OTP code | **MISSING** | `git grep -li` for `totp\|mfa\|multifactor\|secondFactor\|otp\|recoveryCode\|backupCode` across `packages/*/src` → **0 files** |
| Any assurance concept | **MISSING** | `assurance\|assuranceLevel` → 0 files |
| Step-up **contract** | **PARTIAL** | `PrivilegedOperationEntry.stepUpRequired` / `stepUpMaxAgeMs` (`privileged-operations.ts:34,99`); `DEFAULT_STEP_UP_MAX_AGE_MS = 15*60_000` (`privilege-types.ts:80`) |
| Step-up **enforcement** | **UNSAFE** | `privilege-store.ts:166-173` checks only presence + finite + not-future-beyond-5min + non-blank |
| `stepUpMaxAgeMs` freshness | **UNSAFE** | appears at `privilege-store.ts:332,358,474,528,554` — **type and register positions only; used in no comparison anywhere** |
| `stepUpEventId` verification | **UNSAFE** | never resolved against any event store; only propagated (`delegation-store.ts:351`) and typed |
| Rate limiting | **MISSING** | `ratelimit\|throttle\|maxAttempts\|backoff` across `packages/*/src` → **0 files** |
| TOTP secret storage | **IMPLEMENTED (unused)** | S7 `SecretPurpose` already includes `'totp'` (`secret-material.ts:64`) with **zero consumers** |
| Identity/session/audit substrate | **IMPLEMENTED** | `identity-store.ts` 59 KB, `session-tokens.ts`, `authentication-event-store.ts` 37 KB, RLS-scoped storage |
| `CredentialMaterialProvider` | **IMPLEMENTED** | `credential-store.ts:185`; `kind` is a **declaration** the platform cannot verify |
| Break-glass (S6) | **MISSING** | not implemented; not authorized here |

### The central finding

`privilege-store.grantElevation` **required** step-up evidence but the guard was
satisfiable by self-assertion:

```
if (typeof input.stepUpAt !== 'number' || !Number.isFinite(input.stepUpAt)) throw STEP_UP_REQUIRED
if (input.stepUpAt > now + 300_000) throw STEP_UP_FUTURE
if (!isNonBlank(input.stepUpEventId)) throw STEP_UP_REQUIRED
```

Nothing checked that `stepUpEventId` referred to a real event, and nothing
compared elapsed time against the declared `stepUpMaxAgeMs`. The bootstrap path
demonstrates the shape: `stepUpEventId: 'kernel:bootstrap', stepUpAt: now`
(`privilege-store.ts:427-428`). **The control looked enforced and was not.**

S5 closes this by producing durable, resolvable assurance records and exposing
`verifyStepUpEvidence()`, which enforces existence, tenant, principal, session,
level, claimed-timestamp agreement, and **freshness against the register's
declared `stepUpMaxAgeMs`**.

---

## 3. Architecture

`packages/authentication/src/mfa.ts` — one module, no new authorization engine.

* **Factor**: TOTP (RFC 6238) over `node:crypto` HMAC-SHA1, 30 s step, 6 digits,
  ±1 window, 20-byte secret. No vendor dependency, no network dependency.
* **Secret**: sealed through the S7 `SecretMaterialStore` with `purpose:'totp'`
  (the purpose S7 reserved and nothing consumed). Never plaintext at rest; the
  sealing context binds tenant+principal+purpose+secretId as GCM AAD.
* **Collections**: `identity.mfa-factor`, `identity.mfa-assurance`,
  `identity.mfa-event`, `identity.mfa-throttle` — all written inside RLS-scoped
  transactions; a non-transactional source is refused, never degraded.
* **API**: `enroll`, `activate`, `verify`, `revoke`, `replace`, `recover`,
  `verifyStepUpEvidence`, `listFactors`, `hasActiveFactor`.

**MFA VERIFICATION IS NOT AUTHORIZATION.** The chain
`identity → authentication → MFA assurance → authorization → capability` is
respected: S5 produces the assurance link only and hands it to the existing
plane. `verify` returns `{assuranceId, level, satisfiedAt, factorId}` — no
permission, role, or grant — and a test asserts the result shape and that the
class exposes no `authorize`/`grant`/`decide`/`evaluatePolicy`/`assignRole`.

---

## 4. Threat model and what S5 does **not** claim

**TOTP does not solve account takeover.** It raises the cost of a
credential-only compromise. It does **not** resist a real-time phishing proxy and
is not a possession proof in the FIDO2 sense. This is stated rather than
implied.

In scope: credential-only compromise, code replay inside the window, factor swap
by an attacker holding only a password, recovery-based takeover, cross-tenant and
cross-principal factor access, brute-force code guessing, assurance transplant
across sessions, stale assurance reuse.

Out of scope: phishing proxy, device malware, SIM/SMS attacks (no SMS factor
exists), and anything requiring a real KMS/HSM.

---

## 5. Security properties and how each is proven

| Property | Mechanism | Test |
|---|---|---|
| TOTP is standards-correct | RFC 6238 implementation | **5 RFC 6238 App. B vectors** (T=59, 1111111109, 1111111111, 1234567890, 2000000000) |
| Window is ±1 and no wider | `totpVerifyStep` | accepts current and previous step, rejects 2 back |
| Malformed input rejected | regex + length gate | `''`, `'12345'`, `'1234567'`, `'abcdef'`, `'  '`, `'12 34 56'` |
| Enrollment confirms possession | `activate` requires a valid code | wrong code ⇒ `MFA_CODE_INVALID`, factor stays `PENDING` |
| PENDING cannot verify | status gate | `MFA_NOT_ACTIVE` |
| No silent factor swap | one ACTIVE/PENDING per principal | second enroll ⇒ `MFA_ALREADY_ENROLLED` |
| **Replay resistance** | atomic `cas` claim per (tenant, principal, factor, step) | 3 rounds × 12 racers ⇒ **exactly 1 winner**, 11 refusals, exactly 1 durable assurance |
| **Tenant isolation** | RLS + explicit filter | other tenant sees **0 rows**; verify ⇒ `MFA_UNKNOWN` |
| **Principal isolation / no oracle** | binding check before status | wrong principal with the **correct code** and a nonexistent factor id both ⇒ `MFA_UNKNOWN` |
| Forged actor refused | required non-blank `actorPrincipalId` | `MFA_INVALID_ARGUMENT` |
| **Self-asserted step-up refused** | `verifyStepUpEvidence` resolves a real record | `assuranceId:'kernel:bootstrap'` ⇒ `MFA_ASSURANCE_UNKNOWN` |
| **Freshness enforced** | `now - satisfiedAt > maxAgeMs` | `maxAgeMs:1` ⇒ `MFA_ASSURANCE_EXPIRED` |
| No assurance transplant | session + principal + tenant + claimed-timestamp agreement | 4 distinct refusals (`MISMATCH` / `UNKNOWN`) |
| Level ordering | `MFA_ASSURANCE_RANK` | `multi-factor` cannot satisfy `step-up` |
| Brute-force throttle | durable per-(tenant,principal,operation) counter | engages within budget; lockout has a **finite expiry** (no permanent DoS) |
| Revocation terminal | status + S7 secret revoke | revoked factor cannot verify |
| Replacement is step-up | requires a successful verify of the existing factor | wrong code refused; correct code succeeds |
| **Recovery cannot bypass MFA** | yields `PENDING` only | `hasActiveFactor === false` after recovery |
| Audit vocabulary | 17 event kinds | enrollment/activation events present; every row carries actor, tenant, principal, correlation, timestamp |
| **Secret non-disclosure** | identifier-only records and errors | no base32 or hex secret in any audit row, factor row, or error message; no tenant in error messages |

---

## 6. Recovery

Recovery is the weakest path in any MFA system and the classic takeover vector.
It is deliberately **not weaker than the mechanism it replaces**, by three
enforced properties:

1. It requires an explicitly supplied recovery-authorization token, validated by
   a caller-supplied predicate. S5 does **not** invent or judge that policy — it
   refuses without a valid token.
2. It is throttled on its own counter, independent of `verify`.
3. It yields only a **PENDING** factor. Recovery alone grants **no assurance**:
   until the replacement is activated with a real code the principal has no MFA
   and cannot satisfy any step-up requirement.

Tested: wrong token ⇒ `MFA_RECOVERY_NOT_ELIGIBLE` and the old factor **survives**;
valid token ⇒ old factor `REVOKED`, replacement `PENDING`, `hasActiveFactor` false.

---

## 7. Two real bugs found in S5's own first draft

Both were caught by S5's tests, both were security-relevant, and both would have
shipped a control that looked enforced and was not.

**BUG 1 — the throttle never engaged (rollback trap).**
The failure counter was incremented *inside* the transaction that then threw the
refusal. A throw aborts the transaction, so the increment was rolled back and the
counter never accumulated. Symptom: the throttle test failed with "the throttle
engages within the configured budget → false". Fix: record failures in their
**own committed transaction** (`#noteFailureCommitted`) after the aborting one.
This is the same class as the S7 finding that refusal audits inside a throwing
transaction are rolled back.

**BUG 2 — replay resistance was defeated under concurrency (TOCTOU).**
The consumed-step guard was `get()` then `put()`. Standalone it passed (1 winner
from 6 racers). Under full-suite load it let **5 of 6 racers consume the same
code**: every transaction observed "not consumed" before any of them wrote.
Fix: claim the step with the driver's atomic `cas(id, current => current ===
undefined, …)`, which takes a per-document lock. Test strengthened to 3 rounds ×
12 racers and to assert the durable assurance count, not just the return values.

**A test defect found at the same time:** my RFC expectation for T=1111111109 was
`081840`; the RFC 6238 Appendix B value is `07081804` → `081804`. I verified all
five vectors against the RFC table rather than adjusting the test to match the
code — the implementation was right and the expectation was my transcription
error (transposed final digits).

**Also noted, not a defect:** under row-lock contention a losing racer may
surface a serialization failure instead of reaching the replay branch. The test
therefore asserts the *invariant* (exactly one winner; every loser refused with a
fail-closed `MFA_*` code; exactly one durable assurance) rather than pinning the
losers' specific code, which would assert an implementation detail.

---

## 8. Test inventory

27 tests in `p2-s5-mfa.test.ts`, all against **real embedded PostgreSQL**,
fail-hard (no skip path). Categories: TOTP correctness (4), enrollment and
activation (4), verification/replay/concurrency (3), tenant and principal
isolation (3), step-up evidence including the gap fix (5), rate limiting (1),
lifecycle revoke/replace/recover (3), audit and non-disclosure (3),
assurance-not-authorization (1).

**Vacuity guard:** each security assertion asserts a **refusal**, not merely a
happy path. The two bugs in §7 are the evidence this is not decorative — both
were caught by assertions that would have passed had the test been vacuous.

---

## 9. Evidence classification

| Claim | Class |
|---|---|
| TOTP implements RFC 6238 | **TESTED** (RFC vectors) |
| Tenant isolation | **TESTED** against real RLS |
| Replay resistance under concurrency | **TESTED** (36 racers across 3 rounds) |
| Step-up freshness enforced | **TESTED** |
| `privilege-store` now *calls* `verifyStepUpEvidence` | **NOT DONE — DOCUMENTED ONLY.** S5 exposes the verification; wiring the existing plane to call it is a change to `privilege-store.ts`, which is P2-S3 territory and was **not** authorized here. The gap is therefore *closable* but **not yet closed in the plane**. |
| Real KMS/HSM protection of the TOTP secret | **EXTERNAL DEPENDENCY.** Only a test seam exists; `kind:'external'` is a declaration, not proof. |
| Recovery-authorization policy | **HUMAN-OWNED / EXTERNAL.** The caller supplies the validator; S5 refuses without one but does not judge sufficiency. |
| Rate-limit policy adequacy | **UNVERIFIED.** Bounds are configurable; no production tuning evidence. |
| Production readiness / hardening / 95% | **NOT CLAIMED.** |

---

## 10. Verification results

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` | exit 0, 50 workspaces, 0 `error TS` |
| S5 suite | `node --test dist/test/p2-s5-mfa.test.js` | **27 / 0 fail / 0 skipped / 0 cancelled** |
| Full regression | `npm test` | **1,531 · 0 fail · 0 skipped · 0 cancelled · 50/50** |
| Lint | `npm run lint` | 0 errors / **60** warnings (baseline; a 61st from an unused test variable was removed) |
| Secret scan | `npm run scan:r2` | PASS, 0 findings (artifact restored) |

A cancelled or partial run is **INCONCLUSIVE**, not PASS. This run had
`# cancelled 0` and `Total: 50 · Passed: 50`.

---

## 11. Scope discipline

**Not touched:** `commercial-control-plane`, `human-approval`, `loop-host`
harnesses (zero measured overlap, explicitly not authorized for preventive
modification) · S6 break-glass · S8 · P3 · P4 · KMS/HSM integration ·
`privilege-store.ts` (see §9).

**One dependency discovered and reported rather than silently expanded:**
closing the step-up gap *end to end* requires `privilege-store.grantElevation` to
call `verifyStepUpEvidence` instead of trusting caller-supplied evidence. That is
a change to the P2-S3 privileged plane. **STOP-and-report applied**: S5 ships the
capability and the proof; wiring the plane is a separate authorization.

---

## 12. Remaining findings

| # | Finding | Severity |
|---|---|---|
| 1 | `privilege-store` still trusts caller-supplied step-up evidence; S5's `verifyStepUpEvidence` is available but **not yet called by the plane** | **HIGH** (pre-existing; now closable) |
| 2 | No real KMS/HSM behind the TOTP secret — test seam only | MEDIUM (disclosed) |
| 3 | Recovery-authorization policy is caller-supplied; adequacy unverified | MEDIUM (human-owned) |
| 4 | Rate-limit bounds are untested against production traffic | LOW |
| 5 | TOTP does not resist real-time phishing proxies | INFORMATIONAL (inherent) |

---

## 13. S6 prerequisites

S6 (break-glass) should: consume `verifyStepUpEvidence` for break-glass
activation rather than asserting assurance; use S7's `break-glass-seal` purpose
(already reserved, still unconsumed); inherit the recovery-is-step-up rule; and
not re-implement throttling.

---

## 14. 95% score impact

**No score computed or changed.** `NUMERICAL 95% SCORE = NOT COMPUTABLE`
(v1.0 numeric schedule UNRECOVERED). S5 adds implementation evidence for MFA but
no rubric unit is recomputed, and no renormalization is performed.

---

## 15. Explicit non-authorizations

S5 did **not**: merge PR #33 · deploy · start S6, S8, P3 or P4 · integrate a real
KMS/HSM · modify the three non-overlapping PostgreSQL harnesses · modify
`privilege-store.ts` · claim 95% · claim production readiness or security
completeness.

Merge authorization remains outstanding and is human-owned.
