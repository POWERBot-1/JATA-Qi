# P3-B₀ SLICE S0a — B-4 READ-ONLY EVIDENCE ASSESSMENT

| Field | Value |
|---|---|
| Document Class | **READ-ONLY EVIDENCE ASSESSMENT.** Records a capability measurement of the I-6 static guard. Strengthens nothing; remediates nothing. |
| Authorization | Owner: *"I explicitly AUTHORIZE a B-4 READ-ONLY EVIDENCE ASSESSMENT ONLY for S0a / PR #40."* |
| Subject | B-4 as recorded at `461022a`: the I-6 static guard may be defeatable by divergence placed after the region it inspects |
| Under assessment | PR **#40** @ **`ab9914a`** · `packages/authorization-boundary/test/r17-matcher-conformance.test.ts:441-468` |
| Environment | Node **22.22.3** · TypeScript parser from the repo's own `node_modules` · **real compiled R-17 test executed against a `/tmp` scratch tree copy** |
| Date (UTC) | 2026-09-18 |
| **DETERMINATION** | **B-4 CONFIRMED — classified as an evidence / test-design weakness.** It is **not** an implementation defect and **not** a governance defect; it is **not disproved**. **It does not affect the actual matcher equivalence at `ab9914a`** (§8). |
| Constraints honoured | The guard was **not** strengthened, replaced or modified; R-17 was **not** altered; no test was added; **no repository file was modified** (all mutation work was performed on `/tmp` copies); I-6 was **not** reinterpreted into anything stronger than the design specifies (§6). |

---

## 1. THE GUARD AT PR #40 HEAD — **VERBATIM**

`packages/authorization-boundary/test/r17-matcher-conformance.test.ts:441-468`:

```js
it('guarantees source-level byte-identical implementation between both matcher functions (I-6 static guard)', () => {
  const packageDir = resolve(__dirname, __dirname.includes('/dist/') ? '../..' : '..');
  const manifestPath = resolve(packageDir, 'src/capability-manifests.ts');
  const delegationPath = resolve(packageDir, '../authentication/src/delegation-types.ts');

  const manifestSrc = readFileSync(manifestPath, 'utf8');
  const delegationSrc = readFileSync(delegationPath, 'utf8');

  // Extract function bodies
  const extractBody = (src: string, fnName: string): string => {
    const match = src.match(new RegExp(`export function ${fnName}\\([^)]+\\): boolean \\{([\\s\\S]*?\\n\\})`));
    if (!match) throw new Error(`Could not locate function ${fnName} in source`);
    return match[1].trim();
  };

  const targetMatchesBody = extractBody(manifestSrc, 'targetMatches');
  const delegationTargetMatchesBody = extractBody(delegationSrc, 'delegationTargetMatches');

  assert.equal(
    targetMatchesBody,
    delegationTargetMatchesBody,
    'I-6 INVARIANT VIOLATION: targetMatches and delegationTargetMatches function bodies are not byte-identical',
  );
});
```

**This is the only I-6 enforcement in the repository** — no other test, no CI step, and no hash comparison covers it.

---

## 2. EXACTLY WHAT REGION THE GUARD CHECKS

**Stated property:** the assertion compares `match[1].trim()` from each file.

**The inspected region, defined precisely:** the regex is `` export function NAME\([^)]+\): boolean \{([\s\S]*?\n\}) ``.

- **Starts:** immediately after the function's opening `{` — i.e. the **signature is excluded** (parameters, type annotation and return type are never compared).
- **Ends:** at the **first `}` that appears at column 0** (`\n}`), **inclusive** — the closing brace is part of the captured group.
- **…then `.trim()`ed** (leading/trailing whitespace of the whole region is normalised away).

Because the quantifier is **non-greedy** (`*?`), the first column-0 `}` terminates the capture. The guard therefore does **not** verify that the first column-0 `}` *is* the function's closing brace — it merely assumes it.

**Measured at the head:**

| | manifests | delegation |
|---|---|---|
| Captured region | **493 chars / 13 lines** | **493 chars / 13 lines** |
| Brace-balanced interior | 491 chars / 12 lines | 491 chars / 12 lines |
| Captured region ends with | `" regex.test(resource);\n}"` | `" regex.test(resource);\n}"` |

493 = 491 + len(`\n}`). **At the head the captured region is exactly the full body plus the closing brace — it is not truncated.** So at `ab9914a` the guard's proxy coincides with the truth (§8).

**The precise property asserted** is: *"the two first-column-0-`}`-anchored prefixes are equal."* Byte-identity of the true bodies follows **only under the unstated assumption that neither body contains an earlier column-0 `}`.**

---

## 3. IS THE DOCUMENTED OBSERVATION REPRODUCIBLE? — **YES**

Reproduced, and reproduced **end-to-end against the real compiled test**, not merely against a model of it.

**Method.** A `/tmp` scratch copy of the `ab9914a` tree was fully built; the two `src` files were mutated **only inside that copy**; the real compiled `dist/test/r17-matcher-conformance.test.js` was executed; and "true body identity" was measured with a **TypeScript-parser-based** extractor (string-aware, so template literals and quotes cannot fool it) rather than brace counting. No repository file was modified.

### 3.1 Method disclosure — two discarded attempts

Recorded because they bound the weakness's preconditions, and because reporting them is part of not overstating the finding:

1. **Attempt 1 failed to be a valid demonstration.** Injecting a bare column-0 `}` *inside* a body yields `SyntaxError: Illegal return statement` — the file no longer compiles. A false positive that requires invalid source is not a meaningful weakness.
2. **Attempt 2 was correctly caught by the guard.** Placing the divergent text *before* the truncation point (`if (pattern.system === 'AAA') {` … `}` vs `'BBB'`) puts that text **inside** the captured region, so the guard reported `not ok 2` — a correct detection.

**Both attempts establish the precondition** for the weakness, stated in §3.2.

### 3.2 The confirmed false positive (CASE A — crafted)

The two files receive an **identical** block-opening line and an **identical** column-0 `}` that legitimately closes it, so all bytes through the truncation point are equal; the divergent statements follow the `}`:

```js
  if (resource === undefined) return false;
  if (pattern.system === '__probe__') {      // identical in BOTH
}                                            // column-0 '}' -> capture terminates here in BOTH
  if (pattern.system === 'AAA') return false;   // diverges AFTER the truncation point
```

| Check | Result |
|---|---|
| TypeScript build | **succeeds** (valid source) |
| **True bodies identical** (TS-parser) | **FALSE — they genuinely differ** ("`if (pattern.system === 'AAA') return false;`" vs "`…'BBB') return true;`") |
| **Real compiled R-17 guard test** | **`# pass 2 / # fail 0` — silent** |
| Semantic divergence of the two products | **CONFIRMED** — same input (`{system:'AAA',resourcePattern:'p'}`, system `AAA`, resource `p`): `targetMatches = false`, `delegationTargetMatches = true` |

**This is a complete, end-to-end false positive: the two governed matchers genuinely differ, the source genuinely differs, the file compiles, and the I-6 static guard reports PASS.**

### 3.3 The realistic variant (CASE B — ordinary template literal)

Same class, but arising from ordinary code with no adversarial intent — an identical multi-line template literal whose middle line is exactly `}`:

```js
  const banner = `
}
`;
```

| Check | Result |
|---|---|
| TypeScript build | **succeeds** |
| **True bodies identical** (TS-parser) | **FALSE** |
| **Real compiled R-17 guard test** | **`# pass 2 / # fail 0` — silent** |
| Semantic divergence of the two products | **CONFIRMED** (same probe as §3.2) |

**Precondition for both cases:** (i) the bytes through the truncation point must be **identical** in both files, and (ii) the divergence must lie **after** it. Where either fails, the guard detects the drift (§5, `C2`/`C13`).

---

## 4. THE MINIMAL ADVERSARIAL EXAMPLE

The minimal construction is a **single identical line pair** inserted into each body, plus divergence below it:

```diff
   if (resource === undefined) return false;
+  if (pattern.system === '__probe__') {
+}
+  if (pattern.system === 'AAA') return false;      // <- file A only
+  if (pattern.system === 'BBB') return true;       // <- file B only
```

(The two divergent lines are each present in exactly one file; the two `+` bait lines are byte-identical in both.) The guard's capture ends at the `}` and compares only the prefix — which is equal — so it emits PASS.

**Nothing in the repository was modified to produce this**; it was constructed in `/tmp`. At the verified head both files are unmutated.

---

## 5. DOES THE GUARD DETECT REALISTIC DRIFT?

Fourteen function-scoped mutations, against a **verbatim replication** of the guard's own extraction and assertion. The replication is validated by the control (pristine ⇒ PASS, matching the real test) and by the end-to-end runs in §3.

| # | Mutation | Category (owner's list) | Guard | Correct? |
|---|---|---|---|---|
| C0 | none (control) | — | **PASS** | ✅ |
| C1 | single site: `[^/.]*` → `[^/]*` | **(a) wildcard semantics** | **FAIL** | ✅ |
| C2 | **both** sites identically `[^/.]*` → `[^/]*` | (a) | PASS | ✅ bodies *are* identical; see §5.1 |
| C3 | single site: escape class widened | **(b) escaping** | **FAIL** | ✅ |
| C4 | single site: `^` anchor removed | **(c) regex construction** | **FAIL** | ✅ |
| C5 | single site: `$` anchor removed | (c) | **FAIL** | ✅ |
| C6 | single site: guard-clause return flipped | **(d) surrounding logic** | **FAIL** | ✅ |
| C7 | single site: `if (pattern.system !== system) return false;` deleted | (d) | **FAIL** | ✅ |
| C8 | single site: statement inserted before the wildcard branch | **(e) insertion before** | **FAIL** | ✅ |
| C9 | single site: new function added **after** the closing brace | (e) insertion after | PASS | ✅ out of I-6 scope (§5.1) |
| C10 | single site: closing brace **re-indented** | (e) formatting | **THREW** — `Could not locate function targetMatches in source` | ✅ **fails loudly, not silently** |
| C11 | single site: signature whitespace changed | (e) | PASS | ⚠️ signature is outside the region (§5.1) |
| C12 | **identical** column-0 `}` in **both** + divergence after | — | **PASS** | ❌ **FALSE POSITIVE** |
| C13 | column-0 `}` added to **one** body only | (e) | **FAIL** (lens 196 vs 493) | ✅ |
| C14 | **identical** template literal containing a column-0 `}` in **both** | — | **PASS** | ❌ **FALSE POSITIVE** |

### 5.1 Reading the PASSes correctly — not every silent PASS is a defect

To avoid overstating B-4, the non-detections are separated by whether they are *wrong*:

- **C2 (both sites identically changed) — correct behaviour, not a false positive.** The bodies *are* byte-identical, so I-6's textual clause genuinely holds. The *semantic* error is caught by the **R-17 vector assertions** instead: reverting both sites to `.*` and rebuilding makes the vector suite **FAIL** ("`Segment: * REJECTS slash /` … expected false, got true"). Test coverage by the suite as a whole is therefore intact. This division of labour matches the design.
- **C9 / C11 — outside the stated clause, and recorded as boundaries rather than defects.** C9's inserted code lies outside both function bodies, so "bodies byte-identical" is still true. C11 shows the guard does not compare the **signature** at all (region starts after `{`); that is a boundary of coverage, not a violation of the clause *"bodies byte-identical"*.
- **C12 / C14 — genuine false positives.** The true bodies differ and the guard reports identity.
- **C10 — a positive property.** When the guard cannot locate a function it **throws**, failing closed and loudly rather than silently passing.

**Summary for the owner's five categories:** realistic **single-site** drift is detected in **every** category tested — wildcard semantics (C1), escaping (C3), regex construction (C4, C5), surrounding logic (C6, C7), and insertion/deletion before the region (C8); deletion/re-indentation is detected by throwing (C10); single-sided truncation is detected by length divergence (C13). **The guard meets the purpose the design assigns it.** It fails only in the narrow configuration of §3.3.

---

## 6. ASSURANCE VERSUS I-6 AND R-17 — **WITHOUT STRENGTHENING I-6**

The design specifies, verbatim **[REPO]**:

- **I-6 (§8):** *"**I-6** Matcher semantics identical at both sites, enforced by test not comment (R-17); bodies byte-identical until/unless unified in `core-kernel` under separate review (U-4)."*
- **R-17 (§4.4):** *"A companion static check asserts the two bodies remain **textually identical** (defence against **silent single-site edits**)."*

Read **exactly as written**, I-6 has two clauses — (1) semantics identical, enforced by test; (2) bodies byte-identical — and the R-17 text assigns the companion static check the role of **defence against silent single-site edits**.

| Clause / stated purpose | Achieved? |
|---|---|
| **R-17's stated purpose:** defence against *silent single-site edits* | **YES — achieved.** Every single-site mutation tested was caught (C1, C3–C8, C13), and non-locatable drift throws (C10). |
| **I-6 clause (1):** matcher *semantics* identical, enforced by test | **YES — by the vector assertions**, not by the static guard. Confirmed green at head, and demonstrated failure on a both-sites semantic revert. |
| **I-6 clause (2):** bodies *byte-identical* | **Conditionally.** Established soundly **only when neither body contains an earlier column-0 `}` before its close** — an unstated assumption. When it fails, the guard silently degrades to a prefix comparison (C12, C14). |

**Therefore, stated without inflating the requirement:** the guard is an **effective detector of the specific threat the R-17 text names**, and an **unsound proof of the literal byte-identity clause** it appears to establish. The gap is between the *narrow purpose* the design states and the *broad guarantee* the assertion's name, message and the I-6 clause convey. **I-6 is not reinterpreted here as requiring anything stronger than the design says.**

---

## 7. CLASSIFICATION OF B-4

| Candidate | Verdict |
|---|---|
| **Disproved?** | **NO.** The false positive is confirmed end-to-end (§3.2, §3.3). |
| **Evidence / test-design weakness?** | **YES — this is the classification.** The guard is a weaker proxy than its name (*"guarantees source-level byte-identical implementation"*) and its failure message (*"I-6 INVARIANT VIOLATION … not byte-identical"*) imply. It asserts a prefix property, not the property it advertises. |
| **Implementation defect?** | **NO.** No product/matcher code is implicated. The matchers at the head are correct and byte-identical (§8). |
| **Governance defect?** | **NO.** No authorization, ruleset, or record is implicated. |
| **Unresolved?** | **NO.** The weakness is demonstrated, its preconditions are known (§3.3), and its scope is bounded (§5.1). |

**Refinement of the original B-4 wording.** B-4 was first recorded as a *"verification/evidence defect"* and compared against "I-6 byte-identical invariant". This assessment refines rather than changes that: the guard **does** deliver what the R-17 design text asks of it, so the correct characterisation is **an evidence/test-design weakness** — the guard is **sound in the direction it was designed for** (single-site drift) and **unsound in the direction it is named for** (byte-identity in all cases). This is a narrower and more accurate finding than "defeatable invariant enforcement", and B-4 should be recorded in that narrower form.

---

## 8. DOES THIS AFFECT THE ACTUAL S0a EQUIVALENCE AT `ab9914a`? — **NO**

**Preserved distinction, as required: the weak mechanism does not weaken the verified fact.**

Independent evidence that the actual bodies at `ab9914a` are equivalent:

| Evidence | Result |
|---|---|
| Raw brace-balanced interiors compared | **byte-identical** |
| SHA-256, raw interior A / B | `cf597a74e5bb2fb58d7e53f97e4d67ab936d86cdd1ae5c6792f2f80ffd3d0d4ea` / **same** |
| SHA-256, signature-normalised A / B | **same** hash again |
| Guard's region at head **complete** (not truncated) | **yes** — capture = interior + `\n}`, 493 vs 491 chars (§2) |
| Cross-site vector agreement (R-17, both sites identical verdicts) | **green** (2/2) |
| Guard itself | **PASS** — and here the PASS is *earned*, because at this formatting its region equals the true body |

**Conclusion:** at `ab9914a` the guard's proxy **coincides exactly** with the truth, and the byte-identity of the two bodies is established by **at least two routes independent of the guard** (raw-interior byte comparison and SHA-256). The actual matcher equivalence is **not in question**. B-4 weakens **only the guarantee that the mechanism will keep catching certain future drift**, not the present fact it was used to attest.

This is not a licence to ignore B-4: the guard is the *only* I-6 enforcement, and a future refactor could pass it while diverging. But no S0a claim depends on the unproven part of its strength, so **B-4 is not merge-blocking on present evidence** — unlike B-1.

---

## 9. LIMITATIONS OF THIS ASSESSMENT

1. **Classification follows the design text, not an inferred stronger intent.** I-6 was read as written; no clause was added to it. Where the guard falls short, §6 distinguishes the *narrow purpose* the design states from the *broad guarantee* the assertion appears to make.
2. **Mutations were authored by this verifier**, so the adversarial search is not exhaustive. The finding is that a false positive **exists and is realistic**, not that this is the only one. Any similar region boundary (e.g. a column-0 `}` inside a comment or string) should be presumed to behave the same way; only the two classes demonstrated here were executed.
3. **C2, C9 and C11 are silent PASSes that are not defects** (§5.1). They are recorded deliberately so the detection matrix is not misread as an unqualified weakness.
4. **The scratch-tree runs use this sandbox's Node 22.22.3**, not CI's Node 20. Operating in an environment this constrained (2 vCPU) makes the outcomes *more* likely to reproduce, not less; but the end-to-end confirmation was not repeated on Node 20.
5. **No repository file was modified.** All mutation work was performed on `/tmp` copies of the tree; the worktree at `ab9914a` was verified pristine afterwards. The guard, R-17, the matchers, the tests and CI were not touched.
6. **B-1, B-2, B-3 and B-5 were not investigated or modified here**; B-2/B-3 are referenced only where their findings bear on unattested properties.

---

## 10. RECOMMENDED DISPOSITION (no implementation)

1. **Accept B-4 in its refined form:** an **evidence/test-design weakness** — sound against single-site drift (the R-17-stated purpose), unsound as a proof of the literal byte-identity clause in the presence of an earlier column-0 `}`. Record that it is **not** an implementation defect and that **the actual `ab9914a` equivalence is established independently** (§8).
2. **Amend the finding's severity language** so the blocker register does not attribute an unproven weakness to the matchers: the affected property is the *static mechanism's future assurance*, not the *present verified equality*.
3. **When separately authorized, the minimum corrective action is in the test mechanism only** and should be scoped narrowly: replace the regex capture with a **structure-aware extraction** (TypeScript AST, using the `typescript` dependency the package already has, or brace-balanced parsing) so the region is provably the whole body; and **optionally** add a negative meta-test asserting the guard fails on a deliberately drifted fixture. **Both are test-only and neither requires touching matcher code.** The `typescript` package is already a `devDependency` of `authorization-boundary`, so no new dependency is implied.
4. **Do not**, in any corrective slice, extend the guard's remit beyond the design's text (for example by turning it into a semantic oracle) — semantics are already enforced by the vector assertions, which already catch the both-sites case (C2).
5. **Standing unchanged:** B-1 remains **open and merge-blocking**; B-2 confirmed (evidence defect); B-3 confirmed as a false claim plus a U-1 specification gap requiring owner disposition; B-5 as recorded at `f244058`; S0b/S0c and P3-B S1/S2/S3 **not authorized**; PR #39 and PR #40 **OPEN, UNMERGED**; score **9.484375% FROZEN**; **PRODUCTION NOT READY**; **no merge authorized**.

---

*— End of B-4 read-only evidence assessment. No remediation performed; awaiting separate explicit owner authorization. —*
