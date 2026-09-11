# JATA Qi — P2-S3 Step-Up Integration Readiness Audit

**READ-ONLY readiness analysis · no implementation, no commit, no push**

| Field | Value |
|---|---|
| Audited artifact | **pushed** PR #33 head `652cac38cba666a93261cfb142f383a98a365d53` |
| Canonical `main` | `2455c59e8462ca203e9d57788792acb32e5cdad9` (unchanged) |
| Local HEAD | `9fb50ae` — **contains an already-built integration, unpushed** |
| Working tree modified by this audit | **No** — 0 dirty files |
| Determination | **B — gap specified, with one non-blocking open question** |

---

## 1. Executive determination

**B.** The integration gap is fully specified and the minimal patch surface is
small and measured. But the audit found **one §6 invariant the already-built
implementation does not enforce** — assurance state after factor revocation
(§5.3) — which must be decided before implementation is authorized.

**Premise correction (material).** The directive states the gap is open and that
implementation is not yet authorized. Both were true of PR #33 head `652cac3`,
which is what this audit inspected. However **the integration was already
implemented in the previous turn** as commit `9fb50ae`, which is committed
locally and **not pushed** because GitHub credentials expired
(`gh auth status` → *token no longer valid*). So:

* On the **pushed** artifact the gap is **open** — verified below.
* On the **local** artifact the gap is **closed**, locally verified
  (13/13 integration tests, 1,544 full regression, 0 skipped, 0 cancelled), but
  **unpublished, with no CI run and no independent verification**.

This audit reports the pushed state as instructed and reconciles it against the
built patch rather than re-speculating a design.

---

## 2. Exact artifact inspected

`git show 652cac3:packages/authentication/src/privilege-store.ts`, plus
`privilege-types.ts`, `privileged-operations.ts`, `mfa.ts` at the same SHA. No
inference from documentation; every figure below is a grep count on the pushed
blob.

---

## 3. Current `grantElevation` execution path (at `652cac3`)

```
caller
  └─ grantElevation(input, now)                       privilege-store.ts:349
       ├─ assertValidGrant(input, now)                :350  (sync, :128)
       │    └─ step-up guard                          :164-176
       ├─ [scope=tenant] inTenant(...)                :363
       │    ├─ authority.assessInTx(grantorReq, now)  :364  ← AUTHORIZATION
       │    │    └─ verdict !== 'VALID' ⇒ PrivilegeRequiredError  :365-367
       │    └─ insertElevationInTx(scope, input, ...) :368  ← PERSISTENCE
       │         └─ buildElevation(input, now, id)    :178-196
       │              └─ spreads stepUpEventId/stepUpAt into the doc  :189-190
       │         └─ audit event, same transaction
       └─ [scope=platform] inSystem(...)              :371-376  (same shape)
```

**There is no verification step between validation and authorization.** Evidence
flows from caller input straight into the durable elevation document.

## 4. Current step-up evidence path — §3 checklist, measured

| Question | Answer (grep on the pushed blob) |
|---|---|
| Where is evidence received? | `input.stepUpAt`, `input.stepUpEventId` |
| Where is it typed? | `GrantElevationInput` (`privilege-types.ts:117-140`), both **optional** |
| Merely propagated? | **Yes** — `buildElevation:189-190` spreads both into the doc; `:56` lists them in the closed schema |
| Any existing verification? | Presence + `Number.isFinite` + `> now + 300_000` skew + `isNonBlank` — **that is all** (`:166-173`) |
| Freshness checked? | **No.** `stepUpMaxAgeMs`: **5 occurrences, 0 comparisons** |
| Assurance level checked? | **No.** `assurance`: **0 occurrences** in the file |
| Tenant checked? | **No** |
| Principal checked? | **No** |
| Session checked? | **No** |
| Claimed timestamp checked? | **No** |
| Assurance existence checked? | **No.** `stepUpEventId`: 6 occurrences, **0 lookups/resolutions** |
| Result consumed before elevation? | **N/A** — nothing to consume |

## 5. Exact security gap

**5.1 Self-assertion.** `stepUpEventId: 'anything'` with `stepUpAt: now`
satisfies the guard. The bootstrap path demonstrates the shape
(`:427-428`: `stepUpEventId: 'kernel:bootstrap', stepUpAt: now`).

**5.2 No freshness.** `stepUpMaxAgeMs` is declared on every register entry
(`privileged-operations.ts:99`, default `15 * 60_000`) and compared nowhere, so
month-old evidence is accepted.

**5.3 NEW FINDING — assurance outlives factor revocation.** This audit was asked
whether "factor/assurance state is valid" must hold. It currently does not:

* `MfaAssuranceDoc` fields: `id, tenantId, principalId, sessionId?, level,
  factorId, factorKind, satisfiedAt, correlationId` — **no status field**.
* `MfaFactorStore.revoke()`: **0** references to the assurance collection.
* `verifyStepUpEvidence()`: **0** factor-status checks.

So a factor revoked as compromised leaves its already-earned assurances
verifiable for the remainder of the freshness window — **up to 15 minutes**
(`DEFAULT_MFA_STEP_UP_MAX_AGE_MS`, `mfa.ts:340`; `DEFAULT_STEP_UP_MAX_AGE_MS`,
`privilege-types.ts:80`). Within that window a revoked factor's assurance can
still authorize a privilege elevation. The directive's own test list includes
*"revoked/invalid assurance → denied"*; **the built implementation would fail
that test.**

---

## 6. Security invariants required before elevation

| Invariant | Owner | Reason | Enforced by built patch? |
|---|---|---|---|
| Assurance record exists | S5 | an unresolvable id is not evidence | ✅ |
| Tenant matches | S5 | RLS + explicit filter; no cross-tenant spend | ✅ |
| Principal matches | S5 | the **grantor** must own the assurance | ✅ |
| Session matches | S5 | prevents transplant between sessions | ✅ |
| Level sufficient | S5 | ordered `MFA_ASSURANCE_RANK` | ✅ |
| Timestamp fresh | S5 | the check that never existed in S3 | ✅ |
| Claimed timestamp agrees | S5 | stops presenting old evidence as new | ✅ |
| Not from the future | S5 | clock-skew defence | ✅ |
| **Factor/assurance state valid** | **S5 (missing)** | a revoked factor must not keep authorizing | ❌ **§5.3** |
| Authorization policy still permits | **S3 authority plane** | unchanged, `assessInTx` | ✅ (untouched) |

No additional invariants are proposed beyond these.

## 7. Authorization boundary

| Concern | Owner | Evidence |
|---|---|---|
| Authentication | `identity-store.ts` / authenticators | unchanged |
| MFA / step-up **assurance** | S5 `mfa.ts` | produces and verifies assurance records |
| **Authorization** | privilege authority plane, `assessInTx` | `privilege-store.ts:364,372` — **3 call sites, untouched by the patch** |
| Privilege **elevation enforcement** | `privilege-store.ts` | consumes assurance, then delegates the decision |

What each does, stated explicitly:

* **S5 verifies**: that a durable assurance record exists, belongs to this
  tenant/principal/session, is fresh, is of sufficient level, and agrees with the
  claimed timestamp. It returns a record. **It decides nothing.**
* **S3 verifies**: grantor holds a valid security-admin elevation in scope, via
  `assessInTx`; role/class coverage; lifetime bounds; register membership.
* **The authorization plane decides**: whether the grantor may perform the grant.
* **`privilege-store` enforces**: ordering (assurance verified **before** any
  transaction), fail-closed refusal, and persistence.

`mfa.ts` exposes **0** `authorize`/`grant`/`decide`/`evaluatePolicy`/`assignRole`
methods, and the built patch adds none. No second authority is created.

## 8. Minimal patch surface (measured, not proposed)

Already built in `9fb50ae`; `git diff --stat 652cac3 9fb50ae`:

| File | Δ | Nature |
|---|---|---|
| `packages/authentication/src/privilege-store.ts` | **+122 / −11** | the only `src` change |
| `packages/authentication/test/p2-s5-stepup-integration.test.ts` | +306 (new) | 13 integration tests |
| `docs/verification/P2_S5_IMPLEMENTATION_REPORT.md` | +96 | documentation |

Symbols added: `StepUpEvidenceVerifier` (structural interface),
`PrivilegeStoreOptions`, `PrivilegeStore#verifyStepUpEvidence` (private);
`open(source, options?)` gains an optional second parameter; codes
`STEP_UP_UNVERIFIED`, `INVALID_OPTIONS`.

**`mfa.ts` is not touched** — so every verified S5 property is preserved by
construction (§11).

**Design decision that must be ratified:** assurance is verified against
`grantorPrincipalId` / `grantorSessionEventId`, **not** `principalId`.
`principalId` is the elevation's *target*; step-up is required to *perform* the
act. Verifying against the target would let a caller authorize their own action
with somebody else's assurance.

**Backward compatibility:** with no verifier configured and `strictStepUp` off,
behaviour is byte-for-byte pre-S5. `strictStepUp` is the fail-closed switch.
Residual: `authentication-module` wiring does not enable it by default, so an
operator can still construct an unverified plane — the same vacuity shape as
P2-INV-08.

## 9. Required tests

The 12 mandated cases map onto the 13 built tests:

| Mandated case | Covered |
|---|---|
| valid fresh assurance → proceeds if authorized | ✅ |
| nonexistent / forged `stepUpEventId` → denied | ✅ (both) |
| wrong tenant → denied | ✅ |
| wrong principal → denied | ✅ |
| wrong session → denied | ✅ |
| stale assurance → denied | ✅ |
| timestamp mismatch → denied | ✅ (via wrong-session/mismatch assertions) |
| insufficient level → denied | ✅ in the S5 suite (`p2-s5-mfa.test.ts`) |
| authorization denied despite valid MFA → denied | ✅ (rogue grantor, isolated on the unverified plane) |
| target's assurance cannot authorize the grantor | ✅ (added beyond the mandate) |
| operator-class unaffected (spec §9.3) | ✅ |
| **revoked/invalid assurance → denied** | ❌ **NOT COVERED — §5.3** |

Concurrency and replay are covered in the S5 suite (3 rounds × 12 racers, atomic
`cas` claim); cross-tenant and cross-principal attempts are covered in both
suites.

## 10. Mutation-testing plan

Two mutants, both on the enforcement call:

* **M-S3-1** — delete `await this.#verifyStepUpEvidence(input, now);` from
  `grantElevation`. Must be killed by the self-asserted-evidence, wrong-tenant,
  wrong-principal, wrong-session, stale and forged-id tests.
* **M-S3-2** — make `#verifyStepUpEvidence` return immediately. Must be killed by
  the same set.

Both must run against the **real** suite (source mutated, compiled to a scratch
outDir, real target suite required to fail), reusing the S7 mutation harness —
including its two fixes: strip `NODE_TEST_CONTEXT` so a nested `node --test`
cannot exit 0 while failing, and treat a run with cancellations as
**INCONCLUSIVE**, never as "survived".

## 11. Vacuous-test analysis

| Failure mode | Defence in the built tests |
|---|---|
| Verifier never called | The self-asserted test asserts `STEP_UP_UNVERIFIED`; without the call the grant **succeeds** and the test fails |
| Evidence never persisted | The positive test asserts `elevation.status === 'ACTIVE'` **and** `elevation.stepUpEventId === assurance.assuranceId` — a real durable document |
| Authorization path bypassed | The rogue-grantor test runs on the plane **without** a verifier, so the refusal cannot come from the assurance check |
| Privilege never attempted | Tests call `grantElevation` directly and assert on the returned document |
| Assertion checks only metadata | The positive test reads the persisted elevation; the refusals assert the error **code**, not a message substring |
| Silent PG skip | `assert.ok(pg, …)` — fail-hard, no skip path |

The strongest evidence these are not vacuous: during development four of them
**failed for real reasons** (wrong principal semantics, `SESSION_MISMATCH`,
`ROLE_CLASS_MISMATCH`, stale `now`) and were fixed rather than loosened.

## 12. S3 ownership determination

**The integration belongs to the S3 privilege plane, but it is an S5-authorized
requirement.** The two are not in conflict:

* The **file and the enforcement point** are S3's — `privilege-store.ts` is the
  P2-S3 privileged access plane, and the elevation decision boundary is its
  architectural responsibility. Nothing else can enforce it.
* The **requirement** comes from the S5 authorization §8: *"Privileged operations
  requiring stronger assurance must explicitly consume the MFA assurance
  signal."* S5 was obligated to make the signal consumable **and consumed**.

So the correct classification is: **S3 owns the boundary; S5 owned the
obligation.** Recording it as "S3 territory, not authorized" in the first S5
commit was a scope error, since §8 is S5's own text. It is **not** D — no
different milestone owns it.

## 13. Dependencies

**None.** Zero references to `break-glass`, `S6`, `S8`, `KMS`, `HSM`, `oidc` or
any external provider in the patch. No new authorization infrastructure (the
existing `assessInTx` is reused) and no new session infrastructure (the existing
`grantorSessionEventId` binding is reused).

## 14. Regression risks

| Risk | Assessment |
|---|---|
| Existing `grantElevation` callers break | **None observed.** Verified: full regression **1,544 · 0 fail · 0 skipped · 0 cancelled · 50/50**, and all 10 pre-existing S3/S4 call sites pass unchanged |
| Bootstrap path breaks | **No.** Bootstrap writes its own evidence internally and does not traverse `#verifyStepUpEvidence` |
| Operator-class grants regress | **No.** Guarded by the `cls !== 'operator'` condition and tested |
| Latency | One extra indexed read per step-up-requiring grant, before the transaction |
| Deadlock/contention | Verification runs **outside** the elevation transaction, so it cannot hold locks across it |

## 15. 95% score impact

**No score computed.** `NUMERICAL 95% SCORE` remains **NOT COMPUTABLE** (v1.0
numeric schedule UNRECOVERED). Potentially affected dimensions, identified only:

* **D02 Identity/access** — directly relevant; step-up enforcement is an access
  control.
* **D14 Testing/assurance** — relevant; mutation coverage of the enforcement
  call.
* **D11 Production infrastructure** — relevant only via the un-wired
  `strictStepUp` default.
* **D04 / D15** — no material relevance identified.

No improvement is claimed merely because the gap was identified.

## 16. Remaining S5 findings

1. **§5.3 — assurance outlives factor revocation** (NEW, HIGH). Not enforced; the
   mandated "revoked/invalid assurance → denied" test is absent.
2. Verifier must be **configured** to bite; `strictStepUp` is not enabled by
   default in module wiring (MEDIUM, P2-INV-08 shape).
3. No real KMS/HSM behind the TOTP secret (MEDIUM, disclosed).
4. Recovery-authorization policy is caller-supplied; adequacy unverified
   (MEDIUM, human-owned).
5. `9fb50ae` is **unpushed** — no CI, no independent verification (process).

## 17. Recommended implementation sequence

1. **Publish `9fb50ae` first** (requires GitHub reconnection). Do not stack
   further work on an unpublished commit — the last two sandbox re-clones each
   destroyed unpushed work.
2. **Close §5.3**: add a status to `MfaAssuranceDoc` (or check factor status
   inside `verifyStepUpEvidence`) so revoking a factor invalidates its
   outstanding assurances. Prefer checking factor status at verification time —
   it needs no migration of existing assurance rows.
3. Add the "revoked assurance → denied" test **before** the fix, so the test is
   seen to fail first.
4. Add mutation mutants M-S3-1 and M-S3-2.
5. Decide the `strictStepUp` default, ideally as a posture invariant so the
   unverified plane cannot be constructed in production.
6. Full regression, lint, scan, push, CI, independent verification.

## 18. Explicit non-authorizations

This audit did **not**: modify `privilege-store.ts` or any source · modify tests
· implement the integration · commit · push · open or modify a PR · merge PR #33
· change branch protection or rulesets · start S6 or S8 · deploy · integrate
KMS/HSM · alter the authorization architecture · compute a 95% score.

Working tree at completion: **0 modified files**, `HEAD = 9fb50ae` (unchanged by
this audit). This report exists only as an uncommitted workspace file.
