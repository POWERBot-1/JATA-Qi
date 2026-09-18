# P3-B₀ SLICE S0a — BLOCKER ASSESSMENT (READ-ONLY)

| Field | Value |
|---|---|
| Document Class | **READ-ONLY BLOCKER ASSESSMENT.** Evidence and recommended disposition only. Grants nothing; remediates nothing. |
| Subject | Assessment of blockers **B-1 … B-5** recorded in `docs/verification/P3_B0_S0A_INDEPENDENT_VERIFICATION.md` against merged commit `68e819e` |
| Under assessment | PR **#40**, head `ab9914a4d8a6c389645b358d0fdfa07ebb9cc7f7`, baseline `6b61256c6115a02da2d3ad6ba42771831b550f81` |
| Prior determination | **NOT PASS — BLOCKED** (unchanged by this assessment) |
| Environment | Node **v22.22.3**, npm 10.9.8, Linux sandbox |
| Date (UTC) | 2026-09-18 |
| Constraints observed | No code change · no remediation commit · no PR modification · no merge · no S0b/S0c/S1/S2/S3 · no score change · no production-readiness claim |

---

## 1. DISPOSITION SUMMARY

| ID | Subject | Category | In S0a scope? | Effect on determination |
|---|---|---|---|---|
| **B-1** | Required CI check red on head | **CI failure — confirmed; root cause UNDETERMINED** (with a *separate*, distinct sandbox log-access limitation) | **Yes** (E-18, §10.1) | **Merge-blocking. Upholds NOT PASS.** |
| **B-2** | T-16 self-referential corpus / "88 transitions" | **Verification/evidence defect — confirmed** | **Yes** (T-16 is an S0a acceptance precondition) | Upholds NOT PASS (evidence, not implementation) |
| **B-3** | Undisclosed line-terminator widening; "0 widening" claim false | **Verification/evidence defect — confirmed.** Behaviour = **unintended semantic expansion requiring owner disposition** | Claim: yes. Behaviour change: **owner decision, not silently owed** | Upholds NOT PASS |
| **B-4** | Defeatable I-6 static guard | **Verification/evidence defect — confirmed**; guard tests a **weaker proxy** | **Yes** (R-17 + I-6 are S0a deliverables) | Upholds NOT PASS (implementation *is* verified clean) |
| **B-5** | No repository artifact of U-1 election / S0a authorization | **Governance-record defect — confirmed absence** | **No — precedes S0a** (design §12 gate items 1 & 3) | Upholds NOT PASS (governance) |

**No blocker was downgraded. No blocker is an immaterial observation.** Crucially, **none of B-1 … B-5 is a defect in the matcher correction itself**: the two one-line changes independently verify as correct (0 oracle mismatches over 1200 vectors; I-6 holds at the head; no regression reproduced on Node 22). Every blocker is a red gate, an evidence defect, or a governance-recording gap.

---

## 2. B-1 — REQUIRED CI CHECK FAILURE ON THE VERIFIED HEAD

### 2.1 Confirmed as a genuine CI failure (not a tool artifact)

| Evidence | Value |
|---|---|
| Run / job | `35334202868` / `105565178475`, head `ab9914a` |
| Job conclusion | **failure** (started 10:20:40Z, completed 10:29:38Z, 8m58s) |
| Failing step | **step 8, "Test (all workspaces)"** — conclusion `failure` |
| GitHub annotation | `#annotation:8:15882` → **"Process completed with exit code 1."** |
| Steps 1–7 | all `success` — incl. "Build all workspaces" and "Lint" |
| Steps 9–10 | all `success` |
| Preceding heads | `608a6ea` → success; `6b61256` → success. **The only red run in this series is PR #40's head.** |

`ci.yml` step 8 runs `set -o pipefail; npm test 2>&1 | tee …`, so exit 1 is `npm test` failing. **Step 9 succeeding is informative**: step 9 executes `grep -qi 'SKIPPED: PostgreSQL integration'` and `exit 1` on a match; its success proves PostgreSQL integration **did** execute, so the failure is **not** a database-skip false-negative.

### 2.2 Historical discriminator — step-8 red has meant a real defect in this repository

Every CI failure in this repository's history failed at **the same step 8**:

| Run | Head | Failing step |
|---|---|---|
| `35334202868` | `ab9914a` | Test (all workspaces) |
| `34714876835` | `9d9f3d9d` | Test (all workspaces) |
| `34711717133` | `7ef22f43` | Test (all workspaces) |
| `34691184146` | `85047beb` | Test (all workspaces) |
| `34625832959` | `0ab4b542` | Test (all workspaces) |

Run `34714876835` was remediated by a real code/test fix — PR #35, *"fix(authentication): **remediate measured CI defects from run 34714876835** (P2-S3 readiness harness, P2-S5 concurrency assertion)"*, merged as `45fb1285`. **Precedent: a red step 8 in this repo has been a genuine measured defect, not noise.**

### 2.3 Decisive in-repo evidence that local green does NOT exculpate

`docs/verification/P2_S1_VERIFICATION_REPORT.md:72-79` (on `main`) records:

> **Runner masking.** node:test … reports a top-level suite-setup failure as `not ok` but **excludes it from the `# tests`/`# pass`/`# fail` counters**, and its **exit status is version-dependent: Node 22 → exit 0 (fully masked — every local gate run reported PASS); Node 20 → exit 1 (surfaced in CI)**.

and §1.5 records it as a **still-open residual platform risk**:

> …the node:test suite-setup-failure counter/exit-status desync undercounts any suite that throws at setup and is **invisible to exit status on Node 22**. A repo-level guard (e.g., TAP `not ok` scanning in CI, or runner-Node alignment with `engines`) is a separate improvement item.

That occurrence was a **genuine defect** (a fixture calling `ECDH.getPublicKeyDER()`, a method absent from `node:crypto`), remediated test-only at `97f055b`.

**Consequence — and this is the reason B-1 is not downgraded:** on Node 22 a suite can fail at setup while the counters still read `# fail 0` and the process still exits 0. Therefore this session's local results —

- `authorization-boundary` **188 tests / 188 pass / 0 fail**
- `authentication` **365 / 365 / 0 fail** (independent re-run: identical)
- aggregate `npm test` **50 / 50 workspaces, 0 failed**

— **cannot exclude** a Node-20-surfaced failure. Instruction 7 applies directly.

### 2.4 Distinct limitation: log access (NOT part of the failure)

The failing step's log is **unobtainable from this sandbox**:

- `gh api repos/…/actions/runs/35334202868/logs` → zip endpoint `results-receiver.actions.githubusercontent.com` returns **`EOF`**
- `gh api repos/…/actions/jobs/105565178475/logs` → blob endpoint `productionresultssa14.blob.core.windows.net` returns **`EOF`**
- GitHub UI: "Sign in to view logs"; job page reports every step "**truncated due to its large size**"
- Node 20 could not be installed (`nvm` absent; `nodejs.org` unreachable) → **CI parity could not be tested**

This limitation is **pre-existing and already recorded in-repo**: `docs/S01_TENANT_BOUNDARY_HARDENING.md:168` — *"CI log blobs are unreachable from this sandbox (TLS egress blocked), which will be reported as an explicit limitation rather than inferred away."*

### 2.5 Root cause — NOT determined

**No root cause is asserted.** Two candidate hypotheses are recorded **as hypotheses only**:

- **H1** — a genuine test defect surfacing only on Node 20 (precedent: the `p2-s1-oidc` ECDH defect).
- **H2** — the documented node:test setup-failure masking interacting with the newly added R-17 file, which is the diff's only new test and is **environment-sensitive**: it imports `@jataqi/authentication` at module load and reads two sibling source files through `__dirname`-relative paths (`…/src/capability-manifests.ts`, `../../authentication/src/delegation-types.ts`). A **load-time** failure would be masked on Node 22 exactly as documented.

| Field | Determination |
|---|---|
| Category | **CI failure — confirmed. Root cause undetermined.** (The log-access limitation is a *separate* sandbox limitation, not the failure.) |
| In S0a scope | **Yes** — design §10.1 requires Node-20 executed evidence; **E-18** requires all suites green on CI Node 20 on the merge SHA |
| Minimum corrective action | (1) retrieve step-8 log from an environment with egress/authentication; (2) classify the failing test(s); (3) if genuine → remediate under **separate authorization**; if the masking mechanism is implicated → align runner Node with `engines` **or** add the TAP `not ok` guard as its own authorized item; (4) require green CI on the exact head. **Re-running is not diagnosis, and is not a remedy.** |
| Security / governance consequence | **E-18 unsatisfied.** Ruleset `20134880` requires this check with `strict_required_status_checks_policy: true` ⇒ **PR #40 is not mergeable as-is** (it also has 0 of 1 required approving reviews). More broadly: because setup failures can be silently uncounted on Node 22, the slice's green local claims are **weaker than they appear** — precisely the propagation the design record forbade. |

---

## 3. B-2 — T-16 SELF-REFERENTIAL CORPUS / "88 TRANSITIONS"

**Reproduced.** `node scripts/t16-grant-corpus-eval.mjs` → `Total unique resource patterns found in repository: 24`, `Total unique test/code resources found: 67`, **`Total re-evaluation verdict changes across cross-product: 88`**. The figure reproduces; it does not measure what is claimed.

**Exact affected evidence** — `scripts/t16-grant-corpus-eval.mjs:47` performs a regex **text scrape** (`/resourcePattern\s*[:=]\s*["'\`]?([^"'\`,\s{}]+)["'\`]?/g`) over every `.ts/.js/.mjs/.md` file, then takes the cross-product of all patterns × all resources:

- **16 of the 24 scraped patterns exist ONLY in `packages/authorization-boundary/test/r17-matcher-conformance.test.ts`** — a file **added by this same PR**.
- **4 more are not patterns at all**: `==`, `entry.resourcePattern`, `target.resourcePattern` (property accesses / comparison operators) and `pat` (from the script itself, which is inside its own scan corpus).
- Only **4** genuine pre-existing wildcard patterns exist at the baseline: `doc/*`, `res-*`, `task-*`.
- Attribution of the 88: **46** `*` · **19** `*/*` · **7** `https://api.openai.com*` · **4** `*.openai.com` · **3** `https://api.openai.com/v1/*` · **3** `tenants/*/files/*` · **1** `doc/res-*` · **1** `api.*.openai.com` (= 84, all R-17-only) · **4** `doc/*` (pre-existing pattern matched only against R-17-introduced resources). **84/88 derive from the PR's own new test file.**

**Two control experiments, both reproduced:** baseline tree `6b61256` + same script → **0 transitions**; PR tree **minus** the R-17 file → **0 transitions**.

**Design-mandated method vs. delivered artifact** — design `447ab3b` §4.4 requires: *(a) enumerate **deployed** grant patterns; (b) re-evaluate each; (c) record every grant whose verdict changes; (d) obtain explicit owner acceptance per changed grant.* The report performs **none** of (a),(c),(d): no deployed grants exist in-tree, none were obtained, no grant is recorded, no acceptance is recorded — and the substitution is **not disclosed**.

| Field | Determination |
|---|---|
| Category | **Verification/evidence defect — confirmed.** (Not a code defect; not immaterial — the artifact is a required precondition.) |
| In S0a scope | **Yes** — T-16 re-evaluation is an explicit S0a acceptance precondition (design §4.4) |
| Minimum corrective action | Restate T-16 on the **measured pre-existing corpus** (excluding artifacts the slice itself adds); delete or relabel the "88"; state plainly that **no deployed grant corpus exists**, so the T-16 precondition is met **vacuously/prospectively**, and (d) is satisfied because **zero** deployed grants change verdict. Correct the "AST sweep" description (it is a regex scrape) and the "33 test cases" figure (33 **suites / 188 tests**). Author: implementation session; then independently re-verified. |
| Security / governance consequence | The slice's migration-impact evidence is **not load-bearing**, and the design-mandated **owner-acceptance step for changed grants was not performed**. The true measured impact (0) is *more* favourable than claimed, but an unsupported favourable number is still an evidence defect and must not stand. |

---

## 4. B-3 — LINE-TERMINATOR WIDENING ("`.`" vs "`[^/.]`")

**Reproduced against product code at the head.** `packages/authorization-boundary/src/capability-manifests.ts:281` and `packages/authentication/src/delegation-types.ts:399` both encode `.join('[^/.]*')`.

| Pattern `doc/*` (system `docs`) | `targetMatches` | `delegationTargetMatches` | pre-S0a (`.*`) |
|---|---|---|---|
| `doc/a\nb` | **true** | **true** | false |
| `doc/a\rb` | **true** | **true** | false |
| `doc/a U+2028 b` | **true** | **true** | false |
| `doc/a U+2029 b` | **true** | **true** | false |
| `doc/a\tb` / `doc/a b` | true | true | true |
| `doc/a.b` / `doc/a/b` | false | false | true |

A 1200-vector differential yields **16 reproducible `OLD=false → NEW=true` widenings**, all line terminators. Mechanism: JS `.` does not match line terminators; `[^/.]` does. **R-17 corpus vectors containing a line terminator: 0** — the corpus cannot detect it. **T-16 §3.1's claim "`OLD=false -> NEW=true` (Unintended Expansion): **0 transitions** (zero widening)" is therefore false.**

### 4.1 Instruction 9 — intended consequence of U-1, or unintended expansion?

**Determination: an UNINTENDED semantic expansion relative to U-1's evident intent — but a literal consequence of the elected wording as encoded. It is not an elected choice.**

- Design §4.4 states the intent as boundary-character control: *"`*` matches zero or more characters **excluding** the boundary characters `/` and `.`"*, each consequence traceable to T-04/T-05/T-06 — **all three bypass classes concern `/` and `.` only**.
- Design §11 U-1 offers exactly three options — (i) `/`+`.` excluded, (ii) `/` only, (iii) per-entry delimiter declaration. **No option mentions line terminators**; the design record never considered them.
- Therefore the widening is an **incidental artifact of the chosen regex encoding**, not a ratified semantic. Under the literal wording it is *permissible*; under the design's intent it was **never considered**.

**Aggravating / mitigating facts, both recorded:**
- *Aggravating:* `targetResource` is free-form and unvalidated on this path — grep finds **no** control-character, newline, or hostname rejection anywhere in `delegation-store.ts`, `delegation-types.ts` or `policy-engine.ts`, and `packages/authorization-boundary/src/canonical.ts` is **envelope-digest canonicalization, not URL/host canonicalization**. So a line-terminator-bearing resource can reach both matchers today.
- *Mitigating:* the winding does **not** re-open T-04/T-05/T-06; and for the P3-B egress-host use case a line terminator is not a valid hostname character, with §4.4/§7 assigning the R-03 canonicalizer to **S1**.

| Field | Determination |
|---|---|
| Category | **Verification/evidence defect (confirmed false claim)**, plus an **unintended semantic expansion requiring owner disposition** |
| In S0a scope | The **T-16 claim** is in scope and must be corrected. The **behaviour change is an owner decision** — S0a was authorized for "OD-4 and elected U-1 semantics only", and the behaviour satisfies the *literal* election; a change to the accepted language is a semantics change, not a silent S0a obligation |
| Minimum corrective action | (1) Correct T-16 §3.1's false "zero widening" statement and disclose the line-terminator behaviour. (2) **Owner disposition, exactly one of:** **(a)** elect the semantics explicitly as "any character except `/`, `.`, and line terminators", add R-17 vectors, and implement under separate authorization; or **(b)** ratify U-1 on the literal reading and record the widening as a **disclosed, accepted** consequence with a compensating control assigned to S1's canonicalizer. **Neither option may be chosen by the implementation session.** |
| Security / governance consequence | For a matcher whose purpose is fail-closed behaviour, an **undisclosed expansion of the accepted language** is material: the slice's evidence asserts a safety property (monotone tightening) that is not true of the product. Exploitability today is low (no canonicalizer exists yet; egress hosts cannot contain line terminators), but the claim must not stand, and the owner must own the semantics. |

---

## 5. B-4 — DEFEATABLE I-6 STATIC BYTE-IDENTITY GUARD

**Exact affected code** — `packages/authorization-boundary/test/r17-matcher-conformance.test.ts:451-456`:

```js
const extractBody = (src: string, fnName: string): string => {
  const match = src.match(new RegExp(`export function ${fnName}\\([^)]+\\): boolean \\{([\\s\\S]*?\\n\\})`));
  …
  return match[1].trim();
};
```

The capture is **non-greedy and terminates at the first line-initial `}`**, and line 462 then asserts `assert.equal(capturedA, capturedB)`.

**Reproduced control flow:** injecting an **identical** column-0 `}` into **both** bodies at the same offset, with genuinely **divergent** statements after it, yields both captures equal (`captures EQUAL : True`) and the suite reports **`# pass 2 / # fail 0`** — while the two function bodies differ.

### 5.1 Instruction 10 — does the guard satisfy I-6, or test a weaker proxy?

**It tests a weaker proxy.** The property actually asserted is *"the two first-`\n}`-anchored prefixes are equal"*. Byte-identity of the true bodies is only **implied**, under the unstated assumption that neither body contains an interior line-initial `}`. The invariant as stated in the design — *"asserts the two bodies remain textually identical"* — is **not soundly enforced**. This is the **only** I-6 enforcement in the repository: no other test, no CI step, and no hash comparison covers it.

**Counter-evidence, recorded so the severity is not overstated:**
- **M1** — a realistic single-site edit (`[^/.]*` → `.*` in one file) ⇒ guard **FAILS**. This is the drift the guard exists to catch, and it catches it.
- **M3** — reverting **both** sites identically to `.*`, **rebuilding**, ⇒ the **vector** assertions **FAIL** ("`Segment: * REJECTS slash /` … expected false, got true"). So I-6's *purpose* is independently served by semantics, not only by the static check.
- I-6 **holds at the head**: bodies byte-identical modulo the declared name and parameter type (signature-normalised SHA-256 equal; `diff` empty).

| Field | Determination |
|---|---|
| Category | **Verification/evidence defect — confirmed.** Static guard capability **overstated**; invariant itself intact at the head |
| In S0a scope | **Yes** — R-17 and the I-6 static check are explicit S0a deliverables |
| Minimum corrective action | Replace the regex capture with **brace-balanced extraction** (or an AST/`typescript` parse), or compare a normalised whole-body hash; **and** add a negative meta-test asserting the guard fails on a deliberately drifted fixture. Record the invariant's exact scope. |
| Security / governance consequence | The coupling (`:381` "mirrors … exactly"; `:408` "MUST stay identical") is defended by documentation, convention and a **partial** check rather than sound enforcement. The *semantic* half is genuinely enforced; only the *textual* half is defeatable, and only by deliberately identical-formatted edit pairs. Consequence: **bounded but real** — a future single-site refactor that also reformats could evade static detection, though any behaviour it changes within the 50-vector corpus would still be caught. |

---

## 6. B-5 — MISSING GOVERNANCE RECORD OF U-1 ELECTION AND S0a AUTHORIZATION

### 6.1 Instruction 11 — what is PRESENT

| Artifact | Content | Status |
|---|---|---|
| `docs/verification/P3_A_SECURITY_THREAT_MODEL_AND_BASELINE.md:10` (**in `main`**) | *"P3 authorized by the owner (2026-09-17) **for planning only**; implementation requires a **separate P3 implementation authorization naming the selected slice(s)**"* | **PRESENT — and it defines the requirement** |
| Repository convention | Authorizations are recorded in-document — e.g. `docs/T09_F_REGISTER_RECONSTRUCTION.md` carries an explicit **"Authorized by"** field; `M1_CLOSURE_RECORD.md:441` lists merge authorizations as human-owned | **PRESENT** |
| `447ab3b` design record §11/§12 | U-1 recorded as **UNRESOLVED**; options (i)/(ii)/(iii); recommendation (i); *"owner ratifies at exit gate"*; gate items 1 & 3 require owner ratification of U-1…U-8 and explicit S0a/S0b/S0c authorizations | **PRESENT as a deferral** |
| `503e67b` design IV §4.8, §5 | *"This verification is an evidence artifact and does NOT … authorize S0a, S0b, or S0c"*; *"Disposition of U-1 through U-8 … remain strictly reserved to the system owner"* | **PRESENT as a refusal** |
| Owner directive commissioning this verification | States U-1 as *elected* and S0a as the authorized prerequisite slice | **PRESENT but EXTERIOR to the repository** |

### 6.2 Instruction 11 — what is ABSENT

- **No recorded disposition/ratification of U-1** (option (i)) anywhere in the repository.
- **No S0a implementation authorization** naming scope, as the `main` artifact requires.
- **No merged/canonical P3-B₀ design record**: `447ab3b` is **not in `main`** and has **no pull request** — it exists only on the unreferenced branch `arena/01a0b377-jata-qi`.
- Evidence of absence: `git grep` for U-1 election / S0a authorization across `main`, `origin/pr40`, `origin/pr39` → **no match**; the only hit is the phrase *"elected U-1 semantics"* at `docs/verification/T16_GRANT_CORPUS_REEVALUATION_REPORT.md:88` — **i.e. the slice's own artifact asserts the election without recording its source**. Also: **0** repository issues; PR #40 has **0 comments and 0 reviews**; PR #39's single comment contains no U-1/S0a authorization.

| Field | Determination |
|---|---|
| Category | **Governance-record defect — confirmed absence.** The defect is the **recording**, not necessarily the authority |
| In S0a scope | **No — this PRECEDES S0a.** Design §12 gate items 1 and 3 place owner ratification and slice authorization *before* any implementation |
| Minimum corrective action | Owner records, **in a repository artifact** (not a chat message or PR comment): (a) the **U-1 disposition**, naming the elected option; and (b) the **S0a implementation authorization**, naming scope, verification criteria, merge gate and rollback boundary — per the standard already published in `main`. Alternatively confirm such records exist elsewhere and cite them. Note `447ab3b` and `503e67b` are themselves unmerged; the owner may also wish to record the design record's canonical status |
| Security / governance consequence | An auditor reading only the repository **cannot establish the slice's authority**, and the project's own published requirement ("implementation requires a separate P3 implementation authorization naming the selected slice(s)") is **not demonstrably satisfied on disk**. Because U-1 is the semantic that S0a encodes, an unrecorded election also leaves the accepted language of a **live governed matcher** resting on an artifact that is not part of `main`. This is the highest-*governance*-severity blocker of the five, while being the lowest technical one. |

---

## 7. AGGREGATE RECOMMENDED DISPOSITION

1. **Uphold the existing determination: NOT PASS — BLOCKED.** This assessment weakens no blocker and closes none. Findings are **not** downgraded because local tests pass (§2.3).
2. **Do not merge PR #40.** B-1 alone is merge-blocking under active ruleset `20134880`; the PR also has 0 of 1 required approving reviews.
3. **Authorize no remediation yet.** B-2/B-3/B-4 corrective actions touch artifacts owned by the implementation session, and B-3 potentially changes **elected semantics** — which only the owner may elect.
4. **Suggested order when the owner proceeds:** **B-1** (obtain the log → classify → remediate or re-run) → **B-5** (record U-1 disposition + S0a authorization in-repo) → **B-3** (owner elects the semantics; correct the T-16 claim) → **B-2** (restate T-16 on the measured corpus) → **B-4** (harden the guard). Each then re-verified per design §10.5.
5. **Unchanged:** S0b, S0c and P3-B S1/S2/S3 **not implemented / not authorized**; PR #39 and PR #40 **OPEN, UNMERGED**; score **9.484375% FROZEN**, not recalculated; **PRODUCTION NOT READY**; **merge NOT authorized**.

---

## 8. LIMITATIONS OF THIS ASSESSMENT

- **B-1 could not be reproduced or root-caused.** The failing log was unreachable (TLS egress to the Actions blob endpoints; sign-in required in the UI) and Node 20 could not be installed. `H1`/`H2` are **hypotheses, not determinations**. No root cause is invented.
- **Only Node 22 execution was possible**, which — per the repository's own documented masking mechanism — is the *least* sensitive runtime for detecting the failure class in question.
- **No deployed grant corpus exists** to enumerate, so B-2's control experiments measure the in-tree corpus only; a deployment-side corpus could not be assessed by this verifier either.
- **No repository artifact was created, modified or deleted other than this assessment document**; no code, test, workflow, PR or ruleset was touched; CI was not re-run; nothing was pushed to PR #40.

---

*— End of blocker assessment. Awaiting explicit owner authorization before any corrective action. —*
