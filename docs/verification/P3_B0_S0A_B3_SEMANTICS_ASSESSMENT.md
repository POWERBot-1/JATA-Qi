# P3-B₀ SLICE S0a — B-3 READ-ONLY EVIDENCE AND SEMANTICS ASSESSMENT

| Field | Value |
|---|---|
| Document Class | **READ-ONLY EVIDENCE & SEMANTICS ASSESSMENT.** Records a semantics characterisation and an evidentiary finding. Elects nothing; remediates nothing. |
| Authorization | Owner: *"I explicitly AUTHORIZE a B-3 READ-ONLY EVIDENCE AND SEMANTICS ASSESSMENT ONLY for S0a / PR #40."* |
| Subject | B-3 as recorded at `461022a` / `68e819e`: T-16 §3.1's "0 transitions (zero widening)" claim versus the line-terminator behaviour of `[^/.]*` |
| Under assessment | PR **#40** @ **`ab9914a`** · baseline **`6b61256`** · both governed matcher sites · `docs/verification/T16_GRANT_CORPUS_REEVALUATION_REPORT.md` |
| Environment | Node **22.22.3**; product code imported from **both** trees, each fully built (`npm ci` + `npm run build`) |
| Date (UTC) | 2026-09-18 |
| **DETERMINATION** | **B-3 CONFIRMED** — as a **false evidence claim** and as a **U-1 specification gap requiring owner disposition**. It is **NOT an implementation defect**, and **no production impact is established**. |
| Constraint honoured | No new matcher semantics is chosen here. The U-1/line-terminator relationship is **derived from the design record**, not assumed. |

**Method.** Pre-S0a behaviour was measured against the **actual baseline product code** (`/home/user/_b3/base/.../dist`), and S0a behaviour against the **actual head product code** (`/home/user/_b3/pr40/.../dist`) — both imported, neither re-implemented. Characterisation is by **exhaustive sweep**, not sampling.

---

## 1. THE PRE-S0a MATCHER — EXACT SEMANTICS AT BOTH SITES

The change is **exactly two lines** (`git diff 6b61256 ab9914a`):

```
-      .join('.*')}$`,
+      .join('[^/.]*')}$`,
-      .join('.*')}$`,
+      .join('[^/.]*')}$`,
```

one at `packages/authorization-boundary/src/capability-manifests.ts:281` and one at `packages/authentication/src/delegation-types.ts:399`. Nothing else in either file changed.

Pre-S0a construction (unchanged in all other respects, including the `^…$` anchors and the literal-part escaping `/[.*+?^${}()|[\]\\]/g → '\\$&'`):

```js
new RegExp(`^${pattern.resourcePattern.split('*').map(escape).join('.*')}$`)
```

The wildcard therefore expanded to the regex `.`. **In ECMAScript, `.` without the `s` (dotAll) flag matches every code unit _except_ the four LineTerminator code points.** Neither site used the `s` flag.

**Exact pre-S0a `*` semantics:** zero or more characters, **none of which is LF, CR, LS or PS** — and **freely crossing `/` and `.`** (which is the T-04/T-05/T-06 defect the slice exists to close).

**Important:** the pre-S0a exclusion of line terminators was **incidental** — a side effect of using `.`. Neither matcher's comment, and no document, ever stated a line-terminator policy (§4.3).

---

## 2. THE S0a MATCHER — EXACT SEMANTICS

```js
new RegExp(`^${pattern.resourcePattern.split('*').map(escape).join('[^/.]*')}$`)
```

**Exact S0a `*` semantics:** zero or more characters, **none of which is `/` (U+002F) or `.` (U+002E)** — **including** LF, CR, LS, PS.

### 2.1 Exhaustive character characterisation (complete BMP sweep)

Every code point `U+0000 … U+FFFF` was tested as a single character inserted into a wildcard slot (pattern `a*b`, resource `a`+cp+`b`) against **both** products. The divergence set is **exactly six code points — no more, no fewer**:

| Kind | Code point(s) | Count |
|---|---|---|
| **Widening** (`pre-S0a` false → `S0a` true) | `U+000A` LF · `U+000D` CR · `U+2028` LS · `U+2029` PS | **4 — precisely the ECMAScript LineTerminators** |
| **Narrowing** (`pre-S0a` true → `S0a` false) | `U+002E` `.` · `U+002F` `/` | **2 — precisely the elected boundary characters** |

Named probe table (pattern `a*b`), with controls:

| Char | Code | ECMAScript LineTerminator? | pre-S0a | S0a | Diverges | Widening? |
|---|---|---|---|---|---|---|
| LF | U+000A | **yes** | false | true | yes | **yes** |
| CR | U+000D | **yes** | false | true | yes | **yes** |
| LS | U+2028 | **yes** | false | true | yes | **yes** |
| PS | U+2029 | **yes** | false | true | yes | **yes** |
| NEL | U+0085 | no | true | true | no | no |
| VT | U+000B | no | true | true | no | no |
| FF | U+000C | no | true | true | no | no |
| TAB | U+0009 | no | true | true | no | no |
| SPACE | U+0020 | no | true | true | no | no |
| `/` | U+002F | no | true | false | yes | no (narrowing) |
| `.` | U+002E | no | true | false | yes | no (narrowing) |

Language-level minimal repro, independent of product code:

```
LF   /./ : false   /[^/.]/ : true
CR   /./ : false   /[^/.]/ : true
LS   /./ : false   /[^/.]/ : true
PS   /./ : false   /[^/.]/ : true
NEL  /./ : true    /[^/.]/ : true        <- boundary of the class, correctly
```

**Scope of the characterisation:** the sweep covered the entire BMP, in which all four ECMAScript LineTerminators lie; no astral (U+10000+) code point is a LineTerminator, and `[^/.]` and `.` agree on all of them. The characterisation is therefore **complete for this class**.

**Both sites behave identically.** Zero site divergences across the probe set, on both trees.

**Multi-character reachability** (`https://api.openai.com/v1/*`): `…/v1/chat` ⇒ both true; `…/v1/../../admin` ⇒ pre-S0a true → S0a false (the intended closure); `…/v1/a\nb` ⇒ pre-S0a **false** → S0a **true** (widening).

---

## 3. REPRODUCIBILITY OF THE REPORTED "16 WIDENINGS" — CONFIRMED, WITH A PRECISION REFINEMENT

The 16 were reproduced **exactly** by replaying the probe set that generated them (24 patterns × 48 resources = 1152 pairs):

```
doc/*   vs "doc/a\nb"      doc/*   vs "doc/a\rb"      doc/*   vs doc/a LS b     doc/*   vs doc/a PS b
*       vs "a\nb"          *       vs "x\ny"          */*     vs "doc/a\nb"      */*     vs "doc/a\rb"
*/*     vs doc/a LS b      */*     vs doc/a PS b      */*     vs "a\nb/c"        */*     vs "a/b\n"
*/*     vs "\ndoc/1"       a*      vs "a\nb"          **      vs "a\nb"          **      vs "x\ny"
```

Every one of the 16 uses a resource containing an actual line terminator, and both sites agree on all 16.

**Refinement (recorded as a correction to this verifier's own earlier record).** The numeral **16 is probe-set dependent** — it is the count produced by that particular pattern×resource list, not an invariant. A wider probe (23 patterns × 63 resources = 1449 pairs) yields **42**. The **probe-independent** fact — and the one that should be relied upon — is the exhaustive result in §2.1: **the divergence class is exactly the four ECMAScript LineTerminator code points**, of which four are widenings and two are narrowings.

The finding's **substance is therefore confirmed and strengthened** by total characterisation; the specific figure "16" should be quoted only alongside its probe. No conclusion of B-3 depends on the numeral.

---

## 4. ORIGIN OF THE WIDENING — U-1, ENCODING, OR SPECIFICATION GAP?

The constraint for this section is explicit: *do not assume line-termator behaviour is covered by U-1 merely because U-1 specifies `/` and `.` exclusion.* The relationship is therefore established from the design record itself.

### 4.1 What U-1 actually says — verbatim **[REPO]**

| Source | Text |
|---|---|
| Design §11, row **U-1** | *"\"Segment\" was never defined in code/docs"* — options: *"(i) **`/`+`.` excluded from `*`** (design choice, §4.4); (ii) `/` only; (iii) per-entry delimiter declaration"* — recommendation *"(i); owner ratifies at exit gate"* |
| Design §4.4 | *"within the glob language, `*` matches zero or more characters **excluding** the boundary characters **`/` and `.`**"* |
| Design §4.4, enumerated consequences | T-04 (suffix confusion — **dot**), T-05 (host cross-label — **dot**), T-06 (path traversal — **slash**). **All three concern `/` and `.` only.** |

Option (ii) is *"`/` only"* and option (iii) is a per-entry delimiter declaration. **No option, and no part of §4.4, names any character other than `/` and `.`.**

### 4.2 The design record is silent on line terminators — proven **[REPO]**

Exhaustive term search over the full design record (`447ab3b`, 538 lines):

| Term searched | Occurrences |
|---|---|
| `line terminator` | **0** |
| `newline` | **0** |
| `carriage` | **0** |
| `control char` | **0** |
| `whitespace` | **0** |
| `character class` | **0** |
| `dotall` / `s flag` | **0** |
| `U+` | **0** |

(The raw greps for `LF`/`CR` return hits, but inspection shows they are **substring false positives** — from "cross-orig…", "credential", "envelope credential". There is **no** line-terminator discussion anywhere in the design record.)

The two matcher comments likewise never mention line terminators: `capability-manifests.ts:262-265` says *"any sequence within a segment-delimited resource"*; `delegation-types.ts:381-383` says *"simple segment glob"*. Both are accurate for `/` and `.`, and silent on everything else.

### 4.3 Determination

| Candidate | Verdict |
|---|---|
| **Explicitly ratified U-1 semantics?** | **NO.** U-1 defines `*` by excluding **two** characters. It does not elect, and does not mention, line terminators. |
| **A deviation from ratified text by the encoding?** | **NO.** `[^/.]*` excludes **exactly** `/` and `.` — the complete exclusion set U-1 names. The encoding is a **literal, faithful and complete** implementation of option (i) as written. |
| **An ambiguity/gap in the U-1 specification?** | **YES — this is the operative cause.** U-1 specifies `*` by *exclusion of two named characters* and is therefore **silent on every other character**, including the four that the previous encoding had incidentally rejected. |

**Precise mechanism.** The widening arises from the **interaction** of two things:

1. **the U-1 specification gap** — silence on all characters other than `/` and `.`; and
2. **the exclusion-only regex encoding** — a negated character class admits *everything* the specification did not name, so implementing "exclude `/` and `.`" necessarily *includes* the four line terminators.

Note this is a property of *any* exclusion-only encoding of U-1's stated set, not of a poor choice within the specification: selecting `[^/.]*` is the natural and direct encoding of option (i). An encoding that additionally preserved the previous accepted language would have had to exclude four characters that U-1 never names — i.e. would have departed from the ratified text.

**Consequence for classification:** S0a changed behaviour on a character class that **the specification never addressed**, and neither the design record nor the implementation record discloses it. That is a **specification gap**, not an implementation error.

**Also recorded for fairness:** there is **no evidence that the pre-S0a rejection of line terminators was deliberate either**. It followed mechanically from `.`. So neither the old nor the new behaviour on this class reflects a considered decision — which is exactly why the decision now belongs to the owner.

---

## 5. IS ANY ACTUAL AFFECTED AUTHORIZATION DECISION DEMONSTRATED? — **NO**

Searched across corpus, tests, grants, and documented targets:

| Probe | Result |
|---|---|
| R-17 conformance corpus — vectors exercising line terminators (**structurally parsed**, not grepped: 50 vectors, 50 resource literals and 46 pattern literals extracted and tested) | **0** |
| Baseline corpus (7 patterns × 27 resources = 189 pairs) — verdict changes | **0** |
| Baseline corpus — resources/patterns containing a line terminator | **0 / 0** |
| PR-head corpus (24 patterns × 67 resources = 1608 pairs) — resources/patterns containing a line terminator | **0 / 0** |
| T-16 script resource set — line-terminator entries | **0** |
| Any package `src`/`test` `resource:` literal using a `\n`/`\r`/`\u2028`/`\u2029` escape | **none found** |
| Documented target with a line terminator | **none found** |
| Deployed grant corpus | **does not exist** (established in the B-2 assessment, `7f75302`) |

*(Note on method: a naive `grep` for line-terminator escapes in the R-17 file returns 1 hit — line 452, which is the **I-6 guard's own regex source**, not a test vector. Structural parsing of the corpus array is the correct instrument and gives 0.)*

### 5.1 Reachability is real, but no decision is affected

The resource reaching both matchers is **unvalidated** at the boundary:

- `packages/authorization-boundary/src/policy-engine.ts:298` — `const resource = targetRaw && typeof targetRaw.resource === 'string' && targetRaw.resource.length > 0 ? targetRaw.resource : undefined;` — **any non-empty string** is accepted; no format, control-character or length check.
- `packages/authorization-boundary/src/policy-engine.ts:304` — `targetMatches(entry, system, resource)`.
- `packages/authentication/src/delegation-types.ts:513` — `targetsContain(row.targetScope, requirement.targetSystem, requirement.targetResource)`; `targetResource` is a free-form optional string.

No control-character or normalization validation exists on this path. For contrast, the repository **does** validate this class where it chose to — `packages/knowledge-graph/src/graph-module.ts:54` and `docs/T06_TENANT_ISOLATION_AND_SEQUENCE_INTEGRITY.md:124` both state *"tenant ids may not contain control characters"*. That convention exists in the codebase but has **not** been applied to `resource`.

So: the widening is **reachable in principle**, since nothing rejects such input — but **no existing corpus, test, grant, or documented target exercises it**, and therefore **no affected authorization decision is demonstrated**.

### 5.2 Security consequence — stated without inflation

- **No authorization bypass is demonstrated, and none follows structurally.** The wildcard still cannot cross `/` or `.`, so an injected line terminator **cannot create a new path segment or a new host label**. The change strictly **closed** T-04, T-05 and T-06; it opened no route out of a matched prefix/suffix.
- **Residual, speculative risk:** a *parser-differential*. If a future consumer (transport, resolver, URL normaliser) strips or ignores line terminators, a resource that **matched** upstream could be **interpreted differently** downstream. That class is real in web-URL handling generally — but it requires a downstream parser, and **no such parser exists in S0a**. The design record assigns canonicalisation to **R-03 / S1** (§4.4 requires canonicalisation *"additionally … before matching"*, rejecting traversal, encoded slash, non-canonical casing/punycode).
- **Therefore:** the residual concern is not an S0a defect; it is **an input class the S1 canonicaliser must be specified against**. It should be routed into the S1 design decision, not patched into the matcher.

**Do not manufacture a production impact:** none is established. This assessment asserts none.

---

## 6. IS T-16's "ZERO WIDENING" CLAIM SUPPORTED? — **FALSE AS STATED**

T-16 §3.1 states, under the heading *"Verdict Directionality"*:

> *"**`OLD=false -> NEW=true` (Unintended Expansion): 0 transitions** (zero widening)."*

| Reading | Verdict |
|---|---|
| As a statement about **the T-16 script's own cross-product** | **Empirically true** — that corpus contains **zero** line-terminator inputs (§5), so no widening could appear in it. |
| As a statement about **the matcher's accepted language**, which is what §3.1's wording (*"Unintended Expansion"*, *"zero widening"*) conveys and what the report relies on | **FALSE.** There are 4 widening code points, reproducible against both products (§2.1). |

The claim is presented as a general semantics result — a verdict-directionality conclusion about the correction — not scoped to the probe. It is therefore **false as stated**. The scoped truth ("no widening *within this corpus*") is real but is an artifact of a corpus that never exercises the class, which the report does not disclose.

**Classification: false / unsupported.** Not "not determinable" — it is determinable and it is false.

---

## 7. CLASSIFICATION OF B-3

B-3 is **three distinct things**, which were conflated in the original blocker line and are separated here:

| Layer | Classification | Reasoning |
|---|---|---|
| The **code** | **NOT an implementation defect** | `[^/.]*` is a literal, faithful and complete encoding of U-1 option (i). It excludes exactly the two characters U-1 names. Both sites are byte-identical modulo the declared name/type; the diff is exactly two lines; no other clause of the matcher changed. |
| The **specification** | **CONFIRMED specification/design gap** | U-1 defines `*` by exclusion of two characters and is silent on all others — including a class whose behaviour the slice changed. The design record contains no line-terminator discussion whatsoever (§4.2). |
| The **report** | **CONFIRMED evidence/reporting defect** | T-16 §3.1's "0 transitions (zero widening)" is false as stated (§6), and the behaviour change is undisclosed in T-16, in the PR body and in the commit message. |
| Required **disposition** | **Owner decision** | Whether `*` should admit line terminators is a semantics election. It is not this session's to make, and no new semantics is chosen here. |

**Primary characterisation: an evidence/reporting defect (confirmed) plus a specification gap requiring owner disposition — not an implementation defect, and not a demonstrated security defect.**

---

## 8. LIMITATIONS

1. **No production impact is established, and none is claimed.** No deployed grant corpus exists, no deployment environment was reachable, and no repository artifact exercises this input class (§5). Whether any real authorization decision is affected is **unknown and unmeasured**.
2. **Characterisation is by exhaustive BMP sweep plus language-level repro.** Astral planes are unaffected by construction (§2.1).
3. **This assessment elects no semantics.** It deliberately does not decide whether `*` should exclude line terminators; that is the owner's disposition, and the two available readings are set out in §9.
4. **The "16" numeral is probe-dependent** (§3) and is corrected here; reliance should be placed on the exhaustive class characterisation instead.
5. **B-1, B-2, B-4 and B-5 were not investigated or modified.** B-2's finding is cross-referenced only for the shared fact that no deployed grant corpus exists.
6. **Read-only:** no change was made to either matcher, to U-1, to T-16, to R-17, to any test, to CI/workflows, to PR #40 or PR #39; nothing was merged; no score or readiness status was touched.

---

## 9. RECOMMENDED DISPOSITION (no implementation)

1. **Accept B-3 as confirmed** in the two senses established in §7 — a **false evidence claim** and a **U-1 specification gap** — and record explicitly that it is **not** an implementation defect.
2. **Correct the evidence, separately authorised and documentation-only:** strike T-16 §3.1's unqualified "zero widening"; state that the finding holds **within the T-16 corpus only**; and disclose that the corrected encoding admits the four ECMAScript line terminators where the previous encoding did not. Per the B-2 assessment, the numeral "88" likewise needs restating.
3. **Owner semantics election — exactly one of:**
   - **(a) Ratify the literal reading.** U-1 excludes only `/` and `.`; line terminators are therefore permitted. Record the widening as a **disclosed and accepted** consequence of the elected semantics, and assign the parser-differential concern to the **S1 canonicaliser (R-03)** specification, which already owns canonicalisation before matching.
   - **(b) Elect the narrower semantics.** Define `*` as excluding `/`, `.` **and the four ECMAScript line terminators**, add R-17 vectors for the class, and implement under a **separate** authorization.
   **Neither option may be chosen by the implementation session, and this assessment does not choose between them.** Option (a) requires no code change; option (b) is a semantics change and therefore its own slice.
4. **Recommendation on ordering:** decide this **together with** the S1 canonicaliser's input contract, since the only arguments for (b) rest on downstream parsing that S1 will own. Deciding (a) or (b) in isolation risks specifying the same input class twice, inconsistently.
5. **Standing unchanged:** B-1 remains **open and merge-blocking**; B-2 confirmed (evidence defect); B-4 open; B-5 as recorded; S0b/S0c and P3-B S1/S2/S3 **not authorized**; PR #39 and PR #40 **OPEN, UNMERGED**; score **9.484375% FROZEN**; **PRODUCTION NOT READY**; **no merge authorized**.

---

*— End of B-3 read-only evidence and semantics assessment. No remediation performed; awaiting separate explicit owner authorization. —*
