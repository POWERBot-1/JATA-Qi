# P3-B₀ SLICE S0a — B-2 READ-ONLY EVIDENCE ASSESSMENT

| Field | Value |
|---|---|
| Document Class | **READ-ONLY EVIDENCE ASSESSMENT.** Repository evidence only. Grants nothing; remediates nothing. |
| Authorization | Owner: *"I explicitly AUTHORIZE a B-2 READ-ONLY EVIDENCE ASSESSMENT ONLY for S0a / PR #40."* |
| Subject | B-2 as recorded at `461022a`: T-16's "88 verdict transitions" may be self-referential |
| Under assessment | PR **#40** · head **`ab9914a`** · baseline **`6b61256`** · `scripts/t16-grant-corpus-eval.mjs` · `docs/verification/T16_GRANT_CORPUS_REEVALUATION_REPORT.md` |
| Environment | Node 22.22.3, Linux sandbox — text/regex analysis and matcher re-execution only |
| Date (UTC) | 2026-09-18 |
| **DETERMINATION** | **B-2 CONFIRMED AS AN EVIDENCE DEFECT** — with one calibration refinement (§7) |

**Method note.** The analyzer used here is an **independent, faithful reimplementation** of the T-16 script's scan (identical regexes, identical extension set, identical `node_modules`/`.git`/`dist` exclusions) and of both matchers. It re-derives **88** on the PR tree, which validates the reimplementation against the artifact under assessment before any attribution claim is made. Every count below is reproduced execution evidence, not a quotation from T-16.

---

## 1. EXACTLY HOW THE T-16 CORPUS IS CONSTRUCTED — **VERIFIED**

`scripts/t16-grant-corpus-eval.mjs` does **not** consult any grant store, database, deployment artifact or configuration. It performs a **recursive regex text scrape** and then a **Cartesian product**.

| Step | Implementation | Line |
|---|---|---|
| Scan set | every `.ts`, `.js`, `.mjs`, `.md` file under `.`, skipping directories named `node_modules`, `.git`, `dist` | `:34-45` |
| "Patterns" | `resourcePattern\s*[:=]\s*["'\`]?([^"'\`,\s{}]+)["'\`]?` — a **text match on the property name**, then filters `$`-prefixed, `/`-prefixed, `string`, `undefined` | `:47,56` |
| "Resources" | `resource\s*:\s*["'\`]?([^"'\`,\s{}]+)["'\`]?` — likewise a text match | `:68,75` |
| Evaluation | **every pattern × every resource**, under an inlined old matcher (`.join('.*')`, `:14`) and an inlined new matcher (`.join('[^/.]*')`, `:29`); a transition is recorded when the two disagree | `:89-100` |

**There is no corpus declaration, no allowlist, no provenance tag, and no concept of a "grant"** anywhere in the script. "The corpus" is simply *every string that happens to follow `resourcePattern:`/`resource:` anywhere in the scanned file types*.

**Reproduced:**

```
PR tree (ab9914a) : 575 files scanned -> 24 patterns, 67 resources, 88 transitions  (all true->false)
baseline (6b61256): 571 files scanned ->  7 patterns, 27 resources,  0 transitions
```

---

## 2. BASELINE VERSUS PR #40 ADDITIONS — **EXACT PROVENANCE**

PR #40 adds exactly **four** files:

```
+ docs/verification/P3_B0_DESIGN_INDEPENDENT_VERIFICATION.md
+ docs/verification/T16_GRANT_CORPUS_REEVALUATION_REPORT.md
+ packages/authorization-boundary/test/r17-matcher-conformance.test.ts
+ scripts/t16-grant-corpus-eval.mjs
```

Corpus growth is entirely attributable to those four files:

| | Baseline `6b61256` | PR #40 `ab9914a` | PR-only |
|---|---|---|---|
| Unique "patterns" | **7** | **24** | **17** |
| Unique "resources" | **27** | **67** | **40** |

### 2.1 Pattern provenance — the decisive table

| Origin | Count | Identity |
|---|---|---|
| Genuine **pre-existing** target patterns | **4** | `doc/*`, `res-*`, `task-*`, `only-this-one` |
| Pre-existing **regex artifacts** (not patterns at all) | 3 | `==` (from `resourcePattern === undefined`), `entry.resourcePattern`, `target.resourcePattern` (property accesses) |
| **Introduced by PR #40 — from `r17-matcher-conformance.test.ts`** | **16** | `*`, `*/*`, `*.openai.com`, `api.*.openai.com`, `https://api.openai.com*`, `https://api.openai.com/v1/*`, `https://api.openai.com/v1/chat`, `tenants/*/files/*`, `doc/1`, `doc/*-item`, `doc/res-*`, `data+set/*`, `item(1)/*`, `matrix[0]/*`, `a|b/*`, `^prefix$/*` |
| **Introduced by PR #40 — from the T-16 script itself** | 1 | `pat` *(the script is inside its own scan corpus)* |
| **Total** | **24** | |

**16 of the 17 PR-added "patterns" exist only inside the conformance test file that this same PR adds.** They are test inputs, not deployed targets. No production manifest, policy or configuration contains any of them.

### 2.2 Resource provenance

Of 67 resources, 27 exist at baseline and **40 are PR-only**, and the PR-only set is dominated by conformance fixtures: `doc/1.json`, `doc/10`, `doc/alpha-beta-123`, `doc/sub/1`, `doc/a/b/c`, `evil.api.openai.com`, `api.v1.sub.openai.com`, `https://api.openai.com.evil.com/steal`, `https://api.openai.com/v1/../../admin`, `tenants/acme/…`, `foo/bar/baz`, `data+set/item1`, `matrix[0]/elem`, `item(1)/child`, and similar.

---

## 3. CAN THE 88 BE REPRODUCED FROM THE BASELINE CORPUS? — **NO**

### 3.1 Per-transition provenance classification (all 88)

Every one of the 88 transitions was classified by whether its **pattern** and its **resource** exist in the baseline tree:

| Pattern origin | Resource origin | Transitions |
|---|---|---|
| PR-added | PR-added | **77** |
| PR-added | baseline | **7** |
| baseline | PR-added | **4** |
| **baseline** | **baseline** | **0** |

> ### **Zero of 88 transitions involve material that existed at the baseline on both sides.**

There is no (baseline pattern × baseline resource) pair whose verdict changes under the corrected semantics. The four `doc/*` transitions are `doc/*` (the one pre-existing wildcard pattern) evaluated against **PR-added** resources introduced by the R-17 file.

### 3.2 Single-file causation — ablation by variant

| Variant | Patterns | Resources | Transitions |
|---|---|---|---|
| **A** PR tree as-is | 24 | 67 | **88** |
| **B** PR tree **minus `r17-matcher-conformance.test.ts` only** | 8 | 28 | **0** |
| **C** PR tree minus `scripts/t16-grant-corpus-eval.mjs` only | 23 | 66 | **88** |
| **D** PR tree minus R-17 file **and** T-16 script | 7 | 27 | **0** |
| **E** PR tree minus all four PR-added files (= baseline) | 7 | 27 | **0** |

**Removing one file — the conformance suite this PR adds — takes the reported figure from 88 to 0.** The T-16 script's own contribution is nil (variant C).

### 3.3 Direct answer

**The 88 cannot be reproduced from the baseline grant corpus, because the baseline yields zero transitions.** The number is a complete artifact of the slice's own newly added test vectors. Restricting the same script to files that existed before the slice returns **0 patterns' worth of change** — 7 patterns, 27 resources, **0 transitions**.

**The reported figure therefore measures the new test file against itself.** It is a valid *differential-semantics demonstration* (it does show the corrected matcher tightening on those vectors) but it is **not** evidence about any pre-existing, deployed or migrated grant.

---

## 4. WAS THE DESIGN-MANDATED METHOD PERFORMED? — **NO**

Design record `447ab3b` §4.4 mandates, verbatim:

> *"Before the slice merges: **(a) enumerate deployed grant patterns**; (b) re-evaluate each under both semantics; **(c) record every grant whose verdict changes**; **(d) obtain explicit owner acceptance per changed grant** (tightening = fail-closed, but availability-relevant). T-16's exploitability was **UNKNOWN** (no grant corpus inspected); this enumeration converts it to **measured fact** during the prerequisite slice."*

| Required step | Performed? | Evidence |
|---|---|---|
| **(a)** enumerate **deployed** grant patterns | **NO** | No deployment/grant-store/configuration corpus was consulted. The script reads only in-tree `.ts/.js/.mjs/.md` text. Search across the whole PR tree: `"deployed grant"` → **no match anywhere**. |
| **(b)** re-evaluate each under both semantics | **NO — substituted** | Revaluation was performed over a **synthetic in-repo text scrape**, not over enumerated grants. The wrong population was evaluated, so the step's purpose was not served. |
| **(c)** record every grant whose verdict changes | **NO** | `"changed grant"` → **no match anywhere**. No grant is named in T-16 or anywhere else; the artifact records 88 anonymous (pattern, resource) text pairs. |
| **(d)** explicit **owner acceptance per changed grant** | **NO** | `"owner acceptance"` → **no match anywhere**; PR #40 has 0 reviews and 0 comments. |

**Disclosure of the substitution: absent.** `docs/verification/T16_GRANT_CORPUS_REEVALUATION_REPORT.md` never uses the words "deployed" or "owner", and the phrase "R-17" appears in it exactly once — at line 91, listing the suite as an unrelated deliverable, **never as the source of its own corpus**. §1 instead describes the artifact as enumerating *"all target and grant patterns"*, which reads as a complete population rather than as text scraped from one new test file.

### 4.1 Method-fidelity defects (same artifact)

| Defect | Evidence |
|---|---|
| T-16 §2 self-describes the method as *"A full-tree **AST** and string sweep"*. **No AST analysis exists** — the script is a line-oriented regex scrape. | script `:47,:68` |
| The corpus admits **non-patterns** (`==`, `entry.resourcePattern`, `target.resourcePattern`, `pat`) and **non-resources** (`DENY`, `InfrastructureResource`, `string):`, `undefined)`) | §2.1; script filters |
| The script **inlines copies** of both matchers instead of importing product code, so it can silently drift from the implementation it claims to evaluate | script `:4-32` |
| **Blind spot:** the scrape reads only `.ts/.js/.mjs/.md`. JSON, YAML, SQL, CSV and database-resident grants are **invisible to this method**. In-tree the only non-scanned structured files are `.github/workflows/ci.yml`, `docs/verification/r2-perf.json`, `docs/verification/r2-secret-scan.json` — none a grant corpus; but a **real** deployed grant store would never be in `.ts`/`.md` files, so this method **could not have enumerated deployed grants even if they existed.** | scan set `:40` |

---

## 5. ARE THE T-16 REPORT'S CONCLUSIONS SUPPORTED? — **PARTIALLY**

| # | T-16 claim | Status |
|---|---|---|
| 1 | §3/§3.1: *"the full cross-product matrix … yielded **88 verdict transitions**"*, all `OLD=true→NEW=false` | **REPRODUCED** — but the figure is self-referential (§3). |
| 2 | §2: table of "target pattern classes across product source, test fixtures, and builtins" | **PARTIALLY SUPPORTED / MISCHARACTERISED.** Some rows are correctly labelled (`doc/*-item` → *"Conformance vectors"*; `res-*`,`task-*` → *"Tool boundary & delegation tests"*). Others present R-17-only test data as codebase artifacts: `*.openai.com`,`api.*.openai.com` → *"Host-level network policy patterns"*; `tenants/*/files/*`,`*/*` → *"Multi-tenant file paths"*; `https://api.openai.com/v1/*` (juxtaposed with the baseline `doc/*`) → *"Path-level capability grants"*. None of those exist in any product source or manifest. No row states provenance. |
| 3 | §3.1: *"100% of legitimate segment matches … remained matching"* | **SUPPORTED as a direction claim**; the quoted examples (`doc/*`↔`doc/1`, `res-*`↔`res-1`, `*.openai.com`↔`api.openai.com`) do hold. Note `*.openai.com` is R-17-only test data. |
| 4 | §3.1: *"`OLD=false -> NEW=true` (Unintended Expansion): **0 transitions** (zero widening)"* | **UNSUPPORTED / FALSE** — refuted by B-3 (16 reproducible line-terminator widenings against product code). This is an independent defect in the same artifact; it is **not** remediated or re-assessed here. |
| 5 | §4: T-04 / T-05 / T-06 bypass closures demonstrated by named pattern/resource pairs | **SUPPORTED as semantic demonstrations**, since I independently confirmed those product-code verdicts; but every pattern used is R-17-only, so these are **not corpus-derived findings**. |
| 6 | §5: *"Availability Impact: **ZERO regressions observed**"* | **CORRECT CONCLUSION, WRONG EVIDENCE.** The zero-regression result is real, but it is established by **test execution** (independently reproduced: 681 tests / 95 suites green across the five scoped packages, plus 50/50 workspaces on Node 20 and Node 22), **not** by the 88. |
| 7 | §6: *"T-16 re-evaluation confirms zero unintended breakage and **100% fail-closed tightening**"* | **PARTIALLY UNSUPPORTED** — "zero unintended breakage" holds; "100% fail-closed tightening" is false (see #4). |
| 8 | §5: *"all 33 test cases in `authorization-boundary` pass"* | **IMPRECISE** — the package has **33 suites / 188 tests**. Understated by 155 tests; recorded previously as observation O-1. |
| 9 | §5: *"22 test cases in `p2-s4-delegation-store.test.ts`"* | **CONFIRMED exactly** (independently executed: 22/22 pass). |
| 10 | §1: *"Enumerates all target and grant patterns across repository source, tests, and declarations"* | **MISLEADING BY OMISSION** — omits that 16 of 24 patterns come from the slice's own new test file, and that no deployed grant corpus exists or was consulted. |

---

## 6. IS B-2 CONFIRMED, DISPROVED, OR UNRESOLVED? — **CONFIRMED**

**B-2 is CONFIRMED as an evidence defect.** The finding as originally recorded is upheld and is now quantified exactly rather than approximated:

- The self-referential mechanism is **not merely probable** — it is **fully determinative**: ablation of a single PR-added file reduces 88 → 0.
- **0 of 88** transitions involve baseline-origin material on both sides.
- The **88 cannot** be reproduced from the baseline corpus (baseline = 0 transitions).
- The design-mandated deployed-grant enumeration and per-grant owner acceptance were **not performed**, and the substitution is **not disclosed**.

The original B-2 wording ("84/88 from R-17-introduced patterns") is **confirmed and sharpened**: 84 transitions use PR-added patterns (all from the R-17 file), 4 use the one baseline pattern against PR-added resources, and **88/88 depend on PR-added material**.

---

## 7. CALIBRATION — WHAT B-2 DOES **NOT** SAY

Recorded deliberately, so the finding is not over-read:

1. **This is not a security regression.** The corrected semantics are strictly tighter on `/` and `.`; nothing was loosened for the *pre-existing* corpus, which changes by **zero** verdicts.
2. **No deployed grant is adversely affected.** With the pre-existing corpus changing 0 verdicts, the *correct* conclusion is that **no deployed grant changes verdict** — i.e. step (d) would be **vacuously satisfied**. The genuine result is therefore *more* favourable than the claimed one.
3. **The 88 is not meaningless.** As a differential-semantics demonstration over conformance vectors it is legitimate and it corroborates T-16 §4's bypass narrative. Its defect is being **presented and relied upon as grant-corpus / migration-impact evidence**, and being used to imply a completeness the method cannot deliver.
4. **T-16 §5's zero-regression conclusion happens to be true** — but it rests on test execution, not on the 88.

**Nature of the defect:** an **evidence and method-fidelity defect** inside an S0a acceptance artifact. It does not by itself establish a defect in the S0a implementation.

---

## 8. LIMITATIONS OF THIS ASSESSMENT

1. **No deployed grant corpus is available to this assessment, and none can be inferred from the R-17 test corpus.** The repository contains no deployment-side grant store, no configuration corpus, and no enumeration artifact. Findings about *deployed* grants are therefore limited to the **negative** result that none was enumerated and none is recorded.
2. **No deployment environment was reachable.** Conclusions concern the repository trees at `6b61256` and `ab9914a` only. Whether a real deployment holds grants that would change verdict is **unknown and unmeasured** — it is precisely the measurement the design required and T-16 did not perform.
3. The analyzer replicates the T-16 script's scan; it is validated by reproducing **88** exactly, but it inherits that method's blind spots (§4.1) save for the attribution logic.
4. **B-1, B-3, B-4 and B-5 were not investigated or remediated here.** B-3 is referenced only where T-16 makes a claim that B-3 independently refutes.
5. **Read-only:** no change was made to T-16, R-17, the matchers, tests, CI/workflows, PR #40 or PR #39; nothing was merged; no score or readiness status was touched.

---

## 9. RECOMMENDED DISPOSITION (no implementation)

1. **Accept B-2 as confirmed.** Retain it in the blocker register as an **evidence defect** (not a code defect).
2. **Do not merge PR #40 on the strength of T-16.** The artifact may not be relied upon as migration-impact or deployed-grant evidence.
3. **When separately authorized, the minimum corrective action** is documentation-only: restate T-16 on the **measured pre-existing corpus**; remove or relabel the "88"; state plainly that **no deployed grant corpus exists or was consulted**, so the T-16 precondition is satisfied **vacuously as to deployed grants** with **zero** changed grants requiring owner acceptance; and correct the "AST sweep" description, the "33 test cases" figure, and (per B-3) the "zero widening" claim. The author should be the implementation session, with independent re-verification.
4. **Alternatively**, if the owner holds a real deployed grant corpus, supply it for a genuine (a)–(d) execution — which remains the only way to convert T-16 from **UNKNOWN** to **measured fact**, as the design record intended.
5. **Standing unchanged:** B-1 remains **open and merge-blocking**; B-3 and B-4 remain **open**; B-5 stands as recorded at `461022a`/`f244058`; S0b/S0c and P3-B S1/S2/S3 **not authorized**; PR #39 and PR #40 **OPEN, UNMERGED**; score **9.484375% FROZEN**; **PRODUCTION NOT READY**; **no merge authorized**.

---

*— End of B-2 read-only evidence assessment. No remediation performed; awaiting separate explicit authorization. —*
