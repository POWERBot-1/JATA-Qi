# P3-B₀ PREREQUISITE SLICE S0a — INDEPENDENT VERIFICATION RECORD

| Field | Value |
|---|---|
| Document Class | **READ-ONLY, SEPARATE-PARTY INDEPENDENT VERIFICATION RECORD.** Evidence input only. Grants nothing. |
| Subject | P3-B₀ prerequisite slice **S0a** — OD-4 matcher correction (both sites) + R-17 conformance suite + T-16 grant-corpus re-evaluation report |
| Verified Commit (head) | `ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7` |
| Authorized Baseline | `6b61256c6115a02da2d3ad6ba42771831b550f81` (`main`) |
| Merge Base | `6b61256` — PR #40 carries exactly two commits: `503e67b`, `ab9914a` |
| Pull Request | PR **#40**, branch `arena/01a0b3c7-jata-qi` → `main` |
| Verifying Session | `arena/01a0b410-jata-qi` (branch of this record) |
| Verification Environment | Node **v22.22.3**, npm **10.9.8**, Linux sandbox, utc |
| Date (UTC) | 2026-09-18 |
| **FINAL DETERMINATION** | **NOT PASS — S0a evidence package. Blocked (see §10).** The S0a *code change itself* independently verifies as correct and regression-free; the mandatory conditions as a whole are **not** met. |

> **This record is an evidence input, not an authorization.** It authorizes nothing, merges nothing, and asserts no production readiness. No S0a implementation file was modified during verification. S0b, S0c, S1, S2, S3 remain unauthorized and unremediated. The frozen score is unchanged and was not recalculated.

---

## 1. INDEPENDENCE PROVENANCE (GATE: **ESTABLISHED — PASS**)

The gate was executed **first**, before any substantive verification, and it passed.

### 1.1 The four commits named by the authorization were not authored by this session

| Commit | Subject | Branch of origin | Author / Committer | Reachable from this session's branch? |
|---|---|---|---|---|
| `ab9914a` | feat(auth): S0a matcher correction at both sites + R-17 conformance suite + T-16 report | `arena/01a0b3c7-jata-qi` | `POWERBot-1 <256624909+POWERBot-1@users.noreply.github.com>` (body: `Co-authored-by: arena-agent`) | **No** |
| `503e67b` | docs(verification): independent verification of P3-B0 design record at 447ab3b (PASS) | `arena/01a0b3c7-jata-qi` | `POWERBot-1 <…>` | **No** |
| `447ab3b` | docs(design): P3-B0 bounded design-only record — OD-1..OD-7 dispositions, sequencing, gates | `arena/01a0b377-jata-qi` | `POWERBot-1 <…>` | **No** |
| `608a6ea` | docs(verification): correct evidence defects D-1..D-6 in P3-B assessment | `arena/01a0b2f3-jata-qi` | `arena-agent <arena-agent@users.noreply.github.com>` | **No** |

### 1.2 Structural evidence

```
this session branch      = arena/01a0b410-jata-qi   @ 6b61256 (zero commits of its own)
$ git log --format='%h %s' 6b61256..arena/01a0b410-jata-qi
(empty)

refs containing each named commit (git branch -r --contains):
  ab9914a  ->  origin/pr40                 (only)
  503e67b  ->  origin/pr40                 (only)
  447ab3b  ->  origin/sess-01a0b377        (only)
  608a6ea  ->  origin/pr39                 (only)
```

- `447ab3b` is **not** an ancestor of PR #40; it lives on the separate session branch `arena/01a0b377-jata-qi` and is referenced by PR #40 only as a subject document.
- This session's branch is at the authorized baseline `6b61256` and contains **no commit authored by this session**. Not one of the four named commits is reachable from it.
- No file under `docs/verification/P3_B0_DESIGN_INDEPENDENT_VERIFICATION.md`, no matcher source, and no T-16 artifact was authored, edited, or staged by this session prior to this record.
- All verification work was performed in **detached worktrees** (`/home/user/_verify/pr40` @ `origin/pr40`, `/home/user/_verify/base` @ `6b61256`) so that the repository under verification was never mutated.

**Gate result: genuine separate-party independence ESTABLISHED.** Verification proceeded.

---

## 2. SCOPE CONTAINED IN THE PR

Complete PR #40 diff against the authorized baseline:

```
A  docs/verification/P3_B0_DESIGN_INDEPENDENT_VERIFICATION.md       (+229 / -0)
A  docs/verification/T16_GRANT_CORPUS_REEVALUATION_REPORT.md        (+94  / -0)
M  packages/authentication/src/delegation-types.ts                  (+1   / -1)
M  packages/authorization-boundary/src/capability-manifests.ts      (+1   / -1)
A  packages/authorization-boundary/test/r17-matcher-conformance.test.ts  (+468 / -0)
A  scripts/t16-grant-corpus-eval.mjs                                (+102 / -0)
```

The two source modifications are **exactly one line each**; the removed line is the superseded version in both cases. Nothing else in either file changed.

| Scope check | Result |
|---|---|
| `.github/` changes | **NONE** |
| `package-lock.json` / `package.json` / `eslint.config.mjs` / `tsconfig*` / `.env*` | **NONE** |
| S0b (OD-7 `SecretPurpose` `'egress-provider'`) implemented | **NO** |
| S0c (OD-5 F-3 ceiling/replay slice) implemented | **NO** |
| S1/S2/S3 (egress plane, canonicalizer, adapter cutover, static ban) implemented | **NO** |
| Unrelated remediation or speculative hardening | **NONE** — the entire code delta is the two one-line matcher changes plus additive test/script/doc artifacts |

Every S0b/S0c/S1 marker present in the diff (`EgressContext`, `SecretPurpose`, `'egress-provider'`, `EgressAuditRecord`, `canonicalize`) occurs **only** inside the added design-verification document `docs/verification/P3_B0_DESIGN_INDEPENDENT_VERIFICATION.md`, i.e. as design prose, never as executable surface.

**Scope containment: PASS**, with one observation recorded at §9 (O-4).

---

## 3. MATCHER CORRECTION — INDEPENDENTLY VERIFIED

### 3.1 Completeness of the patch surface

A repo-wide search for every site that builds a glob from a `resourcePattern`:

```
$ grep -rn "split('\*')" --include=*.ts --include=*.mjs --include=*.js packages/ scripts/
packages/authentication/src/delegation-types.ts:397        <- product, updated
packages/authorization-boundary/src/capability-manifests.ts:279 <- product, updated
scripts/t16-grant-corpus-eval.mjs:12                       <- evaluation harness (inlined copy)
scripts/t16-grant-corpus-eval.mjs:27                       <- evaluation harness (inlined copy)
```

Exactly **two** product sites exist; **both** are updated. There is no third governed matcher left uncorrected.

### 3.2 Elected semantics — differential test against an independently written oracle

The verifier wrote a **dynamic-programming wildcard matcher** implementing the elected U-1 definition directly (`*` = zero or more characters, none of which is `/` or `.`). It is not derived from the implementation's regex-construction strategy, so agreement is non-trivial. It was then compared against **the real product code** (built `dist`, imported, not re-implemented).

```
vectors exercised (product, both sites): 1200
site divergences (targetMatches vs delegationTargetMatches): 0
product-vs-independent-oracle mismatches: 0
```

Representative vectors, executed against product code:

| Pattern | Resource | Product | Expected (elected U-1) |
|---|---|---|---|
| `doc/*` | `doc/1` | `true` | `true` |
| `doc/*` | `doc/1.json` | `false` | `false` |
| `doc/*` | `doc/sub/1` | `false` | `false` |
| `https://api.openai.com*` | `https://api.openai.com.evil.com/steal` | `false` | `false` |
| `*.openai.com` | `api.openai.com` | `true` | `true` |
| `*.openai.com` | `evil.api.openai.com` | `false` | `false` |
| `https://api.openai.com/v1/*` | `https://api.openai.com/v1/../../admin` | `false` | `false` |
| `tenants/*/files/*` | `tenants/acme/files/report` | `true` | `true` |
| `tenants/*/files/*` | `tenants/acme/sub/files/report` | `false` | `false` |
| `data+set/*` | `dataaaaset/item1` | `false` | `false` |

Undefined-resource matrix (both sites agree on every row): pattern `undefined` ⇒ `false`; pattern with no `resourcePattern` ⇒ `true` **iff** resource is `undefined`; `resourcePattern` defined but resource `undefined` ⇒ `false`; `resourcePattern: '*'` with resource `undefined` ⇒ `false`.

**Matcher correction, elected semantics, and no-bypass: PASS** for the boundary characters `/` and `.`. Regex-metacharacter escaping (`[.*+?^${}()|[\]\\]`) is unchanged and still effective (e.g. `a|b/*` does not act as alternation). One widening outside `/` and `.` is separately recorded as **VD-2**.

---

## 4. I-6 BYTE-IDENTICAL INVARIANT

### 4.1 The invariant holds at the verified head

Bodies extracted by brace matching and compared; then compared again after normalising only the declared function name and the parameter type annotation (the two tokens that must differ by construction).

```
sha256 raw   A (targetMatches)            : ca806b16430326f395382ce9ab93b39d1302ef99d0338454741bdff771c645f0
sha256 raw   B (delegationTargetMatches)  : 03f503cb7ac94692951b6722b881629f180ed9a6fe83e1a84c2b026eae189738
raw bodies identical                      : False
sha256 norm  A                            : ebe6f7c0ab4af4ea3c1e8b0f68491cae8463f4df6aed95f994d73963d579d46e
sha256 norm  B                            : ebe6f7c0ab4af4ea3c1e8b0f68491cae8463f4df6aed95f994d73963d579d46e
norm bodies identical                     : True
```

`diff` of the two signature-normalised bodies produces **no output**. The only differences are the declared name and `{ readonly system: string; readonly resourcePattern?: string } | undefined` vs `DelegationTargetScope | undefined`.

**I-6 as a present property of the head: PASS.**

### 4.2 Does the R-17 static guard actually enforce it? — Adversarial mutation testing

| # | Mutation applied to the two `src` files | Guard verdict | Correct? |
|---|---|---|---|
| M0 | none (control) | PASS | ✅ |
| M1 | single-site revert: `[^/.]*` → `.*` in **one** file only | **FAIL** | ✅ drift detected |
| M2 | **both** sites identically set to `[^/]*` (wrong semantics, bodies identical) | PASS | ✅ by design — identity guard, not a semantics guard |
| M3 | **both** sites identically reverted to `.*`, **then rebuilt**, full suite run | vector suite **FAILS** ("`Segment: * REJECTS slash /`… expected false, got true") | ✅ semantics are independently constrained |
| M4 | identical column-0 `}` injected into **both** bodies at the same offset, with genuinely **divergent** statements after it | **PASS** | ❌ **FALSE NEGATIVE** |

**VD-3 (material, medium-high).** The guard extracts bodies with the non-greedy regex

```js
new RegExp(`export function ${fnName}\\([^)]+\\): boolean \\{([\\s\\S]*?\\n\\})`)
```

which terminates at the **first line-initial `}`**. Injecting an identical column-0 `}` into both bodies causes both captures to truncate at the same point and report `captures EQUAL : True`; the suite then reports `# pass 2 / # fail 0` **while the two function bodies are materially different**. Reproduced verbatim.

Consequently the claim "R-17 *enforces* the I-6 byte-identity invariant" is **conditionally true**: the guard catches ordinary single-site drift and the *vector* assertions independently constrain semantics (M3), so protection is not nil — but the static guard alone is defeatable, and a divergent pair of bodies that both contain a line-initial `}` inside the function would pass it.

---

## 5. R-17 CONFORMANCE SUITE

Executed independently against the verified head:

```
$ node --test packages/authorization-boundary/dist/test/r17-matcher-conformance.test.js
# tests 2
# suites 1
# pass 2
# fail 0
```

Corpus inventory (counted from the committed source):

| Category | Vectors | Requirement |
|---|---|---|
| Exact match | 5 | ✅ |
| Undefined resource/pattern | 6 | ✅ |
| Segment wildcard | 9 | ✅ |
| T-04 suffix confusion | 5 | ✅ |
| T-05 host cross-label | 6 | ✅ |
| T-06 dot-segment / traversal | 5 | ✅ |
| Multi-wildcard | 7 | ✅ |
| Regex-metacharacter escaping | 7 | ✅ |
| **Total** | **50** | |
| Static source/body identity guard | 1 test | ✅ present (strength limited — VD-3) |

All eight mandated categories are present and every vector passes, with **zero** divergence between the two implementations. **Coverage limitation:** the corpus contains **zero** vectors exercising line terminators; that gap is what makes VD-2 undetectable by this suite.

**R-17 conformance: PASS on presence, execution and category coverage — with the enforcement-strength caveat (VD-3).**

---

## 6. T-16 RE-EVALUATION — INDEPENDENT RE-EXECUTION

### 6.1 The script was executed and its headline number reproduces

```
$ node scripts/t16-grant-corpus-eval.mjs
Total unique resource patterns found in repository: 24
Total unique test/code resources found: 67
Total re-evaluation verdict changes across cross-product: 88
```

The figure **88** does reproduce, and its directionality is as stated (88 × `OLD=true -> NEW=false`; zero `OLD=false -> NEW=true` **within the script's own corpus**).

### 6.2 What the corpus actually is — the 88 are self-referential

`scripts/t16-grant-corpus-eval.mjs` performs a **regex text scrape** of every `.ts`/`.js`/`.mjs`/`.md` file in the tree:

```js
const patternRegex = /resourcePattern\s*[:=]\s*["'`]?([^"'`,\s{}]+)["'`]?/g;
```

It then takes the **cross-product of every scraped pattern with every scraped resource**. Provenance of the 24 scraped patterns, traced to source files:

- **16 of 24 patterns exist ONLY in `packages/authorization-boundary/test/r17-matcher-conformance.test.ts`** — a file **added by this same PR**: `*`, `*/*`, `*.openai.com`, `api.*.openai.com`, `https://api.openai.com*`, `https://api.openai.com/v1/*`, `https://api.openai.com/v1/chat`, `tenants/*/files/*`, `doc/1`, `doc/*-item`, `doc/res-*`, `data+set/*`, `item(1)/*`, `matrix[0]/*`, `a|b/*`, `^prefix$/*`.
- A further 4 are **not patterns at all** but regex artifacts of the scrape: `==` (from `resourcePattern === undefined`), `entry.resourcePattern`, `target.resourcePattern` (property accesses), and `pat` (from the script itself, which is inside its own scan corpus).
- Only **4 genuine pre-existing wildcard patterns exist in the whole tree at the baseline**: `doc/*`, `res-*`, `task-*` (plus the non-pattern `==`/property-access artifacts).

Attribution of the 88 transitions by pattern:

| Transitions | Pattern | Origin |
|---|---|---|
| 46 | `*` | **R-17 test file only** |
| 19 | `*/*` | **R-17 test file only** |
| 7 | `https://api.openai.com*` | **R-17 test file only** |
| 4 | `*.openai.com` | **R-17 test file only** |
| 3 | `https://api.openai.com/v1/*` | **R-17 test file only** |
| 3 | `tenants/*/files/*` | **R-17 test file only** |
| 1 | `doc/res-*` | **R-17 test file only** |
| 1 | `api.*.openai.com` | **R-17 test file only** |
| 4 | `doc/*` | pre-existing, but matched only against resources introduced by the R-17 file |
| | **84 / 88 attributable to the PR's own new test file** | |

### 6.3 Two independent control experiments

| Control | Corpus | Result |
|---|---|---|
| **A — baseline tree** (`6b61256`) + the same script | 8 patterns × 28 resources | **0 verdict changes** |
| **B — PR tree minus the R-17 test file** | 8 patterns × 28 resources | **0 verdict changes** |

Both controls reproduce the pre-S0a corpus exactly and both yield **zero** transitions.

**Conclusion:** the entire "88" is an artifact of the slice's own newly added conformance vectors. The genuine pre-existing in-tree corpus changes **no** verdicts. The T-16 report presents these 88 as evidence of migration impact, but they measure the new test file against itself.

This also defeats the design-mandated method. Design record §4.4 requires: *(a) enumerate **deployed** grant patterns; (b) re-evaluate each under both semantics; (c) record every grant whose verdict changes; (d) obtain explicit owner acceptance per changed grant.* The delivered report (i) enumerates no deployed grants — none exist in-tree and none were obtained; (ii) substitutes a synthetic cross-product; (iii) records no grant; (iv) records no owner acceptance. The limitation is not disclosed anywhere in the report.

### 6.4 VD-2 — the report's "zero widening" claim is false

T-16 report §3.1 states: *"**`OLD=false -> NEW=true` (Unintended Expansion): 0 transitions** (zero widening)."*

**Refuted.** Executing the **real product code at both sites** on the verified head:

| Pattern | Resource | `targetMatches` | `delegationTargetMatches` | pre-S0a regex |
|---|---|---|---|---|
| `doc/*` | `"doc/a\nb"` | **true** | **true** | false |
| `doc/*` | `"doc/a\rb"` | **true** | **true** | false |
| `doc/*` | `"doc/a\u2028b"` | **true** | **true** | false |
| `doc/*` | `"doc/a\u2029b"` | **true** | **true** | false |
| `doc/*` | `"doc/a\tb"` | true | true | true |
| `doc/*` | `"doc/a b"` | true | true | true |

A 1200-vector differential search yields **16 reproducible `OLD=false → NEW=true` widenings**, every one of them a line-terminator case (`\n`, `\r`, `\u2028`, `\u2029`). Mechanism: in JavaScript a bare `.` does **not** match line terminators, whereas the negated class `[^/.]` **does**.

Assessment: the elected U-1 wording ("`*` matches zero or more characters excluding `/` and `.`") is satisfied **literally** by the implementation — `\n` is a character that is neither `/` nor `.` — so this is a widening **inherent to the elected semantics**, not a coding error, and it does not re-open T-04/T-05/T-06. But the report's affirmative zero-widening claim is **false**, the widening is **undisclosed**, and the R-17 corpus contains **no** vector that could detect it. For a governed matcher whose whole purpose is to be fail-closed, an undisclosed expansion of the accepted language is a conclusion-altering defect in the evidence package.

---

## 7. REGRESSION TESTING — EXECUTED, BASELINE-COMPARED

Both trees were fully built (`npm ci` + `npm run build` for all workspaces) and the five scoped packages were executed in both. **Both columns are reproduced execution evidence by this verifier**, not reported claims.

| Package | Baseline `6b61256` | Verified head `ab9914a` | Delta |
|---|---|---|---|
| `@jataqi/authorization-boundary` | 186 tests / 32 suites — pass 186, fail 0 | **188 / 33 — pass 188, fail 0** | **+2 tests, +1 suite (= R-17)** |
| `@jataqi/authentication` | 365 / 39 — pass 365, fail 0 | **365 / 39 — pass 365, fail 0** | 0 |
| `@jataqi/agent-runtime` | 80 / 14 — pass 80, fail 0 | **80 / 14 — pass 80, fail 0** | 0 |
| `@jataqi/autonomous-action-runtime` | 26 / 4 — pass 26, fail 0 | **26 / 4 — pass 26, fail 0** | 0 |
| `@jataqi/external-connectors` | 22 / 5 — pass 22, fail 0 | **22 / 5 — pass 22, fail 0** | 0 |
| **Total** | **679 / 94** | **681 / 95** | **+2 / +1** |

Additional independent evidence: the **full aggregated suite** at the verified head on Node 22 is green —

```
$ npm test          # repo root, all workspaces
Total: 50 · Passed: 50 · Failed: 0 · Skipped: 0
```

**On Node 22, no regression is reproduced.** The only test-count change is the additive R-17 suite; no test was removed, weakened, or skipped. This is contradicted on Node 20 CI — see §8.

---

## 8. BLOCKER — THE REQUIRED CI STATUS CHECK FAILS ON THE VERIFIED HEAD

| Fact | Evidence |
|---|---|
| The check is **red** on the exact head under review | `gh pr checks 40` → `build · lint · test` **fail** (8m58s) |
| Run / job | run `35334202868`, job `105565178475`, head `ab9914a` |
| Failing step | **step 8, "Test (all workspaces)"** — annotation: *"Process completed with exit code 1"* at `#step:8:15882` |
| Steps that passed | Set up job, Checkout, Set up Node.js, Install dependencies, Verify workspace/lockfile integrity, **Build all workspaces**, **Lint**, PostgreSQL integration status (all `success`) |
| The check is **required** by active governance | ruleset `20134880` "Jata Qi", `enforcement: active`, `required_status_checks: [{context: "build · lint · test"}]`, `strict_required_status_checks_policy: true`; also `required_approving_review_count: 1` (PR #40 has **zero** reviews) |
| Preceding heads were green | `608a6ea` (PR #39) → success; `6b61256` (baseline) → success. **The only red run in this series is PR #40's head.** |
| Design mandate | §10.1 requires *"executed test evidence **on Node 20** (CI parity)"*; **E-18** requires *"Non-regression: **all existing suites green** (CI Node 20 on the merge SHA)"* |

**Reproduction status — UNRESOLVED.** The verifier could **not** reproduce the failure: the identical aggregate suite is green locally on Node 22 (`50 · Passed: 50 · Failed: 0 · Skipped: 0`). Node 20 could not be obtained in the verification sandbox (no `nvm`; `nodejs.org` unreachable), so **CI parity could not be tested**. The root cause is **undetermined**: retrieval of the failing step's log was blocked by the sandbox (the Actions log blob endpoint returns `EOF`; `gh run view --log`, `gh api …/jobs/…/logs`, and repeated retries all failed). The GitHub UI for the run requires sign-in to reveal step logs.

The S0a evidence package (PR body, T-16 report, commit body) **does not disclose** this CI failure.

**This is a mandatory-condition failure and the primary blocker.** E-18 is not satisfied on the verified head, and the repository's own active ruleset makes this check a precondition of merge. No verification conclusion can be issued as PASS while the required check is red and the cause is undetermined. Per the authorization, this condition is **reported, not repaired** — the verifier did not re-run CI, did not push, and did not touch the check.

---

## 9. DISCREPANCY ANALYSIS

### 9.1 Conclusion-altering discrepancies (blockers)

| ID | Severity | Discrepancy | Evidence |
|---|---|---|---|
| **VD-1** | **HIGH** | **T-16's "88 verdict transitions" is a self-referential artifact, not grant-corpus impact.** 84 of 88 come from patterns existing only in the PR's own new R-17 test file; the remaining 4 are `doc/*` matched only against resources the same file introduces. Controls A and B both yield **0**. The design-mandated enumeration of **deployed** grant patterns and per-grant owner acceptance were not performed and are not disclosed as missing. | §6.2, §6.3 |
| **VD-2** | **HIGH** | **T-16 §3.1's "0 transitions (zero widening)" is false.** 16 reproducible `OLD=false → NEW=true` widenings via line terminators, confirmed against product code at both sites; undetectable by the 50-vector R-17 corpus (0 line-terminator vectors). The widening is inherent to the elected semantics but is undisclosed and expressly denied. | §6.4, §5 |
| **VD-3** | **MEDIUM-HIGH** | **The R-17 I-6 static guard is defeatable.** Identical column-0 `}` bait in both bodies + divergent code ⇒ suite reports `pass 2 / fail 0` while the bodies genuinely differ. The guard enforces the invariant only under ordinary formatting. I-6 nevertheless holds at the head (§4.1) and the vector assertions independently constrain semantics (M3). | §4.2 |
| **VD-4** | **HIGH (governance evidence)** | **No in-repository record of the U-1 election or the S0a authorization the slice presupposes.** Design record `447ab3b` §11 records U-1 as an **UNRESOLVED** question (options (i)/(ii)/(iii), recommendation (i), *"owner ratifies at exit gate"*); §12 gate item 1 requires *"Owner ratification … including explicit disposition of U-1…U-8"* and item 3 requires *"Explicit, individually-scoped authorizations for S0a, S0b, S0c (none granted here)"*. The design IV record `503e67b` states verbatim that it *"does NOT grant authorization … nor does it authorize S0a, S0b, or S0c"* and that disposition of U-1…U-8 *"remain[s] strictly reserved to the system owner."* Nonetheless PR #40 asserts the matchers were *"Remediated … to enforce U-1 semantics"* and T-16 §6 refers to *"elected U-1 semantics"*. Exhaustive search — repository docs, PR #40 body/comments/reviews, PR #39 body/comments, GitHub issues (**0 issues exist**) — finds **no** recorded election of option (i) and **no** recorded S0a authorization. | §1, §6.4, §2 |
| **VD-5** | **HIGH** | **The required CI check is red on the verified head** and the failure is unreproduced and undetermined. See §8. | §8 |

**On VD-4 specifically, and to avoid over-reading:** this record does **not** assert that S0a was unauthorized. The owner's directive commissioning this verification frames U-1 as elected and S0a as the authorized prerequisite slice, which is itself an authorization signal exterior to the repository. The finding is narrower and is left **unresolved on purpose**: the election and the slice authorization are **not recorded in any artifact this verification can inspect**, so a downstream reader of the repository alone cannot establish them. It is recorded, not resolved, and not resolved in favour of PASS.

### 9.2 Immaterial observations (no conclusion changes)

| ID | Observation |
|---|---|
| **O-1** | T-16 §5 says *"all 33 test cases in `authorization-boundary` pass"*. The package actually has **33 suites / 188 tests**. "Suites" was reported as "test cases", understating executed tests by 155. Direction is conservative; no conclusion changes. |
| **O-2** | T-16 §2 describes *"A full-tree **AST** and string sweep"*. The script performs only a **regex text scrape**; there is no AST analysis in it. The sweep also admits non-pattern tokens (`==`, `entry.resourcePattern`, `target.resourcePattern`, `pat`) and non-resource tokens (`DENY`, `InfrastructureResource`, `string):`, `undefined)`, `res-$`) into the cross-product. |
| **O-3** | T-16 §5 claims *"22 test cases in `p2-s4-delegation-store.test.ts`"* — **CONFIRMED exactly** (executed standalone: 22 tests / 22 pass). The companion claim that in-tree delegation tests use single-segment `res-*` patterns against single-segment resources is **CONFIRMED** (14 × `resourcePattern: 'res-*'`; resources `res-1`/`res-2`). |
| **O-4** | PR #40 carries a **second commit**, `503e67b`, which is a design-verification document rather than S0a implementation. Documentation-only, no executable surface. It sits outside the strict S0a code scope but violates no governing prohibition (no S0b/S0c/S1/S2/S3 code). |
| **O-5** | `scripts/t16-grant-corpus-eval.mjs` **inlines copies** of the old and new matchers rather than importing product code, so it can silently drift from the implementation it claims to evaluate. It is also inside its own scan corpus (contributing the `pat` "pattern"). |
| **O-6** | **Canonicalization/normalization was not added — and correctly so.** Design §4.4/§7 assigns the R-03 canonicalizer to **S1**, and the OD-4 slice closes T-06 *"at the matcher"* only. No S0a obligation to normalize exists. The consequence — that **T-06 is not closed end-to-end by S0a** — is accurate but is not stated in T-16 §4.3, which reads as though traversal is fully closed. |
| **O-7** | Governance integrity is otherwise intact: PR **#40 OPEN, UNMERGED** (`state OPEN`, `mergedAt null`, `mergeCommit null`, head `ab9914a`); PR **#39 OPEN, UNMERGED** at `608a6ea`; the active ruleset `20134880` was last modified **2026-09-17T10:41:35Z**, which **predates both S0a commits** (2026-09-18T09:31:39Z / 10:20:18Z) — **no governance or ruleset change accompanied S0a**. |
| **O-8** | Design §4.4 claimed doc/code consistency is restored at `capability-manifests.ts:262-265` and `types.ts:404`. Verified: those comments were **not edited** (they became true by virtue of the code change) and are now accurate ("simple segment glob", "segment-delimited resource"). The coupling comments at `delegation-types.ts:381` and `:408` remain accurate. No discrepancy. |

### 9.3 Statement on resolution

No discrepancy above was resolved in favour of PASS. VD-1, VD-2 and VD-5 are conclusion-altering and are recorded **against** the determination. The implementation session's claims are separated from this verifier's reproduced evidence throughout.

---

## 10. FINAL VERIFICATION DETERMINATION

# NOT PASS — S0a evidence package

**The S0a code change independently verifies as correct. The evidence package accompanying it does not support its stated claims, and a required governance gate is red.**

### What independently verified as correct

1. **Scope containment** — PR #40 is confined to S0a; no S0b/S0c/S1/S2/S3 implementation, no governance, lockfile, config or `.github` change, no unrelated remediation. §2
2. **Matcher correction** — exactly the two governed sites, one line each, both updated, no third site; elected U-1 semantics reproduced against an independent DP oracle over 1200 vectors with **0** mismatches and **0** site divergence; regex escaping intact. §3
3. **I-6 at the head** — the two function bodies are byte-identical modulo the declared name and parameter type. §4.1
4. **R-17 conformance** — present, executes green (2/2), covers all eight mandated categories across 50 vectors. §5
5. **Regression on Node 22** — 681 tests / 95 suites green across the five scoped packages vs 679/94 at baseline; the only delta is the additive R-17 suite; full aggregate suite 50/50 workspaces green. No regression reproduced. §7
6. **Independence** — genuine separate-party independence established before verification began. §1

### Exact blockers

| # | Blocker |
|---|---|
| **B-1** | **Required CI status check `build · lint · test` FAILS on head `ab9914a`** (run `35334202868`, step 8 "Test (all workspaces)" exit 1). The active ruleset requires this check; design **E-18** requires all suites green on CI Node 20. Not reproduced locally (Node 22 green) and **root cause undetermined** (logs unreachable; Node 20 unavailable). Undisclosed in the S0a evidence package. §8 |
| **B-2** | **VD-1** — T-16's 88 transitions are a self-referential artifact of the slice's own new test file; the genuine corpus yields **0**; the design-mandated deployed-grant enumeration and per-grant owner acceptance were not performed and the omission is undisclosed. §6.3 |
| **B-3** | **VD-2** — T-16 §3.1's "zero widening" claim is **false**: 16 reproducible line-terminator widenings against product code, undetectable by the R-17 corpus. §6.4 |
| **B-4** | **VD-3** — the R-17 I-6 static guard admits a demonstrated false negative. §4.2 |
| **B-5** | **VD-4** — no artifact in the repository, PR #40 or PR #39 records the owner's election of U-1 option (i) or the S0a authorization that the slice presupposes. Recorded unresolved. §9.1 |

### Limitations of this verification

- **Node 20 CI parity was not achieved.** All execution evidence here is Node **22.22.3**. The design mandates Node 20 evidence (§10.1). This is precisely the gap that B-1 sits in.
- **The CI failure root cause was not determined.** CI step logs were not retrievable from the verification sandbox.
- **VD-3's false negative is a control-flow demonstration**, produced against source files in a detached worktree and fully reverted; the invariant itself was never at risk in the verified head.
- **No deployed grant corpus was available to this verifier either** — B-2 is a limitation shared by the verifier; the repository contains no deployed grants to enumerate.
- This verification is **read-only**. No S0a file was modified, no remediation was attempted, CI was not re-run, nothing was pushed to PR #40, and PR #40 was not merged.

### Standing

- S0b — **NOT IMPLEMENTED / NOT AUTHORIZED**
- S0c — **NOT IMPLEMENTED / NOT AUTHORIZED**
- P3-B S1 / S2 / S3 — **NOT IMPLEMENTED / NOT AUTHORIZED**
- PR #39 — **OPEN, UNMERGED** (`608a6ea`)
- PR #40 — **OPEN, UNMERGED**; required check **RED**; zero approving reviews
- Score — **9.484375% FROZEN**, unchanged and not recalculated
- Production readiness — **NOT READY**; no readiness claim attaches to S0a
- Merge authorization — **NOT GRANTED.** This record authorizes nothing.

**Per the authorization: verification terminates here.** The blockers above are reported, not repaired. The owner's explicit merge authorization is required before any further action on PR #40.

---

*— End of P3-B₀ S0a independent verification record —*
