# JATA Qi — P2-S5 §8 + §5.3 Security Closure Report

| Field | Value |
|---|---|
| Canonical `main` | `2455c59e8462ca203e9d57788792acb32e5cdad9` (unchanged) |
| Phase A head published | **`9fb50ae99f0376a97d3ab8cb3201efefe5c54b27`** |
| Phase B head published | **`d973cbb3b761ab0698f0519d79b50cb9faf5fbe2`** |
| Phase C head | **this commit** (strictStepUp secure-by-default, child of `d973cbb`) |
| PR #33 | `open`, **`merged = false`**, head `d973cbb`, `mergeable_state` clean after CI |
| Pushes | `652cac3..9fb50ae` then `9fb50ae..d973cbb` — both **fast-forward**, no force/rewrite |
| Determination | **B — implemented with non-blocking findings** |
| Merge status | **NOT MERGED — awaiting separate explicit human authorization** |

---

## A. `9fb50ae` publication evidence

Pre-flight, all six checks measured before pushing:

| Check | Result |
|---|---|
| Authenticated session | `✓ Logged in to github.com as arena-ai-coding-agent[bot]` |
| Remote PR #33 head | `652cac3` |
| Local HEAD | `9fb50ae` |
| Ancestry | `git merge-base --is-ancestor 652cac3 9fb50ae` → **YES** |
| Working tree | 0 tracked modifications (one untracked report) |
| Push | `652cac3..9fb50ae` fast-forward; PR head confirmed **exactly** `9fb50ae` |

## B. CI evidence

| Head | Run | Job | Conclusion | Duration |
|---|---|---|---|---|
| `9fb50ae` | `34610374969` | `103299064799` | **success** | 14:28:58 → 14:37:38Z (8m40s) |
| `d973cbb` | `34614878448` | `103314186171` | **success** | 15:13:51 → 15:21:27Z (7m36s) |

All steps green on both, including `Test (all workspaces)`, `PostgreSQL
integration status`, and `Embedded-PostgreSQL readiness diagnostics`. Because
M1's P1C-OBS-01 work makes the CI detector `exit 1` on any `SKIP`, a green
`Test (all workspaces)` is itself evidence of zero skips. No CI from `652cac3`
or `e52f626` was used as evidence for either new head.

## C. Independent verification evidence

Read from the **published commit objects**, working tree unmodified (`dirty=0`).

**Phase A (`9fb50ae`)** — order of operations in `grantElevation`:

```
:463  assertValidGrant(input, now)
:464  await this.#verifyStepUpEvidence(input, now)   ← BEFORE any transaction
:478  inTenant(...) → assessInTx(grantorRequirement) ← authorization
:482  insertElevationInTx(...)                       ← persistence
```

Assurance is bound to `input.grantorPrincipalId` (:466) and
`input.grantorSessionEventId` (:328) — **not** the elevation target's
`principalId`, which appears only in `buildElevation` (:183) where it is the
document's own subject. `mfa.ts`: **0** vendor imports, **0**
`authorize`/`grant`/`decide`/`evaluatePolicy`/`assignRole` methods.

**Phase B (`d973cbb`)** — factor revocation reaches assurance consumption:
factor read at `mfa.ts:963`, status gate at `:972-973`, new code
`MFA_ASSURANCE_REVOKED` at `:137`, both collections read inside **one**
tenant-scoped transaction. `privilege-store.ts:464` still routes through
verification; grantor authority check intact at 3 sites; 0 vendor imports; 0
authorization methods. Only **4 files** changed — no unrelated files.

## D. Original §8 enforcement gap

At the previously published head `652cac3`, `privilege-store.ts` contained **0**
references to `verifyStepUpEvidence`, `StepUpEvidenceVerifier`, or
`STEP_UP_UNVERIFIED`. The guard checked only presence, finiteness, a 5-minute
future skew, and non-blankness. `stepUpMaxAgeMs`: **5 occurrences, 0
comparisons**. `stepUpEventId`: **6 occurrences, 0 lookups**. Evidence was
propagated straight into the durable document at `buildElevation:189-190`.

**Closed by `9fb50ae`.**

## E. §5.3 revoked-factor defect

`MfaAssuranceDoc` has no status field; `revoke()` had **0** references to the
assurance collection; `verifyStepUpEvidence()` performed **0** factor-status
checks. A factor revoked as compromised therefore left its earned assurances
verifiable for the rest of the freshness window — **up to 15 minutes**
(`mfa.ts:340`, `privilege-types.ts:80`) — during which it could still authorize a
privilege elevation.

**Closed by `d973cbb`.**

## F. Failing-test evidence

Written **before** the fix, as required:

```
not ok 13 - §5.3 a REVOKED factor invalidates its previously-earned assurance
  error: 'Missing expected rejection: a factor revoked as compromised must NOT
          keep authorizing elevations with its old assurance'
not ok 14 - §5.3 a REPLACED factor invalidates its previously-earned assurance
```

`Missing expected rejection` means the elevation was **granted**. Both tests use
the real S5 factor/revocation path — no mocks, no synthetic status mechanism, and
the assertion was not weakened to make it pass.

## G. Implementation

`verifyStepUpEvidence()` now resolves the factor document **alongside** the
assurance, inside the same tenant-scoped transaction, and refuses unless the
factor is still `ACTIVE`. New closed code `MFA_ASSURANCE_REVOKED`, raised only
**after** tenant and principal binding are proven — so it is not an identifier
oracle, consistent with S7's `SECRET_REVOKED`. No assurance rows were migrated.

## H. Factor-status authority

The authoritative lifecycle is the existing `MfaFactorDoc.status` in
`identity.mfa-factor`: `PENDING | ACTIVE | REVOKED | REPLACED`. There is **no**
separate `compromised`, `disabled`, or `expired` state, so **none was invented** —
a compromised factor is `REVOKED` under the existing lifecycle. No second factor
authority was created and no speculative migration was added.

## I. Grantor-vs-target security decision

`GrantElevationInput.principalId` is the elevation's **target**; the **grantor**
performs the privileged act. Step-up is verified against
`grantorPrincipalId`/`grantorSessionEventId`. Verifying against the target would
let a caller authorize their own action with somebody else's assurance. A test
proves the target's own genuine assurance **cannot** spend itself on a grant the
target does not perform.

## J. Mutation results

| Mutant | Change | Result |
|---|---|---|
| **M-S3-1** | remove `await this.#verifyStepUpEvidence(input, now)` | **KILLED** |
| **M-S3-2** | bypass the factor-status check | **KILLED** |
| **M-S3-3** | build the module's plane as `PrivilegeStore.open(storage)` — no verifier, no strict mode (the pre-fix composition) | **KILLED** |

All three live in the existing S7 harness, which required registering `mfa.ts`,
`privilege-store.ts` and `authentication-module.ts` in its pristine-capture list
(`PRISTINE.size` 2 -> 4 -> 5); without that the harness **refused to run them**
rather than silently passing. The harness also asserts each mutation anchor
matches **exactly once** in its target file, so a mutant cannot pass vacuously
after source drift. Mutation suite now **15/15 killed**, and it asserts
byte-for-byte restore — verified: 0 `MUTANT` markers remain, no `.mutation`
scratch dir.

## K. Adversarial results — 17/17 integration tests

active factor + valid assurance -> granted · **revoked factor + prior assurance
-> DENIED** · **replaced factor + prior assurance -> DENIED** · self-asserted id
-> DENIED · forged id -> DENIED · stale -> DENIED · wrong tenant -> DENIED ·
wrong principal -> DENIED · wrong session -> DENIED · target's assurance cannot
authorize the grantor -> DENIED · rogue grantor refused by the **authority**
check · operator class unaffected (§9.3) · unverified path unchanged · invalid
verifier refused at open · **module-wired plane denies self-asserted evidence** ·
**module-wired plane with NO assurance provider fails closed** · `MfaError` never
leaks through the plane.

The last two boot the **real** `AuthenticationModule` through a real kernel over
real PostgreSQL and assert against the plane the module actually hands out — not
a plane the test constructed itself.

Not added: a `compromised`-state case, because no such state exists in the
architecture (§8 forbids inventing one to raise the count).

## L. Full regression

| Check | Result |
|---|---|
| Build | exit 0, 50 workspaces, 0 `error TS` |
| Full test | **1,551 · 0 fail · 0 skipped · 0 cancelled · 50/50** (was 1,548) |
| Authentication workspace | **311 · 0 fail · 0 skipped · 0 cancelled** |
| S5 suite | 27/27 |
| Step-up suite | 17/17 |
| Mutation suite | 15/15 |
| Lint | 0 errors / **60** warnings (baseline) |
| `scan:r2` | PASS, 0 findings (artifact restored) |

The count moved by exactly the three tests this change adds (+2 module-wired
cases, +1 mutant), and no test failed, so there was nothing to triage.

## M. S3/S4 regression

**None.** All pre-existing privilege tests pass unchanged; the change is additive
and the unverified path is byte-for-byte pre-S5 behaviour. The one behavioural
change for existing callers is that the **module** now builds its plane strict —
a composition that grants step-up-requiring elevations must supply real
assurance, which is the intended security posture, not a regression.

## N. Remaining S5 findings

| # | Finding | Severity |
|---|---|---|
| 1 | ~~`strictStepUp` not enabled by default in `authentication-module` wiring~~ — **CLOSED by this commit**: the only production construction passes `strictStepUp: true` unconditionally and supplies the real `MfaFactorStore` as verifier | ~~MEDIUM~~ **CLOSED** |
| 2 | No real KMS/HSM behind the TOTP secret; `kind:'external'` is a declaration | MEDIUM (disclosed) |
| 3 | Recovery-authorization policy is caller-supplied; adequacy unverified | MEDIUM (human-owned) |
| 4 | TOTP does not resist real-time phishing proxies | INFORMATIONAL (inherent) |
| 5 | Rate-limit bounds untested against production traffic | LOW |

Findings 2-5 are **not** code defects in the S5 scope: 2 and 3 are architecture
decisions reserved to humans, 4 is an inherent property of TOTP, 5 requires
production traffic. **No S5 implementation defect remains open.**

### N.1 `strictStepUp` closure evidence

- `grep -rn "PrivilegeStore.open(" packages/*/src/` -> **exactly one** hit,
  `authentication-module.ts:179`, and it passes `strictStepUp: true` **outside**
  any conditional. There is no other production construction path to weaken.
- The verifier is supplied only when `credentialMaterial` is configured; when it
  is absent the plane has **no** verifier, and strict mode makes that a refusal
  rather than a silent accept — proven by the second module-wired test.
- Failing test written **first**, against the unfixed module:

```
not ok 15 - the module-wired production plane enforces step-up verification by default
  error: 'Missing expected rejection: the production composition must verify
          step-up assurance, not accept it on assertion'
```

  `Missing expected rejection` means the elevation was **granted** on
  self-asserted evidence through the real production composition.
- M-S3-3 reverts the wiring and the suite fails again, so the enforcement is
  load-bearing rather than decorative.
- The library-level default of `PrivilegeStore.open(source)` is **unchanged**
  (still permissive) so no existing direct caller or test silently changed
  behaviour; the security guarantee is placed at the production composition
  boundary, which is where the module owns the decision.

## O. 95% target implications

**No score computed.** `NUMERICAL 95% SCORE = NOT COMPUTABLE` (v1.0 numeric
schedule UNRECOVERED). Dimensions potentially affected, identified only: **D02**
Identity/access (directly), **D14** Testing/assurance (mutation coverage of the
enforcement call and of the production wiring), **D11** Production
infrastructure. No improvement is claimed for identifying or closing the gap.

## P. Merge readiness

**VERIFIED — READY FOR EXPLICIT HUMAN MERGE AUTHORIZATION.**

§8 published and verified · §5.3 failing test demonstrated the defect · §5.3
implementation published · `strictStepUp` closure demonstrated by a failing test
then closed · mutation tests pass · revoked-assurance and self-asserted-evidence
attacks both denied through the real module plane · S3/S4 green.

PR #33 additionally carries Phase A, M1, S7 and the evidence audit — so a merge
decision covers all of it. **Not merged. No auto-merge, no squash, no rebase.**

## Q. Explicit non-authorizations

Did **not**: merge PR #33 · enable auto-merge · deploy · start S6/S8/P3/P4 or
PAY-01 · integrate KMS/HSM or OIDC/SAML · modify the three non-overlapping
PostgreSQL port allocators · rewrite or amend `9fb50ae`/`d973cbb` · force-push ·
perform speculative hardening · claim 95% or production readiness.

The `strictStepUp` default **was** changed by this commit — that is the closure
itself, not a non-authorization.
