# P3-B₀ SLICE S0a — B-3 OWNER DECISION RECORD (OPTION (b))

| Field | Value |
|---|---|
| Document Class | **GOVERNANCE DECISION RECORD — documentation-only artifact.** Records an owner decision issued in the Arena governance conversation. **Grants nothing, authorizes no implementation, changes no score, gate, ruleset, or PR state.** |
| Subject | Owner decision on blocker **B-3** (line-terminator widening / U-1 specification gap) — **Option (b): ratify U-1 on its literal reading** |
| Decision date | **2026-09-19** (session date; no clock time recorded; none invented) |
| Decision issuer | **Repository owner (POWERBot-1)** — issued in the Arena governance conversation |
| Recorded by | Arena session `arena/01a0b5bc-jata-qi` (documentation only) |
| Supersedes (as to B-3 status only) | "B-3 … carried forward … must be resolved under separate authorization" (`P3_B0_S0A_FINAL_GOVERNANCE_DISPOSITION.md` §1, on `arena/01a0b410`); "OPEN — owner decision required" (post-S0a next-milestone audit, session `arena/01a0b5bc-jata-qi`, 2026-09-19 — chat artifact, **not a repository file**) |
| Evidence base | Blocker assessment `461022a` §4 · `P3_B0_S0A_B3_SEMANTICS_ASSESSMENT.md` (exhaustive BMP sweep) · `P3_B0_S0A_FINAL_GOVERNANCE_DISPOSITION.md` §1 (owner B-3 disposition) · `docs/verification/T16_GRANT_CORPUS_REEVALUATION_REPORT.md` (in `main` at `5c46539`) |
| Product code modified | **0** |
| Tests / workflows / configs / dependencies modified | **0** |
| Score / rubric / ruleset / PR state modified | **0** |

---

## 1. EVIDENCE RULE APPLIED BY THIS RECORD

Same provenance classes as `docs/P3_B0_GOVERNANCE_AND_AUTHORIZATION_RECORD.md` §1.1 (on `arena/01a0b410`):

| Tag | Meaning |
|---|---|
| **[OWNER]** | Decision issued by the owner in the Arena governance conversation, 2026-09-19. Authoritative as to the owner's intent; **not independently verifiable from the repository** |
| **[REPO]** | Re-derived by read-only inspection of the repository and GitHub metadata while recording this decision |
| **[PRESERVE]** | This record — created after the decision to preserve it. **Not contemporaneous with the decision** |
| **[UNVERIFIED]** | Not obtainable by any means available to this session. Recorded as absent, **not** inferred |

No timestamp, clock time, signature, approval, or historical artifact is invented. This record must not be represented as contemporaneous authorization.

---

## 2. THE DECISION — RECORDED VERBATIM [OWNER]

> **I choose B-3 Option (b):**
>
> **Ratify U-1 on its literal reading.**
>
> **The line-terminator widening is therefore an explicitly disclosed and accepted consequence of the S0a matcher semantics.**

**Verbatim non-authorization clause [OWNER]:**

> This decision does NOT authorize:
>
> - changing either matcher;
> - changing matcher semantics;
> - rewriting the S0a implementation;
> - rewriting the T-16 report;
> - modifying R-17;
> - hardening I-6;
> - implementing S0b;
> - implementing S0c;
> - implementing S1/S2/S3.

**Verbatim compensating-control clause [OWNER]:**

> The accepted line-terminator behavior must be addressed by the canonicalization/input-contract control assigned to the appropriate future S1 design.
>
> That future control must explicitly define:
>
> 1. the canonical input contract;
> 2. treatment of ECMAScript line terminators;
> 3. normalization/rejection behavior;
> 4. where canonicalization occurs;
> 5. how the invariant is enforced;
> 6. adversarial test vectors demonstrating the intended behavior.
>
> The compensating control is a FUTURE S1 design requirement, not an authorization to implement S1 now.

**Verbatim T-16 clause [OWNER]:**

> The existing in-main T-16 report remains historical evidence from the completed S0a cycle. Do not silently rewrite it.
>
> If a correction, amendment, or clarification to T-16 is required, that must occur under separate explicit authorization and must preserve the historical record and provenance.

**Verbatim B-4 clause [OWNER]:**

> No I-6 guard remediation is authorized by this decision.

**Verbatim standing clause [OWNER]:**

> This decision resolves the B-3 semantic question only. All other authorization gates remain unchanged.

---

## 3. WHAT OPTION (b) DETERMINES — RECORDED AGAINST REPOSITORY EVIDENCE

### 3.1 The ratified semantics [REPO]

- **U-1, option (i) (design §11/§4.4 at `447ab3b`): `*` matches zero or more characters excluding the boundary characters `/` and `.` — ratified on the literal reading** [OWNER].
- The S0a encoding is the **literal, faithful, and complete** implementation of that text: `.join('[^/.]*')}$` at **`packages/authorization-boundary/src/capability-manifests.ts:281`** (`targetMatches`) and **`packages/authentication/src/delegation-types.ts:399`** (`delegationTargetMatches`), verified byte-present at current `main` `5c46539` [REPO — SRC].
- **No matcher change follows from this decision.** The S0a matcher semantics stand exactly as merged in PR #40, until any future, separately authorized change.

### 3.2 The disclosed, accepted consequence [REPO]

Per the B-3 semantics assessment (exhaustive BMP sweep; both sites, both trees):

| Kind | Code points | Count | Status after this decision |
|---|---|---|---|
| **Widening** (pre-S0a `.*` false → S0a `[^/.]*` true) | U+000A LF · U+000D CR · U+2028 LS · U+2029 PS — precisely the four ECMAScript LineTerminators | **4** | **Disclosed, accepted consequence** of the ratified literal U-1 [OWNER] |
| **Narrowing** (pre-S0a true → S0a false) | U+002F `/` · U+002E `.` — precisely the elected boundary characters | **2** | Intended T-04/T-05/T-06 closure (unchanged) [REPO] |

This record is where the **disclosure** required by Option (b) — "record the widening as a **disclosed, accepted** consequence" (blocker assessment `461022a` §4, Option (b)) — is made in a repository artifact. No product behavior is changed by the disclosure.

### 3.3 Relationship to the T-16 claim in `main` [OWNER / REPO]

- `docs/verification/T16_GRANT_CORPUS_REEVALUATION_REPORT.md` at `5c46539` — including §3.1 "`OLD=false -> NEW=true` (Unintended Expansion): **0 transitions** (zero widening)" and §6 "100% fail-closed tightening" — **remains unamended historical evidence of the S0a cycle** [OWNER].
- The general-semantic inaccuracy of the "zero widening" statement (relative to the four LineTerminators) is now **disclosed and accepted by this record**, without altering T-16's text. Any correction, amendment, or clarification of T-16 itself requires **separate explicit authorization** and must preserve the historical record and provenance [OWNER].

---

## 4. COMPENSATING CONTROL — REGISTERED AGAINST FUTURE S1 DESIGN (NOT AN AUTHORIZATION)

The owner-specified compensating control is registered here as a **binding design requirement for the future S1 canonicalization/input-contract work**:

| # | Requirement (verbatim [OWNER]) |
|---|---|
| 1 | the canonical input contract |
| 2 | treatment of ECMAScript line terminators |
| 3 | normalization/rejection behavior |
| 4 | where canonicalization occurs |
| 5 | how the invariant is enforced |
| 6 | adversarial test vectors demonstrating the intended behavior |

**This is a design requirement, not an authorization.** S1 is **NOT AUTHORIZED**. Nothing in this record permits any S1 design or implementation work to begin.

---

## 5. REGISTER EFFECT

| Register | Item | Before | After this decision |
|---|---|---|---|
| B (S0a verification cycle, `arena/01a0b410`) | **B-3** | OPEN — owner decision required; "carried forward … under separate authorization" | **DISPOSITIONED — Option (b) elected 2026-09-19.** Specification question resolved: U-1 ratified on literal reading; LineTerminator widening disclosed and accepted; compensating control registered against future S1 design |
| B (S0a verification cycle) | B-1 (CI race) | Dispositioned — known transient flake; un-remediated | **UNCHANGED** |
| B (S0a verification cycle) | B-2 (T-16 corpus) | Dispositioned — evidence defect; limitation stands | **UNCHANGED** |
| B (S0a verification cycle) | B-4 (I-6 guard) | Dispositioned — non-blocking; no remediation authorized | **UNCHANGED** — explicitly reaffirmed by this decision |
| B (S0a verification cycle) | B-5 (governance record) | Discharged as to artifact existence (record on `arena/01a0b410`) | **UNCHANGED** (canonicality of that record remains an owner decision) |
| A (P3-B assessment, PR #39 — **unmerged**) | B-1…B-5, F-*, T-*, TA-*, INV-13 | OPEN as registered at `608a6ea` | **UNCHANGED** — PR #39's status and register remain separate owner decisions |

**This decision resolves the B-3 semantic question only. All other authorization gates remain unchanged.** [OWNER]

---

## 6. UNCHANGED STANDING STATE [REPO]

| Item | State |
|---|---|
| `main` | **`5c46539989c42d0536433aca1aebcbaf48dec237`** (PR #40 merge) — S0a **COMPLETE and VERIFIED** (post-merge verification 14/14 PASS, `8c067cd4`) |
| P2-E4 | **9.484375% FROZEN / NOT ACHIEVED** — rubric files (`docs/rubric/JATA-P0-95-v1.1.md`, `docs/rubric/P0R-95_SCORECARD.md`) untouched by this record |
| Production readiness | **NOT READY** — no readiness claim made |
| S0b | **NOT AUTHORIZED** |
| S0c | **NOT AUTHORIZED** |
| S1 / S2 / S3 | **NOT AUTHORIZED** |
| PR #39 | **OPEN, UNMERGED** (`608a6ea`) |
| Ruleset `20134880` | **UNTOUCHED** by this record |
| Matcher sites `capability-manifests.ts:281` / `delegation-types.ts:399` | **UNCHANGED** — ratified as-is |

---

## 7. LOCATION AND CANONICALITY OF THIS RECORD

**[PRESERVE]** This record is committed to branch **`arena/01a0b5bc-jata-qi`**. It is **not in `main`** until a separately authorized merge occurs — the ownership and merge decision rests with the owner. This record performs no merge, opens no pull request, and authorizes no merge of anything.

As a post-facto preservation artifact, it is **weaker evidence** than a contemporaneous record. It establishes what the owner decided on 2026-09-19; it cannot make that decision contemporaneous with this record.

---

## 8. WHAT THIS RECORD DOES NOT DO

Documentation only. This slice:

- changed **no** matcher or product code, test, workflow, dependency, or configuration;
- did **not** modify R-17, I-6, or the T-16 report in `main`;
- did **not** open, modify, comment on, or merge any pull request (PR #39 untouched; PR #40 already merged and untouched);
- did **not** authorize or implement **S0b**, **S0c**, or **P3-B S1/S2/S3** — including any S1 design work;
- did **not** change, recalculate, or reinterpret the frozen score;
- did **not** assert production readiness;
- did **not** re-run CI or modify any ruleset.

**No governance standing is changed by this document other than the recorded disposition of B-3.**

**STOP.**

---

*— End of B-3 Owner Decision Record (Option (b)) —*
